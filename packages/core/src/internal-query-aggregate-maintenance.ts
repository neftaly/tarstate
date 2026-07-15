import { canonicalizeJson } from './artifacts.js';
import type { Issue } from './issues.js';
import type { QueryContext, ScopedRow } from './internal-query-evaluation-context.js';
import {
  evaluateQueryExpression as evaluateExpr,
  knownExpression as known,
  projectExpressionFields as projectFields,
  type QueryExpressionResult as ExpressionResult
} from './internal-query-expression.js';
import { aggregateValue, exprContext, scopedRow } from './internal-query-evaluator.js';
import { containsNamedCall, containsSubquery } from './internal-query-graph.js';
import {
  withMaintenanceEvent,
  type AggregateGroupKey,
  type AggregateGroupMember,
  type AggregateGroupState,
  type AggregateReducerState,
  type AggregateReducerStates,
  type AggregateRowGroupIndex,
  type DistinctCountIndex,
  type ExtremeValueEntry,
  type ExtremeValueIndex,
  type MaterializedQueryNode
} from './internal-query-maintenance-model.js';
import { canonicalizeQueryValue, compareQueryJsonValuesTotal } from './internal-query-values.js';
import type { AggregateExpr, QueryLogicalValue, QueryNode, QueryRecord } from './query-model.js';
import type { QueryMaintenanceFallbackReason } from './query-incremental-model.js';
import { logicalUnknown, type JsonValue } from './value.js';

export const incrementallyMaterializeAggregateWith = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  fallback: () => MaterializedQueryNode,
  contextFor: (issues: Issue[]) => QueryContext
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (!aggregateCanBeIncrementallyIndexed(node) || child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.aggregate === undefined) {
    const reason: QueryMaintenanceFallbackReason = !aggregateCanBeIncrementallyIndexed(node)
      ? 'unsupported_expression'
      : child === undefined || child.unavailable || child.result.completeness !== 'exact'
        ? 'input_unavailable'
        : 'state_unavailable';
    return withMaintenanceEvent(fallback(), { operator: 'aggregate', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason });
  }
  const issues: Issue[] = [];
  const context = contextFor(issues);
  const compactionsBefore = context.state.aggregateCompactionCount;
  const stablePositions = child.stableChangedPositions;
  if (stablePositions !== undefined && previous.aggregate.inputs.length === child.result.rows.length && stablePositions.length <= Math.max(32, child.result.rows.length >>> 3)) {
    const sparse = sparselyMaterializeAggregate(node, child.result.rows, stablePositions, previous.aggregate, context);
    if (sparse !== undefined && !context.state.unavailable && issues.length === 0) {
      return withMaintenanceEvent({ result: { rows: [...sparse.groups.values()].map(({ output }) => output), completeness: 'exact' }, issues: [], unavailable: false, aggregate: sparse }, { operator: 'aggregate', strategy: 'selective', affectedUnitCount: stablePositions.length, compactionCount: context.state.aggregateCompactionCount - compactionsBefore });
    }
  }
  const indexed = buildAggregateState(node, child.result.rows, context, previous.aggregate);
  if (context.state.unavailable || issues.length > 0) return withMaintenanceEvent(fallback(), { operator: 'aggregate', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });
  return withMaintenanceEvent({ result: { rows: [...indexed.groups.values()].map(({ output }) => output), completeness: 'exact' }, issues: [], unavailable: false, aggregate: indexed }, { operator: 'aggregate', strategy: 'full', affectedUnitCount: child.result.rows.length, compactionCount: context.state.aggregateCompactionCount - compactionsBefore });
};

