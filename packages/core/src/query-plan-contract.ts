/** Stable identity and authority evidence for one prepared query. */
declare const preparedPlanBrand: unique symbol;

export type PreparedPlan<Query = unknown> = {
  /** Compile-time evidence that this value passed through a plan preparation boundary. */
  readonly [preparedPlanBrand]: true;
  readonly planId: string;
  readonly rootNodeId: string;
  readonly query: Query;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
};

export type PreparedPlanFields<Query> = Omit<PreparedPlan<Query>, symbol>;
