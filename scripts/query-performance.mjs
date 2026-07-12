import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { diffQueryMaintenanceSnapshots, evaluateQuery, openIncrementalQueryMaintenance } from '../packages/core/dist/index.js';
import { createPooledIncrementalQueryRuntime } from '../packages/core/dist/query.js';

const schemaView = { id: 'urn:tarstate:benchmark:schema', contentHash: 'sha256:' + 'a'.repeat(64) };
const use = (relationId) => ({ schemaView, relationId });
const from = (relationId, alias) => ({ kind: 'from', relation: use(relationId), alias });
const field = (alias, name) => ({ kind: 'field', alias, name });
const input = (relationId, rows) => ({
  relation: use(relationId),
  rows,
  occurrenceIds: rows.map((row, index) => relationId + ':' + (row.id ?? index)),
  completeness: 'exact',
  sourceId: 'source:' + relationId,
  attachmentId: 'attachment:' + relationId
});
const plan = (name, query) => ({
  planId: 'benchmark:' + name,
  rootNodeId: 'benchmark:' + name + ':root',
  query,
  registryFingerprint: 'benchmark:registry',
  authorityFingerprint: 'benchmark:authority',
  datasetId: 'benchmark:dataset'
});

const linearQuery = {
  kind: 'select',
  alias: 'result',
  input: {
    kind: 'where',
    input: from('item', 'item'),
    predicate: { kind: 'compare', op: 'eq', left: field('item', 'active'), right: { kind: 'literal', value: true } }
  },
  fields: { id: field('item', 'id'), value: field('item', 'value') }
};
const joinQuery = {
  kind: 'join',
  join: 'inner',
  left: from('left', 'left'),
  right: from('right', 'right'),
  on: { kind: 'compare', op: 'eq', left: field('left', 'joinId'), right: field('right', 'id') }
};
const linearRows = (count, changed = false) => Array.from({ length: count }, (_, id) => ({ id, active: id % 2 === 0, value: id === 0 && changed ? 1 : 0 }));
const joinRows = (count, left, changed = false) => Array.from({ length: count }, (_, id) => left ? { id, joinId: id, value: id === 0 && changed ? 1 : 0 } : { id, label: 'row-' + id });
const nestedRows = (count, changed = false) => Array.from({ length: count }, (_, id) => ({ id, payload: { label: 'row-' + id, values: [id, id + 1, id === 0 && changed ? 1 : 0] } }));

let consumedRows = 0;
const benchmark = (label, inputRows, iterations, operation) => {
  for (let index = 0; index < Math.min(iterations, 10); index += 1) consumedRows += operation(index).rows.length;
  globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) consumedRows += operation(index).rows.length;
  const elapsed = performance.now() - started;
  return { label, inputRows, iterations, millisecondsPerOperation: Number((elapsed / iterations).toFixed(3)) };
};

const timedOperation = (iterations, operation) => {
  for (let index = 0; index < Math.min(iterations, 5); index += 1) consumedRows += operation(index);
  globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) consumedRows += operation(index);
  return Number(((performance.now() - started) / iterations).toFixed(3));
};

const pooledEnvironment = (runtimeIdentity) => ({
  runtimeIdentity,
  registryFingerprint: 'benchmark:registry',
  authorityFingerprint: 'benchmark:authority',
  datasetId: 'benchmark:dataset'
});

const physicalDiagnostics = ({
  activeRootCount,
  physicalNodeCount,
  sharedPhysicalNodeCount,
  lastUpdatedPhysicalNodeCount,
  lastChangedPhysicalNodeCount,
  lastCollectedPhysicalNodeCount
}) => ({
  activeRootCount,
  physicalNodeCount,
  sharedPhysicalNodeCount,
  lastUpdatedPhysicalNodeCount,
  lastChangedPhysicalNodeCount,
  lastCollectedPhysicalNodeCount
});