const aggregateGroupRow = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  key: QueryRecord,
  members: readonly AggregateGroupMember[],
  context: QueryContext,
  reducers: AggregateReducerStates = buildAggregateReducers(node, members, context)
): ScopedRow => {
  const output: Record<string, QueryLogicalValue> = { ...key };
  let rows: readonly ScopedRow[] | undefined;
  for (const [name, aggregate] of Object.entries(node.measures)) {
    const reducer = reducers.get(name);
    if (reducer !== undefined) output[name] = aggregateReducerValue(aggregate, reducer);
    else {
      rows ??= members.map(({ row }) => row);
      output[name] = aggregateValue(aggregate, rows, context);
    }
  }
  return scopedRow({ [node.alias]: output }, { [node.alias]: { relationId: 'aggregate', occurrence: 'aggregate:' + canonicalizeQueryValue(key) } });
};

const aggregateReducerEligible = (aggregate: AggregateExpr): boolean =>
  aggregate.orderBy === undefined
  && (aggregate.op === 'count' || aggregate.op === 'count-distinct' || aggregate.op === 'minimum' || aggregate.op === 'maximum' || aggregate.op === 'any' || aggregate.op === 'every')
  && (aggregate.value === undefined || !containsSubquery(aggregate.value) && !containsNamedCall(aggregate.value));

const allAggregateMeasuresReduced = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>): boolean =>
  Object.values(node.measures).every(aggregateReducerEligible);

const aggregateContribution = (aggregate: AggregateExpr, row: ScopedRow, context: QueryContext): ExpressionResult => {
  const contribution = aggregate.value === undefined ? known(1) : evaluateExpr(aggregate.value, exprContext(row, context));
  if (contribution.status === 'unavailable' || contribution.status === 'indeterminate') context.state.unavailable = true;
  return contribution;
};

const updateAggregateReducer = (aggregate: AggregateExpr, state: AggregateReducerState, contribution: ExpressionResult, delta: 1 | -1, context?: QueryContext): AggregateReducerState => {
  if (state.kind === 'count') {
    const contributes = contribution.status === 'known' && contribution.value !== null;
    return contributes ? { kind: 'count', count: state.count + delta } : state;
  }
  if (state.kind === 'truth') {
    const truth = contribution.status === 'known' && typeof contribution.value === 'boolean' ? contribution.value : logicalUnknown;
    return truth === true
      ? { ...state, trueCount: state.trueCount + delta }
      : truth === false
        ? { ...state, falseCount: state.falseCount + delta }
        : { ...state, unknownCount: state.unknownCount + delta };
  }
  if (state.kind === 'extreme') return updateExtremeReducer(aggregate, state, contribution, delta, context);
  if (contribution.status !== 'known' || contribution.value === null) return state;
  const key = canonicalizeJson(contribution.value);
  const before = distinctIndexCount(state.index, key);
  const after = before + delta;
  const changed = new Map([[key, after]]);
  let base = state.index.base;
  let overlays = [...state.index.overlays, changed];
  if (overlays.length >= 64) {
    const compacted = new Map(base);
    for (const overlay of overlays) for (const [candidate, count] of overlay) {
      if (count === 0) compacted.delete(candidate);
      else compacted.set(candidate, count);
    }
    base = compacted;
    overlays = [];
    if (context !== undefined) context.state.aggregateCompactionCount += 1;
  }
  return { kind: 'distinct', index: { base, overlays, distinctCount: state.index.distinctCount + (before === 0 && after > 0 ? 1 : before > 0 && after === 0 ? -1 : 0) } };
};

