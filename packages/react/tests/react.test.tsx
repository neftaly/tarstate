import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AdapterSource,
  RelationAdapter
} from '@tarstate/core/adapter';
import { createDb, stripMeta } from '@tarstate/core/db';
import { evaluate } from '@tarstate/core/evaluate';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { as, env, eq, from, join, pipe, project, where } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';
import { write, writeInputPatches } from '@tarstate/core/write';
import {
  createAdapterStore,
  createDbStore,
  createRuntimeStore,
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
  type QueriesHookState,
  type QueryHookState,
  type TarstateCommitInput,
  type TarstateCommitResult,
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
    expectTypeOf(useCommit).returns.toMatchTypeOf<(patches: TarstateCommitInput) => Promise<unknown>>();
    expectTypeOf<TarstateCommitResult<TarstateDbSnapshot>>().toHaveProperty('snapshot');
  });

  it('exports prefixed hook aliases', () => {
    expect(useTarstateQuery).toBe(useQuery);
    expect(useTarstateQueries).toBe(useQueries);
    expect(useTarstateCommit).toBe(useCommit);
    expectTypeOf(useTarstateQuery).toEqualTypeOf<typeof useQuery>();
    expectTypeOf(useTarstateQueries).toEqualTypeOf<typeof useQueries>();
    expectTypeOf(useTarstateCommit).returns.toMatchTypeOf<
      (patches: TarstateCommitInput) => Promise<unknown>
    >();
  });

  it('keeps the public React barrel consumable with core subpath queries and writes', () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });

    function ConsumerProbe() {
      const open = useQuery(openTodos);
      const selected = useQuery(openTodos, {
        select: (rows) => rows.map((row) => row.id)
      });
      const batch = useQueries({ open: openTodos, titles: todoTitles });
      const commit = useCommit<TarstateDbSnapshot>();

      expectTypeOf(open).toMatchTypeOf<QueryHookState<{ readonly id: string; readonly title: string }>>();
      expectTypeOf(selected).toMatchTypeOf<
        QueryHookState<{ readonly id: string; readonly title: string }, readonly string[]>
      >();
      expectTypeOf(batch).toMatchTypeOf<QueriesHookState<{ open: typeof openTodos; titles: typeof todoTitles }>>();
      expectTypeOf(commit).toMatchTypeOf<TarstateStore<TarstateDbSnapshot>['commit']>();

      return null;
    }

    const element = React.createElement(TarstateProvider, { store }, React.createElement(ConsumerProbe));

    expect(React.isValidElement(element)).toBe(true);
    expect(store.getSnapshot().revision).toBe(0);
  });

  it('updates subscribers only after committed transactions', async () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    const rejected = await store.commit(todos.insert({ id: 'todo-a', title: 'Duplicate', done: false }));

    expect(rejected.status).toBe('rejected');
    expect(rejected.reflected).toBe(false);
    expect(revisions).toEqual([]);

    const committed = await store.commit([todos.insert({ id: 'todo-b', title: 'Beta', done: false })]);

    expect(committed.status).toBe('accepted');
    expect(committed.reflected).toBe(true);
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    expect(stripMeta(committed.snapshot.db).todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: false },
      { id: 'todo-b', title: 'Beta', done: false }
    ]);
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
      todos.updateByKey('todo-a', { done: true })
    ]);

    expect(committed.status).toBe('accepted');
    expect(committed.reflected).toBe(true);
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    expect(committed.diagnostics).toEqual([]);
    expect(stripMeta(committed.snapshot.db).todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: true }
    ]);
    unsubscribe();
  });

  it('reports accepted no-op db commits without reflected row changes', async () => {
    const store = createDbStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });

    const ignored = await store.commit([
      todos.insertIgnore({ id: 'todo-a', title: 'Duplicate', done: true })
    ]);

    expect(ignored.status).toBe('accepted');
    expect(ignored.reflected).toBe(false);
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

  it('renders and commits through a real memory relation runtime store', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });
    const store = createRuntimeStore(runtime);
    const revisions: number[] = [];
    let latestRows: readonly unknown[] = [];
    let latestRevision = -1;
    let latestVersion: unknown;
    let commit: ReturnType<typeof useCommit> | undefined;

    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    function Probe() {
      const result = useQuery(openTodos);
      const snapshot = useTarstateSnapshot();
      commit = useCommit();
      latestRows = result.rows;
      latestRevision = result.revision;
      latestVersion = snapshot.version;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(latestRevision).toBe(0);
    expect(latestVersion).toBe(0);
    expect(latestRows).toEqual([{ id: 'todo-a', title: 'Alpha' }]);

    if (commit === undefined) {
      throw new Error('expected commit hook');
    }

    const commitRows = commit;
    let commitResult: Awaited<ReturnType<TarstateStore['commit']>> | undefined;
    await act(async () => {
      commitResult = await commitRows([
        todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
      ]);
      await flushEffects();
    });

    expect(commitResult).toMatchObject({
      status: 'accepted',
      reflected: true,
      effects: {
        durability: 'memory'
      },
      snapshot: {
        revision: 1,
        version: 1
      }
    });
    expect(revisions).toEqual([1]);
    expect(latestRevision).toBe(1);
    expect(latestVersion).toBe(1);
    expect(latestRows).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-c', title: 'Gamma' }
    ]);

    unsubscribe();
  });

  it('refreshes runtime stores from memory runtime host notifications', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const store = createRuntimeStore(runtime);
    let latestRows: readonly unknown[] = [];
    let latestRevision = -1;
    let latestVersion: unknown;

    function Probe() {
      const result = useQuery(openTodos);
      const snapshot = useTarstateSnapshot();
      latestRows = result.rows;
      latestRevision = result.revision;
      latestVersion = snapshot.version;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(latestRows).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(latestRevision).toBe(0);
    expect(latestVersion).toBe(0);

    await act(async () => {
      await runtime.target?.apply([
        todos.insert({ id: 'todo-b', title: 'Beta', done: false })
      ]);
      await flushEffects();
    });

    expect(latestRevision).toBe(1);
    expect(latestVersion).toBe(1);
    expect(latestRows).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-b', title: 'Beta' }
    ]);
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
          status: 'accepted',
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: []
        };
      }
    };
    const store = createAdapterStore(adapter);

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('accepted');
    expect(result.snapshot.version).toBe('v2');
    expect(store.getSnapshot().version).toBe('v2');
    await expect(evaluate(result.snapshot.source, openTodos)).resolves.toMatchObject({
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ]
    });
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
    expect(result.effects.patches).toBe(1);
    expect(result.effects.applied).toBe(1);
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
    const store = createRuntimeStore<string>({
      source: snapshotSource,
      snapshot: () => ({
        source: snapshotSource
      }),
      target: {
        apply: (patches) => {
        latestRows = [...latestRows, beta];
        snapshotSource = todoSource(latestRows, 'v2');

        return {
          status: 'accepted',
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: []
        };
        }
      }
    });

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('accepted');
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
    const store = createAdapterStore<string>({
      source: snapshotSource,
      snapshot: () => ({
        source: snapshotSource
      }),
      commit: (patches) => {
        latestRows = [...latestRows, beta];
        snapshotSource = todoSource(latestRows, 'v2');

        return {
          status: 'accepted',
          patches: patches.length,
          applied: patches.length,
          deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
          diagnostics: []
        };
      }
    });

    const result = await store.commit([todos.insert(beta)]);

    expect(result.status).toBe('accepted');
    expect(result.snapshot.version).toBe('v2');
    expect(store.getSnapshot().version).toBe('v2');
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

  it('falls back to source evaluation for stale materialized source rows', async () => {
    const counted = countedTodoSource([
      { id: 'todo-a', title: 'Alpha', done: false }
    ]);

    counted.setRows([{ id: 'todo-b', title: 'Beta', done: false }]);
    counted.setVersion('v2');

    const store = createSourceStore({ getSource: () => counted.source });
    let rows: readonly unknown[] = [];

    function Probe() {
      const result = useQuery(openTodos);
      rows = result.rows;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(rows).toEqual([{ id: 'todo-b', title: 'Beta' }]);
  });

  it('does not use materialized rows for queries with runtime env inputs', async () => {
    const db = createDb(
      {
        todos: [
          { id: 'todo-a', title: 'Alpha', done: false },
          { id: 'todo-b', title: 'Beta', done: false }
        ]
      },
      { title: 'Alpha' }
    );

    const store = createDbStore(db);
    let rows: readonly unknown[] = [];

    function Probe() {
      const result = useQuery(todosByEnvTitle, { env: { title: 'Beta' }, deps: ['Beta'] });
      rows = result.rows;
      return null;
    }

    await act(async () => {
      create(React.createElement(TarstateProvider, { store }, React.createElement(Probe)));
      await flushEffects();
    });

    expect(rows).toEqual([{ id: 'todo-b', title: 'Beta' }]);
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
      effects: {
        patches: Array.from(writeInputPatches(patches)).length,
        applied: 0,
        deltas: []
      },
      diagnostics: [],
      snapshot
    }),
    refresh: async () => {}
  };
}

function countedTodoSource(initialRows: readonly Todo[]): {
  readonly source: RelationSource;
  readonly setRows: (rows: readonly Todo[]) => void;
  readonly setVersion: (version: string) => void;
} {
  let rows = initialRows;
  let version = 'v1';

  return {
    source: {
      relationNames: ['todos'],
      rows: (relationRef) => {
        if (relationRef.name !== 'todos') {
          return [];
        }

        return rows;
      },
      version: () => version
    },
    setRows: (nextRows) => {
      rows = nextRows;
    },
    setVersion: (nextVersion) => {
      version = nextVersion;
    }
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
