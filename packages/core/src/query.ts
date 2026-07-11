import { canonicalizeJson, sha256Json, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import { capabilityUnavailable, logicalAnd, logicalNot, logicalOr, logicalUnknown, missingValue, type EvaluationValue, type JsonValue, type LogicalTruth, type LogicalUnknown } from './value.js';
import type { PreparedPlan } from './maintenance.js';
import { comparePortableStrings } from './portable-order.js';

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
};

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
  readonly joinIndexes: Map<QueryNode, ReadonlyMap<string, readonly ScopedRow[]>>;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly outer?: ScopedRow;
  readonly materializedNodes?: ReadonlyMap<QueryNode, MaterializedQueryNode>;
  readonly activeNode?: QueryNode;
  unavailable: boolean;
};

type MaterializedQueryNode = {
  readonly result: NodeResult;
  readonly issues: readonly Issue[];
  readonly unavailable: boolean;
  readonly local?: {
    readonly inputs: readonly ScopedRow[];
    readonly segments: readonly LocalSegment[];
  };
  readonly join?: {
    readonly leftInputs: readonly ScopedRow[];
    readonly rightInputs: readonly ScopedRow[];
    readonly segments: readonly (readonly ScopedRow[])[];
    readonly rightIndex?: ReadonlyMap<string, readonly ScopedRow[]>;
  };
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
  const issues = [...validateRelationInputs(request.relations, 'query')];
  if (issues.length > 0) return { rows: [], resultKeys: [], completeness: 'unknown', issues };
  const context: QueryContext = {
    relations: groupRelationInputs(request.relations),
    parameters: request.parameters ?? {},
    functions: request.functions ?? new Map(),
    issues,
    recursions: new Map(),
    recursionConstants: new Map(),
    joinIndexes: new Map(),
    ...(request.basis === undefined ? {} : { basis: request.basis }),
    ...(request.membershipRevision === undefined ? {} : { membershipRevision: request.membershipRevision }),
    unavailable: false
  };
  const result = evaluateNode(request.root, context);
  if (context.unavailable || result.completeness === 'unknown') return { rows: [], resultKeys: [], completeness: 'unknown', issues };
  const rows = result.rows.map(visibleRow);
  return { rows, resultKeys: result.rows.map(resultKey), completeness: result.completeness, issues };
};

/** Seals query and authority identities into a prepared execution plan. */
export const prepareQuery = async (input: {
  readonly root: QueryNode;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
}): Promise<PreparedPlan<QueryNode>> => {
  const semantic = { root: input.root, registryFingerprint: input.registryFingerprint, authorityFingerprint: input.authorityFingerprint, datasetId: input.datasetId } as unknown as JsonValue;
  const planId = await sha256Json(semantic);
  return { planId, rootNodeId: planId + ':root', query: input.root, registryFingerprint: input.registryFingerprint, authorityFingerprint: input.authorityFingerprint, datasetId: input.datasetId };
};

const evaluateNode = (node: QueryNode, context: QueryContext): NodeResult => {
  const materialized = context.outer === undefined && node !== context.activeNode ? context.materializedNodes?.get(node) : undefined;
  if (materialized !== undefined) {
    context.issues.push(...materialized.issues);
    context.unavailable = context.unavailable || materialized.unavailable;
    return materialized.result;
  }
  const cacheable = context.outer === undefined && context.recursions.size > 0 && !containsRecursionReference(node);
  const cached = cacheable ? context.recursionConstants.get(node) : undefined;
  if (cached !== undefined) return cached;
  const result = evaluateNodeUncached(node, context);
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
    return { rows: inner.rows.filter((row) => { const key = canonicalizeQueryValue(visibleRow(row)); if (seen.has(key)) return false; seen.add(key); return true; }), completeness: inner.completeness };
  }
  if (node.kind === 'set') return evaluateSet(node, context);
  if (node.kind === 'order') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'order');
    const rows = [...inner.rows].sort((left, right) => compareOrder(left, right, node.by, context));
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
  }
  if (node.kind === 'slice') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'slice');
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
  const equality = equijoinFields(node);
  const rightIndex = equality === undefined ? undefined : indexedRows(node, right.rows, equality.right, context);
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
type EquijoinFields = { readonly left: FieldExpression; readonly right: FieldExpression };

