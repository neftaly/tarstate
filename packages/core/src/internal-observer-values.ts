import { sameStructuralJson } from './internal-structural-json-equality.js';
import { freezeOwnedJsonValue } from './internal-owned-json.js';
import { sealPreparedPlan } from './query/internal/prepared-plan.js';
import type { PreparedPlan } from './query/plan-contract.js';
import { safeParseJsonValue, type JsonValue } from './value.js';

/** Detached immutable ownership used at observer publication and input boundaries. */
export const deepFreezeObserverValue = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  const root = Array.isArray(value) ? Array(value.length) : {};
  const seen = new WeakMap<object, object>([[value, root]]);
  const containers: object[] = [root];
  const pending: { readonly input: object; readonly output: object }[] = [
    { input: value, output: root }
  ];
  while (pending.length > 0) {
    const { input, output } = pending.pop() as {
      readonly input: object;
      readonly output: object;
    };
    for (const key of Object.keys(input)) {
      const member = (input as Record<string, unknown>)[key];
      let owned = member;
      if (member !== null && typeof member === 'object') {
        const prior = seen.get(member);
        if (prior !== undefined) {
          owned = prior;
        } else {
          const child = Array.isArray(member) ? Array(member.length) : {};
          seen.set(member, child);
          containers.push(child);
          pending.push({ input: member, output: child });
          owned = child;
        }
      }
      if (key === '__proto__') {
        Object.defineProperty(output, key, {
          value: owned,
          enumerable: true,
          configurable: true,
          writable: true
        });
      } else {
        (output as Record<string, unknown>)[key] = owned;
      }
    }
  }
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    Object.freeze(containers[index]);
  }
  return root as Value;
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
  const parsed = safeParseJsonValue(plan.query);
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
