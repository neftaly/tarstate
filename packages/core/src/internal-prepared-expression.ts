import type { Expr, PreparedExpression } from './query.js';
const preparedExpressions = new WeakSet<object>();

export const sealPreparedExpression = (expression: Expr): PreparedExpression => {
  const prepared = Object.freeze({ expression }) as PreparedExpression;
  preparedExpressions.add(prepared);
  return prepared;
};

export const assertPreparedExpression = (value: PreparedExpression): void => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !preparedExpressions.has(value)) {
    throw new TypeError('Prepared expression was not produced by prepareExpression');
  }
};
