import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { diffQueryMaintenanceSnapshots, evaluateExpression, evaluatePreparedExpression, evaluatePreparedQuery, evaluateQuery, openIncrementalQueryMaintenance, prepareExpression, preparePlan, prepareQueryMaintenanceSnapshot } from '../packages/core/dist/query.js';
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
const plan = (_name, query) => preparePlan({
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
  const samples = Array.from({ length: 3 }, () => {
    globalThis.gc();
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) consumedRows += operation(index).rows.length;
    return (performance.now() - started) / iterations;
  }).sort((left, right) => left - right);
  return { label, inputRows, iterations, sampleCount: samples.length, millisecondsPerOperation: Number((samples[1]).toFixed(3)) };
};
const benchmarkScalar = (label, iterations, operation) => {
  for (let index = 0; index < Math.min(iterations, 10); index += 1) consumedRows += operation(index) === undefined ? 0 : 1;
  const samples = Array.from({ length: 3 }, () => {
    globalThis.gc();
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) consumedRows += operation(index) === undefined ? 0 : 1;
    return (performance.now() - started) / iterations;
  }).sort((left, right) => left - right);
  return { label, inputRows: 1, iterations, sampleCount: samples.length, millisecondsPerOperation: Number(samples[1].toFixed(3)) };
};

const timedOperation = (iterations, operation) => {
  for (let index = 0; index < Math.min(iterations, 5); index += 1) consumedRows += operation(index);
  const samples = Array.from({ length: 3 }, () => {
    globalThis.gc();
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) consumedRows += operation(index);
    return (performance.now() - started) / iterations;
  }).sort((left, right) => left - right);
  return Number((samples[1]).toFixed(3));
};

