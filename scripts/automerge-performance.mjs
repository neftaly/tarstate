import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  AutomergeMappedStorageBinding,
  AutomergeSystemRelationState,
  projectAutomergeFacts
} from '../packages/automerge/dist/internal-benchmark.js';
import { builtInCapabilityRefs } from '../packages/core/dist/capabilities/index.js';
import {
  compileStorageMapping,
  prepareSchema
} from '../packages/core/dist/schema/index.js';

const requireFromAutomerge = createRequire(new URL('../packages/automerge/package.json', import.meta.url));
const Automerge = await import(pathToFileURL(requireFromAutomerge.resolve('@automerge/automerge')).href);

const nestedDocument = (depth) => {
  let value = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return Automerge.from(value);
};

const measureProjection = (depth) => {
  const document = nestedDocument(depth);
  const started = performance.now();
  const projection = projectAutomergeFacts(document);
  return {
    depth,
    milliseconds: Number((performance.now() - started).toFixed(3)),
    propertyCount: projection.properties.length,
    completeness: projection.completeness
  };
};

const measureStaleEvent = (peerCount, iterations) => {
  const state = new AutomergeSystemRelationState('attachment:performance');
  for (let index = 0; index < peerCount; index += 1) {
    state.apply({ kind: 'peer-observed', peerId: 'peer:' + index, observedAt: 1 });
  }
  const accepted = state.getSnapshot();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    if (state.apply({ kind: 'peer-observed', peerId: 'peer:0', observedAt: 0 }) !== accepted) {
      throw new Error('Stale system event unexpectedly published state');
    }
  }
  return {
    peerCount,
    iterations,
    millisecondsPerEvent: Number(((performance.now() - started) / iterations).toFixed(4))
  };
};

const measureTitleOnlyFileProjection = () => {
  const schema = prepareSchema({
    relations: { file: {
      relationId: 'performance.file',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string', values: ['file'] } },
        name: { type: { kind: 'string' } },
        content: { type: { kind: 'bytes' } }
      }
    } }
  });
  if (!schema.success) throw new Error('Performance file schema preparation failed');
  const schemaRef = {
    id: 'urn:performance:file',
    contentHash: `sha256:${'a'.repeat(64)}`
  };
  const mapping = compileStorageMapping({
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: { 'performance.file': {
      collection: { kind: 'singleton', path: [], absent: 'invalid' },
      keys: { id: { kind: 'literal', value: 'file' } },
      fields: {
        name: { path: ['name'], write: { kind: 'read-only' } },
        content: {
          path: ['content'],
          write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace }
        }
      }
    } }
  }, schemaRef, schema.value);
  if (!mapping.success) throw new Error('Performance file mapping preparation failed');
  const contentBytes = 8 * 1024 * 1024;
  const document = Automerge.from({ name: 'large.bin', content: new Uint8Array(contentBytes) });
  const binding = new AutomergeMappedStorageBinding({
    id: 'performance:title-only',
    mapping: mapping.value
  });
  const relations = new Set(['performance.file']);
  const fields = new Map([['performance.file', new Set(['name'])]]);
  const snapshot = (storage) => ({
    sourceId: 'performance:file',
    operationEpoch: 'performance:epoch',
    basis: { heads: Automerge.getHeads(storage) },
    state: 'ready',
    freshness: 'current',
    storage,
    issues: []
  });
  const initialStarted = performance.now();
  const initial = binding.project(snapshot(document), relations, fields);
  const initialMilliseconds = performance.now() - initialStarted;
  const changed = Automerge.change(document, (draft) => {
    draft.content = new Uint8Array(contentBytes);
    draft.content[0] = 1;
  });
  const updateStarted = performance.now();
  const updated = binding.project(snapshot(changed), relations, fields);
  const updateMilliseconds = performance.now() - updateStarted;
  return {
    contentBytes,
    initialMilliseconds: Number(initialMilliseconds.toFixed(3)),
    updateMilliseconds: Number(updateMilliseconds.toFixed(3)),
    fields: Object.keys(initial.rows[0]?.fields ?? {}).sort(),
    reusedAfterContentChange: updated === initial,
    completeness: initial.completeness
  };
};

const projections = [measureProjection(400), measureProjection(800)];
const staleEvents = measureStaleEvent(800, 1_000);
const titleOnlyFile = measureTitleOnlyFileProjection();
const contracts = {
  exactProjectionWithinBound: projections[0].completeness === 'exact' && projections[0].milliseconds <= 50,
  hostileDepthIsBounded: projections[1].completeness === 'unknown' && projections[1].propertyCount <= 513 && projections[1].milliseconds <= 50,
  staleEventConstantTime: staleEvents.millisecondsPerEvent <= 0.05,
  titleOnlyFileProjectionBounded: titleOnlyFile.completeness === 'exact'
    && titleOnlyFile.initialMilliseconds <= 50
    && titleOnlyFile.fields.join(',') === 'id,name',
  unobservedFileContentChangeReusesProjection: titleOnlyFile.reusedAfterContentChange
    && titleOnlyFile.updateMilliseconds <= 50
};
const failures = Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name);

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-automerge-projection-and-system-state',
  contracts,
  projections,
  staleEvents,
  titleOnlyFile,
  node: process.version
}, null, 2) + '\n');
if (failures.length > 0) throw new Error('Automerge performance contracts failed: ' + failures.join(', '));
