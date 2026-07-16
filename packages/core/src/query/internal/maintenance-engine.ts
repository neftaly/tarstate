import { canonicalizeJsonValue as canonicalizeJson } from '../../internal-canonical-json.js';
import { memoizeFrozenAnalysis } from '../../internal-frozen-analysis.js';
import type { Issue } from '../../issues.js';
import type { EvaluationRun, QueryContext, ScopedRow } from './evaluation-context.js';
import {
  evaluateQueryExpression as evaluateExpr,
  expressionJson,
} from './expression.js';
import {
  compareOrder,
  consumeQueryWork,
  equijoinFields,
  evaluateNode,
  evaluateWindowKeys,
  exprContext,
  indexWindowMaintenanceLayouts,
  publicQueryIssues,
  publicQueryRow,
  publicQueryRows,
  replaceScopedAlias,
  requiredAlias,
  resultKey,
  scopedRow,
  tagSetRow,
  visibleRow
} from './evaluator.js';
import { containsNamedCall, containsSubquery } from './graph.js';
import { selectProjectionDependenciesEqual } from './dependency.js';
import { transitionOrderedRows } from './ordering.js';
import {
  aggregateCanBeIncrementallyIndexed,
  incrementallyMaterializeAggregateWith,
  indexAggregateState,
  orderCanBeIncrementallyIndexed
} from './aggregate-maintenance.js';
import { incrementallyMaterializeJoinWith, indexJoinSegments } from './join-maintenance.js';
import type { QueryMaintenanceOperatorEvent } from './maintenance-diagnostics.js';
import { emptyOperatorDiagnostics } from './maintenance-diagnostics.js';
import {
  MaterializedEvaluationCache,
  withMaintenanceEvent,
  type DistinctMaterializedState,
  type DistinctPositionKeyIndex,
  type DistinctPositionsIndex,
  type LocalSegment,
  type MaterializedQueryNode
} from './maintenance-model.js';
import {
  transformWindowPartitions,
  transitionWindowLayouts,
  updateWindowPartitionKeyIndex,
  updateWindowPartitionStates,
  windowSpecificationKey,
  windowSpecificationReferencesFields,
  type IndexedWindowField,
  type WindowMaintenanceLayout
} from './window-maintenance.js';
import { canonicalizeQueryValue, queryValueEqual } from './values.js';
import { groupRelationInputs, relationInputKey, relationKey, relationOccurrence } from './relations.js';
import { stringTupleKey } from '../../internal-string-key.js';
import type {
  Expr,
  QueryLogicalValue,
  QueryNode,
  QueryRecord,
  RelationUse,
  WindowExpr
} from '../model.js';
import type {
  IncrementalQueryMaintenanceState,
  IncrementalQueryResult,
  IncrementalQueryResultDelta,
  QueryMaintenanceFallbackReason,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  RelationInputChange,
  RelationRowChange
} from '../incremental-model.js';
import type { JsonValue } from '../../value.js';

export const materializeQueryNode = (
  node: QueryNode,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  run: EvaluationRun
): MaterializedQueryNode => {
  const materialized = evaluateMaterializedQueryNode(node, snapshot, materializedNodes, run);
  if (node.kind === 'from' && !materialized.unavailable && materialized.issues.length === 0) {
    return { ...materialized, from: indexFromInputs(node, snapshot) };
  }
  if (node.kind === 'join' && equijoinFields(node) !== undefined && !materialized.unavailable && materialized.issues.length === 0) {
    const left = materializedNodes.get(node.left);
    const right = materializedNodes.get(node.right);
    if (left !== undefined && right !== undefined && !left.unavailable && !right.unavailable) {
      const issues: Issue[] = [];
      const context = materializationContext(snapshot, materializedNodes, node, issues, run, false);
      const join = indexJoinSegments(node, left.result.rows, right.result.rows, materialized.result.rows, context);
      if (context.state.unavailable || issues.length > 0) {
        return {
          result: { rows: [], completeness: 'unknown' },
          issues: deduplicateQueryIssues([...materialized.issues, ...issues]),
          unavailable: true
        };
      }
      return { ...materialized, join };
    }
  }
  if (node.kind === 'order' && orderCanBeIncrementallyIndexed(node) && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') return { ...materialized, order: { inputs: child.result.rows } };
  }
  if (node.kind === 'distinct' && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness !== 'unknown') return { ...materialized, distinct: indexDistinctState(child.result.rows) };
  }
  if (node.kind === 'window' && windowCanBePartitionMaintained(node) && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') {
      const indexed = indexWindowState(node, child.result.rows, materialized.result.rows, materializationContext(snapshot, materializedNodes, node, [], run, false));
      if (indexed !== undefined) return { ...materialized, window: indexed };
    }
  }
  if (node.kind === 'aggregate' && aggregateCanBeIncrementallyIndexed(node) && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') {
      const indexed = indexAggregateState(node, child.result.rows, materialized.result.rows, materializationContext(snapshot, materializedNodes, node, [], run, false));
      if (indexed !== undefined) return { ...materialized, aggregate: indexed };
    }
  }
  if (node.kind === 'slice' && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') return { ...materialized, slice: { inputs: child.result.rows } };
  }
  if (node.kind === 'set' && node.op === 'union-all' && !materialized.unavailable && materialized.issues.length === 0) {
    const left = materializedNodes.get(node.left);
    const right = materializedNodes.get(node.right);
    if (left !== undefined && right !== undefined && left.result.completeness !== 'unknown' && right.result.completeness !== 'unknown') {
      return { ...materialized, unionAll: { leftInputs: left.result.rows, rightInputs: right.result.rows } };
    }
  }
  if (!isLocallyMaintainedNode(node) || materialized.unavailable || materialized.issues.length > 0) return materialized;
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.result.completeness === 'unknown') return materialized;
  return { ...materialized, local: indexLocalSegments(node, child.result.rows, materialized.result.rows) };
};

type WindowNode = Extract<QueryNode, { readonly kind: 'window' }>;
type WindowMaintenancePlan = {
  readonly canPartitionMaintain: boolean;
  readonly outputFields: ReadonlySet<string>;
  readonly specifications: ReadonlyMap<string, WindowExpr>;
};
const windowMaintenancePlan = memoizeFrozenAnalysis((node: WindowNode): WindowMaintenancePlan => {
  const windows = Object.values(node.fields);
  const first = windows[0];
  const outputFields = new Set(Object.keys(node.fields));
  const specifications = new Map<string, WindowExpr>();
  for (const window of windows) specifications.set(windowSpecificationKey(window), window);
  const partitionKey = first === undefined ? undefined : canonicalizeJson((first.partitionBy ?? []) as unknown as JsonValue);
  const canPartitionMaintain = partitionKey !== undefined && windows.every((window) =>
    canonicalizeJson((window.partitionBy ?? []) as unknown as JsonValue) === partitionKey
    && !windowSpecificationReferencesFields(window, node.alias, outputFields)
    && !(window.partitionBy ?? []).some((expression) => containsSubquery(expression) || containsNamedCall(expression))
    && !window.orderBy.some((term) => containsSubquery(term.value) || containsNamedCall(term.value))
    && (window.value === undefined
      || !expressionReferencesWindowFields(window.value, node.alias, outputFields)
        && !containsSubquery(window.value)
        && !containsNamedCall(window.value)));
  return { canPartitionMaintain, outputFields, specifications };
});
const windowCanBePartitionMaintained = (node: WindowNode): boolean => windowMaintenancePlan(node).canPartitionMaintain;

const windowPartitionKey = (node: Extract<QueryNode, { readonly kind: 'window' }>, row: ScopedRow, context: QueryContext): string => {
  const first = Object.values(node.fields)[0] as WindowExpr;
  const values = (first.partitionBy ?? []).map((expression) => evaluateExpr(expression, exprContext(row, context)));
  if (values.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.state.unavailable = true;
  return canonicalizeJson(values.map(expressionJson));
};

// Stable-position evidence already proves that result identities retain their layout.
const stableReplacementLayout = (
  previous: readonly ScopedRow[],
  next: readonly ScopedRow[],
  changedPositions: readonly number[] | undefined
): boolean => previous.length === next.length
  && (changedPositions !== undefined || previous.every((row, index) => row === next[index]));

export const incrementallyMaterializeSlice = (
  node: Extract<QueryNode, { readonly kind: 'slice' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.slice === undefined) {
    const reason: QueryMaintenanceFallbackReason = child === undefined || child.unavailable || child.result.completeness !== 'exact' ? 'input_unavailable' : 'state_unavailable';
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'slice', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason });
  }
  if (!stableReplacementLayout(previous.slice.inputs, child.result.rows, child.stableChangedPositions)) {
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'slice', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'unstable_layout' });
  }
  const offset = Math.max(0, node.offset ?? 0);
  const end = Math.min(child.result.rows.length, node.limit === undefined ? child.result.rows.length : offset + Math.max(0, node.limit));
  const changedOutputPositions: number[] = [];
  let output = previous.result.rows;
  for (const position of child.stableChangedPositions ?? []) {
    if (position < offset || position >= end || previous.slice.inputs[position] === child.result.rows[position]) continue;
    if (changedOutputPositions.length === 0) output = previous.result.rows.slice();
    const outputPosition = position - offset;
    (output as ScopedRow[])[outputPosition] = child.result.rows[position] as ScopedRow;
    changedOutputPositions.push(outputPosition);
  }
  return withMaintenanceEvent({
    result: { rows: output, completeness: 'exact' },
    issues: [],
    unavailable: false,
    stableChangedPositions: changedOutputPositions,
    slice: { inputs: child.result.rows }
  }, { operator: 'slice', strategy: 'selective', affectedUnitCount: changedOutputPositions.length });
};