const equijoinFields = (node: Extract<QueryNode, { readonly kind: 'join' }>): EquijoinFields | undefined => {
  if (node.on?.kind !== 'compare' || node.on.op !== 'eq' || node.on.left.kind !== 'field' || node.on.right.kind !== 'field') return undefined;
  const leftAliases = queryAliases(node.left);
  const rightAliases = queryAliases(node.right);
  if (leftAliases.has(node.on.left.alias) && rightAliases.has(node.on.right.alias)) return { left: node.on.left, right: node.on.right };
  if (leftAliases.has(node.on.right.alias) && rightAliases.has(node.on.left.alias)) return { left: node.on.right, right: node.on.left };
  return undefined;
};

const indexedRows = (node: QueryNode, rows: readonly ScopedRow[], expression: Expr, context: QueryContext): ReadonlyMap<string, readonly ScopedRow[]> => {
  const cacheable = context.outer === undefined && !containsRecursionReference(node.kind === 'join' ? node.right : node);
  const cached = cacheable ? context.joinIndexes.get(node) : undefined;
  if (cached !== undefined) return cached;
  const index = buildIndexedRows(rows, expression, context);
  if (cacheable) context.joinIndexes.set(node, index);
  return index;
};

const buildIndexedRows = (rows: readonly ScopedRow[], expression: Expr, context: QueryContext): Map<string, ScopedRow[]> => {
  const index = new Map<string, ScopedRow[]>();
  for (const row of rows) {
    const key = indexKey(expression, row, context);
    if (key === undefined) continue;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [row]);
    else bucket.push(row);
  }
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

const containsRecursionReference = (node: QueryNode): boolean => {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind === 'recursion-ref') return true;
    if (candidate.kind === 'recursive') return false;
    return Object.values(candidate).some(visit);
  };
  return visit(node);
};

const evaluateAggregate = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'aggregate');
  const groups = new Map<string, { readonly key: QueryRecord; readonly rows: ScopedRow[] }>();
  for (const row of inner.rows) {
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
  const ordered = aggregate.orderBy === undefined ? rows : [...rows].sort((left, right) => compareOrder(left, right, aggregate.orderBy ?? [], context));
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
    const comparison = compareJsonValuesTotal(value, selected);
    return aggregate.op === 'minimum' ? (comparison < 0 ? value : selected) : (comparison > 0 ? value : selected);
  });
};

const evaluateSet = (node: Extract<QueryNode, { readonly kind: 'set' }>, context: QueryContext): NodeResult => {
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (left.completeness === 'unknown' || right.completeness === 'unknown') return { rows: [], completeness: 'unknown' };
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
  for (const [field, window] of Object.entries(node.fields)) {
    const partitions = new Map<string, { readonly row: ScopedRow; readonly outputIndex: number }[]>();
    for (const [outputIndex, row] of output.entries()) {
      const partitionValues = (window.partitionBy ?? []).map((expr) => evaluateExpr(expr, exprContext(row, context)));
      if (partitionValues.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.unavailable = true;
      const key = canonicalizeJson(partitionValues.map(expressionJson));
      const rows = partitions.get(key) ?? [];
      rows.push({ row, outputIndex });
      partitions.set(key, rows);
    }
    for (const partition of partitions.values()) {
      partition.sort((left, right) => compareOrder(left.row, right.row, window.orderBy, context));
      let rank = 1;
      let previousOrder: string | undefined;
      partition.forEach(({ row, outputIndex }, index) => {
        const orderValues = window.orderBy.map((term) => evaluateExpr(term.value, exprContext(row, context)));
        if (orderValues.some((item) => item.status === 'unavailable' || item.status === 'indeterminate')) context.unavailable = true;
        const orderKey = canonicalizeJson(orderValues.map(expressionJson));
        if (previousOrder !== undefined && previousOrder !== orderKey) rank = index + 1;
        previousOrder = orderKey;
        let value: JsonValue = window.op === 'row-number' ? index + 1 : rank;
        if (window.op === 'lag') {
          const previous = partition[index - (window.offset ?? 1)]?.row;
          const lagged = previous === undefined || window.value === undefined ? undefined : evaluateExpr(window.value, exprContext(previous, context));
          if (lagged?.status === 'unavailable' || lagged?.status === 'indeterminate') context.unavailable = true;
          value = lagged === undefined ? null : expressionJson(lagged);
        }
        const aliasFields = requiredAlias(row, node.alias, context);
        if (aliasFields === undefined) return;
        output[outputIndex] = { ...row, scope: { ...row.scope, [node.alias]: { ...aliasFields, [field]: value } } };
      });
    }
  }
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows: output, completeness: 'exact' };
};

