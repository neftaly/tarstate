import type {
  DatabaseTransactionOptions,
  DatabaseTransactionSnapshot,
  DatabaseTransactionTransform
} from '../database/transaction.js';
import type { StagedBasisAtomicSource } from '../source-protocol.js';
import type { SourceBasis } from '../source-state.js';
import {
  executeRetainedCandidatePreparedTransaction,
  type PreparedWritableExecutionContext,
  type ReplayablePreparedTransactionInput
} from '../transaction-executor.js';
import type { JsonValue } from '../value.js';
import type { TextIntentPublicationDriver } from './text-intent-service.js';
import {
  settleRetainedTextPositions,
  type RetainedTextPositionResolver
} from './retained-text-positions.js';
import {
  ImmutableDatabaseTransactionSnapshot,
  sameTransactionSnapshotLineage
} from './transaction-snapshot.js';

type AttachmentPrivateBranch<Storage, Command> = ReturnType<
  StagedBasisAtomicSource<Storage, Command>['snapshot']
>;

type PrepareTransactionInput = (
  intent: JsonValue,
  transform: DatabaseTransactionTransform,
  options: DatabaseTransactionOptions
) => Promise<ReplayablePreparedTransactionInput>;

/** Adapter-only bridge from pure segment transforms to retained source publication. */
export const createRetainedTextPublicationDriver = <Storage, Command>(
  source: StagedBasisAtomicSource<Storage, Command>,
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepareInput: PrepareTransactionInput,
  supported: boolean,
  textPositions?: RetainedTextPositionResolver<Storage>
): TextIntentPublicationDriver<AttachmentPrivateBranch<Storage, Command>> | undefined => {
  const createPrivateBranch = source.createPrivateBranch;
  const snapshotAt = source.snapshotAt;
  if (!supported
    || createPrivateBranch === undefined
    || snapshotAt === undefined
    || source.reconcile === undefined
    || source.commitReconciled === undefined) {
    return undefined;
  }
  return Object.freeze({
    openBranch: (observedBasis: SourceBasis) => {
      const captured = snapshotAt(observedBasis);
      if (captured.state !== 'ready' || captured.storage === undefined) {
        throw new TypeError('Retained text publication requires a ready historical source snapshot');
      }
      return Object.freeze({
        ...captured,
        storage: createPrivateBranch(captured)
      });
    },
    publish: async ({ intent, transforms, textPositions: requestedPositions, branch, signal }) => {
      let authored: ImmutableDatabaseTransactionSnapshot | undefined;
      const transform = async (initial: DatabaseTransactionSnapshot) => {
        if (!(initial instanceof ImmutableDatabaseTransactionSnapshot)) {
          throw new TypeError('Retained text publication received an invalid transaction snapshot');
        }
        let current = initial;
        for (const apply of transforms) {
          const next = apply(current);
          if (!(next instanceof ImmutableDatabaseTransactionSnapshot)
            || !sameTransactionSnapshotLineage(current, next)) {
            throw new TypeError('Retained text transform must preserve its publication lineage');
          }
          current = next;
        }
        authored = current;
        return current;
      };
      const prepared = await prepareInput(intent, transform, {
        observedBasis: branch.basis,
        signal
      });
      const result = await executeRetainedCandidatePreparedTransaction(
        context,
        prepared,
        branch
      );
      let committed: ReturnType<typeof snapshotAt> | undefined;
      if (result.receipt.outcome === 'committed') {
        try {
          committed = snapshotAt(result.receipt.afterBasis);
        } catch { /* Position evidence must not replace a known commit receipt. */ }
      }
      const resolvedPositions = settleRetainedTextPositions({
        receipt: result.receipt,
        signal,
        positions: requestedPositions,
        ...(result.continuation?.storage === undefined
          ? {}
          : { optimistic: result.continuation.storage }),
        ...(committed?.state !== 'ready' || committed.storage === undefined
          ? {}
          : { committed: committed.storage }),
        ...(textPositions === undefined ? {} : { resolve: textPositions })
      });
      if (result.receipt.outcome !== 'committed'
        || result.continuation === undefined
        || authored === undefined) {
        return { receipt: result.receipt, textPositions: resolvedPositions };
      }
      return {
        receipt: result.receipt,
        textPositions: resolvedPositions,
        continuation: result.continuation,
        optimisticBase: authored.continuationBase()
      };
    }
  });
};