export const incrementallyMaterializeUnionAll = (
  node: Extract<QueryNode, { readonly kind: 'set' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const left = materializedNodes.get(node.left);
  const right = materializedNodes.get(node.right);
  if (node.op !== 'union-all') return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'set', strategy: 'fallback', affectedUnitCount: (left?.result.rows.length ?? 0) + (right?.result.rows.length ?? 0), reason: 'unsupported_expression' });
  if (left === undefined || right === undefined || left.unavailable || right.unavailable || left.issues.length > 0 || right.issues.length > 0 || left.result.completeness === 'unknown' || right.result.completeness === 'unknown' || previous?.unionAll === undefined) {
    const reason: QueryMaintenanceFallbackReason = left === undefined || right === undefined || left.unavailable || right.unavailable || left.result.completeness === 'unknown' || right.result.completeness === 'unknown' ? 'input_unavailable' : 'state_unavailable';
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'set', strategy: 'fallback', affectedUnitCount: (left?.result.rows.length ?? 0) + (right?.result.rows.length ?? 0), reason });
  }
  if (!stableReplacementLayout(previous.unionAll.leftInputs, left.result.rows, left.stableChangedPositions)
    || !stableReplacementLayout(previous.unionAll.rightInputs, right.result.rows, right.stableChangedPositions)) {
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'set', strategy: 'fallback', affectedUnitCount: left.result.rows.length + right.result.rows.length, reason: 'unstable_layout' });
  }
  const replacements: { readonly outputPosition: number; readonly row: ScopedRow; readonly branch: 'left' | 'right' }[] = [];
  for (const position of left.stableChangedPositions ?? []) {
    const row = left.result.rows[position];
    if (row !== undefined && row !== previous.unionAll.leftInputs[position]) replacements.push({ outputPosition: position, row, branch: 'left' });
  }
  for (const position of right.stableChangedPositions ?? []) {
    const row = right.result.rows[position];
    if (row !== undefined && row !== previous.unionAll.rightInputs[position]) replacements.push({ outputPosition: left.result.rows.length + position, row, branch: 'right' });
  }
  const output = replacements.length === 0 ? previous.result.rows : previous.result.rows.slice();
  for (const replacement of replacements) (output as ScopedRow[])[replacement.outputPosition] = tagSetRow(replacement.row, replacement.branch);
  const completeness = left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound';
  const stableChangedPositions = replacements.map(({ outputPosition }) => outputPosition).sort((a, b) => a - b);
  return withMaintenanceEvent({
    result: { rows: output, completeness },
    issues: [],
    unavailable: false,
    stableChangedPositions,
    unionAll: { leftInputs: left.result.rows, rightInputs: right.result.rows }
  }, { operator: 'set', strategy: 'selective', affectedUnitCount: stableChangedPositions.length });
};

const indexWindowState = (
  node: Extract<QueryNode, { readonly kind: 'window' }>,
  inputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[],
  context: QueryContext
): NonNullable<MaterializedQueryNode['window']> | undefined => {
  if (inputs.length !== outputs.length) return undefined;
  const partitionKeyByResultKey = new Map<string, string>();
  const partitions = new Map<string, { members: ScopedRow[]; outputs: ScopedRow[] }>();
  inputs.forEach((row, index) => {
    const key = windowPartitionKey(node, row, context);
    partitionKeyByResultKey.set(resultKey(row), key);
    const partition = partitions.get(key) ?? { members: [], outputs: [] };
    partition.members.push(row);
    partition.outputs.push(outputs[index] as ScopedRow);
    partitions.set(key, partition);
  });
  const layouts = context.state.unavailable ? undefined : indexWindowMaintenanceLayouts(node, inputs, context);
  return context.state.unavailable || layouts === undefined ? undefined : { inputs, partitionKeyByResultKey, partitions, layouts };
};

const expressionReferencesWindowFields = (expression: Expr, alias: string, fields: ReadonlySet<string>): boolean => {
  if (expression.kind === 'field') return expression.alias === alias && fields.has(expression.name);
  if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'key-of' || expression.kind === 'source-of' || expression.kind === 'subquery') return false;
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') return expressionReferencesWindowFields(expression.left, alias, fields) || expressionReferencesWindowFields(expression.right, alias, fields);
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') return expressionReferencesWindowFields(expression.value, alias, fields);
  if (expression.kind === 'boolean') return expression.op === 'not' ? expressionReferencesWindowFields(expression.arg, alias, fields) : expression.args.some((argument) => expressionReferencesWindowFields(argument, alias, fields));
  if (expression.kind === 'case') return expression.branches.some(({ when, then }) => expressionReferencesWindowFields(when, alias, fields) || expressionReferencesWindowFields(then, alias, fields)) || expressionReferencesWindowFields(expression.otherwise, alias, fields);
  if (expression.kind === 'record') return Object.values(expression.fields).some((field) => expressionReferencesWindowFields(field, alias, fields));
  const expressions = expression.kind === 'array' ? expression.items : expression.args;
  return expressions.some((argument) => expressionReferencesWindowFields(argument, alias, fields));
};

const microMaterializeStableWindow = (
  node: Extract<QueryNode, { readonly kind: 'window' }>,
  inputs: readonly ScopedRow[],
  changedPositions: readonly number[],
  previous: MaterializedQueryNode,
  context: QueryContext
): MaterializedQueryNode | undefined => {
  const state = previous.window;
  if (state?.layouts === undefined || state.inputs.length !== inputs.length || previous.result.rows.length !== inputs.length) return undefined;
  const { outputFields, specifications } = windowMaintenancePlan(node);
  if (Object.values(node.fields).some((window) => window.op === 'lag' && window.value !== undefined && expressionReferencesWindowFields(window.value, node.alias, outputFields))) return undefined;

  for (const position of changedPositions) {
    const row = inputs[position];
    if (row === undefined) return undefined;
    for (const [specification, window] of specifications) {
      const indexed = state.layouts.get(specification)?.positions.get(resultKey(row));
      if (indexed === undefined) return undefined;
      const keys = evaluateWindowKeys(window, row, context);
      if (keys.partitionKey !== indexed.partitionKey || keys.orderSignature !== indexed.orderSignature) return undefined;
    }
  }
  if (context.state.unavailable || context.state.issues.length > 0) return undefined;

  const output = previous.result.rows.slice();
  const affected = new Set<number>();
  for (const position of changedPositions) {
    const input = inputs[position] as ScopedRow;
    if (input === state.inputs[position]) continue;
    const prior = previous.result.rows[position] as ScopedRow;
    const inputAlias = requiredAlias(input, node.alias, context);
    const priorAlias = requiredAlias(prior, node.alias, context);
    if (inputAlias === undefined || priorAlias === undefined) return undefined;
    const retainedFields = Object.fromEntries([...outputFields].map((field) => [field, priorAlias[field] as QueryLogicalValue]));
    output[position] = replaceScopedAlias(input, node.alias, { ...inputAlias, ...retainedFields });
    affected.add(position);
  }

  for (const [field, window] of Object.entries(node.fields)) {
    if (window.op !== 'lag') continue;
    const layout = state.layouts.get(windowSpecificationKey(window));
    if (layout === undefined) return undefined;
    const targets = new Map<number, number>();
    for (const sourcePosition of changedPositions) {
      const source = inputs[sourcePosition];
      if (source === undefined || source === state.inputs[sourcePosition]) continue;
      const indexed = layout.positions.get(resultKey(source));
      const partition = indexed === undefined ? undefined : layout.partitions.get(indexed.partitionKey);
      const targetPosition = indexed === undefined || partition === undefined ? undefined : partition[indexed.sortedIndex + (window.offset ?? 1)];
      if (targetPosition !== undefined) targets.set(targetPosition, sourcePosition);
    }
    for (const [targetPosition, sourcePosition] of targets) {
      const source = inputs[sourcePosition] as ScopedRow;
      const contribution = window.value === undefined ? undefined : evaluateExpr(window.value, exprContext(source, context));
      if (contribution?.status === 'unavailable' || contribution?.status === 'indeterminate') context.state.unavailable = true;
      const value: JsonValue = contribution === undefined ? null : expressionJson(contribution);
      const target = output[targetPosition] as ScopedRow;
      const aliasFields = requiredAlias(target, node.alias, context);
      if (aliasFields === undefined) return undefined;
      if (queryValueEqual(aliasFields[field] as QueryLogicalValue, value)) continue;
      output[targetPosition] = replaceScopedAlias(target, node.alias, { ...aliasFields, [field]: value });
      affected.add(targetPosition);
    }
  }
  if (context.state.unavailable || context.state.issues.length > 0) return undefined;

  const firstLayout = state.layouts.values().next().value as WindowMaintenanceLayout | undefined;
  if (firstLayout === undefined) return undefined;
  const affectedPartitionKeys = new Set<string>();
  for (const position of affected) {
    const row = inputs[position];
    const key = row === undefined ? undefined : firstLayout.positions.get(resultKey(row))?.partitionKey;
    if (key === undefined) return undefined;
    affectedPartitionKeys.add(key);
  }
  const partitions = updateWindowPartitionStates(state.partitions, affectedPartitionKeys, firstLayout, inputs, output);
  const stableChangedPositions = [...affected].sort((left, right) => left - right);
  return withMaintenanceEvent({
    result: { rows: output, completeness: 'exact' },
    issues: [],
    unavailable: false,
    stableChangedPositions,
    window: { inputs, partitionKeyByResultKey: state.partitionKeyByResultKey, partitions, layouts: state.layouts }
  }, { operator: 'window', strategy: 'selective', affectedUnitCount: stableChangedPositions.length });
};

