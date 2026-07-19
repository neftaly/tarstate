/** Transaction authoring, commit coordination, receipts, and lifecycle governance. */
export * from '../commit-coordinator.js';
export * from '../lifecycle-governance.js';
export type * from '../non-atomic-batch-model.js';
export * from '../non-atomic-batch.js';
export type {
  Footprint,
  FootprintRelation,
  GeneratedLogicalKey,
  LogicalEdit,
  LogicalEditTarget,
  LogicalReplaceFieldsEdit,
  LogicalReplaceRowEdit,
  LogicalSemanticEdit,
  PlannedEditHandling,
  ProjectionResult,
  WritableLogicalRow,
  WritableLogicalState
} from '../logical-edit.js';
export * from '../receipts.js';
export * from '../transaction.js';
export { isValidUtf16TextSplice, type TextSpliceRange } from '../internal-text-splice.js';
export type * from '../database/transaction.js';
export {
  relationAccess,
  typedFieldEdit,
  typedMove,
  typedRekey,
  typedReturning
} from '../transaction-authoring.js';
export type {
  RelationAccessOf,
  ReturningRowOf,
  TypedReturning
} from '../transaction-authoring.js';
