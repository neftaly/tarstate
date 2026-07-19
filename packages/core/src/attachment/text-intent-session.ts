import type {
  DatabaseTextIntentSegment,
  DatabaseTextIntentSession,
  DatabaseTextIntentSessionSnapshot,
  DatabaseTextIntentTransform
} from '../database/transaction.js';
import { TarstateParseError, type Issue } from '../issues.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { SourceBasis } from '../source-state.js';
import type { CommitReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';
import {
  ImmutableDatabaseTransactionSnapshot,
  sameTransactionSnapshotLineage
} from './transaction-snapshot.js';
import {
  composedTextIntent,
  isTerminalTextIntentState,
  rebaseAcceptedTextSegments,
  retainRecentTextEvidence,
  settleSelectedTextSegments,
  textIntentIssue,
  textIntentSegmentEvidence,
  validateTextContinuation,
  type AcceptedTextIntentSegment
} from './text-intent-core.js';

const maxPendingSegments = 256;
const maxPendingSplices = 1_024;
const maxRetainedEvidence = 256;

export type TextIntentSessionInput<Branch extends object> = {
  readonly observedBasis: SourceBasis;
  readonly initial: ImmutableDatabaseTransactionSnapshot;
  readonly branch: Branch;
  readonly initialIssues: readonly Issue[];
  readonly initiallyStale: boolean;
  readonly signal?: AbortSignal;
  readonly subscribeSource: (markStale: () => void) => () => void;
  readonly publish: (input: {
    readonly intent: JsonValue;
    readonly transforms: readonly DatabaseTextIntentTransform[];
    readonly branch: Branch;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly receipt: CommitReceipt;
    readonly continuation?: Branch;
    readonly optimisticBase?: ImmutableDatabaseTransactionSnapshot;
  }>;
};

/** Lifecycle shell over immutable causal text authoring and an opaque source branch. */
export const createTextIntentSession = <Branch extends object>(
  input: TextIntentSessionInput<Branch>
): DatabaseTextIntentSession => {
  const sessionId = globalThis.crypto.randomUUID();
  const listeners = new Set<() => void>();
  let accepted: AcceptedTextIntentSegment[] = [];
  let allSegments: readonly DatabaseTextIntentSegment[] = Object.freeze([]);
  let nextSegmentIndex = 0;
  let pendingSplices = 0;
  let current = input.initial;
  let branch = input.branch;
  let state: DatabaseTextIntentSessionSnapshot['state'] = 'ready';
  let freshness: DatabaseTextIntentSessionSnapshot['freshness'] = input.initiallyStale
    ? 'stale'
    : 'current';
  let issues = Object.freeze([...input.initialIssues]);
  let receipt: CommitReceipt | undefined;
  let closed = false;
  let publication: Promise<CommitReceipt> | undefined;
  let nextPublicationIndex = 0;
  const abort = new AbortController();

  let snapshot = sessionSnapshot();
  const publishSnapshot = (): void => {
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
    publishSnapshot();
  };
  const unsubscribeSource = input.subscribeSource(markStale);

  const cancel = (): void => {
    if (closed || isTerminalTextIntentState(state)) return;
    abort.abort();
    const cancellation = textIntentIssue('lifecycle.cancelled', 'text_intent_cancelled');
    issues = Object.freeze([...issues, cancellation]);
    const inFlightCount = state === 'publishing' ? publicationPrefixCount : 0;
    const queuedIds = new Set(accepted.slice(inFlightCount).map(({ evidence }) => evidence.segmentId));
    allSegments = settleSelectedTextSegments(allSegments, queuedIds, 'cancelled', [cancellation]);
    state = 'cancelled';
    publishSnapshot();
  };
  const append = (
    intent: JsonValue,
    transform: DatabaseTextIntentTransform
  ): DatabaseTextIntentSegment => {
    if ((state !== 'ready' && state !== 'publishing') || closed) {
      throw new Error('Text intent segments can only be appended to an active session');
    }
    if (typeof transform !== 'function') {
      throw new TypeError('Text intent transform must be a function');
    }
    const ownedIntent = detachAndFreezeJsonValue(intent);
    if (!ownedIntent.success) throw new TarstateParseError(ownedIntent.issues);
    if (accepted.length >= maxPendingSegments) {
      return rejectSegment('text_intent_pending_segment_budget_exceeded');
    }
    const transformed = transform(current);
    if (!(transformed instanceof ImmutableDatabaseTransactionSnapshot)
      || !sameTransactionSnapshotLineage(transformed, current)) {
      throw new TypeError('Text intent transform must return a snapshot created by this session');
    }
    const segmentId = `${sessionId}:${nextSegmentIndex}`;
    nextSegmentIndex += 1;
    const segmentIssues = validateTextContinuation(current, transformed);
    const beforeSpliceCount = current.authoredTextSplices().length;
    const segmentSplices = transformed.authoredTextSplices().slice(beforeSpliceCount);
    if (pendingSplices + segmentSplices.length > maxPendingSplices) {
      return rejectSegment('text_intent_pending_splice_budget_exceeded', segmentId);
    }
    if (segmentIssues.length > 0) {
      const rejected = textIntentSegmentEvidence(segmentId, 'rejected', segmentIssues);
      allSegments = retainRecentTextEvidence([...allSegments, rejected], maxRetainedEvidence);
      publishSnapshot();
      return rejected;
    }
    current = transformed;
    pendingSplices += segmentSplices.length;
    const evidence = textIntentSegmentEvidence(segmentId, 'pending', []);
    accepted.push({
      evidence,
      intent: ownedIntent.value,
      transform,
      splices: Object.freeze(segmentSplices)
    });
    allSegments = retainRecentTextEvidence([...allSegments, evidence], maxRetainedEvidence);
    publishSnapshot();
    return evidence;

    function rejectSegment(
      reason: string,
      segmentId = `${sessionId}:${nextSegmentIndex++}`
    ): DatabaseTextIntentSegment {
      const rejected = textIntentSegmentEvidence(
        segmentId,
        'rejected',
        [textIntentIssue('lifecycle.command_invalid', reason)]
      );
      allSegments = retainRecentTextEvidence([...allSegments, rejected], maxRetainedEvidence);
      publishSnapshot();
      return rejected;
    }
  };
  let publicationPrefixCount = 0;
  const publish = (): Promise<CommitReceipt> => {
    if (publication !== undefined) return publication;
    if (closed || isTerminalTextIntentState(state)) {
      return Promise.reject(new Error('Text intent session is not publishable'));
    }
    if (accepted.length === 0) {
      return Promise.reject(new Error('Text intent session has no unpublished segments'));
    }
    publicationPrefixCount = accepted.length;
    const publicationIndex = nextPublicationIndex;
    nextPublicationIndex += 1;
    const prefix = accepted.slice(0, publicationPrefixCount);
    const prefixIds = new Set(prefix.map(({ evidence }) => evidence.segmentId));
    const publishAbort = abort.signal;
    state = 'publishing';
    publication = Promise.resolve().then(() => input.publish({
      intent: composedTextIntent(sessionId, publicationIndex, prefix),
      transforms: Object.freeze(prefix.map(({ transform }) => transform)),
      branch,
      signal: publishAbort
    })).then((settled) => {
      receipt = settled.receipt;
      issues = Object.freeze([...issues, ...settled.receipt.issues]);
      if (settled.receipt.outcome === 'committed'
        && settled.continuation !== undefined
        && settled.optimisticBase !== undefined) {
        allSegments = settleSelectedTextSegments(
          allSegments,
          prefixIds,
          'committed',
          settled.receipt.issues
        );
        accepted = accepted.slice(publicationPrefixCount);
        pendingSplices = accepted.reduce((total, segment) => total + segment.splices.length, 0);
        branch = settled.continuation;
        if (state === 'cancelled' || closed) {
          settleQueuedAfterCancellation();
        } else {
          const rebased = rebaseAcceptedTextSegments(settled.optimisticBase, accepted);
          if (rebased.success) {
            current = rebased.current;
            state = 'ready';
          } else {
            issues = Object.freeze([...issues, rebased.issue]);
            const queuedIds = new Set(accepted.map(({ evidence }) => evidence.segmentId));
            allSegments = settleSelectedTextSegments(
              allSegments,
              queuedIds,
              'rejected',
              [rebased.issue]
            );
            accepted = [];
            pendingSplices = 0;
            state = 'blocked';
          }
        }
      } else if (settled.receipt.outcome === 'committed') {
        const failure = textIntentIssue(
          'lifecycle.adapter_failed',
          'text_intent_committed_continuation_unavailable'
        );
        issues = Object.freeze([...issues, failure]);
        settleUncertainDescendants(prefixIds, [failure]);
      } else if (settled.receipt.outcome === 'unknown') {
        settleUncertainDescendants(prefixIds, settled.receipt.issues);
      } else if (state === 'cancelled' || closed) {
        allSegments = settleSelectedTextSegments(
          allSegments,
          prefixIds,
          'cancelled',
          settled.receipt.issues
        );
        accepted = [];
        pendingSplices = 0;
      } else {
        settleRejectedDescendants(prefixIds, settled.receipt.issues);
      }
      return settled.receipt;
    }).catch((error: unknown) => {
      const failure = textIntentIssue(
        'lifecycle.adapter_failed',
        'text_intent_publication_failed',
        error
      );
      issues = Object.freeze([...issues, failure]);
      settleUncertainDescendants(prefixIds, [failure]);
      throw error;
    }).finally(() => {
      publication = undefined;
      publicationPrefixCount = 0;
      allSegments = retainRecentTextEvidence(allSegments, maxRetainedEvidence);
      publishSnapshot();
    });
    publishSnapshot();
    return publication;
  };
  const close = (): void => {
    if (closed) return;
    cancel();
    closed = true;
    state = 'closed';
    unsubscribeSource();
    input.signal?.removeEventListener('abort', cancel);
    publishSnapshot();
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
    publish,
    cancel,
    close
  });
  if (input.signal?.aborted === true) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  return service;

  function settleQueuedAfterCancellation(): void {
    const cancellation = textIntentIssue('lifecycle.cancelled', 'text_intent_descendant_cancelled');
    const queuedIds = new Set(accepted.map(({ evidence }) => evidence.segmentId));
    allSegments = settleSelectedTextSegments(allSegments, queuedIds, 'cancelled', [cancellation]);
    accepted = [];
    pendingSplices = 0;
  }

  function settleUncertainDescendants(
    prefixIds: ReadonlySet<string>,
    settlementIssues: readonly Issue[]
  ): void {
    const descendant = textIntentIssue(
      'lifecycle.adapter_failed',
      'text_intent_ancestor_outcome_unknown'
    );
    allSegments = settleSelectedTextSegments(allSegments, prefixIds, 'unknown', settlementIssues);
    const queuedIds = new Set(accepted
      .filter(({ evidence }) => !prefixIds.has(evidence.segmentId))
      .map(({ evidence }) => evidence.segmentId));
    allSegments = settleSelectedTextSegments(allSegments, queuedIds, 'unknown', [descendant]);
    accepted = [];
    pendingSplices = 0;
    if (!closed) state = 'unknown';
  }

  function settleRejectedDescendants(
    prefixIds: ReadonlySet<string>,
    settlementIssues: readonly Issue[]
  ): void {
    const descendant = textIntentIssue(
      'lifecycle.command_invalid',
      'text_intent_ancestor_rejected'
    );
    allSegments = settleSelectedTextSegments(allSegments, prefixIds, 'rejected', settlementIssues);
    const queuedIds = new Set(accepted
      .filter(({ evidence }) => !prefixIds.has(evidence.segmentId))
      .map(({ evidence }) => evidence.segmentId));
    allSegments = settleSelectedTextSegments(allSegments, queuedIds, 'rejected', [descendant]);
    accepted = [];
    pendingSplices = 0;
    if (!closed) state = 'rejected';
  }

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
