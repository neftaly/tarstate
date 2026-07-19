import type {
  DatabaseTextIntentService,
  DatabaseTextIntentTransform,
  DatabaseTextPositionRequest,
  DatabaseTextPositionResult,
  DatabaseTransactionService,
  DatabaseTransactionSnapshot
} from '../database/transaction.js';
import { createIssue } from '../issues.js';
import { samePortableJson } from '../internal-json-equality.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { AtomicSource } from '../source-protocol.js';
import type { SourceBasis } from '../source-state.js';
import type { CommitReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';
import { createTextIntentSession } from './text-intent-session.js';
import { ImmutableDatabaseTransactionSnapshot } from './transaction-snapshot.js';

export type AttachmentTextIntentServiceInput<Storage, Branch extends object> = {
  readonly transactions: DatabaseTransactionService;
  readonly source: Pick<AtomicSource<Storage, unknown>, 'sourceId' | 'snapshot' | 'subscribe'>;
  readonly publication?: TextIntentPublicationDriver<Branch>;
};

export type TextIntentPublicationDriver<Branch extends object> = {
  readonly openBranch: (observedBasis: SourceBasis) => Branch;
  readonly publish: (input: {
    readonly intent: JsonValue;
    readonly transforms: readonly DatabaseTextIntentTransform[];
    readonly textPositions: readonly DatabaseTextPositionRequest[];
    readonly branch: Branch;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly receipt: CommitReceipt;
    readonly textPositions: readonly DatabaseTextPositionResult[];
    readonly continuation?: Branch;
    readonly optimisticBase?: ImmutableDatabaseTransactionSnapshot;
  }>;
};

/** Optional causal text lifecycle composed beside the ordinary transaction service. */
export const createAttachmentTextIntentService = <Storage, Branch extends object>(
  input: AttachmentTextIntentServiceInput<Storage, Branch>
): DatabaseTextIntentService => Object.freeze({
  openTextIntent: async (options) => {
    if (input.publication === undefined) {
      return {
        success: false,
        issues: [createIssue({
          code: 'transaction.capability_unavailable',
          details: { capability: 'dependent-text-intent' }
        })]
      };
    }
    const ownedBasis = detachAndFreezeJsonValue(options.observedBasis);
    if (!ownedBasis.success) return { success: false, issues: ownedBasis.issues };
    const observedBasis = ownedBasis.value;
    let initial: ImmutableDatabaseTransactionSnapshot | undefined;
    const capture = await input.transactions.simulate(
      { kind: 'tarstate.open-dependent-text-intent' },
      (snapshot: DatabaseTransactionSnapshot) => {
        if (!(snapshot instanceof ImmutableDatabaseTransactionSnapshot)) {
          throw new TypeError('Attachment service created an invalid transaction snapshot');
        }
        initial = snapshot;
        return snapshot;
      },
      {
        observedBasis,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      }
    );
    if (initial === undefined || capture.outcome === 'rejected') {
      return { success: false, issues: capture.issues };
    }
    let currentBasis: SourceBasis;
    try {
      currentBasis = input.source.snapshot().basis;
    } catch (error) {
      return { success: false, issues: [sourceSnapshotIssue(input.source, error)] };
    }
    try {
      const branch = input.publication.openBranch(observedBasis);
      return {
        success: true,
        value: createTextIntentSession({
          observedBasis,
          initial,
          branch,
          initialIssues: capture.issues,
          initiallyStale: !samePortableJson(currentBasis, observedBasis),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          subscribeSource: (markStale) => {
            const unsubscribe = input.source.subscribe((change) => {
              try {
                const afterBasis = change?.afterBasis ?? input.source.snapshot().basis;
                if (!samePortableJson(afterBasis, observedBasis)) markStale();
              } catch {
                markStale();
              }
            });
            try {
              if (!samePortableJson(input.source.snapshot().basis, observedBasis)) markStale();
              return unsubscribe;
            } catch (error) {
              unsubscribe();
              throw error;
            }
          },
          publish: input.publication.publish
        }),
        issues: capture.issues
      };
    } catch (error) {
      return { success: false, issues: [sourceSnapshotIssue(input.source, error)] };
    }
  }
});

const sourceSnapshotIssue = (
  source: { readonly sourceId: string },
  error: unknown
) => createIssue({
  code: 'source.snapshot_failed',
  sourceId: source.sourceId,
  details: { error: error instanceof Error ? error.name : typeof error }
});
