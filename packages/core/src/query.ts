import { canonicalizeJson, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import { capabilityUnavailable, logicalAnd, logicalNot, logicalOr, logicalUnknown, missingValue, type EvaluationValue, type JsonValue, type LogicalTruth, type LogicalUnknown } from './value.js';
import { preparePlan, type PreparedPlan } from './maintenance.js';
import { assertPreparedPlan, hasOwnedPreparedQuery } from './internal-prepared-plan.js';
import { comparePortableStrings } from './portable-order.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import {
  adoptExpressionScope,
  adoptFunctionRegistry,
  adoptJsonRecord,
  adoptJsonValue,
  adoptMaintenanceSnapshot,
  adoptQueryMaintenanceUpdate,
  adoptQueryRecord,
  adoptQueryRequest,
  cloneAndFreezeExpression,
  cloneAndFreezeQueryAst,
  freezePortableValue
} from './internal-query-ownership.js';
import { canonicalizeQueryValue, compareQueryJsonValues, compareQueryJsonValuesTotal, containsQueryLogicalUnknown, queryValueEqual } from './internal-query-values.js';

/** `lower-bound` contains only proven rows; `unknown` withdraws the current row assertion. */
export type Completeness = 'exact' | 'lower-bound' | 'unknown';
export type QueryLogicalValue = null | boolean | number | string | LogicalUnknown | readonly QueryLogicalValue[] | { readonly [key: string]: QueryLogicalValue };
export type QueryRecord = Readonly<Record<string, QueryLogicalValue>>;

export type RelationUse = { readonly schemaView: ArtifactRef; readonly relationId: string };
export type RelationInput = {
  readonly relation: RelationUse;
  readonly rows: readonly QueryRecord[];
  /** Stable base-row occurrence identities within this attachment input. */
  readonly occurrenceIds?: readonly string[];
  readonly completeness: Completeness;
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly basis?: JsonValue;
};

export type QueryFunction = (args: readonly JsonValue[]) => JsonValue;
export type FunctionRegistry = ReadonlyMap<string, QueryFunction>;

export type Expr =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'field'; readonly alias: string; readonly name: string }
  | { readonly kind: 'compare'; readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'boolean'; readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
  | { readonly kind: 'boolean'; readonly op: 'not'; readonly arg: Expr }
  | { readonly kind: 'arithmetic'; readonly op: 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo'; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'string'; readonly op: 'concat'; readonly args: readonly Expr[] }
  | { readonly kind: 'string'; readonly op: 'lower' | 'upper' | 'length'; readonly args: readonly [Expr] }
  | { readonly kind: 'array'; readonly items: readonly Expr[] }
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'case'; readonly branches: readonly { readonly when: Expr; readonly then: Expr }[]; readonly otherwise: Expr }
  | { readonly kind: 'coalesce'; readonly args: readonly Expr[] }
  | { readonly kind: 'call'; readonly capability: CapabilityRef; readonly args: readonly Expr[] }
  | { readonly kind: 'subquery'; readonly mode: 'scalar' | 'exists'; readonly query: QueryNode }
  | { readonly kind: 'is-null'; readonly value: Expr }
  | { readonly kind: 'is-missing'; readonly value: Expr }
  | { readonly kind: 'key-of'; readonly alias: string }
  | { readonly kind: 'source-of'; readonly alias: string };

export type AggregateExpr = {
  readonly kind: 'aggregate';
  readonly op: 'count' | 'count-distinct' | 'sum' | 'average' | 'minimum' | 'maximum' | 'any' | 'every' | 'collect' | 'first' | 'last';
  readonly value?: Expr;
  readonly orderBy?: readonly OrderTerm[];
};

export type OrderTerm = { readonly value: Expr; readonly direction: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' };

export type WindowExpr = {
  readonly kind: 'window';
  readonly op: 'row-number' | 'rank' | 'lag';
  readonly value?: Expr;
  readonly offset?: number;
  readonly partitionBy?: readonly Expr[];
  readonly orderBy: readonly OrderTerm[];
};

/** Portable relational query AST with bag semantics and hidden occurrence identity. Recursive bodies must be monotone with exactly one structural recursion reference. Unmatched left-join fields are missing, never synthesized as null. */
export type QueryNode =
  | { readonly kind: 'from'; readonly relation: RelationUse; readonly alias: string }
  | { readonly kind: 'values'; readonly alias: string; readonly rows: readonly Readonly<Record<string, JsonValue>>[] }
  | { readonly kind: 'where'; readonly input: QueryNode; readonly predicate: Expr }
  | { readonly kind: 'select'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'with-fields'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'rename'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: 'omit'; readonly input: QueryNode; readonly alias: string; readonly fields: readonly string[] }
  | { readonly kind: 'unnest'; readonly input: QueryNode; readonly expression: Expr; readonly alias: string; readonly field: string }
  | { readonly kind: 'join'; readonly join: 'inner' | 'cross' | 'left' | 'semi' | 'anti'; readonly left: QueryNode; readonly right: QueryNode; readonly on?: Expr }
  | { readonly kind: 'aggregate'; readonly input: QueryNode; readonly alias: string; readonly groupBy: Readonly<Record<string, Expr>>; readonly measures: Readonly<Record<string, AggregateExpr>> }
  | { readonly kind: 'distinct'; readonly input: QueryNode }
  | { readonly kind: 'set'; readonly op: 'union' | 'union-all' | 'intersect' | 'except'; readonly left: QueryNode; readonly right: QueryNode }
  | { readonly kind: 'order'; readonly input: QueryNode; readonly by: readonly OrderTerm[] }
  | { readonly kind: 'slice'; readonly input: QueryNode; readonly offset?: number; readonly limit?: number }
  | { readonly kind: 'window'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, WindowExpr>> }
  | { readonly kind: 'seek'; readonly input: QueryNode; readonly by: readonly OrderTerm[]; readonly after: QueryCursor }
  | { readonly kind: 'recursion-ref'; readonly name: string }
  | { readonly kind: 'recursive'; readonly name: string; readonly seed: QueryNode; readonly step: QueryNode; readonly key: readonly Expr[]; readonly maxIterations?: number; readonly maxRows?: number };

/** Basis-bound seek position. Cursors reject basis or dataset-membership drift. */
export type QueryCursor = {
  readonly order: readonly JsonValue[];
  readonly resultKey: string;
  readonly basis: JsonValue;
  readonly membershipRevision: number;
  readonly mode: 'live';
};

export type QueryRequest = {
  readonly root: QueryNode;
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly executionBudget?: QueryExecutionBudget;
};

/**
 * Optional deterministic work limit. One unit is charged for each expression
 * node, visited scan-operator input, join candidate, sort comparison, recursion
 * iteration/admission, and output row produced by an evaluated physical node.
 * The counter resets for each evaluation, update, or pooled attachment.
 * Omission preserves unlimited execution.
 */
export type QueryExecutionBudget = { readonly maxWorkUnits: number };

/** Changing inputs for repeated evaluation of an already prepared query. */
export type PreparedQueryRequest = Omit<QueryRequest, 'root'>;

/** Pure query result. `resultKeys` are stable occurrence identities and grant no write authority. */
export type QueryResult = {
  readonly rows: readonly QueryRecord[];
  readonly resultKeys: readonly string[];
  readonly completeness: Completeness;
  readonly issues: readonly Issue[];
};

/** Initial session state. Every non-empty relation requires unique occurrence IDs. */
export type QueryMaintenanceSnapshot = {
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  /** Fixed for the lifetime of a maintenance session; reset for each update. */
  readonly executionBudget?: QueryExecutionBudget;
};

export type RelationRowChange = {
  /** Source-local stable occurrence identity. */
  readonly occurrenceId: string;
  /** Required proof of the accepted row being replaced or removed. */
  readonly before?: { readonly index: number; readonly row: QueryRecord };
  /** New row and its exact position; omitted for removal. */
  readonly after?: { readonly index: number; readonly row: QueryRecord };
};

export type RelationInputChange = {
  readonly relation: RelationUse;
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly before?: { readonly index: number; readonly completeness: Completeness; readonly basis?: JsonValue };
  readonly after?: { readonly index: number; readonly completeness: Completeness; readonly basis?: JsonValue };
  readonly rows: readonly RelationRowChange[];
};

/** Exact occurrence-keyed change from one accepted maintenance basis to the next. */
export type QueryMaintenanceUpdate = {
  /** Optimistic evidence for the currently accepted dataset/source basis. */
  readonly expectedBasis?: JsonValue;
  /** Evidence attached to the state after applying this update. */
  readonly basis?: JsonValue;
  readonly expectedMembershipRevision?: number;
  readonly membershipRevision?: number;
  readonly relations: readonly RelationInputChange[];
};

export type IncrementalQueryResultDelta = {
  readonly addedResultKeys: readonly string[];
  readonly removedResultKeys: readonly string[];
  readonly updatedResultKeys: readonly string[];
};

/** Observable evidence that the stateful operator graph handled an update incrementally. */
export type IncrementalQueryMaintenanceState = {
  readonly strategy: 'differential-operator-graph';
  readonly revision: number;
  readonly materializedNodeCount: number;
  readonly updatedNodeCount: number;
  readonly changedNodeCount: number;
  readonly changedRelationIds: readonly string[];
  readonly resultDelta: IncrementalQueryResultDelta;
  readonly rejectedUpdateCount: number;
};

export type IncrementalQueryResult = QueryResult & { readonly state: IncrementalQueryMaintenanceState };

export interface IncrementalQueryMaintenanceSession {
  getCurrentResult(): IncrementalQueryResult;
  /** Applies one exact change against the last accepted basis; malformed or stale changes are rejected without mutating accepted state. */
  applyUpdate(update: QueryMaintenanceUpdate): IncrementalQueryResult;
  /** Idempotent; closure requested during an update is applied after that update completes. */
  close(): void;
}

/** Fixed execution environment for one conservative shared physical query DAG. */
export type PooledIncrementalQueryEnvironment = {
  readonly runtimeIdentity: string;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly executionBudget?: QueryExecutionBudget;
};

/** Frozen physical counters for the pooled DAG, independent of any logical root. */
export type PooledIncrementalQueryDiagnostics = {
  readonly strategy: 'pooled-differential-operator-dag';
  readonly runtimeIdentity: string;
  readonly revision: number;
  readonly activeRootCount: number;
  readonly physicalNodeCount: number;
  readonly sharedPhysicalNodeCount: number;
  readonly lastUpdatedPhysicalNodeCount: number;
  readonly lastChangedPhysicalNodeCount: number;
  readonly lastCollectedPhysicalNodeCount: number;
  readonly rejectedUpdateCount: number;
};

export interface PooledIncrementalQueryRoot {
  getCurrentResult(): IncrementalQueryResult;
  /** Idempotent; closure requested during an update is applied after that update completes. */
  close(): void;
}

/**
 * Explicit multi-root runtime. Exact portable subtrees are interned; seek,
 * recursion, and expression-subquery graphs remain isolated in v1.
 */
export interface PooledIncrementalQueryRuntime {
  /** Attaches a root while idle; attachment during an update is rejected. */
  attach(plan: PreparedPlan<QueryNode>): PooledIncrementalQueryRoot;
  /** Applies one update synchronously; recursive application is rejected. */
  applyUpdate(update: QueryMaintenanceUpdate): void;
  getDiagnostics(): PooledIncrementalQueryDiagnostics;
  /** Idempotent; closure requested during an update is applied after that update completes. */
  close(): void;
}

type Provenance = { readonly sourceId?: string; readonly attachmentId?: string; readonly relationId: string; readonly key?: JsonValue; readonly occurrence: string };
type ScopedRow = { readonly scope: Readonly<Record<string, QueryRecord>>; readonly provenance: Readonly<Record<string, Provenance>>; readonly identity: string; readonly origin?: string };
type NodeResult = { readonly rows: readonly ScopedRow[]; readonly completeness: Completeness };
type ExpressionResult = { readonly status: 'known'; readonly value: JsonValue } | { readonly status: 'missing' | 'unknown' | 'indeterminate' | 'unavailable' };
type EvalContext = { readonly row: ScopedRow; readonly parameters: Readonly<Record<string, JsonValue>>; readonly functions: FunctionRegistry; readonly issues: Issue[]; readonly query?: QueryContext };
type QueryContext = {
  readonly relations: ReadonlyMap<string, readonly RelationInput[]>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly functions: FunctionRegistry;
  readonly issues: Issue[];
  readonly recursions: Map<string, readonly ScopedRow[]>;
  readonly recursionConstants: Map<QueryNode, NodeResult>;
  readonly recursionDependencies: Map<QueryNode, ReadonlySet<string>>;
  readonly joinIndexes: Map<QueryNode, ReadonlyMap<string, readonly ScopedRow[]>>;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly outer?: ScopedRow;
  readonly materializedNodes?: ReadonlyMap<QueryNode, MaterializedQueryNode>;
  readonly activeNode?: QueryNode;
  unavailable: boolean;
  readonly work?: QueryWork;
};

type QueryWork = { readonly limit: number; used: number; exhausted: boolean };
const snapshotWork = new WeakMap<QueryMaintenanceSnapshot, QueryWork>();
const resetSnapshotWork = (snapshot: QueryMaintenanceSnapshot): void => {
  if (snapshot.executionBudget === undefined) snapshotWork.delete(snapshot);
  else snapshotWork.set(snapshot, { limit: snapshot.executionBudget.maxWorkUnits, used: 0, exhausted: false });
};
const consumeQueryWork = (context: QueryContext, units = 1): boolean => {
  const work = context.work;
  if (work === undefined) return true;
  if (work.exhausted || work.used + units > work.limit) {
    if (!context.issues.some(({ code }) => code === 'query.execution_budget_exceeded')) context.issues.push(createIssue({ code: 'query.execution_budget_exceeded', phase: 'query', severity: 'error', retry: 'after_input', details: { maxWorkUnits: work.limit } }));
    work.exhausted = true;
    context.unavailable = true;
    return false;
  }
  work.used += units;
  return true;
};

type MaterializedQueryNode = {
  readonly result: NodeResult;
  readonly issues: readonly Issue[];
  readonly unavailable: boolean;
  /** Exact changed output positions when length and order match the prior materialization. */
  readonly stableChangedPositions?: readonly number[];
  readonly from?: {
    readonly inputOffsets: ReadonlyMap<string, number>;
  };
  readonly local?: {
    readonly inputs: readonly ScopedRow[];
    readonly segments: readonly LocalSegment[];
    /** Omitted for one-to-one nodes, where offset=index and width=1. */
    readonly outputOffsets?: readonly number[];
    readonly widths?: readonly number[];
  };
  readonly join?: {
    readonly leftInputs: readonly ScopedRow[];
    readonly rightInputs: readonly ScopedRow[];
    readonly segments: readonly (readonly ScopedRow[])[];
    readonly rightIndex?: ReadonlyMap<string, readonly ScopedRow[]>;
  };
  readonly order?: {
    readonly inputs: readonly ScopedRow[];
  };
  readonly window?: {
    readonly inputs: readonly ScopedRow[];
    readonly partitionKeyByRow: ReadonlyMap<ScopedRow, string>;
    readonly partitions: ReadonlyMap<string, { readonly members: readonly ScopedRow[]; readonly outputs: readonly ScopedRow[] }>;
  };
  readonly aggregate?: {
    readonly inputs: readonly ScopedRow[];
    readonly groupKeys: AggregateRowGroupIndex;
    readonly groups: ReadonlyMap<string, AggregateGroupState>;
  };
};

type AggregateGroupKey = { readonly canonical: string; readonly key: QueryRecord };
type AggregateGroupMember = { readonly position: number; readonly row: ScopedRow };
type AggregateGroupState = { readonly key: QueryRecord; readonly members: readonly AggregateGroupMember[]; readonly output: ScopedRow };
type AggregateRowGroupIndex = {
  readonly parent?: AggregateRowGroupIndex;
  readonly entries: ReadonlyMap<ScopedRow, AggregateGroupKey>;
  readonly depth: number;
};

type LocalSegment = ScopedRow | readonly ScopedRow[] | undefined;

const relationKey = (relation: RelationUse): string => relation.schemaView.id + '\u0000' + relation.schemaView.contentHash + '\u0000' + relation.relationId;
const relationInputKey = (input: RelationInput): string => relationKey(input.relation) + '\u0000' + (input.attachmentId ?? input.sourceId ?? '');
const groupRelationInputs = (inputs: readonly RelationInput[]): ReadonlyMap<string, readonly RelationInput[]> => {
  const grouped = new Map<string, RelationInput[]>();
  for (const input of inputs) {
    const key = relationKey(input.relation);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [input]);
    else group.push(input);
  }
  return grouped;
};
const relationOccurrence = (input: RelationInput, index: number): string => {
  const occurrence = input.occurrenceIds?.[index] ?? relationKey(input.relation) + ':' + index;
  const namespace = input.sourceId ?? input.attachmentId;
  return namespace === undefined ? occurrence : namespace.length + ':' + namespace + occurrence.length + ':' + occurrence;
};
const capabilityKey = (ref: CapabilityRef): string => ref.id + '\u0000' + ref.version + '\u0000' + ref.contractHash;

/** Evaluates the independent, deterministic semantic oracle. */
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
    relations: groupRelationInputs(owned.relations),
    parameters: owned.parameters ?? {},
    functions: owned.functions ?? new Map(),
    issues,
    recursions: new Map(),
    recursionConstants: new Map(),
    recursionDependencies: new Map(),
    joinIndexes: new Map(),
    ...(owned.basis === undefined ? {} : { basis: owned.basis }),
    ...(owned.membershipRevision === undefined ? {} : { membershipRevision: owned.membershipRevision }),
    unavailable: false,
    ...(owned.executionBudget === undefined ? {} : { work: { limit: owned.executionBudget.maxWorkUnits, used: 0, exhausted: false } })
  };
  const result = evaluateNode(root, context);
  if (context.unavailable || result.completeness === 'unknown') return frozenQueryResult([], [], 'unknown', issues);
  const rows = publicQueryRows(result.rows, new WeakMap());
  return frozenQueryResult(rows, result.rows.map(resultKey), result.completeness, issues);
};