const evaluateSeek = (node: Extract<QueryNode, { readonly kind: 'seek' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'seek');
  if (context.basis === undefined || context.membershipRevision === undefined || canonicalizeJson(context.basis) !== canonicalizeJson(node.after.basis) || context.membershipRevision !== node.after.membershipRevision) {
    context.issues.push(createIssue({ code: 'query.cursor_stale', phase: 'query', severity: 'error', retry: 'after_refresh', details: { mode: node.after.mode } }));
    return { rows: [], completeness: 'unknown' };
  }
  const rows = [...inner.rows].sort((left, right) => compareOrder(left, right, node.by, context)).filter((row) => compareRowToCursor(row, node.by, node.after, context) > 0);
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
  const add = (candidate: ScopedRow): boolean => {
    const parts = node.key.map((expression) => evaluateExpr(expression, exprContext(candidate, context)));
    if (parts.some((part) => part.status === 'unavailable' || part.status === 'indeterminate')) context.unavailable = true;
    if (parts.some((part) => part.status !== 'known')) return false;
    const key = canonicalizeJson(parts.map((part) => (part as { readonly status: 'known'; readonly value: JsonValue }).value));
    if (keys.has(key)) return false;
    keys.add(key);
    rows.push(candidate);
    return true;
  };
  try {
    seed.rows.forEach(add);
    if (rows.length > maxRows) return recursionBudgetUnknown(context, 'rows', maxRows);
    let frontier = [...rows];
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      context.recursions.set(node.name, frontier);
      const step = evaluateNode(node.step, context);
      if (step.completeness !== 'exact' || context.unavailable) return { rows: [], completeness: 'unknown' };
      const next: ScopedRow[] = [];
      for (const candidate of step.rows) {
        if (add(candidate)) next.push(candidate);
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
  const scoped: ScopedRow = { scope: row, provenance: {}, identity: '' };
  const result = evaluateExpr(expression, { row: scoped, parameters: options.parameters ?? {}, functions: options.functions ?? new Map(), issues });
  if (result.status === 'known') return result.value;
  if (result.status === 'missing') return missingValue;
  if (result.status === 'unknown' || result.status === 'indeterminate') return logicalUnknown;
  return capabilityUnavailable;
};

const evaluateExpr = (expression: Expr, context: EvalContext): ExpressionResult => {
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
      const equal = canonicalizeJson(left.value) === canonicalizeJson(right.value);
      return known(expression.op === 'eq' ? equal : !equal);
    }
    const comparison = compareJsonValues(left.value, right.value);
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
    return Object.values(fields).some((value) => containsLogicalUnknown(value)) ? { status: 'unknown' } : known(fields as JsonValue);
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
      return known(fn(args.map((value) => (value as { readonly status: 'known'; readonly value: JsonValue }).value)));
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
  const comparison = compareJsonValuesTotal(left.value, right.value);
  return term.direction === 'asc' ? comparison : -comparison;
};

const compareJsonValues = (left: JsonValue, right: JsonValue): number | undefined => {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right ? 0 : left ? 1 : -1;
  if (typeof left === 'object' && typeof right === 'object') {
    const leftCanonical = canonicalizeJson(left);
    const rightCanonical = canonicalizeJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  }
  return undefined;
};

const compareJsonValuesTotal = (left: JsonValue, right: JsonValue): number => {
  const comparable = compareJsonValues(left, right);
  if (comparable !== undefined) return comparable;
  const leftCanonical = canonicalizeJson(left);
  const rightCanonical = canonicalizeJson(right);
  return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
};

const containsLogicalUnknown = (value: QueryLogicalValue): boolean => {
  if (value === logicalUnknown) return true;
  if (Array.isArray(value)) return value.some(containsLogicalUnknown);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsLogicalUnknown);
  return false;
};

