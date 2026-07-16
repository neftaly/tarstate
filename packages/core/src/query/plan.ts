import { sha256Json } from '../canonical-json.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import { sealOwnedPreparedPlan } from './internal/prepared-plan.js';
import type { PreparedPlan } from './plan-contract.js';
import { defaultValueParseBudget, type JsonValue } from '../value.js';

export type { PreparedPlan } from './plan-contract.js';

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
