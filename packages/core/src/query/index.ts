/** Typed query authoring, evaluation, preparation, and incremental maintenance. */
export {
  diffQueryMaintenanceSnapshots,
  evaluateExpression,
  evaluatePreparedQuery,
  evaluateQuery,
  openIncrementalQueryMaintenance,
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
  PreparedQueryRequest,
  QueryCursor,
  QueryExecutionBudget,
  QueryFunction,
  QueryLogicalValue,
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
export * from '../query-builder.js';
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
  typedPreparedPlan,
  typedQueryBody,
  typedSelect,
  typedSourceOf,
  typedWhere
} from '../type-authoring.js';
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
} from '../type-authoring.js';