const frozenQueryResult = (rows: readonly QueryRecord[], resultKeys: readonly string[], completeness: Completeness, issues: readonly Issue[]): QueryResult => Object.freeze({
  rows: Object.isFrozen(rows) ? rows : Object.freeze([...rows]),
  resultKeys: Object.freeze([...resultKeys]),
  completeness,
  issues: publicQueryIssues(issues)
});

/** Seals query and authority identities into a prepared execution plan. */
export const prepareQuery = async (input: {
  readonly root: QueryNode;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
}): Promise<PreparedPlan<QueryNode>> => {
  return preparePlan({ query: input.root, registryFingerprint: input.registryFingerprint, authorityFingerprint: input.authorityFingerprint, datasetId: input.datasetId });
};

const evaluateNode = (node: QueryNode, context: QueryContext): NodeResult => {
  const materialized = context.outer === undefined && node !== context.activeNode ? context.materializedNodes?.get(node) : undefined;
  if (materialized !== undefined) {
    context.issues.push(...materialized.issues);
    context.unavailable = context.unavailable || materialized.unavailable;
    return materialized.result;
  }
  const cacheable = context.outer === undefined && context.recursions.size > 0 && !referencesActiveRecursion(node, context);
  const cached = cacheable ? context.recursionConstants.get(node) : undefined;
  if (cached !== undefined) return cached;
  const result = evaluateNodeUncached(node, context);
  if (result.completeness !== 'unknown' && !consumeQueryWork(context, result.rows.length)) return { rows: [], completeness: 'unknown' };
  if (cacheable) context.recursionConstants.set(node, result);
  return result;
};

