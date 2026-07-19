import type {
  DatabaseTextIntentSegment,
  DatabaseTextIntentSession,
  DatabaseTextIntentSessionSnapshot,
  DatabaseTextIntentTransform
} from '../database/transaction.js';
import { createIssue, TarstateParseError, type Issue } from '../issues.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { SourceBasis } from '../source-state.js';
import type { CommitReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';
import {
  ImmutableDatabaseTransactionSnapshot,
  sameTransactionSnapshotLineage
} from './transaction-snapshot.js';

type AcceptedSegment = {
  readonly evidence: DatabaseTextIntentSegment;
  readonly intent: JsonValue;
};

// Keeps immutable per-publication segment evidence from becoming quadratic
// editor-session churn while comfortably covering one UI input batch.
const maxSegments = 256;
const maxSplices = 1_024;

export type TextIntentSessionInput = {
  readonly observedBasis: SourceBasis;
  readonly initial: ImmutableDatabaseTransactionSnapshot;
  readonly initialIssues: readonly Issue[];
  readonly initiallyStale: boolean;
  readonly signal?: AbortSignal;
  readonly subscribeSource: (markStale: () => void) => () => void;
  readonly commit: (input: {
    readonly intent: JsonValue;
    readonly finalSnapshot: ImmutableDatabaseTransactionSnapshot;
    readonly signal: AbortSignal;
  }) => Promise<CommitReceipt>;
};

/** Lifecycle shell over the immutable text-authoring core. */
export const createTextIntentSession = (
  input: TextIntentSessionInput
): DatabaseTextIntentSession => {
  const sessionId = globalThis.crypto.randomUUID();
  const listeners = new Set<() => void>();
  const accepted: AcceptedSegment[] = [];
  let allSegments: readonly DatabaseTextIntentSegment[] = Object.freeze([]);
  let current = input.initial;
  let state: DatabaseTextIntentSessionSnapshot['state'] = 'ready';
  let freshness: DatabaseTextIntentSessionSnapshot['freshness'] = input.initiallyStale
    ? 'stale'
    : 'current';
  let issues = Object.freeze([...input.initialIssues]);
  let receipt: CommitReceipt | undefined;
  let closed = false;
  let completion: Promise<CommitReceipt> | undefined;
  const abort = new AbortController();

  let snapshot = sessionSnapshot();
  const publish = (): void => {
    snapshot = sessionSnapshot();
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch { /* A listener cannot block lifecycle progress. */ }
    }
  };
  const markStale = (): void => {
    if (freshness === 'stale' || closed) return;
    freshness = 'stale';
    publish();
  };
  const unsubscribeSource = input.subscribeSource(markStale);

  const cancel = (): void => {
    if (closed || isSettled(state) || state === 'cancelled') return;
    abort.abort();
    state = 'cancelled';
    const cancellation = sessionIssue('lifecycle.cancelled', 'text_intent_cancelled');
    issues = Object.freeze([...issues, cancellation]);
    allSegments = settlePendingSegments(allSegments, 'cancelled', [cancellation]);
    publish();
  };
  const append = (
    intent: JsonValue,
    transform: DatabaseTextIntentTransform
  ): DatabaseTextIntentSegment => {
    if (state !== 'ready' || closed) {
      throw new Error('Text intent segments can only be appended to a ready session');
    }
    if (typeof transform !== 'function') {
      throw new TypeError('Text intent transform must be a function');
    }
    const ownedIntent = detachAndFreezeJsonValue(intent);
    if (!ownedIntent.success) throw new TarstateParseError(ownedIntent.issues);
    if (allSegments.length >= maxSegments) {
      return rejectSegment('text_intent_segment_budget_exceeded');
    }
    const transformed = transform(current);
    if (!(transformed instanceof ImmutableDatabaseTransactionSnapshot)
      || !sameTransactionSnapshotLineage(transformed, current)) {
      throw new TypeError('Text intent transform must return a snapshot created by this transaction service');
    }
    const segmentId = `${sessionId}:${allSegments.length}`;
    const segmentIssues = validateTextContinuation(current, transformed);
    if (transformed.authoredTextSplices().length > maxSplices) {
      return rejectSegment('text_intent_splice_budget_exceeded');
    }
    if (segmentIssues.length > 0) {
      const rejected = segmentEvidence(segmentId, 'rejected', segmentIssues);
      allSegments = Object.freeze([...allSegments, rejected]);
      publish();
      return rejected;
    }
    current = transformed;
    const evidence = segmentEvidence(segmentId, 'pending', []);
    accepted.push({ evidence, intent: ownedIntent.value });
    allSegments = Object.freeze([...allSegments, evidence]);
    publish();
    return evidence;

    function rejectSegment(reason: string): DatabaseTextIntentSegment {
      const rejected = segmentEvidence(
        `${sessionId}:${allSegments.length}`,
        'rejected',
        [sessionIssue('lifecycle.command_invalid', reason)]
      );
      allSegments = Object.freeze([...allSegments, rejected]);
      state = 'blocked';
      issues = Object.freeze([...issues, ...rejected.issues]);
      publish();
      return rejected;
    }
  };
  const complete = (): Promise<CommitReceipt> => {
    if (completion !== undefined) return completion;
    if (closed || state === 'cancelled') {
      return Promise.reject(new Error('Text intent session is not completable'));
    }
    if (accepted.length === 0) {
      return Promise.reject(new Error('Text intent session has no accepted segments'));
    }
    state = 'committing';
    const commitInput = {
      intent: composedIntent(sessionId, accepted),
      finalSnapshot: current,
      signal: abort.signal
    };
    completion = Promise.resolve().then(() => input.commit(commitInput)).then((settled) => {
      receipt = settled;
      if (!closed) state = settled.outcome;
      issues = Object.freeze([...issues, ...settled.issues]);
      allSegments = settlePendingSegments(allSegments, settled.outcome, settled.issues);
      publish();
      return settled;
    }).catch((error: unknown) => {
      state = closed ? 'closed' : 'unknown';
      const failure = sessionIssue(
        'lifecycle.adapter_failed',
        'text_intent_completion_failed',
        error
      );
      issues = Object.freeze([...issues, failure]);
      allSegments = settlePendingSegments(allSegments, 'unknown', [failure]);
      publish();
      throw error;
    });
    publish();
    return completion;
  };
  const close = (): void => {
    if (closed) return;
    cancel();
    closed = true;
    state = 'closed';
    unsubscribeSource();
    input.signal?.removeEventListener('abort', cancel);
    publish();
    listeners.clear();
  };

  const service = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    append,
    complete,
    cancel,
    close
  });
  if (input.signal?.aborted === true) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  return service;

  function sessionSnapshot(): DatabaseTextIntentSessionSnapshot {
    return Object.freeze({
      state,
      freshness,
      observedBasis: input.observedBasis,
      current,
      segments: allSegments,
      issues,
      ...(receipt === undefined ? {} : { receipt })
    });
  }
};

