import { describe, expect, it, vi } from 'vitest';
import { executePresence, executeSequence, safeParseReceipt, type SourceLifecycleReceipt } from '../src/index.js';

const hash = `sha256:${'a'.repeat(64)}` as const;
const lifecycle = (outcome: 'committed' | 'rejected' | 'unknown', sourceId = 'source:new'): SourceLifecycleReceipt => ({
  kind: 'source-lifecycle', receiptVersion: 1, lifecycleCoordinatorId: 'lifecycle', operationEpoch: 'epoch', operationId: 'create', commandHash: hash, action: 'create', sourceId, outcome, issues: []
});

describe('receipt forwarding and shell sequences', () => {
  it('forwards unknown future receipt kinds without inferring success', () => {
    const result = safeParseReceipt({ kind: 'future-workflow', receiptVersion: 8, outcome: 'committed', issues: [], payload: { retained: true } });
    expect(result).toMatchObject({ success: true, value: { kind: 'unknown_receipt', original: { kind: 'future-workflow', payload: { retained: true } }, issues: [{ code: 'receipt.unknown_kind_version', retry: 'never' }] } });
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
