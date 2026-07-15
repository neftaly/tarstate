import { canonicalizeJson } from './artifacts.js';
import { createIssue, type Issue } from './issues.js';
import { WorkBudgetLedger, type NodeResult, type QueryContext, type ScopedRow } from './internal-query-evaluation-context.js';
import {
  evaluateQueryExpression as evaluateExpr,
  expressionJson,
  knownExpression as known,
  projectExpressionFields as projectFields,
  type QueryExpressionContext as EvalContext,
  type QueryExpressionResult as ExpressionResult,
  type QueryExpressionRuntime
} from './internal-query-expression.js';
import { containsNamedCall, containsSubquery, directQueryChildren } from './internal-query-graph.js';
import { assertPreparedPlan } from './internal-prepared-plan.js';
import {
  adoptJsonValue,
  adoptMaintenanceSnapshot,
  adoptQueryRecord,
  adoptQueryRequest
} from './internal-query-ownership.js';
import { canonicalizeQueryValue, compareQueryJsonValuesTotal } from './internal-query-values.js';
import { groupRelationInputs, relationKey, relationOccurrence } from './internal-query-relations.js';
import { validateRelationInputs } from './internal-query-input-validation.js';
import type { PreparedPlan } from './query-plan-contract.js';
import { comparePortableStrings } from './portable-order.js';
import type {
  AggregateExpr,
  Completeness,
  Expr,
  OrderTerm,
  PreparedQueryRequest,
  QueryCursor,
  QueryLogicalValue,
  QueryNode,
  QueryRecord,
  QueryRequest,
  QueryResult,
  RelationInput,
  WindowExpr
} from './query-model.js';
import type { QueryMaintenanceSnapshot } from './query-incremental-model.js';
import { logicalAnd, logicalOr, logicalUnknown, type JsonValue, type LogicalTruth } from './value.js';

const scopedInputRows = new WeakMap<object, Map<string, readonly ScopedRow[]>>();

export const consumeQueryWork = (context: QueryContext, units = 1): boolean => {
  const work = context.state.work;
  if (work === undefined) return true;
  if (!work.consume(units)) {
    if (!context.state.issues.some(({ code }) => code === 'query.execution_budget_exceeded')) context.state.issues.push(createIssue({ code: 'query.execution_budget_exceeded', phase: 'query', severity: 'error', retry: 'after_input', details: { maxWorkUnits: work.limit } }));
    context.state.unavailable = true;
    return false;
  }
  return true;
};

export const evaluateQuery = (request: QueryRequest): QueryResult => {
  const owned = adoptQueryRequest(request);
  return evaluateOwnedQuery(owned.root, owned);
};

/**
 * Evaluates a runtime-sealed prepared plan while adopting every changing input.
 * Unlike `evaluateQuery`, this path amortizes adoption of the portable query AST.
 */
export const evaluatePreparedQuery = (
  plan: PreparedPlan<QueryNode>,
  request: PreparedQueryRequest
): QueryResult => {
  assertPreparedPlan(plan);
  return evaluateOwnedQuery(plan.query, adoptMaintenanceSnapshot(request));
};

const evaluateOwnedQuery = (root: QueryNode, owned: QueryMaintenanceSnapshot): QueryResult => {
  const issues = [...validateRelationInputs(owned.relations, 'query')];
  if (issues.length > 0) return frozenQueryResult([], [], 'unknown', issues);
  const context: QueryContext = {
    environment: {
      relations: groupRelationInputs(owned.relations),
      parameters: owned.parameters ?? {},
      functions: owned.functions ?? new Map(),
      ...(owned.basis === undefined ? {} : { basis: owned.basis }),
      ...(owned.membershipRevision === undefined ? {} : { membershipRevision: owned.membershipRevision })
    },
    state: {
      issues,
      recursions: new Map(),
      recursionConstants: new Map(),
      recursionDependencies: new Map(),
      joinIndexes: new Map(),
      unavailable: false,
      aggregateCompactionCount: 0,
      ...(owned.executionBudget === undefined ? {} : { work: new WorkBudgetLedger(owned.executionBudget.maxWorkUnits) })
    }
  };
  const result = evaluateNode(root, context);
  if (context.state.unavailable || result.completeness === 'unknown') return frozenQueryResult([], [], 'unknown', issues);
  const rows = publicQueryRows(result.rows, new WeakMap());
  return frozenQueryResult(rows, result.rows.map(resultKey), result.completeness, issues);
};

const frozenQueryResult = (rows: readonly QueryRecord[], resultKeys: readonly string[], completeness: Completeness, issues: readonly Issue[]): QueryResult => Object.freeze({
  rows: Object.isFrozen(rows) ? rows : Object.freeze([...rows]),
  resultKeys: Object.freeze([...resultKeys]),
  completeness,
  issues: publicQueryIssues(issues)
});

export const evaluateNode = (node: QueryNode, context: QueryContext): NodeResult => {
  const materialized = context.environment.outer === undefined ? context.environment.evaluationCache?.resultFor(node) : undefined;
  if (materialized !== undefined) {
    context.state.issues.push(...materialized.issues);
    context.state.unavailable = context.state.unavailable || materialized.unavailable;
    return materialized.result;
  }
  const cacheable = context.environment.outer === undefined && context.state.recursions.size > 0 && !referencesActiveRecursion(node, context);
  const cached = cacheable ? context.state.recursionConstants.get(node) : undefined;
  if (cached !== undefined) return cached;
  const result = evaluateNodeUncached(node, context);
  if (result.completeness !== 'unknown' && !consumeQueryWork(context, result.rows.length)) return { rows: [], completeness: 'unknown' };
  if (cacheable) context.state.recursionConstants.set(node, result);
  return result;
};

