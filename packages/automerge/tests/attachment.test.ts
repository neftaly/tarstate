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

  it('replays across repeated player syncs and preserves every disjoint row', async () => {
    const fixture = await openTaskAttachment();
    const started = [deferred(), deferred()];
    const resume = [deferred(), deferred()];
    let calls = 0;
    const pending = fixture.attachment.transact(
      { kind: 'repeated-player-sync', id: 'first' },
      async ({ rows }) => {
        const call = calls;
        calls += 1;
        if (call < started.length) {
          started[call]!.resolve();
          await resume[call]!.promise;
        }
        return rows.map((row) => {
          if (row.fields.id !== 'first') return row;
          if (typeof row.fields.title !== 'string') throw new TypeError('Expected a task title');
          return { ...row, fields: { ...row.fields, title: `Local after ${row.fields.title}` } };
        });
      }
    );

    await started[0]!.promise;
    mergePlayerChange(fixture.handle, '3', (draft) => {
      draft.tasks.first!.title = 'Remote one';
      draft.tasks.second = { id: 'second', title: 'Second player row' };
    });
    resume[0]!.resolve();
    await started[1]!.promise;
    mergePlayerChange(fixture.handle, '4', (draft) => {
      draft.tasks.first!.title = 'Remote two';
      draft.tasks.third = { id: 'third', title: 'Third player row' };
    });
    resume[1]!.resolve();

    await expect(pending).resolves.toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(3);
    expect(fixture.handle.doc()?.tasks).toEqual({
      first: { id: 'first', title: 'Local after Remote two' },
      second: { id: 'second', title: 'Second player row' },
      third: { id: 'third', title: 'Third player row' }
    });

    fixture.attachment.close();
    await fixture.repo.shutdown();
  });

  it('does not resurrect a row deleted by another player during authoring', async () => {
    const fixture = await openTaskAttachment();
    const started = deferred();
    const resume = deferred();
    let calls = 0;
    const pending = fixture.attachment.transact(
      { kind: 'rename-if-present', id: 'first' },
      async ({ rows }) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await resume.promise;
        }
        return rows.map((row) => row.fields.id === 'first'
          ? { ...row, fields: { ...row.fields, title: 'Local rename' } }
          : row);
      }
    );

    await started.promise;
    mergePlayerChange(fixture.handle, '5', (draft) => {
      delete draft.tasks.first;
      draft.tasks.second = { id: 'second', title: 'Preserved' };
    });
    resume.resolve();

    await expect(pending).resolves.toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(2);
    expect(fixture.handle.doc()?.tasks).toEqual({
      second: { id: 'second', title: 'Preserved' }
    });

    fixture.attachment.close();
    await fixture.repo.shutdown();
  });

  it('rejects mapped same-field conflicts without selecting a winner or invoking the transform', async () => {
    const fixture = await openTaskAttachment();
    const base = fixture.handle.doc()!;
    const left = Automerge.change(Automerge.clone(base, { actor: '6'.repeat(64) }), (draft) => {
      draft.tasks.first!.title = 'Left';
    });
    const right = Automerge.change(Automerge.clone(base, { actor: '7'.repeat(64) }), (draft) => {
      draft.tasks.first!.title = 'Right';
    });
    fixture.handle.update(() => Automerge.merge(left, right));
    let calls = 0;

    const receipt = await fixture.attachment.transact(
      { kind: 'must-not-select-conflict', id: 'first' },
      ({ rows }) => {
        calls += 1;
        return rows;
      }
    );

    expect(receipt).toMatchObject({ outcome: 'rejected' });
    expect(receipt.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'automerge.conflict_observed', path: ['tasks', 'first', 'title'] })
    ]));
    expect(calls).toBe(0);
    const conflictTitles = Object.values(Automerge.getConflicts(fixture.handle.doc()!.tasks.first!, 'title') ?? {});
    expect(conflictTitles.every((title) => typeof title === 'string')).toBe(true);
    expect(conflictTitles.filter((title): title is string => typeof title === 'string')
      .sort((left, right) => left.localeCompare(right)))
      .toEqual(['Left', 'Right']);

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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const mergePlayerChange = (
  handle: Awaited<ReturnType<typeof openTaskAttachment>>['handle'],
  actorDigit: string,
  change: Automerge.ChangeFn<TaskDocument>
): void => {
  const remote = Automerge.change(
    Automerge.clone(handle.doc()!, { actor: actorDigit.repeat(64) }),
    change
  );
  handle.update((current) => Automerge.merge(current, remote));
};
