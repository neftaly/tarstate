/** Query and expression preparation without evaluation or incremental maintenance. */
export {
  prepareExpression,
  prepareQuery
} from '../../query-prepare.js';
export type * from '../../query-model.js';
export type { QueryMaintenanceSnapshot } from '../../query-incremental-model.js';
