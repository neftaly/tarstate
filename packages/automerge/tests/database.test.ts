import * as Automerge from '@automerge/automerge';
import { Repo } from '@automerge/automerge-repo';
import { builtInCapabilityRefs } from '@tarstate/core/capabilities';
import { sealConstraintSet } from '@tarstate/core/artifacts/constraint-set';
import {
  AttachmentCatalog,
  type AttachmentLease,
  type DatabaseAttachmentInput
} from '@tarstate/core/database';
import {
  openDatabaseQuery,
  type OwnedDatabaseSource
} from '@tarstate/core/database/session';
import type { QueryNode } from '@tarstate/core/query/model';
import { prepareQuery } from '@tarstate/core/query/prepare';
import { relationLiteral, sealSchema, sealStorageMapping } from '@tarstate/core/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  openAutomergeDatabase,
  type OpenAutomergeDatabaseOptions
} from '../src/index.js';
import { createLiveAutomergeDatabase } from '../src/database/live.js';

type TaskDocument = {
  tasks: Record<string, { id: string; title: string }>;
};

type FileDocument = {
  '@patchpit': { type: string };
  content: Uint8Array;
};

type TitledFileDocument = FileDocument & { name: string };

type OrderedTaskDocument = {
  tasks: { id: string; title: string }[];
};

type SourceIdentityTaskDocument = {
  tasks?: { title: string }[];
};

