import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { evaluateQuery, openIncrementalQueryMaintenance } from '../packages/core/dist/index.js';

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

let consumedRows = 0;
const benchmark = (label, inputRows, iterations, operation) => {
  for (let index = 0; index < Math.min(iterations, 10); index += 1) consumedRows += operation(index).rows.length;
  globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) consumedRows += operation(index).rows.length;
  const elapsed = performance.now() - started;
  return { label, inputRows, iterations, millisecondsPerOperation: Number((elapsed / iterations).toFixed(3)) };
};

const measurements = [];
for (const [count, iterations] of [[100, 1_000], [1_000, 200], [10_000, 20]]) {
  const relation = input('item', linearRows(count));
  measurements.push(benchmark('linear-pure', count, iterations, () => evaluateQuery({ root: linearQuery, relations: [relation] })));

  const first = { relations: [relation] };
  const second = { relations: [input('item', linearRows(count, true))] };
  const session = openIncrementalQueryMaintenance(plan('linear-' + count, linearQuery), first);
  measurements.push(benchmark('linear-one-row-update', count, iterations, (index) => session.updateSnapshot(index % 2 === 0 ? second : first)));
  session.close();
}

for (const [count, iterations] of [[50, 100], [100, 30], [200, 8], [400, 2]]) {
  const relations = [input('left', joinRows(count, true)), input('right', joinRows(count, false))];
  measurements.push(benchmark('equijoin-pure', count * 2, iterations, () => evaluateQuery({ root: joinQuery, relations })));
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

const post = (session, method, parameters = {}) => new Promise((resolve, reject) => session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
const allocationSession = new inspector.Session();
allocationSession.connect();
await post(allocationSession, 'HeapProfiler.enable');
await post(allocationSession, 'HeapProfiler.startSampling', { samplingInterval: 1_024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
{
  const first = { relations: [input('item', linearRows(1_000))] };
  const second = { relations: [input('item', linearRows(1_000, true))] };
  const session = openIncrementalQueryMaintenance(plan('allocation-sample', linearQuery), first);
  for (let index = 0; index < 100; index += 1) consumedRows += session.updateSnapshot(index % 2 === 0 ? second : first).rows.length;
  session.close();
}
const { profile } = await post(allocationSession, 'HeapProfiler.stopSampling');
allocationSession.disconnect();
const sampledAllocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-query-scaling',
  note: 'Diagnostic evidence only; timings are not release thresholds.',
  measurements,
  allocationSample: {
    workload: '100 one-row updates over a 1,000-row linear query',
    sampledBytes: sampledAllocationBytes,
    sampledBytesPerUpdate: Math.round(sampledAllocationBytes / 100)
  },
  node: process.version,
  consumedRows
}, null, 2) + '\n');