const evaluateNodeUncached = (node: QueryNode, context: QueryContext): NodeResult => {
  if (node.kind === 'from') {
    const inputs = context.environment.relations.get(relationKey(node.relation));
    if (inputs === undefined || inputs.some(({ completeness }) => completeness === 'unknown')) {
      context.state.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', relationId: node.relation.relationId, details: { reason: 'input_unavailable' } }));
      return { rows: [], completeness: 'unknown' };
    }
    const rows = inputs.length === 1
      ? scopedRowsForInput(inputs[0] as RelationInput, node.alias, node.relation.relationId, context)
      : inputs.flatMap((input) => scopedRowsForInput(input, node.alias, node.relation.relationId, context));
    return {
      rows,
      completeness: inputs.some(({ completeness }) => completeness === 'lower-bound') ? 'lower-bound' : 'exact'
    };
  }
  if (node.kind === 'values') return { rows: node.rows.map((fields, index) => scopedRow({ ...context.environment.outer?.scope, [node.alias]: fields }, { ...context.environment.outer?.provenance, [node.alias]: { relationId: 'values', occurrence: 'values:' + index } })), completeness: 'exact' };
  if (node.kind === 'recursion-ref') {
    const rows = context.state.recursions.get(node.name);
    if (rows !== undefined) return { rows, completeness: 'exact' };
    context.state.issues.push(createIssue({ code: 'query.recursion_reference_missing', details: { name: node.name } }));
    return { rows: [], completeness: 'unknown' };
  }
  if (node.kind === 'recursive') return evaluateRecursive(node, context);
  if (node.kind === 'where') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness === 'unknown') return inner;
    const rows = inner.rows.filter((row) => {
      if (!consumeQueryWork(context)) return false;
      const result = evaluateExpr(node.predicate, exprContext(row, context));
      if (result.status === 'unavailable' || result.status === 'indeterminate') context.state.unavailable = true;
      return result.status === 'known' && result.value === true;
    });
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'select') {
    const inner = evaluateNode(node.input, context);
    return mapProjection(inner, node.alias, (row) => projectFields(node.fields, exprContext(row, context)), context);
  }
  if (node.kind === 'with-fields') {
    const inner = evaluateNode(node.input, context);
    const rows = inner.rows.map((row) => {
      const base = requiredAlias(row, node.alias, context);
      if (base === undefined) return row;
      const additions = projectFields(node.fields, exprContext(row, context));
      const identity = resultKey(row);
      return { scope: { ...row.scope, [node.alias]: { ...base, ...additions } }, provenance: row.provenance, identity, origin: identity };
    });
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'rename') {
    const inner = evaluateNode(node.input, context);
    const rows = inner.rows.map((row) => {
      const record = requiredAlias(row, node.alias, context);
      return record === undefined ? row : { ...row, scope: { ...row.scope, [node.alias]: renameFields(record, node.fields) }, origin: resultKey(row) };
    });
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'omit') {
    const inner = evaluateNode(node.input, context);
    const omitted = new Set(node.fields);
    const rows = inner.rows.map((row) => {
      const record = requiredAlias(row, node.alias, context);
      return record === undefined ? row : { ...row, scope: { ...row.scope, [node.alias]: omitFields(record, omitted) }, origin: resultKey(row) };
    });
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'unnest') {
    const inner = evaluateNode(node.input, context);
    const rows: ScopedRow[] = [];
    for (const row of inner.rows) {
      const value = evaluateExpr(node.expression, exprContext(row, context));
      if (value.status === 'unavailable' || value.status === 'indeterminate') context.state.unavailable = true;
      if (value.status !== 'known' || !Array.isArray(value.value)) continue;
      const origin = resultKey(row);
      value.value.forEach((item, index) => rows.push(scopedRow({ ...row.scope, [node.alias]: { [node.field]: item } }, { ...row.provenance, [node.alias]: { relationId: 'unnest', occurrence: origin + ':' + index } }, origin)));
    }
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'join') return evaluateJoin(node, context);
  if (node.kind === 'aggregate') return evaluateAggregate(node, context);
  if (node.kind === 'distinct') {
    const inner = evaluateNode(node.input, context);
    const seen = new Set<string>();
    return { rows: inner.rows.filter((row) => { if (!consumeQueryWork(context)) return false; const key = canonicalizeQueryValue(visibleRow(row)); if (seen.has(key)) return false; seen.add(key); return true; }), completeness: inner.completeness };
  }
  if (node.kind === 'set') return evaluateSet(node, context);
  if (node.kind === 'order') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'order');
    const rows = sortRowsByOrder(inner.rows, node.by, context);
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
  }
  if (node.kind === 'slice') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'slice');
    if (!consumeQueryWork(context, inner.rows.length)) return { rows: [], completeness: 'unknown' };
    const offset = Math.max(0, node.offset ?? 0);
    const end = node.limit === undefined ? undefined : offset + Math.max(0, node.limit);
    return { rows: inner.rows.slice(offset, end), completeness: 'exact' };
  }
  if (node.kind === 'window') return evaluateWindow(node, context);
  return evaluateSeek(node, context);
};

const scopedRowsForInput = (
  input: RelationInput,
  alias: string,
  relationId: string,
  context: QueryContext
): readonly ScopedRow[] => {
  const outer = context.environment.outer;
  if (outer === undefined && Object.isFrozen(input)) {
    const cached = scopedInputRows.get(input)?.get(alias);
    if (cached !== undefined) return cached;
  }
  const rows = input.rows.map((fields, index) => scopedRow(
    { ...outer?.scope, [alias]: fields },
    {
      ...outer?.provenance,
      [alias]: {
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
        relationId,
        ...(Object.hasOwn(fields, 'id') ? { key: fields.id as JsonValue } : {}),
        occurrence: relationOccurrence(input, index)
      }
    }
  ));
  if (outer === undefined && Object.isFrozen(input)) {
    const byAlias = scopedInputRows.get(input) ?? new Map<string, readonly ScopedRow[]>();
    byAlias.set(alias, rows);
    scopedInputRows.set(input, byAlias);
  }
  return rows;
};

