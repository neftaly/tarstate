/** Typed query authoring, evaluation, preparation, and incremental maintenance. */
export {
  capabilityRefKey,
  diffQueryMaintenanceSnapshots,
  evaluateExpression,
  evaluateQuery,
  openIncrementalQueryMaintenance,
  prepareExpression,
  prepareQuery
} from '../query.js';
export type {
  AggregateExpr,
  Completeness,
  Expr,
  FunctionRegistry,
  IncrementalQueryMaintenanceSession,
  IncrementalQueryMaintenanceState,
  IncrementalQueryResult,
  IncrementalQueryResultDelta,
  OrderTerm,
  PreparedExpression,
  QueryCursor,
  QueryExecutionBudget,
  QueryFunction,
  QueryLogicalValue,
  QueryMaintenanceFallbackReason,
  QueryMaintenanceOperator,
  QueryMaintenanceOperatorDiagnostics,
  QueryOperatorMaintenanceDiagnostics,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  QueryNode,
  QueryRecord,
  QueryRequest,
  QueryResult,
  RelationInput,
  RelationInputChange,
  RelationRowChange,
  RelationUse,
  WindowExpr
} from '../query.js';
export type { PreparedPlan } from './plan-contract.js';
export * from './builder.js';
export {
  prepareTypedQuery,
  typedAnd,
  typedCompare,
  typedFrom,
  typedIsMissing,
  typedIsNull,
  typedJoin,
  typedLiteral,
  typedNot,
  typedOr,
  typedOrderBy,
  typedParameter,
  typedQueryBody,
  typedSelect,
  typedSourceOf,
  typedWhere
} from './authoring.js';
export type {
  PreparedPlanParameters,
  PreparedPlanRow,
  QueryParametersOf,
  QueryResultRowOf,
  TypedAlias,
  TypedAliases,
  TypedExpression,
  TypedOrderTerm,
  TypedPreparedPlan,
  TypedQuery
} from './authoring.js';