const updateExtremeReducer = (
  aggregate: AggregateExpr,
  state: Extract<AggregateReducerState, { readonly kind: 'extreme' }>,
  contribution: ExpressionResult,
  delta: 1 | -1,
  context?: QueryContext
): AggregateReducerState => {
  if (contribution.status !== 'known') return state;
  const key = canonicalizeJson(contribution.value);
  const existing = extremeIndexEntry(state.index, key);
  const after = (existing?.count ?? 0) + delta;
  const changedEntry: ExtremeValueEntry | undefined = after === 0 ? undefined : { count: after, value: existing?.value ?? contribution.value };
  const changed = new Map<string, ExtremeValueEntry | undefined>([[key, changedEntry]]);
  let base = state.index.base;
  let overlays = [...state.index.overlays, changed];
  if (overlays.length >= 64) {
    const compacted = new Map(base);
    for (const overlay of overlays) for (const [candidate, entry] of overlay) {
      if (entry === undefined) compacted.delete(candidate);
      else compacted.set(candidate, entry);
    }
    base = compacted;
    overlays = [];
    if (context !== undefined) context.state.aggregateCompactionCount += 1;
  }
  const liveIndex: ExtremeValueIndex = { base, overlays, orderedKeys: state.index.orderedKeys };
  const orderedKeys = after === 0
    ? state.index.orderedKeys.filter((candidate) => candidate !== key)
    : existing === undefined
      ? insertOrderedExtremeKey(state.index.orderedKeys, key, contribution.value, liveIndex)
      : state.index.orderedKeys;
  const extremeKey = aggregate.op === 'minimum'
    ? orderedKeys[0]
    : orderedKeys[orderedKeys.length - 1];
  return { kind: 'extreme', index: { base, overlays, orderedKeys, ...(extremeKey === undefined ? {} : { extremeKey }) } };
};

const extremeIndexEntry = (index: ExtremeValueIndex, key: string): ExtremeValueEntry | undefined => {
  for (let position = index.overlays.length - 1; position >= 0; position -= 1) {
    const overlay = index.overlays[position] as ReadonlyMap<string, ExtremeValueEntry | undefined>;
    if (overlay.has(key)) return overlay.get(key);
  }
  return index.base.get(key);
};

const insertOrderedExtremeKey = (
  orderedKeys: readonly string[],
  key: string,
  value: JsonValue,
  index: ExtremeValueIndex
): readonly string[] => {
  let low = 0;
  let high = orderedKeys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const existing = extremeIndexEntry(index, orderedKeys[middle] as string);
    if (existing === undefined || compareQueryJsonValuesTotal(existing.value, value) > 0) high = middle;
    else low = middle + 1;
  }
  const output = orderedKeys.slice();
  output.splice(low, 0, key);
  return output;
};

const distinctIndexCount = (index: DistinctCountIndex, key: string): number => {
  for (let position = index.overlays.length - 1; position >= 0; position -= 1) {
    const count = index.overlays[position]?.get(key);
    if (count !== undefined) return count;
  }
  return index.base.get(key) ?? 0;
};

const buildAggregateReducers = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>, members: readonly AggregateGroupMember[], context: QueryContext): AggregateReducerStates => {
  // Semantic materialization already evaluated these built-in expressions.
  // The decorator intentionally evaluates them once more to seed persistent
  // state, but uses mutable builders so bulk opens allocate O(distinct keys)
  // rather than one immutable overlay per contribution.
  const reducers = new Map<string, AggregateReducerState>();
  for (const [name, aggregate] of Object.entries(node.measures)) {
    if (!aggregateReducerEligible(aggregate)) continue;
    if (aggregate.op === 'count' && aggregate.value === undefined) {
      reducers.set(name, { kind: 'count', count: members.length });
      continue;
    }
    if (aggregate.op === 'count') {
      let count = 0;
      for (const { row } of members) {
        const contribution = aggregateContribution(aggregate, row, context);
        if (contribution.status === 'known' && contribution.value !== null) count += 1;
      }
      reducers.set(name, { kind: 'count', count });
      continue;
    }
    if (aggregate.op === 'count-distinct') {
      const base = new Map<string, number>();
      for (const { row } of members) {
        const contribution = aggregateContribution(aggregate, row, context);
        if (contribution.status !== 'known' || contribution.value === null) continue;
        const key = canonicalizeJson(contribution.value);
        base.set(key, (base.get(key) ?? 0) + 1);
      }
      reducers.set(name, { kind: 'distinct', index: { base, overlays: [], distinctCount: base.size } });
      continue;
    }
    if (aggregate.op === 'minimum' || aggregate.op === 'maximum') {
      const base = new Map<string, ExtremeValueEntry>();
      for (const { row } of members) {
        const contribution = aggregateContribution(aggregate, row, context);
        if (contribution.status !== 'known') continue;
        const key = canonicalizeJson(contribution.value);
        const existing = base.get(key);
        base.set(key, { count: (existing?.count ?? 0) + 1, value: existing?.value ?? contribution.value });
      }
      const orderedKeys = [...base.keys()].sort((left, right) =>
        compareQueryJsonValuesTotal((base.get(left) as ExtremeValueEntry).value, (base.get(right) as ExtremeValueEntry).value));
      const extremeKey = aggregate.op === 'minimum' ? orderedKeys[0] : orderedKeys[orderedKeys.length - 1];
      reducers.set(name, { kind: 'extreme', index: { base, overlays: [], orderedKeys, ...(extremeKey === undefined ? {} : { extremeKey }) } });
      continue;
    }
    let trueCount = 0;
    let falseCount = 0;
    let unknownCount = 0;
    for (const { row } of members) {
      const contribution = aggregateContribution(aggregate, row, context);
      if (contribution.status === 'known' && contribution.value === true) trueCount += 1;
      else if (contribution.status === 'known' && contribution.value === false) falseCount += 1;
      else unknownCount += 1;
    }
    reducers.set(name, { kind: 'truth', trueCount, falseCount, unknownCount });
  }
  return reducers;
};

