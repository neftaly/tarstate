import { defaultValueParseBudget, type JsonValue } from './value.js';
import { sha256Json } from './artifacts.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { sealOwnedPreparedPlan } from './internal-prepared-plan.js';

export type SourceBasis = JsonValue;
export type RowOccurrenceId = string;
export type PlanNodeId = string;

declare const preparedPlanBrand: unique symbol;

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
  /** Compile-time evidence that this value passed through a plan preparation boundary. */
  readonly [preparedPlanBrand]: true;
  readonly planId: string;
  readonly rootNodeId: PlanNodeId;
  readonly query: Query;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
};

/** Prepares an arbitrary portable query representation for trusted execution. */
export const preparePlan = async <Query extends JsonValue>(input: {
  readonly query: Query;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
}): Promise<PreparedPlan<Query>> => {
  const parsed = detachAndFreezeJsonValue(input.query, { ...defaultValueParseBudget, maxDepth: 1_024 });
  if (!parsed.success) throw new TypeError('Prepared plan query must be a portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
  const query = parsed.value as Query;
  const semantic = { root: query, registryFingerprint: input.registryFingerprint, authorityFingerprint: input.authorityFingerprint, datasetId: input.datasetId } as JsonValue;
  const planId = await sha256Json(semantic);
  return sealOwnedPreparedPlan({
    planId,
    rootNodeId: planId + ':root',
    query,
    registryFingerprint: input.registryFingerprint,
    authorityFingerprint: input.authorityFingerprint,
    datasetId: input.datasetId
  });
};
