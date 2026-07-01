import { describe, expect, expectTypeOf, it } from 'vitest';
import { as, eq, from, pipe, project, where } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createStore, type Store, type StoreCommitInput, type StoreView } from '@tarstate/core/store';
import { write } from '@tarstate/core/write';

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
    expectTypeOf(store.commit).parameter(0).toMatchTypeOf<StoreCommitInput>();
    await expect(store.query(openTodos)).resolves.toEqual({
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      diagnostics: []
    });

    const rejected = await store.commit(todos.insert({ id: 'todo-a', title: 'Duplicate', done: false }));

    expect(rejected).toMatchObject({
      kind: 'tarstateCommit',
      status: 'rejected',
      reflected: false,
    });
    expect(revisions).toEqual([]);
    expect(store.getSnapshot().revision).toBe(0);

    const committed = await store.commit([
      todos.insert({ id: 'todo-b', title: 'Beta', done: false })
    ]);

    expect(committed).toMatchObject({
      kind: 'tarstateCommit',
      status: 'accepted',
      reflected: true,
    });
    expect(committed.snapshot.revision).toBe(1);
    expect(revisions).toEqual([1]);
    await expect(store.query(openTodos, { mapRows: (rows) => rows.map((row) => row.id) })).resolves.toEqual({
      rows: ['todo-a', 'todo-b'],
      diagnostics: []
    });

    unsubscribe();
  });

  it('reads derived views through one stable view API', async () => {
    const store = createStore({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });
    const view = store.view(openTodos);

    expectTypeOf(view).toMatchTypeOf<StoreView<{ readonly id: string; readonly title: string }>>();
    await expect(view.rows()).resolves.toEqual([{ id: 'todo-a', title: 'Alpha' }]);

    await store.commit(todos.updateByKey('todo-a', { done: true }));

    await expect(view.read()).resolves.toEqual({
      rows: [],
      diagnostics: []
    });
  });
});
