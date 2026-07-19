import { describe, expect, it } from 'vitest';
import type { DatabaseTextPositionRequest } from '../src/database/transaction.js';
import type { CommitReceipt } from '../src/transaction.js';
import { settleRetainedTextPositions } from '../src/attachment/retained-text-positions.js';

const basis = Object.freeze({ kind: 'test', revision: 1 });
const position = Object.freeze({
  name: 'focus'
}) as unknown as DatabaseTextPositionRequest;
const commitEvidence = {
  kind: 'commit',
  receiptVersion: 1,
  operationEpoch: 'epoch',
  operationId: 'operation',
  transactionHash: '0'.repeat(64),
  intentHash: '1'.repeat(64),
  attachmentId: 'attachment',
  attachmentFingerprint: '2'.repeat(64),
  sourceId: 'source',
  statementResults: [],
  issues: [],
  beforeBasis: basis
} as const;

describe('retained text position settlement', () => {
  it.each([
    {
      label: 'unsupported committed source',
      receipt: {
        ...commitEvidence,
        outcome: 'committed',
        afterBasis: basis,
        durability: 'memory'
      } as CommitReceipt,
      aborted: false,
      state: 'unsupported'
    },
    {
      label: 'unknown publication',
      receipt: {
        ...commitEvidence,
        outcome: 'unknown',
        durability: 'unknown'
      } as CommitReceipt,
      aborted: false,
      state: 'unknown'
    },
    {
      label: 'cancelled rejected publication',
      receipt: {
        ...commitEvidence,
        outcome: 'rejected'
      } as CommitReceipt,
      aborted: true,
      state: 'cancelled'
    }
  ])('reports $label without invoking source mechanics', ({ receipt, aborted, state }) => {
    const abort = new AbortController();
    if (aborted) abort.abort();

    expect(settleRetainedTextPositions({
      receipt,
      signal: abort.signal,
      positions: [position]
    })).toMatchObject([{ name: 'focus', state }]);
  });

  it('turns malformed adapter output into unknown evidence', () => {
    const receipt = {
      ...commitEvidence,
      outcome: 'committed',
      afterBasis: basis,
      durability: 'memory'
    } as CommitReceipt;

    expect(settleRetainedTextPositions({
      receipt,
      signal: new AbortController().signal,
      positions: [position],
      optimistic: {},
      committed: {},
      resolve: () => []
    })).toMatchObject([{
      name: 'focus',
      state: 'unknown',
      issues: [expect.objectContaining({
        details: expect.objectContaining({ reason: 'text_position_resolution_invalid' })
      })]
    }]);
  });
});
