import { AttachmentCatalog } from '@tarstate/core/database';
import { openDatabaseQuery } from '@tarstate/core/database/session';
import {
  prepareTypedQuery,
  typedFrom,
  typedSelect,
  type RelationInput
} from '@tarstate/core/query';
import { prepareSchema } from '@tarstate/core/schema';
import { describe, expect, it, vi } from 'vitest';
import { openAutomergeSystemDatabase } from '../src/system-database/index.js';

describe('public Automerge system database', () => {
  it('queries normalized host observations through the ordinary database session', async () => {
    const system = await openAutomergeSystemDatabase({
      attachmentId: 'attachment:workspace',
      authorityScope: 'workspace'
    });
    expect(prepareSchema(system.schema.body)).toMatchObject({ success: true });
    expect(Object.isFrozen(system.relations.sync)).toBe(true);
    expect(Object.isFrozen(system.relations.sync.schemaView)).toBe(true);

    const sync = typedFrom(system.relations.sync, 'sync');
    const plan = await prepareTypedQuery(
      typedSelect(sync, 'result', ({ sync: row }) => ({
        documentId: row.row.documentId,
        state: row.row.state,
        heads: row.row.heads
      })),
      {
        registryFingerprint: 'registry:system-test',
        authorityFingerprint: 'authority:system-test',
        datasetId: 'dataset:system-test'
      }
    );
    const session = await openDatabaseQuery({
      sources: [{ source: system }],
      plan,
      queryAuthorityScope: 'workspace'
    });
    expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: { rows: [] }
    });

    const heads = ['head:b', 'head:a', 'head:a'];
    system.observe({
      kind: 'remote-heads-observed',
      documentId: 'document:one',
      storageId: 'storage:one',
      heads,
      observedAt: 1
    });
    heads.splice(0, heads.length, 'mutated');
    expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        rows: [{
          documentId: 'document:one',
          state: 'observed',
          heads: ['head:a', 'head:b']
        }]
      }
    });

    system.observe({
      kind: 'sync-state',
      documentId: 'document:one',
      storageId: 'storage:one',
      state: 'synced',
      heads: ['head:c'],
      observedAt: 2
    });
    expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        rows: [{
          documentId: 'document:one',
          state: 'synced',
          heads: ['head:c']
        }]
      }
    });

    session.close();
    system.close();
  });

  it('projects only demanded relations and fields and reuses immutable results', async () => {
    const system = await openAutomergeSystemDatabase({
      attachmentId: 'attachment:projection',
      authorityScope: 'workspace'
    });
    system.observe({
      kind: 'peer-observed',
      peerId: 'peer:one',
      observedAt: 1,
      peerMetadata: { metadata: { large: ['not', 'needed'] } }
    });
    system.observe({
      kind: 'sync-state',
      documentId: 'document:one',
      storageId: 'storage:one',
      state: 'syncing',
      observedAt: 2
    });

    const catalog = new AttachmentCatalog();
    const lease = system.mount(catalog);
    const attachment = catalog.get(lease.attachmentId);
    if (attachment === undefined) throw new Error('system database did not mount');
    const demand = {
      relations: [{
        relation: {
          schemaView: system.relations.sync.schemaView,
          relationId: system.relations.sync.relationId
        },
        fields: ['state']
      }]
    } as const;
    const first = attachment.project(attachment.source.snapshot(), demand);
    const second = attachment.project(attachment.source.snapshot(), demand);
    expect(first.state).toBe('ready');
    expect(second.state).toBe('ready');
    if (first.state !== 'ready' || second.state !== 'ready') return;
    const relations = first.value as readonly RelationInput[];
    expect(second.value).toBe(first.value);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      relation: { relationId: system.relations.sync.relationId },
      rows: [{ state: 'syncing' }],
      completeness: 'exact'
    });
    expect(relations[0]?.rows[0]).toEqual({ state: 'syncing' });

    lease.close();
    system.close();
  });

  it('adopts hostile host values once and owns idempotent closure', async () => {
    const diagnostic = vi.fn();
    const system = await openAutomergeSystemDatabase({
      attachmentId: 'attachment:lifecycle',
      authorityScope: 'workspace',
      onDiagnostic: diagnostic
    });
    const listener = vi.fn();
    system.subscribe(listener);
    const catalog = new AttachmentCatalog();
    system.mount(catalog);
    expect(catalog.get(system.attachmentId)).toBeDefined();

    expect(() => system.observe({
      kind: 'sync-state',
      documentId: 'document:one',
      storageId: 'storage:one',
      state: 'synced',
      observedAt: -1
    })).toThrow(/Invalid Automerge system observation/);
    expect(() => system.observe({
      kind: 'peer-observed',
      peerId: 'peer:one',
      observedAt: 1,
      unexpected: true
    } as never)).toThrow(/Invalid Automerge system observation/);
    expect(listener).not.toHaveBeenCalled();

    system.close();
    system.close();
    expect(catalog.get(system.attachmentId)).toBeUndefined();
    expect(system.getSnapshot()).toEqual({ state: 'closed' });
    expect(listener).toHaveBeenCalledOnce();
    expect(() => system.observe({
      kind: 'peer-disconnected',
      peerId: 'peer:one',
      observedAt: 2
    })).toThrow(/closed/);
  });
});