const allocationHotspots = (profile, limit = 8) => {
  const nodesById = new Map();
  const visit = (node) => {
    nodesById.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile.head);
  const bytesByFrame = new Map();
  for (const sample of profile.samples) {
    const frame = nodesById.get(sample.nodeId)?.callFrame;
    const key = frame === undefined
      ? 'unknown'
      : `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
    bytesByFrame.set(key, (bytesByFrame.get(key) ?? 0) + sample.size);
  }
  return [...bytesByFrame]
    .sort(([, left], [, right]) => right - left)
    .slice(0, limit)
    .map(([frame, bytes]) => ({ frame, bytes }));
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
const repeatedQuery = (() => {
  let query = from('item', 'item');
  for (let depth = 0; depth < 50; depth += 1) query = { kind: 'where', input: query, predicate: { kind: 'literal', value: true } };
  return query;
})();
const repeatedInputs = { relations: [input('item', linearRows(1))] };
const ownedRepeatedInputs = prepareQueryMaintenanceSnapshot(repeatedInputs);
const repeatedPlan = await plan('repeated-pure', repeatedQuery);
measurements.push(benchmark('repeated-unprepared-pure', 1, 500, () => evaluateQuery({ root: repeatedQuery, ...repeatedInputs })));
measurements.push(benchmark('repeated-prepared-pure', 1, 500, () => evaluatePreparedQuery(repeatedPlan, repeatedInputs)));
measurements.push(benchmark('repeated-owned-prepared-pure', 1, 500, () => evaluatePreparedQuery(repeatedPlan, ownedRepeatedInputs)));
let deepExpression = { kind: 'field', alias: 'row', name: 'value' };
for (let depth = 0; depth < 50; depth += 1) deepExpression = { kind: 'arithmetic', op: 'add', left: deepExpression, right: { kind: 'literal', value: 1 } };
const preparedDeepExpression = prepareExpression(deepExpression);
const deepExpressionRow = { row: { value: 1 } };
measurements.push(benchmarkScalar('repeated-unprepared-expression', 2_000, () => evaluateExpression(deepExpression, deepExpressionRow)));
measurements.push(benchmarkScalar('repeated-prepared-expression', 2_000, () => evaluatePreparedExpression(preparedDeepExpression, deepExpressionRow)));
for (const [count, iterations] of [[100, 1_000], [1_000, 200], [10_000, 20]]) {
  const relation = input('item', linearRows(count));
  const linearPlan = await plan('linear-pure-' + count, linearQuery);
  measurements.push(benchmark('linear-pure', count, iterations, () => evaluatePreparedQuery(linearPlan, { relations: [relation] })));
  const ownedLinear = prepareQueryMaintenanceSnapshot({ relations: [relation] });
  measurements.push(benchmark('linear-owned-prepared-pure', count, iterations, () => evaluatePreparedQuery(linearPlan, ownedLinear)));
  measurements.push(benchmark('linear-direct-js-baseline', count, iterations, () => ({
    rows: relation.rows.filter(({ active }) => active === true).map(({ id, value }) => ({ id, value }))
  })));

  const first = { relations: [relation] };
  const second = { relations: [input('item', linearRows(count, true))] };
  const session = openIncrementalQueryMaintenance(linearPlan, first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  measurements.push(benchmark('linear-one-row-update', count, iterations, (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
  let accepted = first;
  const endToEnd = openIncrementalQueryMaintenance(await plan('linear-end-to-end-' + count, linearQuery), accepted);
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
for (const [count, iterations] of [[100, 300], [1_000, 50], [10_000, 10]]) {
  const first = { relations: [input('nested', nestedRows(count))] };
  const second = { relations: [input('nested', nestedRows(count, true))] };
  const nestedPlan = await plan('nested-ownership-' + count, nestedQuery);
  measurements.push(benchmark('nested-pure-ownership', count, iterations, () => evaluatePreparedQuery(nestedPlan, { relations: first.relations })));
  const session = openIncrementalQueryMaintenance(nestedPlan, first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  measurements.push(benchmark('nested-one-row-update', count, iterations, (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
  measurements.push(benchmark('named-function-ownership', count, iterations, () => evaluateQuery({ root: functionQuery, relations: first.relations, functions })));
}

for (const [count, iterations] of [[50, 100], [100, 30], [200, 8], [400, 5]]) {
  const relations = [input('left', joinRows(count, true)), input('right', joinRows(count, false))];
  const joinPlan = await plan('join-' + count, joinQuery);
  measurements.push(benchmark('equijoin-pure', count * 2, iterations, () => evaluatePreparedQuery(joinPlan, { relations })));
  const changed = { relations: [input('left', joinRows(count, true, true)), relations[1]] };
  const initial = { relations };
  const session = openIncrementalQueryMaintenance(joinPlan, initial);
  const forward = diffQueryMaintenanceSnapshots(initial, changed);
  const backward = diffQueryMaintenanceSnapshots(changed, initial);
  measurements.push(benchmark('equijoin-one-row-update', count * 2, Math.max(10, iterations), (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
}

for (const [count, iterations] of [[100, 300], [1_000, 30], [10_000, 5]]) {
  const rows = Array.from({ length: count }, (_, id) => ({ id, group: id % 100, score: id * 7_919 % count, active: id % 3 === 0 }));
  const relations = [input('score', rows)];
  const order = { kind: 'order', input: from('score', 'score'), by: [{ value: field('score', 'score'), direction: 'asc' }] };
  const objectKeyOrder = { kind: 'order', input: from('score', 'score'), by: [{ value: { kind: 'record', fields: { group: field('score', 'group'), score: field('score', 'score') } }, direction: 'asc' }] };
  const scalarEquality = { kind: 'where', input: from('score', 'score'), predicate: { kind: 'compare', op: 'eq', left: field('score', 'score'), right: field('score', 'score') } };
  const equalityRecord = { kind: 'record', fields: { group: field('score', 'group'), score: field('score', 'score') } };
  const objectEquality = { kind: 'where', input: from('score', 'score'), predicate: { kind: 'compare', op: 'eq', left: equalityRecord, right: equalityRecord } };
  const distinct = { kind: 'distinct', input: { kind: 'select', input: from('score', 'score'), alias: 'value', fields: { group: field('score', 'group') } } };
  const aggregate = { kind: 'aggregate', input: from('score', 'score'), alias: 'summary', groupBy: { group: field('score', 'group') }, measures: {
    count: { kind: 'aggregate', op: 'count' },
    sum: { kind: 'aggregate', op: 'sum', value: field('score', 'score') },
    minimum: { kind: 'aggregate', op: 'minimum', value: field('score', 'score') },
    maximum: { kind: 'aggregate', op: 'maximum', value: field('score', 'score') }
  } };
  const reducerMeasures = {
    count: { kind: 'aggregate', op: 'count' },
    distinct: { kind: 'aggregate', op: 'count-distinct', value: field('score', 'score') },
    minimum: { kind: 'aggregate', op: 'minimum', value: field('score', 'score') },
    maximum: { kind: 'aggregate', op: 'maximum', value: field('score', 'score') },
    any: { kind: 'aggregate', op: 'any', value: field('score', 'active') },
    every: { kind: 'aggregate', op: 'every', value: field('score', 'active') }
  };
  const groupedReducers = { kind: 'aggregate', input: from('score', 'score'), alias: 'summary', groupBy: { group: field('score', 'group') }, measures: reducerMeasures };
  const ungroupedReducers = { kind: 'aggregate', input: from('score', 'score'), alias: 'summary', groupBy: {}, measures: reducerMeasures };
  const orderPlan = await plan('order-pure-' + count, order);
  const objectKeyOrderPlan = await plan('order-object-key-pure-' + count, objectKeyOrder);
  const scalarEqualityPlan = await plan('equality-scalar-pure-' + count, scalarEquality);
  const objectEqualityPlan = await plan('equality-object-pure-' + count, objectEquality);
  const aggregatePlan = await plan('aggregate-pure-' + count, aggregate);
  const distinctPlan = await plan('distinct-pure-' + count, distinct);
  const groupedReducerPlan = await plan('aggregate-reducer-grouped-pure-' + count, groupedReducers);
  const ungroupedReducerPlan = await plan('aggregate-reducer-ungrouped-pure-' + count, ungroupedReducers);
  measurements.push(benchmark('order', count, iterations, () => evaluatePreparedQuery(orderPlan, { relations })));
  measurements.push(benchmark('order-prepared-scalar-key', count, iterations, () => evaluatePreparedQuery(orderPlan, { relations })));
  measurements.push(benchmark('order-prepared-object-key', count, iterations, () => evaluatePreparedQuery(objectKeyOrderPlan, { relations })));
  measurements.push(benchmark('equality-prepared-scalar', count, iterations, () => evaluatePreparedQuery(scalarEqualityPlan, { relations })));
  measurements.push(benchmark('equality-prepared-object', count, iterations, () => evaluatePreparedQuery(objectEqualityPlan, { relations })));
  measurements.push(benchmark('aggregate', count, iterations, () => evaluatePreparedQuery(aggregatePlan, { relations })));
  measurements.push(benchmark('distinct', count, iterations, () => evaluatePreparedQuery(distinctPlan, { relations })));
  measurements.push(benchmark('aggregate-reducer-grouped', count, iterations, () => evaluatePreparedQuery(groupedReducerPlan, { relations })));
  measurements.push(benchmark('aggregate-reducer-ungrouped', count, iterations, () => evaluatePreparedQuery(ungroupedReducerPlan, { relations })));
  measurements.push(benchmark('aggregate-reducer-grouped-open', count, iterations, () => {
    const session = openIncrementalQueryMaintenance(groupedReducerPlan, { relations });
    const result = session.getCurrentResult();
    session.close();
    return result;
  }));
  const changedRows = rows.map((row, index) => index === 0 ? { ...row, score: count + 1 } : row);
  const first = { relations };
  const second = { relations: [input('score', changedRows)] };
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  const updateIterations = iterations % 2 === 0 ? iterations : iterations + 1;
  const orderSession = openIncrementalQueryMaintenance(await plan('order-' + count, order), first);
  measurements.push(benchmark('order-one-row-update', count, updateIterations, (index) => orderSession.applyUpdate(index % 2 === 0 ? forward : backward)));
  orderSession.close();
  const aggregateSession = openIncrementalQueryMaintenance(await plan('aggregate-' + count, aggregate), first);
  measurements.push(benchmark('aggregate-one-row-update', count, updateIterations, (index) => aggregateSession.applyUpdate(index % 2 === 0 ? forward : backward)));
  aggregateSession.close();
  const groupedReducerSession = openIncrementalQueryMaintenance(groupedReducerPlan, first);
  measurements.push(benchmark('aggregate-reducer-grouped-one-row-update', count, updateIterations, (index) => groupedReducerSession.applyUpdate(index % 2 === 0 ? forward : backward)));
  groupedReducerSession.close();
  const ungroupedReducerSession = openIncrementalQueryMaintenance(ungroupedReducerPlan, first);
  measurements.push(benchmark('aggregate-reducer-ungrouped-one-row-update', count, updateIterations, (index) => ungroupedReducerSession.applyUpdate(index % 2 === 0 ? forward : backward)));
  ungroupedReducerSession.close();
  const distinctChanged = { relations: [input('score', rows.map((row, index) => index === 0 ? { ...row, group: 101 } : row))] };
  const distinctSession = openIncrementalQueryMaintenance(distinctPlan, first);
  const distinctForward = diffQueryMaintenanceSnapshots(first, distinctChanged);
  const distinctBackward = diffQueryMaintenanceSnapshots(distinctChanged, first);
  measurements.push(benchmark('distinct-one-row-update', count, updateIterations, (index) => distinctSession.applyUpdate(index % 2 === 0 ? distinctForward : distinctBackward)));
  distinctSession.close();
  if (count <= 10_000) {
    const orderBy = [{ value: field('score', 'score'), direction: 'asc' }];
    const window = { kind: 'window', input: from('score', 'score'), alias: 'score', fields: {
      rowNumber: { kind: 'window', op: 'row-number', orderBy },
      rank: { kind: 'window', op: 'rank', orderBy },
      previous: { kind: 'window', op: 'lag', value: field('score', 'score'), orderBy }
    } };
    measurements.push(benchmark('window-three-fields', count, iterations, () => evaluateQuery({ root: window, relations })));
    const windowSession = openIncrementalQueryMaintenance(await plan('window-' + count, window), first);
    measurements.push(benchmark('window-one-row-update', count, updateIterations, (index) => windowSession.applyUpdate(index % 2 === 0 ? forward : backward)));
    windowSession.close();
    const partitionBy = [field('score', 'group')];
    const partitionedWindow = { ...window, fields: {
      rowNumber: { kind: 'window', op: 'row-number', partitionBy, orderBy },
      rank: { kind: 'window', op: 'rank', partitionBy, orderBy },
      previous: { kind: 'window', op: 'lag', value: field('score', 'score'), partitionBy, orderBy }
    } };
    const partitionedWindowPlan = await plan('window-partitioned-' + count, partitionedWindow);
    measurements.push(benchmark('window-partitioned-prepared-pure', count, iterations, () => evaluatePreparedQuery(partitionedWindowPlan, first)));
    const partitionedWindowSession = openIncrementalQueryMaintenance(partitionedWindowPlan, first);
    measurements.push(benchmark('window-partitioned-one-row-update', count, updateIterations, (index) => partitionedWindowSession.applyUpdate(index % 2 === 0 ? forward : backward)));
    partitionedWindowSession.close();
  }
}

{
  const uniqueKeyCount = 10_000;
  const rows = [...Array.from({ length: uniqueKeyCount }, (_, id) => ({ id, key: id })), { id: uniqueKeyCount, key: 0 }];
  const changedRows = rows.map((row, index) => index === uniqueKeyCount ? { ...row, key: 1 } : row);
  const first = { relations: [input('distinct-high-cardinality', rows)] };
  const second = { relations: [input('distinct-high-cardinality', changedRows)] };
  const query = { kind: 'distinct', input: { kind: 'select', input: from('distinct-high-cardinality', 'row'), alias: 'value', fields: { key: field('row', 'key') } } };
  const highCardinalityPlan = await plan('distinct-high-cardinality', query);
  measurements.push(benchmark('distinct-high-cardinality-prepared-pure', rows.length, 5, () => evaluatePreparedQuery(highCardinalityPlan, first)));
  const session = openIncrementalQueryMaintenance(highCardinalityPlan, first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  measurements.push(benchmark('distinct-high-cardinality-hidden-update', rows.length, 200, (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
}

{
  const count = 5_000;
  const relations = [input('left', joinRows(count, true)), input('right', joinRows(count, false))];
  const initial = { relations };
  const changed = { relations: [relations[0], input('right', joinRows(count, false).map((row, index) => index === 0 ? { ...row, label: 'changed' } : row))] };
  const prepared = await plan('join-right-' + count, joinQuery);
  measurements.push(benchmark('equijoin-prepared-pure', count * 2, 6, () => evaluatePreparedQuery(prepared, initial)));
  const session = openIncrementalQueryMaintenance(prepared, initial);
  const forward = diffQueryMaintenanceSnapshots(initial, changed);
  const backward = diffQueryMaintenanceSnapshots(changed, initial);
  measurements.push(benchmark('equijoin-right-one-row-update', count * 2, 6, (index) => session.applyUpdate(index % 2 === 0 ? forward : backward)));
  session.close();
  const leftChanged = { relations: [input('left', joinRows(count, true, true)), relations[1]] };
  const leftSession = openIncrementalQueryMaintenance(prepared, initial);
  const leftForward = diffQueryMaintenanceSnapshots(initial, leftChanged);
  const leftBackward = diffQueryMaintenanceSnapshots(leftChanged, initial);
  measurements.push(benchmark('equijoin-left-one-row-update', count * 2, 6, (index) => leftSession.applyUpdate(index % 2 === 0 ? leftForward : leftBackward)));
  leftSession.close();
}

for (const [count, iterations] of [[10, 100], [20, 60], [40, 30], [80, 15]]) {
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
  const reversedRecursive = {
    ...recursive,
    step: {
      kind: 'select',
      alias: 'node',
      input: { kind: 'join', join: 'inner', left: from('edge', 'edge'), right: { kind: 'recursion-ref', name: 'nodes' }, on: { kind: 'compare', op: 'eq', left: field('edge', 'parentId'), right: field('node', 'id') } },
      fields: { id: field('edge', 'targetId') }
    }
  };
  const edges = Array.from({ length: count }, (_, id) => ({ id: 'edge-' + id, parentId: id, targetId: id + 1 }));
  const recursivePlan = await plan('recursive-chain-' + count, recursive);
  const reversedRecursivePlan = await plan('recursive-chain-reversed-' + count, reversedRecursive);
  measurements.push(benchmark('recursive-chain', count, iterations, () => evaluatePreparedQuery(recursivePlan, { relations: [input('edge', edges)] })));
  measurements.push(benchmark('recursive-chain-reversed', count, iterations, () => evaluatePreparedQuery(reversedRecursivePlan, { relations: [input('edge', edges)] })));
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
  const roots = await Promise.all(Array.from({ length: fanout }, async (_, index) => runtime.attach(await plan('fanout-' + fanout + '-' + index, {
    kind: 'select',
    alias: 'result-' + index,
    input: clonedPrefix(),
    // The update changes `value`; omitting it here measures shared traversal
    // and semantic public-view reuse rather than unavoidable visible array
    // publication, which is linear in root count by construction.
    fields: { id: field('item', 'id') }
  }))));
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
  const prepared = await plan('depth-' + depth, query);
  const sampleRoot = sample.attach(prepared);
  const diagnostics = physicalDiagnostics(sample.getDiagnostics());
  sampleRoot.close();
  sample.close();
  const millisecondsPerAttachClose = timedOperation(iterations, (index) => {
    const runtime = createPooledIncrementalQueryRuntime({ environment: pooledEnvironment('depth-' + depth + '-' + index), initialSnapshot: initial });
    const root = runtime.attach(prepared);
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
  const roots = await Promise.all(Array.from({ length: rootCount }, async (_, index) => runtime.attach(await plan('unrelated-' + index, {
    kind: 'select',
    alias: 'result',
    input: from('unrelated-' + index, 'item'),
    fields: { id: field('item', 'id'), value: field('item', 'value') }
  }))));
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
  const residents = await Promise.all(Array.from({ length: residentRootCount }, async (_, index) => runtime.attach(await plan('resident-' + index, {
    kind: 'select', alias: 'resident-' + index, input: clonedPrefix(), fields: { id: field('item', 'id') }
  }))));
  const churnPlans = await Promise.all(Array.from({ length: 305 }, (_, index) => plan('churn-' + index, {
    kind: 'select', alias: 'churn-' + index, input: clonedPrefix(), fields: { id: field('item', 'id') }
  })));
  let churn = 0;
  const millisecondsPerAttachClose = timedOperation(100, () => {
    const index = churn++;
    const root = runtime.attach(churnPlans[index]);
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
const sampleUpdateAllocations = async (iterations, prepare) => {
  const workload = await prepare();
  globalThis.gc();
  const allocationSession = new inspector.Session();
  allocationSession.connect();
  await post(allocationSession, 'HeapProfiler.enable');
  await post(allocationSession, 'HeapProfiler.startSampling', { samplingInterval: 1_024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  let allocationProfile;
  try {
    for (let index = 0; index < iterations; index += 1) consumedRows += workload.update(index);
    ({ profile: allocationProfile } = await post(allocationSession, 'HeapProfiler.stopSampling'));
    return allocationProfile;
  } finally {
    if (allocationProfile === undefined) {
      try { await post(allocationSession, 'HeapProfiler.stopSampling'); } catch { /* preserve the workload failure */ }
    }
    allocationSession.disconnect();
    workload.close();
  }
};
const sampledBytes = (profile) => profile.samples.reduce((sum, sample) => sum + sample.size, 0);
const alternatingSessionWorkload = (session, forward, backward) => ({
  update: (index) => session.applyUpdate(index % 2 === 0 ? forward : backward).rows.length,
  close: () => session.close()
});
const reducerAggregateQuery = (groupBy) => ({
  kind: 'aggregate', input: from('score', 'score'), alias: 'summary', groupBy,
  measures: {
    count: { kind: 'aggregate', op: 'count' },
    distinct: { kind: 'aggregate', op: 'count-distinct', value: field('score', 'score') },
    minimum: { kind: 'aggregate', op: 'minimum', value: field('score', 'score') },
    maximum: { kind: 'aggregate', op: 'maximum', value: field('score', 'score') },
    any: { kind: 'aggregate', op: 'any', value: field('score', 'active') },
    every: { kind: 'aggregate', op: 'every', value: field('score', 'active') }
  }
});

const profile = await sampleUpdateAllocations(100, async () => {
  const first = { relations: [input('item', linearRows(1_000))] };
  const second = { relations: [input('item', linearRows(1_000, true))] };
  const session = openIncrementalQueryMaintenance(await plan('allocation-sample', linearQuery), first);
  let accepted = first;
  return {
    update: (index) => {
    const next = index % 2 === 0 ? second : first;
      const rowCount = session.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next)).rows.length;
    accepted = next;
      return rowCount;
    },
    close: () => session.close()
  };
});
const sampledAllocationBytes = sampledBytes(profile);

const leftJoinAllocationProfile = await sampleUpdateAllocations(100, async () => {
  const count = 1_000;
  const relations = [input('left', joinRows(count, true)), input('right', joinRows(count, false))];
  const first = { relations };
  const second = { relations: [input('left', joinRows(count, true, true)), relations[1]] };
  const session = openIncrementalQueryMaintenance(await plan('left-join-allocation-sample', joinQuery), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return alternatingSessionWorkload(session, forward, backward);
});
const leftJoinSampledAllocationBytes = sampledBytes(leftJoinAllocationProfile);

const rightJoinAllocationProfile = await sampleUpdateAllocations(100, async () => {
  const count = 1_000;
  const relations = [input('left', joinRows(count, true)), input('right', joinRows(count, false))];
  const first = { relations };
  const changedRight = joinRows(count, false).map((row, index) => index === 0 ? { ...row, label: 'changed' } : row);
  const second = { relations: [relations[0], input('right', changedRight)] };
  const session = openIncrementalQueryMaintenance(await plan('right-join-allocation-sample', joinQuery), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return alternatingSessionWorkload(session, forward, backward);
});
const rightJoinSampledAllocationBytes = sampledBytes(rightJoinAllocationProfile);

const aggregateAllocationProfile = await sampleUpdateAllocations(100, async () => {
  const rows = Array.from({ length: 1_000 }, (_, id) => ({ id, group: id % 100, score: id, active: id % 3 === 0 }));
  const changed = rows.map((row, index) => index === 0 ? { ...row, score: 2_000 } : row);
  const first = { relations: [input('score', rows)] };
  const second = { relations: [input('score', changed)] };
  const aggregateQuery = reducerAggregateQuery({ group: field('score', 'group') });
  const session = openIncrementalQueryMaintenance(await plan('aggregate-allocation-sample', aggregateQuery), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return alternatingSessionWorkload(session, forward, backward);
});
const aggregateSampledAllocationBytes = sampledBytes(aggregateAllocationProfile);

const ungroupedReducerAllocationProfile = await sampleUpdateAllocations(100, async () => {
  const rows = Array.from({ length: 1_000 }, (_, id) => ({ id, score: id, active: id % 3 === 0 }));
  const changed = rows.map((row, index) => index === 0 ? { ...row, score: 2_000, active: !row.active } : row);
  const first = { relations: [input('score', rows)] };
  const second = { relations: [input('score', changed)] };
  const aggregateQuery = reducerAggregateQuery({});
  const session = openIncrementalQueryMaintenance(await plan('aggregate-ungrouped-reducer-allocation-sample', aggregateQuery), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return alternatingSessionWorkload(session, forward, backward);
});
const ungroupedReducerSampledAllocationBytes = sampledBytes(ungroupedReducerAllocationProfile);

const distinctAllocationProfile = await sampleUpdateAllocations(100, async () => {
  const rows = Array.from({ length: 1_000 }, (_, id) => ({ id, group: id % 100 }));
  const changed = rows.map((row, index) => index === 0 ? { ...row, group: 101 } : row);
  const first = { relations: [input('score', rows)] };
  const second = { relations: [input('score', changed)] };
  const query = { kind: 'distinct', input: { kind: 'select', input: from('score', 'score'), alias: 'value', fields: { group: field('score', 'group') } } };
  const session = openIncrementalQueryMaintenance(await plan('distinct-allocation-sample', query), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return alternatingSessionWorkload(session, forward, backward);
});
const distinctSampledAllocationBytes = sampledBytes(distinctAllocationProfile);

const highCardinalityDistinctAllocationProfile = await sampleUpdateAllocations(200, async () => {
  const uniqueKeyCount = 10_000;
  const rows = [...Array.from({ length: uniqueKeyCount }, (_, id) => ({ id, key: id })), { id: uniqueKeyCount, key: 0 }];
  const changedRows = rows.map((row, index) => index === uniqueKeyCount ? { ...row, key: 1 } : row);
  const first = { relations: [input('distinct-high-cardinality-allocation', rows)] };
  const second = { relations: [input('distinct-high-cardinality-allocation', changedRows)] };
  const query = { kind: 'distinct', input: { kind: 'select', input: from('distinct-high-cardinality-allocation', 'row'), alias: 'value', fields: { key: field('row', 'key') } } };
  const session = openIncrementalQueryMaintenance(await plan('distinct-high-cardinality-allocation', query), first);
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return alternatingSessionWorkload(session, forward, backward);
});
const highCardinalityDistinctSampledAllocationBytes = sampledBytes(highCardinalityDistinctAllocationProfile);

const pooledAllocationProfile = await sampleUpdateAllocations(100, async () => {
  const first = { relations: [input('item', linearRows(1_000))] };
  const second = { relations: [input('item', linearRows(1_000, true))] };
  const runtime = createPooledIncrementalQueryRuntime({
    environment: pooledEnvironment('allocation-pooled-fanout-100'), initialSnapshot: first
  });
  const roots = await Promise.all(Array.from({ length: 100 }, async (_, index) => runtime.attach(await plan('allocation-pooled-' + index, {
    kind: 'select', alias: 'allocation-' + index, input: clonedPrefix(), fields: { id: field('item', 'id') }
  }))));
  const forward = diffQueryMaintenanceSnapshots(first, second);
  const backward = diffQueryMaintenanceSnapshots(second, first);
  return {
    update: (index) => {
      runtime.applyUpdate(index % 2 === 0 ? forward : backward);
      return roots[0].getCurrentResult().rows.length;
    },
    close: () => {
      for (const root of roots) root.close();
      runtime.close();
    }
  };
});
const pooledSampledAllocationBytes = sampledBytes(pooledAllocationProfile);

const measurement = (label, inputRows) => measurements.find((candidate) => candidate.label === label && candidate.inputRows === inputRows);
const linearPure10k = measurement('linear-pure', 10_000)?.millisecondsPerOperation;
const linearUpdate10k = measurement('linear-one-row-update', 10_000)?.millisecondsPerOperation;
const linearOwnedPure10k = measurement('linear-owned-prepared-pure', 10_000)?.millisecondsPerOperation;
const repeatedUnprepared = measurement('repeated-unprepared-pure', 1)?.millisecondsPerOperation;
const repeatedPrepared = measurement('repeated-prepared-pure', 1)?.millisecondsPerOperation;
const repeatedUnpreparedExpression = measurement('repeated-unprepared-expression', 1)?.millisecondsPerOperation;
const repeatedPreparedExpression = measurement('repeated-prepared-expression', 1)?.millisecondsPerOperation;
const orderPure10k = measurement('order', 10_000)?.millisecondsPerOperation;
const orderUpdate10k = measurement('order-one-row-update', 10_000)?.millisecondsPerOperation;
const aggregatePure10k = measurement('aggregate', 10_000)?.millisecondsPerOperation;
const aggregateUpdate10k = measurement('aggregate-one-row-update', 10_000)?.millisecondsPerOperation;
const distinctPure10k = measurement('distinct', 10_000)?.millisecondsPerOperation;
const distinctUpdate10k = measurement('distinct-one-row-update', 10_000)?.millisecondsPerOperation;
const highCardinalityDistinctPure = measurement('distinct-high-cardinality-prepared-pure', 10_001)?.millisecondsPerOperation;
const highCardinalityDistinctUpdate = measurement('distinct-high-cardinality-hidden-update', 10_001)?.millisecondsPerOperation;
const groupedReducerPure10k = measurement('aggregate-reducer-grouped', 10_000)?.millisecondsPerOperation;
const groupedReducerUpdate10k = measurement('aggregate-reducer-grouped-one-row-update', 10_000)?.millisecondsPerOperation;
const ungroupedReducerPure10k = measurement('aggregate-reducer-ungrouped', 10_000)?.millisecondsPerOperation;
const ungroupedReducerUpdate10k = measurement('aggregate-reducer-ungrouped-one-row-update', 10_000)?.millisecondsPerOperation;
const groupedReducerOpen1k = measurement('aggregate-reducer-grouped-open', 1_000)?.millisecondsPerOperation;
const groupedReducerOpen10k = measurement('aggregate-reducer-grouped-open', 10_000)?.millisecondsPerOperation;
const windowUpdate10k = measurement('window-one-row-update', 10_000)?.millisecondsPerOperation;
const partitionedWindowUpdate10k = measurement('window-partitioned-one-row-update', 10_000)?.millisecondsPerOperation;
const partitionedWindowPure10k = measurement('window-partitioned-prepared-pure', 10_000)?.millisecondsPerOperation;
const joinPreparedPure10k = measurement('equijoin-prepared-pure', 10_000)?.millisecondsPerOperation;
const joinRightUpdate10k = measurement('equijoin-right-one-row-update', 10_000)?.millisecondsPerOperation;
const joinLeftUpdate10k = measurement('equijoin-left-one-row-update', 10_000)?.millisecondsPerOperation;
const privateBytesPerUpdate = Math.round(sampledAllocationBytes / 100);
const leftJoinBytesPerUpdate = Math.round(leftJoinSampledAllocationBytes / 100);
const rightJoinBytesPerUpdate = Math.round(rightJoinSampledAllocationBytes / 100);
const aggregateBytesPerUpdate = Math.round(aggregateSampledAllocationBytes / 100);
const ungroupedReducerBytesPerUpdate = Math.round(ungroupedReducerSampledAllocationBytes / 100);
const distinctBytesPerUpdate = Math.round(distinctSampledAllocationBytes / 100);
const highCardinalityDistinctBytesPerUpdate = Math.round(highCardinalityDistinctSampledAllocationBytes / 200);
const pooledBytesPerUpdate = Math.round(pooledSampledAllocationBytes / 100);
const pooledFanout10 = pooledMeasurements.find(({ scenario, fanout }) => scenario === 'cloned-root-fanout' && fanout === 10)?.millisecondsPerUpdate;
const pooledFanout100 = pooledMeasurements.find(({ scenario, fanout }) => scenario === 'cloned-root-fanout' && fanout === 100)?.millisecondsPerUpdate;
const contracts = {
  repeatedSamples: measurements.every(({ sampleCount }) => sampleCount === 3),
  linearIncrementalAdvantage: linearPure10k !== undefined && linearUpdate10k !== undefined && linearUpdate10k < linearPure10k * 0.5,
  ownedPreparedEvaluationAdvantage: linearPure10k !== undefined && linearOwnedPure10k !== undefined && linearOwnedPure10k < linearPure10k * 0.75,
  orderIncrementalAdvantage: orderPure10k !== undefined && orderUpdate10k !== undefined && orderUpdate10k < orderPure10k * 0.5,
  aggregateIncrementalAdvantage: aggregatePure10k !== undefined && aggregateUpdate10k !== undefined && aggregateUpdate10k < aggregatePure10k * 0.5,
  distinctIncrementalAdvantage: distinctPure10k !== undefined && distinctUpdate10k !== undefined && distinctUpdate10k < distinctPure10k * 0.5,
  highCardinalityDistinctIncrementalAdvantage: highCardinalityDistinctUpdate !== undefined && highCardinalityDistinctPure !== undefined && highCardinalityDistinctUpdate < highCardinalityDistinctPure * 0.2,
  groupedReducerIncrementalAdvantage: groupedReducerPure10k !== undefined && groupedReducerUpdate10k !== undefined && groupedReducerUpdate10k < groupedReducerPure10k * 0.5,
  ungroupedReducerIncrementalAdvantage: ungroupedReducerPure10k !== undefined && ungroupedReducerUpdate10k !== undefined && ungroupedReducerUpdate10k < ungroupedReducerPure10k * 0.5,
  groupedReducerOpenNearLinear: groupedReducerOpen1k !== undefined && groupedReducerOpen10k !== undefined && groupedReducerOpen10k < groupedReducerOpen1k * 15,
  aggregateAllocationCeiling: aggregateBytesPerUpdate <= 1_000_000,
  ungroupedReducerAllocationCeiling: ungroupedReducerBytesPerUpdate <= 1_000_000,
  distinctAllocationCeiling: distinctBytesPerUpdate <= 1_000_000,
  // The duplicate never represents its key, so a correct sparse update can
  // retain the entire 10k-row result. Full Map cloning and representative
  // sorting alone sampled above 3.5 MB/update in the rejected implementation.
  highCardinalityDistinctAllocationCeiling: highCardinalityDistinctBytesPerUpdate <= 1_500_000,
  partitionedWindowAdvantage: windowUpdate10k !== undefined && partitionedWindowUpdate10k !== undefined && partitionedWindowUpdate10k < windowUpdate10k * 0.5,
  partitionedWindowIncrementalAdvantage: partitionedWindowPure10k !== undefined && partitionedWindowUpdate10k !== undefined && partitionedWindowUpdate10k < partitionedWindowPure10k * 0.5,
  rightJoinIncrementalAdvantage: joinPreparedPure10k !== undefined && joinRightUpdate10k !== undefined && joinRightUpdate10k < joinPreparedPure10k * 0.5,
  leftJoinIncrementalAdvantage: joinPreparedPure10k !== undefined && joinLeftUpdate10k !== undefined && joinLeftUpdate10k < joinPreparedPure10k * 0.5,
  joinSideUpdateSymmetry: joinLeftUpdate10k !== undefined && joinRightUpdate10k !== undefined && Math.max(joinLeftUpdate10k, joinRightUpdate10k) < Math.min(joinLeftUpdate10k, joinRightUpdate10k) * 2.5,
  leftJoinAllocationCeiling: leftJoinBytesPerUpdate <= 2_000_000,
  rightJoinAllocationCeiling: rightJoinBytesPerUpdate <= 2_000_000,
  joinSideAllocationSymmetry: Math.max(leftJoinBytesPerUpdate, rightJoinBytesPerUpdate) < Math.min(leftJoinBytesPerUpdate, rightJoinBytesPerUpdate) * 2.5,
  preparedEvaluationAdvantage: repeatedUnprepared !== undefined && repeatedPrepared !== undefined && repeatedPrepared < repeatedUnprepared * 0.75,
  preparedExpressionAdvantage: repeatedUnpreparedExpression !== undefined && repeatedPreparedExpression !== undefined && repeatedPreparedExpression < repeatedUnpreparedExpression * 0.75,
  unrelatedTraversalSelective: pooledMeasurements.filter(({ scenario }) => scenario === 'unrelated-relation-union-dag').every(({ selectiveVisitedPhysicalNodeCount }) => selectiveVisitedPhysicalNodeCount <= 2),
  pooledIgnoredFanoutScaling: pooledFanout10 !== undefined && pooledFanout100 !== undefined && pooledFanout100 < pooledFanout10 * 8,
  privateAllocationCeiling: privateBytesPerUpdate <= 2_000_000,
  pooledAllocationCeiling: pooledBytesPerUpdate <= 4_000_000
};
const contractFailures = Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name);

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-query-scaling',
  note: 'Wall times and allocation samples are diagnostic. Thresholds catch regressions; passing them is not evidence that the implementation is close to optimal.',
  contracts,
  measurements,
  pooledMeasurements,
  allocationSample: {
    workload: '100 snapshot diffs plus one-row updates over a 1,000-row linear query',
    sampledBytes: sampledAllocationBytes,
    sampledBytesPerUpdate: privateBytesPerUpdate
  },
  leftJoinAllocationSample: {
    workload: '100 one-row left updates over a 1,000-by-1,000 one-to-one equijoin',
    sampledBytes: leftJoinSampledAllocationBytes,
    sampledBytesPerUpdate: leftJoinBytesPerUpdate
  },
  rightJoinAllocationSample: {
    workload: '100 one-row right updates over a 1,000-by-1,000 one-to-one equijoin',
    sampledBytes: rightJoinSampledAllocationBytes,
    sampledBytesPerUpdate: rightJoinBytesPerUpdate
  },
  aggregateAllocationSample: {
    workload: '100 one-row updates over a 1,000-row, 100-group reducer-only aggregate query',
    sampledBytes: aggregateSampledAllocationBytes,
    sampledBytesPerUpdate: aggregateBytesPerUpdate
  },
  ungroupedReducerAllocationSample: {
    workload: '100 one-row updates over a 1,000-row ungrouped reducer-only aggregate query',
    sampledBytes: ungroupedReducerSampledAllocationBytes,
    sampledBytesPerUpdate: ungroupedReducerBytesPerUpdate,
    hotspots: allocationHotspots(ungroupedReducerAllocationProfile)
  },
  distinctAllocationSample: {
    workload: '100 one-row updates over a 1,000-row, 100-key distinct query',
    sampledBytes: distinctSampledAllocationBytes,
    sampledBytesPerUpdate: distinctBytesPerUpdate
  },
  highCardinalityDistinctAllocationSample: {
    workload: '200 trailing duplicate-key updates over a 10,001-row, 10,000-key distinct query',
    sampledBytes: highCardinalityDistinctSampledAllocationBytes,
    sampledBytesPerUpdate: highCardinalityDistinctBytesPerUpdate,
    hotspots: allocationHotspots(highCardinalityDistinctAllocationProfile),
    boundaryNote: 'The changed row is never a representative, so the public distinct output remains unchanged.'
  },
  pooledAllocationSample: {
    workload: '100 one-row updates to a field ignored by 100 pooled roots over 1,000 input rows',
    sampledBytes: pooledSampledAllocationBytes,
    sampledBytesPerUpdate: pooledBytesPerUpdate,
    boundaryNote: 'The changed field is ignored by every root, so public row views should be reused and fanout costs expose internal bookkeeping.'
  },
  node: process.version,
  consumedRows
}, null, 2) + '\n');

if (contractFailures.length > 0) {
  process.stderr.write('Query performance contracts failed: ' + contractFailures.join(', ') + '\n');
  process.exitCode = 1;
}
