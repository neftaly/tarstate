import { describe, expect, it, vi } from 'vitest';
import {
  executeDatabaseNonAtomicBatch,
  executeNonAtomicBatch,
  type CommitReceipt,
  type DatabaseTransactionService,
  type TransactionAttempt
} from '../src/transactions/index.js';

describe('non-atomic database batches', () => {
  it('retains committed receipts from ordinary database transaction services', async () => {
    const firstReceipt = commitReceipt('committed', 'attachment:first', 'source:first');
    const secondReceipt = commitReceipt('committed', 'attachment:second', 'source:second');
    const first = transactionService(firstReceipt);
    const second = transactionService(secondReceipt);

    const batch = await executeDatabaseNonAtomicBatch({
      batchId: 'batch:complete',
      failurePolicy: 'stop',
      steps: [
        {
          stepId: 'first',
          attachmentId: firstReceipt.attachmentId,
          sourceId: firstReceipt.sourceId,
          transact: () => first.transact({ kind: 'first' }, (snapshot) => snapshot)
        },
        {
          stepId: 'second',
          attachmentId: secondReceipt.attachmentId,
          sourceId: secondReceipt.sourceId,
          transact: () => second.transact({ kind: 'second' }, (snapshot) => snapshot)
        }
      ]
    });

    expect(batch).toMatchObject({
      outcome: 'complete',
      steps: [{ outcome: 'applied' }, { outcome: 'applied' }]
    });
    expect(batch.steps[0]?.receipt).toBe(firstReceipt);
    expect(batch.steps[1]?.receipt).toBe(secondReceipt);
  });

  it.each(['stop', 'continue'] as const)(
    'retains rejected, unknown, thrown, and unattempted evidence under %s policy',
    async (failurePolicy) => {
      const rejected = commitReceipt('rejected', 'attachment:rejected', 'source:rejected');
      const unknown = commitReceipt('unknown', 'attachment:unknown', 'source:unknown');
      const after = vi.fn(async () => commitReceipt(
        'committed',
        'attachment:after',
        'source:after'
      ));
      const steps = [
        databaseStep('rejected', rejected),
        databaseStep('unknown', unknown),
        {
          stepId: 'thrown',
          attachmentId: 'attachment:thrown',
          sourceId: 'source:thrown',
          transact: async (): Promise<CommitReceipt> => { throw new Error('offline'); }
        },
        {
          stepId: 'after',
          attachmentId: 'attachment:after',
          sourceId: 'source:after',
          transact: after
        }
      ];

      const batch = await executeDatabaseNonAtomicBatch({
        batchId: 'batch:evidence:' + failurePolicy,
        failurePolicy,
        steps
      });

      if (failurePolicy === 'stop') {
        expect(batch).toMatchObject({
          outcome: 'failed',
          steps: [
            { outcome: 'failed', receipt: rejected },
            { outcome: 'unattempted' },
            { outcome: 'unattempted' },
            { outcome: 'unattempted' }
          ]
        });
        expect(after).not.toHaveBeenCalled();
      } else {
        expect(batch).toMatchObject({
          outcome: 'unknown',
          steps: [
            { outcome: 'failed', receipt: rejected },
            { outcome: 'unknown', receipt: unknown },
            { outcome: 'unknown' },
            { outcome: 'applied' }
          ],
          issues: [{ code: 'transaction.batch_step_outcome_unknown' }]
        });
        expect(after).toHaveBeenCalledOnce();
      }
    }
  );

  it('cancels before the next callback without discarding completed evidence', async () => {
    const controller = new AbortController();
    const first = commitReceipt('committed', 'attachment:first', 'source:first');
    const second = vi.fn(async () => commitReceipt(
      'committed',
      'attachment:second',
      'source:second'
    ));

    const batch = await executeDatabaseNonAtomicBatch({
      batchId: 'batch:cancelled',
      failurePolicy: 'continue',
      signal: controller.signal,
      steps: [
        {
          ...databaseStep('first', first),
          transact: async () => {
            controller.abort();
            return first;
          }
        },
        {
          stepId: 'second',
          attachmentId: 'attachment:second',
          sourceId: 'source:second',
          transact: second
        }
      ]
    });

    expect(batch).toMatchObject({
      outcome: 'partial',
      steps: [{ outcome: 'applied', receipt: first }, { outcome: 'unattempted' }],
      issues: [{ code: 'transaction.cancelled', details: { timing: 'before_batch_step' } }]
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('fails closed on receipt identity disagreement while retaining the receipt', async () => {
    const wrong = commitReceipt('committed', 'attachment:actual', 'source:actual');

    const batch = await executeDatabaseNonAtomicBatch({
      batchId: 'batch:mismatch',
      failurePolicy: 'stop',
      steps: [{
        stepId: 'mismatch',
        attachmentId: 'attachment:expected',
        sourceId: 'source:expected',
        transact: async () => wrong
      }]
    });

    expect(batch).toMatchObject({
      outcome: 'unknown',
      steps: [{
        attachmentId: 'attachment:expected',
        sourceId: 'source:expected',
        outcome: 'unknown'
      }],
      issues: [{
        code: 'transaction.batch_step_outcome_unknown',
        details: { reason: 'receipt_identity_mismatch' }
      }]
    });
    expect(batch.steps[0]?.receipt).toBe(wrong);
  });

  it('uses equivalent aggregation for portable attempts and database callbacks', async () => {
    const receipts = [
      commitReceipt('committed', 'attachment:one', 'source:one'),
      commitReceipt('rejected', 'attachment:two', 'source:two'),
      commitReceipt('committed', 'attachment:three', 'source:three')
    ];
    const database = await executeDatabaseNonAtomicBatch({
      batchId: 'batch:equivalent',
      failurePolicy: 'continue',
      steps: receipts.map((receipt, index) => databaseStep(String(index), receipt))
    });
    const attempts = receipts.map((receipt, index) => ({
      stepId: String(index),
      attempt: transactionAttempt(receipt.attachmentId, String(index))
    }));
    const byAttachment = new Map(receipts.map((receipt) => [receipt.attachmentId, receipt]));
    const portable = await executeNonAtomicBatch({
      batchId: 'batch:equivalent',
      failurePolicy: 'continue',
      steps: attempts
    }, {
      sourceIdFor: (attempt) => byAttachment.get(attempt.attachmentId)!.sourceId,
      commit: async (attempt) => byAttachment.get(attempt.attachmentId)!
    });

    expect(portable).toEqual(database);
  });
});

const databaseStep = (
  stepId: string,
  receipt: CommitReceipt
) => ({
  stepId,
  attachmentId: receipt.attachmentId,
  sourceId: receipt.sourceId,
  transact: async () => receipt
});

const transactionService = (receipt: CommitReceipt): DatabaseTransactionService => ({
  capabilities: vi.fn(),
  transact: vi.fn(async () => receipt),
  simulate: vi.fn()
});

const transactionAttempt = (
  attachmentId: string,
  operationId: string
): TransactionAttempt => ({
  operationEpoch: 'epoch:batch',
  operationId,
  attachmentId,
  transaction: {
    id: 'urn:test:batch:transaction',
    contentHash: `sha256:${'1'.repeat(64)}`
  }
});

const commitReceipt = (
  outcome: CommitReceipt['outcome'],
  attachmentId: string,
  sourceId: string
): CommitReceipt => {
  const evidence = {
    kind: 'commit' as const,
    receiptVersion: 1 as const,
    operationEpoch: 'epoch:batch',
    operationId: 'operation:' + attachmentId,
    transactionHash: `sha256:${'2'.repeat(64)}` as const,
    intentHash: `sha256:${'3'.repeat(64)}` as const,
    attachmentId,
    attachmentFingerprint: `sha256:${'4'.repeat(64)}` as const,
    sourceId,
    statementResults: [],
    issues: []
  };
  if (outcome === 'committed') {
    return {
      ...evidence,
      outcome,
      beforeBasis: { revision: 1 },
      afterBasis: { revision: 2 },
      durability: 'memory'
    };
  }
  return outcome === 'rejected'
    ? { ...evidence, outcome, beforeBasis: { revision: 1 } }
    : { ...evidence, outcome, beforeBasis: { revision: 1 }, durability: 'unknown' };
};