const evaluateNodeUncached = (node: QueryNode, context: QueryContext): NodeResult => {
  if (node.kind === 'from') {
    const inputs = context.relations.get(relationKey(node.relation));
    if (inputs === undefined || inputs.some(({ completeness }) => completeness === 'unknown')) {
      context.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', relationId: node.relation.relationId, details: { reason: 'input_unavailable' } }));
      return { rows: [], completeness: 'unknown' };
    }
    return {
      rows: inputs.flatMap((input) => input.rows.map((fields, index) => scopedRow(
        { ...context.outer?.scope, [node.alias]: fields },
        { ...context.outer?.provenance, [node.alias]: { ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }), ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }), relationId: node.relation.relationId, ...(Object.hasOwn(fields, 'id') ? { key: fields.id as JsonValue } : {}), occurrence: relationOccurrence(input, index) } }
      ))),
      completeness: inputs.some(({ completeness }) => completeness === 'lower-bound') ? 'lower-bound' : 'exact'
    };
  }
  if (node.kind === 'values') return { rows: node.rows.map((fields, index) => scopedRow({ ...context.outer?.scope, [node.alias]: fields }, { ...context.outer?.provenance, [node.alias]: { relationId: 'values', occurrence: 'values:' + index } })), completeness: 'exact' };
  if (node.kind === 'recursion-ref') {
    const rows = context.recursions.get(node.name);
    if (rows !== undefined) return { rows, completeness: 'exact' };
    context.issues.push(createIssue({ code: 'query.recursion_reference_missing', details: { name: node.name } }));
    return { rows: [], completeness: 'unknown' };
  }
  if (node.kind === 'recursive') return evaluateRecursive(node, context);
  if (node.kind === 'where') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness === 'unknown') return inner;
    const rows = inner.rows.filter((row) => {
      if (!consumeQueryWork(context)) return false;
      const result = evaluateExpr(node.predicate, exprContext(row, context));
      if (result.status === 'unavailable' || result.status === 'indeterminate') context.unavailable = true;
      return result.status === 'known' && result.value === true;
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
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
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'rename') {
    const inner = evaluateNode(node.input, context);
    const rows = inner.rows.map((row) => {
      const record = requiredAlias(row, node.alias, context);
      return record === undefined ? row : { ...row, scope: { ...row.scope, [node.alias]: renameFields(record, node.fields) }, origin: resultKey(row) };
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'omit') {
    const inner = evaluateNode(node.input, context);
    const omitted = new Set(node.fields);
    const rows = inner.rows.map((row) => {
      const record = requiredAlias(row, node.alias, context);
      return record === undefined ? row : { ...row, scope: { ...row.scope, [node.alias]: omitFields(record, omitted) }, origin: resultKey(row) };
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'unnest') {
    const inner = evaluateNode(node.input, context);
    const rows: ScopedRow[] = [];
    for (const row of inner.rows) {
      const value = evaluateExpr(node.expression, exprContext(row, context));
      if (value.status === 'unavailable' || value.status === 'indeterminate') context.unavailable = true;
      if (value.status !== 'known' || !Array.isArray(value.value)) continue;
      const origin = resultKey(row);
      value.value.forEach((item, index) => rows.push(scopedRow({ ...row.scope, [node.alias]: { [node.field]: item } }, { ...row.provenance, [node.alias]: { relationId: 'unnest', occurrence: origin + ':' + index } }, origin)));
    }
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
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
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
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
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  }
  const rightIndex = equality === undefined ? undefined : indexedRows(node, node.right, right.rows, equality.right, context);
  for (const leftRow of left.rows) {
    const candidates = rightIndex === undefined || equality === undefined ? right.rows : lookupIndexedRows(rightIndex, equality.left, leftRow, context);
    rows.push(...joinLeftRow(node, leftRow, candidates, rightIndex !== undefined, context));
  }
  if (context.unavailable) return { rows: [], completeness: 'unknown' };
  return { rows, completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
};

const joinLeftRow = (
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
    if (result.status === 'unavailable' || result.status === 'indeterminate') context.unavailable = true;
    if (result.status !== 'known' || result.value !== true) continue;
    matched = true;
    if (node.join === 'inner' || node.join === 'cross' || node.join === 'left') rows.push(combined);
  }
  if (node.join === 'semi' && matched || node.join === 'anti' && !matched) rows.push(leftRow);
  if (node.join === 'left' && !matched) {
    const missingRight = Object.fromEntries([...queryAliases(node.right)].map((alias) => [alias, {}]));
    rows.push({ scope: { ...leftRow.scope, ...missingRight }, provenance: leftRow.provenance, identity: origin, origin });
  }
  return rows;
};

type FieldExpression = Extract<Expr, { readonly kind: 'field' }>;
type EquijoinExpressions = { readonly left: Expr; readonly right: Expr };

const equijoinField = (expression: Expr): FieldExpression | undefined => expression.kind === 'field'
  ? expression
  : expression.kind === 'array' && expression.items.length === 1 && expression.items[0]?.kind === 'field'
    ? expression.items[0]
    : undefined;

const equijoinFields = (node: Extract<QueryNode, { readonly kind: 'join' }>): EquijoinExpressions | undefined => {
  if (node.on?.kind !== 'compare' || node.on.op !== 'eq') return undefined;
  const leftField = equijoinField(node.on.left);
  const rightField = equijoinField(node.on.right);
  if (leftField === undefined || rightField === undefined) return undefined;
  const leftAliases = queryAliases(node.left);
  const rightAliases = queryAliases(node.right);
  if (leftAliases.has(leftField.alias) && rightAliases.has(rightField.alias)) return { left: node.on.left, right: node.on.right };
  if (leftAliases.has(rightField.alias) && rightAliases.has(leftField.alias)) return { left: node.on.right, right: node.on.left };
  return undefined;
};

const materializedEquijoinFields = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  leftRows: readonly ScopedRow[],
  rightRows: readonly ScopedRow[]
): EquijoinExpressions | undefined => {
  if (node.on?.kind !== 'compare' || node.on.op !== 'eq' || leftRows.length === 0 || rightRows.length === 0) return undefined;
  const leftField = equijoinField(node.on.left);
  const rightField = equijoinField(node.on.right);
  if (leftField === undefined || rightField === undefined) return undefined;
  const leftScope = (leftRows[0] as ScopedRow).scope;
  const rightScope = (rightRows[0] as ScopedRow).scope;
  if (Object.hasOwn(leftScope, leftField.alias) && Object.hasOwn(rightScope, rightField.alias)) return { left: node.on.left, right: node.on.right };
  if (Object.hasOwn(leftScope, rightField.alias) && Object.hasOwn(rightScope, leftField.alias)) return { left: node.on.right, right: node.on.left };
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

class OverlayRowIndex implements ReadonlyMap<string, readonly ScopedRow[]> {
  readonly #base: ReadonlyMap<string, readonly ScopedRow[]>;
  readonly #overrides: ReadonlyMap<string, readonly ScopedRow[] | undefined>;
  constructor(base: ReadonlyMap<string, readonly ScopedRow[]>, overrides: ReadonlyMap<string, readonly ScopedRow[] | undefined>) {
    if (base instanceof OverlayRowIndex) {
      const combined = new Map([...base.#overrides, ...overrides]);
      if (combined.size >= maxJoinIndexOverrides) {
        this.#base = materializeRowIndex(base.#base, combined);
        this.#overrides = new Map();
      } else {
        this.#base = base.#base;
        this.#overrides = combined;
      }
    } else if (overrides.size >= maxJoinIndexOverrides) {
      this.#base = materializeRowIndex(base, overrides);
      this.#overrides = new Map();
    } else {
      this.#base = base;
      this.#overrides = overrides;
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

const indexedRows = (cacheKey: QueryNode, input: QueryNode, rows: readonly ScopedRow[], expression: Expr, context: QueryContext): ReadonlyMap<string, readonly ScopedRow[]> => {
  const cacheable = context.outer === undefined && !referencesActiveRecursion(input, context);
  const cached = cacheable ? context.joinIndexes.get(cacheKey) : undefined;
  if (cached !== undefined) return cached;
  const index = buildIndexedRows(rows, expression, context);
  if (cacheable) context.joinIndexes.set(cacheKey, index);
  return index;
};

const buildIndexedRows = (rows: readonly ScopedRow[], expression: Expr, context: QueryContext): Map<string, ScopedRow[]> => {
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

const indexKey = (expression: Expr, row: ScopedRow, context: QueryContext): string | undefined => {
  const result = evaluateExpr(expression, exprContext(row, context));
  if (result.status === 'unavailable' || result.status === 'indeterminate') context.unavailable = true;
  return result.status === 'known' && result.value !== null ? canonicalizeJson(result.value) : undefined;
};

const referencesActiveRecursion = (node: QueryNode, context: QueryContext): boolean => {
  let dependencies = context.recursionDependencies.get(node);
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
    context.recursionDependencies.set(node, dependencies);
  }
  for (const name of context.recursions.keys()) if (dependencies.has(name)) return true;
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
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
};

const aggregateValue = (aggregate: AggregateExpr, rows: readonly ScopedRow[], context: QueryContext): QueryLogicalValue => {
  const ordered = aggregate.orderBy === undefined ? rows : sortRowsByOrder(rows, aggregate.orderBy, context);
  const values = aggregate.value === undefined ? ordered.map(() => known(1)) : ordered.map((row) => evaluateExpr(aggregate.value as Expr, exprContext(row, context)));
  if (values.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.unavailable = true;
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
  if (node.op === 'union-all') return { rows: [...tagSetBranch(left.rows, 'left'), ...tagSetBranch(right.rows, 'right')], completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
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
          if (lagged?.status === 'unavailable' || lagged?.status === 'indeterminate') context.unavailable = true;
          value = lagged === undefined ? null : expressionJson(lagged);
        }
        const row = output[outputIndex] as ScopedRow;
        const aliasFields = requiredAlias(row, node.alias, context);
        if (aliasFields === undefined) return;
        output[outputIndex] = { ...row, scope: { ...row.scope, [node.alias]: { ...aliasFields, [field]: value } } };
      });
    }
  }
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows: output, completeness: 'exact' };
};

type WindowLayoutRow = {
  readonly outputIndex: number;
  readonly rowNumber: number;
  readonly rank: number;
};
type WindowLayout = readonly (readonly WindowLayoutRow[])[];

const buildWindowLayout = (rows: readonly ScopedRow[], window: WindowExpr, context: QueryContext): WindowLayout => {
  const partitions = new Map<string, { readonly outputIndex: number; readonly orderValues: readonly ExpressionResult[] }[]>();
  for (const [outputIndex, row] of rows.entries()) {
    const partitionValues = (window.partitionBy ?? []).map((expression) => evaluateExpr(expression, exprContext(row, context)));
    const orderValues = window.orderBy.map((term) => evaluateExpr(term.value, exprContext(row, context)));
    if ([...partitionValues, ...orderValues].some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.unavailable = true;
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

const windowSpecificationKey = (window: WindowExpr): string => canonicalizeJson({
  partitionBy: window.partitionBy ?? [],
  orderBy: window.orderBy
} as unknown as JsonValue);

const windowSpecificationReferencesFields = (window: WindowExpr, alias: string, fields: ReadonlySet<string>): boolean => {
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
  if (context.basis === undefined || context.membershipRevision === undefined || canonicalizeJson(context.basis) !== canonicalizeJson(node.after.basis) || context.membershipRevision !== node.after.membershipRevision) {
    context.issues.push(createIssue({ code: 'query.cursor_stale', phase: 'query', severity: 'error', retry: 'after_refresh', details: { mode: node.after.mode } }));
    return { rows: [], completeness: 'unknown' };
  }
  const rows = sortRowsByOrder(inner.rows, node.by, context).filter((row) => compareRowToCursor(row, node.by, node.after, context) > 0);
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
};

const evaluateRecursive = (node: Extract<QueryNode, { readonly kind: 'recursive' }>, context: QueryContext): NodeResult => {
  if (!isMonotoneRecursiveBody(node.step) || countRecursionReferences(node.step, node.name) !== 1 || countStructuralRecursionReferences(node.step, node.name) !== 1) {
    context.issues.push(createIssue({ code: 'query.recursion_non_monotone', phase: 'query', severity: 'error', retry: 'after_input', details: { reason: 'recursion_must_be_linear_and_monotone' } }));
    return { rows: [], completeness: 'unknown' };
  }
  const seed = evaluateNode(node.seed, context);
  if (seed.completeness !== 'exact') return nonMonotoneUnknown(context, 'recursive');
  const maxIterations = node.maxIterations ?? 100;
  const maxRows = node.maxRows ?? 100_000;
  const previous = context.recursions.get(node.name);
  const rows: ScopedRow[] = [];
  const keys = new Set<string>();
  const add = (candidate: ScopedRow): ScopedRow | undefined => {
    if (!consumeQueryWork(context)) return undefined;
    const parts = node.key.map((expression) => evaluateExpr(expression, exprContext(candidate, context)));
    if (parts.some((part) => part.status === 'unavailable' || part.status === 'indeterminate')) context.unavailable = true;
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
      context.recursions.set(node.name, frontier);
      const step = evaluateNode(node.step, context);
      if (step.completeness !== 'exact' || context.unavailable) return { rows: [], completeness: 'unknown' };
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
    if (previous === undefined) context.recursions.delete(node.name);
    else context.recursions.set(node.name, previous);
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
  context.issues.push(createIssue({ code: 'query.recursion_budget_exceeded', phase: 'query', severity: 'error', retry: 'after_input', details: { budget, limit } }));
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

/** Evaluates one expression using Tarstate missing/unknown three-valued semantics. */
export const evaluateExpression = (expression: Expr, row: Readonly<Record<string, QueryRecord>>, options: { readonly parameters?: Readonly<Record<string, JsonValue>>; readonly functions?: FunctionRegistry } = {}): EvaluationValue => {
  const issues: Issue[] = [];
  const ownedExpression = cloneAndFreezeExpression(expression);
  const scoped: ScopedRow = { scope: adoptExpressionScope(row), provenance: {}, identity: '' };
  const parameters = options.parameters === undefined ? {} : adoptJsonRecord(options.parameters, 'Query expression parameters');
  const result = evaluateExpr(ownedExpression, { row: scoped, parameters, functions: options.functions === undefined ? new Map() : adoptFunctionRegistry(options.functions), issues });
  if (result.status === 'known') return adoptJsonValue(result.value, 'Query expression result');
  if (result.status === 'missing') return missingValue;
  if (result.status === 'unknown' || result.status === 'indeterminate') return logicalUnknown;
  return capabilityUnavailable;
};

const evaluateExpr = (expression: Expr, context: EvalContext): ExpressionResult => {
  if (context.query !== undefined && !consumeQueryWork(context.query)) return { status: 'unavailable' };
  if (expression.kind === 'literal') return known(expression.value);
  if (expression.kind === 'parameter') return Object.hasOwn(context.parameters, expression.name) ? known(context.parameters[expression.name] as JsonValue) : { status: 'missing' };
  if (expression.kind === 'field') {
    const record = context.row.scope[expression.alias];
    if (record === undefined || !Object.hasOwn(record, expression.name)) return { status: 'missing' };
    const value = record[expression.name] as QueryLogicalValue;
    return value === logicalUnknown ? { status: 'unknown' } : known(value as JsonValue);
  }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') {
    const provenance = context.row.provenance[expression.alias];
    if (provenance === undefined) return { status: 'missing' };
    const value = expression.kind === 'key-of' ? provenance.key : provenance.sourceId;
    return value === undefined ? { status: 'missing' } : known(value);
  }
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') {
    const value = evaluateExpr(expression.value, context);
    if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
    if (expression.kind === 'is-missing') return known(value.status === 'missing');
    if (value.status === 'unknown') return value;
    return known(value.status === 'known' && value.value === null);
  }
  if (expression.kind === 'compare') {
    const left = evaluateExpr(expression.left, context);
    const right = evaluateExpr(expression.right, context);
    const unavailable = propagate(left, right);
    if (unavailable !== undefined) return unavailable;
    if (left.status !== 'known' || right.status !== 'known' || left.value === null || right.value === null) return { status: 'unknown' };
    if (expression.op === 'eq' || expression.op === 'ne') {
      const equal = compareQueryJsonValuesTotal(left.value, right.value) === 0;
      return known(expression.op === 'eq' ? equal : !equal);
    }
    const comparison = compareQueryJsonValues(left.value, right.value);
    if (comparison === undefined) return { status: 'unknown' };
    return known(expression.op === 'lt' ? comparison < 0 : expression.op === 'lte' ? comparison <= 0 : expression.op === 'gt' ? comparison > 0 : comparison >= 0);
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') {
      const value = evaluateExpr(expression.arg, context);
      if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
      const truth = value.status === 'known' && typeof value.value === 'boolean' ? value.value : logicalUnknown;
      const result = logicalNot(truth);
      return result === logicalUnknown ? { status: 'unknown' } : known(result);
    }
    const values = expression.args.map((argument) => evaluateExpr(argument, context));
    if (values.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    const truths = values.map((value): LogicalTruth => value.status === 'known' && typeof value.value === 'boolean' ? value.value : logicalUnknown);
    const result = expression.op === 'and' ? logicalAnd(truths) : logicalOr(truths);
    return result === logicalUnknown ? values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' } : { status: 'unknown' } : known(result);
  }
  if (expression.kind === 'arithmetic') {
    const left = evaluateExpr(expression.left, context);
    const right = evaluateExpr(expression.right, context);
    const propagated = propagate(left, right);
    if (propagated !== undefined) return propagated;
    if (left.status !== 'known' || right.status !== 'known' || typeof left.value !== 'number' || typeof right.value !== 'number') return { status: 'unknown' };
    if ((expression.op === 'divide' || expression.op === 'modulo') && right.value === 0) return { status: 'unknown' };
    const value = expression.op === 'add' ? left.value + right.value : expression.op === 'subtract' ? left.value - right.value : expression.op === 'multiply' ? left.value * right.value : expression.op === 'divide' ? left.value / right.value : left.value % right.value;
    return Number.isFinite(value) ? known(value) : { status: 'unknown' };
  }
  if (expression.kind === 'string') {
    const args = expression.args.map((argument) => evaluateExpr(argument, context));
    if (args.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (args.some((value) => value.status === 'indeterminate')) return { status: 'indeterminate' };
    if (args.some((value) => value.status !== 'known' || typeof value.value !== 'string')) return { status: 'unknown' };
    const strings = args.map((value) => (value as { readonly status: 'known'; readonly value: string }).value);
    if (expression.op === 'concat') return known(strings.join(''));
    const value = strings[0]!;
    return known(expression.op === 'lower' ? value.toLowerCase() : expression.op === 'upper' ? value.toUpperCase() : Array.from(value).length);
  }
  if (expression.kind === 'array') {
    const values = expression.items.map((item) => evaluateExpr(item, context));
    if (values.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (values.some((value) => value.status === 'indeterminate')) return { status: 'indeterminate' };
    if (values.some((value) => value.status !== 'known')) return { status: 'unknown' };
    return known(values.map((value) => (value as { readonly status: 'known'; readonly value: JsonValue }).value));
  }
  if (expression.kind === 'record') {
    const fields = projectFields(expression.fields, context);
    return Object.values(fields).some((value) => containsQueryLogicalUnknown(value)) ? { status: 'unknown' } : known(fields as JsonValue);
  }
  if (expression.kind === 'case') {
    for (const branch of expression.branches) {
      const condition = evaluateExpr(branch.when, context);
      if (condition.status === 'unavailable' || condition.status === 'indeterminate') return condition;
      if (condition.status === 'known' && condition.value === true) return evaluateExpr(branch.then, context);
    }
    return evaluateExpr(expression.otherwise, context);
  }
  if (expression.kind === 'coalesce') {
    for (const argument of expression.args) {
      const value = evaluateExpr(argument, context);
      if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
      if (value.status === 'unknown') return value;
      if (value.status === 'known' && value.value !== null) return value;
    }
    return known(null);
  }
  if (expression.kind === 'subquery') {
    if (context.query === undefined) return { status: 'unavailable' };
    const child: QueryContext = {
      relations: context.query.relations,
      parameters: context.parameters,
      functions: context.functions,
      issues: context.issues,
      recursions: context.query.recursions,
      recursionConstants: context.query.recursionConstants,
      recursionDependencies: context.query.recursionDependencies,
      joinIndexes: context.query.joinIndexes,
      ...(context.query.basis === undefined ? {} : { basis: context.query.basis }),
      ...(context.query.membershipRevision === undefined ? {} : { membershipRevision: context.query.membershipRevision }),
      outer: context.row,
      unavailable: false
    };
    const result = evaluateNode(expression.query, child);
    if (child.unavailable) { context.query.unavailable = true; return { status: 'unavailable' }; }
    if (result.completeness === 'unknown') return { status: 'indeterminate' };
    if (expression.mode === 'exists') return result.rows.length > 0 ? known(true) : result.completeness === 'exact' ? known(false) : { status: 'indeterminate' };
    if (result.completeness !== 'exact') return { status: 'indeterminate' };
    if (result.rows.length !== 1) {
      context.issues.push(createIssue({ code: 'query.scalar_subquery_cardinality', phase: 'query', severity: 'error', retry: 'after_input', details: { rows: result.rows.length } }));
      return { status: 'unknown' };
    }
    const record = visibleRow(result.rows[0] as ScopedRow);
    const values = Object.values(record);
    if (values.length !== 1) {
      context.issues.push(createIssue({ code: 'query.scalar_subquery_cardinality', phase: 'query', severity: 'error', retry: 'after_input', details: { fields: values.length } }));
      return { status: 'unknown' };
    }
    return values[0] === logicalUnknown ? { status: 'unknown' } : known(values[0] as JsonValue);
  }
  if (expression.kind === 'call') {
    const fn = context.functions.get(capabilityKey(expression.capability));
    if (fn === undefined) {
      context.issues.push(createIssue({ code: 'query.capability_unavailable', retry: 'after_capability', requiredCapabilities: [expression.capability] }));
      return { status: 'unavailable' };
    }
    const args = expression.args.map((argument) => evaluateExpr(argument, context));
    if (args.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (args.some((value) => value.status !== 'known')) return { status: 'unknown' };
    try {
      const ownedArgs = Object.freeze(args.map((value) => freezePortableValue(
        (value as { readonly status: 'known'; readonly value: JsonValue }).value
      )));
      const returned = fn(ownedArgs);
      const parsed = detachAndFreezeJsonValue(returned);
      if (!parsed.success) throw new TypeError('Query function returned a non-portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
      return known(parsed.value);
    } catch (error) {
      context.issues.push(createIssue({ code: 'query.function_failed', phase: 'query', severity: 'error', retry: 'after_input', requiredCapabilities: [expression.capability], details: { error: error instanceof Error ? error.name : typeof error } }));
      return { status: 'unavailable' };
    }
  }
  return assertNever(expression);
};

const exprContext = (row: ScopedRow, context: QueryContext): EvalContext => ({ row, parameters: context.parameters, functions: context.functions, issues: context.issues, query: context });
const known = (value: JsonValue): ExpressionResult => ({ status: 'known', value });
const propagate = (...values: readonly ExpressionResult[]): ExpressionResult | undefined => values.some((value) => value.status === 'unavailable') ? { status: 'unavailable' } : values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' } : values.some((value) => value.status === 'unknown') ? { status: 'unknown' } : undefined;
const expressionJson = (result: ExpressionResult): JsonValue => result.status === 'known' ? result.value : null;
const assertNever = (value: never): never => { throw new TypeError('Unsupported query expression: ' + String(value)); };

const projectFields = (fields: Readonly<Record<string, Expr>>, context: EvalContext): QueryRecord => {
  const output: Record<string, QueryLogicalValue> = {};
  for (const [name, expression] of Object.entries(fields)) {
    const result = evaluateExpr(expression, context);
    if (result.status === 'known') output[name] = result.value;
    else if (result.status === 'unknown') output[name] = logicalUnknown;
    else if ((result.status === 'unavailable' || result.status === 'indeterminate') && context.query !== undefined) context.query.unavailable = true;
  }
  return output;
};

const mapProjection = (inner: NodeResult, alias: string, project: (row: ScopedRow) => QueryRecord, context: QueryContext): NodeResult => {
  const rows = inner.rows.map((row) => {
    const origin = resultKey(row);
    return scopedRow({ [alias]: project(row) }, { [alias]: { relationId: 'select', occurrence: origin + ':select' } }, origin);
  });
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
};

const visibleRow = (row: ScopedRow): QueryRecord => {
  const aliases = Object.keys(row.scope);
  if (aliases.length === 1) return row.scope[aliases[0] as string] as QueryRecord;
  return row.scope as unknown as QueryRecord;
};

const requiredAlias = (row: ScopedRow, alias: string, context: QueryContext): QueryRecord | undefined => {
  const record = row.scope[alias];
  if (record !== undefined) return record;
  context.unavailable = true;
  if (!context.issues.some(({ code, details }) => code === 'query.alias_missing' && (details as { alias?: unknown } | undefined)?.alias === alias)) {
    context.issues.push(createIssue({ code: 'query.alias_missing', details: { alias } }));
  }
  return undefined;
};

const resultKey = (row: ScopedRow): string => row.identity;
const provenanceIdentity = (provenance: ScopedRow['provenance']): string => Object.entries(provenance).sort(([left], [right]) => comparePortableStrings(left, right)).map(([alias, value]) => alias.length + ':' + alias + value.occurrence.length + ':' + value.occurrence).join('');
const scopedRow = (scope: ScopedRow['scope'], provenance: ScopedRow['provenance'], origin?: string): ScopedRow => ({ scope, provenance, identity: provenanceIdentity(provenance), ...(origin === undefined ? {} : { origin }) });
const renameFields = (record: QueryRecord, fields: Readonly<Record<string, string>>): QueryRecord => Object.fromEntries(Object.entries(record).map(([name, value]) => [fields[name] ?? name, value]));
const omitFields = (record: QueryRecord, fields: ReadonlySet<string>): QueryRecord => Object.fromEntries(Object.entries(record).filter(([name]) => !fields.has(name)));
const uniqueRows = (rows: readonly ScopedRow[]): Map<string, ScopedRow> => new Map(rows.map((row) => [canonicalizeQueryValue(visibleRow(row)), row]));
const tagSetBranch = (rows: readonly ScopedRow[], branch: 'left' | 'right'): readonly ScopedRow[] => rows.map((row) => scopedRow(
  row.scope,
  Object.fromEntries(Object.entries(row.provenance).map(([alias, value]) => [alias, { ...value, occurrence: branch + ':' + value.occurrence }]))
));
const compareOrder = (left: ScopedRow, right: ScopedRow, terms: readonly OrderTerm[], context: QueryContext): number => {
  for (const term of terms) {
    const leftValue = evaluateExpr(term.value, exprContext(left, context));
    const rightValue = evaluateExpr(term.value, exprContext(right, context));
    if (leftValue.status === 'unavailable' || leftValue.status === 'indeterminate' || rightValue.status === 'unavailable' || rightValue.status === 'indeterminate') context.unavailable = true;
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
    if (values.some(({ status }) => status === 'unavailable' || status === 'indeterminate')) context.unavailable = true;
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
    if (rowValue.status === 'unavailable' || rowValue.status === 'indeterminate') context.unavailable = true;
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
  context.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', details: { reason: 'incomplete_non_monotone', operator } }));
  return { rows: [], completeness: 'unknown' };
};

/** Pure shell adapter from two snapshots to the exact update consumed by maintenance. */
export const diffQueryMaintenanceSnapshots = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): QueryMaintenanceUpdate => {
  if (!sameOptionalJson(previous.parameters, next.parameters) || !sameFunctionRegistry(previous.functions, next.functions) || !sameExecutionBudget(previous.executionBudget, next.executionBudget)) {
    throw new TypeError('Query maintenance parameters, functions, and execution budget are fixed for the session');
  }
  const previousInputs = indexedRelationInputs(previous.relations);
  const nextInputs = indexedRelationInputs(next.relations);
  const identities = [...new Set([...previousInputs.keys(), ...nextInputs.keys()])].sort(comparePortableStrings);
  const relations: RelationInputChange[] = [];
  for (const identity of identities) {
    const before = previousInputs.get(identity);
    const after = nextInputs.get(identity);
    const rows = diffRelationRows(before?.input, after?.input);
    if (before !== undefined && after !== undefined && before.index === after.index && before.input.completeness === after.input.completeness && sameOptionalJson(before.input.basis, after.input.basis) && rows.length === 0) continue;
    const input = after?.input ?? before?.input;
    if (input === undefined) continue;
    relations.push({
      relation: input.relation,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
      ...(before === undefined ? {} : { before: relationChangeState(before) }),
      ...(after === undefined ? {} : { after: relationChangeState(after) }),
      rows
    });
  }
  return {
    ...(previous.basis === undefined ? {} : { expectedBasis: previous.basis }),
    ...(next.basis === undefined ? {} : { basis: next.basis }),
    ...(previous.membershipRevision === undefined ? {} : { expectedMembershipRevision: previous.membershipRevision }),
    ...(next.membershipRevision === undefined ? {} : { membershipRevision: next.membershipRevision }),
    relations
  };
};

const diffRelationRows = (before: RelationInput | undefined, after: RelationInput | undefined): readonly RelationRowChange[] => {
  const beforeIds = before?.occurrenceIds ?? [];
  const afterIds = after?.occurrenceIds ?? [];
  if ((before?.rows.length ?? 0) !== beforeIds.length || (after?.rows.length ?? 0) !== afterIds.length) throw new TypeError('Relation changes require complete occurrence IDs');
  if (beforeIds.length === afterIds.length && beforeIds.every((occurrenceId, index) => occurrenceId === afterIds[index])) {
    return beforeIds.flatMap((occurrenceId, index) => {
      const previousRow = before?.rows[index] as QueryRecord;
      const nextRow = after?.rows[index] as QueryRecord;
      return previousRow === nextRow || queryValueEqual(previousRow, nextRow) ? [] : [{ occurrenceId, before: { index, row: previousRow }, after: { index, row: nextRow } }];
    });
  }
  const beforeRows = before === undefined ? new Map<string, { readonly index: number; readonly row: QueryRecord }>() : indexedRelationRows(before);
  const afterRows = after === undefined ? new Map<string, { readonly index: number; readonly row: QueryRecord }>() : indexedRelationRows(after);
  const changes: RelationRowChange[] = [];
  for (const occurrenceId of [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort(comparePortableStrings)) {
    const previousRow = beforeRows.get(occurrenceId);
    const nextRow = afterRows.get(occurrenceId);
    if (previousRow !== undefined && nextRow !== undefined && previousRow.index === nextRow.index && (previousRow.row === nextRow.row || queryValueEqual(previousRow.row, nextRow.row))) continue;
    changes.push({ occurrenceId, ...(previousRow === undefined ? {} : { before: previousRow }), ...(nextRow === undefined ? {} : { after: nextRow }) });
  }
  return changes;
};

const relationChangeState = ({ input, index }: IndexedRelationInput): NonNullable<RelationInputChange['before']> => ({
  index,
  completeness: input.completeness,
  ...(input.basis === undefined ? {} : { basis: input.basis })
});

type IndexedRelationInput = { readonly input: RelationInput; readonly index: number };

const indexedRelationInputs = (relations: readonly RelationInput[]): ReadonlyMap<string, IndexedRelationInput> => {
  const output = new Map<string, IndexedRelationInput>();
  relations.forEach((input, index) => {
    const identity = relationInputKey(input);
    if (output.has(identity)) throw new TypeError('Duplicate relation input identity: ' + input.relation.relationId);
    output.set(identity, { input, index });
  });
  return output;
};

const indexedRelationRows = (input: RelationInput): ReadonlyMap<string, { readonly index: number; readonly row: QueryRecord }> => {
  if (input.rows.length > 0 && input.occurrenceIds === undefined) throw new TypeError('Relation changes require occurrence IDs: ' + input.relation.relationId);
  const output = new Map<string, { readonly index: number; readonly row: QueryRecord }>();
  input.rows.forEach((row, index) => {
    const occurrenceId = input.occurrenceIds?.[index];
    if (occurrenceId === undefined || output.has(occurrenceId)) throw new TypeError('Invalid occurrence identity: ' + input.relation.relationId);
    output.set(occurrenceId, { index, row });
  });
  return output;
};

/**
 * Opens the production stateful query-maintenance path. The pure
 * `evaluateQuery` function remains an independent semantic oracle; updates here
 * rematerialize only query nodes whose relation dependencies changed.
 */
export const openIncrementalQueryMaintenance = (
  plan: PreparedPlan<QueryNode>,
  initialSnapshot: QueryMaintenanceSnapshot
): IncrementalQueryMaintenanceSession => {
  assertPreparedPlan(plan);
  const queryRoot = hasOwnedPreparedQuery(plan) ? plan.query : cloneAndFreezeQueryAst(plan.query);
  const graph = compileQueryGraph(queryRoot);
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  const ownedInitialSnapshot = adoptMaintenanceSnapshot(initialSnapshot);
  resetSnapshotWork(ownedInitialSnapshot);
  let acceptedSnapshot = ownedInitialSnapshot;
  let closed = false;
  let revision = 0;
  let rejectedUpdateCount = 0;
  let valueIdentities = new WeakMap<ScopedRow, string>();
  const publicRows = new WeakMap<ScopedRow, QueryRecord>();
  let executionPhase: 'idle' | 'updating' = 'idle';
  let closeRequested = false;

  const initialIssues = validateMaintenanceSnapshot(ownedInitialSnapshot);
  if (initialIssues.length === 0) {
    for (const node of graph.nodes) materialized.set(node, materializeQueryNode(node, ownedInitialSnapshot, materialized));
  }
  let current = maintainedQueryResult(
    initialIssues.length === 0 ? materialized.get(queryRoot) : undefined,
    initialIssues,
    maintenanceState(graph.nodes.length, graph.nodes.length, graph.nodes.length, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
    publicRows
  );
  let assertedRoot = initialIssues.length === 0 ? materialized.get(queryRoot) : undefined;

  const closeNow = (): void => {
    if (closed) return;
    closed = true;
    materialized.clear();
  };

  return {
    getCurrentResult: () => current,
    applyUpdate: (update) => {
      if (closed) throw new Error('Incremental query maintenance session is closed');
      if (executionPhase === 'updating') throw new Error('Recursive incremental query updates are not supported');
      const checkpoint = { acceptedSnapshot, revision, rejectedUpdateCount, current, assertedRoot };
      const journal = new Map<QueryNode, MaterializedQueryNode | undefined>();
      executionPhase = 'updating';
      try {
        const ownedUpdate = adoptQueryMaintenanceUpdate(update);
        revision += 1;
        const applied = applyQueryMaintenanceUpdate(acceptedSnapshot, ownedUpdate);
        if (!applied.success) {
          rejectedUpdateCount += 1;
          current = maintainedQueryResult(
            undefined,
            applied.issues,
            maintenanceState(graph.nodes.length, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
            publicRows
          );
          assertedRoot = undefined;
          return current;
        }

        const nextSnapshot = applied.value;
        resetSnapshotWork(nextSnapshot);
        const changedRelations = new Set(ownedUpdate.relations.map(({ relation }) => relationKey(relation)));
        const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
          || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
        let updatedNodeCount = 0;
        const changedNodes = new Set<QueryNode>();
        for (const node of graph.nodes) {
          const children = graph.children.get(node) as readonly QueryNode[];
          const externalDependencies = graph.externalDependencies.get(node) as ReadonlySet<string>;
          const childChanged = children.some((child) => changedNodes.has(child));
          const externalInputChanged = [...externalDependencies].some((key) => changedRelations.has(key));
          const evidenceInputChanged = sessionEvidenceChanged && graph.sessionEvidenceDependencies.get(node) === true;
          if (!evidenceInputChanged && !childChanged && !externalInputChanged) continue;
          const previousNode = materialized.get(node);
          let nextNode = node.kind === 'from'
            ? incrementallyMaterializeFrom(node, nextSnapshot, update, previousNode)
            : node.kind === 'join'
              ? incrementallyMaterializeJoin(node, nextSnapshot, materialized, previousNode)
            : node.kind === 'order'
              ? incrementallyMaterializeOrder(node, nextSnapshot, materialized, previousNode)
            : node.kind === 'window'
              ? incrementallyMaterializeWindow(node, nextSnapshot, materialized, previousNode)
            : node.kind === 'aggregate'
              ? incrementallyMaterializeAggregate(node, nextSnapshot, materialized, previousNode)
            : isLocallyMaintainedNode(node)
              ? incrementallyMaterializeLocal(node, nextSnapshot, materialized, previousNode)
              : materializeQueryNode(node, nextSnapshot, materialized);
          nextNode = chargeIncrementalOutput(node, nextSnapshot, materialized, nextNode);
          journal.set(node, previousNode);
          materialized.set(node, nextNode);
          updatedNodeCount += 1;
          if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode, valueIdentities)) changedNodes.add(node);
        }
        acceptedSnapshot = nextSnapshot;
        const root = materialized.get(queryRoot);
        current = maintainedQueryResult(
          root,
          [],
          maintenanceState(
            graph.nodes.length,
            updatedNodeCount,
            changedNodes.size,
            changedRelationIds(nextSnapshot, changedRelations),
            diffMaintainedResults(assertedRoot, root, valueIdentities),
            revision,
            rejectedUpdateCount
          ),
          publicRows,
          current
        );
        assertedRoot = root;
        return current;
      } catch (error) {
        acceptedSnapshot = checkpoint.acceptedSnapshot;
        revision = checkpoint.revision;
        rejectedUpdateCount = checkpoint.rejectedUpdateCount;
        current = checkpoint.current;
        assertedRoot = checkpoint.assertedRoot;
        for (const [node, previous] of journal) {
          if (previous === undefined) materialized.delete(node);
          else materialized.set(node, previous);
        }
        valueIdentities = new WeakMap();
        throw error;
      } finally {
        executionPhase = 'idle';
        if (closeRequested) closeNow();
      }
    },
    close: () => {
      if (closed) return;
      if (executionPhase !== 'idle') {
        closeRequested = true;
        return;
      }
      closeNow();
    }
  };
};

type PooledPhysicalNode = {
  readonly key: string;
  readonly children: readonly QueryNode[];
  readonly parents: Set<QueryNode>;
  readonly externalDependencies: ReadonlySet<string>;
  readonly sessionEvidenceDependency: boolean;
  orderIndex: number;
  readonly owners: Set<PooledRootState>;
};

type InternedPooledNode = {
  readonly id: number;
  readonly key: string;
  readonly node: QueryNode;
};

type PooledRootState = {
  readonly root: QueryNode;
  readonly reachable: ReadonlySet<QueryNode>;
  current: IncrementalQueryResult;
  asserted: MaterializedQueryNode | undefined;
  closed: boolean;
};

type PooledUpdateJournal = {
  readonly materialized: Map<QueryNode, MaterializedQueryNode | undefined>;
  readonly roots: Map<PooledRootState, { readonly current: IncrementalQueryResult; readonly asserted: MaterializedQueryNode | undefined }>;
};

/** Creates an explicitly scoped multi-root physical runtime. */
export const createPooledIncrementalQueryRuntime = (input: {
  readonly environment: PooledIncrementalQueryEnvironment;
  readonly initialSnapshot: QueryMaintenanceSnapshot;
}): PooledIncrementalQueryRuntime => {
  const environment = Object.freeze({
    ...input.environment,
    ...(input.environment.parameters === undefined ? {} : { parameters: adoptJsonRecord(input.environment.parameters, 'Pooled query parameters') }),
    ...(input.environment.functions === undefined ? {} : { functions: adoptFunctionRegistry(input.environment.functions) }),
    ...(input.environment.executionBudget === undefined ? {} : { executionBudget: adoptMaintenanceSnapshot({ relations: [], executionBudget: input.environment.executionBudget }).executionBudget })
  });
  const ownedInitialSnapshot = adoptMaintenanceSnapshot(input.initialSnapshot);
  resetSnapshotWork(ownedInitialSnapshot);
  if (!sameOptionalJson(environment.parameters, ownedInitialSnapshot.parameters)) {
    throw new TypeError('Pooled query environment parameters do not match the initial snapshot');
  }
  if (!sameFunctionRegistry(environment.functions, ownedInitialSnapshot.functions)) {
    throw new TypeError('Pooled query environment functions do not match the initial snapshot');
  }
  if (!sameExecutionBudget(environment.executionBudget, ownedInitialSnapshot.executionBudget)) throw new TypeError('Pooled query environment execution budget does not match the initial snapshot');

  const interned = new Map<string, InternedPooledNode>();
  const internedByNode = new Map<QueryNode, InternedPooledNode>();
  let nextInternedNodeId = 0;
  const physical = new Map<QueryNode, PooledPhysicalNode>();
  let physicalOrder: (QueryNode | undefined)[] = [];
  let physicalOrderTombstones = 0;
  const relationConsumers = new Map<string, Set<QueryNode>>();
  const evidenceConsumers = new Set<QueryNode>();
  const unmaterializedNodes = new Set<QueryNode>();
  let sharedPhysicalNodeCount = 0;
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  const roots = new Set<PooledRootState>();
  let valueIdentities = new WeakMap<ScopedRow, string>();
  const publicRows = new WeakMap<ScopedRow, QueryRecord>();
  let acceptedSnapshot = ownedInitialSnapshot;
  let runtimeIssues = validateMaintenanceSnapshot(ownedInitialSnapshot);
  let revision = 0;
  let rejectedUpdateCount = 0;
  let closed = false;
  let executionPhase: 'idle' | 'attaching' | 'updating' = 'idle';
  let closeRequested = false;
  const deferredReleases = new Set<PooledRootState>();
  let diagnostics = pooledDiagnostics(environment.runtimeIdentity, 0, 0, 0, 0, 0, 0, 0, 0);

  const refreshDiagnostics = (updated: number, changed: number, collected: number): void => {
    diagnostics = pooledDiagnostics(
      environment.runtimeIdentity,
      revision,
      roots.size,
      physical.size,
      sharedPhysicalNodeCount,
      updated,
      changed,
      collected,
      rejectedUpdateCount
    );
  };

  const compactPhysicalOrderIfNeeded = (): void => {
    if (physicalOrderTombstones < 64 || physicalOrderTombstones * 3 < physicalOrder.length) return;
    const compacted: QueryNode[] = [];
    for (const node of physicalOrder) {
      if (node === undefined || !physical.has(node)) continue;
      (physical.get(node) as PooledPhysicalNode).orderIndex = compacted.length;
      compacted.push(node);
    }
    physicalOrder = compacted;
    physicalOrderTombstones = 0;
  };

  const removePhysicalNode = (node: QueryNode, record: PooledPhysicalNode): void => {
    physical.delete(node);
    materialized.delete(node);
    unmaterializedNodes.delete(node);
    for (const child of record.children) physical.get(child)?.parents.delete(node);
    for (const dependency of record.externalDependencies) {
      const consumers = relationConsumers.get(dependency);
      consumers?.delete(node);
      if (consumers?.size === 0) relationConsumers.delete(dependency);
    }
    if (record.sessionEvidenceDependency) evidenceConsumers.delete(node);
    if (interned.get(record.key)?.node === node) interned.delete(record.key);
    internedByNode.delete(node);
    if (physicalOrder[record.orderIndex] === node) {
      physicalOrder[record.orderIndex] = undefined;
      physicalOrderTombstones += 1;
    }
  };

  const releaseNow = (root: PooledRootState): void => {
    if (root.closed) return;
    root.closed = true;
    roots.delete(root);
    let collected = 0;
    for (const node of [...root.reachable].reverse()) {
      const record = physical.get(node);
      if (record === undefined) continue;
      const ownerCount = record.owners.size;
      if (!record.owners.delete(root)) continue;
      if (ownerCount === 2) sharedPhysicalNodeCount -= 1;
      if (record.owners.size !== 0) continue;
      removePhysicalNode(node, record);
      collected += 1;
    }
    if (!closed) compactPhysicalOrderIfNeeded();
    refreshDiagnostics(0, 0, collected);
  };

  const release = (root: PooledRootState): void => {
    if (root.closed || deferredReleases.has(root)) return;
    if (executionPhase !== 'idle') {
      deferredReleases.add(root);
      return;
    }
    releaseNow(root);
  };

  const closeNow = (): void => {
    if (closed) return;
    closed = true;
    const collected = physical.size;
    for (const root of Array.from(roots)) releaseNow(root);
    deferredReleases.clear();
    interned.clear();
    internedByNode.clear();
    physical.clear();
    physicalOrder = [];
    physicalOrderTombstones = 0;
    relationConsumers.clear();
    evidenceConsumers.clear();
    unmaterializedNodes.clear();
    sharedPhysicalNodeCount = 0;
    materialized.clear();
    refreshDiagnostics(0, 0, collected);
  };

  const flushDeferredLifecycle = (): void => {
    if (closeRequested) {
      closeNow();
      return;
    }
    for (const root of Array.from(deferredReleases)) releaseNow(root);
    deferredReleases.clear();
  };

  const attachNow = (plan: PreparedPlan<QueryNode>): PooledIncrementalQueryRoot => {
    assertPreparedPlan(plan);
    resetSnapshotWork(acceptedSnapshot);
    if (plan.registryFingerprint !== environment.registryFingerprint) throw new TypeError('Prepared plan registry fingerprint does not match pooled query environment');
    if (plan.authorityFingerprint !== environment.authorityFingerprint) throw new TypeError('Prepared plan authority fingerprint does not match pooled query environment');
    if (plan.datasetId !== environment.datasetId) throw new TypeError('Prepared plan dataset does not match pooled query environment');
    assertPoolableQuery(plan.query);
    const detachedRoot = hasOwnedPreparedQuery(plan) ? plan.query : cloneAndFreezeQueryAst(plan.query);
    const createdInterned: InternedPooledNode[] = [];
    const stagedMaterialized: QueryNode[] = [];
    let state: PooledRootState | undefined;
    try {
      const canonicalRoot = internPooledQueryNode(detachedRoot, interned, internedByNode, createdInterned, () => nextInternedNodeId += 1);
      const graph = compileQueryGraph(canonicalRoot);
      const reachable = new Set(graph.nodes);
      const newNodes = graph.nodes.filter((node) => !physical.has(node));
      if (runtimeIssues.length === 0) {
        for (const node of newNodes) {
          materialized.set(node, materializeQueryNode(node, acceptedSnapshot, materialized));
          stagedMaterialized.push(node);
        }
      }
      const rootMaterialized = runtimeIssues.length === 0 ? materialized.get(canonicalRoot) : undefined;
      state = {
        root: canonicalRoot,
        reachable,
        current: maintainedQueryResult(
          rootMaterialized,
          runtimeIssues,
          maintenanceState(reachable.size, reachable.size, reachable.size, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
          publicRows
        ),
        asserted: rootMaterialized,
        closed: false
      };
      for (const node of graph.nodes) {
        const existing = physical.get(node);
        if (existing !== undefined) {
          if (existing.owners.size === 1) sharedPhysicalNodeCount += 1;
          existing.owners.add(state);
          continue;
        }
        const identity = internedByNode.get(node) as InternedPooledNode;
        const orderIndex = physicalOrder.length;
        physical.set(node, {
          key: identity.key,
          children: graph.children.get(node) as readonly QueryNode[],
          parents: new Set(),
          externalDependencies: graph.externalDependencies.get(node) as ReadonlySet<string>,
          sessionEvidenceDependency: graph.sessionEvidenceDependencies.get(node) === true,
          orderIndex,
          owners: new Set([state])
        });
        physicalOrder.push(node);
        if (!materialized.has(node)) unmaterializedNodes.add(node);
        for (const dependency of graph.externalDependencies.get(node) as ReadonlySet<string>) {
          let consumers = relationConsumers.get(dependency);
          if (consumers === undefined) {
            consumers = new Set();
            relationConsumers.set(dependency, consumers);
          }
          consumers.add(node);
        }
        if (graph.sessionEvidenceDependencies.get(node) === true) evidenceConsumers.add(node);
      }
      for (const node of graph.nodes) {
        for (const child of graph.children.get(node) as readonly QueryNode[]) (physical.get(child) as PooledPhysicalNode).parents.add(node);
      }
      const registeredState = state;
      roots.add(registeredState);
      refreshDiagnostics(newNodes.length, newNodes.length, 0);
      return {
        getCurrentResult: () => registeredState.current,
        close: () => release(registeredState)
      };
    } catch (error) {
      if (state !== undefined) {
        roots.delete(state);
        for (const node of [...state.reachable].reverse()) {
          const record = physical.get(node);
          if (record === undefined) continue;
          const ownerCount = record.owners.size;
          if (!record.owners.delete(state)) continue;
          if (ownerCount === 2) sharedPhysicalNodeCount -= 1;
          if (record.owners.size === 0) removePhysicalNode(node, record);
        }
      }
      for (const node of stagedMaterialized) materialized.delete(node);
      for (const identity of createdInterned.reverse()) {
        if (physical.has(identity.node)) continue;
        if (interned.get(identity.key) === identity) interned.delete(identity.key);
        internedByNode.delete(identity.node);
      }
      throw error;
    }
  };

  const attach = (plan: PreparedPlan<QueryNode>): PooledIncrementalQueryRoot => {
    if (closed) throw new Error('Pooled incremental query runtime is closed');
    if (executionPhase !== 'idle') throw new PooledQueryRuntimeBusyError(
      executionPhase === 'updating'
        ? 'Cannot attach a pooled query root during an update'
        : 'Cannot attach a pooled query root during another attachment'
    );
    executionPhase = 'attaching';
    try {
      return attachNow(plan);
    } finally {
      executionPhase = 'idle';
      flushDeferredLifecycle();
    }
  };

  const applyUpdateNow = (update: QueryMaintenanceUpdate, journal: PooledUpdateJournal): void => {
    if (closed) throw new Error('Pooled incremental query runtime is closed');
    revision += 1;
    const applied = applyQueryMaintenanceUpdate(acceptedSnapshot, update);
    if (!applied.success) {
      rejectedUpdateCount += 1;
      runtimeIssues = applied.issues;
      for (const root of roots) {
        if (!journal.roots.has(root)) journal.roots.set(root, { current: root.current, asserted: root.asserted });
        root.current = maintainedQueryResult(
          undefined,
          runtimeIssues,
          maintenanceState(root.reachable.size, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
          publicRows
        );
        root.asserted = undefined;
      }
      refreshDiagnostics(0, 0, 0);
      return;
    }

    const nextSnapshot = applied.value;
    resetSnapshotWork(nextSnapshot);
    runtimeIssues = [];
    const changedRelations = new Set(update.relations.map(({ relation }) => relationKey(relation)));
    const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
      || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
    const updatedNodes = new Set<QueryNode>();
    const changedNodes = new Set<QueryNode>();
    const rootUpdatedCounts = new Map<PooledRootState, number>();
    const rootChangedCounts = new Map<PooledRootState, number>();
    const candidates: QueryNode[] = [];
    const enqueued = new Set<QueryNode>();
    const evaluated = new Set<QueryNode>();
    const candidateOrder = (node: QueryNode): number => (physical.get(node) as PooledPhysicalNode).orderIndex;
    const enqueue = (node: QueryNode): void => {
      if (enqueued.has(node) || evaluated.has(node) || !physical.has(node)) return;
      enqueued.add(node);
      candidates.push(node);
      let index = candidates.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (candidateOrder(candidates[parent] as QueryNode) <= candidateOrder(node)) break;
        candidates[index] = candidates[parent] as QueryNode;
        index = parent;
      }
      candidates[index] = node;
    };
    const dequeue = (): QueryNode | undefined => {
      const first = candidates[0];
      const last = candidates.pop();
      if (first === undefined) return undefined;
      enqueued.delete(first);
      if (candidates.length !== 0 && last !== undefined) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          if (left >= candidates.length) break;
          const right = left + 1;
          const child = right < candidates.length
            && candidateOrder(candidates[right] as QueryNode) < candidateOrder(candidates[left] as QueryNode)
            ? right
            : left;
          if (candidateOrder(last) <= candidateOrder(candidates[child] as QueryNode)) break;
          candidates[index] = candidates[child] as QueryNode;
          index = child;
        }
        candidates[index] = last;
      }
      return first;
    };
    for (const relation of changedRelations) for (const node of relationConsumers.get(relation) ?? []) enqueue(node);
    if (sessionEvidenceChanged) for (const node of evidenceConsumers) enqueue(node);
    for (const node of unmaterializedNodes) enqueue(node);

    for (let node = dequeue(); node !== undefined; node = dequeue()) {
      evaluated.add(node);
      const record = physical.get(node) as PooledPhysicalNode;
      const previousNode = materialized.get(node);
      let nextNode = node.kind === 'from'
        ? incrementallyMaterializeFrom(node, nextSnapshot, update, previousNode)
        : node.kind === 'join'
          ? incrementallyMaterializeJoin(node, nextSnapshot, materialized, previousNode)
        : node.kind === 'order'
          ? incrementallyMaterializeOrder(node, nextSnapshot, materialized, previousNode)
        : node.kind === 'window'
          ? incrementallyMaterializeWindow(node, nextSnapshot, materialized, previousNode)
        : node.kind === 'aggregate'
          ? incrementallyMaterializeAggregate(node, nextSnapshot, materialized, previousNode)
        : isLocallyMaintainedNode(node)
          ? incrementallyMaterializeLocal(node, nextSnapshot, materialized, previousNode)
          : materializeQueryNode(node, nextSnapshot, materialized);
      nextNode = chargeIncrementalOutput(node, nextSnapshot, materialized, nextNode);
      if (!journal.materialized.has(node)) journal.materialized.set(node, previousNode);
      materialized.set(node, nextNode);
      unmaterializedNodes.delete(node);
      updatedNodes.add(node);
      for (const owner of record.owners) rootUpdatedCounts.set(owner, (rootUpdatedCounts.get(owner) ?? 0) + 1);
      if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode, valueIdentities)) {
        changedNodes.add(node);
        for (const owner of record.owners) rootChangedCounts.set(owner, (rootChangedCounts.get(owner) ?? 0) + 1);
        for (const parent of record.parents) enqueue(parent);
      }
    }
    acceptedSnapshot = nextSnapshot;
    const changedIds = changedRelationIds(nextSnapshot, changedRelations);
    for (const root of roots) {
      const nextRoot = materialized.get(root.root);
      const rootChangedNodeCount = rootChangedCounts.get(root) ?? 0;
      // A rejected update clears `asserted` while retaining the last physical
      // graph. The first accepted transition must therefore republish that
      // graph even when no node needed evaluation.
      const reusePublicViews = root.asserted !== undefined && rootChangedNodeCount === 0;
      const nextCurrent = maintainedQueryResult(
        nextRoot,
        [],
        maintenanceState(
          root.reachable.size,
          rootUpdatedCounts.get(root) ?? 0,
          rootChangedNodeCount,
          changedIds,
          reusePublicViews
            ? emptyIncrementalQueryResultDelta
            : diffMaintainedResults(root.asserted, nextRoot, valueIdentities),
          revision,
          rejectedUpdateCount
        ),
        publicRows,
        root.current,
        reusePublicViews
      );
      if (!journal.roots.has(root)) journal.roots.set(root, { current: root.current, asserted: root.asserted });
      root.current = nextCurrent;
      root.asserted = nextRoot;
    }
    refreshDiagnostics(updatedNodes.size, changedNodes.size, 0);
  };

  const applyUpdate = (update: QueryMaintenanceUpdate): void => {
    if (closed) throw new Error('Pooled incremental query runtime is closed');
    if (executionPhase === 'updating') throw new Error('Recursive pooled query updates are not supported');
    if (executionPhase === 'attaching') throw new Error('Cannot update a pooled query runtime during root attachment');
    const checkpoint = {
      acceptedSnapshot,
      runtimeIssues,
      revision,
      rejectedUpdateCount,
      diagnostics
    };
    const journal: PooledUpdateJournal = { materialized: new Map(), roots: new Map() };
    executionPhase = 'updating';
    try {
      applyUpdateNow(adoptQueryMaintenanceUpdate(update), journal);
    } catch (error) {
      acceptedSnapshot = checkpoint.acceptedSnapshot;
      runtimeIssues = checkpoint.runtimeIssues;
      revision = checkpoint.revision;
      rejectedUpdateCount = checkpoint.rejectedUpdateCount;
      diagnostics = checkpoint.diagnostics;
      for (const [node, value] of journal.materialized) {
        if (value === undefined) {
          materialized.delete(node);
          if (physical.has(node)) unmaterializedNodes.add(node);
        } else {
          materialized.set(node, value);
          unmaterializedNodes.delete(node);
        }
      }
      for (const [root, state] of journal.roots) {
        root.current = state.current;
        root.asserted = state.asserted;
      }
      // Identity entries computed from an aborted graph may refer to values
      // that were never accepted. Rebuild them lazily from restored nodes.
      valueIdentities = new WeakMap();
      throw error;
    } finally {
      executionPhase = 'idle';
      flushDeferredLifecycle();
    }
  };

  return {
    attach,
    applyUpdate,
    getDiagnostics: () => diagnostics,
    close: () => {
      if (closed) return;
      if (executionPhase !== 'idle') {
        closeRequested = true;
        return;
      }
      closeNow();
    }
  };
};

const pooledDiagnostics = (
  runtimeIdentity: string,
  revision: number,
  activeRootCount: number,
  physicalNodeCount: number,
  sharedPhysicalNodeCount: number,
  lastUpdatedPhysicalNodeCount: number,
  lastChangedPhysicalNodeCount: number,
  lastCollectedPhysicalNodeCount: number,
  rejectedUpdateCount: number
): PooledIncrementalQueryDiagnostics => Object.freeze({
  strategy: 'pooled-differential-operator-dag',
  runtimeIdentity,
  revision,
  activeRootCount,
  physicalNodeCount,
  sharedPhysicalNodeCount,
  lastUpdatedPhysicalNodeCount,
  lastChangedPhysicalNodeCount,
  lastCollectedPhysicalNodeCount,
  rejectedUpdateCount
});

class NonPoolableQueryError extends TypeError {
  readonly code = 'query.pool.nonpoolable';
}

class PooledQueryRuntimeBusyError extends Error {
  readonly code = 'query.pool.busy';
}

export const isNonPoolableQueryError = (error: unknown): boolean => error instanceof NonPoolableQueryError;
export const isPooledQueryRuntimeBusyError = (error: unknown): boolean => error instanceof PooledQueryRuntimeBusyError;

const assertPoolableQuery = (root: QueryNode): void => {
  const visiting = new Set<object>();
  const visited = new Set<object>();
  const visitObject = (value: object, children: () => void): void => {
    if (visited.has(value)) return;
    if (visiting.has(value)) throw new NonPoolableQueryError('Pooled query graphs must be acyclic');
    visiting.add(value);
    children();
    visiting.delete(value);
    visited.add(value);
  };
  const visitList = <Value extends object>(values: readonly Value[], visit: (value: Value) => void): void => visitObject(values, () => {
    for (const value of values) visit(value);
  });
  const visitExpressions = (values: Readonly<Record<string, Expr>>): void => visitObject(values, () => {
    for (const expression of Object.values(values)) visitExpression(expression);
  });
  const visitOrder = (terms: readonly OrderTerm[]): void => visitList(terms, (term) => visitObject(term, () => visitExpression(term.value)));
  const visitExpression = (expression: Expr): void => visitObject(expression, () => {
    if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'field' || expression.kind === 'key-of' || expression.kind === 'source-of') return;
    if (expression.kind === 'subquery') throw new NonPoolableQueryError('Pooled query graphs do not support subquery');
    if (expression.kind === 'compare' || expression.kind === 'arithmetic') { visitExpression(expression.left); visitExpression(expression.right); return; }
    if (expression.kind === 'is-null' || expression.kind === 'is-missing') { visitExpression(expression.value); return; }
    if (expression.kind === 'boolean') {
      if (expression.op === 'not') visitExpression(expression.arg);
      else visitList(expression.args, visitExpression);
      return;
    }
    if (expression.kind === 'case') {
      visitList(expression.branches, (branch) => visitObject(branch, () => { visitExpression(branch.when); visitExpression(branch.then); }));
      visitExpression(expression.otherwise);
      return;
    }
    if (expression.kind === 'record') { visitExpressions(expression.fields); return; }
    visitList(expression.kind === 'array' ? expression.items : expression.args, visitExpression);
  });
  const visitAggregate = (aggregate: AggregateExpr): void => visitObject(aggregate, () => {
    if (aggregate.value !== undefined) visitExpression(aggregate.value);
    if (aggregate.orderBy !== undefined) visitOrder(aggregate.orderBy);
  });
  const visitWindow = (window: WindowExpr): void => visitObject(window, () => {
    if (window.value !== undefined) visitExpression(window.value);
    if (window.partitionBy !== undefined) visitList(window.partitionBy, visitExpression);
    visitOrder(window.orderBy);
  });
  const visitQuery = (node: QueryNode): void => visitObject(node, () => {
    if (node.kind === 'seek' || node.kind === 'recursive' || node.kind === 'recursion-ref') {
      throw new NonPoolableQueryError('Pooled query graphs do not support ' + node.kind);
    }
    if (node.kind === 'from' || node.kind === 'values') return;
    if (node.kind === 'join' || node.kind === 'set') {
      visitQuery(node.left);
      visitQuery(node.right);
      if (node.kind === 'join' && node.on !== undefined) visitExpression(node.on);
      return;
    }
    visitQuery(node.input);
    if (node.kind === 'where') visitExpression(node.predicate);
    else if (node.kind === 'select' || node.kind === 'with-fields') visitExpressions(node.fields);
    else if (node.kind === 'unnest') visitExpression(node.expression);
    else if (node.kind === 'aggregate') {
      visitExpressions(node.groupBy);
      visitObject(node.measures, () => { for (const measure of Object.values(node.measures)) visitAggregate(measure); });
    } else if (node.kind === 'order') visitOrder(node.by);
    else if (node.kind === 'window') visitObject(node.fields, () => { for (const window of Object.values(node.fields)) visitWindow(window); });
  });
  visitQuery(root);
};

const publicQueryRow = (row: ScopedRow, cache: WeakMap<ScopedRow, QueryRecord>): QueryRecord => {
  const cached = cache.get(row);
  if (cached !== undefined) return cached;
  const owned = adoptQueryRecord(visibleRow(row), 'Query result row');
  cache.set(row, owned);
  return owned;
};

const publicQueryRows = (rows: readonly ScopedRow[], cache: WeakMap<ScopedRow, QueryRecord>): readonly QueryRecord[] =>
  Object.freeze(rows.map((row) => publicQueryRow(row, cache)));

const publicQueryIssues = (issues: readonly Issue[]): readonly Issue[] => Object.freeze(issues.map((issue) =>
  adoptJsonValue(issue, 'Query issue') as unknown as Issue
));

const internPooledQueryNode = (
  node: QueryNode,
  interned: Map<string, InternedPooledNode>,
  byNode: Map<QueryNode, InternedPooledNode>,
  created: InternedPooledNode[],
  nextId: () => number
): QueryNode => {
  let canonical: QueryNode;
  let key: string;
  if (node.kind === 'join' || node.kind === 'set') {
    const left = internPooledQueryNode(node.left, interned, byNode, created, nextId);
    const right = internPooledQueryNode(node.right, interned, byNode, created, nextId);
    canonical = Object.freeze({ ...node, left, right });
    const { left: _left, right: _right, ...payload } = canonical;
    key = canonicalizeJson(['binary', payload, (byNode.get(left) as InternedPooledNode).id, (byNode.get(right) as InternedPooledNode).id] as unknown as JsonValue);
  } else if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest' || node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order' || node.kind === 'slice' || node.kind === 'window') {
    const child = internPooledQueryNode(node.input, interned, byNode, created, nextId);
    canonical = Object.freeze({ ...node, input: child });
    const { input: _input, ...payload } = canonical;
    key = canonicalizeJson(['unary', payload, (byNode.get(child) as InternedPooledNode).id] as unknown as JsonValue);
  } else {
    canonical = node;
    key = canonicalizeJson(['leaf', canonical] as unknown as JsonValue);
  }
  const existing = interned.get(key);
  if (existing !== undefined) return existing.node;
  const identity = { id: nextId(), key, node: canonical };
  interned.set(key, identity);
  byNode.set(canonical, identity);
  created.push(identity);
  return canonical;
};

type CompiledQueryGraph = {
  readonly nodes: readonly QueryNode[];
  readonly children: ReadonlyMap<QueryNode, readonly QueryNode[]>;
  readonly externalDependencies: ReadonlyMap<QueryNode, ReadonlySet<string>>;
  readonly sessionEvidenceDependencies: ReadonlyMap<QueryNode, boolean>;
};

const compileQueryGraph = (root: QueryNode): CompiledQueryGraph => {
  const nodes: QueryNode[] = [];
  const visited = new Set<QueryNode>();
  const visit = (node: QueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of directQueryChildren(node)) visit(child);
    nodes.push(node);
  };
  visit(root);
  const children = new Map(nodes.map((node) => [node, directQueryChildren(node)]));
  return {
    nodes: Object.freeze(nodes),
    children,
    externalDependencies: new Map(nodes.map((node) => [node, relationDependencies(node, children.get(node))])),
    sessionEvidenceDependencies: new Map(nodes.map((node) => [node, containsSeek(node, children.get(node))]))
  };
};

const directQueryChildren = (node: QueryNode): readonly QueryNode[] => {
  if (node.kind === 'join' || node.kind === 'set') return [node.left, node.right];
  if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest' || node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order' || node.kind === 'slice' || node.kind === 'window' || node.kind === 'seek') return [node.input];
  // Recursion owns a cyclic local fixpoint and is one incremental operator.
  return [];
};

const relationDependencies = (node: QueryNode, excludedChildren: readonly QueryNode[] = []): ReadonlySet<string> => {
  const dependencies = new Set<string>();
  const excluded = new Set<unknown>(excludedChildren);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== 'object' || excluded.has(value)) return;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind === 'from' && isRelationUse(candidate.relation)) dependencies.add(relationKey(candidate.relation));
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(node);
  return dependencies;
};

const containsSeek = (node: QueryNode, excludedChildren: readonly QueryNode[] = []): boolean => {
  const excluded = new Set<unknown>(excludedChildren);
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== 'object' || excluded.has(value)) return false;
    const candidate = value as Readonly<Record<string, unknown>>;
    return candidate.kind === 'seek' || Object.values(candidate).some(visit);
  };
  return visit(node);
};

const isRelationUse = (value: unknown): value is RelationUse => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { readonly schemaView?: unknown; readonly relationId?: unknown };
  return typeof candidate.relationId === 'string' && candidate.schemaView !== null && typeof candidate.schemaView === 'object';
};

const materializeQueryNode = (
  node: QueryNode,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>
): MaterializedQueryNode => {
  const materialized = evaluateMaterializedQueryNode(node, snapshot, materializedNodes);
  if (node.kind === 'from' && !materialized.unavailable && materialized.issues.length === 0) {
    return { ...materialized, from: indexFromInputs(node, snapshot) };
  }
  if (node.kind === 'join' && equijoinFields(node) !== undefined && !materialized.unavailable && materialized.issues.length === 0) {
    const left = materializedNodes.get(node.left);
    const right = materializedNodes.get(node.right);
    if (left !== undefined && right !== undefined && !left.unavailable && !right.unavailable) return { ...materialized, join: indexJoinSegments(node, left.result.rows, right.result.rows, materialized.result.rows) };
  }
  if (node.kind === 'order' && orderCanBeIncrementallyIndexed(node) && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') return { ...materialized, order: { inputs: child.result.rows } };
  }
  if (node.kind === 'window' && windowCanBePartitionMaintained(node) && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') {
      const indexed = indexWindowState(node, child.result.rows, materialized.result.rows, materializationContext(snapshot, materializedNodes, node, []));
      if (indexed !== undefined) return { ...materialized, window: indexed };
    }
  }
  if (node.kind === 'aggregate' && aggregateCanBeIncrementallyIndexed(node) && !materialized.unavailable && materialized.issues.length === 0) {
    const child = materializedNodes.get(node.input);
    if (child !== undefined && child.result.completeness === 'exact') {
      const indexed = indexAggregateState(node, child.result.rows, materialized.result.rows, materializationContext(snapshot, materializedNodes, node, []));
      if (indexed !== undefined) return { ...materialized, aggregate: indexed };
    }
  }
  if (!isLocallyMaintainedNode(node) || materialized.unavailable || materialized.issues.length > 0) return materialized;
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.result.completeness === 'unknown') return materialized;
  return { ...materialized, local: indexLocalSegments(node, child.result.rows, materialized.result.rows) };
};

