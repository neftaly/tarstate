import type { Expr, PreparedExpression } from './query-model.js';
import { provenanceRegistry } from './internal-provenance-registry.js';

export const sealPreparedExpression = (expression: Expr): PreparedExpression => {
  const prepared = Object.freeze({ expression }) as PreparedExpression;
  provenanceRegistry.preparedExpressions.add(prepared);
  return prepared;
};

export const assertPreparedExpression = (value: PreparedExpression): void => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !provenanceRegistry.preparedExpressions.has(value)) {
    throw new TypeError('Prepared expression was not produced by prepareExpression');
  }
};
