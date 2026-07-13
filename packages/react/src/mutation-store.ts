import type {
  CommitReceipt,
  ObserverDiagnosticReporter,
  TransactionAttempt
} from '@tarstate/core';
import type {
  CommitFunction,
  ErasedCreateOptimisticOverlay,
  MutationEntry,
  MutationState,
  OptimisticOverlay,
  OptimisticUpdateError
} from './contracts.js';
import type { OptimisticOverlayStore } from './optimistic-store.js';
import { deepFreezeClone, errorDetails, notifyReactListeners } from './shared.js';

const emptyMutationState: MutationState = Object.freeze({ pendingCount: 0, mutations: Object.freeze([]) });
const maxRetainedMutations = 100;

const receiptIdentityMatches = (attempt: TransactionAttempt, receipt: CommitReceipt): boolean =>
  receipt.kind === 'commit'
  && receipt.receiptVersion === 1
  && receipt.operationEpoch === attempt.operationEpoch
  && receipt.operationId === attempt.operationId
  && receipt.attachmentId === attempt.attachmentId
  && receipt.transactionHash === attempt.transaction.contentHash;

export class MutationStore {
  readonly #overlayStore: OptimisticOverlayStore;
  readonly #listeners = new Set<() => void>();
  #snapshot: MutationState = emptyMutationState;
  #nextMutationId = 1;
  #closed = false;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;

  constructor(overlayStore: OptimisticOverlayStore, onDiagnostic?: ObserverDiagnosticReporter) { this.#overlayStore = overlayStore; this.#onDiagnostic = onDiagnostic; }

  readonly getSnapshot = (): MutationState => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  readonly commit = async (attempt: TransactionAttempt, commitImplementation: CommitFunction | undefined, createOptimisticOverlay: ErasedCreateOptimisticOverlay | undefined): Promise<CommitReceipt> => {
    if (this.#closed) throw new Error('Tarstate provider runtime is closed');
    if (commitImplementation === undefined) throw new Error('TarstateProvider has no commit implementation');
    const mutationId = this.#nextMutationId++;
    let optimisticError: MutationEntry['optimisticError'];
    let overlay: OptimisticOverlay<unknown, unknown> | undefined;
    if (createOptimisticOverlay !== undefined) {
      try {
        overlay = createOptimisticOverlay(attempt);
      } catch (error) {
        optimisticError = { phase: 'create-overlay', ...errorDetails(error) };
      }
    }
    if (overlay !== undefined) optimisticError = this.#overlayStore.add(mutationId, attempt, overlay) ?? optimisticError;
    this.#replace({
      mutationId,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      state: 'pending',
      ...(optimisticError === undefined ? {} : { optimisticError })
    });
    let receipt: CommitReceipt;
    try {
      receipt = await commitImplementation(attempt);
      if (!receiptIdentityMatches(attempt, receipt)) throw new Error('Commit receipt identity does not match its transaction attempt');
    } catch (error) {
      this.#overlayStore.discard(mutationId);
      this.#replace({
        mutationId,
        operationEpoch: attempt.operationEpoch,
        operationId: attempt.operationId,
        attachmentId: attempt.attachmentId,
        state: 'failed',
        error: errorDetails(error),
        ...(optimisticError === undefined ? {} : { optimisticError })
      });
      throw error;
    }
    this.#overlayStore.discard(mutationId);
    const latestError = this.#snapshot.mutations.find((entry) => entry.mutationId === mutationId)?.optimisticError ?? optimisticError;
    this.#replace({
      mutationId,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      state: 'settled',
      receipt,
      ...(latestError === undefined ? {} : { optimisticError: latestError })
    });
    return receipt;
  };

  recordOptimisticError(mutationId: number, optimisticError: OptimisticUpdateError): void {
    const entry = this.#snapshot.mutations.find((candidate) => candidate.mutationId === mutationId);
    if (entry === undefined) return;
    this.#replace({ ...entry, optimisticError });
  }

  #replace(entry: MutationEntry): void {
    if (this.#closed) return;
    const replaced = [...this.#snapshot.mutations.filter(({ mutationId }) => mutationId !== entry.mutationId), deepFreezeClone(entry)];
    // Pending operations are evidence, not history: retain them until their promise settles.
    const pending = replaced.filter(({ state }) => state === 'pending');
    const settled = replaced.filter(({ state }) => state !== 'pending').slice(-maxRetainedMutations);
    const mutations = [...settled, ...pending].sort((left, right) => left.mutationId - right.mutationId);
    this.#snapshot = Object.freeze({
      pendingCount: mutations.filter(({ state }) => state === 'pending').length,
      mutations: Object.freeze(mutations)
    });
    notifyReactListeners(this.#listeners, 'react-mutations', 'publish-mutation-state', this.#onDiagnostic);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#snapshot = emptyMutationState;
  }
}