const windowCanBePartitionMaintained = (node: Extract<QueryNode, { readonly kind: 'window' }>): boolean => {
  const windows = Object.values(node.fields);
  const first = windows[0];
  if (first === undefined) return false;
  const partitionKey = canonicalizeJson((first.partitionBy ?? []) as unknown as JsonValue);
  const outputFields = new Set(Object.keys(node.fields));
  return windows.every((window) =>
    canonicalizeJson((window.partitionBy ?? []) as unknown as JsonValue) === partitionKey
    && !windowSpecificationReferencesFields(window, node.alias, outputFields)
    && !(window.partitionBy ?? []).some((expression) => containsSubquery(expression) || containsNamedCall(expression))
    && !window.orderBy.some((term) => containsSubquery(term.value) || containsNamedCall(term.value))
    && (window.value === undefined || !containsSubquery(window.value) && !containsNamedCall(window.value)));
};

const windowPartitionKey = (node: Extract<QueryNode, { readonly kind: 'window' }>, row: ScopedRow, context: QueryContext): string => {
  const first = Object.values(node.fields)[0] as WindowExpr;
  const values = (first.partitionBy ?? []).map((expression) => evaluateExpr(expression, exprContext(row, context)));
  if (values.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.unavailable = true;
  return canonicalizeJson(values.map(expressionJson));
};

const indexWindowState = (
  node: Extract<QueryNode, { readonly kind: 'window' }>,
  inputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[],
  context: QueryContext
): NonNullable<MaterializedQueryNode['window']> | undefined => {
  if (inputs.length !== outputs.length) return undefined;
  const partitionKeyByRow = new Map<ScopedRow, string>();
  const partitions = new Map<string, { members: ScopedRow[]; outputs: ScopedRow[] }>();
  inputs.forEach((row, index) => {
    const key = windowPartitionKey(node, row, context);
    partitionKeyByRow.set(row, key);
    const partition = partitions.get(key) ?? { members: [], outputs: [] };
    partition.members.push(row);
    partition.outputs.push(outputs[index] as ScopedRow);
    partitions.set(key, partition);
  });
  return context.unavailable ? undefined : { inputs, partitionKeyByRow, partitions };
};

const incrementallyMaterializeWindow = (
  node: Extract<QueryNode, { readonly kind: 'window' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (!windowCanBePartitionMaintained(node) || child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.window === undefined) {
    return materializeQueryNode(node, snapshot, materializedNodes);
  }
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues);
  const partitionKeyByRow = new Map<ScopedRow, string>();
  const partitions = new Map<string, { members: ScopedRow[]; positions: number[] }>();
  child.result.rows.forEach((row, position) => {
    const key = previous.window?.partitionKeyByRow.get(row) ?? windowPartitionKey(node, row, context);
    partitionKeyByRow.set(row, key);
    const partition = partitions.get(key) ?? { members: [], positions: [] };
    partition.members.push(row);
    partition.positions.push(position);
    partitions.set(key, partition);
  });
  if (context.unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
  const output: ScopedRow[] = Array.from({ length: child.result.rows.length });
  const indexedPartitions = new Map<string, { readonly members: readonly ScopedRow[]; readonly outputs: readonly ScopedRow[] }>();
  const changedPositions: number[] = [];
  const overrides = new Map(materializedNodes);
  for (const [key, partition] of partitions) {
    const prior = previous.window.partitions.get(key);
    const reusable = prior !== undefined && prior.members.length === partition.members.length && prior.members.every((row, index) => row === partition.members[index]);
    let outputs: readonly ScopedRow[];
    if (reusable) outputs = prior.outputs;
    else {
      overrides.set(node.input, { result: { rows: partition.members, completeness: 'exact' }, issues: [], unavailable: false });
      const evaluated = evaluateMaterializedQueryNode(node, snapshot, overrides);
      if (evaluated.unavailable || evaluated.issues.length > 0 || evaluated.result.completeness !== 'exact') return materializeQueryNode(node, snapshot, materializedNodes);
      outputs = evaluated.result.rows;
      if (outputs.length !== partition.members.length) return materializeQueryNode(node, snapshot, materializedNodes);
      changedPositions.push(...partition.positions);
    }
    partition.positions.forEach((position, index) => { output[position] = outputs[index] as ScopedRow; });
    indexedPartitions.set(key, { members: partition.members, outputs });
  }
  const stableIdentityLayout = previous.window.inputs.length === child.result.rows.length
    && previous.window.inputs.every((row, index) => resultKey(row) === resultKey(child.result.rows[index] as ScopedRow));
  return {
    result: { rows: output, completeness: 'exact' },
    issues: [],
    unavailable: false,
    ...(stableIdentityLayout ? { stableChangedPositions: changedPositions.sort((left, right) => left - right) } : {}),
    window: { inputs: child.result.rows, partitionKeyByRow, partitions: indexedPartitions }
  };
};

const incrementallyMaterializeOrder = (
  node: Extract<QueryNode, { readonly kind: 'order' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (!orderCanBeIncrementallyIndexed(node) || child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.order === undefined) {
    return materializeQueryNode(node, snapshot, materializedNodes);
  }
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues);
  const nextPositions = new Map(child.result.rows.map((row, index) => [row, index]));
  const previousInputs = new Set(previous.order.inputs);
  const retained = previous.result.rows.filter((row) => nextPositions.has(row));
  // Stable sort ties follow input order. Insert/delete preserves the relative
  // order of retained inputs; an upstream reorder does not, so fall back in
  // that uncommon case rather than silently changing SQL-style tie semantics.
  const previousCommon = previous.order.inputs.filter((row) => nextPositions.has(row));
  const nextCommon = child.result.rows.filter((row) => previousInputs.has(row));
  if (previousCommon.some((row, index) => row !== nextCommon[index])) return materializeQueryNode(node, snapshot, materializedNodes);
  const changed = child.result.rows.filter((row) => !previousInputs.has(row));
  // Repeated array insertion is attractive for sparse changes but quadratic
  // for bulk replacements. A full stable sort is the safer upper bound once
  // the changed set is no longer sparse.
  if (changed.length > Math.max(32, child.result.rows.length >>> 3)) {
    return materializeQueryNode(node, snapshot, materializedNodes);
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
  if (context.unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
  return { result: { rows: retained, completeness: 'exact' }, issues: [], unavailable: false, order: { inputs: child.result.rows } };
};

const incrementallyMaterializeAggregate = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (!aggregateCanBeIncrementallyIndexed(node) || child === undefined || child.unavailable || child.issues.length > 0 || child.result.completeness !== 'exact' || previous?.aggregate === undefined) {
    return materializeQueryNode(node, snapshot, materializedNodes);
  }
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues);
  const stablePositions = child.stableChangedPositions;
  if (stablePositions !== undefined && previous.aggregate.inputs.length === child.result.rows.length && stablePositions.length <= Math.max(32, child.result.rows.length >>> 3)) {
    const sparse = sparselyMaterializeAggregate(node, child.result.rows, stablePositions, previous.aggregate, context);
    if (sparse !== undefined && !context.unavailable && issues.length === 0) {
      return { result: { rows: [...sparse.groups.values()].map(({ output }) => output), completeness: 'exact' }, issues: [], unavailable: false, aggregate: sparse };
    }
  }
  const indexed = buildAggregateState(node, child.result.rows, context, previous.aggregate);
  if (context.unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
  return { result: { rows: [...indexed.groups.values()].map(({ output }) => output), completeness: 'exact' }, issues: [], unavailable: false, aggregate: indexed };
};

const aggregateGroupRow = (
  node: Extract<QueryNode, { readonly kind: 'aggregate' }>,
  key: QueryRecord,
  members: readonly AggregateGroupMember[],
  context: QueryContext
): ScopedRow => {
  const output: Record<string, QueryLogicalValue> = { ...key };
  const rows = members.map(({ row }) => row);
  for (const [name, aggregate] of Object.entries(node.measures)) output[name] = aggregateValue(aggregate, rows, context);
  return scopedRow({ [node.alias]: output }, { [node.alias]: { relationId: 'aggregate', occurrence: 'aggregate:' + canonicalizeQueryValue(key) } });
};

const indexAggregateState = (
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
  if (groups.size !== outputs.length || context.unavailable) return undefined;
  const indexed = new Map<string, AggregateGroupState>();
  [...groups].forEach(([canonical, group], index) => indexed.set(canonical, { key: group.key, members: group.members, output: outputs[index] as ScopedRow }));
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
    const oldMembers = oldGroup.members.filter((member) => member.position !== position);
    groups.set(beforeKey.canonical, { ...oldGroup, members: oldMembers });
    const target = groups.get(afterKey.canonical);
    const nextMember = { position, row: after };
    if (target === undefined) groups.set(afterKey.canonical, { key, members: [nextMember], output: oldGroup.output });
    else {
      const members = [...target.members, nextMember].sort((left, right) => left.position - right.position);
      groups.set(afterKey.canonical, { ...target, members });
    }
  }
  for (const canonical of affected) {
    const group = groups.get(canonical);
    if (group === undefined) continue;
    if (group.members.length === 0 && !(canonical === '{}' && Object.keys(node.groupBy).length === 0)) {
      groups.delete(canonical);
      continue;
    }
    groups.set(canonical, { ...group, output: aggregateGroupRow(node, group.key, group.members, context) });
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) {
    const key = {};
    groups.set('{}', { key, members: [], output: aggregateGroupRow(node, key, [], context) });
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
  const ordered = new Map(orderedEntries);
  let groupKeys: AggregateRowGroupIndex = { parent: previous.groupKeys, entries: changedKeys, depth: previous.groupKeys.depth + 1 };
  if (groupKeys.depth >= 64) {
    const compacted = new Map<ScopedRow, AggregateGroupKey>();
    for (const row of inputs) {
      const indexed = lookupAggregateGroupKey(groupKeys, row);
      if (indexed === undefined) return undefined;
      compacted.set(row, indexed);
    }
    groupKeys = { entries: compacted, depth: 0 };
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
    output.set(canonical, { key: group.key, members: group.members, output: reusable ? prior.output : aggregateGroupRow(node, group.key, group.members, context) });
  }
  return { inputs, groupKeys: { entries: groupKeys, depth: 0 }, groups: output };
};

// Building the persistent group index evaluates grouping expressions once in
// addition to semantic materialization. Built-in expressions are pure; named
// host calls and subqueries may carry observable work, so keep those on the
// single-evaluation fallback path.
const orderCanBeIncrementallyIndexed = (node: Extract<QueryNode, { readonly kind: 'order' }>): boolean =>
  !node.by.some(({ value }) => containsSubquery(value) || containsNamedCall(value));

const aggregateCanBeIncrementallyIndexed = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>): boolean => {
  if (Object.values(node.groupBy).some((expression) => containsSubquery(expression) || containsNamedCall(expression))) return false;
  return !Object.values(node.measures).some((measure) =>
    measure.value !== undefined && containsSubquery(measure.value)
    || measure.orderBy?.some(({ value }) => containsSubquery(value)) === true
  );
};

const containsNamedCall = (expression: Expr): boolean => {
  if (expression.kind === 'call') return true;
  if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'field' || expression.kind === 'key-of' || expression.kind === 'source-of' || expression.kind === 'subquery') return false;
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') return containsNamedCall(expression.left) || containsNamedCall(expression.right);
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') return containsNamedCall(expression.value);
  if (expression.kind === 'boolean') return expression.op === 'not' ? containsNamedCall(expression.arg) : expression.args.some(containsNamedCall);
  if (expression.kind === 'case') return expression.branches.some(({ when, then }) => containsNamedCall(when) || containsNamedCall(then)) || containsNamedCall(expression.otherwise);
  if (expression.kind === 'record') return Object.values(expression.fields).some(containsNamedCall);
  const expressions = expression.kind === 'array' ? expression.items : expression.args;
  return expressions.some(containsNamedCall);
};

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
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>
): MaterializedQueryNode => {
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues);
  const result = evaluateNode(node, context);
  return { result, issues: deduplicateQueryIssues(issues), unavailable: context.unavailable };
};