const validateTextContinuation = (
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
    return [sessionIssue('lifecycle.command_invalid', 'text_intent_operation_required')];
  }
  if (afterSplices.length <= beforeSplices.length) {
    return [sessionIssue('lifecycle.command_invalid', 'text_intent_splice_required')];
  }
  for (let index = 0; index < beforeSplices.length; index += 1) {
    if (beforeSplices[index] !== afterSplices[index]) {
      return [sessionIssue('lifecycle.command_invalid', 'text_intent_lineage_mismatch')];
    }
  }
  return Object.freeze([]);
};

const composedIntent = (
  sessionId: string,
  accepted: readonly AcceptedSegment[]
): JsonValue => Object.freeze({
  kind: 'tarstate.dependent-text-intent',
  formatVersion: 1,
  sessionId,
  segments: Object.freeze(accepted.map(({ evidence, intent }) => Object.freeze({
    segmentId: evidence.segmentId,
    intent
  })))
});

const segmentEvidence = (
  segmentId: string,
  status: DatabaseTextIntentSegment['status'],
  issues: readonly Issue[]
): DatabaseTextIntentSegment => Object.freeze({
  segmentId,
  status,
  issues: Object.freeze([...issues])
});

const settlePendingSegments = (
  segments: readonly DatabaseTextIntentSegment[],
  status: Exclude<DatabaseTextIntentSegment['status'], 'pending'>,
  issues: readonly Issue[]
): readonly DatabaseTextIntentSegment[] => Object.freeze(segments.map((segment) =>
  segment.status === 'pending'
    ? segmentEvidence(segment.segmentId, status, issues)
    : segment));

const isSettled = (state: DatabaseTextIntentSessionSnapshot['state']): boolean =>
  state === 'committed' || state === 'rejected' || state === 'unknown';

const sessionIssue = (
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