/** Canonical internal equality key; tags keep logical unknown disjoint from every JSON value. */
const canonicalizeQueryValue = (value: QueryLogicalValue): string => {
  if (value === logicalUnknown) return 'u';
  if (Array.isArray(value)) return 'a[' + value.map(canonicalizeQueryValue).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, QueryLogicalValue>>;
    return 'o{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonicalizeQueryValue(record[key] as QueryLogicalValue)).join(',') + '}';
  }
  return 'j' + canonicalizeJson(value);
};

const queryValueEqual = (left: QueryLogicalValue, right: QueryLogicalValue): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => queryValueEqual(value, right[index] as QueryLogicalValue));
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Readonly<Record<string, QueryLogicalValue>>;
  const rightRecord = right as Readonly<Record<string, QueryLogicalValue>>;
  let leftCount = 0;
  for (const key in leftRecord) {
    if (!Object.hasOwn(leftRecord, key)) continue;
    leftCount += 1;
    if (!Object.hasOwn(rightRecord, key) || !queryValueEqual(leftRecord[key] as QueryLogicalValue, rightRecord[key] as QueryLogicalValue)) return false;
  }
  let rightCount = 0;
  for (const key in rightRecord) if (Object.hasOwn(rightRecord, key)) rightCount += 1;
  return leftCount === rightCount;
};

const nonMonotoneUnknown = (context: QueryContext, operator: string): NodeResult => {
  context.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', details: { reason: 'incomplete_non_monotone', operator } }));
  return { rows: [], completeness: 'unknown' };
};

