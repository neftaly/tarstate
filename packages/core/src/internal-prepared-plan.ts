import type { PreparedPlan } from './maintenance.js';
import { provenanceRegistry } from './internal-provenance-registry.js';

type PreparedPlanFields<Query> = Omit<PreparedPlan<Query>, symbol>;

// Deliberately module-private: this is an optimization marker, not portable
// provenance. Compatible copies safely re-adopt plans they did not prepare.
const ownedPreparedPlans = new WeakSet<object>();

/** Internal provenance seal. Deliberately absent from every public entry point. */
export const sealPreparedPlan = <Query>(fields: PreparedPlanFields<Query>): PreparedPlan<Query> => {
  const plan = Object.freeze(fields) as PreparedPlan<Query>;
  provenanceRegistry.preparedPlans.add(plan);
  return plan;
};

/** Seals a plan whose query has already crossed a deep ownership boundary. */
export const sealOwnedPreparedPlan = <Query>(fields: PreparedPlanFields<Query>): PreparedPlan<Query> => {
  const plan = sealPreparedPlan(fields);
  ownedPreparedPlans.add(plan);
  return plan;
};

export const hasOwnedPreparedQuery = (plan: PreparedPlan<unknown>): boolean => ownedPreparedPlans.has(plan);

export const assertPreparedPlan = <Query>(value: PreparedPlan<Query>): void => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !provenanceRegistry.preparedPlans.has(value)) {
    throw new TypeError('Prepared plan was not produced by a plan preparation API');
  }
};