const updateAggregateReducers = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  reducers: AggregateReducerStates,
  row: ScopedRow,
  delta: 1 | -1,
  context: QueryContext
): AggregateReducerStates => {
  if (reducers.size === 0) return reducers;
  const updated = new Map(reducers);
  for (const [name, reducer] of reducers) {
    const aggregate = node.measures[name];
    if (aggregate !== undefined) updated.set(name, updateAggregateReducer(aggregate, reducer, aggregateContribution(aggregate, row, context), delta, context));
  }
  return updated;
};

const aggregateReducerValue = (aggregate: AggregateExpr, reducer: AggregateReducerState): QueryLogicalValue => {
  if (reducer.kind === 'count') return reducer.count;
  if (reducer.kind === 'distinct') return reducer.index.distinctCount;
  if (reducer.kind === 'extreme') return reducer.index.extremeKey === undefined ? null : extremeIndexEntry(reducer.index, reducer.index.extremeKey)?.value ?? null;
  if (aggregate.op === 'any') return reducer.trueCount > 0 ? true : reducer.unknownCount > 0 ? logicalUnknown : false;
  return reducer.falseCount > 0 ? false : reducer.unknownCount > 0 ? logicalUnknown : true;
};

export const indexAggregateState = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  inputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[],
  context: QueryContext
): NonNullable<MaterializedQueryNode['aggregate']> | undefined => {
  const groupKeyByRow = new Map<ScopedRow, AggregateGroupKey>();
  const groups = new Map<string, { key: QueryRecord; members: AggregateGroupMember[] }>();
  for (const [position, row] of inputs.entries()) {
    const key = projectFields(node.groupBy, exprContext(row, context));
    const canonical = canonicalizeQueryValue(key);
    groupKeyByRow.set(row, { canonical, key });
    const group = groups.get(canonical);
    if (group === undefined) groups.set(canonical, { key, members: [{ position, row }] });
    else group.members.push({ position, row });
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) groups.set('{}', { key: {}, members: [] });
  if (groups.size !== outputs.length || context.state.unavailable) return undefined;
  const indexed = new Map<string, AggregateGroupState>();
  [...groups].forEach(([canonical, group], index) => indexed.set(canonical, { key: group.key, members: group.members, reducers: buildAggregateReducers(node, group.members, context), output: outputs[index] as ScopedRow }));
  return { inputs, groupKeys: { entries: groupKeyByRow, depth: 0 }, groups: indexed };
};

