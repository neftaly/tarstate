import type { PreparedPlan } from './maintenance.js';

type PreparedPlanFields<Query> = Omit<PreparedPlan<Query>, symbol>;

const preparedPlans = new WeakSet<object>();

/** Internal provenance seal. Deliberately absent from every public entry point. */
export const sealPreparedPlan = <Query>(fields: PreparedPlanFields<Query>): PreparedPlan<Query> => {
  const plan = Object.freeze(fields) as PreparedPlan<Query>;
  preparedPlans.add(plan);
  return plan;
};

export const assertPreparedPlan = <Query>(value: PreparedPlan<Query>): void => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !preparedPlans.has(value)) {
    throw new TypeError('Prepared plan was not produced by a plan preparation API');
  }
};
