import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  AutomergeSystemRelationState,
  createAutomergeMappedStorageBinding,
  projectAutomergeFacts
} from '../packages/automerge/dist/internal-benchmark.js';
import { adoptAutomergeJsonValue } from '../packages/automerge/dist/values/index.js';
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

const measureValueAdoption = (rowCount) => {
  const document = Automerge.from({
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: index,
      name: 'row:' + index,
      values: [index, index + 1, index + 2]
    }))
  });
  const started = performance.now();
  const adopted = adoptAutomergeJsonValue(document);
  return {
    rowCount,
    milliseconds: Number((performance.now() - started).toFixed(3)),
    success: adopted.success,
    frozen: adopted.success && Object.isFrozen(adopted.value)
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
        name: { path: ['name'], write: {} },
        content: {
          path: ['content'],
          write: { replace: builtInCapabilityRefs.fieldReplace }
        }
      }
    } }
  }, schemaRef, schema.value);
  if (!mapping.success) throw new Error('Performance file mapping preparation failed');
  const contentBytes = 8 * 1024 * 1024;
  const document = Automerge.from({ name: 'large.bin', content: new Uint8Array(contentBytes) });
  const binding = createAutomergeMappedStorageBinding({
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

const measureRecursiveStructuredProjection = (rowCount) => {
  const schema = prepareSchema({
    relations: { pieces: {
      relationId: 'performance.pieces',
      key: ['occurrenceId'],
      fields: {
        occurrenceId: { type: { kind: 'string' } },
        parentOccurrenceId: { type: { kind: 'string' }, nullable: true },
        order: { type: { kind: 'integer' } },
        name: { type: { kind: 'string' } },
        position: {
          type: {
            kind: 'tuple',
            items: [{ kind: 'number' }, { kind: 'number' }]
          }
        }
      }
    } }
  });
  if (!schema.success) throw new Error('Performance recursive schema preparation failed');
  const schemaRef = {
    id: 'urn:performance:recursive',
    contentHash: `sha256:${'b'.repeat(64)}`
  };
  const mapping = compileStorageMapping({
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: { 'performance.pieces': {
      collection: {
        kind: 'recursive-array',
        path: ['children'],
        descendants: ['children'],
        absent: 'invalid',
        maxDepth: 8,
        maxRows: rowCount + 1,
        maxTraversalSteps: rowCount * 2 + 1
      },
      keys: {
        occurrenceId: {
          kind: 'source-metadata',
          value: 'collection-element-identity'
        }
      },
      fields: {
        parentOccurrenceId: {
          kind: 'source-metadata',
          value: 'recursive-parent-element-identity'
        },
        order: { kind: 'source-metadata', value: 'collection-position' },
        name: { path: ['name'], write: {} },
        position: { path: ['position'], write: {} }
      }
    } }
  }, schemaRef, schema.value);
  if (!mapping.success) throw new Error('Performance recursive mapping preparation failed');
  const snapshot = (storage) => ({
    sourceId: 'performance:recursive',
    operationEpoch: 'performance:epoch',
    basis: { heads: Automerge.getHeads(storage) },
    state: 'ready',
    freshness: 'current',
    storage,
    issues: []
  });
  let document = Automerge.from({
    children: Array.from({ length: rowCount }, (_, index) => ({
      name: 'piece:' + index,
      position: [index, index],
      children: []
    }))
  });
  const binding = createAutomergeMappedStorageBinding({
    id: 'performance:recursive',
    mapping: mapping.value
  });
  const initialStarted = performance.now();
  let previous = binding.project(snapshot(document));
  const initialMilliseconds = performance.now() - initialStarted;
  const measureUpdates = (change) => {
    const firstChangedDocument = Automerge.change(document, (draft) => {
      change(draft, 0);
    });
    const diffStarted = performance.now();
    const patches = Automerge.diff(
      firstChangedDocument,
      Automerge.getHeads(document),
      Automerge.getHeads(firstChangedDocument)
    );
    const diffMilliseconds = performance.now() - diffStarted;
    const incrementalSamples = [];
    let retainedRows = rowCount;
    let incremental;
    for (let sample = 0; sample < 7; sample += 1) {
      document = sample === 0
        ? firstChangedDocument
        : Automerge.change(document, (draft) => {
            change(draft, sample);
          });
      const incrementalStarted = performance.now();
      incremental = binding.project(snapshot(document));
      incrementalSamples.push(performance.now() - incrementalStarted);
      let retained = 0;
      for (let index = 0; index < rowCount; index += 1) {
        if (incremental.rows[index] === previous.rows[index]) retained += 1;
      }
      retainedRows = Math.min(retainedRows, retained);
      previous = incremental;
    }
    incrementalSamples.sort((left, right) => left - right);
    return {
      patchCount: patches.length,
      patches: patches.map(({ action, path }) => ({ action, path })),
      diffMilliseconds: Number(diffMilliseconds.toFixed(3)),
      incrementalMilliseconds: Number(
        incrementalSamples[Math.floor(incrementalSamples.length / 2)].toFixed(3)
      ),
      incrementalSamples: incrementalSamples.map((value) => Number(value.toFixed(3))),
      retainedRows,
      exact: incremental.completeness === 'exact'
    };
  };
  const scalarUpdate = measureUpdates((draft, sample) => {
    draft.children[0].name = 'changed:' + sample;
  });
  const structuredUpdate = measureUpdates((draft, sample) => {
    draft.children[0].position[0] = -sample - 1;
  });
  const freshBinding = createAutomergeMappedStorageBinding({
    id: 'performance:recursive',
    mapping: mapping.value
  });
  const fullStarted = performance.now();
  const full = freshBinding.project(snapshot(document));
  const fullMilliseconds = performance.now() - fullStarted;
  return {
    rowCount,
    initialMilliseconds: Number(initialMilliseconds.toFixed(3)),
    fullMilliseconds: Number(fullMilliseconds.toFixed(3)),
    scalarUpdate,
    structuredUpdate,
    exact: scalarUpdate.exact
      && structuredUpdate.exact
      && full.completeness === 'exact',
    equivalent: JSON.stringify(previous) === JSON.stringify(full)
  };
};

const projections = [measureProjection(400), measureProjection(800)];
const staleEvents = measureStaleEvent(800, 1_000);
const valueAdoption = measureValueAdoption(2_000);
const titleOnlyFile = measureTitleOnlyFileProjection();
const recursiveStructuredProjection = measureRecursiveStructuredProjection(5_000);
const contracts = {
  exactProjectionWithinBound: projections[0].completeness === 'exact' && projections[0].milliseconds <= 50,
  hostileDepthIsBounded: projections[1].completeness === 'unknown' && projections[1].propertyCount <= 513 && projections[1].milliseconds <= 50,
  staleEventConstantTime: staleEvents.millisecondsPerEvent <= 0.05,
  valueAdoptionBounded: valueAdoption.success && valueAdoption.frozen && valueAdoption.milliseconds <= 25,
  titleOnlyFileProjectionBounded: titleOnlyFile.completeness === 'exact'
    && titleOnlyFile.initialMilliseconds <= 50
    && titleOnlyFile.fields.join(',') === 'id,name',
  unobservedFileContentChangeReusesProjection: titleOnlyFile.reusedAfterContentChange
    && titleOnlyFile.updateMilliseconds <= 50,
  recursiveStructuredProjectionIsIncremental: recursiveStructuredProjection.exact
    && recursiveStructuredProjection.equivalent
    && recursiveStructuredProjection.scalarUpdate.retainedRows === recursiveStructuredProjection.rowCount - 1
    && recursiveStructuredProjection.structuredUpdate.retainedRows === recursiveStructuredProjection.rowCount - 1
    && recursiveStructuredProjection.scalarUpdate.incrementalMilliseconds <= 50
    && recursiveStructuredProjection.structuredUpdate.incrementalMilliseconds <= 50
    && recursiveStructuredProjection.scalarUpdate.incrementalMilliseconds * 2 < recursiveStructuredProjection.fullMilliseconds
    && recursiveStructuredProjection.structuredUpdate.incrementalMilliseconds * 2 < recursiveStructuredProjection.fullMilliseconds
};
const failures = Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name);

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-automerge-projection-and-system-state',
  contracts,
  projections,
  staleEvents,
  valueAdoption,
  titleOnlyFile,
  recursiveStructuredProjection,
  node: process.version
}, null, 2) + '\n');
if (failures.length > 0) throw new Error('Automerge performance contracts failed: ' + failures.join(', '));