export const incrementallyMaterializeWindow = (
  node: Extract<QueryNode, { readonly kind: 'window' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (!windowCanBePartitionMaintained(node) || child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.window === undefined) {
    const reason: QueryMaintenanceFallbackReason = !windowCanBePartitionMaintained(node)
      ? 'unsupported_expression'
      : child === undefined || child.unavailable || child.result.completeness !== 'exact'
        ? 'input_unavailable'
        : 'state_unavailable';
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason });
  }
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues, run);
  if (child.stableChangedPositions !== undefined) {
    const micro = microMaterializeStableWindow(node, child.result.rows, child.stableChangedPositions, previous, context);
    if (micro !== undefined) return micro;
  }
  const stableIdentityLayout = child.stableChangedPositions !== undefined
    && previous.window.inputs.length === child.result.rows.length;
  const { specifications } = windowMaintenancePlan(node);

  if (stableIdentityLayout && child.stableChangedPositions !== undefined && previous.window.layouts !== undefined) {
    const layoutContext = materializationContext(snapshot, materializedNodes, node, [], run, false);
    const transitioned = transitionWindowLayouts(
      specifications,
      previous.window.layouts,
      child.result.rows,
      child.stableChangedPositions,
      (window, row) => evaluateWindowKeys(window, row, layoutContext)
    );
    if (layoutContext.state.unavailable) {
      return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });
    }
    if (transitioned !== undefined) {
      const indexedFields: IndexedWindowField[] = [];
      for (const [field, window] of Object.entries(node.fields)) {
        const layout = transitioned.layouts.get(windowSpecificationKey(window));
        if (layout === undefined) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'state_unavailable' });
        indexedFields.push({ field, window, layout });
      }
      const transformed = transformWindowPartitions(
        node.alias,
        indexedFields,
        transitioned.affectedPartitionKeys,
        child.result.rows,
        previous.window.inputs,
        previous.result.rows,
        (expression, source) => {
          const value = evaluateExpr(expression, exprContext(source, context));
          if (value.status === 'unavailable' || value.status === 'indeterminate') context.state.unavailable = true;
          return expressionJson(value);
        }
      );
      const firstLayout = transitioned.layouts.values().next().value as WindowMaintenanceLayout | undefined;
      const partitionKeyByResultKey = firstLayout === undefined
        ? undefined
        : updateWindowPartitionKeyIndex(previous.window.partitionKeyByResultKey, child.stableChangedPositions, child.result.rows, firstLayout);
      if (transformed === undefined || firstLayout === undefined || partitionKeyByResultKey === undefined || context.state.unavailable || issues.length > 0) {
        return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });
      }
      const changedPositions = [...transformed.changedPositions].sort((left, right) => left - right);
      const partitions = updateWindowPartitionStates(
        previous.window.partitions,
        transitioned.affectedPartitionKeys,
        firstLayout,
        child.result.rows,
        transformed.rows
      );
      return withMaintenanceEvent({
        result: { rows: transformed.rows, completeness: 'exact' },
        issues: [],
        unavailable: false,
        stableChangedPositions: changedPositions,
        verifiedChangedPositions: changedPositions,
        window: { inputs: child.result.rows, partitionKeyByResultKey, partitions, layouts: transitioned.layouts }
      }, { operator: 'window', strategy: 'selective', affectedUnitCount: changedPositions.length });
    }
  }

  const partitionKeyByResultKey = new Map<string, string>();
  const partitions = new Map<string, { members: ScopedRow[]; positions: number[] }>();
  child.result.rows.forEach((row, position) => {
    const identity = resultKey(row);
    const key = previous.window?.inputs[position] === row
      ? previous.window.partitionKeyByResultKey.get(identity) ?? windowPartitionKey(node, row, context)
      : windowPartitionKey(node, row, context);
    partitionKeyByResultKey.set(identity, key);
    const partition = partitions.get(key) ?? { members: [], positions: [] };
    partition.members.push(row);
    partition.positions.push(position);
    partitions.set(key, partition);
  });
  if (context.state.unavailable || issues.length > 0) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });
  const layoutContext = materializationContext(snapshot, materializedNodes, node, [], run, false);
  const layouts = indexWindowMaintenanceLayouts(node, child.result.rows, layoutContext);
  if (layoutContext.state.unavailable || layouts === undefined) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });

  let output: readonly ScopedRow[];
  let changedPositions: number[];
  if (stableIdentityLayout) {
    const affectedPartitionKeys = new Set<string>();
    for (const [key, partition] of partitions) {
      const prior = previous.window.partitions.get(key);
      const reusable = prior !== undefined
        && prior.members.length === partition.members.length
        && prior.members.every((row, index) => row === partition.members[index]);
      if (!reusable) affectedPartitionKeys.add(key);
    }
    for (const key of previous.window.partitions.keys()) {
      if (!partitions.has(key)) affectedPartitionKeys.add(key);
    }
    const indexedFields: IndexedWindowField[] = [];
    for (const [field, window] of Object.entries(node.fields)) {
      const layout = layouts.get(windowSpecificationKey(window));
      if (layout === undefined) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'state_unavailable' });
      indexedFields.push({ field, window, layout });
    }
    const transformed = transformWindowPartitions(
      node.alias,
      indexedFields,
      affectedPartitionKeys,
      child.result.rows,
      previous.window.inputs,
      previous.result.rows,
      (expression, source) => {
        const value = evaluateExpr(expression, exprContext(source, context));
        if (value.status === 'unavailable' || value.status === 'indeterminate') context.state.unavailable = true;
        return expressionJson(value);
      }
    );
    if (transformed === undefined || context.state.unavailable || issues.length > 0) {
      return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });
    }
    output = transformed.rows;
    changedPositions = [...transformed.changedPositions];
  } else {
    const rebuilt: ScopedRow[] = Array.from({ length: child.result.rows.length });
    changedPositions = [];
    const overrides = new Map(materializedNodes);
    for (const [key, partition] of partitions) {
      const prior = previous.window.partitions.get(key);
      const reusable = prior !== undefined && prior.members.length === partition.members.length && prior.members.every((row, index) => row === partition.members[index]);
      let outputs: readonly ScopedRow[];
      if (reusable) outputs = prior.outputs;
      else {
        overrides.set(node.input, { result: { rows: partition.members, completeness: 'exact' }, issues: [], unavailable: false });
        const evaluated = evaluateMaterializedQueryNode(node, snapshot, overrides, run);
        if (evaluated.unavailable || evaluated.issues.length > 0 || evaluated.result.completeness !== 'exact') return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: partition.members.length, reason: 'evaluation_unavailable' });
        outputs = evaluated.result.rows;
        if (outputs.length !== partition.members.length) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'window', strategy: 'fallback', affectedUnitCount: partition.members.length, reason: 'unstable_layout' });
        changedPositions.push(...partition.positions);
      }
      partition.positions.forEach((position, index) => { rebuilt[position] = outputs[index] as ScopedRow; });
    }
    output = rebuilt;
  }

  const indexedPartitions = new Map<string, { readonly members: readonly ScopedRow[]; readonly outputs: readonly ScopedRow[] }>();
  for (const [key, partition] of partitions) {
    indexedPartitions.set(key, {
      members: partition.members,
      outputs: partition.positions.map((position) => output[position] as ScopedRow)
    });
  }
  return withMaintenanceEvent({
    result: { rows: output, completeness: 'exact' },
    issues: [],
    unavailable: false,
    ...(stableIdentityLayout ? {
      stableChangedPositions: changedPositions.sort((left, right) => left - right)
    } : {}),
    window: { inputs: child.result.rows, partitionKeyByResultKey, partitions: indexedPartitions, layouts }
  }, { operator: 'window', strategy: 'selective', affectedUnitCount: changedPositions.length });
};

const indexDistinctState = (inputs: readonly ScopedRow[]): DistinctMaterializedState => {
  const base: string[] = [];
  const positionsByKey = new Map<string, number[]>();
  inputs.forEach((row, position) => {
    const key = canonicalizeQueryValue(visibleRow(row));
    base.push(key);
    const positions = positionsByKey.get(key);
    if (positions === undefined) positionsByKey.set(key, [position]);
    else positions.push(position);
  });
  const outputKeys = [...positionsByKey.keys()];
  return {
    inputs,
    keys: { base, overlays: [] },
    positions: { base: positionsByKey, overlays: [] },
    outputKeys,
    outputPositionByKey: new Map(outputKeys.map((key, position) => [key, position]))
  };
};

const distinctPositionKey = (index: DistinctPositionKeyIndex, position: number): string | undefined => {
  for (let overlay = index.overlays.length - 1; overlay >= 0; overlay -= 1) {
    const key = index.overlays[overlay]?.get(position);
    if (key !== undefined) return key;
  }
  return index.base[position];
};

const distinctPositions = (index: DistinctPositionsIndex, key: string): readonly number[] | undefined => {
  for (let overlay = index.overlays.length - 1; overlay >= 0; overlay -= 1) {
    const changes = index.overlays[overlay] as ReadonlyMap<string, readonly number[] | undefined>;
    if (changes.has(key)) return changes.get(key);
  }
  return index.base.get(key);
};

const materializeDistinctPositions = (index: DistinctPositionsIndex): Map<string, readonly number[]> => {
  const materialized = new Map(index.base);
  for (const overlay of index.overlays) for (const [key, positions] of overlay) {
    if (positions === undefined) materialized.delete(key);
    else materialized.set(key, positions);
  }
  return materialized;
};

