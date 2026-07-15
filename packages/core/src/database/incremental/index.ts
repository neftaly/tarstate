/** Explicit adapter between database observation and incremental query maintenance. */
export { createIncrementalDatabaseQueryMaintenance } from '../../internal-observer-query-maintenance.js';
export type {
  CreateDatabaseQueryMaintenance,
  DatabaseQueryMaintenanceInput,
  DatabaseQueryMaintenanceSession,
  MaintainedDatabaseQueryResult,
  QueryMaintenanceDiagnostics,
  QueryMaintenanceReuseDiagnostics
} from '../../observer-maintenance-contracts.js';