/** Pure shell adapter from two snapshots to the exact update consumed by maintenance. */
export const diffQueryMaintenanceSnapshots = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): QueryMaintenanceUpdate => {
  if (!sameOptionalJson(previous.parameters, next.parameters) || !sameFunctionRegistry(previous.functions, next.functions)) {
    throw new TypeError('Query maintenance parameters and functions are fixed for the session');
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
  const graph = compileQueryGraph(plan.query);
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  let acceptedSnapshot = initialSnapshot;
  let closed = false;
  let revision = 0;
  let rejectedUpdateCount = 0;
  const valueIdentities = new WeakMap<ScopedRow, string>();

  const initialIssues = validateMaintenanceSnapshot(initialSnapshot);
  if (initialIssues.length === 0) {
    for (const node of graph.nodes) materialized.set(node, materializeQueryNode(node, initialSnapshot, materialized));
  }
  let current = maintainedQueryResult(
    initialIssues.length === 0 ? materialized.get(plan.query) : undefined,
    initialIssues,
    maintenanceState(graph.nodes.length, graph.nodes.length, graph.nodes.length, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount)
  );
  let assertedRoot = initialIssues.length === 0 ? materialized.get(plan.query) : undefined;

  return {
    getCurrentResult: () => current,
    applyUpdate: (update) => {
      if (closed) throw new Error('Incremental query maintenance session is closed');
      revision += 1;
      const applied = applyQueryMaintenanceUpdate(acceptedSnapshot, update);
      if (!applied.success) {
        rejectedUpdateCount += 1;
        current = maintainedQueryResult(
          undefined,
          applied.issues,
          maintenanceState(graph.nodes.length, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount)
        );
        assertedRoot = undefined;
        return current;
      }

      const nextSnapshot = applied.value;
      const changedRelations = new Set(update.relations.map(({ relation }) => relationKey(relation)));
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
        const nextNode = node.kind === 'from'
          ? incrementallyMaterializeFrom(node, nextSnapshot, update, previousNode)
          : node.kind === 'join'
            ? incrementallyMaterializeJoin(node, nextSnapshot, materialized, previousNode)
          : isLocallyMaintainedNode(node)
            ? incrementallyMaterializeLocal(node, nextSnapshot, materialized, previousNode)
            : materializeQueryNode(node, nextSnapshot, materialized);
        materialized.set(node, nextNode);
        updatedNodeCount += 1;
        if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode, valueIdentities)) changedNodes.add(node);
      }
      acceptedSnapshot = nextSnapshot;
      const root = materialized.get(plan.query);
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
        )
      );
      assertedRoot = root;
      return current;
    },
    close: () => {
      if (closed) return;
      closed = true;
      materialized.clear();
    }
  };
};

