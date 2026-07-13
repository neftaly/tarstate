import type { ArtifactRef } from './artifacts.js';
import type { CapabilityRef, Issue } from './issues.js';
import type { PreparedPlan } from './maintenance.js';
import type { JsonValue, LogicalUnknown } from './value.js';

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
/** Key with `capabilityRefKey`; legacy NUL-delimited keys remain accepted for NUL-free references. */
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
 * `maxWorkUnits` must be a nonnegative safe integer; zero permits no charged
 * work. Omission preserves unlimited execution.
 */
export type QueryExecutionBudget = { readonly maxWorkUnits: number };

/** Changing inputs for repeated evaluation of an already prepared query. */
export type PreparedQueryRequest = Omit<QueryRequest, 'root'>;

declare const preparedExpressionBrand: unique symbol;
/** Owned expression syntax accepted by the prepared scalar evaluator. */
export type PreparedExpression = {
  readonly [preparedExpressionBrand]: true;
  readonly expression: Expr;
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

/**
 * Occurrence-identity changes from the previously accepted result to the
 * current available exact or lower-bound materialization. Each array should be
 * consumed as a set; ordering is deterministic but is not a public sorting
 * guarantee.
 *
 * - `addedResultKeys`: identities absent before and asserted by the new result.
 * - `removedResultKeys`: identities asserted before and absent from the new result.
 * - `updatedResultKeys`: retained identities whose visible row value changed.
 *
 * Rejected updates and invalidation to unknown completeness report empty arrays:
 * withdrawing an assertion does not prove that its rows were removed. Recovery
 * from an unknown result republishes the recovered identities as additions.
 */
export type IncrementalQueryResultDelta = {
  readonly addedResultKeys: readonly string[];
  readonly removedResultKeys: readonly string[];
  readonly updatedResultKeys: readonly string[];
};

/**
 * Physical operator families reported by incremental-maintenance diagnostics.
 *
 * The corresponding diagnostics record contains every operator in this union,
 * including operators with all-zero counters. New operator families may be
 * added in a future release, so persisted or remotely transported diagnostics
 * should be decoded as telemetry rather than as a versioned wire format.
 */
export type QueryMaintenanceOperator = 'local' | 'join' | 'distinct' | 'order' | 'aggregate' | 'window' | 'slice' | 'set';

/**
 * Why an evaluated physical node used semantic rematerialization. The set may
 * grow as new fallback boundaries become observable; branch defensively when
 * diagnostics cross package-version or process boundaries.
 */
export type QueryMaintenanceFallbackReason = 'unsupported_expression' | 'state_unavailable' | 'input_unavailable' | 'unstable_layout' | 'evaluation_unavailable';

/**
 * Per-operator telemetry for one maintenance transition.
 *
 * Each evaluated physical node contributes to exactly one strategy count:
 * `selectiveNodeCount` when a subset was maintained, `fullNodeCount` when the
 * operator's full-input path ran, or `fallbackNodeCount` when semantic
 * rematerialization ran. These are operational observations, not correctness
 * or complexity guarantees; thresholds and chosen strategies may evolve.
 *
 * `affectedUnitCount` is the sum of the logical affected scope reported by
 * those nodes. It is not a count of CPU operations. Its unit depends on the
 * operator and strategy:
 *
 * - `local`: input row/segment positions evaluated or changed.
 * - `join`: left-row segments evaluated (including those affected by a
 *   right-side change).
 * - `distinct`: distinct value classes for selective maintenance; input rows
 *   for full maintenance.
 * - `order`: changed/new input rows that selected the maintenance path.
 * - `aggregate`: changed input positions for selective maintenance; input rows
 *   for full maintenance.
 * - `window`: row positions whose window output was targeted or recomputed.
 * - `slice`: changed output positions for selective maintenance.
 * - `set`: changed output positions for selective maintenance.
 *
 * A fallback reports the best available affected scope in that operator's
 * units, commonly the available input cardinality or the positions that
 * triggered fallback; it may be zero when the input itself is unavailable.
 *
 * Consequently, `affectedUnitCount` is useful for comparing like-for-like
 * transitions of one operator, but must not be summed across operator families
 * as a normalized cost metric.
 */
export type QueryOperatorMaintenanceDiagnostics = {
  /** Evaluated physical nodes that maintained a subset of their input. */
  readonly selectiveNodeCount: number;
  /** Evaluated physical nodes that ran their operator-specific full path. */
  readonly fullNodeCount: number;
  /** Evaluated physical nodes that used semantic rematerialization. */
  readonly fallbackNodeCount: number;
  /** Operator-specific affected units, as defined on this type. */
  readonly affectedUnitCount: number;
  /**
   * Persistent maintenance-index compactions performed in this transition,
   * excluding DAG garbage collection. One node may compact multiple indexes.
   */
  readonly compactionCount: number;
  /**
   * Sparse histogram of reasons for fallback nodes in this transition. Counts
   * sum to `fallbackNodeCount`; reasons with zero occurrences are omitted.
   */
  readonly fallbackReasons: Readonly<Partial<Record<QueryMaintenanceFallbackReason, number>>>;
};

/**
 * Complete, frozen diagnostics for the current operator set. Every key is
 * present and has zero-valued counters when no node of that family ran.
 */
export type QueryMaintenanceOperatorDiagnostics = Readonly<Record<QueryMaintenanceOperator, QueryOperatorMaintenanceDiagnostics>>;

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
  /**
   * Physical operator decisions for the transition that produced this result.
   * The record is reset on every accepted or rejected `applyUpdate`; the
   * initial result contains zero counters. Counts contain no keys or row values.
   */
  readonly operatorDiagnostics: QueryMaintenanceOperatorDiagnostics;
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
  /**
   * Decisions for the last runtime update across distinct evaluated physical
   * nodes. Each shared node is counted once, not once per attached root.
   * Runtime lifecycle operations (`attach`, root closure, runtime closure)
   * reset this record to zero counters, as does a rejected update with no node
   * evaluation. Per-root result diagnostics instead count the evaluated nodes
   * reachable by that root.
   */
  readonly operatorDiagnostics: QueryMaintenanceOperatorDiagnostics;
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
