import { sameStructuralJson } from './internal-structural-json-equality.js';
import { freezeOwnedJsonValue } from './internal-owned-json.js';
import { sealPreparedPlan } from './query/internal/prepared-plan.js';
import type { PreparedPlan } from './query/plan-contract.js';
import { defaultValueParseBudget, safeParseJsonValue, type JsonValue } from './value.js';

/** Detached immutable ownership used at observer publication and input boundaries. */
export const deepFreezeObserverValue = <Value>(value: Value, seen = new WeakMap<object, object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as Value;
  if (Array.isArray(value)) {
    const output: unknown[] = Array(value.length);
    seen.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      output[index] = deepFreezeObserverValue(value[index], seen);
    }
    return Object.freeze(output) as Value;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const key of Object.keys(value)) {
    const owned = deepFreezeObserverValue((value as Record<string, unknown>)[key], seen);
    if (key === '__proto__') {
      Object.defineProperty(output, key, {
        value: owned,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else {
      output[key] = owned;
    }
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
  return sameStructuralJson(left, right);
};
