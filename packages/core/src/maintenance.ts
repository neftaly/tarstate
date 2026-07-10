import type { JsonValue } from './value.js';

export type SourceBasis = JsonValue;
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

export type PreparedPlan<Query = unknown> = {
  readonly planId: string;
  readonly rootNodeId: PlanNodeId;
  readonly query: Query;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
};