const materializationContext = (
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  activeNode: QueryNode,
  issues: Issue[]
): QueryContext => ({
    relations: groupRelationInputs(snapshot.relations),
    parameters: snapshot.parameters ?? {},
    functions: snapshot.functions ?? new Map(),
    issues,
    recursions: new Map(),
    recursionConstants: new Map(),
    recursionDependencies: new Map(),
    joinIndexes: new Map(),
    ...(snapshot.basis === undefined ? {} : { basis: snapshot.basis }),
    ...(snapshot.membershipRevision === undefined ? {} : { membershipRevision: snapshot.membershipRevision }),
    materializedNodes,
    activeNode,
    unavailable: false,
    ...(snapshotWork.get(snapshot) === undefined ? {} : { work: snapshotWork.get(snapshot) as QueryWork })
  });

const chargeIncrementalOutput = (
  activeNode: QueryNode,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  materialized: MaterializedQueryNode
): MaterializedQueryNode => {
  if (materialized.result.completeness === 'unknown' || snapshotWork.get(snapshot) === undefined) return materialized;
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, activeNode, issues);
  if (consumeQueryWork(context, materialized.result.rows.length)) return materialized;
  return { result: { rows: [], completeness: 'unknown' }, issues: deduplicateQueryIssues([...materialized.issues, ...issues]), unavailable: true };
};