export const incrementallyMaterializeDistinct = (
  node: Extract<QueryNode, { readonly kind: 'distinct' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness === 'unknown' || previous?.distinct === undefined) {
    const reason: QueryMaintenanceFallbackReason = child === undefined || child.unavailable || child.result.completeness === 'unknown' ? 'input_unavailable' : 'state_unavailable';
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'distinct', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason });
  }
  const changed = child.stableChangedPositions;
  if (changed === undefined || child.result.rows.length !== previous.distinct.inputs.length || changed.length > Math.max(32, child.result.rows.length >>> 3)) {
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'distinct', strategy: 'full', affectedUnitCount: child.result.rows.length });
  }
  if (changed.length === 0) return withMaintenanceEvent({
    result: previous.result.completeness === child.result.completeness
      ? previous.result
      : { rows: previous.result.rows, completeness: child.result.completeness },
    issues: [], unavailable: false, stableChangedPositions: [],
    distinct: { ...previous.distinct, inputs: child.result.rows }
  }, { operator: 'distinct', strategy: 'selective', affectedUnitCount: 0 });
  const affectedKeys = new Set<string>();
  const keyChanges = new Map<number, string>();
  const positionChanges = new Map<string, readonly number[] | undefined>();
  const previousPositions = previous.distinct.positions;
  const currentPositions = (key: string): readonly number[] | undefined => positionChanges.has(key)
    ? positionChanges.get(key)
    : distinctPositions(previousPositions, key);
  for (const position of changed) {
    const row = child.result.rows[position];
    const beforeKey = distinctPositionKey(previous.distinct.keys, position);
    if (row === undefined || beforeKey === undefined) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'distinct', strategy: 'fallback', affectedUnitCount: changed.length, reason: 'unstable_layout' });
    const afterKey = canonicalizeQueryValue(visibleRow(row));
    if (beforeKey !== afterKey) keyChanges.set(position, afterKey);
    affectedKeys.add(beforeKey);
    affectedKeys.add(afterKey);
    if (beforeKey !== afterKey) {
      const oldPositions = currentPositions(beforeKey)?.filter((candidate) => candidate !== position) ?? [];
      positionChanges.set(beforeKey, oldPositions.length === 0 ? undefined : oldPositions);
      const target = currentPositions(afterKey) ?? [];
      positionChanges.set(afterKey, [...target, position].sort((left, right) => left - right));
    }
  }
  let keys: DistinctPositionKeyIndex = keyChanges.size === 0 ? previous.distinct.keys : { base: previous.distinct.keys.base, overlays: [...previous.distinct.keys.overlays, keyChanges] };
  let positions: DistinctPositionsIndex = positionChanges.size === 0
    ? previous.distinct.positions
    : { base: previous.distinct.positions.base, overlays: [...previous.distinct.positions.overlays, positionChanges] };
  let compactionCount = 0;
  if (keys.overlays.length >= 64) {
    const base = [...keys.base];
    for (const overlay of keys.overlays) for (const [position, key] of overlay) base[position] = key;
    keys = { base, overlays: [] };
    compactionCount += 1;
  }
  if (positions.overlays.length >= 64) {
    positions = { base: materializeDistinctPositions(positions), overlays: [] };
    compactionCount += 1;
  }

  // Most sparse replacements do not add, remove, or reorder a representative.
  // Validate only the affected representatives and their immediate neighbours;
  // untouched first positions remain strictly ordered by construction.
  let stableRepresentativeLayout = true;
  const nextKeyByOutputPosition = new Map<number, string>();
  const vacatedOutputPositions: number[] = [];
  const addedKeys: string[] = [];
  const edges = new Set<number>();
  for (const key of affectedKeys) {
    const outputPosition = previous.distinct.outputPositionByKey.get(key);
    const next = distinctPositions(positions, key);
    if (outputPosition === undefined) {
      if (next !== undefined) addedKeys.push(key);
    } else if (next === undefined) vacatedOutputPositions.push(outputPosition);
    else nextKeyByOutputPosition.set(outputPosition, key);
  }
  vacatedOutputPositions.sort((left, right) => left - right);
  addedKeys.sort((left, right) => (distinctPositions(positions, left)?.[0] as number) - (distinctPositions(positions, right)?.[0] as number));
  if (vacatedOutputPositions.length !== addedKeys.length) stableRepresentativeLayout = false;
  else addedKeys.forEach((key, index) => nextKeyByOutputPosition.set(vacatedOutputPositions[index] as number, key));
  for (const outputPosition of nextKeyByOutputPosition.keys()) {
    if (outputPosition > 0) edges.add(outputPosition - 1);
    if (outputPosition + 1 < previous.distinct.outputKeys.length) edges.add(outputPosition);
  }
  if (stableRepresentativeLayout) for (const leftPosition of edges) {
    const leftKey = nextKeyByOutputPosition.get(leftPosition) ?? previous.distinct.outputKeys[leftPosition] as string;
    const rightKey = nextKeyByOutputPosition.get(leftPosition + 1) ?? previous.distinct.outputKeys[leftPosition + 1] as string;
    const leftFirst = distinctPositions(positions, leftKey)?.[0];
    const rightFirst = distinctPositions(positions, rightKey)?.[0];
    if (leftFirst === undefined || rightFirst === undefined || leftFirst >= rightFirst) {
      stableRepresentativeLayout = false;
      break;
    }
  }

  if (stableRepresentativeLayout) {
    const replacements = new Map<number, ScopedRow>();
    for (const [outputPosition, key] of nextKeyByOutputPosition) {
      const firstPosition = distinctPositions(positions, key)?.[0] as number;
      const row = child.result.rows[firstPosition] as ScopedRow;
      if (row !== previous.result.rows[outputPosition]) replacements.set(outputPosition, row);
    }
    const changedOutputPositions = [...replacements.keys()].sort((left, right) => left - right);
    const output = changedOutputPositions.length === 0 ? previous.result.rows : [...previous.result.rows];
    for (const [position, row] of replacements) (output as ScopedRow[])[position] = row;
    let outputKeys = previous.distinct.outputKeys;
    let outputPositionByKey = previous.distinct.outputPositionByKey;
    if (vacatedOutputPositions.length > 0) {
      const updatedKeys = [...outputKeys];
      const updatedPositions = new Map(outputPositionByKey);
      vacatedOutputPositions.forEach((outputPosition, index) => {
        updatedPositions.delete(previous.distinct?.outputKeys[outputPosition] as string);
        const key = addedKeys[index] as string;
        updatedKeys[outputPosition] = key;
        updatedPositions.set(key, outputPosition);
      });
      outputKeys = updatedKeys;
      outputPositionByKey = updatedPositions;
    }
    const stableIdentityLayout = output.length === previous.result.rows.length
      && output.every((row, index) => resultKey(row) === resultKey(previous.result.rows[index] as ScopedRow));
    return withMaintenanceEvent({
      result: { rows: output, completeness: child.result.completeness },
      issues: [], unavailable: false,
      ...(stableIdentityLayout ? { stableChangedPositions: changedOutputPositions } : {}),
      distinct: { inputs: child.result.rows, keys, positions, outputKeys, outputPositionByKey }
    }, { operator: 'distinct', strategy: 'selective', affectedUnitCount: affectedKeys.size, compactionCount });
  }

  const positionsByKey = materializeDistinctPositions(positions);
  const previousOutputByKey = new Map(previous.distinct.outputKeys.map((key, position) => [key, previous.result.rows[position] as ScopedRow]));
  const entries = [...positionsByKey].sort((left, right) => (left[1][0] as number) - (right[1][0] as number));
  const outputKeys = entries.map(([key]) => key);
  const candidateOutput = entries.map(([key, keyPositions]) => affectedKeys.has(key)
    ? child.result.rows[keyPositions[0] as number] as ScopedRow
    : previousOutputByKey.get(key) ?? child.result.rows[keyPositions[0] as number] as ScopedRow);
  const changedOutputPositions = changedRowPositionsIfStableIdentity(candidateOutput, previous.result.rows);
  const output = changedOutputPositions?.length === 0 ? previous.result.rows : candidateOutput;
  return withMaintenanceEvent({
    result: { rows: output, completeness: child.result.completeness },
    issues: [], unavailable: false,
    ...(changedOutputPositions === undefined ? {} : { stableChangedPositions: changedOutputPositions }),
    distinct: { inputs: child.result.rows, keys, positions, outputKeys, outputPositionByKey: new Map(outputKeys.map((key, position) => [key, position])) }
  }, { operator: 'distinct', strategy: 'selective', affectedUnitCount: affectedKeys.size, compactionCount });
};

