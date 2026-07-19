import type {
  DatabaseTextIntentSegment,
  DatabaseTextIntentSessionSnapshot,
  DatabaseTextIntentTransform
} from '../database/transaction.js';
import { createIssue, type Issue } from '../issues.js';
import { samePortableJson } from '../internal-json-equality.js';
import type { JsonValue } from '../value.js';
import {
  ImmutableDatabaseTransactionSnapshot,
  sameTransactionSnapshotLineage,
  type AuthoredTextSplice
} from './transaction-snapshot.js';

export type AcceptedTextIntentSegment = {
  readonly evidence: DatabaseTextIntentSegment;
  readonly intent: JsonValue;
  readonly transform: DatabaseTextIntentTransform;
  readonly splices: readonly AuthoredTextSplice[];
};

export const validateTextContinuation = (
  before: ImmutableDatabaseTransactionSnapshot,
  after: ImmutableDatabaseTransactionSnapshot
): readonly Issue[] => {
  const beforeSplices = before.authoredTextSplices();
  const afterSplices = after.authoredTextSplices();
  const authoringIssues = after.rejectionIssues();
  if (authoringIssues.length > before.rejectionIssues().length) {
    return authoringIssues.slice(before.rejectionIssues().length);
  }
  if (after.changedRelations().size > 0 || after.generatedInserts().length > 0) {
    return [textIntentIssue('lifecycle.command_invalid', 'text_intent_operation_required')];
  }
  if (afterSplices.length <= beforeSplices.length) {
    return [textIntentIssue('lifecycle.command_invalid', 'text_intent_splice_required')];
  }
  for (let index = 0; index < beforeSplices.length; index += 1) {
    if (beforeSplices[index] !== afterSplices[index]) {
      return [textIntentIssue('lifecycle.command_invalid', 'text_intent_lineage_mismatch')];
    }
  }
  return Object.freeze([]);
};

export const rebaseAcceptedTextSegments = (
  base: ImmutableDatabaseTransactionSnapshot,
  accepted: readonly AcceptedTextIntentSegment[]
): { readonly success: true; readonly current: ImmutableDatabaseTransactionSnapshot }
  | { readonly success: false; readonly issue: Issue } => {
  let current = base;
  for (const segment of accepted) {
    let transformed: ReturnType<DatabaseTextIntentTransform>;
    try {
      transformed = segment.transform(current);
    } catch (error) {
      return {
        success: false,
        issue: textIntentIssue('lifecycle.command_invalid', 'text_intent_transform_replay_failed', error)
      };
    }
    if (!(transformed instanceof ImmutableDatabaseTransactionSnapshot)
      || !sameTransactionSnapshotLineage(current, transformed)) {
      return {
        success: false,
        issue: textIntentIssue('lifecycle.command_invalid', 'text_intent_transform_replay_lineage')
      };
    }
    const continuationIssues = validateTextContinuation(current, transformed);
    const replayed = transformed.authoredTextSplices().slice(current.authoredTextSplices().length);
    if (continuationIssues.length > 0 || !samePortableJson(replayed, segment.splices)) {
      return {
        success: false,
        issue: textIntentIssue('lifecycle.command_invalid', 'text_intent_transform_not_replayable')
      };
    }
    current = transformed;
  }
  return { success: true, current };
};

export const composedTextIntent = (
  sessionId: string,
  publicationIndex: number,
  accepted: readonly AcceptedTextIntentSegment[]
): JsonValue => Object.freeze({
  kind: 'tarstate.dependent-text-intent',
  formatVersion: 2,
  sessionId,
  publicationIndex,
  segments: Object.freeze(accepted.map(({ evidence, intent }) => Object.freeze({
    segmentId: evidence.segmentId,
    intent
  })))
});

export const textIntentSegmentEvidence = (
  segmentId: string,
  status: DatabaseTextIntentSegment['status'],
  issues: readonly Issue[]
): DatabaseTextIntentSegment => Object.freeze({
  segmentId,
  status,
  issues: Object.freeze([...issues])
});

export const settleSelectedTextSegments = (
  segments: readonly DatabaseTextIntentSegment[],
  selected: ReadonlySet<string>,
  status: Exclude<DatabaseTextIntentSegment['status'], 'pending'>,
  issues: readonly Issue[]
): readonly DatabaseTextIntentSegment[] => Object.freeze(segments.map((segment) =>
  segment.status === 'pending' && selected.has(segment.segmentId)
    ? textIntentSegmentEvidence(segment.segmentId, status, issues)
    : segment));

export const retainRecentTextEvidence = (
  segments: readonly DatabaseTextIntentSegment[],
  maximum: number
): readonly DatabaseTextIntentSegment[] => {
  if (segments.length <= maximum) return Object.freeze(segments);
  const pending = segments.filter(({ status }) => status === 'pending');
  const settledBudget = Math.max(0, maximum - pending.length);
  const settled = settledBudget === 0
    ? []
    : segments.filter(({ status }) => status !== 'pending').slice(-settledBudget);
  const retainedIds = new Set([...settled, ...pending].map(({ segmentId }) => segmentId));
  return Object.freeze(segments.filter(({ segmentId }) => retainedIds.has(segmentId)));
};

export const isTerminalTextIntentState = (
  state: DatabaseTextIntentSessionSnapshot['state']
): boolean => state === 'blocked'
  || state === 'rejected'
  || state === 'unknown'
  || state === 'cancelled'
  || state === 'closed';

export const textIntentIssue = (
  code: 'lifecycle.adapter_failed' | 'lifecycle.cancelled' | 'lifecycle.command_invalid',
  reason: string,
  error?: unknown
): Issue => createIssue({
  code,
  details: {
    reason,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.name : typeof error })
  }
});
