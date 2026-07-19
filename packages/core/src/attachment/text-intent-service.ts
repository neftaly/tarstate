import type {
  DatabaseTextIntentService,
  DatabaseTransactionService,
  DatabaseTransactionSnapshot
} from '../database/transaction.js';
import { createIssue } from '../issues.js';
import { samePortableJson } from '../internal-json-equality.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { AtomicSource } from '../source-protocol.js';
import type { SourceBasis } from '../source-state.js';
import { createTextIntentSession } from './text-intent-session.js';
import { ImmutableDatabaseTransactionSnapshot } from './transaction-snapshot.js';

export type AttachmentTextIntentServiceInput<Storage> = {
  readonly transactions: DatabaseTransactionService;
  readonly source: Pick<AtomicSource<Storage, unknown>, 'sourceId' | 'snapshot' | 'subscribe'>;
  readonly supported: boolean;
};

/** Optional bounded text lifecycle composed beside the ordinary transaction service. */
export const createAttachmentTextIntentService = <Storage>(
  input: AttachmentTextIntentServiceInput<Storage>
): DatabaseTextIntentService => Object.freeze({
  openTextIntent: async (options) => {
    if (!input.supported) {
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
      return {
        success: true,
        value: createTextIntentSession({
          observedBasis,
          initial,
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
          commit: ({ intent, finalSnapshot, signal }) => input.transactions.transact(
            intent,
            () => finalSnapshot,
            { observedBasis, signal }
          )
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