export const incrementallyMaterializeOrder = (
  node: Extract<QueryNode, { readonly kind: 'order' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (!orderCanBeIncrementallyIndexed(node) || child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.order === undefined) {
    const reason: QueryMaintenanceFallbackReason = !orderCanBeIncrementallyIndexed(node)
      ? 'unsupported_expression'
      : child === undefined || child.unavailable || child.result.completeness !== 'exact'
        ? 'input_unavailable'
        : 'state_unavailable';
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'order', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason });
  }
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues, run);
  const stableChanges = child.stableChangedPositions;
  const sparseChangeLimit = Math.min(64, Math.max(32, child.result.rows.length >>> 3));
  if (stableChanges !== undefined && stableChanges.length <= sparseChangeLimit) {
    const transitioned = transitionOrderedRows(
      previous.order.inputs,
      child.result.rows,
      previous.result.rows,
      stableChanges,
      (left, right) => compareOrder(left, right, node.by, context)
    );
    if (transitioned !== undefined && !context.state.unavailable && issues.length === 0) {
      const changedOutputPositions = changedRowPositionsIfStableIdentity(transitioned, previous.result.rows);
      const verifiedUpdatedResultKeys = stableChanges.flatMap((position) => {
        const before = previous.order?.inputs[position];
        const after = child.result.rows[position];
        return before === undefined || after === undefined
          || queryValueEqual(visibleRow(before) as QueryLogicalValue, visibleRow(after) as QueryLogicalValue)
          ? []
          : [resultKey(after)];
      });
      return withMaintenanceEvent({
        result: { rows: changedOutputPositions?.length === 0 ? previous.result.rows : transitioned, completeness: 'exact' },
        issues: [],
        unavailable: false,
        ...(changedOutputPositions === undefined ? {} : { stableChangedPositions: changedOutputPositions }),
        verifiedUpdatedResultKeys,
        order: { inputs: child.result.rows }
      }, { operator: 'order', strategy: 'selective', affectedUnitCount: stableChanges.length });
    }
  }
  const nextPositions = new Map(child.result.rows.map((row, index) => [row, index]));
  const previousInputs = new Set(previous.order.inputs);
  const retained = previous.result.rows.filter((row) => nextPositions.has(row));
  // Stable sort ties follow input order. Insert/delete preserves the relative
  // order of retained inputs; an upstream reorder does not, so fall back in
  // that uncommon case rather than silently changing SQL-style tie semantics.
  const previousCommon = previous.order.inputs.filter((row) => nextPositions.has(row));
  const nextCommon = child.result.rows.filter((row) => previousInputs.has(row));
  if (previousCommon.some((row, index) => row !== nextCommon[index])) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'order', strategy: 'fallback', affectedUnitCount: child.result.rows.length - previousCommon.length, reason: 'unstable_layout' });
  const changed = child.result.rows.filter((row) => !previousInputs.has(row));
  // Repeated array insertion is attractive for sparse changes but quadratic
  // for bulk replacements. A full stable sort is the safer upper bound once
  // the changed set is no longer sparse.
  if (changed.length > sparseChangeLimit) {
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'order', strategy: 'full', affectedUnitCount: changed.length });
  }
  const compare = (left: ScopedRow, right: ScopedRow): number => {
    const semantic = compareOrder(left, right, node.by, context);
    return semantic !== 0 ? semantic : (nextPositions.get(left) ?? 0) - (nextPositions.get(right) ?? 0);
  };
  for (const row of changed) {
    let low = 0;
    let high = retained.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(retained[middle] as ScopedRow, row) <= 0) low = middle + 1;
      else high = middle;
    }
    retained.splice(low, 0, row);
  }
  if (context.state.unavailable || issues.length > 0) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'order', strategy: 'fallback', affectedUnitCount: changed.length, reason: 'evaluation_unavailable' });
  return withMaintenanceEvent({ result: { rows: retained, completeness: 'exact' }, issues: [], unavailable: false, order: { inputs: child.result.rows } }, { operator: 'order', strategy: 'selective', affectedUnitCount: changed.length });
};


export const incrementallyMaterializeAggregate = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => incrementallyMaterializeAggregateWith(
  node,
  materializedNodes,
  previous,
  () => materializeQueryNode(node, snapshot, materializedNodes, run),
  (issues) => materializationContext(snapshot, materializedNodes, node, issues, run)
);

const indexFromInputs = (
  node: Extract<QueryNode, { readonly kind: 'from' }>,
  snapshot: QueryMaintenanceSnapshot
): NonNullable<MaterializedQueryNode['from']> => {
  const inputOffsets = new Map<string, number>();
  let offset = 0;
  for (const input of groupRelationInputs(snapshot.relations).get(relationKey(node.relation)) ?? []) {
    inputOffsets.set(relationInputKey(input), offset);
    offset += input.rows.length;
  }
  return { inputOffsets };
};

const evaluateMaterializedQueryNode = (
  node: QueryNode,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  run: EvaluationRun
): MaterializedQueryNode => {
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues, run);
  const result = evaluateNode(node, context);
  return { result, issues: deduplicateQueryIssues(issues), unavailable: context.state.unavailable };
};

const materializationContext = (
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  activeNode: QueryNode,
  issues: Issue[],
  run: EvaluationRun,
  chargeWork = true
): QueryContext => ({
  environment: {
    relations: groupRelationInputs(snapshot.relations),
    parameters: snapshot.parameters ?? {},
    functions: snapshot.functions ?? new Map(),
    ...(snapshot.basis === undefined ? {} : { basis: snapshot.basis }),
    ...(snapshot.membershipRevision === undefined ? {} : { membershipRevision: snapshot.membershipRevision }),
    evaluationCache: new MaterializedEvaluationCache(materializedNodes, activeNode)
  },
  state: {
    issues,
    recursions: new Map(),
    recursionConstants: new Map(),
    recursionDependencies: new Map(),
    joinIndexes: new Map(),
    unavailable: false,
    aggregateCompactionCount: 0,
    ...(!chargeWork || run.work === undefined ? {} : { work: run.work })
  }
});

export const chargeIncrementalOutput = (
  activeNode: QueryNode,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  materialized: MaterializedQueryNode,
  run: EvaluationRun
): MaterializedQueryNode => {
  if (materialized.result.completeness === 'unknown' || run.work === undefined) return materialized;
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, activeNode, issues, run);
  if (consumeQueryWork(context, materialized.result.rows.length)) return materialized;
  return {
    result: { rows: [], completeness: 'unknown' },
    issues: deduplicateQueryIssues([...materialized.issues, ...issues]),
    unavailable: true,
    ...(materialized.maintenanceEvent === undefined ? {} : {
      maintenanceEvent: { ...materialized.maintenanceEvent, strategy: 'fallback' as const, reason: 'evaluation_unavailable' as const }
    })
  };
};

export const incrementallyMaterializeJoin = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => incrementallyMaterializeJoinWith(
  node,
  materializedNodes,
  previous,
  () => materializeQueryNode(node, snapshot, materializedNodes, run),
  (issues) => materializationContext(snapshot, materializedNodes, node, issues, run)
);

export const incrementallyMaterializeFrom = (
  node: Extract<QueryNode, { readonly kind: 'from' }>,
  snapshot: QueryMaintenanceSnapshot,
  update: QueryMaintenanceUpdate,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const inputs = groupRelationInputs(snapshot.relations).get(relationKey(node.relation));
  if (inputs === undefined || inputs.some(({ completeness }) => completeness === 'unknown')) {
    return evaluateMaterializedQueryNode(node, snapshot, new Map(), run);
  }
  if (previous === undefined || previous.unavailable || previous.from === undefined) {
    const recovered = evaluateMaterializedQueryNode(node, snapshot, new Map(), run);
    return recovered.unavailable || recovered.issues.length > 0 || recovered.result.completeness === 'unknown'
      ? recovered
      : { ...recovered, from: indexFromInputs(node, snapshot) };
  }
  const relevantChanges = update.relations.filter(({ relation }) => relationKey(relation) === relationKey(node.relation));
  const stable = previous.from !== undefined && relevantChanges.every((change) => {
    if (change.before === undefined || change.after === undefined || change.before.index !== change.after.index) return false;
    if (!previous.from?.inputOffsets.has(relationInputChangeKey(change))) return false;
    return change.rows.every((row) => row.before !== undefined && row.after !== undefined && row.before.index === row.after.index);
  });
  if (stable) {
    const rows = previous.result.rows.slice();
    const changedPositions: number[] = [];
    for (const change of relevantChanges) {
      const offset = previous.from?.inputOffsets.get(relationInputChangeKey(change)) as number;
      for (const row of change.rows) {
        if (row.before !== undefined && row.after !== undefined && queryValueEqual(row.before.row, row.after.row)) continue;
        const after = row.after as NonNullable<RelationRowChange['after']>;
        const occurrence = namespacedOccurrence(change.sourceId ?? change.attachmentId, row.occurrenceId);
        const position = offset + after.index;
        rows[position] = scopedRow(
          { [node.alias]: after.row },
          { [node.alias]: {
            ...(change.sourceId === undefined ? {} : { sourceId: change.sourceId }),
            ...(change.attachmentId === undefined ? {} : { attachmentId: change.attachmentId }),
            relationId: node.relation.relationId,
            ...(Object.hasOwn(after.row, 'id') ? { key: after.row.id as JsonValue } : {}),
            occurrence
          } }
        );
        changedPositions.push(position);
      }
    }
    return {
      result: { rows, completeness: inputs.some(({ completeness }) => completeness === 'lower-bound') ? 'lower-bound' : 'exact' },
      issues: [],
      unavailable: false,
      stableChangedPositions: [...new Set(changedPositions)].sort((left, right) => left - right),
      from: previous.from
    };
  }
  const changed = changedOccurrences(update, node.relation);
  const rows: ScopedRow[] = [];
  let previousByIdentity: ReadonlyMap<string, ScopedRow> | undefined;
  let outputIndex = 0;
  for (const input of inputs) input.rows.forEach((fields, index) => {
    const occurrence = relationOccurrence(input, index);
    const aligned = previous.result.rows[outputIndex];
    let retained: ScopedRow | undefined;
    if (!changed.has(occurrence)) {
      if (aligned?.provenance[node.alias]?.occurrence === occurrence) retained = aligned;
      else {
        previousByIdentity ??= new Map(previous.result.rows.map((row) => [resultKey(row), row]));
        retained = previousByIdentity.get(singleAliasResultKey(node.alias, occurrence));
      }
    }
    rows.push(retained ?? scopedRow(
      { [node.alias]: fields },
      { [node.alias]: { ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }), ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }), relationId: node.relation.relationId, ...(Object.hasOwn(fields, 'id') ? { key: fields.id as JsonValue } : {}), occurrence } }
    ));
    outputIndex += 1;
  });
  return {
    result: { rows, completeness: inputs.some(({ completeness }) => completeness === 'lower-bound') ? 'lower-bound' : 'exact' },
    issues: [],
    unavailable: false,
    from: indexFromInputs(node, snapshot)
  };
};

