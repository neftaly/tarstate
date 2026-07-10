import { createHash } from 'node:crypto';
import * as Automerge from '@automerge/automerge';
import { NetworkAdapter, Presence, Repo, type Message, type PeerId, type PeerMetadata, type StorageId } from '@automerge/automerge-repo';
import { describe, expect, it, vi } from 'vitest';
import { copyRelocateAutomerge, exactAutomergeHeadsEqual } from '../src/v1-spike.js';

const actor = (digit: string) => digit.repeat(64);

type DuplicateDoc = { tasks: Record<string, { title: string }>; metadata: { schema: string } };
type MoveNode = { title: string; count: Automerge.Counter; text: string; nested: { flag: boolean }; list: string[] };
type MoveDoc = {
  active: { item?: MoveNode };
  archive: { item?: MoveNode };
  __tarstateMovesV1?: Record<string, unknown>;
};

const duplicateBase = (): Automerge.Doc<DuplicateDoc> => Automerge.from({ tasks: {}, metadata: { schema: 'base' } }, { actor: actor('1') });

const moveBase = (): Automerge.Doc<MoveDoc> => {
  let doc = Automerge.init<MoveDoc>({ actor: actor('a') });
  doc = Automerge.change(doc, { time: 0, message: 'fixture' }, (draft) => {
    draft.active = { item: { title: 'Original', count: new Automerge.Counter(2), text: 'hello', nested: { flag: true }, list: ['a', 'b'] } };
    draft.archive = {};
  });
  return doc;
};