const evaluateJoin = (node: Extract<QueryNode, { readonly kind: 'join' }>, context: QueryContext): NodeResult => {
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (left.completeness === 'unknown' || right.completeness === 'unknown') return { rows: [], completeness: 'unknown' };
  if ((node.join === 'anti' || node.join === 'left') && right.completeness !== 'exact') return nonMonotoneUnknown(context, node.join);
  const rows: ScopedRow[] = [];
  // A recursion-ref has no statically declared aliases, but its frontier rows
  // do. Recover those aliases from the materialized operands so recursive
  // equijoins still use the invariant-side index instead of scanning it once
  // per frontier row.
  const equality = equijoinFields(node) ?? materializedEquijoinFields(node, left.rows, right.rows);
  const reverseIndexed = node.join === 'inner'
    && equality !== undefined
    && !referencesActiveRecursion(node.left, context)
    && referencesActiveRecursion(node.right, context);
  if (reverseIndexed && equality !== undefined) {
    const leftIndex = indexedRows(node, node.left, left.rows, equality.left, context);
    const leftPositions = indexedRowPositions.get(leftIndex);
    const rightPositions = new Map(right.rows.map((row, index) => [row, index]));
    const matches: { readonly left: ScopedRow; readonly right: ScopedRow }[] = [];
    outer: for (const rightRow of right.rows) {
      for (const leftRow of lookupIndexedRows(leftIndex, equality.right, rightRow, context)) {
        if (!consumeQueryWork(context)) break outer;
        matches.push({ left: leftRow, right: rightRow });
      }
    }
    matches.sort((first, second) =>
      (leftPositions?.get(first.left) ?? 0) - (leftPositions?.get(second.left) ?? 0)
      || (rightPositions.get(first.right) ?? 0) - (rightPositions.get(second.right) ?? 0));
    for (const { left: leftRow, right: rightRow } of matches) {
      const origin = resultKey(leftRow);
      rows.push(scopedRow({ ...leftRow.scope, ...rightRow.scope }, { ...leftRow.provenance, ...rightRow.provenance }, origin));
    }
    return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  }
  const rightIndex = equality === undefined ? undefined : indexedRows(node, node.right, right.rows, equality.right, context);
  for (const leftRow of left.rows) {
    const candidates = rightIndex === undefined || equality === undefined ? right.rows : lookupIndexedRows(rightIndex, equality.left, leftRow, context);
    rows.push(...joinLeftRow(node, leftRow, candidates, rightIndex !== undefined, context));
  }
  if (context.state.unavailable) return { rows: [], completeness: 'unknown' };
  return { rows, completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
};

export const joinLeftRow = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  leftRow: ScopedRow,
  candidates: readonly ScopedRow[],
  indexed: boolean,
  context: QueryContext
): readonly ScopedRow[] => {
  const rows: ScopedRow[] = [];
  let matched = false;
  const origin = resultKey(leftRow);
  for (const rightRow of candidates) {
    if (!consumeQueryWork(context)) break;
    const combined = scopedRow({ ...leftRow.scope, ...rightRow.scope }, { ...leftRow.provenance, ...rightRow.provenance }, origin);
    const result = indexed || node.join === 'cross' || node.on === undefined ? known(true) : evaluateExpr(node.on, exprContext(combined, context));
    if (result.status === 'unavailable' || result.status === 'indeterminate') context.state.unavailable = true;
    if (result.status !== 'known' || result.value !== true) continue;
    matched = true;
    if (node.join === 'inner' || node.join === 'cross' || node.join === 'left') rows.push(combined);
    if (node.join === 'semi' || node.join === 'anti') break;
  }
  if (node.join === 'semi' && matched || node.join === 'anti' && !matched) rows.push(leftRow);
  if (node.join === 'left' && !matched) {
    const missingRight = Object.fromEntries([...queryAliases(node.right)].map((alias) => [alias, {}]));
    rows.push({ scope: { ...leftRow.scope, ...missingRight }, provenance: leftRow.provenance, identity: origin, origin });
  }
  return rows;
};

type FieldExpression = Extract<Expr, { readonly kind: 'field' }>;
export type EquijoinExpressions = { readonly left: Expr; readonly right: Expr };

const equijoinFieldsIn = (expression: Expr): readonly FieldExpression[] | undefined => {
  if (expression.kind === 'field') return [expression];
  if (expression.kind !== 'array' || expression.items.length === 0 || expression.items.some((item) => item.kind !== 'field')) return undefined;
  return expression.items as readonly FieldExpression[];
};

export const equijoinFields = (node: Extract<QueryNode, { readonly kind: 'join' }>): EquijoinExpressions | undefined => {
  if (node.on?.kind !== 'compare' || node.on.op !== 'eq') return undefined;
  const leftFields = equijoinFieldsIn(node.on.left);
  const rightFields = equijoinFieldsIn(node.on.right);
  if (leftFields === undefined || rightFields === undefined) return undefined;
  const leftAliases = queryAliases(node.left);
  const rightAliases = queryAliases(node.right);
  if (leftFields.every(({ alias }) => leftAliases.has(alias)) && rightFields.every(({ alias }) => rightAliases.has(alias))) return { left: node.on.left, right: node.on.right };
  if (leftFields.every(({ alias }) => rightAliases.has(alias)) && rightFields.every(({ alias }) => leftAliases.has(alias))) return { left: node.on.right, right: node.on.left };
  return undefined;
};

const materializedEquijoinFields = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  leftRows: readonly ScopedRow[],
  rightRows: readonly ScopedRow[]
): EquijoinExpressions | undefined => {
  if (node.on?.kind !== 'compare' || node.on.op !== 'eq' || leftRows.length === 0 || rightRows.length === 0) return undefined;
  const leftFields = equijoinFieldsIn(node.on.left);
  const rightFields = equijoinFieldsIn(node.on.right);
  if (leftFields === undefined || rightFields === undefined) return undefined;
  const leftScope = (leftRows[0] as ScopedRow).scope;
  const rightScope = (rightRows[0] as ScopedRow).scope;
  if (leftFields.every(({ alias }) => Object.hasOwn(leftScope, alias)) && rightFields.every(({ alias }) => Object.hasOwn(rightScope, alias))) return { left: node.on.left, right: node.on.right };
  if (leftFields.every(({ alias }) => Object.hasOwn(rightScope, alias)) && rightFields.every(({ alias }) => Object.hasOwn(leftScope, alias))) return { left: node.on.right, right: node.on.left };
  return undefined;
};

const indexedRowPositions = new WeakMap<ReadonlyMap<string, readonly ScopedRow[]>, ReadonlyMap<ScopedRow, number>>();
const maxJoinIndexOverrides = 256;

const materializeRowIndex = (
  base: ReadonlyMap<string, readonly ScopedRow[]>,
  overrides: ReadonlyMap<string, readonly ScopedRow[] | undefined>
): Map<string, readonly ScopedRow[]> => {
  const output = new Map(base);
  for (const [key, value] of overrides) {
    if (value === undefined) output.delete(key);
    else output.set(key, value);
  }
  return output;
};

