/** Storage-independent logical edits, source state, and live source protocols. */
export type {
  Footprint,
  FootprintRelation,
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
export * from '../source-protocol.js';
export * from '../source-state.js';
