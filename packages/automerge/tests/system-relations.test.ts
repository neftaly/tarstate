import { prepareSchema } from '@tarstate/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeSystemRelationState,
  automergeSystemRelationIds,
  automergeSystemSchema,
  materializeAutomergeConflictRows,
  materializeAutomergeSyncRow,
  type AutomergeConflictFact
} from '../src/index.js';

describe('Automerge system relations', () => {
  it('declares the five normalized relations with measured identity keys', () => {
    const prepared = prepareSchema(automergeSystemSchema);
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    expect([...prepared.value.relationsById.keys()].sort()).toEqual(Object.values(automergeSystemRelationIds).sort());
    expect(prepared.value.relationsById.get(automergeSystemRelationIds.peers)?.declaration.key).toEqual(['attachmentId', 'peerId']);
    expect(prepared.value.relationsById.get(automergeSystemRelationIds.connections)?.declaration.key).toEqual(['attachmentId', 'peerId']);
    expect(prepared.value.relationsById.get(automergeSystemRelationIds.sync)?.declaration.key).toEqual(['attachmentId', 'documentId', 'storageId']);
    expect(prepared.value.relationsById.get(automergeSystemRelationIds.conflicts)?.declaration.key).toEqual(['issueId']);
    expect(prepared.value.relationsById.get(automergeSystemRelationIds.presence)?.declaration.key).toEqual(['attachmentId', 'peerId', 'channel']);
    expect('connectionId' in (automergeSystemSchema.relations.connections.fields as object)).toBe(false);
  });

  it('normalizes peer lifecycle without inventing a connection ID and correlates only unambiguous storage metadata', () => {
    const state = new AutomergeSystemRelationState('attachment:one');
    const listener = vi.fn();
    state.subscribe(listener);
    state.apply({ kind: 'remote-heads', documentId: 'document:one', storageId: 'storage:one', heads: ['b', 'a', 'a'], timestamp: 1 });
    expect(state.getSnapshot().sync).toEqual([expect.objectContaining({ heads: ['a', 'b'], state: 'synced' })]);
    expect(state.getSnapshot().sync[0]).not.toHaveProperty('peerId');

    state.apply({
      kind: 'peer-observed', peerId: 'peer:one', observedAt: 2,
      peerMetadata: { storageId: 'storage:one', isEphemeral: true, metadata: { transport: 'test' } }
    });
    expect(state.getSnapshot()).toMatchObject({
      peers: [{ peerId: 'peer:one', state: 'observed', storageId: 'storage:one', isEphemeral: true }],
      connections: [{ peerId: 'peer:one', state: 'connected' }],
      sync: [{ peerId: 'peer:one' }]
    });
    expect(state.getSnapshot().connections[0]).not.toHaveProperty('connectionId');

    state.apply({ kind: 'peer-observed', peerId: 'peer:two', observedAt: 3, peerMetadata: { storageId: 'storage:one' } });
    expect(state.getSnapshot().sync[0]).not.toHaveProperty('peerId');
    state.apply({ kind: 'peer-disconnected', peerId: 'peer:two', observedAt: 4 });
    expect(state.getSnapshot().sync[0]).toMatchObject({ peerId: 'peer:one' });
    expect(state.getSnapshot().connections).toContainEqual(expect.objectContaining({ peerId: 'peer:two', state: 'disconnected' }));

    const beforeDuplicate = state.getSnapshot();
    state.apply({ kind: 'peer-disconnected', peerId: 'peer:two', observedAt: 4 });
    expect(state.getSnapshot()).toBe(beforeDuplicate);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('retains explicit peer correlation and all normalized sync lifecycle states', () => {
    const states = ['offline', 'idle', 'syncing', 'synced', 'error'] as const;
    for (const [index, syncState] of states.entries()) {
      const row = materializeAutomergeSyncRow({
        attachmentId: 'attachment:one',
        documentId: 'document:' + index,
        storageId: 'storage:shared',
        state: syncState,
        observedAt: index,
        peerId: 'peer:explicit',
        ...(syncState === 'error' ? { errorCode: 'transport_failed' } : {})
      });
      expect(row.state).toBe(syncState);
      expect(Object.isFrozen(row)).toBe(true);
    }

    const state = new AutomergeSystemRelationState('attachment:one');
    state.apply({ kind: 'sync-state', documentId: 'document:one', storageId: 'storage:one', state: 'syncing', observedAt: 10, peerId: 'peer:explicit' });
    state.apply({ kind: 'peer-observed', peerId: 'peer:other', observedAt: 11, peerMetadata: { storageId: 'storage:one' } });
    expect(state.getSnapshot().sync[0]).toMatchObject({ state: 'syncing', peerId: 'peer:explicit' });
    state.apply({ kind: 'sync-state', documentId: 'document:one', storageId: 'storage:one', state: 'idle', observedAt: 9 });
    expect(state.getSnapshot().sync[0]).toMatchObject({ state: 'syncing', observedAt: 10 });
  });

  it('tracks presence by peer and channel with explicit local/observed and stop/expiry evidence', () => {
    const state = new AutomergeSystemRelationState('attachment:presence');
    state.apply({ kind: 'presence-set', peerId: 'peer:local', channel: 'cursor', origin: 'local', value: { x: 1 }, observedAt: 10 });
    state.apply({ kind: 'presence-set', peerId: 'peer:remote', channel: 'cursor', origin: 'observed', value: { x: 2 }, observedAt: 11 });
    state.apply({ kind: 'presence-set', peerId: 'peer:remote', channel: 'selection', origin: 'observed', value: [1, 2], observedAt: 12 });
    state.apply({ kind: 'presence-heartbeat', peerId: 'peer:remote', observedAt: 13 });
    expect(state.getSnapshot().presence).toContainEqual(expect.objectContaining({ peerId: 'peer:local', channel: 'cursor', origin: 'local', state: 'active' }));
    expect(state.getSnapshot().presence.filter(({ peerId }) => peerId === 'peer:remote')).toEqual([
      expect.objectContaining({ channel: 'cursor', lastActiveAt: 11, lastSeenAt: 13 }),
      expect.objectContaining({ channel: 'selection', lastActiveAt: 12, lastSeenAt: 13 })
    ]);

    state.apply({ kind: 'presence-stop', peerId: 'peer:remote', observedAt: 20, reason: 'goodbye' });
    expect(state.getSnapshot().presence.filter(({ peerId }) => peerId === 'peer:remote').every(({ state: rowState }) => rowState === 'stopped')).toBe(true);
    state.apply({ kind: 'presence-stop', peerId: 'peer:local', observedAt: 21, reason: 'expired' });
    expect(state.getSnapshot().presence).toContainEqual(expect.objectContaining({ peerId: 'peer:local', state: 'expired', expiresAt: 21 }));
  });

  it('materializes stable, bounded authorized conflict evidence and replaces its lifecycle atomically', () => {
    const conflict: AutomergeConflictFact = {
      kind: 'automerge.conflict',
      ownerObjectId: 'object:private',
      path: ['tasks', 'same'],
      property: 'same',
      alternatives: [
        { changeHash: 'change:c', value: { title: 'C' } },
        { changeHash: 'change:a', value: { title: 'A' } },
        { changeHash: 'change:b', value: { title: 'B' } }
      ]
    };
    const input = {
      attachmentId: 'attachment:one',
      sourceId: 'source:one',
      basis: { kind: 'automerge-heads' as const, heads: ['head:b', 'head:a'] },
      conflicts: [conflict],
      maxAlternatives: 2,
      logicalEvidence: () => ({ relationId: 'relation:tasks', logicalKey: ['same'] })
    };
    const first = materializeAutomergeConflictRows(input);
    const second = materializeAutomergeConflictRows({ ...input, conflicts: [{ ...conflict, alternatives: [...conflict.alternatives].reverse() }] });
    expect(first[0]).toMatchObject({
      issueId: expect.any(String),
      relationId: 'relation:tasks',
      logicalKey: ['same'],
      alternativeCount: 3,
      alternativesTruncated: true,
      alternatives: [{ changeHash: 'change:a' }, { changeHash: 'change:b' }]
    });
    expect(first[0]?.issueId).toBe(second[0]?.issueId);
    expect(first[0]).not.toHaveProperty('ownerObjectId');

    const state = new AutomergeSystemRelationState('attachment:one');
    state.apply({ kind: 'conflicts-replaced', rows: first });
    expect(state.getSnapshot().conflicts).toEqual(first);
    state.apply({ kind: 'conflicts-replaced', rows: [] });
    expect(state.getSnapshot().conflicts).toEqual([]);
  });

  it('clears retained ephemeral rows and subscriptions on close', () => {
    const state = new AutomergeSystemRelationState('attachment:one');
    const listener = vi.fn();
    state.subscribe(listener);
    state.apply({ kind: 'presence-set', peerId: 'peer:one', channel: 'cursor', origin: 'observed', value: null, observedAt: 1 });
    state.close();
    expect(state.getSnapshot()).toMatchObject({ peers: [], connections: [], sync: [], conflicts: [], presence: [] });
    expect(() => state.apply({ kind: 'peer-disconnected', peerId: 'peer:one', observedAt: 2 })).toThrow(/closed/);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
