import type {
  CommitReceipt,
  TransactionAttempt
} from '@tarstate/core/transactions';
import { safeParseJsonValue, type JsonValue } from '@tarstate/core';
import type { ObserverDiagnosticReporter } from '@tarstate/core/database/observer';
import type {
  CommitFunction,
  ErasedCreateOptimisticOverlay,
  MutationEntry,
  MutationState,
  OptimisticOverlay,
  OptimisticUpdateError
} from './contracts.js';
import type { OptimisticOverlayStore } from './optimistic-store.js';
import { deepFreezeDataClone, errorDetails, freezeOwnedPortable, notifyReactListeners } from './shared.js';

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

export type MutationStore = {
  readonly getSnapshot: () => MutationState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly commit: (
    attempt: TransactionAttempt,
    commitImplementation: CommitFunction | undefined,
    createOptimisticOverlay: ErasedCreateOptimisticOverlay | undefined
  ) => Promise<CommitReceipt>;
  readonly recordOptimisticError: (mutationId: number, optimisticError: OptimisticUpdateError) => void;
  readonly close: () => void;
};

export const createMutationStore = (
  overlayStore: OptimisticOverlayStore,
  onDiagnostic?: ObserverDiagnosticReporter
): MutationStore => {
  const listeners = new Set<() => void>();
  let snapshot: MutationState = emptyMutationState;
  let nextMutationId = 1;
  let closed = false;

  const replace = (entry: MutationEntry): void => {
    if (closed) return;
    snapshot = nextMutationState(snapshot, entry);
    notifyReactListeners(listeners, 'react-mutations', 'publish-mutation-state', onDiagnostic);
  };

  const commit = async (
    attempt: TransactionAttempt,
    commitImplementation: CommitFunction | undefined,
    createOptimisticOverlay: ErasedCreateOptimisticOverlay | undefined
  ): Promise<CommitReceipt> => {
    if (closed) throw new Error('Tarstate provider runtime is closed');
    if (commitImplementation === undefined) throw new Error('TarstateProvider has no commit implementation');
    const ownedAttempt = adoptTransactionAttempt(attempt);
    const mutationId = nextMutationId++;
    let optimisticError: MutationEntry['optimisticError'];
    let overlay: OptimisticOverlay<unknown, unknown> | undefined;
    if (createOptimisticOverlay !== undefined) {
      try {
        overlay = createOptimisticOverlay(ownedAttempt);
      } catch (error) {
        optimisticError = { phase: 'create-overlay', ...errorDetails(error) };
      }
    }
    if (overlay !== undefined) optimisticError = overlayStore.add(mutationId, ownedAttempt, overlay) ?? optimisticError;
    replace({
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
      overlayStore.discard(mutationId);
      replace({
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
    overlayStore.discard(mutationId);
    const latestError = snapshot.mutations.find((entry) => entry.mutationId === mutationId)?.optimisticError ?? optimisticError;
    replace({
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

  const recordOptimisticError = (mutationId: number, optimisticError: OptimisticUpdateError): void => {
    const entry = snapshot.mutations.find((candidate) => candidate.mutationId === mutationId);
    if (entry === undefined) return;
    replace({ ...entry, optimisticError });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    commit,
    recordOptimisticError,
    close: (): void => {
      if (closed) return;
      closed = true;
      listeners.clear();
      snapshot = emptyMutationState;
    }
  };
};

export const nextMutationState = (current: MutationState, entry: MutationEntry): MutationState => {
  const pending: MutationEntry[] = [];
  const settled: MutationEntry[] = [];
  for (const candidate of current.mutations) {
    if (candidate.mutationId === entry.mutationId) continue;
    (candidate.state === 'pending' ? pending : settled).push(candidate);
  }
  const ownedEntry = deepFreezeDataClone(entry);
  (ownedEntry.state === 'pending' ? pending : settled).push(ownedEntry);
  // Pending operations are evidence, not history: retain them until their promise settles.
  const retainedSettled = settled.length > maxRetainedMutations
    ? settled.slice(settled.length - maxRetainedMutations)
    : settled;
  const mutations = [...retainedSettled, ...pending]
    .sort((left, right) => left.mutationId - right.mutationId);
  return Object.freeze({
    pendingCount: pending.length,
    mutations: Object.freeze(mutations)
  });
};
