/** Query and expression preparation without evaluation or incremental maintenance. */
export {
  prepareExpression,
  prepareQuery
} from '../prepare.js';
export type * from '../model.js';
export type { QueryMaintenanceSnapshot } from '../incremental-model.js';
