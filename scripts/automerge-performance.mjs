import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  AutomergeSystemRelationState,
  projectAutomergeFacts
} from '../packages/automerge/dist/index.js';

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

const projections = [measureProjection(400), measureProjection(800)];
const staleEvents = measureStaleEvent(800, 1_000);
const contracts = {
  exactProjectionWithinBound: projections[0].completeness === 'exact' && projections[0].milliseconds <= 50,
  hostileDepthIsBounded: projections[1].completeness === 'unknown' && projections[1].propertyCount <= 513 && projections[1].milliseconds <= 50,
  staleEventConstantTime: staleEvents.millisecondsPerEvent <= 0.05
};
const failures = Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name);

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-automerge-projection-and-system-state',
  contracts,
  projections,
  staleEvents,
  node: process.version
}, null, 2) + '\n');
if (failures.length > 0) throw new Error('Automerge performance contracts failed: ' + failures.join(', '));
