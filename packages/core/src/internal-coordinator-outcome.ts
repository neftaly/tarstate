import type { Issue } from './issues.js';

type CoordinatorMutationResult = {
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly issues: readonly Issue[];
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
};

export type CoordinatorMutationEvidence = {
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly issues: readonly Issue[];
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
};

/** Pure outcome normalization shared by lifecycle shells after an adapter returns. */
export const deriveCoordinatorMutationEvidence = (
  result: CoordinatorMutationResult,
  ledgerRetention: 'memory' | 'durable',
  durableLookupUnavailable: Issue
): CoordinatorMutationEvidence => ({
  outcome: result.outcome,
  issues: result.outcome === 'unknown' && ledgerRetention !== 'durable'
    ? [...result.issues, durableLookupUnavailable]
    : result.issues,
  ...(result.outcome === 'rejected'
    ? {}
    : { durability: result.outcome === 'unknown' ? result.durability ?? 'unknown' : result.durability })
});

/** Pure failure classification based only on whether the mutation boundary may have been crossed. */
export const deriveCoordinatorFailureEvidence = (
  mutationPossible: boolean,
  ledgerRetention: 'memory' | 'durable',
  failure: Issue,
  durableLookupUnavailable: Issue
): CoordinatorMutationEvidence => ({
  outcome: mutationPossible ? 'unknown' : 'rejected',
  issues: mutationPossible && ledgerRetention !== 'durable'
    ? [failure, durableLookupUnavailable]
    : [failure],
  ...(mutationPossible ? { durability: 'unknown' as const } : {})
});