type PooledPhysicalNode = {
  readonly key: string;
  readonly children: readonly QueryNode[];
  readonly externalDependencies: ReadonlySet<string>;
  readonly sessionEvidenceDependency: boolean;
  references: number;
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
  const environment = input.environment;
  if (!sameOptionalJson(environment.parameters, input.initialSnapshot.parameters)) {
    throw new TypeError('Pooled query environment parameters do not match the initial snapshot');
  }
  if (!sameFunctionRegistry(environment.functions, input.initialSnapshot.functions)) {
    throw new TypeError('Pooled query environment functions do not match the initial snapshot');
  }

  const interned = new Map<string, InternedPooledNode>();
  const internedByNode = new Map<QueryNode, InternedPooledNode>();
  let nextInternedNodeId = 0;
  const physical = new Map<QueryNode, PooledPhysicalNode>();
  let physicalOrder: QueryNode[] = [];
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  const roots = new Set<PooledRootState>();
  let valueIdentities = new WeakMap<ScopedRow, string>();
  let acceptedSnapshot = input.initialSnapshot;
  let runtimeIssues = validateMaintenanceSnapshot(input.initialSnapshot);
  let revision = 0;
  let rejectedUpdateCount = 0;
  let closed = false;
  let executionPhase: 'idle' | 'attaching' | 'updating' = 'idle';
  let closeRequested = false;
  const deferredReleases = new Set<PooledRootState>();
  let diagnostics = pooledDiagnostics(environment.runtimeIdentity, 0, 0, 0, 0, 0, 0, 0, 0);

  const refreshDiagnostics = (updated: number, changed: number, collected: number): void => {
    let shared = 0;
    for (const node of physical.values()) if (node.references > 1) shared += 1;
    diagnostics = pooledDiagnostics(
      environment.runtimeIdentity,
      revision,
      roots.size,
      physical.size,
      shared,
      updated,
      changed,
      collected,
      rejectedUpdateCount
    );
  };

  const releaseNow = (root: PooledRootState): void => {
    if (root.closed) return;
    root.closed = true;
    roots.delete(root);
    let collected = 0;
    for (const node of root.reachable) {
      const record = physical.get(node);
      if (record === undefined) continue;
      record.references -= 1;
      if (record.references !== 0) continue;
      physical.delete(node);
      materialized.delete(node);
      if (interned.get(record.key)?.node === node) interned.delete(record.key);
      internedByNode.delete(node);
      collected += 1;
    }
    if (collected > 0) physicalOrder = physicalOrder.filter((node) => physical.has(node));
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
    if (plan.registryFingerprint !== environment.registryFingerprint) throw new TypeError('Prepared plan registry fingerprint does not match pooled query environment');
    if (plan.authorityFingerprint !== environment.authorityFingerprint) throw new TypeError('Prepared plan authority fingerprint does not match pooled query environment');
    if (plan.datasetId !== environment.datasetId) throw new TypeError('Prepared plan dataset does not match pooled query environment');
    assertPoolableQuery(plan.query);
    const detachedRoot = cloneAndFreezeQueryAst(plan.query);
    const createdInterned: InternedPooledNode[] = [];
    const stagedMaterialized: QueryNode[] = [];
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
      const state: PooledRootState = {
        root: canonicalRoot,
        reachable,
        current: maintainedQueryResult(
          rootMaterialized,
          runtimeIssues,
          maintenanceState(reachable.size, reachable.size, reachable.size, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount)
        ),
        asserted: rootMaterialized,
        closed: false
      };
      for (const node of graph.nodes) {
        const existing = physical.get(node);
        if (existing !== undefined) {
          existing.references += 1;
          continue;
        }
        const identity = internedByNode.get(node) as InternedPooledNode;
        physical.set(node, {
          key: identity.key,
          children: graph.children.get(node) as readonly QueryNode[],
          externalDependencies: graph.externalDependencies.get(node) as ReadonlySet<string>,
          sessionEvidenceDependency: graph.sessionEvidenceDependencies.get(node) === true,
          references: 1
        });
        physicalOrder.push(node);
      }
      roots.add(state);
      refreshDiagnostics(newNodes.length, newNodes.length, 0);
      return {
        getCurrentResult: () => state.current,
        close: () => release(state)
      };
    } catch (error) {
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
          maintenanceState(root.reachable.size, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount)
        );
        root.asserted = undefined;
      }
      refreshDiagnostics(0, 0, 0);
      return;
    }

    const nextSnapshot = applied.value;
    runtimeIssues = [];
    const changedRelations = new Set(update.relations.map(({ relation }) => relationKey(relation)));
    const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
      || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
    const updatedNodes = new Set<QueryNode>();
    const changedNodes = new Set<QueryNode>();
    for (const node of physicalOrder) {
      const record = physical.get(node) as PooledPhysicalNode;
      const previousNode = materialized.get(node);
      const childChanged = record.children.some((child) => changedNodes.has(child));
      const externalInputChanged = [...record.externalDependencies].some((key) => changedRelations.has(key));
      const evidenceInputChanged = sessionEvidenceChanged && record.sessionEvidenceDependency;
      // Roots may attach while the runtime is invalidated. A successful
      // transition, including an A -> A recovery, must initialize every
      // missing physical node before results can be asserted again.
      if (previousNode !== undefined && !evidenceInputChanged && !childChanged && !externalInputChanged) continue;
      const nextNode = node.kind === 'from'
        ? incrementallyMaterializeFrom(node, nextSnapshot, update, previousNode)
        : node.kind === 'join'
          ? incrementallyMaterializeJoin(node, nextSnapshot, materialized, previousNode)
        : isLocallyMaintainedNode(node)
          ? incrementallyMaterializeLocal(node, nextSnapshot, materialized, previousNode)
          : materializeQueryNode(node, nextSnapshot, materialized);
      if (!journal.materialized.has(node)) journal.materialized.set(node, previousNode);
      materialized.set(node, nextNode);
      updatedNodes.add(node);
      if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode, valueIdentities)) changedNodes.add(node);
    }
    acceptedSnapshot = nextSnapshot;
    const changedIds = changedRelationIds(nextSnapshot, changedRelations);
    for (const root of roots) {
      const nextRoot = materialized.get(root.root);
      let updated = 0;
      let changed = 0;
      for (const node of root.reachable) {
        if (updatedNodes.has(node)) updated += 1;
        if (changedNodes.has(node)) changed += 1;
      }
      const nextCurrent = maintainedQueryResult(
        nextRoot,
        [],
        maintenanceState(
          root.reachable.size,
          updated,
          changed,
          changedIds,
          diffMaintainedResults(root.asserted, nextRoot, valueIdentities),
          revision,
          rejectedUpdateCount
        )
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
      applyUpdateNow(update, journal);
    } catch (error) {
      acceptedSnapshot = checkpoint.acceptedSnapshot;
      runtimeIssues = checkpoint.runtimeIssues;
      revision = checkpoint.revision;
      rejectedUpdateCount = checkpoint.rejectedUpdateCount;
      diagnostics = checkpoint.diagnostics;
      for (const [node, value] of journal.materialized) {
        if (value === undefined) materialized.delete(node);
        else materialized.set(node, value);
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

const cloneAndFreezeQueryAst = (root: QueryNode): QueryNode => {
  const clones = new WeakMap<object, object>();
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const prior = clones.get(value);
    if (prior !== undefined) return prior;
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      clones.set(value, output);
      for (const item of value) output.push(clone(item));
      return Object.freeze(output);
    }
    const output: Record<string, unknown> = {};
    clones.set(value, output);
    for (const [key, item] of Object.entries(value)) output[key] = clone(item);
    return Object.freeze(output);
  };
  return clone(root) as QueryNode;
};

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
  if (node.kind === 'join' && equijoinFields(node) !== undefined && !materialized.unavailable && materialized.issues.length === 0) {
    const left = materializedNodes.get(node.left);
    const right = materializedNodes.get(node.right);
    if (left !== undefined && right !== undefined && !left.unavailable && !right.unavailable) return { ...materialized, join: indexJoinSegments(node, left.result.rows, right.result.rows, materialized.result.rows) };
  }
  if (!isLocallyMaintainedNode(node) || materialized.unavailable || materialized.issues.length > 0) return materialized;
  const child = materializedNodes.get(node.input);
  if (child === undefined || child.unavailable || child.result.completeness === 'unknown') return materialized;
  return { ...materialized, local: indexLocalSegments(node, child.result.rows, materialized.result.rows) };
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
    joinIndexes: new Map(),
    ...(snapshot.basis === undefined ? {} : { basis: snapshot.basis }),
    ...(snapshot.membershipRevision === undefined ? {} : { membershipRevision: snapshot.membershipRevision }),
    materializedNodes,
    activeNode,
    unavailable: false
  });

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
  const rightIndex = rightUnchanged && previous.join.rightIndex !== undefined ? previous.join.rightIndex : buildIndexedRows(right.result.rows, equality.right, context);
  const affectedRightKeys = rightUnchanged ? new Set<string>() : changedExpressionKeys(previous.join.rightInputs, right.result.rows, equality.right, context);
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
  if (inputs === undefined || inputs.some(({ completeness }) => completeness === 'unknown') || previous === undefined || previous.unavailable) {
    return evaluateMaterializedQueryNode(node, snapshot, new Map());
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
  return { result: { rows, completeness: inputs.some(({ completeness }) => completeness === 'lower-bound') ? 'lower-bound' : 'exact' }, issues: [], unavailable: false };
};

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
  const segments: LocalSegment[] = [];
  const inputs: ScopedRow[] = [];
  const output: ScopedRow[] = [];
  const issues: Issue[] = [];
  let unavailable = false;
  let previousPositions: ReadonlyMap<string, number> | undefined;
  for (let index = 0; index < child.result.rows.length; index += 1) {
    const row = child.result.rows[index] as ScopedRow;
    const key = resultKey(row);
    inputs.push(row);
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
      appendLocalSegment(output, retained);
      continue;
    }
    const overrides = new Map(materializedNodes);
    overrides.set(node.input, { result: { rows: [row], completeness: child.result.completeness }, issues: [], unavailable: false });
    const segment = evaluateMaterializedQueryNode(node, snapshot, overrides);
    issues.push(...segment.issues);
    unavailable = unavailable || segment.unavailable;
    const next = localSegment(node, segment.result.rows);
    segments.push(next);
    appendLocalSegment(output, next);
  }
  if (unavailable || issues.length > 0) return materializeQueryNode(node, snapshot, materializedNodes);
  return {
    result: { rows: output, completeness: child.result.completeness },
    issues: [],
    unavailable: false,
    local: { inputs, segments }
  };
};

