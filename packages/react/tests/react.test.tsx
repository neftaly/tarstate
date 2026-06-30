import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AdapterCommitResult, AdapterSource, RelationAdapter } from '@tarstate/core/adapter';
import {
  attachConstraints,
  attachedConstraintsFor,
  check,
  constrain,
  hasAttachedConstraints
} from '@tarstate/core/constraints';
import { createDb } from '@tarstate/core/db';
import { evaluate } from '@tarstate/core/evaluate';
import {
  materializationsFor,
  materializedRowsFor,
  materializeSnapshot
} from '@tarstate/core/materialization';
import { as, env, eq, from, join, pipe, project, where } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';
import { write, type WritePatch } from '@tarstate/core/write';
import {
  createAdapterStore,
  createDbStore,
  createSourceStore,
  TarstateProvider,
  useCommit,
  useQueries,
  useQuery,
  useTarstateCommit,
  useTarstateQueries,
  useTarstateQuery,
  useTarstateSnapshot,
  useTarstateStore,
  type TarstateDbSnapshot,
  type TarstateSnapshot,
  type TarstateStore
} from '@tarstate/react';

type Todo = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      title: stringField(),
      done: booleanField()
    }
  })
});

const todo = as(schema.todos, 'todo');
const otherTodo = as(schema.todos, 'otherTodo');
const todos = write(schema.todos);
const openTodos = pipe(
  from(todo),
  where(eq(todo.done, false)),
  project({
    id: todo.id,
    title: todo.title
  })
);
const todoTitles = pipe(
  from(todo),
  project({
    title: todo.title
  })
);
const todosByEnvTitle = pipe(
  from(todo),
  where(eq(todo.title, env<string>('title'))),
  project({
    id: todo.id,
    title: todo.title
  })
);
const matchingTodoPairs = pipe(
  from(todo),
  join(from(otherTodo), eq(todo.id, otherTodo.id)),
  project({
    leftTitle: todo.title,
    rightTitle: otherTodo.title
  })
);

