import type { Expr, PreparedExpression } from '../model.js';
import { provenanceRegistry } from '../../internal-provenance-registry.js';

export const sealPreparedExpression = (expression: Expr): PreparedExpression => {
  const prepared = Object.freeze({ expression }) as PreparedExpression;
  provenanceRegistry.preparedExpressions.add(prepared);
  return prepared;
};

export const isPreparedExpression = (value: unknown): value is PreparedExpression =>
  (typeof value === 'object' || typeof value === 'function')
  && value !== null
  && provenanceRegistry.preparedExpressions.has(value);

export const assertPreparedExpression = (value: PreparedExpression): void => {
  if (!isPreparedExpression(value)) {
    throw new TypeError('Prepared expression was not produced by prepareExpression');
  }
};
