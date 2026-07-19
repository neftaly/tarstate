import type {
  DatabaseTextPositionRequest,
  DatabaseTextPositionResult
} from '../database/transaction.js';
import { createIssue, type Issue } from '../issues.js';
import type { CommitReceipt } from '../transaction.js';

export type RetainedTextPositionResolution =
  | {
      readonly name: string;
      readonly state: 'resolved';
      readonly index: number;
      readonly issues: readonly Issue[];
    }
  | {
      readonly name: string;
      readonly state: 'deleted' | 'rejected';
      readonly issues: readonly Issue[];
    };

/** Source-specific cursor mechanics kept behind the retained publication boundary. */
export type RetainedTextPositionResolver<Storage> = (input: {
  readonly optimistic: Storage;
  readonly committed: Storage;
  readonly positions: readonly DatabaseTextPositionRequest[];
}) => readonly RetainedTextPositionResolution[];

export const settleRetainedTextPositions = <Storage>(input: {
  readonly receipt: CommitReceipt;
  readonly signal: AbortSignal;
  readonly positions: readonly DatabaseTextPositionRequest[];
  readonly optimistic?: Storage;
  readonly committed?: Storage;
  readonly resolve?: RetainedTextPositionResolver<Storage>;
}): readonly DatabaseTextPositionResult[] => {
  if (input.positions.length === 0) return emptyTextPositions;
  if (input.receipt.outcome !== 'committed') {
    const state = input.signal.aborted
      ? 'cancelled'
      : input.receipt.outcome === 'unknown' ? 'unknown' : 'rejected';
    return unresolvedPositions(input.positions, state, input.receipt.issues);
  }
  if (input.resolve === undefined) {
    return unresolvedPositions(input.positions, 'unsupported', [createIssue({
      code: 'transaction.capability_unavailable',
      details: { capability: 'text-position-resolution' }
    })]);
  }
  if (input.optimistic === undefined || input.committed === undefined) {
    return unresolvedPositions(input.positions, 'unknown', [positionIssue(
      'text_position_source_snapshot_unavailable'
    )]);
  }
  let resolved: readonly RetainedTextPositionResolution[];
  try {
    resolved = input.resolve({
      optimistic: input.optimistic,
      committed: input.committed,
      positions: input.positions
    });
  } catch (error) {
    return unresolvedPositions(input.positions, 'unknown', [positionIssue(
      'text_position_resolution_failed',
      error
    )]);
  }
  if (resolved.length !== input.positions.length
    || resolved.some((result, index) => result.name !== input.positions[index]?.name)) {
    return unresolvedPositions(input.positions, 'unknown', [positionIssue(
      'text_position_resolution_invalid'
    )]);
  }
  const basis = input.receipt.afterBasis;
  return Object.freeze(resolved.map((result) => ownResolution(result, basis)));
};

const emptyTextPositions: readonly DatabaseTextPositionResult[] = Object.freeze([]);

const unresolvedPositions = (
  positions: readonly DatabaseTextPositionRequest[],
  state: Extract<
    DatabaseTextPositionResult['state'],
    'rejected' | 'unknown' | 'cancelled' | 'unsupported'
  >,
  issues: readonly Issue[]
): readonly DatabaseTextPositionResult[] => {
  const ownedIssues = Object.freeze([...issues]);
  return Object.freeze(positions.map(({ name }) => unresolvedPosition(
    name,
    state,
    ownedIssues
  )));
};

const ownResolution = (
  result: RetainedTextPositionResolution,
  basis: Extract<CommitReceipt, { readonly outcome: 'committed' }>['afterBasis']
): DatabaseTextPositionResult => {
  const issues = Object.freeze([...result.issues]);
  if (result.state === 'resolved') {
    return Object.freeze({
      name: result.name,
      state: 'resolved',
      index: result.index,
      basis,
      issues
    });
  }
  if (result.state === 'deleted') {
    return Object.freeze({
      name: result.name,
      state: 'deleted',
      basis,
      issues
    });
  }
  return unresolvedPosition(result.name, 'rejected', issues);
};

const unresolvedPosition = (
  name: string,
  state: Extract<
    DatabaseTextPositionResult['state'],
    'rejected' | 'unknown' | 'cancelled' | 'unsupported'
  >,
  issues: readonly Issue[]
): DatabaseTextPositionResult => Object.freeze({
  name,
  state,
  issues
});

const positionIssue = (reason: string, error?: unknown): Issue => createIssue({
  code: 'transaction.delta_invalid',
  details: {
    reason,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.name : typeof error })
  }
});