describe('@tarstate/react', () => {
  it('exports a revisioned external-store surface', () => {
    expectTypeOf(createDbStore()).toMatchTypeOf<TarstateStore<TarstateDbSnapshot>>();
    expectTypeOf(useTarstateStore).returns.toMatchTypeOf<TarstateStore>();
    expectTypeOf(useTarstateSnapshot<TarstateDbSnapshot>).returns.toMatchTypeOf<TarstateDbSnapshot>();
    expectTypeOf(useCommit).returns.toMatchTypeOf<(patches: Iterable<WritePatch>) => Promise<unknown>>();
  });

  it('exports prefixed hook aliases', () => {
    expect(useTarstateQuery).toBe(useQuery);
    expect(useTarstateQueries).toBe(useQueries);
    expect(useTarstateCommit).toBe(useCommit);
    expectTypeOf(useTarstateQuery).toEqualTypeOf<typeof useQuery>();
    expectTypeOf(useTarstateQueries).toEqualTypeOf<typeof useQueries>();
    expectTypeOf(useTarstateCommit).returns.toMatchTypeOf<
      (patches: Iterable<WritePatch>) => Promise<unknown>
    >();
  });

  it('updates subscribers only after committed transactions', async () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    const rejected = await store.commit([todos.insert({ id: 'todo-a', title: 'Duplicate', done: false })]);

    expect(rejected.status).toBe('rejected');
    expect(rejected.reflected).toBe(false);
    expect(rejected.fullyCommitted).toBe(false);
    expect(rejected.committed).toBe(false);
    expect(revisions).toEqual([]);

    const committed = await store.commit([todos.insert({ id: 'todo-b', title: 'Beta', done: false })]);

    expect(committed.status).toBe('committed');
    expect(committed.reflected).toBe(true);
    expect(committed.fullyCommitted).toBe(true);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    expect(committed.snapshot.db.data.todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: false },
      { id: 'todo-b', title: 'Beta', done: false }
    ]);
    unsubscribe();
  });

  it('rejects db store commits that violate attached constraints without revision notification', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const constraints = constrain(
      check(from(todo), eq(todo.done, false), { name: 'todos-stay-open' })
    );
    attachConstraints(db, constraints);
    const store = createDbStore(db);
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    const rejected = await store.commit([
      todos.update('todo-a', { done: true })
    ]);

    expect(rejected.status).toBe('rejected');
    expect(rejected.reflected).toBe(false);
    expect(rejected.fullyCommitted).toBe(false);
    expect(rejected.committed).toBe(false);
    expect(rejected.applied).toBe(0);
    expect(rejected.deltas).toEqual([]);
    expect(rejected.snapshot.revision).toBe(0);
    expect(revisions).toEqual([]);
    expect(rejected.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        message: 'check constraint failed',
        detail: {
          op: 'check',
          name: 'todos-stay-open',
          row: {
            todo: { id: 'todo-a', title: 'Alpha', done: true }
          }
        }
      }
    ]);
    expect(store.getSnapshot().db.data.todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: false }
    ]);
    expect(attachedConstraintsFor(store.getSnapshot().db)).toEqual(constraints.constraints);
    unsubscribe();
  });

  it('accepts valid db store commits with attached constraints and carries attachments forward', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const constraints = constrain(
      check(from(todo), eq(todo.done, false), { name: 'todos-stay-open' })
    );
    attachConstraints(db, constraints);
    const store = createDbStore(db);
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    const committed = await store.commit([
      todos.insert({ id: 'todo-b', title: 'Beta', done: false })
    ]);

    expect(committed.status).toBe('committed');
    expect(committed.reflected).toBe(true);
    expect(committed.fullyCommitted).toBe(true);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    expect(committed.diagnostics).toEqual([]);
    expect(committed.snapshot.db.data.todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: false },
      { id: 'todo-b', title: 'Beta', done: false }
    ]);
    expect(hasAttachedConstraints(committed.snapshot.db)).toBe(true);
    expect(attachedConstraintsFor(committed.snapshot.db)).toEqual(constraints.constraints);
    unsubscribe();
  });

  it('keeps unconstrained db store commits on the existing write behavior', async () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    const committed = await store.commit([
      todos.update('todo-a', { done: true })
    ]);

    expect(committed.status).toBe('committed');
    expect(committed.reflected).toBe(true);
    expect(committed.fullyCommitted).toBe(true);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    expect(committed.diagnostics).toEqual([]);
    expect(committed.snapshot.db.data.todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: true }
    ]);
    expect(hasAttachedConstraints(committed.snapshot.db)).toBe(false);
    unsubscribe();
  });

  it('reports accepted no-op db commits without reflected row changes', async () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });

    const ignored = await store.commit([
      todos.insertIgnore({ id: 'todo-a', title: 'Duplicate', done: true })
    ]);

    expect(ignored.status).toBe('committed');
    expect(ignored.reflected).toBe(false);
    expect(ignored.fullyCommitted).toBe(true);
    expect(ignored.committed).toBe(true);
    expect(ignored.deltas).toEqual([]);
  });

  it('maintains materialized db snapshots after committed store writes', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });

    await materializeSnapshot(db, openTodos, { id: 'open-todos', mode: 'incremental' });

    const store = createDbStore(db);
    const result = await store.commit([
      todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
    ]);

    expect(result.status).toBe('committed');
    expect(result.diagnostics).toEqual([]);
    expect(result.materializations).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: []
    });
    expect(result.materializations?.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'incremental',
        id: 'open-todos',
        queryKey: expect.any(String),
        maintenance: 'incremental',
        previousRowsAvailable: true,
        previousRows: [{ id: 'todo-a', title: 'Alpha' }],
        rows: [
          { id: 'todo-a', title: 'Alpha' },
          { id: 'todo-c', title: 'Gamma' }
        ],
        addedRows: [{ id: 'todo-c', title: 'Gamma' }],
        removedRows: [],
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor(result.snapshot.db, 'open-todos')).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-c', title: 'Gamma' }
    ]);
    expect(materializationsFor(result.snapshot.db)).toMatchObject([
      {
        id: 'open-todos',
        requestedMode: 'incremental',
        maintenance: 'incremental'
      }
    ]);
  });

  it('evaluates db store queries with db env and hook env overrides', async () => {
    const store = createDbStore(createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    }, { title: 'Alpha' }));
    let defaultRows: readonly unknown[] = [];
    let overrideRows: readonly unknown[] = [];

    function Probe() {
      defaultRows = useQuery(todosByEnvTitle).rows;
      overrideRows = useQuery(todosByEnvTitle, { env: { title: 'Beta' }, deps: ['Beta'] }).rows;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(defaultRows).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(overrideRows).toEqual([{ id: 'todo-b', title: 'Beta' }]);
  });

  it('renders query data and updates after a commit', async () => {
    const store = createDbStore({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });
    let latestRows: readonly unknown[] = [];
    let latestData = '';
    let latestStatus = '';
    let latestRevision = -1;
    let commit: ReturnType<typeof useCommit> | undefined;

    function Probe() {
      const result = useQuery(openTodos, {
        select: (rows) => rows.map((row) => row.title).join(',')
      });
      commit = useCommit();
      latestRows = result.rows;
      latestData = result.data ?? '';
      latestStatus = result.status;
      latestRevision = result.revision;
      return React.createElement('output', null, latestStatus);
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(latestStatus).toBe('ready');
    expect(latestRevision).toBe(0);
    expect(latestRows).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(latestData).toBe('Alpha');

    await act(async () => {
      await commit?.([todos.insert({ id: 'todo-c', title: 'Gamma', done: false })]);
      await flushEffects();
    });

    expect(latestStatus).toBe('ready');
    expect(latestRevision).toBe(1);
    expect(latestRows).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-c', title: 'Gamma' }
    ]);
    expect(latestData).toBe('Alpha,Gamma');
  });

  it('evaluates query batches against the same revision', async () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    let titles: readonly unknown[] = [];
    let open: readonly unknown[] = [];
    let status = '';

    function Probe() {
      const result = useQueries({ open: openTodos, titles: todoTitles });
      status = result.status;
      open = result.results?.open.rows ?? [];
      titles = result.results?.titles.rows ?? [];
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(status).toBe('ready');
    expect(open).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(titles).toEqual([{ title: 'Alpha' }]);
  });

  it('uses adapter-provided source snapshots for adapter stores', async () => {
    let latestRows: readonly Todo[] = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const adapter: RelationAdapter<string> = {
      source: {
        rows: (relationRef) => relationRef.name === 'todos' ? latestRows : [],
        version: () => 'live'
      },
      snapshot: () => {
        const rows = [...latestRows];
        const version = rows.map((row) => row.id).join(',');
        return {
          source: {
            relationNames: ['todos'],
            rows: (relationRef) => relationRef.name === 'todos' ? rows : [],
            version: () => version
          },
          version
        };
      },
      commit: (patches) => ({
        status: 'rejected',
        committed: false,
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics: []
      })
    };
    const store = createAdapterStore(adapter);
    const initialSnapshot = store.getSnapshot();

    latestRows = [{ id: 'todo-b', title: 'Beta', done: false }];

    await expect(evaluate(initialSnapshot.source, openTodos)).resolves.toMatchObject({
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });

    await store.refresh();

    await expect(evaluate(store.getSnapshot().source, openTodos)).resolves.toMatchObject({
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });
  });

  it('reads the fresh adapter snapshot version when adapter commits omit a version', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    const staleSource = todoSource([alpha], 'v1');
    let latestRows: readonly Todo[] = [alpha];
    let snapshotSource = todoSource(latestRows, 'v1');

    const adapter: RelationAdapter<string> = {
      source: staleSource,
      snapshot: () => ({
        source: snapshotSource
      }),
      commit: (patches) => {
        latestRows = [...latestRows, beta];
        snapshotSource = todoSource(latestRows, 'v2');

        return {
          status: 'committed',
          committed: true,
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: []
        };
      }
    };
    const store = createAdapterStore(adapter);

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('committed');
    expect(result.snapshot.version).toBe('v2');
    expect(store.getSnapshot().version).toBe('v2');
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ]
    });
  });

  it('normalizes thrown adapter-store fallback commits through the adapter helper', async () => {
    const commitError = new Error('adapter write failed');
    const adapter: RelationAdapter<string> = {
      source: todoSource([], 'v1'),
      snapshot: () => ({
        source: todoSource([], 'v1')
      }),
      commit: () => {
        throw commitError;
      }
    };
    const store = createAdapterStore(adapter);

    const result = await store.commit([
      todos.insert({ id: 'todo-a', title: 'Alpha', done: false })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.reflected).toBe(false);
    expect(result.fullyCommitted).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.deltas).toEqual([]);
    expect(result.snapshot.revision).toBe(0);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        message: 'adapter commit failed'
      }
    ]);
    expect(result.diagnostics[0]?.detail).toBe(commitError);
  });

  it('normalizes malformed rejected adapter-store fallback commits without reflected effects', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    const bogusDelta = { relation: schema.todos, added: [beta], removed: [] };
    const adapter: RelationAdapter<string> = {
      source: todoSource([alpha], 'v1'),
      snapshot: () => ({
        source: todoSource([alpha], 'v1')
      }),
      commit: (_patches) =>
        ({
          status: 'rejected',
          committed: true,
          patches: 99,
          applied: 1,
          deltas: [bogusDelta],
          diagnostics: [{ code: 'source_error', message: 'malformed rejected commit' }],
          version: 'bogus'
        }) as unknown as AdapterCommitResult<string>
    };
    const store = createAdapterStore(adapter);

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('rejected');
    expect(result.reflected).toBe(false);
    expect(result.fullyCommitted).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.patches).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.deltas).toEqual([]);
    expect(result.snapshot.revision).toBe(0);
    expect(result.diagnostics).toMatchObject([
      { code: 'source_error', message: 'malformed rejected commit' }
    ]);
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
  });

  it('recomputes materialized adapter snapshots in refreshed source order after committed adapter writes', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    let version = 'v1';
    let latestRows: readonly Todo[] = [alpha];
    let snapshotSource = todoSource(latestRows, version);

    await materializeSnapshot(snapshotSource, openTodos, { id: 'adapter-open-todos', mode: 'incremental' });

    const adapter: RelationAdapter<string> = {
      source: {
        relationNames: ['todos'],
        rows: (relationRef) => relationRef.name === 'todos' ? latestRows : [],
        version: () => version
      },
      snapshot: () => ({
        source: snapshotSource,
        version
      }),
      commit: (patches) => {
        latestRows = [beta, ...latestRows];
        version = 'v2';
        snapshotSource = todoSource(latestRows, version);

        return {
          status: 'committed',
          committed: true,
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: [],
          durability: 'ephemeral',
          version
        };
      }
    };
    const store = createAdapterStore(adapter);

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('committed');
    expect(result.diagnostics).toEqual([]);
    expect(result.materializations).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: []
    });
    expect(result.materializations?.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'recomputed',
        id: 'adapter-open-todos',
        queryKey: expect.any(String),
        maintenance: 'incremental',
        previousRowsAvailable: true,
        previousRows: [{ id: 'todo-a', title: 'Alpha' }],
        rows: [
          { id: 'todo-b', title: 'Beta' },
          { id: 'todo-a', title: 'Alpha' }
        ],
        addedRows: [{ id: 'todo-b', title: 'Beta' }],
        removedRows: [],
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor(result.snapshot.source, 'adapter-open-todos')).toEqual([
      { id: 'todo-b', title: 'Beta' },
      { id: 'todo-a', title: 'Alpha' }
    ]);
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-b', title: 'Beta' },
        { id: 'todo-a', title: 'Alpha' }
      ]
    });
    expect(materializationsFor(result.snapshot.source)).toMatchObject([
      {
        id: 'adapter-open-todos',
        requestedMode: 'incremental',
        maintenance: 'incremental'
      }
    ]);
  });

  it('reports partial adapter commits as reflected but not fully committed', async () => {
    let version = 'v1';
    let latestRows: readonly Todo[] = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    const adapter: RelationAdapter<string> = {
      source: {
        relationNames: ['todos'],
        rows: (relationRef) => relationRef.name === 'todos' ? latestRows : [],
        version: () => version
      },
      snapshot: () => {
        const rows = [...latestRows];
        const snapshotVersion = version;

        return {
          source: {
            relationNames: ['todos'],
            rows: (relationRef) => relationRef.name === 'todos' ? rows : [],
            version: () => snapshotVersion
          },
          version: snapshotVersion
        };
      },
      commit: () => {
        latestRows = [...latestRows, beta];
        version = 'v2';

        return {
          status: 'partial',
          committed: false,
          patches: 0,
          applied: 1,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: [{ code: 'source_error', message: 'partial adapter commit' }],
          version
        };
      }
    };
    const store = createAdapterStore(adapter);

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('partial');
    expect(result.reflected).toBe(true);
    expect(result.fullyCommitted).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.materializations).toBeUndefined();
    expect(result.patches).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.version).toBe('v2');
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ]
    });
  });

  it('reads the fresh source snapshot version when apply commits omit a version', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    let latestRows: readonly Todo[] = [alpha];
    let snapshotSource = todoSource(latestRows, 'v1');
    const store = createSourceStore<string>({
      getSource: () => snapshotSource,
      getSnapshot: () => ({
        source: snapshotSource
      }),
      apply: (patches) => {
        latestRows = [...latestRows, beta];
        snapshotSource = todoSource(latestRows, 'v2');

        return {
          status: 'accepted',
          accepted: true,
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: []
        };
      }
    });

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('committed');
    expect(result.snapshot.version).toBe('v2');
    expect(store.getSnapshot().version).toBe('v2');
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ]
    });
  });

  it('reads the fresh source snapshot version when adapter-style source commits omit a version', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    let latestRows: readonly Todo[] = [alpha];
    let snapshotSource = todoSource(latestRows, 'v1');
    const store = createSourceStore<string>({
      getSource: () => snapshotSource,
      getSnapshot: () => ({
        source: snapshotSource
      }),
      commit: (patches) => {
        latestRows = [...latestRows, beta];
        snapshotSource = todoSource(latestRows, 'v2');

        return {
          status: 'committed',
          committed: true,
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: []
        };
      }
    });

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('committed');
    expect(result.snapshot.version).toBe('v2');
    expect(store.getSnapshot().version).toBe('v2');
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ]
    });
  });

  it('recomputes materialized source snapshots in refreshed source order after accepted apply commits', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    let version = 'v1';
    let latestRows: readonly Todo[] = [alpha];
    let snapshotSource = todoSource(latestRows, version);

    await materializeSnapshot(snapshotSource, openTodos, { id: 'source-open-todos', mode: 'incremental' });

    const store = createSourceStore<string>({
      getSource: () => snapshotSource,
      getSnapshot: () => ({
        source: snapshotSource,
        version
      }),
      apply: (patches) => {
        latestRows = [beta, ...latestRows];
        version = 'v2';
        snapshotSource = todoSource(latestRows, version);

        return {
          status: 'accepted',
          accepted: true,
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: [],
          durability: 'ephemeral',
          version
        };
      }
    });

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('committed');
    expect(result.reflected).toBe(true);
    expect(result.fullyCommitted).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.durability).toBe('ephemeral');
    expect(result.diagnostics).toEqual([]);
    expect(result.materializations).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: []
    });
    expect(result.materializations?.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'recomputed',
        id: 'source-open-todos',
        queryKey: expect.any(String),
        maintenance: 'incremental',
        previousRowsAvailable: true,
        previousRows: [{ id: 'todo-a', title: 'Alpha' }],
        rows: [
          { id: 'todo-b', title: 'Beta' },
          { id: 'todo-a', title: 'Alpha' }
        ],
        addedRows: [{ id: 'todo-b', title: 'Beta' }],
        removedRows: [],
        diagnostics: []
      }
    ]);
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.version).toBe('v2');
    expect(materializedRowsFor(result.snapshot.source, 'source-open-todos')).toEqual([
      { id: 'todo-b', title: 'Beta' },
      { id: 'todo-a', title: 'Alpha' }
    ]);
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-b', title: 'Beta' },
        { id: 'todo-a', title: 'Alpha' }
      ]
    });
    expect(materializationsFor(result.snapshot.source)).toMatchObject([
      {
        id: 'source-open-todos',
        requestedMode: 'incremental',
        maintenance: 'incremental'
      }
    ]);
  });

  it('omits materialization maintenance for unmaterialized source store commits', async () => {
    let version = 'v1';
    let latestRows: readonly Todo[] = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    const store = createSourceStore<string>({
      getSource: () => ({
        relationNames: ['todos'],
        rows: (relationRef) => relationRef.name === 'todos' ? latestRows : [],
        version: () => version
      }),
      getSnapshot: () => {
        const rows = [...latestRows];
        const snapshotVersion = version;

        return {
          source: {
            relationNames: ['todos'],
            rows: (relationRef) => relationRef.name === 'todos' ? rows : [],
            version: () => snapshotVersion
          },
          version: snapshotVersion
        };
      },
      commit: (patches) => {
        latestRows = [...latestRows, beta];
        version = 'v2';

        return {
          status: 'committed',
          committed: true,
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: [],
          version
        };
      }
    });

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('committed');
    expect(result.reflected).toBe(true);
    expect(result.fullyCommitted).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.materializations).toBeUndefined();
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.version).toBe('v2');
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ]
    });
  });

  it('evaluates useQuery against the captured snapshot source', async () => {
    const store = mutatingRowsStore(
      [{ id: 'todo-a', title: 'Alpha', done: false }],
      [{ id: 'todo-b', title: 'Beta', done: false }]
    );
    let rows: readonly unknown[] = [];
    let revision = -1;

    function Probe() {
      const result = useQuery(matchingTodoPairs);
      rows = result.rows;
      revision = result.revision;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(revision).toBe(0);
    expect(rows).toEqual([{ leftTitle: 'Alpha', rightTitle: 'Alpha' }]);
  });

  it('evaluates useQueries against the captured snapshot source', async () => {
    const store = mutatingRowsStore(
      [{ id: 'todo-a', title: 'Alpha', done: false }],
      [{ id: 'todo-b', title: 'Beta', done: false }]
    );
    let open: readonly unknown[] = [];
    let titles: readonly unknown[] = [];
    let revision = -1;

    function Probe() {
      const result = useQueries({ open: openTodos, titles: todoTitles });
      open = result.results?.open.rows ?? [];
      titles = result.results?.titles.rows ?? [];
      revision = result.revision;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(revision).toBe(0);
    expect(open).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(titles).toEqual([{ title: 'Alpha' }]);
  });
});

function todoSource(rows: readonly Todo[], version?: string): AdapterSource<string> {
  const source: AdapterSource<string> = {
    relationNames: ['todos'],
    rows: (relationRef) => relationRef.name === 'todos' ? rows : []
  };

  return version === undefined ? source : { ...source, version: () => version };
}

function mutatingRowsStore(initialRows: readonly Todo[], latestRows: readonly Todo[]): TarstateStore {
  let currentRows = initialRows;
  const source: RelationSource = {
    relationNames: ['todos'],
    rows: (relationRef) => {
      if (relationRef.name !== 'todos') {
        return [];
      }

      const rows = currentRows;
      currentRows = latestRows;
      return rows;
    }
  };
  const snapshot: TarstateSnapshot = {
    source,
    revision: 0,
    diagnostics: []
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    commit: async (patches) => ({
      kind: 'tarstateCommit',
      status: 'rejected',
      reflected: false,
      fullyCommitted: false,
      committed: false,
      patches: Array.from(patches).length,
      applied: 0,
      deltas: [],
      diagnostics: [],
      snapshot
    }),
    refresh: async () => {}
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
