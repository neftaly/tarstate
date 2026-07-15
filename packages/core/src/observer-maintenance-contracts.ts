import type { DatabaseAttachment, DatasetMember, DatasetSnapshot } from './database-model.js';
import { createIssue, type Issue } from './issues.js';
import type { PreparedPlan } from './query-plan-contract.js';
import type { SourceSnapshot } from './source-state.js';
import type { JsonValue } from './value.js';

export type AvailableQueryAttachment<Projection> = {
  readonly member: DatasetMember;
  readonly attachment: DatabaseAttachment<unknown, Projection>;
  readonly snapshot: SourceSnapshot<unknown>;
  readonly projection: Projection;
};

export type DatabaseQueryMaintenanceInput<Query, Projection> = {
  readonly query: Query;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly dataset: DatasetSnapshot;
  readonly attachments: readonly AvailableQueryAttachment<Projection>[];
};

export type MaintainedDatabaseQueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export interface DatabaseQueryMaintenanceSession<Query, Row, Projection> {
  getCurrentResult(): MaintainedDatabaseQueryResult<Row>;
  updateInput(input: DatabaseQueryMaintenanceInput<Query, Projection>): MaintainedDatabaseQueryResult<Row>;
  close(): void;
}

export type CreateDatabaseQueryMaintenance<Query, Row, Projection> = (input: {
  readonly plan: PreparedPlan<Query>;
  readonly initialInput: DatabaseQueryMaintenanceInput<Query, Projection>;
  /** Observer-owned identity permitting an implementation to share work within one database runtime. */
  readonly reuseScope?: object;
}) => DatabaseQueryMaintenanceSession<Query, Row, Projection>;

/** Optional physical counters exposed by a maintenance implementation. */
export type QueryMaintenanceDiagnostics = {
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
  readonly operatorDiagnostics: unknown;
};

/** Frame-delta computations shared across parameter cohorts in this database view. */
export type QueryMaintenanceReuseDiagnostics = {
  readonly computedFrameDeltaCount: number;
  readonly reusedFrameDeltaCount: number;
};

/** Trusted change evidence used only to optimize observer publication. */
export type TrustedQueryMaintenanceMetadata = {
  readonly revision: number;
  readonly resultDelta: {
    readonly addedResultKeys: readonly string[];
    readonly removedResultKeys: readonly string[];
    readonly updatedResultKeys: readonly string[];
  };
  readonly resultKeyPositions: ReadonlyMap<string, number>;
};

export type QueryMaintenanceExtensions<Row> = {
  readonly diagnostics: (reuseScope: object) => readonly QueryMaintenanceDiagnostics[];
  readonly reuseDiagnostics: (reuseScope: object) => QueryMaintenanceReuseDiagnostics;
  /** Must return evidence only for results produced by this exact factory. */
  readonly trustedMetadata: (result: MaintainedDatabaseQueryResult<Row>) => TrustedQueryMaintenanceMetadata | undefined;
};

const extensionsByFactory = new WeakMap<object, QueryMaintenanceExtensions<unknown>>();

/** Registers optional observer optimizations without changing correctness behavior. */
export const registerQueryMaintenanceExtensions = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>,
  extensions: QueryMaintenanceExtensions<Row>
): void => {
  if (extensionsByFactory.has(factory)) throw new TypeError('Query maintenance extensions are already registered for this factory');
  extensionsByFactory.set(factory, Object.freeze(extensions) as QueryMaintenanceExtensions<unknown>);
};

export const queryMaintenanceExtensionsFor = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>
): QueryMaintenanceExtensions<Row> | undefined =>
  extensionsByFactory.get(factory) as QueryMaintenanceExtensions<Row> | undefined;

export const failedMaintenanceSession = <Query, Row, Projection>(
  error: unknown
): DatabaseQueryMaintenanceSession<Query, Row, Projection> => {
  const result = failedMaintenanceEvaluation(error) as MaintainedDatabaseQueryResult<Row>;
  return { getCurrentResult: () => result, updateInput: () => result, close: () => undefined };
};

export const failedMaintenanceEvaluation = (error: unknown): MaintainedDatabaseQueryResult<never> => ({
  rows: [],
  resultKeys: [],
  completeness: 'unknown',
  issues: [createIssue({
    code: 'observer.evaluation_failed',
    phase: 'query',
    severity: 'error',
    retry: 'after_refresh',
    details: { error: error instanceof Error ? error.name : typeof error }
  })]
});