const sparselyMaterializeAggregate = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  inputs: readonly ScopedRow[],
  changedPositions: readonly number[],
  previous: NonNullable<MaterializedQueryNode['aggregate']>,
  context: QueryContext
): NonNullable<MaterializedQueryNode['aggregate']> | undefined => {
  const groups = new Map(previous.groups);
  const changedKeys = new Map<ScopedRow, AggregateGroupKey>();
  const affected = new Set<string>();
  for (const position of changedPositions) {
    const before = previous.inputs[position];
    const after = inputs[position];
    if (before === undefined || after === undefined) return undefined;
    const beforeKey = lookupAggregateGroupKey(previous.groupKeys, before);
    if (beforeKey === undefined) return undefined;
    const key = projectFields(node.groupBy, exprContext(after, context));
    const afterKey = { canonical: canonicalizeQueryValue(key), key };
    changedKeys.set(after, afterKey);
    affected.add(beforeKey.canonical);
    affected.add(afterKey.canonical);
    const oldGroup = groups.get(beforeKey.canonical);
    if (oldGroup === undefined) return undefined;
    if (beforeKey.canonical === afterKey.canonical && allAggregateMeasuresReduced(node)) {
      // Reducer-only groups use members for stable positions, not row values.
      // Keeping the layout avoids copying an entire ungrouped member array for
      // a replacement; a later group move still removes the position normally.
      const removed = updateAggregateReducers(node, oldGroup.reducers, before, -1, context);
      groups.set(beforeKey.canonical, { ...oldGroup, reducers: updateAggregateReducers(node, removed, after, 1, context) });
      continue;
    }
    const oldMembers = oldGroup.members.filter((member) => member.position !== position);
    groups.set(beforeKey.canonical, { ...oldGroup, members: oldMembers, reducers: updateAggregateReducers(node, oldGroup.reducers, before, -1, context) });
    const target = groups.get(afterKey.canonical);
    const nextMember = { position, row: after };
    if (target === undefined) {
      const reducers = updateAggregateReducers(node, buildAggregateReducers(node, [], context), after, 1, context);
      groups.set(afterKey.canonical, { key, members: [nextMember], reducers, output: oldGroup.output });
    }
    else {
      const members = [...target.members, nextMember].sort((left, right) => left.position - right.position);
      groups.set(afterKey.canonical, { ...target, members, reducers: updateAggregateReducers(node, target.reducers, after, 1, context) });
    }
  }
  for (const canonical of affected) {
    const group = groups.get(canonical);
    if (group === undefined) continue;
    if (group.members.length === 0 && !(canonical === '{}' && Object.keys(node.groupBy).length === 0)) {
      groups.delete(canonical);
      continue;
    }
    groups.set(canonical, { ...group, output: aggregateGroupRow(node, group.key, group.members, context, group.reducers) });
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) {
    const key = {};
    const reducers = buildAggregateReducers(node, [], context);
    groups.set('{}', { key, members: [], reducers, output: aggregateGroupRow(node, key, [], context, reducers) });
  }
  // Unaffected groups retain their already-sorted relative order. Merge the
  // few affected groups back by first input position instead of sorting all
  // groups, keeping sparse maintenance O(groups + affected log affected).
  const unaffected = [...groups].filter(([canonical]) => !affected.has(canonical));
  const changedGroups = [...affected].flatMap((canonical) => {
    const group = groups.get(canonical);
    return group === undefined ? [] : [[canonical, group] as const];
  }).sort(([, left], [, right]) => aggregateGroupPosition(left) - aggregateGroupPosition(right));
  const orderedEntries: [string, AggregateGroupState][] = [];
  let unchangedIndex = 0;
  let changedIndex = 0;
  while (unchangedIndex < unaffected.length || changedIndex < changedGroups.length) {
    const unchanged = unaffected[unchangedIndex];
    const changed = changedGroups[changedIndex];
    if (changed === undefined || unchanged !== undefined && aggregateGroupPosition(unchanged[1]) <= aggregateGroupPosition(changed[1])) {
      orderedEntries.push(unchanged as [string, AggregateGroupState]);
      unchangedIndex += 1;
    } else {
      orderedEntries.push(changed as [string, AggregateGroupState]);
      changedIndex += 1;
    }
  }
  let ordered = new Map(orderedEntries);
  let groupKeys: AggregateRowGroupIndex = { parent: previous.groupKeys, entries: changedKeys, depth: previous.groupKeys.depth + 1 };
  if (groupKeys.depth >= 64) {
    const compacted = new Map<ScopedRow, AggregateGroupKey>();
    for (const row of inputs) {
      const indexed = lookupAggregateGroupKey(groupKeys, row);
      if (indexed === undefined) return undefined;
      compacted.set(row, indexed);
    }
    groupKeys = { entries: compacted, depth: 0 };
    context.state.aggregateCompactionCount += 1;
    if (allAggregateMeasuresReduced(node)) {
      const refreshed = new Map<string, AggregateGroupState>();
      for (const [canonical, group] of ordered) {
        const members: AggregateGroupMember[] = [];
        for (const member of group.members) {
          const row = inputs[member.position];
          if (row === undefined) return undefined;
          members.push({ position: member.position, row });
        }
        refreshed.set(canonical, { ...group, members });
      }
      ordered = refreshed;
    }
  }
  return { inputs, groupKeys, groups: ordered };
};

