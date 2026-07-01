import { describe, expect, expectTypeOf, it } from 'vitest';
import { as, eq, from, pipe, project, where } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createStore, type Store, type StoreView } from '@tarstate/core/store';
import { write, type WritePatch } from '@tarstate/core/write';

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
const todos = write(schema.todos);
const openTodos = pipe(
  from(todo),
  where(eq(todo.done, false)),
  project({
    id: todo.id,
    title: todo.title
  })
);

describe('tarstate store facade', () => {
  it('queries and commits through a renderer-independent store API', async () => {
    const store = createStore({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    expectTypeOf(store).toMatchTypeOf<Store>();
    expectTypeOf(store.commit).parameter(0).toMatchTypeOf<WritePatch | Iterable<WritePatch>>();
    await expect(store.query(openTodos)).resolves.toEqual({
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      diagnostics: []
    });

    const rejected = await store.commit(todos.insert({ id: 'todo-a', title: 'Duplicate', done: false }));

    expect(rejected).toMatchObject({
      kind: 'tarstateCommit',
      status: 'rejected',
      reflected: false,
      fullyCommitted: false,
      committed: false,
      applied: 0
    });
    expect(revisions).toEqual([]);
    expect(store.getSnapshot().revision).toBe(0);

    const committed = await store.commit([
      todos.insert({ id: 'todo-b', title: 'Beta', done: false })
    ]);

    expect(committed).toMatchObject({
      kind: 'tarstateCommit',
      status: 'committed',
      reflected: true,
      fullyCommitted: true,
      committed: true,
      applied: 1
    });
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    await expect(store.query(openTodos, { mapRows: (rows) => rows.map((row) => row.id) })).resolves.toEqual({
      rows: ['todo-a', 'todo-b'],
      diagnostics: []
    });

    unsubscribe();
  });

  it('treats materialized views as a cache behind the same read API', async () => {
    const store = createStore({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });
    const view = store.view(openTodos, { id: 'open-todos', mode: 'incremental' });

    expectTypeOf(view).toMatchTypeOf<StoreView<{ readonly id: string; readonly title: string }>>();
    await expect(view.rows()).resolves.toEqual([{ id: 'todo-a', title: 'Alpha' }]);

    const materialized = await view.materialize();

    expect(materialized).toMatchObject({
      kind: 'storeMaterialization',
      materialized: true,
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      metadata: {
        id: 'open-todos',
        requestedMode: 'incremental',
        maintenance: 'incremental'
      }
    });
    expect(view.materialization()).toMatchObject({ id: 'open-todos' });

    const committed = await store.commit(todos.update('todo-a', { done: true }));

    expect(committed.materializations).toMatchObject({
      maintained: 1,
      changes: [{ id: 'open-todos', maintenance: 'incremental' }]
    });
    await expect(view.read()).resolves.toEqual({
      rows: [],
      diagnostics: []
    });
    await expect(view.read({ cache: 'ignore-cache' })).resolves.toEqual({
      rows: [],
      diagnostics: []
    });
  });
});
