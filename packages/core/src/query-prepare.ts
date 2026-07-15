import { sealPreparedExpression } from './internal-prepared-expression.js';
import { cloneAndFreezeExpression } from './internal-query-ownership.js';
import { preparePlan } from './query-plan.js';
import type { PreparedPlan } from './query-plan-contract.js';
import type { Expr, PreparedExpression, QueryNode } from './query-model.js';

export { preparePlan } from './query-plan.js';

export const prepareQuery = (input: {
  readonly root: QueryNode;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
}): Promise<PreparedPlan<QueryNode>> =>
  preparePlan({
    query: input.root,
    registryFingerprint: input.registryFingerprint,
    authorityFingerprint: input.authorityFingerprint,
    datasetId: input.datasetId
  });

export const prepareExpression = (expression: Expr): PreparedExpression =>
  sealPreparedExpression(cloneAndFreezeExpression(expression));
