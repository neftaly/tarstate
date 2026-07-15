import type { JsonValue } from './value.js';

export type { PreparedPlan } from './query-plan-contract.js';
export { preparePlan } from './query-plan.js';
export type { SourceBasis } from './source-state.js';
export type RowOccurrenceId = string;
export type PlanNodeId = string;

export type LogicalRow<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = {
  readonly occurrenceId: RowOccurrenceId;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly relationId: string;
  readonly key: JsonValue;
  readonly locator: JsonValue;
  readonly fields: Row;
};