const indexLocalSegments = (
  node: Extract<QueryNode, { readonly kind: 'where' | 'select' | 'with-fields' | 'rename' | 'omit' | 'unnest' }>,
  inputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[]
): NonNullable<MaterializedQueryNode['local']> => {
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
  return { inputs, segments };
};

const localSegment = (node: QueryNode, rows: readonly ScopedRow[]): LocalSegment => node.kind === 'unnest' ? rows : rows[0];
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
  state: IncrementalQueryMaintenanceState
): IncrementalQueryResult => {
  const issues = deduplicateQueryIssues([...(root?.issues ?? []), ...additionalIssues]);
  if (root === undefined || root.unavailable || root.result.completeness === 'unknown') {
    return { rows: [], resultKeys: [], completeness: 'unknown', issues, state };
  }
  return {
    rows: root.result.rows.map(visibleRow),
    resultKeys: root.result.rows.map(resultKey),
    completeness: root.result.completeness,
    issues,
    state
  };
};

const maintenanceState = (
  materializedNodeCount: number,
  updatedNodeCount: number,
  changedNodeCount: number,
  changedRelationIds: readonly string[],
  resultDelta: IncrementalQueryResultDelta,
  revision: number,
  rejectedUpdateCount: number
): IncrementalQueryMaintenanceState => ({
  strategy: 'differential-operator-graph',
  revision,
  materializedNodeCount,
  updatedNodeCount,
  changedNodeCount,
  changedRelationIds,
  resultDelta,
  rejectedUpdateCount
});

