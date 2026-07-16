import { sealPreparedExpression } from './internal/prepared-expression.js';
import { adoptMaintenanceSnapshot, cloneAndFreezeExpression } from './internal/ownership.js';
import { preparePlan } from './plan.js';
import type { PreparedPlan } from './plan-contract.js';
import type { Expr, PreparedExpression, QueryNode } from './model.js';
import type { OwnedQueryMaintenanceSnapshot, QueryMaintenanceSnapshot } from './incremental-model.js';

export { preparePlan } from './plan.js';

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

/** Owns changing query input once for reuse by prepared evaluators. */
export const prepareQueryMaintenanceSnapshot = (
  snapshot: QueryMaintenanceSnapshot
): OwnedQueryMaintenanceSnapshot => adoptMaintenanceSnapshot(snapshot);
