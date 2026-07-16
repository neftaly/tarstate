import * as Automerge from '@automerge/automerge';
import { Repo } from '@automerge/automerge-repo';
import { builtInCapabilityRefs } from '@tarstate/core/capabilities';
import { sealConstraintSet } from '@tarstate/core/artifacts/constraint-set';
import { AttachmentCatalog } from '@tarstate/core/database';
import { openDatabaseQuery } from '@tarstate/core/database/session';
import type { QueryNode } from '@tarstate/core/query/model';
import { prepareQuery } from '@tarstate/core/query/prepare';
import { relationLiteral, sealSchema, sealStorageMapping } from '@tarstate/core/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  openAutomergeDatabase,
  type OpenAutomergeDatabaseOptions
} from '../src/index.js';

type TaskDocument = {
  tasks: Record<string, { id: string; title: string }>;
};

describe('standard Automerge attachment', () => {
  it('opens embedded artifacts and exposes only logical transactions and lifecycle', async () => {
    const fixture = await openTaskAttachment();
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

  it('accepts embedded artifact maps and runs standard logical constraints without host plumbing', async () => {
    const fixture = await openTaskAttachment({ artifactMap: true, constrained: true });
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
    const fixture = await openTaskAttachment({ constrained: true, initialTitle: 'Forbidden' });
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
    const fixture = await openTaskAttachment();
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
    const fixture = await openTaskAttachment();
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
    const fixture = await openTaskAttachment();
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

const openTaskAttachment = async (options: {
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

const mountTaskDatabase = async (
  fixture: Awaited<ReturnType<typeof openTaskAttachment>>
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
