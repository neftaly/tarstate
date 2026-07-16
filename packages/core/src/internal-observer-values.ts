import { samePortableJson } from './internal-json-equality.js';
import { freezeOwnedJsonValue } from './internal-owned-json.js';
import { sealPreparedPlan } from './internal-prepared-plan.js';
import type { PreparedPlan } from './query-plan-contract.js';
import { defaultValueParseBudget, safeParseJsonValue, type JsonValue } from './value.js';

/** Detached immutable ownership used at observer publication and input boundaries. */
export const deepFreezeObserverValue = <Value>(value: Value, seen = new WeakMap<object, object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as Value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(deepFreezeObserverValue(item, seen));
    return Object.freeze(output) as Value;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: deepFreezeObserverValue(item, seen),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return Object.freeze(output) as Value;
};

export const parseObservationParameters = (input: unknown): Readonly<Record<string, JsonValue>> => {
  const parsed = safeParseJsonValue(input);
  if (!parsed.success) throw new TypeError('Observation parameters must be a portable record: ' + parsed.issues.map(({ code }) => code).join(', '));
  if (parsed.value === null || Array.isArray(parsed.value) || typeof parsed.value !== 'object') {
    throw new TypeError('Observation parameters must be a portable record');
  }
  return freezeOwnedJsonValue(parsed.value) as Readonly<Record<string, JsonValue>>;
};

export const detachPreparedPlan = <Query>(plan: PreparedPlan<Query>): PreparedPlan<Query> => {
  const parsed = safeParseJsonValue(plan.query, { ...defaultValueParseBudget, maxDepth: 1_024 });
  if (!parsed.success) throw new TypeError('Prepared plan query must be a portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
  return sealPreparedPlan({
    planId: plan.planId,
    rootNodeId: plan.rootNodeId,
    query: freezeOwnedJsonValue(parsed.value) as Query,
    registryFingerprint: plan.registryFingerprint,
    authorityFingerprint: plan.authorityFingerprint,
    datasetId: plan.datasetId
  });
};

export const samePortableObserverValue = (left: unknown, right: unknown): boolean => {
  return samePortableJson(left, right);
};
