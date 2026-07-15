import type { PreparedPlan } from './query-plan-contract.js';
import type {
  Completeness,
  FunctionRegistry,
  QueryExecutionBudget,
  QueryNode,
  QueryRecord,
  QueryResult,
  RelationInput,
  RelationUse
} from './query-model.js';
import type { JsonValue } from './value.js';

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
  readonly occurrenceId: string;
  readonly before?: { readonly index: number; readonly row: QueryRecord };
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
  readonly expectedBasis?: JsonValue;
  readonly basis?: JsonValue;
  readonly expectedMembershipRevision?: number;
  readonly membershipRevision?: number;
  readonly relations: readonly RelationInputChange[];
};

/** Proven result-identity changes from one accepted maintenance state to the next. */
export type IncrementalQueryResultDelta = {
  readonly addedResultKeys: readonly string[];
  readonly removedResultKeys: readonly string[];
  readonly updatedResultKeys: readonly string[];
};

export type QueryMaintenanceOperator = 'local' | 'join' | 'distinct' | 'order' | 'aggregate' | 'window' | 'slice' | 'set';

export type QueryMaintenanceFallbackReason =
  | 'unsupported_expression'
  | 'state_unavailable'
  | 'input_unavailable'
  | 'unstable_layout'
  | 'evaluation_unavailable';

/** Operational telemetry, not a correctness or normalized-cost guarantee. */
export type QueryOperatorMaintenanceDiagnostics = {
  readonly selectiveNodeCount: number;
  readonly fullNodeCount: number;
  readonly fallbackNodeCount: number;
  readonly affectedUnitCount: number;
  readonly compactionCount: number;
  readonly fallbackReasons: Readonly<Partial<Record<QueryMaintenanceFallbackReason, number>>>;
};

export type QueryMaintenanceOperatorDiagnostics = Readonly<Record<QueryMaintenanceOperator, QueryOperatorMaintenanceDiagnostics>>;

export type IncrementalQueryMaintenanceState = {
  readonly strategy: 'differential-operator-graph';
  readonly revision: number;
  readonly materializedNodeCount: number;
  readonly updatedNodeCount: number;
  readonly changedNodeCount: number;
  readonly changedRelationIds: readonly string[];
  readonly resultDelta: IncrementalQueryResultDelta;
  readonly rejectedUpdateCount: number;
  readonly operatorDiagnostics: QueryMaintenanceOperatorDiagnostics;
};

export type IncrementalQueryResult = QueryResult & { readonly state: IncrementalQueryMaintenanceState };

export interface IncrementalQueryMaintenanceSession {
  getCurrentResult(): IncrementalQueryResult;
  applyUpdate(update: QueryMaintenanceUpdate): IncrementalQueryResult;
  close(): void;
}

export type PooledIncrementalQueryEnvironment = {
  readonly runtimeIdentity: string;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly executionBudget?: QueryExecutionBudget;
};

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
  readonly operatorDiagnostics: QueryMaintenanceOperatorDiagnostics;
};

export interface PooledIncrementalQueryRoot {
  getCurrentResult(): IncrementalQueryResult;
  close(): void;
}

/** Explicit multi-root runtime with exact portable subtree interning. */
export interface PooledIncrementalQueryRuntime {
  attach(plan: PreparedPlan<QueryNode>): PooledIncrementalQueryRoot;
  applyUpdate(update: QueryMaintenanceUpdate): void;
  getDiagnostics(): PooledIncrementalQueryDiagnostics;
  close(): void;
}
