import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { executePresence, executeSequence, safeParseReceipt, safeParseReceiptText, type CommitReceipt, type SourceBasis, type SourceLifecycleReceipt } from '../src/index.js';

const hash = `sha256:${'a'.repeat(64)}` as const;
const lifecycle = (outcome: 'committed' | 'rejected' | 'unknown', sourceId = 'source:new'): SourceLifecycleReceipt => ({
  kind: 'source-lifecycle', receiptVersion: 1, lifecycleCoordinatorId: 'lifecycle', operationEpoch: 'epoch', operationId: 'create', commandHash: hash, action: 'create', sourceId, outcome, issues: []
});
const commitEvidence = {
  kind: 'commit', receiptVersion: 1, operationEpoch: 'epoch', operationId: 'operation', transactionHash: hash, intentHash: hash,
  attachmentId: 'attachment', attachmentFingerprint: hash, sourceId: 'source', statementResults: [], issues: []
} as const;

const expectDeepFrozen = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const member of Object.values(value)) expectDeepFrozen(member);
};

const narrowCommitReceipt = (receipt: CommitReceipt): void => {
  if (receipt.outcome === 'committed') expectTypeOf(receipt.afterBasis).toEqualTypeOf<SourceBasis>();
  if (receipt.outcome === 'unknown') expectTypeOf(receipt.durability).toEqualTypeOf<'unknown'>();
  if (receipt.outcome === 'rejected') {
    // @ts-expect-error rejected receipts make no after-basis claim
    void receipt.afterBasis;
  }
};
void narrowCommitReceipt;

// @ts-expect-error committed receipts require before/after basis evidence
const invalidCommittedReceipt: CommitReceipt = { ...commitEvidence, outcome: 'committed', durability: 'memory' };
void invalidCommittedReceipt;

describe('receipt forwarding and shell sequences', () => {
  it('forwards unknown future receipt kinds without inferring success', () => {
    const result = safeParseReceipt({ kind: 'future-workflow', receiptVersion: 8, outcome: 'committed', issues: [], payload: { retained: true } });
    expect(result).toMatchObject({ success: true, value: { kind: 'unknown_receipt', original: { kind: 'future-workflow', payload: { retained: true } }, issues: [{ code: 'receipt.unknown_kind_version', retry: 'never' }] } });
  });

  it('detaches and recursively freezes known and unknown receipt evidence', () => {
    const knownInput = {
      kind: 'presence', receiptVersion: 1, operationId: 'known', attachmentId: 'attachment', outcome: 'accepted',
      issues: [{ id: 'test.issue:known', code: 'test.issue', severity: 'warning', phase: 'presence', details: { nested: ['original'] } }]
    };
    const known = safeParseReceipt(knownInput);
    if (!known.success) throw new Error('expected known receipt');
    expectDeepFrozen(known.value);
    knownInput.issues[0]!.details.nested.push('caller mutation');
    expect(known.value.issues[0]?.details).toEqual({ nested: ['original'] });

    const unknownInput = { kind: 'future-workflow', receiptVersion: 8, payload: { nested: ['original'] } };
    const unknown = safeParseReceipt(unknownInput);
    if (!unknown.success || unknown.value.kind !== 'unknown_receipt') throw new Error('expected unknown receipt wrapper');
    expectDeepFrozen(unknown.value);
    unknownInput.payload.nested.push('caller mutation');
    expect(unknown.value.original).toMatchObject({ payload: { nested: ['original'] } });
  });

  it('does not charge an unknown receipt payload against the parse budget twice', () => {
    const payload = Array.from({ length: 5 }, () => Array<null>(99_995).fill(null));
    const result = safeParseReceipt({ kind: 'future-near-budget', receiptVersion: 2, payload });

    expect(result).toMatchObject({ success: true, value: { kind: 'unknown_receipt' } });
  });

  it('rejects malformed known receipts and duplicate JSON members before casting', () => {
    expect(safeParseReceipt({ kind: 'commit', receiptVersion: 1, issues: [] })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'committed', durability: 'memory' })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'rejected', afterBasis: 1 })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'unknown' })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'rejected', statementResults: [{ statementIndex: 0, matched: 0, logicallyChanged: 0, inserted: 0, deleted: 0, editOutcomes: [42], issues: [] }] })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'rejected', returning: [42] })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'rejected', generatedKeys: [{ relationId: 'items', token: 'new' }] })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ ...commitEvidence, outcome: 'rejected', generatedKeys: [{ relationId: 'items', token: 'new', key: ['id'] }] })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceipt({ kind: 'presence', receiptVersion: 1, operationId: 'one', attachmentId: 'a', outcome: 'accepted', issues: [{ id: 'bad', code: 'bad', severity: 'fatal', phase: 'query' }] })).toMatchObject({ success: false, issues: [{ code: 'receipt.invalid' }] });
    expect(safeParseReceiptText('{"kind":"presence","kind":"presence","receiptVersion":1,"operationId":"one","attachmentId":"a","outcome":"accepted","issues":[]}')).toMatchObject({ success: false, issues: [{ code: 'artifact.duplicate_member' }] });
  });

  it('forwards generated logical key evidence on committed receipts', () => {
    const receipt = safeParseReceipt({
      ...commitEvidence,
      outcome: 'committed',
      beforeBasis: { revision: 1 },
      afterBasis: { revision: 2 },
      durability: 'local',
      generatedKeys: [{ relationId: 'items', token: 'new', key: ['source-id'] }]
    });

    expect(receipt).toMatchObject({
      success: true,
      value: {
        kind: 'commit',
        generatedKeys: [{ relationId: 'items', token: 'new', key: ['source-id'] }]
      }
    });
    if (!receipt.success) throw new Error('expected generated key receipt');
    expectDeepFrozen(receipt.value);
  });

  it('retains successful creation and reports its source as orphaned after a later failure', async () => {
    const receipt = await executeSequence({
      sequenceId: 'sequence:create-link',
      steps: [
        { stepId: 'create', run: async () => lifecycle('committed') },
        { stepId: 'link', run: async () => lifecycle('rejected', 'source:existing') },
        { stepId: 'later', run: async () => lifecycle('committed') }
      ]
    });
    expect(receipt).toMatchObject({ outcome: 'partial', orphanedSourceIds: ['source:new'], steps: [{ outcome: 'applied', receipt: { sourceId: 'source:new' } }, { outcome: 'failed', receipt: { outcome: 'rejected' } }, { outcome: 'unattempted' }] });
  });

  it('validates presence shape and converts adapter failure to a receipt', async () => {
    const accept = vi.fn(async () => []);
    expect(await executePresence({ operationId: 'one', attachmentId: 'a', sessionId: 's', action: 'set' }, accept)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'presence.command_invalid' }] });
    expect(accept).not.toHaveBeenCalled();
    expect(await executePresence({ operationId: 'two', attachmentId: 'a', sessionId: 's', action: 'clear' }, async () => { throw new Error('offline'); })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'presence.accept_failed' }] });
  });
});