const emptyIncrementalQueryResultDelta: IncrementalQueryResultDelta = Object.freeze({ addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] });

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
    for (const rowChange of change.rows) {
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
      rows: nextRows as QueryRecord[],
      occurrenceIds: nextOccurrences as string[],
      completeness: change.after.completeness,
      ...(change.sourceId === undefined ? {} : { sourceId: change.sourceId }),
      ...(change.attachmentId === undefined ? {} : { attachmentId: change.attachmentId }),
      ...(change.after.basis === undefined ? {} : { basis: change.after.basis })
    };
    current.set(identity, { input, index: change.after.index });
  }
  const orderedInputs = [...current.values()].sort((left, right) => left.index - right.index);
  if (orderedInputs.some(({ index }, expected) => index !== expected)) return rejectedMaintenanceUpdate('invalid_relation_order');
  const value: QueryMaintenanceSnapshot = {
    relations: orderedInputs.map(({ input }) => input),
    ...(previous.parameters === undefined ? {} : { parameters: previous.parameters }),
    ...(previous.functions === undefined ? {} : { functions: previous.functions }),
    ...(update.basis === undefined ? {} : { basis: update.basis }),
    ...(update.membershipRevision === undefined ? {} : { membershipRevision: update.membershipRevision })
  };
  return { success: true, value };
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

const diffMaintainedResults = (
  previousRoot: MaterializedQueryNode | undefined,
  nextRoot: MaterializedQueryNode | undefined,
  values: WeakMap<ScopedRow, string>
): IncrementalQueryResultDelta => {
  // Invalidation withdraws the current assertion; it does not prove removals.
  if (nextRoot === undefined || nextRoot.unavailable || nextRoot.result.completeness === 'unknown') return emptyIncrementalQueryResultDelta;
  const beforeRows = previousRoot?.result.rows ?? [];
  const afterRows = nextRoot.result.rows;
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
