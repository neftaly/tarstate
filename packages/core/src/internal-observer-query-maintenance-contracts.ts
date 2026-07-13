import type { DatasetSnapshot } from './database.js';
import type { Issue } from './issues.js';
import type { AvailableQueryAttachment } from './internal-observer-dataset-capture.js';
import type { PreparedPlan } from './maintenance.js';
import type { PooledIncrementalQueryDiagnostics } from './query-model.js';
import type { JsonValue } from './value.js';

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
}) => DatabaseQueryMaintenanceSession<Query, Row, Projection>;

/** Frozen physical counters for one active shared query-maintenance cohort. */
export type QueryMaintenanceDiagnostics = PooledIncrementalQueryDiagnostics;

/** Frame-delta computations shared across parameter cohorts in this database view. */
export type QueryMaintenanceReuseDiagnostics = {
  readonly computedFrameDeltaCount: number;
  readonly reusedFrameDeltaCount: number;
};