describe('v1 Automerge spike', () => {
  it('compares exact heads as an unordered set and retains historical views', () => {
    const base = duplicateBase();
    const changed = Automerge.change(base, { time: 0 }, (draft) => { draft.metadata.schema = 'next'; });
    const heads = Automerge.getHeads(changed);
    expect(exactAutomergeHeadsEqual(heads, [...heads].reverse())).toBe(true);
    expect(exactAutomergeHeadsEqual(Automerge.getHeads(base), heads)).toBe(false);
    expect(Automerge.view(changed, Automerge.getHeads(base)).metadata.schema).toBe('base');
  });

  it('retains concurrent duplicate map-key candidates instead of choosing a semantic winner', () => {
    const base = duplicateBase();
    let left = Automerge.clone(base, { actor: actor('2') });
    let right = Automerge.clone(base, { actor: actor('3') });
    left = Automerge.change(left, { time: 0 }, (draft) => { draft.tasks.same = { title: 'Left' }; });
    right = Automerge.change(right, { time: 0 }, (draft) => { draft.tasks.same = { title: 'Right' }; });
    const merged = Automerge.merge(left, right);
    const conflicts = Automerge.getConflicts(merged.tasks, 'same');
    expect(Object.values(conflicts ?? {}).map((candidate) => (candidate as { title: string }).title).sort((leftTitle, rightTitle) => leftTitle.localeCompare(rightTitle))).toEqual(['Left', 'Right']);
    expect(Object.values(conflicts ?? {}).map((candidate) => Automerge.getObjectId(candidate as object))).toEqual([undefined, undefined]);
    expect(Automerge.getObjectId(merged.tasks.same)).toBeTypeOf('string');
  });

  it('exposes conflicted schema metadata and an ordinary causal assignment clears it', () => {
    const base = duplicateBase();
    let left = Automerge.clone(base, { actor: actor('4') });
    let right = Automerge.clone(base, { actor: actor('5') });
    left = Automerge.change(left, { time: 0 }, (draft) => { draft.metadata.schema = 'schema:left'; });
    right = Automerge.change(right, { time: 0 }, (draft) => { draft.metadata.schema = 'schema:right'; });
    const merged = Automerge.merge(left, right);
    const schemaConflicts = Object.values(Automerge.getConflicts(merged.metadata, 'schema') ?? {}) as string[];
    expect(schemaConflicts.sort((leftSchema, rightSchema) => leftSchema.localeCompare(rightSchema))).toEqual(['schema:left', 'schema:right']);
    const resolved = Automerge.change(merged, { time: 0 }, (draft) => { draft.metadata.schema = 'schema:resolved'; });
    expect(Automerge.getConflicts(resolved.metadata, 'schema')).toBeUndefined();
    expect(resolved.metadata.schema).toBe('schema:resolved');
  });

  it('records fallback relocation IDs and the measured counter/text/list preservation losses', async () => {
    const base = moveBase();
    const oldRootId = Automerge.getObjectId(base.active.item as object);
    const oldNestedId = Automerge.getObjectId(base.active.item?.nested as object);
    const result = await copyRelocateAutomerge(base, {
      operationEpoch: 'epoch:move', operationId: 'operation:move', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['archive', 'item']
    });
    expect(result.doc.active.item).toBeUndefined();
    expect(result.doc.archive.item).toMatchObject({ title: 'Original', text: 'hello', nested: { flag: true }, list: ['a', 'b'] });
    expect(Number(result.doc.archive.item?.count)).toBe(2);
    expect(Automerge.isCounter(result.doc.archive.item?.count)).toBe(true);
    expect(result.record).toMatchObject({ oldRootObjectId: oldRootId, newRootObjectId: Automerge.getObjectId(result.doc.archive.item as object) });
    expect(result.record.newRootObjectId).not.toBe(oldRootId);
    expect(result.record.descendants).toEqual(expect.arrayContaining([expect.objectContaining({ fromObjectId: oldNestedId, relativePath: ['nested'] })]));
    expect(result.record.preservationLosses).toEqual(expect.arrayContaining([
      'automerge.concurrent_old_subtree_edits_not_forwarded',
      'automerge.counter_identity_changed',
      'automerge.descendant_mapping_incomplete',
      'automerge.descendant_object_identity_changed',
      'automerge.list_element_identity_changed',
      'automerge.root_object_identity_changed',
      'automerge.text_identity_changed'
    ]));
    expect(result.doc.__tarstateMovesV1?.[result.recordId]).toEqual(result.record);
  });

  it('does not surface concurrent old-subtree edits in live state after copy relocation', async () => {
    const base = moveBase();
    const relocatingPeer = Automerge.clone(base, { actor: actor('b') });
    let editingPeer = Automerge.clone(base, { actor: actor('c') });
    const relocated = await copyRelocateAutomerge(relocatingPeer, {
      operationEpoch: 'epoch:concurrent', operationId: 'operation:concurrent', statementIndex: 0,
      fromPath: ['active', 'item'], toPath: ['archive', 'item']
    });
    editingPeer = Automerge.change(editingPeer, { time: 0 }, (draft) => {
      if (draft.active.item === undefined) throw new Error('fixture item missing');
      draft.active.item.title = 'Concurrent edit';
      draft.active.item.count.increment(3);
      Automerge.splice(draft, ['active', 'item', 'text'], 5, 0, '!');
    });
    const merged = Automerge.merge(relocated.doc, editingPeer);
    expect(merged.active.item).toBeUndefined();
    expect(merged.archive.item).toMatchObject({ title: 'Original', text: 'hello' });
    expect(Number(merged.archive.item?.count)).toBe(2);
    const historical = Automerge.view(merged, Automerge.getHeads(editingPeer)).active.item;
    expect(historical).toMatchObject({ title: 'Concurrent edit', text: 'hello!' });
    expect(Number(historical?.count)).toBe(5);
  });

  it('produces deterministic golden bytes for the frozen fallback record', async () => {
    const first = await copyRelocateAutomerge(moveBase(), { operationEpoch: 'epoch:golden', operationId: 'operation:golden', statementIndex: 7, fromPath: ['active', 'item'], toPath: ['archive', 'item'] });
    const second = await copyRelocateAutomerge(moveBase(), { operationEpoch: 'epoch:golden', operationId: 'operation:golden', statementIndex: 7, fromPath: ['active', 'item'], toPath: ['archive', 'item'] });
    const firstBytes = Automerge.save(first.doc);
    expect(firstBytes).toEqual(Automerge.save(second.doc));
    expect(createHash('sha256').update(firstBytes).digest('hex')).toBe('85776c89abd082ae4d29e4b72bc19732089931b348e0083b95abc3d99c4e93e6');
  });

  it('uses stable peer/storage/channel identities and explicit connection/presence lifecycles', async () => {
    const network = new ProbeNetwork();
    const repo = new Repo({ peerId: 'peer:local' as PeerId, network: [network] });
    const peers: { peerId: PeerId; peerMetadata: PeerMetadata }[] = [];
    repo.networkSubsystem.on('peer', (event) => peers.push(event));
    network.peerCandidate('peer:remote' as PeerId, { storageId: 'storage:remote' as StorageId, isEphemeral: true });
    await vi.waitFor(() => expect(repo.peers).toContain('peer:remote'));
    expect(peers).toEqual([{ peerId: 'peer:remote', peerMetadata: { storageId: 'storage:remote', isEphemeral: true } }]);

    const handle = repo.create<{ value: string }>({ value: 'initial' });
    const remoteHeads = vi.fn();
    handle.on('remote-heads', remoteHeads);
    handle.emit('remote-heads', { storageId: 'storage:remote' as StorageId, heads: ['head:remote'] as never, timestamp: 10 });
    expect(remoteHeads).toHaveBeenCalledWith({ storageId: 'storage:remote', heads: ['head:remote'], timestamp: 10 });

    const presence = new Presence<Record<string, unknown>, { value: string }>({ handle });
    expect(presence.running).toBe(false);
    presence.start({ initialState: { cursor: 'a1' }, heartbeatMs: 60_000 });
    expect(presence.running).toBe(true);
    expect(presence.getLocalState()).toEqual({ cursor: 'a1' });
    presence.stop();
    expect(presence.running).toBe(false);

    network.peerDisconnected('peer:remote' as PeerId);
    await vi.waitFor(() => expect(repo.peers).not.toContain('peer:remote'));
    await repo.shutdown();
  });
});

class ProbeNetwork extends NetworkAdapter {
  isReady(): boolean { return true; }
  whenReady(): Promise<void> { return Promise.resolve(); }
  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void { this.peerId = peerId; if (peerMetadata !== undefined) this.peerMetadata = peerMetadata; }
  disconnect(): void {}
  send(_message: Message): void {}
  peerCandidate(peerId: PeerId, peerMetadata: PeerMetadata): void { this.emit('peer-candidate', { peerId, peerMetadata }); }
  peerDisconnected(peerId: PeerId): void { this.emit('peer-disconnected', { peerId }); }
}
