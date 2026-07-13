import type {
  CommitReceipt,
  JsonValue,
  ObserverDiagnosticReporter,
  TransactionAttempt
} from '@tarstate/core';
import { safeParseJsonValue } from '@tarstate/core';
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

const adoptTransactionAttempt = (input: TransactionAttempt): TransactionAttempt => {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('Transaction attempt must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const required = (name: 'operationEpoch' | 'operationId' | 'attachmentId' | 'transaction'): unknown => {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(`Transaction attempt ${name} must be an enumerable data property`);
    return descriptor.value;
  };
  const operationEpoch = required('operationEpoch');
  const operationId = required('operationId');
  const attachmentId = required('attachmentId');
  if (typeof operationEpoch !== 'string' || operationEpoch.length === 0 || typeof operationId !== 'string' || operationId.length === 0 || typeof attachmentId !== 'string' || attachmentId.length === 0) {
    throw new TypeError('Transaction attempt identifiers must be non-empty strings');
  }
  const transaction = safeParseJsonValue(required('transaction'));
  if (!transaction.success || transaction.value === null || typeof transaction.value !== 'object' || Array.isArray(transaction.value)) {
    throw new TypeError('Transaction attempt transaction must be descriptor-safe portable data');
  }
  const optionalPortable = (name: 'expectedBasis'): JsonValue | undefined => {
    const descriptor = descriptors[name];
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(`Transaction attempt ${name} must be an enumerable data property`);
    if (descriptor.value === undefined) return undefined;
    const parsed = safeParseJsonValue(descriptor.value);
    if (!parsed.success) throw new TypeError(`Transaction attempt ${name} must be descriptor-safe portable data`);
    return parsed.value;
  };
  const expectedBasis = optionalPortable('expectedBasis');
  const signalDescriptor = descriptors.signal;
  if (signalDescriptor !== undefined && (!signalDescriptor.enumerable || !('value' in signalDescriptor))) throw new TypeError('Transaction attempt signal must be an enumerable data property');
  return Object.freeze({
    operationEpoch,
    operationId,
    attachmentId,
    transaction: freezeOwnedPortable(transaction.value) as TransactionAttempt['transaction'],
    ...(expectedBasis === undefined ? {} : { expectedBasis: freezeOwnedPortable(expectedBasis) }),
    ...(signalDescriptor === undefined || signalDescriptor.value === undefined ? {} : { signal: signalDescriptor.value as AbortSignal })
  });
};

const freezeOwnedPortable = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  for (const member of Array.isArray(value) ? value : Object.values(value)) freezeOwnedPortable(member);
  return Object.freeze(value);
};

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
    const ownedAttempt = adoptTransactionAttempt(attempt);
    const mutationId = this.#nextMutationId++;
    let optimisticError: MutationEntry['optimisticError'];
    let overlay: OptimisticOverlay<unknown, unknown> | undefined;
    if (createOptimisticOverlay !== undefined) {
      try {
        overlay = createOptimisticOverlay(ownedAttempt);
      } catch (error) {
        optimisticError = { phase: 'create-overlay', ...errorDetails(error) };
      }
    }
    if (overlay !== undefined) optimisticError = this.#overlayStore.add(mutationId, ownedAttempt, overlay) ?? optimisticError;
    this.#replace({
      mutationId,
      operationEpoch: ownedAttempt.operationEpoch,
      operationId: ownedAttempt.operationId,
      attachmentId: ownedAttempt.attachmentId,
      state: 'pending',
      ...(optimisticError === undefined ? {} : { optimisticError })
    });
    let receipt: CommitReceipt;
    try {
      receipt = await commitImplementation(ownedAttempt);
      if (!receiptIdentityMatches(ownedAttempt, receipt)) throw new Error('Commit receipt identity does not match its transaction attempt');
    } catch (error) {
      this.#overlayStore.discard(mutationId);
      this.#replace({
        mutationId,
        operationEpoch: ownedAttempt.operationEpoch,
        operationId: ownedAttempt.operationId,
        attachmentId: ownedAttempt.attachmentId,
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
      operationEpoch: ownedAttempt.operationEpoch,
      operationId: ownedAttempt.operationId,
      attachmentId: ownedAttempt.attachmentId,
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