const relationInputChangeKey = (input: RelationInputChange): string =>
  stringTupleKey(relationKey(input.relation), input.attachmentId ?? input.sourceId ?? '');

const namespacedOccurrence = (namespace: string | undefined, occurrenceId: string): string =>
  namespace === undefined ? occurrenceId : namespace.length + ':' + namespace + occurrenceId.length + ':' + occurrenceId;

const changedOccurrences = (update: QueryMaintenanceUpdate, relation: RelationUse): ReadonlySet<string> => {
  const changed = new Set<string>();
  for (const input of update.relations) {
    if (relationKey(input.relation) !== relationKey(relation)) continue;
    const namespace = input.sourceId ?? input.attachmentId;
    for (const row of input.rows) {
      if (row.before !== undefined && row.after !== undefined && queryValueEqual(row.before.row, row.after.row)) continue;
      const occurrence = namespace === undefined ? row.occurrenceId : namespace.length + ':' + namespace + row.occurrenceId.length + ':' + row.occurrenceId;
      changed.add(occurrence);
    }
  }
  return changed;
};

const singleAliasResultKey = (alias: string, occurrence: string): string => alias.length + ':' + alias + occurrence.length + ':' + occurrence;

export const incrementallyMaterializeLocal = (
  node: Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  run: EvaluationRun
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.result.completeness === 'unknown' || child.issues.length > 0 || previous?.local === undefined) {
    const reason: QueryMaintenanceFallbackReason = child === undefined || child.unavailable || child.result.completeness === 'unknown' ? 'input_unavailable' : 'state_unavailable';
    return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'local', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason });
  }
  const oneToOne = isOneToOneLocallyMaintainedNode(node);
  if (child.stableChangedPositions !== undefined) {
    if (node.kind === 'select') {
      if (selectProjectionDependenciesEqual(
        node,
        previous.local.inputs,
        child.result.rows,
        child.stableChangedPositions
      )) {
        return withMaintenanceEvent({
          result: previous.result,
          issues: previous.issues,
          unavailable: previous.unavailable,
          stableChangedPositions: [],
          // The comparison above proves every projection dependency is equal.
          // Retaining the older input witness is safe: future comparisons only
          // inspect those same dependencies, while avoiding one state object
          // per independent projection in a pooled fanout.
          local: previous.local
        }, { operator: 'local', strategy: 'selective', affectedUnitCount: 0 });
      }
    }
    const replacements = new Map<number, LocalSegment>();
    const issues: Issue[] = [];
    let unavailable = false;
    let overrides: Map<QueryNode, MaterializedQueryNode> | undefined;
    for (const index of child.stableChangedPositions) {
      const row = child.result.rows[index];
      if (row === undefined) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'local', strategy: 'fallback', affectedUnitCount: child.stableChangedPositions.length, reason: 'unstable_layout' });
      overrides ??= new Map(materializedNodes);
      overrides.set(node.input, { result: { rows: [row], completeness: child.result.completeness }, issues: [], unavailable: false });
      const evaluated = evaluateMaterializedQueryNode(node, snapshot, overrides, run);
      issues.push(...evaluated.issues);
      unavailable = unavailable || evaluated.unavailable;
      const candidate = localSegment(node, evaluated.result.rows);
      const retained = localSegmentsSemanticallyEqual(previous.local.segments[index], candidate)
        ? previous.local.segments[index]
        : candidate;
      replacements.set(index, retained);
    }
    if (unavailable || issues.length > 0) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'local', strategy: 'fallback', affectedUnitCount: child.stableChangedPositions.length, reason: 'evaluation_unavailable' });
    const widthsChanged = [...replacements].some(([index, segment]) => localSegmentWidth(segment) !== (previous.local?.widths?.[index] ?? 1));
    const changedSegments = [...replacements].filter(([index, segment]) => segment !== previous.local?.segments[index]);
    const segments = changedSegments.length === 0 ? previous.local.segments : previous.local.segments.slice();
    for (const [index, segment] of changedSegments) (segments as LocalSegment[])[index] = segment;
    if (!widthsChanged) {
      // One-to-one segments are already the packed output in input order.
      // Preserve that invariant on updates: a second full reference-array copy
      // would contain the exact same objects and doubles local-pipeline churn.
      // Variable-width operators still require a separately packed output.
      const output = oneToOne
        ? segments as readonly ScopedRow[]
        : changedSegments.length === 0 ? previous.result.rows : previous.result.rows.slice();
      const changedOutputPositions: number[] = [];
      for (const [index, segment] of changedSegments) {
        const offset = previous.local.outputOffsets?.[index] ?? index;
        const replacementRows = localSegmentRows(segment);
        for (let relative = 0; relative < replacementRows.length; relative += 1) {
          if (!oneToOne) (output as ScopedRow[])[offset + relative] = replacementRows[relative] as ScopedRow;
          changedOutputPositions.push(offset + relative);
        }
      }
      return withMaintenanceEvent({
        result: { rows: output, completeness: child.result.completeness },
        issues: [],
        unavailable: false,
        stableChangedPositions: changedOutputPositions,
        local: {
          inputs: child.result.rows,
          segments,
          ...(previous.local.outputOffsets === undefined ? {} : { outputOffsets: previous.local.outputOffsets }),
          ...(previous.local.widths === undefined ? {} : { widths: previous.local.widths })
        }
      }, { operator: 'local', strategy: 'selective', affectedUnitCount: changedSegments.length });
    }
    const indexed = indexLocalSegmentLayout(segments);
    return withMaintenanceEvent({
      result: { rows: indexed.rows, completeness: child.result.completeness },
      issues: [],
      unavailable: false,
      local: { inputs: child.result.rows, segments, outputOffsets: indexed.outputOffsets, widths: indexed.widths }
    }, { operator: 'local', strategy: 'selective', affectedUnitCount: changedSegments.length });
  }
  // One-to-one operators have exactly one output per input, in input order, so
  // their packed output array is also their segment index. Other local
  // operators only need a separate sparse/variable-width segment array; the
  // child result already is the immutable input index and does not need copying.
  const segments: LocalSegment[] = [];
  const output: ScopedRow[] = oneToOne ? segments as ScopedRow[] : [];
  const issues: Issue[] = [];
  let unavailable = false;
  let previousPositions: ReadonlyMap<string, number> | undefined;
  // Reuse one lazily created overlay map for every changed child row. The
  // single overridden entry is replaced before each evaluation, so row-local
  // state cannot leak and an all-retained update allocates no overlay.
  let overrides: Map<QueryNode, MaterializedQueryNode> | undefined;
  for (let index = 0; index < child.result.rows.length; index += 1) {
    const row = child.result.rows[index] as ScopedRow;
    const key = resultKey(row);
    let previousIndex = index;
    const aligned = previous.local.inputs[index];
    if (aligned === undefined || resultKey(aligned) !== key) {
      previousPositions ??= new Map(previous.local.inputs.map((input, position) => [resultKey(input), position]));
      previousIndex = previousPositions.get(key) ?? -1;
    }
    const canRetain = previousIndex >= 0 && previous.local.inputs[previousIndex] === row;
    if (canRetain) {
      const retained = previous.local.segments[previousIndex];
      segments.push(retained);
      if (!oneToOne) appendLocalSegment(output, retained);
      continue;
    }
    overrides ??= new Map(materializedNodes);
    overrides.set(node.input, { result: { rows: [row], completeness: child.result.completeness }, issues: [], unavailable: false });
    const segment = evaluateMaterializedQueryNode(node, snapshot, overrides, run);
    issues.push(...segment.issues);
    unavailable = unavailable || segment.unavailable;
    const next = localSegment(node, segment.result.rows);
    segments.push(next);
    if (!oneToOne) appendLocalSegment(output, next);
  }
  if (unavailable || issues.length > 0) return withMaintenanceEvent(materializeQueryNode(node, snapshot, materializedNodes, run), { operator: 'local', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' });
  if (oneToOne) {
    return withMaintenanceEvent({
      result: { rows: output, completeness: child.result.completeness },
      issues: [],
      unavailable: false,
      local: { inputs: child.result.rows, segments }
    }, { operator: 'local', strategy: 'full', affectedUnitCount: child.result.rows.length });
  }
  const indexed = indexLocalSegmentLayout(segments);
  return withMaintenanceEvent({
    result: { rows: indexed.rows, completeness: child.result.completeness },
    issues: [],
    unavailable: false,
    local: { inputs: child.result.rows, segments, outputOffsets: indexed.outputOffsets, widths: indexed.widths }
  }, { operator: 'local', strategy: 'full', affectedUnitCount: child.result.rows.length });
};

export type UpdatedQueryNodeMaterialization = {
  readonly materialized: MaterializedQueryNode;
  readonly operatorEvent?: QueryMaintenanceOperatorEvent;
};

/** Shared physical-operator dispatch for single-root and pooled lifecycles. */
export const materializeUpdatedQueryNode = (input: {
  readonly node: QueryNode;
  readonly snapshot: QueryMaintenanceSnapshot;
  readonly update: QueryMaintenanceUpdate;
  readonly materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>;
  readonly previous: MaterializedQueryNode | undefined;
  readonly run: EvaluationRun;
}): UpdatedQueryNodeMaterialization => {
  const { node, snapshot, update, materializedNodes, previous, run } = input;
  const next = node.kind === 'from'
    ? incrementallyMaterializeFrom(node, snapshot, update, previous, run)
    : node.kind === 'join'
      ? incrementallyMaterializeJoin(node, snapshot, materializedNodes, previous, run)
    : node.kind === 'order'
      ? incrementallyMaterializeOrder(node, snapshot, materializedNodes, previous, run)
    : node.kind === 'distinct'
      ? incrementallyMaterializeDistinct(node, snapshot, materializedNodes, previous, run)
    : node.kind === 'window'
      ? incrementallyMaterializeWindow(node, snapshot, materializedNodes, previous, run)
    : node.kind === 'aggregate'
      ? incrementallyMaterializeAggregate(node, snapshot, materializedNodes, previous, run)
    : node.kind === 'slice'
      ? incrementallyMaterializeSlice(node, snapshot, materializedNodes, previous, run)
    : node.kind === 'set'
      ? incrementallyMaterializeUnionAll(node, snapshot, materializedNodes, previous, run)
    : isLocallyMaintainedNode(node)
      ? incrementallyMaterializeLocal(node, snapshot, materializedNodes, previous, run)
      : materializeQueryNode(node, snapshot, materializedNodes, run);
  const charged = chargeIncrementalOutput(node, snapshot, materializedNodes, next, run);
  const operatorEvent = charged.maintenanceEvent ?? operatorEventForUpdate(node, previous, charged, materializedNodes);
  return {
    materialized: charged,
    ...(operatorEvent === undefined ? {} : { operatorEvent })
  };
};

const indexLocalSegments = (
  node: Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }>,
  inputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[]
): NonNullable<MaterializedQueryNode['local']> => {
  if (isOneToOneLocallyMaintainedNode(node) && outputs.length === inputs.length) {
    return { inputs, segments: outputs };
  }
  const positions = new Map(inputs.map((row, index) => [resultKey(row), index]));
  const segments: LocalSegment[] = Array.from({ length: inputs.length });
  for (const row of outputs) {
    const key = node.kind === 'where' ? resultKey(row) : row.origin;
    const index = key === undefined ? undefined : positions.get(key);
    if (index === undefined) continue;
    if (node.kind !== 'unnest') segments[index] = row;
    else {
      const existing = segments[index];
      if (existing === undefined) segments[index] = [row];
      else (existing as ScopedRow[]).push(row);
    }
  }
  const indexed = indexLocalSegmentLayout(segments);
  return { inputs, segments, outputOffsets: indexed.outputOffsets, widths: indexed.widths };
};