const aggregateGroupPosition = (group: AggregateGroupState): number => group.members[0]?.position ?? -1;

const lookupAggregateGroupKey = (index: AggregateRowGroupIndex, row: ScopedRow): AggregateGroupKey | undefined => {
  for (let current: AggregateRowGroupIndex | undefined = index; current !== undefined; current = current.parent) {
    const value = current.entries.get(row);
    if (value !== undefined) return value;
  }
  return undefined;
};

const buildAggregateState = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  inputs: readonly ScopedRow[],
  context: QueryContext,
  previous?: NonNullable<MaterializedQueryNode['aggregate']>
): NonNullable<MaterializedQueryNode['aggregate']> => {
  const groupKeys = new Map<ScopedRow, AggregateGroupKey>();
  const groups = new Map<string, { key: QueryRecord; members: AggregateGroupMember[] }>();
  for (const [position, row] of inputs.entries()) {
    const retained = previous === undefined ? undefined : lookupAggregateGroupKey(previous.groupKeys, row);
    const indexed = retained ?? (() => { const key = projectFields(node.groupBy, exprContext(row, context)); return { canonical: canonicalizeQueryValue(key), key }; })();
    groupKeys.set(row, indexed);
    const group = groups.get(indexed.canonical);
    if (group === undefined) groups.set(indexed.canonical, { key: indexed.key, members: [{ position, row }] });
    else group.members.push({ position, row });
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) groups.set('{}', { key: {}, members: [] });
  const output = new Map<string, AggregateGroupState>();
  for (const [canonical, group] of groups) {
    const prior = previous?.groups.get(canonical);
    const reusable = prior !== undefined && prior.members.length === group.members.length && prior.members.every((member, index) => member.row === group.members[index]?.row);
    const reducers = reusable && prior !== undefined ? prior.reducers : buildAggregateReducers(node, group.members, context);
    output.set(canonical, { key: group.key, members: group.members, reducers, output: reusable && prior !== undefined ? prior.output : aggregateGroupRow(node, group.key, group.members, context, reducers) });
  }
  return { inputs, groupKeys: { entries: groupKeys, depth: 0 }, groups: output };
};

// Building the persistent group index evaluates grouping expressions once in
// addition to semantic materialization. Built-in expressions are pure; named
// host calls and subqueries may carry observable work, so keep those on the
// single-evaluation fallback path.
export const orderCanBeIncrementallyIndexed = (node: Extract<QueryNode, { readonly kind: 'order' }>): boolean =>
  !node.by.some(({ value }) => containsSubquery(value) || containsNamedCall(value));

export const aggregateCanBeIncrementallyIndexed = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>): boolean => {
  if (Object.values(node.groupBy).some((expression) => containsSubquery(expression) || containsNamedCall(expression))) return false;
  return !Object.values(node.measures).some((measure) =>
    measure.value !== undefined && containsSubquery(measure.value)
    || measure.orderBy?.some(({ value }) => containsSubquery(value)) === true
  );
};
