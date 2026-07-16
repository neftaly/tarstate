import * as Automerge from '@automerge/automerge';
import { Repo } from '@automerge/automerge-repo';
import { builtInCapabilityRefs } from '@tarstate/core/capabilities';
import { sealSchema, sealStorageMapping } from '@tarstate/core/schema';
import { describe, expect, it } from 'vitest';
import {
  openAutomergeAttachment,
  type OpenAutomergeAttachmentInput
} from '../src/index.js';

type TaskDocument = {
  tasks: Record<string, { id: string; title: string }>;
};

describe('standard Automerge attachment', () => {
  it('opens embedded artifacts and exposes only logical transactions and lifecycle', async () => {
    const fixture = await openTaskAttachment();
    expect(Object.keys(fixture.attachment).sort()).toEqual(['close', 'simulate', 'transact']);
    await expect(fixture.attachment.transact(
      { kind: 'rename-task', id: 'first' },
      ({ rows }) => rows.map((row) => ({ ...row, fields: { ...row.fields, title: 'Renamed' } }))
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Renamed');

    fixture.attachment.close();
    await fixture.repo.shutdown();
  });

  it('reconciles a player sync before publishing local work', async () => {
    const fixture = await openTaskAttachment();
    const remote = Automerge.change(
      Automerge.clone(fixture.handle.doc()!, { actor: '2'.repeat(64) }),
      (draft) => {
        draft.tasks.first!.title = 'Remote';
        draft.tasks.second = { id: 'second', title: 'From another player' };
      }
    );
    let calls = 0;
    let markTransformStarted!: () => void;
    let resumeTransform!: () => void;
    const transformStarted = new Promise<void>((resolve) => { markTransformStarted = resolve; });
    const transformCanResume = new Promise<void>((resolve) => { resumeTransform = resolve; });

    const pending = fixture.attachment.transact(
      { kind: 'derive-title-from-current-state', id: 'first' },
      async ({ rows }) => {
        calls += 1;
        if (calls === 1) {
          markTransformStarted();
          await transformCanResume;
        }
        return rows.map((row) => {
          if (row.fields.id !== 'first') return row;
          if (typeof row.fields.title !== 'string') throw new TypeError('Expected a task title');
          return { ...row, fields: { ...row.fields, title: `Local after ${row.fields.title}` } };
        });
      },
    );
    await transformStarted;
    fixture.handle.update((current) => Automerge.merge(current, remote));
    resumeTransform();
    const receipt = await pending;

    expect(receipt).toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(2);
    expect(fixture.handle.doc()?.tasks).toEqual({
      first: { id: 'first', title: 'Local after Remote' },
      second: { id: 'second', title: 'From another player' }
    });

    fixture.attachment.close();
    await fixture.repo.shutdown();
  });

  it('rejects a conflicted native declaration before constructing source machinery', async () => {
    let left = Automerge.from({ metadata: { declaration: { formatVersion: 1 } } }, { actor: '1'.repeat(64) });
    let right = Automerge.clone(left, { actor: '2'.repeat(64) });
    left = Automerge.change(left, (draft) => { draft.metadata.declaration.formatVersion = 2; });
    right = Automerge.change(right, (draft) => { draft.metadata.declaration.formatVersion = 3; });
    const declaration = Automerge.merge(left, right).metadata.declaration;
    const repo = new Repo();
    const handle = repo.create<TaskDocument>({ tasks: {} });

    await expect(openAutomergeAttachment({
      handle,
      declaration,
      embeddedArtifacts: [],
      authorityScope: 'scope:test'
    })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'automerge.value_conflicted', path: ['formatVersion'] }]
    });

    await repo.shutdown();
  });
});

const reference = (artifact: { readonly id: string; readonly contentHash: `sha256:${string}` }) => ({
  id: artifact.id,
  contentHash: artifact.contentHash
});

const openTaskAttachment = async () => {
  const schema = await sealSchema({ id: 'urn:test:open-automerge:schema', body: {
    relations: { tasks: {
      relationId: 'tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } }
      }
    } }
  } });
  const mapping = await sealStorageMapping({ id: 'urn:test:open-automerge:mapping', body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { tasks: {
      collection: { kind: 'object-map', path: ['tasks'], absent: 'creatable' },
      keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
      fields: {
        title: { path: ['title'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } }
      }
    } }
  } });
  const repo = new Repo();
  const handle = repo.create<TaskDocument>({ tasks: { first: { id: 'first', title: 'First' } } });
  const declaration: OpenAutomergeAttachmentInput<TaskDocument, readonly string[]>['declaration'] = {
    formatVersion: 1,
    storageSchema: reference(schema),
    projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
  };
  const opened = await openAutomergeAttachment({
    handle,
    declaration,
    embeddedArtifacts: [schema, mapping],
    authorityScope: 'scope:test'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error(JSON.stringify(opened.issues));
  }
  return { attachment: opened.value, handle, repo };
};