export class OverlayRowIndex implements ReadonlyMap<string, readonly ScopedRow[]> {
  readonly #base: ReadonlyMap<string, readonly ScopedRow[]>;
  readonly #overrides: ReadonlyMap<string, readonly ScopedRow[] | undefined>;
  readonly compacted: boolean;
  constructor(base: ReadonlyMap<string, readonly ScopedRow[]>, overrides: ReadonlyMap<string, readonly ScopedRow[] | undefined>) {
    if (base instanceof OverlayRowIndex) {
      const combined = new Map([...base.#overrides, ...overrides]);
      if (combined.size >= maxJoinIndexOverrides) {
        this.#base = materializeRowIndex(base.#base, combined);
        this.#overrides = new Map();
        this.compacted = true;
      } else {
        this.#base = base.#base;
        this.#overrides = combined;
        this.compacted = false;
      }
    } else if (overrides.size >= maxJoinIndexOverrides) {
      this.#base = materializeRowIndex(base, overrides);
      this.#overrides = new Map();
      this.compacted = true;
    } else {
      this.#base = base;
      this.#overrides = overrides;
      this.compacted = false;
    }
  }
  get(key: string): readonly ScopedRow[] | undefined { return this.#overrides.has(key) ? this.#overrides.get(key) : this.#base.get(key); }
  has(key: string): boolean { return this.get(key) !== undefined; }
  get size(): number { return this.#materialized().size; }
  entries(): MapIterator<[string, readonly ScopedRow[]]> { return this.#materialized().entries(); }
  keys(): MapIterator<string> { return this.#materialized().keys(); }
  values(): MapIterator<readonly ScopedRow[]> { return this.#materialized().values(); }
  forEach(callbackfn: (value: readonly ScopedRow[], key: string, map: ReadonlyMap<string, readonly ScopedRow[]>) => void, thisArg?: unknown): void {
    this.#materialized().forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[string, readonly ScopedRow[]]> { return this.entries(); }
  #materialized(): Map<string, readonly ScopedRow[]> { return materializeRowIndex(this.#base, this.#overrides); }
}

export type JoinPositionBucket = number | readonly number[];
const materializeJoinPositions = (
  base: ReadonlyMap<string, JoinPositionBucket>,
  overrides: ReadonlyMap<string, JoinPositionBucket | undefined>
): Map<string, JoinPositionBucket> => {
  const output = new Map(base);
  for (const [key, value] of overrides) {
    if (value === undefined) output.delete(key);
    else output.set(key, value);
  }
  return output;
};

export class OverlayJoinPositions implements ReadonlyMap<string, JoinPositionBucket> {
  readonly #base: ReadonlyMap<string, JoinPositionBucket>;
  readonly #overrides: ReadonlyMap<string, JoinPositionBucket | undefined>;
  readonly compacted: boolean;
  constructor(base: ReadonlyMap<string, JoinPositionBucket>, overrides: ReadonlyMap<string, JoinPositionBucket | undefined>) {
    if (base instanceof OverlayJoinPositions) {
      const combined = new Map([...base.#overrides, ...overrides]);
      if (combined.size >= maxJoinIndexOverrides) {
        this.#base = materializeJoinPositions(base.#base, combined);
        this.#overrides = new Map();
        this.compacted = true;
      } else {
        this.#base = base.#base;
        this.#overrides = combined;
        this.compacted = false;
      }
    } else if (overrides.size >= maxJoinIndexOverrides) {
      this.#base = materializeJoinPositions(base, overrides);
      this.#overrides = new Map();
      this.compacted = true;
    } else {
      this.#base = base;
      this.#overrides = overrides;
      this.compacted = false;
    }
  }
  get(key: string): JoinPositionBucket | undefined { return this.#overrides.has(key) ? this.#overrides.get(key) : this.#base.get(key); }
  has(key: string): boolean { return this.get(key) !== undefined; }
  get size(): number { return this.#materialized().size; }
  entries(): MapIterator<[string, JoinPositionBucket]> { return this.#materialized().entries(); }
  keys(): MapIterator<string> { return this.#materialized().keys(); }
  values(): MapIterator<JoinPositionBucket> { return this.#materialized().values(); }
  forEach(callbackfn: (value: JoinPositionBucket, key: string, map: ReadonlyMap<string, JoinPositionBucket>) => void, thisArg?: unknown): void {
    this.#materialized().forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[string, JoinPositionBucket]> { return this.entries(); }
  #materialized(): Map<string, JoinPositionBucket> { return materializeJoinPositions(this.#base, this.#overrides); }
}

const indexedRows = (cacheKey: QueryNode, input: QueryNode, rows: readonly ScopedRow[], expression: Expr, context: QueryContext): ReadonlyMap<string, readonly ScopedRow[]> => {
  const cacheable = context.environment.outer === undefined && !referencesActiveRecursion(input, context);
  const cached = cacheable ? context.state.joinIndexes.get(cacheKey) : undefined;
  if (cached !== undefined) return cached;
  const index = buildIndexedRows(rows, expression, context);
  if (cacheable) context.state.joinIndexes.set(cacheKey, index);
  return index;
};

export const buildIndexedRows = (rows: readonly ScopedRow[], expression: Expr, context: QueryContext): Map<string, ScopedRow[]> => {
  const index = new Map<string, ScopedRow[]>();
  const positions = new Map<ScopedRow, number>();
  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position] as ScopedRow;
    if (!positions.has(row)) positions.set(row, position);
    const key = indexKey(expression, row, context);
    if (key === undefined) continue;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [row]);
    else bucket.push(row);
  }
  indexedRowPositions.set(index, positions);
  return index;
};

const lookupIndexedRows = (index: ReadonlyMap<string, readonly ScopedRow[]>, expression: Expr, row: ScopedRow, context: QueryContext): readonly ScopedRow[] => {
  const key = indexKey(expression, row, context);
  return key === undefined ? [] : index.get(key) ?? [];
};

export const indexKey = (expression: Expr, row: ScopedRow, context: QueryContext): string | undefined => {
  const result = evaluateExpr(expression, exprContext(row, context));
  if (result.status === 'unavailable' || result.status === 'indeterminate') context.state.unavailable = true;
  return result.status === 'known' && result.value !== null ? canonicalizeJson(result.value) : undefined;
};

const referencesActiveRecursion = (node: QueryNode, context: QueryContext): boolean => {
  let dependencies = context.state.recursionDependencies.get(node);
  if (dependencies === undefined) {
    const free = new Set<string>();
    const visit = (value: unknown, bound: ReadonlySet<string>): void => {
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, bound));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const candidate = value as Readonly<Record<string, unknown>>;
      if (candidate.kind === 'recursion-ref') {
        if (typeof candidate.name === 'string' && !bound.has(candidate.name)) free.add(candidate.name);
        return;
      }
      if (candidate.kind !== 'recursive' || typeof candidate.name !== 'string') {
        Object.values(candidate).forEach((child) => visit(child, bound));
        return;
      }
      // A nested recursion can capture an outer binding in its seed. Its own
      // binding shadows an outer recursion with the same name in the step,
      // key, and expression subqueries evaluated while iterating.
      visit(candidate.seed, bound);
      const nested = new Set(bound);
      nested.add(candidate.name);
      Object.entries(candidate).forEach(([key, child]) => {
        if (key !== 'seed') visit(child, nested);
      });
    };
    visit(node, new Set());
    dependencies = free;
    context.state.recursionDependencies.set(node, dependencies);
  }
  for (const name of context.state.recursions.keys()) if (dependencies.has(name)) return true;
  return false;
};

const evaluateAggregate = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'aggregate');
  const groups = new Map<string, { readonly key: QueryRecord; readonly rows: ScopedRow[] }>();
  for (const row of inner.rows) {
    if (!consumeQueryWork(context)) break;
    const key = projectFields(node.groupBy, exprContext(row, context));
    const canonical = canonicalizeQueryValue(key);
    const existing = groups.get(canonical);
    if (existing === undefined) groups.set(canonical, { key, rows: [row] });
    else existing.rows.push(row);
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) groups.set('{}', { key: {}, rows: [] });
  const rows = [...groups.values()].map(({ key, rows: members }): ScopedRow => {
    const output: Record<string, QueryLogicalValue> = { ...key };
    for (const [name, aggregate] of Object.entries(node.measures)) output[name] = aggregateValue(aggregate, members, context);
    return scopedRow({ [node.alias]: output }, { [node.alias]: { relationId: 'aggregate', occurrence: 'aggregate:' + canonicalizeQueryValue(key) } });
  });
  return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
};

export const aggregateValue = (aggregate: AggregateExpr, rows: readonly ScopedRow[], context: QueryContext): QueryLogicalValue => {
  const ordered = aggregate.orderBy === undefined ? rows : sortRowsByOrder(rows, aggregate.orderBy, context);
  const values = aggregate.value === undefined ? ordered.map(() => known(1)) : ordered.map((row) => evaluateExpr(aggregate.value as Expr, exprContext(row, context)));
  if (values.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.state.unavailable = true;
  const knownValues = values.filter((result): result is { readonly status: 'known'; readonly value: JsonValue } => result.status === 'known').map((result) => result.value);
  const nonNullValues = knownValues.filter((value) => value !== null);
  if (aggregate.op === 'count') return nonNullValues.length;
  if (aggregate.op === 'count-distinct') return new Set(nonNullValues.map(canonicalizeJson)).size;
  if (aggregate.op === 'collect') return knownValues;
  if (aggregate.op === 'first') return knownValues[0] ?? null;
  if (aggregate.op === 'last') return knownValues.at(-1) ?? null;
  if (aggregate.op === 'any' || aggregate.op === 'every') {
    const truths = values.map((result): LogicalTruth => result.status === 'known' && typeof result.value === 'boolean' ? result.value : logicalUnknown);
    const truth = aggregate.op === 'any' ? logicalOr(truths) : logicalAnd(truths);
    return truth;
  }
  const numbers = nonNullValues.filter((value): value is number => typeof value === 'number');
  if (aggregate.op === 'sum') return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0);
  if (aggregate.op === 'average') return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (knownValues.length === 0) return null;
  return knownValues.reduce((selected, value) => {
    const comparison = compareQueryJsonValuesTotal(value, selected);
    return aggregate.op === 'minimum' ? (comparison < 0 ? value : selected) : (comparison > 0 ? value : selected);
  });
};

const evaluateSet = (node: Extract<QueryNode, { readonly kind: 'set' }>, context: QueryContext): NodeResult => {
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (left.completeness === 'unknown' || right.completeness === 'unknown') return { rows: [], completeness: 'unknown' };
  if (!consumeQueryWork(context, left.rows.length + right.rows.length)) return { rows: [], completeness: 'unknown' };
  if (node.op === 'except' && right.completeness !== 'exact') return nonMonotoneUnknown(context, node.op);
  if (node.op === 'union-all') return { rows: [...left.rows.map((row) => tagSetRow(row, 'left')), ...right.rows.map((row) => tagSetRow(row, 'right'))], completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  const leftMap = uniqueRows(left.rows);
  const rightMap = uniqueRows(right.rows);
  if (node.op === 'union') return { rows: [...new Map([...leftMap, ...rightMap]).values()], completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  if (node.op === 'intersect') return { rows: [...leftMap].filter(([key]) => rightMap.has(key)).map(([, row]) => row), completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  return { rows: [...leftMap].filter(([key]) => !rightMap.has(key)).map(([, row]) => row), completeness: left.completeness };
};

const evaluateWindow = (node: Extract<QueryNode, { readonly kind: 'window' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'window');
  const output = [...inner.rows];
  const outputFields = new Set(Object.keys(node.fields));
  const layouts = new Map<string, WindowLayout>();
  for (const [field, window] of Object.entries(node.fields)) {
    const reusable = !windowSpecificationReferencesFields(window, node.alias, outputFields);
    const layoutKey = reusable ? windowSpecificationKey(window) : field;
    let layout = reusable ? layouts.get(layoutKey) : undefined;
    if (layout === undefined) {
      layout = buildWindowLayout(output, window, context);
      if (reusable) layouts.set(layoutKey, layout);
    }
    for (const partition of layout) {
      partition.forEach(({ outputIndex, rowNumber, rank }, index) => {
        let value: JsonValue = window.op === 'row-number' ? rowNumber : rank;
        if (window.op === 'lag') {
          const previousIndex = partition[index - (window.offset ?? 1)]?.outputIndex;
          const previous = previousIndex === undefined ? undefined : output[previousIndex];
          const lagged = previous === undefined || window.value === undefined ? undefined : evaluateExpr(window.value, exprContext(previous, context));
          if (lagged?.status === 'unavailable' || lagged?.status === 'indeterminate') context.state.unavailable = true;
          value = lagged === undefined ? null : expressionJson(lagged);
        }
        const row = output[outputIndex] as ScopedRow;
        const aliasFields = requiredAlias(row, node.alias, context);
        if (aliasFields === undefined) return;
        output[outputIndex] = { ...row, scope: { ...row.scope, [node.alias]: { ...aliasFields, [field]: value } } };
      });
    }
  }
  return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows: output, completeness: 'exact' };
};

type WindowLayoutRow = {
  readonly outputIndex: number;
  readonly rowNumber: number;
  readonly rank: number;
};
type WindowLayout = readonly (readonly WindowLayoutRow[])[];
type WindowMaintenancePosition = {
  readonly partitionKey: string;
  readonly orderSignature: string;
  readonly sortedIndex: number;
  readonly outputIndex: number;
};
export type WindowMaintenanceLayout = {
  readonly positions: ReadonlyMap<string, WindowMaintenancePosition>;
  readonly partitions: ReadonlyMap<string, readonly number[]>;
};
export type WindowMaintenanceLayouts = ReadonlyMap<string, WindowMaintenanceLayout>;

const buildWindowLayout = (rows: readonly ScopedRow[], window: WindowExpr, context: QueryContext): WindowLayout => {
  const partitions = new Map<string, { readonly outputIndex: number; readonly orderValues: readonly ExpressionResult[] }[]>();
  for (const [outputIndex, row] of rows.entries()) {
    const partitionValues = (window.partitionBy ?? []).map((expression) => evaluateExpr(expression, exprContext(row, context)));
    const orderValues = window.orderBy.map((term) => evaluateExpr(term.value, exprContext(row, context)));
    if ([...partitionValues, ...orderValues].some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.state.unavailable = true;
    const key = canonicalizeJson(partitionValues.map(expressionJson));
    const partition = partitions.get(key) ?? [];
    partition.push({ outputIndex, orderValues });
    partitions.set(key, partition);
  }
  return [...partitions.values()].map((partition) => {
    partition.sort((left, right) => consumeQueryWork(context) ? compareWindowRows(left, right, rows, window.orderBy) : 0);
    let rank = 1;
    let previousOrder: string | undefined;
    return partition.map(({ outputIndex, orderValues }, index): WindowLayoutRow => {
      const orderKey = canonicalizeJson(orderValues.map(expressionJson));
      if (previousOrder !== undefined && previousOrder !== orderKey) rank = index + 1;
      previousOrder = orderKey;
      return { outputIndex, rowNumber: index + 1, rank };
    });
  });
};

const compareWindowRows = (
  left: { readonly outputIndex: number; readonly orderValues: readonly ExpressionResult[] },
  right: { readonly outputIndex: number; readonly orderValues: readonly ExpressionResult[] },
  rows: readonly ScopedRow[],
  terms: readonly OrderTerm[]
): number => {
  for (let index = 0; index < terms.length; index += 1) {
    const comparison = compareOrderedExpressions(left.orderValues[index] as ExpressionResult, right.orderValues[index] as ExpressionResult, terms[index] as OrderTerm);
    if (comparison !== 0) return comparison;
  }
  return comparePortableStrings(resultKey(rows[left.outputIndex] as ScopedRow), resultKey(rows[right.outputIndex] as ScopedRow));
};

const windowOrderSignature = (values: readonly ExpressionResult[]): string => canonicalizeJson(values.map((value) =>
  value.status === 'missing'
    ? ['missing']
    : value.status === 'known' && value.value !== null
      ? ['known', value.value]
      : ['nullish']
) as JsonValue);

export const evaluateWindowKeys = (window: WindowExpr, row: ScopedRow, context: QueryContext): { readonly partitionKey: string; readonly orderValues: readonly ExpressionResult[]; readonly orderSignature: string } => {
  const partitionValues = (window.partitionBy ?? []).map((expression) => evaluateExpr(expression, exprContext(row, context)));
  const orderValues = window.orderBy.map((term) => evaluateExpr(term.value, exprContext(row, context)));
  if ([...partitionValues, ...orderValues].some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.state.unavailable = true;
  return {
    partitionKey: canonicalizeJson(partitionValues.map(expressionJson)),
    orderValues,
    orderSignature: windowOrderSignature(orderValues)
  };
};

export const indexWindowMaintenanceLayouts = (
  node: Extract<QueryNode, { readonly kind: 'window' }>,
  rows: readonly ScopedRow[],
  context: QueryContext
): WindowMaintenanceLayouts | undefined => {
  const layouts = new Map<string, WindowMaintenanceLayout>();
  for (const window of Object.values(node.fields)) {
    const specification = windowSpecificationKey(window);
    if (layouts.has(specification)) continue;
    const grouped = new Map<string, { readonly outputIndex: number; readonly orderValues: readonly ExpressionResult[]; readonly orderSignature: string }[]>();
    for (const [outputIndex, row] of rows.entries()) {
      const keys = evaluateWindowKeys(window, row, context);
      const partition = grouped.get(keys.partitionKey) ?? [];
      partition.push({ outputIndex, orderValues: keys.orderValues, orderSignature: keys.orderSignature });
      grouped.set(keys.partitionKey, partition);
    }
    if (context.state.unavailable) return undefined;
    const positions = new Map<string, WindowMaintenancePosition>();
    const partitions = new Map<string, readonly number[]>();
    for (const [partitionKey, partition] of grouped) {
      partition.sort((left, right) => compareWindowRows(left, right, rows, window.orderBy));
      const outputIndexes = partition.map(({ outputIndex }) => outputIndex);
      partitions.set(partitionKey, outputIndexes);
      partition.forEach(({ outputIndex, orderSignature }, sortedIndex) => positions.set(resultKey(rows[outputIndex] as ScopedRow), { partitionKey, orderSignature, sortedIndex, outputIndex }));
    }
    layouts.set(specification, { positions, partitions });
  }
  return layouts;
};

export const windowSpecificationKey = (window: WindowExpr): string => canonicalizeJson({
  partitionBy: window.partitionBy ?? [],
  orderBy: window.orderBy
} as unknown as JsonValue);

export const windowSpecificationReferencesFields = (window: WindowExpr, alias: string, fields: ReadonlySet<string>): boolean => {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind === 'field' && candidate.alias === alias && typeof candidate.name === 'string' && fields.has(candidate.name)) return true;
    return Object.values(candidate).some(visit);
  };
  return visit(window.partitionBy ?? []) || visit(window.orderBy);
};

const evaluateSeek = (node: Extract<QueryNode, { readonly kind: 'seek' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'seek');
  if (context.environment.basis === undefined || context.environment.membershipRevision === undefined || canonicalizeJson(context.environment.basis) !== canonicalizeJson(node.after.basis) || context.environment.membershipRevision !== node.after.membershipRevision) {
    context.state.issues.push(createIssue({ code: 'query.cursor_stale', phase: 'query', severity: 'error', retry: 'after_refresh', details: { mode: node.after.mode } }));
    return { rows: [], completeness: 'unknown' };
  }
  const rows = sortRowsByOrder(inner.rows, node.by, context).filter((row) => compareRowToCursor(row, node.by, node.after, context) > 0);
  return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
};

const evaluateRecursive = (node: Extract<QueryNode, { readonly kind: 'recursive' }>, context: QueryContext): NodeResult => {
  if (!isMonotoneRecursiveBody(node.step) || countRecursionReferences(node.step, node.name) !== 1 || countStructuralRecursionReferences(node.step, node.name) !== 1) {
    context.state.issues.push(createIssue({ code: 'query.recursion_non_monotone', phase: 'query', severity: 'error', retry: 'after_input', details: { reason: 'recursion_must_be_linear_and_monotone' } }));
    return { rows: [], completeness: 'unknown' };
  }
  const seed = evaluateNode(node.seed, context);
  if (seed.completeness !== 'exact') return nonMonotoneUnknown(context, 'recursive');
  const maxIterations = node.maxIterations ?? 100;
  const maxRows = node.maxRows ?? 100_000;
  const previous = context.state.recursions.get(node.name);
  const rows: ScopedRow[] = [];
  const keys = new Set<string>();
  const add = (candidate: ScopedRow): ScopedRow | undefined => {
    if (!consumeQueryWork(context)) return undefined;
    const parts = node.key.map((expression) => evaluateExpr(expression, exprContext(candidate, context)));
    if (parts.some((part) => part.status === 'unavailable' || part.status === 'indeterminate')) context.state.unavailable = true;
    if (parts.some((part) => part.status !== 'known')) return undefined;
    const key = canonicalizeJson(parts.map((part) => (part as { readonly status: 'known'; readonly value: JsonValue }).value));
    if (keys.has(key)) return undefined;
    keys.add(key);
    // A recursive row is semantically identified by the declared fixpoint key,
    // not by the complete derivation path that happened to discover it. Keeping
    // the path would append another projection occurrence on every iteration,
    // making identities grow linearly and a simple chain take quadratic work.
    const occurrence = node.name.length + ':' + node.name + key.length + ':' + key;
    const provenance = Object.fromEntries(Object.entries(candidate.provenance).map(([alias, value]) => [alias, { ...value, occurrence }]));
    const normalizedProvenance = Object.keys(provenance).length === 0
      ? { [node.name]: { relationId: 'recursive', occurrence } }
      : provenance;
    const identity = provenanceIdentity(normalizedProvenance);
    const accepted = candidate.identity === identity ? candidate : { ...candidate, provenance: normalizedProvenance, identity, origin: identity };
    rows.push(accepted);
    return accepted;
  };
  try {
    seed.rows.forEach(add);
    if (rows.length > maxRows) return recursionBudgetUnknown(context, 'rows', maxRows);
    let frontier = [...rows];
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (!consumeQueryWork(context)) return { rows: [], completeness: 'unknown' };
      context.state.recursions.set(node.name, frontier);
      const step = evaluateNode(node.step, context);
      if (step.completeness !== 'exact' || context.state.unavailable) return { rows: [], completeness: 'unknown' };
      const next: ScopedRow[] = [];
      for (const candidate of step.rows) {
        const accepted = add(candidate);
        if (accepted !== undefined) next.push(accepted);
        if (rows.length > maxRows) return recursionBudgetUnknown(context, 'rows', maxRows);
      }
      if (next.length === 0) return { rows, completeness: 'exact' };
      frontier = next;
    }
    return recursionBudgetUnknown(context, 'iterations', maxIterations);
  } finally {
    if (previous === undefined) context.state.recursions.delete(node.name);
    else context.state.recursions.set(node.name, previous);
  }
};

const countRecursionReferences = (node: QueryNode, name: string): number => {
  const visit = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum, child) => sum + visit(child), 0);
    if (value === null || typeof value !== 'object') return 0;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind === 'recursion-ref') return candidate.name === name ? 1 : 0;
    if (candidate.kind === 'recursive') return 0;
    return Object.values(candidate).reduce<number>((sum, child) => sum + visit(child), 0);
  };
  return visit(node);
};

const countStructuralRecursionReferences = (node: QueryNode, name: string): number => {
  if (node.kind === 'recursion-ref') return node.name === name ? 1 : 0;
  if (node.kind === 'recursive') return 0;
  return directQueryChildren(node).reduce((sum, child) => sum + countStructuralRecursionReferences(child, name), 0);
};

const recursionBudgetUnknown = (context: QueryContext, budget: 'rows' | 'iterations', limit: number): NodeResult => {
  context.state.issues.push(createIssue({ code: 'query.recursion_budget_exceeded', phase: 'query', severity: 'error', retry: 'after_input', details: { budget, limit } }));
  return { rows: [], completeness: 'unknown' };
};

const isMonotoneRecursiveBody = (node: QueryNode): boolean => {
  if (node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order' || node.kind === 'slice' || node.kind === 'window' || node.kind === 'seek') return false;
  if (node.kind === 'join' && (node.join === 'anti' || node.join === 'left')) return false;
  if (node.kind === 'set' && node.op !== 'union-all' && node.op !== 'union') return false;
  if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest') return isMonotoneRecursiveBody(node.input);
  if (node.kind === 'join' || node.kind === 'set') return isMonotoneRecursiveBody(node.left) && isMonotoneRecursiveBody(node.right);
  if (node.kind === 'recursive') return isMonotoneRecursiveBody(node.seed) && isMonotoneRecursiveBody(node.step);
  return true;
};

const queryAliases = (node: QueryNode): ReadonlySet<string> => {
  if (node.kind === 'from' || node.kind === 'values') return new Set([node.alias]);
  if (node.kind === 'select' || node.kind === 'aggregate') return new Set([node.alias]);
  if (node.kind === 'recursion-ref') return new Set();
  if (node.kind === 'recursive') return queryAliases(node.seed);
  if (node.kind === 'join') return node.join === 'semi' || node.join === 'anti' ? queryAliases(node.left) : new Set([...queryAliases(node.left), ...queryAliases(node.right)]);
  if (node.kind === 'set') return new Set([...queryAliases(node.left), ...queryAliases(node.right)]);
  if (node.kind === 'unnest') return new Set([...queryAliases(node.input), node.alias]);
  return queryAliases(node.input);
};

const queryExpressionRuntime: QueryExpressionRuntime = {
  consumeWork: (state) => consumeQueryWork(state as QueryContext),
  markUnavailable: (state) => { (state as QueryContext).state.unavailable = true; },
  evaluateSubquery: (state, node, outer) => {
    const parent = state as QueryContext;
    const child: QueryContext = {
      environment: { ...parent.environment, outer: outer as ScopedRow },
      state: {
        issues: parent.state.issues,
        recursions: parent.state.recursions,
        recursionConstants: parent.state.recursionConstants,
        recursionDependencies: parent.state.recursionDependencies,
        joinIndexes: parent.state.joinIndexes,
        unavailable: false,
        aggregateCompactionCount: 0
      }
    };
    const result = evaluateNode(node, child);
    return { rows: result.rows.map(visibleRow), completeness: result.completeness, unavailable: child.state.unavailable };
  }
};

export const exprContext = (row: ScopedRow, context: QueryContext): EvalContext => ({
  row,
  parameters: context.environment.parameters,
  functions: context.environment.functions,
  issues: context.state.issues,
  runtime: queryExpressionRuntime,
  runtimeState: context
});

const mapProjection = (inner: NodeResult, alias: string, project: (row: ScopedRow) => QueryRecord, context: QueryContext): NodeResult => {
  const rows = inner.rows.map((row) => {
    const origin = resultKey(row);
    return scopedRow({ [alias]: project(row) }, { [alias]: { relationId: 'select', occurrence: origin + ':select' } }, origin);
  });
  return context.state.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
};

export const visibleRow = (row: ScopedRow): QueryRecord => {
  const aliases = Object.keys(row.scope);
  if (aliases.length === 1) return row.scope[aliases[0] as string] as QueryRecord;
  return row.scope as unknown as QueryRecord;
};

export const requiredAlias = (row: ScopedRow, alias: string, context: QueryContext): QueryRecord | undefined => {
  const record = row.scope[alias];
  if (record !== undefined) return record;
  context.state.unavailable = true;
  if (!context.state.issues.some(({ code, details }) => code === 'query.alias_missing' && (details as { alias?: unknown } | undefined)?.alias === alias)) {
    context.state.issues.push(createIssue({ code: 'query.alias_missing', details: { alias } }));
  }
  return undefined;
};

export const resultKey = (row: ScopedRow): string => row.identity;
const provenanceIdentity = (provenance: ScopedRow['provenance']): string => Object.entries(provenance).sort(([left], [right]) => comparePortableStrings(left, right)).map(([alias, value]) => alias.length + ':' + alias + value.occurrence.length + ':' + value.occurrence).join('');
export const scopedRow = (scope: ScopedRow['scope'], provenance: ScopedRow['provenance'], origin?: string): ScopedRow => ({ scope, provenance, identity: provenanceIdentity(provenance), ...(origin === undefined ? {} : { origin }) });
const renameFields = (record: QueryRecord, fields: Readonly<Record<string, string>>): QueryRecord => Object.fromEntries(Object.entries(record).map(([name, value]) => [fields[name] ?? name, value]));
const omitFields = (record: QueryRecord, fields: ReadonlySet<string>): QueryRecord => Object.fromEntries(Object.entries(record).filter(([name]) => !fields.has(name)));
const uniqueRows = (rows: readonly ScopedRow[]): Map<string, ScopedRow> => new Map(rows.map((row) => [canonicalizeQueryValue(visibleRow(row)), row]));
export const tagSetRow = (row: ScopedRow, branch: 'left' | 'right'): ScopedRow => scopedRow(
  row.scope,
  Object.fromEntries(Object.entries(row.provenance).map(([alias, value]) => [alias, { ...value, occurrence: branch + ':' + value.occurrence }]))
);
export const compareOrder = (left: ScopedRow, right: ScopedRow, terms: readonly OrderTerm[], context: QueryContext): number => {
  for (const term of terms) {
    const leftValue = evaluateExpr(term.value, exprContext(left, context));
    const rightValue = evaluateExpr(term.value, exprContext(right, context));
    if (leftValue.status === 'unavailable' || leftValue.status === 'indeterminate' || rightValue.status === 'unavailable' || rightValue.status === 'indeterminate') context.state.unavailable = true;
    const comparison = compareOrderedExpressions(leftValue, rightValue, term);
    if (comparison !== 0) return comparison;
  }
  return comparePortableStrings(resultKey(left), resultKey(right));
};

const sortRowsByOrder = (rows: readonly ScopedRow[], terms: readonly OrderTerm[], context: QueryContext): ScopedRow[] => {
  if (terms.some(({ value }) => containsSubquery(value) || containsNamedCall(value))) {
    return [...rows].sort((left, right) => compareOrder(left, right, terms, context));
  }
  const decorated = rows.map((row) => ({
    row,
    values: terms.map(({ value }) => evaluateExpr(value, exprContext(row, context)))
  }));
  for (const { values } of decorated) {
    if (values.some(({ status }) => status === 'unavailable' || status === 'indeterminate')) context.state.unavailable = true;
  }
  decorated.sort((left, right) => {
    if (!consumeQueryWork(context)) return 0;
    for (let index = 0; index < terms.length; index += 1) {
      const comparison = compareOrderedExpressions(left.values[index] as ExpressionResult, right.values[index] as ExpressionResult, terms[index] as OrderTerm);
      if (comparison !== 0) return comparison;
    }
    return comparePortableStrings(resultKey(left.row), resultKey(right.row));
  });
  return decorated.map(({ row }) => row);
};

const compareRowToCursor = (row: ScopedRow, terms: readonly OrderTerm[], cursor: QueryCursor, context: QueryContext): number => {
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index] as OrderTerm;
    const rowValue = evaluateExpr(term.value, exprContext(row, context));
    if (rowValue.status === 'unavailable' || rowValue.status === 'indeterminate') context.state.unavailable = true;
    const cursorValue = known(cursor.order[index] ?? null);
    const comparison = compareOrderedExpressions(rowValue, cursorValue, term);
    if (comparison !== 0) return comparison;
  }
  return comparePortableStrings(resultKey(row), cursor.resultKey);
};

const compareOrderedExpressions = (left: ExpressionResult, right: ExpressionResult, term: OrderTerm): number => {
  const leftRank = left.status === 'missing' ? 2 : left.status !== 'known' || left.value === null ? 1 : 0;
  const rightRank = right.status === 'missing' ? 2 : right.status !== 'known' || right.value === null ? 1 : 0;
  if (leftRank !== rightRank) {
    if (leftRank > 0 && rightRank > 0) return leftRank < rightRank ? -1 : 1;
    const specialIsLeft = leftRank > 0;
    return term.nulls === 'first' ? (specialIsLeft ? -1 : 1) : (specialIsLeft ? 1 : -1);
  }
  if (leftRank > 0 || left.status !== 'known' || right.status !== 'known') return 0;
  const comparison = compareQueryJsonValuesTotal(left.value, right.value);
  return term.direction === 'asc' ? comparison : -comparison;
};

const nonMonotoneUnknown = (context: QueryContext, operator: string): NodeResult => {
  context.state.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', details: { reason: 'incomplete_non_monotone', operator } }));
  return { rows: [], completeness: 'unknown' };
};

export const publicQueryRow = (row: ScopedRow, cache: WeakMap<ScopedRow, QueryRecord>): QueryRecord => {
  const cached = cache.get(row);
  if (cached !== undefined) return cached;
  const visible = visibleRow(row);
  // Frozen visible rows originate from the already-adopted maintenance input,
  // prepared values, or a previously owned maintained result. Reuse them
  // instead of cloning the same immutable graph at the output boundary.
  const owned = Object.isFrozen(visible)
    ? visible
    : adoptQueryRecord(visible, 'Query result row');
  cache.set(row, owned);
  return owned;
};

export const publicQueryRows = (rows: readonly ScopedRow[], cache: WeakMap<ScopedRow, QueryRecord>): readonly QueryRecord[] =>
  Object.freeze(rows.map((row) => publicQueryRow(row, cache)));

export const publicQueryIssues = (issues: readonly Issue[]): readonly Issue[] => Object.freeze(issues.map((issue) =>
  adoptJsonValue(issue, 'Query issue') as unknown as Issue
));
