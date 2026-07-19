import type { Issue } from './issues.js';
import type { SourceBasis } from './source-state.js';
import type { CommitReceipt, TransactionAttempt } from './transaction.js';

export type NonAtomicBatch = {
  readonly batchId: string;
  readonly failurePolicy: 'stop' | 'continue';
  readonly steps: readonly {
    readonly stepId: string;
    readonly attempt: TransactionAttempt;
  }[];
};

export type DatabaseNonAtomicBatchStep = {
  readonly stepId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  /** Performs one ordinary host-local database transaction. */
  readonly transact: () => Promise<CommitReceipt>;
};

export type DatabaseNonAtomicBatch = {
  readonly batchId: string;
  readonly failurePolicy: 'stop' | 'continue';
  readonly steps: readonly DatabaseNonAtomicBatchStep[];
  /** Prevents callbacks that have not started; it cannot roll back completed steps. */
  readonly signal?: AbortSignal;
};

export type NonAtomicBatchStepReceipt = {
  readonly stepId: string;
  readonly attachmentId: string;
  /** Absent only when shell-owned membership resolution itself failed. */
  readonly sourceId?: string;
  readonly capturedBasis?: SourceBasis;
  readonly outcome: 'applied' | 'failed' | 'unattempted' | 'unknown';
  readonly receipt?: CommitReceipt;
};

export type NonAtomicBatchReceipt = {
  readonly kind: 'non-atomic-batch';
  readonly receiptVersion: 1;
  readonly batchId: string;
  readonly outcome: 'complete' | 'partial' | 'failed' | 'unknown';
  readonly steps: readonly NonAtomicBatchStepReceipt[];
  readonly issues: readonly Issue[];
};

export type NonAtomicBatchExecutor = {
  /** Resolves shell-owned attachment membership before a step is attempted. */
  readonly sourceIdFor: (attempt: TransactionAttempt) => string;
  readonly commit: (attempt: TransactionAttempt) => Promise<CommitReceipt>;
};
