/** Portable transaction construction without execution, sources, or governance. */
export * from '../../relation-delta-authoring.js';
export { sealTransaction } from '../../transaction.js';
export type {
  FieldEdit,
  InsertConflictPolicy,
  KeyedDeltaChange,
  MovePosition,
  Transaction,
  TransactionBody,
  TransactionGuard,
  WriteExpression,
  WriteRelation,
  WriteStatement,
  WriteTarget
} from '../../transaction.js';
export {
  relationAccess,
  typedFieldEdit,
  typedMove,
  typedRekey,
  typedReturning
} from '../../transaction-authoring.js';
export type {
  RelationAccessOf,
  ReturningRowOf,
  TypedReturning
} from '../../transaction-authoring.js';