const localSegment = (node: QueryNode, rows: readonly ScopedRow[]): LocalSegment => node.kind === 'unnest' ? rows : rows[0];
const localSegmentsSemanticallyEqual = (left: LocalSegment, right: LocalSegment): boolean => {
  const leftRows = localSegmentRows(left);
  const rightRows = localSegmentRows(right);
  return leftRows.length === rightRows.length && leftRows.every((row, index) => {
    const candidate = rightRows[index] as ScopedRow;
    return resultKey(row) === resultKey(candidate)
      && queryValueEqual(row.scope as unknown as QueryLogicalValue, candidate.scope as unknown as QueryLogicalValue)
      && queryValueEqual(row.provenance as unknown as QueryLogicalValue, candidate.provenance as unknown as QueryLogicalValue);
  });
};
const localSegmentRows = (segment: LocalSegment): readonly ScopedRow[] => segment === undefined ? [] : Array.isArray(segment) ? segment : [segment as ScopedRow];
const localSegmentWidth = (segment: LocalSegment): number => segment === undefined ? 0 : Array.isArray(segment) ? segment.length : 1;
const indexLocalSegmentLayout = (segments: readonly LocalSegment[]): {
  readonly rows: readonly ScopedRow[];
  readonly outputOffsets: readonly number[];
  readonly widths: readonly number[];
} => {
  const rows: ScopedRow[] = [];
  const outputOffsets: number[] = [];
  const widths: number[] = [];
  for (const segment of segments) {
    outputOffsets.push(rows.length);
    const segmentRows = localSegmentRows(segment);
    widths.push(segmentRows.length);
    rows.push(...segmentRows);
  }
  return { rows, outputOffsets, widths };
};
const appendLocalSegment = (output: ScopedRow[], segment: LocalSegment): void => {
  if (segment === undefined) return;
  if (Array.isArray(segment)) output.push(...segment);
  else output.push(segment as ScopedRow);
};

export const isLocallyMaintainedNode = (node: QueryNode): node is Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }> => {
  if (node.kind === 'rename' || node.kind === 'omit') return true;
  if (node.kind === 'where') return !containsSubquery(node.predicate);
  if (node.kind === 'select' || node.kind === 'with-fields') return !Object.values(node.fields).some(containsSubquery);
  return node.kind === 'unnest' && !containsSubquery(node.expression);
};

const isOneToOneLocallyMaintainedNode = (
  node: Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }>
): node is Extract<QueryNode, { readonly kind: 'select' | 'with-fields' | 'rename' | 'omit' }> => {
  return node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit';
};