const incrementallyMaterializeJoin = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined
): MaterializedQueryNode => {
  const equality = equijoinFields(node);
  const left = materializedNodes.get(node.left);
  const right = materializedNodes.get(node.right);
  if (equality === undefined || previous?.join === undefined || left === undefined || right === undefined || left.unavailable || right.unavailable || left.issues.length > 0 || right.issues.length > 0 || left.result.completeness === 'unknown' || right.result.completeness === 'unknown') {
    return materializeQueryNode(node, snapshot, materializedNodes);
  }
  if ((node.join === 'anti' || node.join === 'left') && right.result.completeness !== 'exact') return materializeQueryNode(node, snapshot, materializedNodes);
  const issues: Issue[] = [];
  const context = materializationContext(snapshot, materializedNodes, node, issues);
  const rightUnchanged = previous.join.rightInputs.length === right.result.rows.length && previous.join.rightInputs.every((row, index) => row === right.result.rows[index]);
  const stableRightChanges = right.stableChangedPositions !== undefined
    && previous.join.rightInputs.length === right.result.rows.length;
  const sparseRightChanges = stableRightChanges
    && (right.stableChangedPositions?.length ?? 0) <= Math.max(32, Math.floor(right.result.rows.length / 4));
  const rightIndex = rightUnchanged && previous.join.rightIndex !== undefined
    ? previous.join.rightIndex
    : sparseRightChanges && previous.join.rightIndex !== undefined
      ? updateIndexedRows(previous.join.rightIndex, previous.join.rightInputs, right.result.rows, right.stableChangedPositions ?? [], equality.right, context)
      : buildIndexedRows(right.result.rows, equality.right, context);
  const affectedRightKeys = rightUnchanged
    ? new Set<string>()
    : sparseRightChanges
      ? changedExpressionKeysAtPositions(previous.join.rightInputs, right.result.rows, right.stableChangedPositions ?? [], equality.right, context)
      : changedExpressionKeys(previous.join.rightInputs, right.result.rows, equality.right, context);
  const segments: (readonly ScopedRow[])[] = [];
  const output: ScopedRow[] = [];
  let previousPositions: ReadonlyMap<string, number> | undefined;
  for (let index = 0; index < left.result.rows.length; index += 1) {
    const row = left.result.rows[index] as ScopedRow;
    const identity = resultKey(row);
    const aligned = previous.join.leftInputs[index];
    let previousIndex = index;
    if (aligned === undefined || resultKey(aligned) !== identity) {
      previousPositions ??= new Map(previous.join.leftInputs.map((input, position) => [resultKey(input), position]));
      previousIndex = previousPositions.get(identity) ?? -1;
    }
    const previousInput = previous.join.leftInputs[previousIndex];
    const leftKey = indexKey(equality.left, row, context);
    const retained = previousInput === row && (leftKey === undefined || !affectedRightKeys.has(leftKey)) ? previous.join.segments[previousIndex] : undefined;
    const segment = retained ?? joinLeftRow(node, row, leftKey === undefined ? [] : rightIndex.get(leftKey) ?? [], true, context);
    segments.push(segment);
    output.push(...segment);
  }
  if (context.unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
  return {
    result: { rows: output, completeness: left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound' },
    issues: [],
    unavailable: false,
    join: { leftInputs: left.result.rows, rightInputs: right.result.rows, segments, rightIndex }
  };
};

const changedExpressionKeysAtPositions = (
  before: readonly ScopedRow[],
  after: readonly ScopedRow[],
  positions: readonly number[],
  expression: Expr,
  context: QueryContext
): ReadonlySet<string> => {
  const changed = new Set<string>();
  for (const position of positions) {
    const previous = before[position];
    const next = after[position];
    if (previous !== undefined) { const key = indexKey(expression, previous, context); if (key !== undefined) changed.add(key); }
    if (next !== undefined) { const key = indexKey(expression, next, context); if (key !== undefined) changed.add(key); }
  }
  return changed;
};

const updateIndexedRows = (
  previous: ReadonlyMap<string, readonly ScopedRow[]>,
  before: readonly ScopedRow[],
  after: readonly ScopedRow[],
  positions: readonly number[],
  expression: Expr,
  context: QueryContext
): ReadonlyMap<string, readonly ScopedRow[]> => {
  const operations = new Map<string, { readonly removed: ScopedRow[]; readonly added: ScopedRow[] }>();
  const operation = (key: string): { readonly removed: ScopedRow[]; readonly added: ScopedRow[] } => {
    const existing = operations.get(key);
    if (existing !== undefined) return existing;
    const created = { removed: [], added: [] };
    operations.set(key, created);
    return created;
  };
  for (const position of positions) {
    const previousRow = before[position];
    const nextRow = after[position];
    if (previousRow !== undefined) {
      const key = indexKey(expression, previousRow, context);
      if (key !== undefined) operation(key).removed.push(previousRow);
    }
    if (nextRow !== undefined) {
      const key = indexKey(expression, nextRow, context);
      if (key !== undefined) operation(key).added.push(nextRow);
    }
  }
  const nextPositions = new Map(after.map((row, index) => [row, index]));
  const overrides = new Map<string, readonly ScopedRow[] | undefined>();
  for (const [key, { removed, added }] of operations) {
    const removedRows = new Set(removed);
    const bucket = [...(previous.get(key) ?? [])].filter((row) => !removedRows.has(row));
    bucket.push(...added);
    bucket.sort((left, right) => (nextPositions.get(left) ?? 0) - (nextPositions.get(right) ?? 0));
    overrides.set(key, bucket.length === 0 ? undefined : bucket);
  }
  return new OverlayRowIndex(previous, overrides);
};

const changedExpressionKeys = (before: readonly ScopedRow[], after: readonly ScopedRow[], expression: Expr, context: QueryContext): ReadonlySet<string> => {
  const changed = new Set<string>();
  const beforeByIdentity = new Map(before.map((row, index) => [resultKey(row), { row, index }]));
  const afterByIdentity = new Map(after.map((row, index) => [resultKey(row), { row, index }]));
  for (const identity of new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])) {
    const previous = beforeByIdentity.get(identity);
    const next = afterByIdentity.get(identity);
    if (previous?.row === next?.row && previous?.index === next?.index) continue;
    if (previous !== undefined) { const key = indexKey(expression, previous.row, context); if (key !== undefined) changed.add(key); }
    if (next !== undefined) { const key = indexKey(expression, next.row, context); if (key !== undefined) changed.add(key); }
  }
  return changed;
};