describe('standard Automerge database', () => {
  it('does not build a full logical snapshot until a snapshot consumer asks for one', () => {
    const sourceSnapshot = vi.fn(() => ({
      sourceId: 'source:test',
      operationEpoch: 'epoch:test',
      basis: { kind: 'test', revision: 1 },
      state: 'ready',
      freshness: 'current',
      storage: Automerge.from({ value: 'ready' }),
      issues: []
    } as const));
    const project = vi.fn(() => ({
      mapped: Object.freeze({ rows: Object.freeze([]), completeness: 'exact' as const, issues: Object.freeze([]) }),
      logicalState: Object.freeze({ rows: Object.freeze([]) }),
      constraints: Object.freeze({ blockingIssues: Object.freeze([]), auditIssues: Object.freeze([]) }),
      issues: Object.freeze([])
    }));
    const database = createLiveAutomergeDatabase({
      attachmentId: 'attachment:test',
      incarnation: 'incarnation:test',
      authorityScope: 'scope:test',
      transactions: { transact: vi.fn(), simulate: vi.fn() },
      preparation: {},
      source: {
        sourceId: 'source:test',
        snapshot: sourceSnapshot,
        subscribe: vi.fn(() => () => undefined),
        close: vi.fn()
      },
      projector: { project }
    } as unknown as Parameters<typeof createLiveAutomergeDatabase<{ value: string }>>[0]);

    expect(sourceSnapshot).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(database.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'ready' } });
    expect(sourceSnapshot).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledOnce();
    database.close();
  });

  it('rejects invalid database identities before reading metadata', async () => {
    const repo = new Repo();
    const handle = repo.create<TaskDocument>({ tasks: {} });

    await expect(openAutomergeDatabase({
      handle,
      declaration: null,
      embeddedArtifacts: null,
      authorityScope: ''
    })).rejects.toThrow('authorityScope must be a non-empty string');
    await expect(openAutomergeDatabase({
      handle,
      declaration: null,
      embeddedArtifacts: null,
      authorityScope: 'scope:test',
      attachmentId: ''
    })).rejects.toThrow('attachmentId must be a non-empty string');

    await repo.shutdown();
  });

  it('opens embedded artifacts and exposes only logical transactions and lifecycle', async () => {
    const fixture = await openTaskDatabase();
    expect(Object.keys(fixture.database).sort()).toEqual([
      'close', 'getSnapshot', 'mount', 'simulate', 'subscribe', 'transact'
    ]);
    const initial = fixture.database.getSnapshot();
    expect(initial).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ relationId: 'tasks', fields: { id: 'first', title: 'First' } }] }
    });
    expect(fixture.database.getSnapshot()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = fixture.database.subscribe(listener);
    await expect(fixture.database.transact(
      { kind: 'rename-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Renamed' }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Renamed');
    expect(listener).toHaveBeenCalled();
    unsubscribe();

    const catalog = new AttachmentCatalog();
    const lease = fixture.database.mount(catalog, { discoveryEdges: ['embedded'] });
    expect(lease).toMatchObject({
      attachmentId: fixture.handle.url,
      sourceId: fixture.handle.url,
      discoveryEdges: ['embedded']
    });
    expect('attachment' in lease).toBe(false);
    expect(catalog.list()).toHaveLength(1);

    const closeListener = vi.fn();
    fixture.database.subscribe(closeListener);
    fixture.database.close();
    expect(closeListener).toHaveBeenCalledOnce();
    expect(fixture.database.getSnapshot()).toEqual({ state: 'closed' });
    expect(catalog.list()).toHaveLength(0);
    await fixture.repo.shutdown();
  });

  it('finishes closing after a mounted lease reports a cleanup failure', async () => {
    const fixture = await openTaskDatabase();
    const catalog = new ThrowingLeaseCatalog();
    await fixture.database.mount(catalog);
    const closeListener = vi.fn();
    fixture.database.subscribe(closeListener);

    expect(() => fixture.database.close()).toThrow('lease cleanup failed');
    expect(fixture.database.getSnapshot()).toEqual({ state: 'closed' });
    expect(closeListener).toHaveBeenCalledOnce();
    expect(catalog.list()).toEqual([]);
    expect(() => fixture.database.close()).not.toThrow();
    await fixture.repo.shutdown();
  });

  it('transfers an opened linked database lifetime while keeping the root caller-owned', async () => {
    const child = await openTaskDatabase();
    const root = await openTaskDatabase({ initialTitle: child.handle.url });
    const taskRelation = {
      schemaView: reference(root.schema),
      relationId: 'tasks'
    };
    const common = {
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'workspace'
    } as const;
    const linkPlan = await prepareQuery({
      ...common,
      root: {
        kind: 'select',
        input: {
          kind: 'where',
          input: { kind: 'from', relation: taskRelation, alias: 'task' },
          predicate: {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'field', alias: 'task', name: 'title' },
            right: { kind: 'literal', value: child.handle.url }
          }
        },
        alias: 'link',
        fields: {
          linkId: { kind: 'field', alias: 'task', name: 'id' },
          originSourceId: { kind: 'source-of', alias: 'task' },
          targetSourceId: { kind: 'field', alias: 'task', name: 'title' },
          expectation: { kind: 'literal', value: 'required' }
        }
      } satisfies QueryNode
    });
    const itemPlan = await prepareQuery({
      ...common,
      root: {
        kind: 'select',
        input: { kind: 'from', relation: taskRelation, alias: 'task' },
        alias: 'item',
        fields: { id: { kind: 'field', alias: 'task', name: 'id' } }
      }
    });
    const openSource = vi.fn((): OwnedDatabaseSource => child.database);
    const session = await openDatabaseQuery({
      sources: [{ source: root.database }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: { plan: linkPlan, openSource }
    });

    await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce());
    expect(child.database.getSnapshot()).toMatchObject({ state: 'open' });

    await expect(root.database.transact(
      { kind: 'remove-link' },
      (snapshot) => snapshot.withRows(root.tasks, [])
    )).resolves.toMatchObject({ outcome: 'committed' });
    await vi.waitFor(() => expect(child.database.getSnapshot()).toEqual({ state: 'closed' }));

    session.close();
    expect(root.database.getSnapshot()).toMatchObject({ state: 'open' });
    root.database.close();
    await child.repo.shutdown();
    await root.repo.shutdown();
  });

  it('opens and updates a native-byte root singleton through the standard database API', async () => {
    const schema = await sealSchema({ id: 'urn:test:file:schema', body: {
      relations: {
        file: {
          relationId: 'file',
          key: ['id'],
          fields: {
            id: { type: { kind: 'string', values: ['content'] } },
            content: { type: { kind: 'bytes' } }
          }
        }
      }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:file:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: {
        file: {
          collection: { kind: 'singleton', path: [], absent: 'invalid' },
          keys: { id: { kind: 'literal', value: 'content' } },
          fields: {
            content: { path: ['content'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } }
          }
        }
      }
    } });
    const repo = new Repo();
    const handle = repo.create<FileDocument>({
      '@patchpit': { type: 'file-content' },
      content: new Uint8Array([1, 2, 3])
    });
    const opened = await openAutomergeDatabase({
      handle,
      declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      },
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    expect(opened.value.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        rows: [{ fields: { id: 'content', content: { type: 'bytes', value: 'AQID' } } }]
      }
    });
    const file = relationLiteral(schema, 'file');
    await expect(opened.value.transact(
      { kind: 'replace-content' },
      (snapshot) => snapshot.withRows(
        file,
        snapshot.rows(file).map((row) => ({
          ...row,
          content: { kind: 'tarstate.value', type: 'bytes', value: 'BAU' }
        }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect([...(handle.doc()?.content ?? [])]).toEqual([4, 5]);
    expect(handle.doc()?.['@patchpit']).toEqual({ type: 'file-content' });
    opened.value.close();
    await repo.shutdown();
  });

  it('keeps a title-only query exact without projecting conflicted binary content', async () => {
    const schema = await sealSchema({ id: 'urn:test:titled-file:schema', body: {
      relations: { file: {
        relationId: 'titled-file',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string', values: ['file'] } },
          name: { type: { kind: 'string' } },
          content: { type: { kind: 'bytes' } }
        }
      } }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:titled-file:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: { 'titled-file': {
        collection: { kind: 'singleton', path: [], absent: 'invalid' },
        keys: { id: { kind: 'literal', value: 'file' } },
        fields: {
          name: { path: ['name'], write: { kind: 'read-only' } },
          content: { path: ['content'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } }
        }
      } }
    } });
    const repo = new Repo();
    const handle = repo.create<TitledFileDocument>({
      '@patchpit': { type: 'file-content' },
      name: 'large.bin',
      content: new Uint8Array(1024 * 1024)
    });
    const opened = await openAutomergeDatabase({
      handle,
      declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      },
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const plan = await prepareQuery({
      root: {
        kind: 'select',
        input: {
          kind: 'from',
          relation: { schemaView: reference(schema), relationId: 'titled-file' },
          alias: 'file'
        },
        alias: 'title',
        fields: { title: { kind: 'field', alias: 'file', name: 'name' } }
      },
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'files'
    });
    const query = await openDatabaseQuery({
      sources: [{ source: opened.value }],
      plan,
      queryAuthorityScope: 'scope:test'
    });
    expect(query.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ title: 'large.bin' }] }
    });

    const base = handle.doc()!;
    const left = Automerge.change(Automerge.clone(base, { actor: 'a'.repeat(64) }), (draft) => {
      draft.content = new Uint8Array([1]);
    });
    const right = Automerge.change(Automerge.clone(base, { actor: 'b'.repeat(64) }), (draft) => {
      draft.content = new Uint8Array([2]);
    });
    handle.update(() => Automerge.merge(left, right));
    expect(query.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ title: 'large.bin' }] }
    });
    expect(opened.value.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'incomplete', completeness: 'unknown', rows: [] }
    });

    query.close();
    opened.value.close();
    await repo.shutdown();
  });

  it('opens and updates an explicitly keyed array through the standard database API', async () => {
    const schema = await sealSchema({ id: 'urn:test:ordered-task:schema', body: {
      relations: { tasks: {
        relationId: 'ordered-tasks',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' } }
        }
      } }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:ordered-task:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: { 'ordered-tasks': {
        collection: { kind: 'array', path: ['tasks'], absent: 'creatable' },
        keys: { id: { kind: 'field', path: ['id'] } },
        fields: {
          title: { path: ['title'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } }
        }
      } }
    } });
    const repo = new Repo();
    const handle = repo.create<OrderedTaskDocument>({
      tasks: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }]
    });
    const opened = await openAutomergeDatabase({
      handle,
      declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      },
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const tasks = relationLiteral(schema, 'tasks');
    await expect(opened.value.transact(
      { kind: 'replace-ordered-tasks' },
      (snapshot) => snapshot.withRows(tasks, [
        ...snapshot.rows(tasks).filter(({ id }) => id !== 'first'),
        { id: 'third', title: 'Third' }
      ])
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(handle.doc()?.tasks).toEqual([
      { id: 'second', title: 'Second' },
      { id: 'third', title: 'Third' }
    ]);
    opened.value.close();
    await repo.shutdown();
  });

  it('inserts a source-identity keyed row and returns its committed logical key', async () => {
    const fixture = await openSourceIdentityTaskDatabase({ collectionPresent: false });

    await expect(fixture.database.simulate(
      { kind: 'invalid-generated-task' },
      (snapshot) => snapshot.insertWithGeneratedKey(
        fixture.tasks,
        'invalid',
        { title: 'Invalid', position: 0 }
      )
    )).rejects.toMatchObject({
      name: 'TarstateParseError',
      issues: [{ details: { reason: 'source_generated_field_supplied', field: 'position' } }]
    });
    await expect(fixture.database.simulate(
      { kind: 'duplicate-generated-token' },
      (snapshot) => snapshot
        .insertWithGeneratedKey(fixture.tasks, 'duplicate', { title: 'First' })
        .insertWithGeneratedKey(fixture.tasks, 'duplicate', { title: 'Second' })
    )).rejects.toMatchObject({
      name: 'TarstateParseError',
      issues: [{ details: { reason: 'insertion_token_duplicate' } }]
    });

    const simulated = await fixture.database.simulate(
      { kind: 'preview-generated-task', token: 'preview' },
      (snapshot) => snapshot.insertWithGeneratedKey(
        fixture.tasks,
        'preview',
        { title: 'Preview' }
      )
    );
    expect(simulated).toMatchObject({
      outcome: 'would-commit',
      statementResults: [{ inserted: 1, logicallyChanged: 1 }]
    });
    expect('generatedKeys' in simulated).toBe(false);
    expect(fixture.handle.doc()?.tasks).toBeUndefined();

    const receipt = await fixture.database.transact(
      { kind: 'insert-generated-task', token: 'local' },
      (snapshot) => snapshot.insertWithGeneratedKey(
        fixture.tasks,
        'local',
        { title: 'Local' }
      )
    );

    expect(receipt).toMatchObject({
      outcome: 'committed',
      generatedKeys: [{ relationId: 'source-identity-tasks', token: 'local' }]
    });
    const inserted = fixture.handle.doc()?.tasks?.[0];
    const objectId = inserted === undefined ? null : Automerge.getObjectId(inserted);
    expect(receipt.generatedKeys).toEqual([{
      relationId: 'source-identity-tasks',
      token: 'local',
      key: [objectId]
    }]);
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        rows: [{
          relationId: 'source-identity-tasks',
          fields: { id: objectId, title: 'Local', position: 0 }
        }]
      }
    });

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('replays a generated-key insert after a player edit without duplicating it', async () => {
    const fixture = await openSourceIdentityTaskDatabase();
    const started = deferred();
    const resume = deferred();
    let calls = 0;
    const pending = fixture.database.transact(
      { kind: 'insert-generated-task-after-player-change', token: 'local' },
      async (snapshot) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await resume.promise;
        }
        return snapshot.insertWithGeneratedKey(fixture.tasks, 'local', { title: 'Local' });
      }
    );

    await started.promise;
    const remote = Automerge.change(
      Automerge.clone(fixture.handle.doc()!, { actor: 'b'.repeat(64) }),
      (draft) => { draft.tasks!.push({ title: 'Remote' }); }
    );
    fixture.handle.update((current) => Automerge.merge(current, remote));
    resume.resolve();

    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(2);
    expect(fixture.handle.doc()?.tasks?.map(({ title }) => title).sort()).toEqual(['Local', 'Remote']);
    const local = fixture.handle.doc()?.tasks?.find(({ title }) => title === 'Local');
    const localObjectId = local === undefined ? null : Automerge.getObjectId(local);
    expect(receipt.generatedKeys).toEqual([{
      relationId: 'source-identity-tasks',
      token: 'local',
      key: [localObjectId]
    }]);

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('accepts embedded artifact maps and runs standard logical constraints without host plumbing', async () => {
    const fixture = await openTaskDatabase({ artifactMap: true, constrained: true });
    const mounted = await mountTaskDatabase(fixture);

    await expect(fixture.database.transact(
      { kind: 'rename-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Constrained' }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Constrained');
    await expect(fixture.database.transact(
      { kind: 'rename-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Forbidden' }))
      )
    )).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.task_invalid' }] });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Constrained');

    const changed = vi.fn();
    fixture.database.subscribe(changed);
    mergePlayerChange(fixture.handle, '8', (draft) => {
      draft.tasks.first!.title = 'Forbidden';
    });
    expect(changed).toHaveBeenCalled();
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        completeness: 'exact',
        issues: [{ code: 'test.task_invalid', severity: 'error' }]
      }
    });
    const invalidMounted = mounted.observer.getSnapshot();
    expect(invalidMounted).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        completeness: 'unknown',
        rows: []
      }
    });
    expect(invalidMounted.state === 'open' && invalidMounted.current.issues).toContainEqual(
      expect.objectContaining({ code: 'test.task_invalid', severity: 'error' })
    );

    let repairCalls = 0;
    await expect(fixture.database.transact(
      { kind: 'repair-task', id: 'first' },
      (snapshot) => {
        repairCalls += 1;
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Repaired' }))
        );
      }
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(repairCalls).toBe(1);
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', issues: [] }
    });
    expect(mounted.observer.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', completeness: 'exact' }
    });

    mounted.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('reports an initially invalid constrained document and permits a final-state repair', async () => {
    const fixture = await openTaskDatabase({ constrained: true, initialTitle: 'Forbidden' });
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'invalid', issues: [{ code: 'test.task_invalid' }] }
    });

    await expect(fixture.database.transact(
      { kind: 'repair-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Valid' }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', rows: [{ fields: { title: 'Valid' } }] }
    });

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('mounts through dataset authority into a recursive source-aware database query', async () => {
    const fixture = await openTaskDatabase();
    const mounted = await mountTaskDatabase(fixture);

    expect(mounted.observer.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        completeness: 'exact',
        rows: [{ id: 'first', source: fixture.handle.url }]
      }
    });

    mounted.close();
    fixture.database.close();
    expect(mounted.observer.getSnapshot()).toEqual({ state: 'closed' });
    await fixture.repo.shutdown();
  });

  it('replays across repeated player syncs and preserves every disjoint row', async () => {
    const fixture = await openTaskDatabase();
    const started = [deferred(), deferred()];
    const resume = [deferred(), deferred()];
    let calls = 0;
    const pending = fixture.database.transact(
      { kind: 'repeated-player-sync', id: 'first' },
      async (snapshot) => {
        const call = calls;
        calls += 1;
        if (call < started.length) {
          started[call]!.resolve();
          await resume[call]!.promise;
        }
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((row) => row.id === 'first'
            ? { ...row, title: `Local after ${row.title}` }
            : row)
        );
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

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('does not resurrect a row deleted by another player during authoring', async () => {
    const fixture = await openTaskDatabase();
    const started = deferred();
    const resume = deferred();
    let calls = 0;
    const pending = fixture.database.transact(
      { kind: 'rename-if-present', id: 'first' },
      async (snapshot) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await resume.promise;
        }
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((row) => row.id === 'first'
            ? { ...row, title: 'Local rename' }
            : row)
        );
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

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('rejects mapped same-field conflicts without selecting a winner or invoking the transform', async () => {
    const fixture = await openTaskDatabase();
    const base = fixture.handle.doc()!;
    const left = Automerge.change(Automerge.clone(base, { actor: '6'.repeat(64) }), (draft) => {
      draft.tasks.first!.title = 'Left';
    });
    const right = Automerge.change(Automerge.clone(base, { actor: '7'.repeat(64) }), (draft) => {
      draft.tasks.first!.title = 'Right';
    });
    fixture.handle.update(() => Automerge.merge(left, right));
    let calls = 0;

    const receipt = await fixture.database.transact(
      { kind: 'must-not-select-conflict', id: 'first' },
      (snapshot) => {
        calls += 1;
        return snapshot;
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

    fixture.database.close();
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

    await expect(openAutomergeDatabase({
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

class ThrowingLeaseCatalog extends AttachmentCatalog {
  override attach<Storage, Projection>(
    input: DatabaseAttachmentInput<Storage, Projection>,
    releaseSource?: () => void
  ): AttachmentLease<Storage, Projection> {
    const lease = super.attach(input, releaseSource);
    return {
      attachment: lease.attachment,
      close: () => {
        lease.close();
        throw new Error('lease cleanup failed');
      }
    };
  }
}

const openTaskDatabase = async (options: {
  readonly artifactMap?: boolean;
  readonly constrained?: boolean;
  readonly initialTitle?: string;
} = {}) => {
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
  const constraint = options.constrained === true
    ? await sealConstraintSet({ id: 'urn:test:open-automerge:constraints', body: {
        schemaView: reference(schema),
        constraints: [{
          id: 'task-validity',
          code: 'test.task_invalid',
          dependencyRelations: ['tasks'],
          violationQuery: {
            kind: 'select',
            input: {
              kind: 'where',
              input: { kind: 'from', relation: { schemaView: reference(schema), relationId: 'tasks' }, alias: 'task' },
              predicate: {
                kind: 'compare',
                op: 'eq',
                left: { kind: 'field', alias: 'task', name: 'title' },
                right: { kind: 'literal', value: 'Forbidden' }
              }
            },
            alias: 'violation',
            fields: {
              subject: {
                kind: 'record',
                fields: {
                  relationId: { kind: 'literal', value: 'tasks' },
                  key: { kind: 'field', alias: 'task', name: 'id' }
                }
              }
            }
          }
        }],
        requiredCapabilities: []
      } })
    : undefined;
  const repo = new Repo();
  const handle = repo.create<TaskDocument>({
    tasks: { first: { id: 'first', title: options.initialTitle ?? 'First' } }
  });
  const declaration: OpenAutomergeDatabaseOptions<TaskDocument, readonly string[]>['declaration'] = {
    formatVersion: 1,
    storageSchema: reference(schema),
    projection: { kind: 'storage-mapping', storageMapping: reference(mapping) },
    ...(constraint === undefined ? {} : { constraints: { set: reference(constraint), mode: 'required' as const } })
  };
  const artifacts = [schema, mapping, ...(constraint === undefined ? [] : [constraint])];
  const opened = await openAutomergeDatabase({
    handle,
    declaration,
    embeddedArtifacts: options.artifactMap === true
      ? Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact]))
      : artifacts,
    authorityScope: 'scope:test'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error(JSON.stringify(opened.issues));
  }
  return { database: opened.value, handle, repo, schema, tasks: relationLiteral(schema, 'tasks') };
};

const openSourceIdentityTaskDatabase = async (
  options: { readonly collectionPresent?: boolean } = {}
) => {
  const schema = await sealSchema({ id: 'urn:test:source-identity-task:schema', body: {
    relations: { tasks: {
      relationId: 'source-identity-tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } },
        position: { type: { kind: 'number' } }
      }
    } }
  } });
  const mapping = await sealStorageMapping({ id: 'urn:test:source-identity-task:mapping', body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { 'source-identity-tasks': {
      collection: { kind: 'array', path: ['tasks'], absent: 'creatable' },
      keys: { id: { kind: 'source-metadata', value: 'collection-element-identity' } },
      fields: {
        title: { path: ['title'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } },
        position: { kind: 'source-metadata', value: 'collection-position' }
      }
    } }
  } });
  const repo = new Repo();
  const handle = repo.create<SourceIdentityTaskDocument>(
    options.collectionPresent === false ? {} : { tasks: [] }
  );
  const opened = await openAutomergeDatabase({
    handle,
    declaration: {
      formatVersion: 1,
      storageSchema: reference(schema),
      projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
    },
    embeddedArtifacts: [schema, mapping],
    authorityScope: 'scope:test'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error(JSON.stringify(opened.issues));
  }
  return {
    database: opened.value,
    handle,
    repo,
    tasks: relationLiteral(schema, 'tasks')
  };
};

const mountTaskDatabase = async (
  fixture: Awaited<ReturnType<typeof openTaskDatabase>>
) => {
  const taskRelation = { schemaView: reference(fixture.schema), relationId: 'tasks' };
  const root: QueryNode = {
    kind: 'recursive',
    name: 'reachable',
    seed: {
      kind: 'select',
      alias: 'node',
      input: { kind: 'from', relation: taskRelation, alias: 'task' },
      fields: {
        id: { kind: 'field', alias: 'task', name: 'id' },
        source: { kind: 'source-of', alias: 'task' }
      }
    },
    step: {
      kind: 'select',
      alias: 'node',
      input: { kind: 'recursion-ref', name: 'reachable' },
      fields: {
        id: { kind: 'field', alias: 'node', name: 'id' },
        source: { kind: 'field', alias: 'node', name: 'source' }
      }
    },
    key: [
      { kind: 'field', alias: 'node', name: 'id' },
      { kind: 'field', alias: 'node', name: 'source' }
    ]
  };
  const plan = await prepareQuery({
    root,
    registryFingerprint: 'registry:test',
    authorityFingerprint: 'authority:test',
    datasetId: 'workspace'
  });
  const observer = await openDatabaseQuery({
    sources: [{
      source: fixture.database,
      expectation: 'required',
      discoveryEdges: ['workspace']
    }],
    plan,
    queryAuthorityScope: 'scope:test',
    canRead: ({ queryAuthorityScope, sourceAuthorityScope }) =>
      queryAuthorityScope === sourceAuthorityScope
  });
  return {
    observer,
    close: () => observer.close()
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const mergePlayerChange = (
  handle: Awaited<ReturnType<typeof openTaskDatabase>>['handle'],
  actorDigit: string,
  change: Automerge.ChangeFn<TaskDocument>
): void => {
  const remote = Automerge.change(
    Automerge.clone(handle.doc()!, { actor: actorDigit.repeat(64) }),
    change
  );
  handle.update((current) => Automerge.merge(current, remote));
};