const measurements = [];
for (const [count, iterations] of [[100, 1_000], [1_000, 200], [10_000, 20]]) {
  const relation = input('item', linearRows(count));
  measurements.push(benchmark('linear-pure', count, iterations, () => evaluateQuery({ root: linearQuery, relations: [relation] })));

  const first = { relations: [relation] };
  const second = { relations: [input('item', linearRows(count, true))] };
  const session = openIncrementalQueryMaintenance(plan('linear-' + count, linearQuery), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  measurements.push(benchmark('linear-one-row-update', count, iterations, (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
  let accepted = first;
  const endToEnd = openIncrementalQueryMaintenance(plan('linear-end-to-end-' + count, linearQuery), accepted);
  measurements.push(benchmark('linear-snapshot-diff-and-update', count, iterations, (index) => {
    const next = index % 2 === 0 ? second : first;
    const result = endToEnd.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
    accepted = next;
    return result;
  }));
  endToEnd.close();
}

const functionCapability = { id: 'urn:tarstate:benchmark:identity', version: '1', contractHash: 'sha256:' + 'f'.repeat(64) };
const functionKey = functionCapability.id + '\u0000' + functionCapability.version + '\u0000' + functionCapability.contractHash;
const functions = new Map([[functionKey, ([value]) => value ?? null]]);
const nestedQuery = from('nested', 'nested');
const functionQuery = { kind: 'select', input: nestedQuery, alias: 'result', fields: {
  id: field('nested', 'id'),
  payload: { kind: 'call', capability: functionCapability, args: [field('nested', 'payload')] }
} };
for (const [count, iterations] of [[100, 300], [1_000, 50], [10_000, 5]]) {
  const first = { relations: [input('nested', nestedRows(count))] };
  const second = { relations: [input('nested', nestedRows(count, true))] };
  measurements.push(benchmark('nested-pure-ownership', count, iterations, () => evaluateQuery({ root: nestedQuery, relations: first.relations })));
  const session = openIncrementalQueryMaintenance(plan('nested-ownership-' + count, nestedQuery), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  measurements.push(benchmark('nested-one-row-update', count, iterations, (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
  measurements.push(benchmark('named-function-ownership', count, iterations, () => evaluateQuery({ root: functionQuery, relations: first.relations, functions })));
}

for (const [count, iterations] of [[50, 100], [100, 30], [200, 8], [400, 2]]) {
  const relations = [input('left', joinRows(count, true)), input('right', joinRows(count, false))];
  measurements.push(benchmark('equijoin-pure', count * 2, iterations, () => evaluateQuery({ root: joinQuery, relations })));
  const changed = { relations: [input('left', joinRows(count, true, true)), relations[1]] };
  const initial = { relations };
  const session = openIncrementalQueryMaintenance(plan('join-' + count, joinQuery), initial);
  const forward = diffQueryMaintenanceSnapshots(initial, changed);
  const backward = diffQueryMaintenanceSnapshots(changed, initial);
  measurements.push(benchmark('equijoin-one-row-update', count * 2, Math.max(10, iterations), (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
}

for (const [count, iterations] of [[100, 300], [1_000, 30], [10_000, 3]]) {
  const rows = Array.from({ length: count }, (_, id) => ({ id, group: id % 100, score: count - id }));
  const relations = [input('score', rows)];
  const order = { kind: 'order', input: from('score', 'score'), by: [{ value: field('score', 'score'), direction: 'asc' }] };
  const aggregate = { kind: 'aggregate', input: from('score', 'score'), alias: 'summary', groupBy: { group: field('score', 'group') }, measures: {
    count: { kind: 'aggregate', op: 'count' },
    sum: { kind: 'aggregate', op: 'sum', value: field('score', 'score') },
    minimum: { kind: 'aggregate', op: 'minimum', value: field('score', 'score') },
    maximum: { kind: 'aggregate', op: 'maximum', value: field('score', 'score') }
  } };
  measurements.push(benchmark('order', count, iterations, () => evaluateQuery({ root: order, relations })));
  measurements.push(benchmark('aggregate', count, iterations, () => evaluateQuery({ root: aggregate, relations })));
  if (count <= 1_000) {
    const orderBy = [{ value: field('score', 'score'), direction: 'asc' }];
    const window = { kind: 'window', input: from('score', 'score'), alias: 'score', fields: {
      rowNumber: { kind: 'window', op: 'row-number', orderBy },
      rank: { kind: 'window', op: 'rank', orderBy },
      previous: { kind: 'window', op: 'lag', value: field('score', 'score'), orderBy }
    } };
    measurements.push(benchmark('window-three-fields', count, iterations, () => evaluateQuery({ root: window, relations })));
  }
}

for (const [count, iterations] of [[10, 100], [20, 30], [40, 5], [80, 1]]) {
  const recursive = {
    kind: 'recursive',
    name: 'nodes',
    seed: { kind: 'values', alias: 'node', rows: [{ id: 0 }] },
    step: {
      kind: 'select',
      alias: 'node',
      input: { kind: 'join', join: 'inner', left: { kind: 'recursion-ref', name: 'nodes' }, right: from('edge', 'edge'), on: { kind: 'compare', op: 'eq', left: field('node', 'id'), right: field('edge', 'parentId') } },
      fields: { id: field('edge', 'targetId') }
    },
    key: [field('node', 'id')],
    maxIterations: count + 1
  };
  const edges = Array.from({ length: count }, (_, id) => ({ id: 'edge-' + id, parentId: id, targetId: id + 1 }));
  measurements.push(benchmark('recursive-chain', count, iterations, () => evaluateQuery({ root: recursive, relations: [input('edge', edges)] })));
}

const pooledMeasurements = [];
const clonedPrefix = () => ({
  kind: 'where',
  input: from('item', 'item'),
  predicate: { kind: 'compare', op: 'eq', left: field('item', 'active'), right: { kind: 'literal', value: true } }
});

for (const fanout of [1, 10, 50, 100]) {
  const first = { relations: [input('item', linearRows(1_000))] };
  const second = { relations: [input('item', linearRows(1_000, true))] };
  const runtime = createPooledIncrementalQueryRuntime({ environment: pooledEnvironment('fanout-' + fanout), initialSnapshot: first });
  const roots = Array.from({ length: fanout }, (_, index) => runtime.attach(plan('fanout-' + fanout + '-' + index, {
    kind: 'select',
    alias: 'result-' + index,
    input: clonedPrefix(),
    fields: { id: field('item', 'id'), value: field('item', 'value') }
  })));
  const afterAttach = physicalDiagnostics(runtime.getDiagnostics());
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  let update = 0;
  const millisecondsPerUpdate = timedOperation(30, () => {
    runtime.applyUpdate(update++ % 2 === 0 ? forward : backward);
    return roots[0].getCurrentResult().rows.length;
  });
  pooledMeasurements.push({
    scenario: 'cloned-root-fanout', fanout, inputRows: 1_000, iterations: 30,
    millisecondsPerUpdate, afterAttach, afterUpdate: physicalDiagnostics(runtime.getDiagnostics())
  });
  for (const root of roots) root.close();
  runtime.close();
}

const deepPipeline = (depth) => {
  let query = from('item', 'item');
  for (let index = 0; index < depth; index += 1) {
    query = { kind: 'where', input: query, predicate: { kind: 'literal', value: true } };
  }
  return query;
};

for (const [depth, iterations] of [[10, 30], [25, 20], [50, 10], [100, 5]]) {
  const initial = { relations: [input('item', linearRows(10))] };
  const query = deepPipeline(depth);
  const sample = createPooledIncrementalQueryRuntime({ environment: pooledEnvironment('depth-sample-' + depth), initialSnapshot: initial });
  const sampleRoot = sample.attach(plan('depth-sample-' + depth, query));
  const diagnostics = physicalDiagnostics(sample.getDiagnostics());
  sampleRoot.close();
  sample.close();
  const millisecondsPerAttachClose = timedOperation(iterations, (index) => {
    const runtime = createPooledIncrementalQueryRuntime({ environment: pooledEnvironment('depth-' + depth + '-' + index), initialSnapshot: initial });
    const root = runtime.attach(plan('depth-' + depth + '-' + index, query));
    const rows = root.getCurrentResult().rows.length;
    root.close();
    runtime.close();
    return rows;
  });
  pooledMeasurements.push({
    scenario: 'pipeline-depth-attach', depth, inputRows: 10, iterations,
    millisecondsPerAttachClose, afterAttach: diagnostics
  });
}

for (const rootCount of [10, 50, 100, 1_000]) {
  const relations = Array.from({ length: rootCount }, (_, index) => input('unrelated-' + index, linearRows(10)));
  const changedRelations = [...relations];
  changedRelations[0] = input('unrelated-0', linearRows(10, true));
  const first = { relations };
  const second = { relations: changedRelations };
  const runtime = createPooledIncrementalQueryRuntime({ environment: pooledEnvironment('unrelated-' + rootCount), initialSnapshot: first });
  const roots = Array.from({ length: rootCount }, (_, index) => runtime.attach(plan('unrelated-' + index, {
    kind: 'select',
    alias: 'result',
    input: from('unrelated-' + index, 'item'),
    fields: { id: field('item', 'id'), value: field('item', 'value') }
  })));
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  let update = 0;
  const millisecondsPerUpdate = timedOperation(50, () => {
    runtime.applyUpdate(update++ % 2 === 0 ? forward : backward);
    return roots[0].getCurrentResult().rows.length;
  });
  const afterUpdate = physicalDiagnostics(runtime.getDiagnostics());
  pooledMeasurements.push({
    scenario: 'unrelated-relation-union-dag', rootCount, inputRows: rootCount * 10, iterations: 50,
    millisecondsPerUpdate,
    selectiveVisitedPhysicalNodeCount: afterUpdate.lastUpdatedPhysicalNodeCount,
    selectiveChangedPhysicalNodeCount: afterUpdate.lastChangedPhysicalNodeCount,
    afterUpdate
  });
  for (const root of roots) root.close();
  runtime.close();
}

for (const residentRootCount of [100, 1_000]) {
  const initial = { relations: [input('item', linearRows(10))] };
  const runtime = createPooledIncrementalQueryRuntime({ environment: pooledEnvironment('churn-' + residentRootCount), initialSnapshot: initial });
  const residents = Array.from({ length: residentRootCount }, (_, index) => runtime.attach(plan('resident-' + index, {
    kind: 'select', alias: 'resident-' + index, input: clonedPrefix(), fields: { id: field('item', 'id') }
  })));
  let churn = 0;
  const millisecondsPerAttachClose = timedOperation(100, () => {
    const index = churn++;
    const root = runtime.attach(plan('churn-' + index, {
      kind: 'select', alias: 'churn-' + index, input: clonedPrefix(), fields: { id: field('item', 'id') }
    }));
    const rows = root.getCurrentResult().rows.length;
    root.close();
    return rows;
  });
  pooledMeasurements.push({
    scenario: 'attach-close-churn', residentRootCount, inputRows: 10, iterations: 100,
    millisecondsPerAttachClose, afterChurn: physicalDiagnostics(runtime.getDiagnostics())
  });
  for (const root of residents) root.close();
  runtime.close();
}

const post = (session, method, parameters = {}) => new Promise((resolve, reject) => session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
const allocationSession = new inspector.Session();
allocationSession.connect();
await post(allocationSession, 'HeapProfiler.enable');
await post(allocationSession, 'HeapProfiler.startSampling', { samplingInterval: 1_024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
{
  const first = { relations: [input('item', linearRows(1_000))] };
  const second = { relations: [input('item', linearRows(1_000, true))] };
  const session = openIncrementalQueryMaintenance(plan('allocation-sample', linearQuery), first);
  let accepted = first;
  for (let index = 0; index < 100; index += 1) {
    const next = index % 2 === 0 ? second : first;
    consumedRows += session.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next)).rows.length;
    accepted = next;
  }
  session.close();
}
const { profile } = await post(allocationSession, 'HeapProfiler.stopSampling');
allocationSession.disconnect();
const sampledAllocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);

const pooledAllocationFirst = { relations: [input('item', linearRows(1_000))] };
const pooledAllocationSecond = { relations: [input('item', linearRows(1_000, true))] };
const pooledAllocationRuntime = createPooledIncrementalQueryRuntime({
  environment: pooledEnvironment('allocation-pooled-fanout-100'), initialSnapshot: pooledAllocationFirst
});
const pooledAllocationRoots = Array.from({ length: 100 }, (_, index) => pooledAllocationRuntime.attach(plan('allocation-pooled-' + index, {
  kind: 'select', alias: 'allocation-' + index, input: clonedPrefix(), fields: { id: field('item', 'id') }
})));
const pooledAllocationForward = diffQueryMaintenanceSnapshots(pooledAllocationFirst, pooledAllocationSecond);
const pooledAllocationBackward = diffQueryMaintenanceSnapshots(pooledAllocationSecond, pooledAllocationFirst);
const pooledAllocationSession = new inspector.Session();
pooledAllocationSession.connect();
await post(pooledAllocationSession, 'HeapProfiler.enable');
await post(pooledAllocationSession, 'HeapProfiler.startSampling', { samplingInterval: 1_024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (let index = 0; index < 100; index += 1) {
  pooledAllocationRuntime.applyUpdate(index % 2 === 0 ? pooledAllocationForward : pooledAllocationBackward);
  consumedRows += pooledAllocationRoots[0].getCurrentResult().rows.length;
}
const { profile: pooledAllocationProfile } = await post(pooledAllocationSession, 'HeapProfiler.stopSampling');
pooledAllocationSession.disconnect();
for (const root of pooledAllocationRoots) root.close();
pooledAllocationRuntime.close();
const pooledSampledAllocationBytes = pooledAllocationProfile.samples.reduce((sum, sample) => sum + sample.size, 0);

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-query-scaling',
  note: 'Diagnostic evidence only; timings are not release thresholds.',
  measurements,
  pooledMeasurements,
  allocationSample: {
    workload: '100 snapshot diffs plus one-row updates over a 1,000-row linear query',
    sampledBytes: sampledAllocationBytes,
    sampledBytesPerUpdate: Math.round(sampledAllocationBytes / 100)
  },
  pooledAllocationSample: {
    workload: '100 one-row updates over 100 pooled roots and 1,000 input rows',
    sampledBytes: pooledSampledAllocationBytes,
    sampledBytesPerUpdate: Math.round(pooledSampledAllocationBytes / 100)
  },
  node: process.version,
  consumedRows
}, null, 2) + '\n');