const indexJoinSegments = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  leftInputs: readonly ScopedRow[],
  rightInputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[]
): NonNullable<MaterializedQueryNode['join']> => {
  const positions = new Map(leftInputs.map((row, index) => [resultKey(row), index]));
  const segments = leftInputs.map(() => [] as ScopedRow[]);
  for (const row of outputs) {
    const key = node.join === 'semi' || node.join === 'anti' ? resultKey(row) : row.origin;
    const index = key === undefined ? undefined : positions.get(key);
    if (index !== undefined) (segments[index] as ScopedRow[]).push(row);
  }
  return { leftInputs, rightInputs, segments };
};

const incrementallyMaterializeFrom = (
  node: Extract<QueryNode, { readonly kind: 'from' }>,
  snapshot: QueryMaintenanceSnapshot,
  update: QueryMaintenanceUpdate,
  previous: MaterializedQueryNode | undefined
): MaterializedQueryNode => {
  const inputs = groupRelationInputs(snapshot.relations).get(relationKey(node.relation));
  if (inputs === undefined || inputs.some(({ completeness }) => completeness === 'unknown')) {
    return evaluateMaterializedQueryNode(node, snapshot, new Map());
  }
  if (previous === undefined || previous.unavailable || previous.from === undefined) {
    const recovered = evaluateMaterializedQueryNode(node, snapshot, new Map());
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
    const key = singleAliasResultKey(node.alias, occurrence);
    const aligned = previous.result.rows[outputIndex];
    if (aligned !== undefined && resultKey(aligned) !== key && previousByIdentity === undefined) previousByIdentity = new Map(previous.result.rows.map((row) => [resultKey(row), row]));
    const retained = changed.has(occurrence) ? undefined : aligned !== undefined && resultKey(aligned) === key ? aligned : previousByIdentity?.get(key);
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
  relationKey(input.relation) + '\u0000' + (input.attachmentId ?? input.sourceId ?? '');

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

const incrementallyMaterializeLocal = (
  node: Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }>,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined
): MaterializedQueryNode => {
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.result.completeness === 'unknown' || child.issues.length > 0 || previous?.local === undefined) {
    return materializeQueryNode(node, snapshot, materializedNodes);
  }
  const oneToOne = isOneToOneLocallyMaintainedNode(node);
  if (child.stableChangedPositions !== undefined) {
    const segments = previous.local.segments.slice();
    const replacements = new Map<number, LocalSegment>();
    const issues: Issue[] = [];
    let unavailable = false;
    let overrides: Map<QueryNode, MaterializedQueryNode> | undefined;
    for (const index of child.stableChangedPositions) {
      const row = child.result.rows[index];
      if (row === undefined) return materializeQueryNode(node, snapshot, materializedNodes);
      overrides ??= new Map(materializedNodes);
      overrides.set(node.input, { result: { rows: [row], completeness: child.result.completeness }, issues: [], unavailable: false });
      const evaluated = evaluateMaterializedQueryNode(node, snapshot, overrides);
      issues.push(...evaluated.issues);
      unavailable = unavailable || evaluated.unavailable;
      replacements.set(index, localSegment(node, evaluated.result.rows));
    }
    if (unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
    const widthsChanged = [...replacements].some(([index, segment]) => localSegmentWidth(segment) !== (previous.local?.widths?.[index] ?? 1));
    for (const [index, segment] of replacements) segments[index] = segment;
    if (!widthsChanged) {
      const output = previous.result.rows.slice();
      const changedOutputPositions: number[] = [];
      for (const [index, segment] of replacements) {
        const offset = previous.local.outputOffsets?.[index] ?? index;
        const replacementRows = localSegmentRows(segment);
        for (let relative = 0; relative < replacementRows.length; relative += 1) {
          output[offset + relative] = replacementRows[relative] as ScopedRow;
          changedOutputPositions.push(offset + relative);
        }
      }
      return {
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
      };
    }
    const indexed = indexLocalSegmentLayout(segments);
    return {
      result: { rows: indexed.rows, completeness: child.result.completeness },
      issues: [],
      unavailable: false,
      local: { inputs: child.result.rows, segments, outputOffsets: indexed.outputOffsets, widths: indexed.widths }
    };
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
    const segment = evaluateMaterializedQueryNode(node, snapshot, overrides);
    issues.push(...segment.issues);
    unavailable = unavailable || segment.unavailable;
    const next = localSegment(node, segment.result.rows);
    segments.push(next);
    if (!oneToOne) appendLocalSegment(output, next);
  }
  if (unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
  if (oneToOne) {
    return {
      result: { rows: output, completeness: child.result.completeness },
      issues: [],
      unavailable: false,
      local: { inputs: child.result.rows, segments }
    };
  }
  const indexed = indexLocalSegmentLayout(segments);
  return {
    result: { rows: indexed.rows, completeness: child.result.completeness },
    issues: [],
    unavailable: false,
    local: { inputs: child.result.rows, segments, outputOffsets: indexed.outputOffsets, widths: indexed.widths }
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

const isLocallyMaintainedNode = (node: QueryNode): node is Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }> => {
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

const containsSubquery = (expression: Expr): boolean => {
  if (expression.kind === 'subquery') return true;
  if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'field' || expression.kind === 'key-of' || expression.kind === 'source-of') return false;
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') return containsSubquery(expression.left) || containsSubquery(expression.right);
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') return containsSubquery(expression.value);
  if (expression.kind === 'boolean') return expression.op === 'not' ? containsSubquery(expression.arg) : expression.args.some(containsSubquery);
  if (expression.kind === 'case') return expression.branches.some(({ when, then }) => containsSubquery(when) || containsSubquery(then)) || containsSubquery(expression.otherwise);
  if (expression.kind === 'record') return Object.values(expression.fields).some(containsSubquery);
  const expressions = expression.kind === 'array' ? expression.items : expression.args;
  return expressions.some(containsSubquery);
};

const maintainedQueryResult = (
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

const maintenanceState = (
  materializedNodeCount: number,
  updatedNodeCount: number,
  changedNodeCount: number,
  changedRelationIds: readonly string[],
  resultDelta: IncrementalQueryResultDelta,
  revision: number,
  rejectedUpdateCount: number
): IncrementalQueryMaintenanceState => Object.freeze({
  strategy: 'differential-operator-graph',
  revision,
  materializedNodeCount,
  updatedNodeCount,
  changedNodeCount,
  changedRelationIds: Object.freeze([...changedRelationIds]),
  resultDelta: Object.freeze({
    addedResultKeys: Object.freeze([...resultDelta.addedResultKeys]),
    removedResultKeys: Object.freeze([...resultDelta.removedResultKeys]),
    updatedResultKeys: Object.freeze([...resultDelta.updatedResultKeys])
  }),
  rejectedUpdateCount
});

const emptyIncrementalQueryResultDelta: IncrementalQueryResultDelta = Object.freeze({ addedResultKeys: Object.freeze([]), removedResultKeys: Object.freeze([]), updatedResultKeys: Object.freeze([]) });

const materializedQueryNodeEqual = (left: MaterializedQueryNode, right: MaterializedQueryNode, values: WeakMap<ScopedRow, string>): boolean => {
  if (left.unavailable !== right.unavailable || left.result.completeness !== right.result.completeness) return false;
  if (left.issues.length !== right.issues.length || left.issues.some((issue, index) => issue.id !== right.issues[index]?.id)) return false;
  if (left.result.rows.length !== right.result.rows.length) return false;
  return left.result.rows.every((row, index) => {
    const candidate = right.result.rows[index] as ScopedRow;
    return row === candidate || scopedRowIdentity(row, values) === scopedRowIdentity(candidate, values);
  });
};

const scopedRowIdentity = (row: ScopedRow, values: WeakMap<ScopedRow, string>): string => resultKey(row) + '\u0000' + rowValueIdentity(row, values);
const rowValueIdentity = (row: ScopedRow, values: WeakMap<ScopedRow, string>): string => {
  const cached = values.get(row);
  if (cached !== undefined) return cached;
  const identity = canonicalizeQueryValue(visibleRow(row));
  values.set(row, identity);
  return identity;
};

const validateMaintenanceSnapshot = (snapshot: QueryMaintenanceSnapshot): readonly Issue[] => {
  return validateRelationInputs(snapshot.relations, 'incremental');
};

const validateRelationInputs = (inputs: readonly RelationInput[], mode: 'query' | 'incremental'): readonly Issue[] => {
  const identities = new Set<string>();
  const issues: Issue[] = [];
  for (const input of inputs) {
    const identity = relationInputKey(input);
    if (identities.has(identity)) {
      issues.push(mode === 'incremental'
        ? incrementalQueryIssue('query.incremental_relation_ambiguous', { relationId: input.relation.relationId, attachmentId: input.attachmentId ?? null })
        : createIssue({ code: 'query.input_identity_invalid', relationId: input.relation.relationId, details: { reason: 'duplicate_attachment_input', attachmentId: input.attachmentId ?? null } }));
      continue;
    }
    identities.add(identity);
    if ((mode === 'incremental' && input.rows.length > 0 && input.occurrenceIds === undefined) || input.occurrenceIds !== undefined && (input.occurrenceIds.length !== input.rows.length || new Set(input.occurrenceIds).size !== input.occurrenceIds.length)) {
      issues.push(mode === 'incremental'
        ? incrementalQueryIssue('query.incremental_identity_invalid', { relationId: input.relation.relationId, attachmentId: input.attachmentId ?? null })
        : createIssue({ code: 'query.input_identity_invalid', relationId: input.relation.relationId, details: { reason: 'invalid_occurrence_ids', attachmentId: input.attachmentId ?? null } }));
    }
  }
  return issues;
};

type AppliedMaintenanceUpdate = { readonly success: true; readonly value: QueryMaintenanceSnapshot } | { readonly success: false; readonly issues: readonly Issue[] };

const applyQueryMaintenanceUpdate = (previous: QueryMaintenanceSnapshot, update: QueryMaintenanceUpdate): AppliedMaintenanceUpdate => {
  if (!sameOptionalJson(previous.basis, update.expectedBasis) || previous.membershipRevision !== update.expectedMembershipRevision) {
    return rejectedMaintenanceUpdate('stale_update_basis');
  }
  let current: Map<string, IndexedRelationInput>;
  try { current = new Map(indexedRelationInputs(previous.relations)); } catch { return rejectedMaintenanceUpdate('ambiguous_relation_input'); }
  const changedInputs = new Set<string>();
  for (const change of update.relations) {
    if (change.before === undefined && change.after === undefined) return rejectedMaintenanceUpdate('empty_relation_change', change.relation.relationId);
    const identity = relationInputKey({ relation: change.relation, rows: [], completeness: 'exact', ...(change.sourceId === undefined ? {} : { sourceId: change.sourceId }), ...(change.attachmentId === undefined ? {} : { attachmentId: change.attachmentId }) });
    if (changedInputs.has(identity)) return rejectedMaintenanceUpdate('duplicate_relation_change', change.relation.relationId);
    changedInputs.add(identity);
    const existing = current.get(identity);
    if (!sameRelationChangeState(existing, change.before)) return rejectedMaintenanceUpdate('stale_relation_change', change.relation.relationId);
    const existingRows = existing?.input.rows ?? [];
    const existingOccurrences = existing?.input.occurrenceIds ?? [];
    if (existingRows.length !== existingOccurrences.length) return rejectedMaintenanceUpdate('invalid_occurrence_ids', change.relation.relationId);
    const rowChanges = new Map<string, RelationRowChange>();
    for (const rowChange of change.rows) {
      if (rowChanges.has(rowChange.occurrenceId)) return rejectedMaintenanceUpdate('duplicate_occurrence_change', change.relation.relationId);
      rowChanges.set(rowChange.occurrenceId, rowChange);
    }
    const inserted = change.rows.filter(({ before, after }) => before === undefined && after !== undefined).length;
    const removed = change.rows.filter(({ before, after }) => before !== undefined && after === undefined).length;
    const nextRows = Array.from<QueryRecord | undefined>({ length: existingRows.length + inserted - removed });
    const nextOccurrences = Array.from<string | undefined>({ length: nextRows.length });
    const consumedChanges = new Set<string>();
    for (let index = 0; index < existingRows.length; index += 1) {
      const occurrenceId = existingOccurrences[index] as string;
      const row = existingRows[index] as QueryRecord;
      const rowChange = rowChanges.get(occurrenceId);
      if (rowChange === undefined) {
        nextRows[index] = row;
        nextOccurrences[index] = occurrenceId;
        continue;
      }
      consumedChanges.add(occurrenceId);
      if (!sameIndexedRow({ index, row }, rowChange.before)) return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
      if (rowChange.after !== undefined && !placeChangedRow(nextRows, nextOccurrences, occurrenceId, rowChange.after)) return rejectedMaintenanceUpdate('invalid_row_order', change.relation.relationId);
    }
    for (const rowChange of rowChanges.values()) {
      if (consumedChanges.has(rowChange.occurrenceId)) continue;
      if (rowChange.before !== undefined || rowChange.after === undefined || !placeChangedRow(nextRows, nextOccurrences, rowChange.occurrenceId, rowChange.after)) return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
    }
    if (nextRows.some((row) => row === undefined) || nextOccurrences.some((occurrence) => occurrence === undefined)) return rejectedMaintenanceUpdate('invalid_row_order', change.relation.relationId);
    if (change.after === undefined) {
      if (nextRows.length > 0) return rejectedMaintenanceUpdate('relation_removal_incomplete', change.relation.relationId);
      current.delete(identity);
      continue;
    }
    const input: RelationInput = {
      relation: change.relation,
      rows: Object.freeze(nextRows as QueryRecord[]),
      occurrenceIds: Object.freeze(nextOccurrences as string[]),
      completeness: change.after.completeness,
      ...(change.sourceId === undefined ? {} : { sourceId: change.sourceId }),
      ...(change.attachmentId === undefined ? {} : { attachmentId: change.attachmentId }),
      ...(change.after.basis === undefined ? {} : { basis: change.after.basis })
    };
    current.set(identity, { input: Object.freeze(input), index: change.after.index });
  }
  const orderedInputs = [...current.values()].sort((left, right) => left.index - right.index);
  if (orderedInputs.some(({ index }, expected) => index !== expected)) return rejectedMaintenanceUpdate('invalid_relation_order');
  const value: QueryMaintenanceSnapshot = {
    relations: Object.freeze(orderedInputs.map(({ input }) => input)),
    ...(previous.parameters === undefined ? {} : { parameters: previous.parameters }),
    ...(previous.functions === undefined ? {} : { functions: previous.functions }),
    ...(previous.executionBudget === undefined ? {} : { executionBudget: previous.executionBudget }),
    ...(update.basis === undefined ? {} : { basis: update.basis }),
    ...(update.membershipRevision === undefined ? {} : { membershipRevision: update.membershipRevision })
  };
  return { success: true, value: Object.freeze(value) };
};

const sameRelationChangeState = (current: IndexedRelationInput | undefined, expected: RelationInputChange['before']): boolean => {
  if (current === undefined || expected === undefined) return current === undefined && expected === undefined;
  return current.index === expected.index && current.input.completeness === expected.completeness && sameOptionalJson(current.input.basis, expected.basis);
};

const sameIndexedRow = (current: { readonly index: number; readonly row: QueryRecord } | undefined, expected: RelationRowChange['before']): boolean => {
  if (current === undefined || expected === undefined) return current === undefined && expected === undefined;
  return current.index === expected.index && queryValueEqual(current.row, expected.row);
};

const placeChangedRow = (
  rows: (QueryRecord | undefined)[],
  occurrences: (string | undefined)[],
  occurrenceId: string,
  changed: NonNullable<RelationRowChange['after']>
): boolean => {
  if (changed.index < 0 || changed.index >= rows.length || rows[changed.index] !== undefined || occurrences[changed.index] !== undefined) return false;
  rows[changed.index] = changed.row;
  occurrences[changed.index] = occurrenceId;
  return true;
};

const rejectedMaintenanceUpdate = (reason: string, relationId?: string): AppliedMaintenanceUpdate => ({
  success: false,
  issues: [incrementalQueryIssue('query.incremental_identity_invalid', { reason, ...(relationId === undefined ? {} : { relationId }) })]
});

const changedRelationIds = (snapshot: QueryMaintenanceSnapshot, identities: ReadonlySet<string>): readonly string[] => {
  const byIdentity = groupRelationInputs(snapshot.relations);
  return [...new Set([...identities].map((identity) => byIdentity.get(identity)?.[0]?.relation.relationId ?? identity.split('\u0000').at(-1) as string))].sort(comparePortableStrings);
};

const sameOptionalJson = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};

const sameFunctionRegistry = (left: FunctionRegistry | undefined, right: FunctionRegistry | undefined): boolean => {
  if (left === right) return true;
  const leftEntries = [...(left ?? new Map()).entries()];
  const rightMap = right ?? new Map();
  return leftEntries.length === rightMap.size && leftEntries.every(([key, implementation]) => rightMap.get(key) === implementation);
};
const sameExecutionBudget = (left: QueryExecutionBudget | undefined, right: QueryExecutionBudget | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.maxWorkUnits === right.maxWorkUnits;

const diffMaintainedResults = (
  previousRoot: MaterializedQueryNode | undefined,
  nextRoot: MaterializedQueryNode | undefined,
  values: WeakMap<ScopedRow, string>
): IncrementalQueryResultDelta => {
  // Invalidation withdraws the current assertion; it does not prove removals.
  if (nextRoot === undefined || nextRoot.unavailable || nextRoot.result.completeness === 'unknown') return emptyIncrementalQueryResultDelta;
  const beforeRows = previousRoot?.result.rows ?? [];
  const afterRows = nextRoot.result.rows;
  if (previousRoot !== undefined && nextRoot.stableChangedPositions !== undefined && beforeRows.length === afterRows.length) {
    const updatedResultKeys = nextRoot.stableChangedPositions.flatMap((index) => {
      const before = beforeRows[index];
      const after = afterRows[index];
      if (before === undefined || after === undefined) return [];
      return before === after || rowValueIdentity(before, values) === rowValueIdentity(after, values) ? [] : [resultKey(after)];
    });
    return updatedResultKeys.length === 0
      ? emptyIncrementalQueryResultDelta
      : { addedResultKeys: [], removedResultKeys: [], updatedResultKeys };
  }
  if (beforeRows.length === afterRows.length && beforeRows.every((row, index) => resultKey(row) === resultKey(afterRows[index] as ScopedRow))) {
    const updatedResultKeys = beforeRows.flatMap((row, index) => {
      const after = afterRows[index] as ScopedRow;
      return row === after || rowValueIdentity(row, values) === rowValueIdentity(after, values) ? [] : [resultKey(row)];
    });
    return updatedResultKeys.length === 0 ? emptyIncrementalQueryResultDelta : { addedResultKeys: [], removedResultKeys: [], updatedResultKeys };
  }
  const previousRows = resultIdentityMap(beforeRows, values);
  const nextRows = resultIdentityMap(afterRows, values);
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const key of new Set([...previousRows.keys(), ...nextRows.keys()])) {
    const before = previousRows.get(key);
    const after = nextRows.get(key);
    if (before === undefined) added.push(key);
    else if (after === undefined) removed.push(key);
    else if (before !== after) updated.push(key);
  }
  return { addedResultKeys: added.sort(), removedResultKeys: removed.sort(), updatedResultKeys: updated.sort() };
};

const resultIdentityMap = (rows: readonly ScopedRow[], values: WeakMap<ScopedRow, string>): ReadonlyMap<string, string> =>
  new Map(rows.map((row) => [resultKey(row), rowValueIdentity(row, values)]));

const deduplicateQueryIssues = (issues: readonly Issue[]): readonly Issue[] => [...new Map(issues.map((issue) => [issue.id, issue])).values()];

const incrementalQueryIssue = (code: string, details: JsonValue): Issue => createIssue({
  code,
  phase: 'query',
  severity: 'error',
  retry: code === 'query.incremental_session_input_changed' ? 'after_input' : 'after_refresh',
  details
});
