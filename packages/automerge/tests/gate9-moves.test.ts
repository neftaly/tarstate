import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import {
  automergeCopyRelocateCapability,
  copyRelocateAutomerge,
  initializeAutomergeMoveMetadata,
  readAutomergeMoveRecords,
  repairAutomergeLiveFork,
  resolveAutomergeMoveReference,
  type AutomergeMoveRecordV1
} from '../src/move.js';
import { projectAutomergeFacts } from '../src/projection.js';
import { automergeBasis } from '../src/source.js';

const actor = (digit: string): string => digit.repeat(64);

describe('gate 9 move evidence and live repair', () => {
  it('resolves recorded descendant references and fails closed for an unrecorded list mapping', async () => {
    type Doc = {
      active: { item?: { nested: { value: string }; list: { value: string }[] } };
      archive: { item?: { nested: { value: string }; list: { value: string }[] } };
      __tarstateMovesV1?: Record<string, unknown>;
    };
    const base = Automerge.from<Doc>({
      active: { item: { nested: { value: 'nested' }, list: [{ value: 'list child' }] } },
      archive: {}
    }, { actor: actor('1') });
    const oldNestedId = Automerge.getObjectId(base.active.item!.nested);
    const oldListId = Automerge.getObjectId(base.active.item!.list);
    expect(oldNestedId).toBeTypeOf('string');
    expect(oldListId).toBeTypeOf('string');
    const moved = await copyRelocateAutomerge(base, {
      operationEpoch: 'epoch:references', operationId: 'operation:references', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['archive', 'item']
    });
    expect(resolveAutomergeMoveReference(moved.record, oldNestedId!)).toMatchObject({
      status: 'resolved', fromObjectId: oldNestedId, relativePath: ['nested'], toObjectId: expect.any(String)
    });
    expect(resolveAutomergeMoveReference(moved.record, oldListId!)).toMatchObject({
      status: 'unresolved', reason: 'mapping-incomplete', preservationLosses: expect.arrayContaining(['automerge.descendant_mapping_incomplete'])
    });
    expect(resolveAutomergeMoveReference(moved.record, 'unrelated-object')).toMatchObject({ status: 'unresolved', reason: 'mapping-incomplete' });
  });

  it('retains a concurrent old-subtree edit in historical heads without forwarding it to the live copy', async () => {
    type Doc = {
      active: { item?: { title: string; nested: { label: string } } };
      archive: { item?: { title: string; nested: { label: string } } };
      __tarstateMovesV1?: Record<string, unknown>;
    };
    const base = Automerge.from<Doc>({ active: { item: { title: 'Original', nested: { label: 'old' } } }, archive: {} }, { actor: actor('2') });
    const movePeer = Automerge.clone(base, { actor: actor('3') });
    let editPeer = Automerge.clone(base, { actor: actor('4') });
    editPeer = Automerge.change(editPeer, { time: 0 }, (draft) => { draft.active.item!.nested.label = 'remote edit'; });
    const remoteHeads = [...Automerge.getHeads(editPeer)];
    const moved = await copyRelocateAutomerge(movePeer, {
      operationEpoch: 'epoch:old-edit', operationId: 'operation:old-edit', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['archive', 'item']
    });
    const merged = Automerge.merge(moved.doc, editPeer);
    expect(merged.active.item).toBeUndefined();
    expect(merged.archive.item?.nested.label).toBe('old');
    expect(Automerge.view(merged, remoteHeads).active.item?.nested.label).toBe('remote edit');
    expect(moved.record.preservationLosses).toContain('automerge.concurrent_old_subtree_edits_not_forwarded');
  });

  it('diagnoses actual move chains and retained history cycles', async () => {
    type ChainDoc = {
      active: { item?: { value: string } };
      middle: { item?: { value: string } };
      archive: { item?: { value: string } };
      __tarstateMovesV1?: Record<string, unknown>;
    };
    const base = Automerge.from<ChainDoc>({ active: { item: { value: 'x' } }, middle: {}, archive: {} }, { actor: actor('5') });
    const first = await copyRelocateAutomerge(base, {
      operationEpoch: 'epoch:chain', operationId: 'operation:first', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['middle', 'item']
    });
    const second = await copyRelocateAutomerge(first.doc, {
      operationEpoch: 'epoch:chain', operationId: 'operation:second', statementIndex: 1,
      fromPath: ['middle', 'item'], toPath: ['archive', 'item']
    });
    expect(projectAutomergeFacts(second.doc).issues).toContainEqual(expect.objectContaining({
      code: 'automerge.move_chain_history',
      details: { objectIds: [first.record.oldRootObjectId, first.record.newRootObjectId, second.record.newRootObjectId] }
    }));

    const cycle = Automerge.from({
      __tarstateMovesV1: {
        first: record('object:a', 'object:b', ['a'], ['b']),
        second: record('object:b', 'object:a', ['b'], ['a'])
      }
    }, { actor: actor('6') });
    const issues = projectAutomergeFacts(cycle).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'automerge.move_cycle_history' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'automerge.move_chain_history' }));
  });

  it('repairs only an exact authority-approved live fork and retains immutable fork history', async () => {
    type ForkDoc = {
      active: { item?: { title: string } };
      left: { item?: { title: string } };
      right: { item?: { title: string } };
      __tarstateMovesV1?: Record<string, unknown>;
    };
    let base = Automerge.from<ForkDoc>({ active: { item: { title: 'shared' } }, left: {}, right: {} }, { actor: actor('7') });
    base = initializeAutomergeMoveMetadata(base);
    const left = await copyRelocateAutomerge(Automerge.clone(base, { actor: actor('8') }), {
      operationEpoch: 'epoch:fork', operationId: 'operation:left', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['left', 'item']
    });
    const right = await copyRelocateAutomerge(Automerge.clone(base, { actor: actor('9') }), {
      operationEpoch: 'epoch:fork', operationId: 'operation:right', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['right', 'item']
    });
    const merged = Automerge.merge(left.doc, right.doc);
    const observed = readAutomergeMoveRecords(merged).map(({ recordId, record }) => ({ recordId, newRootObjectId: record.newRootObjectId, toPath: record.toPath }));
    const historyBeforeRepair = JSON.stringify(readAutomergeMoveRecords(merged));
    const input = {
      governanceAuthorized: true,
      expectedBasis: automergeBasis(merged),
      oldRootObjectId: left.record.oldRootObjectId,
      observedAlternatives: observed,
      selectedRecordId: left.recordId
    } as const;
    expect(() => repairAutomergeLiveFork(merged, { ...input, governanceAuthorized: false })).toThrow(expect.objectContaining({ code: 'automerge.move_repair_governance_required' }));
    expect(() => repairAutomergeLiveFork(merged, { ...input, expectedBasis: automergeBasis(left.doc) })).toThrow(expect.objectContaining({ code: 'automerge.move_repair_basis_stale' }));
    expect(() => repairAutomergeLiveFork(merged, { ...input, observedAlternatives: observed.slice(0, 1) })).toThrow(expect.objectContaining({ code: 'automerge.move_repair_alternatives_changed' }));
    expect(() => repairAutomergeLiveFork(merged, { ...input, selectedRecordId: 'unobserved' })).toThrow(expect.objectContaining({ code: 'automerge.move_repair_selection_invalid' }));

    const repaired = repairAutomergeLiveFork(merged, input);
    expect(repaired.doc.left.item?.title).toBe('shared');
    expect(repaired.doc.right.item).toBeUndefined();
    expect(repaired.retainedRecordIds).toEqual([left.recordId, right.recordId].sort());
    expect(JSON.stringify(readAutomergeMoveRecords(repaired.doc))).toBe(historyBeforeRepair);
    const facts = projectAutomergeFacts(repaired.doc);
    expect(facts.moves.map(({ recordId }) => recordId).sort()).toEqual(repaired.retainedRecordIds);
    expect(facts.issues).toContainEqual(expect.objectContaining({ code: 'automerge.move_fork_history' }));
    expect(() => repairAutomergeLiveFork(repaired.doc, { ...input, expectedBasis: repaired.afterBasis })).toThrow(expect.objectContaining({ code: 'automerge.move_repair_not_live_fork' }));
  });

  it('reads both legacy move shapes alongside current immutable move records', async () => {
    type LegacyDoc = {
      active: { item?: { value: string } };
      archive: { item?: { value: string } };
      __tarstateMovesV1?: Record<string, unknown>;
      __automergeMoves?: Record<string, unknown>;
    };
    const base = Automerge.from<LegacyDoc>({ active: { item: { value: 'x' } }, archive: {} }, { actor: actor('a') });
    const moved = await copyRelocateAutomerge(base, {
      operationEpoch: 'epoch:legacy', operationId: 'operation:current', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['archive', 'item']
    });
    const withLegacy = Automerge.change(moved.doc, { time: 0 }, (draft) => {
      draft.__automergeMoves = {
        'old-object-id': 'new-object-id',
        'path-record': { from: ['old', 'path'], to: ['new', 'path'] }
      };
    });
    const facts = projectAutomergeFacts(withLegacy);
    expect(facts.moves).toContainEqual(expect.objectContaining({ recordId: moved.recordId }));
    expect(facts.legacyMoves).toEqual([
      expect.objectContaining({ legacyKey: 'old-object-id', shape: 'object-id', value: 'new-object-id', basisKnown: false }),
      expect.objectContaining({ legacyKey: 'path-record', shape: 'path-relocation', value: { from: ['old', 'path'], to: ['new', 'path'] }, basisKnown: false })
    ]);
  });
});

const record = (oldRootObjectId: string, newRootObjectId: string, fromPath: readonly string[], toPath: readonly string[]): AutomergeMoveRecordV1 => ({
  formatVersion: 1,
  operationEpoch: 'epoch:synthetic',
  operationId: oldRootObjectId + '->' + newRootObjectId,
  statementIndex: 0,
  beforeHeads: [],
  fromPath,
  toPath,
  oldRootObjectId,
  newRootObjectId,
  descendants: [],
  mechanism: automergeCopyRelocateCapability,
  preservationLosses: ['automerge.root_object_identity_changed']
});