export const operatorEventForUpdate = (
  node: QueryNode,
  previous: MaterializedQueryNode | undefined,
  next: MaterializedQueryNode,
  materialized: ReadonlyMap<QueryNode, MaterializedQueryNode>
): QueryMaintenanceOperatorEvent | undefined => {
  const failed = next.unavailable || next.result.completeness === 'unknown';
  if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest') {
    const child = materialized.get(node.input);
    if (!isLocallyMaintainedNode(node)) return { operator: 'local', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason: 'unsupported_expression' };
    if (child === undefined || child.unavailable || child.result.completeness === 'unknown') return { operator: 'local', strategy: 'fallback', affectedUnitCount: 0, reason: 'input_unavailable' };
    if (previous?.local === undefined) return { operator: 'local', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'state_unavailable' };
    if (failed) return { operator: 'local', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' };
    const affected = child.stableChangedPositions?.length;
    return { operator: 'local', strategy: affected === undefined ? 'full' : 'selective', affectedUnitCount: affected ?? child.result.rows.length };
  }
  if (node.kind === 'join') {
    const left = materialized.get(node.left);
    const right = materialized.get(node.right);
    if (equijoinFields(node) === undefined) return { operator: 'join', strategy: 'fallback', affectedUnitCount: left?.result.rows.length ?? 0, reason: 'unsupported_expression' };
    if (left === undefined || right === undefined || left.unavailable || right.unavailable || left.result.completeness === 'unknown' || right.result.completeness === 'unknown') return { operator: 'join', strategy: 'fallback', affectedUnitCount: 0, reason: 'input_unavailable' };
    if (previous?.join === undefined) return { operator: 'join', strategy: 'fallback', affectedUnitCount: left.result.rows.length, reason: 'state_unavailable' };
    if (failed || next.join === undefined) return { operator: 'join', strategy: 'fallback', affectedUnitCount: left.result.rows.length, reason: 'evaluation_unavailable' };
    const affected = next.join.segments.reduce((count, segment, index) => count + (segment === previous.join?.segments[index] ? 0 : 1), 0);
    return { operator: 'join', strategy: affected < left.result.rows.length ? 'selective' : 'full', affectedUnitCount: affected };
  }
  if (node.kind === 'order') {
    const child = materialized.get(node.input);
    if (!orderCanBeIncrementallyIndexed(node)) return { operator: 'order', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason: 'unsupported_expression' };
    if (child === undefined || child.unavailable || child.result.completeness !== 'exact') return { operator: 'order', strategy: 'fallback', affectedUnitCount: 0, reason: 'input_unavailable' };
    if (previous?.order === undefined) return { operator: 'order', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'state_unavailable' };
    if (failed) return { operator: 'order', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' };
    const retained = new Set(previous.order.inputs);
    const nextInputs = new Set(child.result.rows);
    const affected = child.result.rows.reduce((count, row) => count + (retained.has(row) ? 0 : 1), 0);
    const previousCommon = previous.order.inputs.filter((row) => nextInputs.has(row));
    const nextCommon = child.result.rows.filter((row) => retained.has(row));
    if (previousCommon.some((row, index) => row !== nextCommon[index])) return { operator: 'order', strategy: 'fallback', affectedUnitCount: affected, reason: 'unstable_layout' };
    return { operator: 'order', strategy: affected > Math.max(32, child.result.rows.length >>> 3) ? 'full' : 'selective', affectedUnitCount: affected };
  }
  if (node.kind === 'aggregate') {
    const child = materialized.get(node.input);
    if (!aggregateCanBeIncrementallyIndexed(node)) return { operator: 'aggregate', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason: 'unsupported_expression' };
    if (child === undefined || child.unavailable || child.result.completeness !== 'exact') return { operator: 'aggregate', strategy: 'fallback', affectedUnitCount: 0, reason: 'input_unavailable' };
    if (previous?.aggregate === undefined) return { operator: 'aggregate', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'state_unavailable' };
    if (failed || next.aggregate === undefined) return { operator: 'aggregate', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' };
    const affected = child.stableChangedPositions?.length;
    const selective = affected !== undefined && previous.aggregate.inputs.length === child.result.rows.length && affected <= Math.max(32, child.result.rows.length >>> 3);
    return { operator: 'aggregate', strategy: selective ? 'selective' : 'full', affectedUnitCount: affected ?? child.result.rows.length };
  }
  if (node.kind === 'window') {
    const child = materialized.get(node.input);
    if (!windowCanBePartitionMaintained(node)) return { operator: 'window', strategy: 'fallback', affectedUnitCount: child?.result.rows.length ?? 0, reason: 'unsupported_expression' };
    if (child === undefined || child.unavailable || child.result.completeness !== 'exact') return { operator: 'window', strategy: 'fallback', affectedUnitCount: 0, reason: 'input_unavailable' };
    if (previous?.window === undefined) return { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'state_unavailable' };
    if (failed || next.window === undefined) return { operator: 'window', strategy: 'fallback', affectedUnitCount: child.result.rows.length, reason: 'evaluation_unavailable' };
    return { operator: 'window', strategy: 'selective', affectedUnitCount: next.stableChangedPositions?.length ?? child.result.rows.length };
  }
  return undefined;
};

export const maintainedQueryResult = (
  root: MaterializedQueryNode | undefined,
  additionalIssues: readonly Issue[],
  state: IncrementalQueryMaintenanceState,
  publicRows: WeakMap<ScopedRow, QueryRecord>,
  previousPublicViews?: IncrementalQueryResult,
  reusePublicViews = false
): IncrementalQueryResult => {
  if (reusePublicViews && previousPublicViews !== undefined) {
    return Object.freeze({
      rows: previousPublicViews.rows,
      resultKeys: previousPublicViews.resultKeys,
      completeness: previousPublicViews.completeness,
      issues: previousPublicViews.issues,
      state
    });
  }
  const issues = publicQueryIssues(deduplicateQueryIssues([...(root?.issues ?? []), ...additionalIssues]));
  if (root === undefined || root.unavailable || root.result.completeness === 'unknown') {
    return Object.freeze({ rows: Object.freeze([]), resultKeys: Object.freeze([]), completeness: 'unknown', issues, state });
  }
  if (root.stableChangedPositions?.length === 0 && previousPublicViews !== undefined && previousPublicViews.rows.length === root.result.rows.length) {
    return Object.freeze({
      rows: previousPublicViews.rows,
      resultKeys: previousPublicViews.resultKeys,
      completeness: root.result.completeness,
      issues,
      state
    });
  }
  if (root.stableChangedPositions !== undefined && previousPublicViews !== undefined && previousPublicViews.rows.length === root.result.rows.length) {
    const rows = previousPublicViews.rows.slice();
    for (const position of root.stableChangedPositions) {
      const row = root.result.rows[position];
      if (row !== undefined) rows[position] = publicQueryRow(row, publicRows);
    }
    return Object.freeze({
      rows: Object.freeze(rows),
      resultKeys: previousPublicViews.resultKeys,
      completeness: root.result.completeness,
      issues,
      state
    });
  }
  return Object.freeze({
    rows: publicQueryRows(root.result.rows, publicRows),
    resultKeys: Object.freeze(root.result.rows.map(resultKey)),
    completeness: root.result.completeness,
    issues,
    state
  });
};

export const maintenanceState = (
  materializedNodeCount: number,
  updatedNodeCount: number,
  changedNodeCount: number,
  changedRelationIds: readonly string[],
  resultDelta: IncrementalQueryResultDelta,
  revision: number,
  rejectedUpdateCount: number,
  operatorDiagnostics = emptyOperatorDiagnostics()
): IncrementalQueryMaintenanceState => Object.freeze({
  strategy: 'differential-operator-graph',
  revision,
  materializedNodeCount,
  updatedNodeCount,
  changedNodeCount,
  changedRelationIds: frozenInternalArray(changedRelationIds),
  resultDelta: Object.freeze({
    addedResultKeys: frozenInternalArray(resultDelta.addedResultKeys),
    removedResultKeys: frozenInternalArray(resultDelta.removedResultKeys),
    updatedResultKeys: frozenInternalArray(resultDelta.updatedResultKeys)
  }),
  rejectedUpdateCount,
  operatorDiagnostics
});

export const emptyIncrementalQueryResultDelta: IncrementalQueryResultDelta = Object.freeze({ addedResultKeys: Object.freeze([]), removedResultKeys: Object.freeze([]), updatedResultKeys: Object.freeze([]) });

export const materializedQueryNodeEqual = (left: MaterializedQueryNode, right: MaterializedQueryNode, values: WeakMap<ScopedRow, string>): boolean => {
  if (left.unavailable !== right.unavailable || left.result.completeness !== right.result.completeness) return false;
  if (left.issues.length !== right.issues.length || left.issues.some((issue, index) => issue.id !== right.issues[index]?.id)) return false;
  if (left.result.rows.length !== right.result.rows.length) return false;
  if (right.verifiedChangedPositions !== undefined) return right.verifiedChangedPositions.length === 0;
  if (right.stableChangedPositions !== undefined) {
    for (const index of right.stableChangedPositions) {
      const row = left.result.rows[index];
      const candidate = right.result.rows[index];
      if (row === undefined
        || candidate === undefined
        || row !== candidate && scopedRowIdentity(row, values) !== scopedRowIdentity(candidate, values)) return false;
    }
    return true;
  }
  for (let index = 0; index < left.result.rows.length; index += 1) {
    const row = left.result.rows[index] as ScopedRow;
    const candidate = right.result.rows[index] as ScopedRow;
    if (row !== candidate && scopedRowIdentity(row, values) !== scopedRowIdentity(candidate, values)) return false;
  }
  return true;
};

const changedRowPositionsIfStableIdentity = (
  next: readonly ScopedRow[],
  previous: readonly ScopedRow[]
): readonly number[] | undefined => {
  if (next.length !== previous.length) return undefined;
  const changed: number[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const row = next[index] as ScopedRow;
    const prior = previous[index] as ScopedRow;
    if (resultKey(row) !== resultKey(prior)) return undefined;
    if (row !== prior) changed.push(index);
  }
  return changed;
};

const scopedRowIdentity = (row: ScopedRow, values: WeakMap<ScopedRow, string>): string => stringTupleKey(resultKey(row), rowValueIdentity(row, values));
const rowValueIdentity = (row: ScopedRow, values: WeakMap<ScopedRow, string>): string => {
  const cached = values.get(row);
  if (cached !== undefined) return cached;
  const identity = canonicalizeQueryValue(visibleRow(row));
  values.set(row, identity);
  return identity;
};



export const diffMaintainedResults = (
  previousRoot: MaterializedQueryNode | undefined,
  nextRoot: MaterializedQueryNode | undefined,
  values: WeakMap<ScopedRow, string>
): IncrementalQueryResultDelta => {
  // Invalidation withdraws the current assertion; it does not prove removals.
  if (nextRoot === undefined || nextRoot.unavailable || nextRoot.result.completeness === 'unknown') return emptyIncrementalQueryResultDelta;
  const beforeRows = previousRoot?.result.rows ?? [];
  const afterRows = nextRoot.result.rows;
  if (previousRoot !== undefined && nextRoot.verifiedUpdatedResultKeys !== undefined) {
    return nextRoot.verifiedUpdatedResultKeys.length === 0
      ? emptyIncrementalQueryResultDelta
      : { addedResultKeys: [], removedResultKeys: [], updatedResultKeys: nextRoot.verifiedUpdatedResultKeys };
  }
  if (previousRoot !== undefined && nextRoot.verifiedChangedPositions !== undefined && beforeRows.length === afterRows.length) {
    return nextRoot.verifiedChangedPositions.length === 0
      ? emptyIncrementalQueryResultDelta
      : {
        addedResultKeys: [],
        removedResultKeys: [],
        updatedResultKeys: nextRoot.verifiedChangedPositions.map((index) => resultKey(afterRows[index] as ScopedRow))
      };
  }
  if (previousRoot !== undefined && nextRoot.stableChangedPositions !== undefined && beforeRows.length === afterRows.length) {
    const updatedResultKeys: string[] = [];
    for (const index of nextRoot.stableChangedPositions) {
      const before = beforeRows[index];
      const after = afterRows[index];
      if (before === undefined || after === undefined || before === after) continue;
      if (rowValueIdentity(before, values) !== rowValueIdentity(after, values)) updatedResultKeys.push(resultKey(after));
    }
    return updatedResultKeys.length === 0
      ? emptyIncrementalQueryResultDelta
      : { addedResultKeys: [], removedResultKeys: [], updatedResultKeys };
  }
  if (beforeRows.length === afterRows.length) {
    const updatedResultKeys: string[] = [];
    let identitiesStable = true;
    for (let index = 0; index < beforeRows.length; index += 1) {
      const row = beforeRows[index] as ScopedRow;
      const after = afterRows[index] as ScopedRow;
      if (resultKey(row) !== resultKey(after)) {
        identitiesStable = false;
        break;
      }
      if (row !== after && rowValueIdentity(row, values) !== rowValueIdentity(after, values)) updatedResultKeys.push(resultKey(row));
    }
    if (identitiesStable) {
      return updatedResultKeys.length === 0 ? emptyIncrementalQueryResultDelta : { addedResultKeys: [], removedResultKeys: [], updatedResultKeys };
    }
  }
  const previousRows = resultIdentityMap(beforeRows, values);
  const nextRows = resultIdentityMap(afterRows, values);
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const [key, before] of previousRows) {
    const after = nextRows.get(key);
    if (after === undefined) removed.push(key);
    else if (before !== after) updated.push(key);
  }
  for (const key of nextRows.keys()) if (!previousRows.has(key)) added.push(key);
  return { addedResultKeys: added.sort(), removedResultKeys: removed.sort(), updatedResultKeys: updated.sort() };
};

const resultIdentityMap = (rows: readonly ScopedRow[], values: WeakMap<ScopedRow, string>): ReadonlyMap<string, string> =>
  new Map(rows.map((row) => [resultKey(row), rowValueIdentity(row, values)]));

const frozenInternalArray = <Value>(values: readonly Value[]): readonly Value[] =>
  Object.isFrozen(values) ? values : Object.freeze([...values]);

const deduplicateQueryIssues = (issues: readonly Issue[]): readonly Issue[] => [...new Map(issues.map((issue) => [issue.id, issue])).values()];
