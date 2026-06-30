import { describe, expect, it } from 'vitest';
import {
  DbTransactionError,
  createDb,
  dbSource,
  exists,
  getEnv,
  q,
  qMany,
  row,
  transact,
  tryTransact,
  updateEnv,
  whatIf,
  withEnv
} from '@tarstate/core/db';
import {
  DbConstraintTransactionError,
  transactConstrained,
  tryTransactConstrained,
  unique
} from '@tarstate/core/constraints';
import { as, call, env, eq, from, pipe, project, where } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';

type Todo = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      done: booleanField()
    }
  })
});

const todo = as(schema.todos, 'todo');
const todoProjection = pipe(
  from(todo),
  project({
    id: todo.id,
    text: todo.text,
    done: todo.done
  })
);
const todos = write(schema.todos);

describe('tarstate db facade', () => {
  it('queries a db through q and exposes a source adapter', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    await expect(q(db, todoProjection)).resolves.toEqual({
      rows: [{ id: 'todo-a', text: 'Buy oat milk', done: false }],
      diagnostics: []
    });
    expect(Array.from(await dbSource(db).rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);
  });

  it('preserves query diagnostics from evaluate', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', done: false }]
    });

    const result = await q(db, todoProjection);

    expect(result.rows).toEqual([{ id: 'todo-a', text: undefined, done: false }]);
    expect(result.diagnostics).toEqual([
      {
        code: 'invalid_row',
        message: 'missing required field text in relation todos',
        relation: 'todos',
        field: 'text'
      }
    ]);
  });

  it('passes evaluator options through q', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });
    const projected = pipe(
      from(todo),
      project({
        id: todo.id,
        label: call('label', todo.text)
      })
    );

    await expect(
      q(db, projected, {
        functions: {
          label: (value) => `todo:${String(value)}`
        }
      })
    ).resolves.toEqual({
      rows: [{ id: 'todo-a', label: 'todo:Buy oat milk' }],
      diagnostics: []
    });
  });

  it('stores env separately from relation data and evaluates env expressions through q', async () => {
    const db = createDb(
      {
        todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
      },
      { workspaceId: 'workspace-a', userId: 'user-a' }
    );
    const projected = pipe(
      from(todo),
      project({
        id: todo.id,
        workspaceId: env('workspaceId'),
        userId: env('userId')
      })
    );

    expect(getEnv(db)).toEqual({ workspaceId: 'workspace-a', userId: 'user-a' });
    expect(Object.hasOwn(db.data, 'workspaceId')).toBe(false);
    await expect(q(db, projected)).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-a', userId: 'user-a' }],
      diagnostics: []
    });
    await expect(q(db, projected, { env: { userId: 'override-user' } })).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-a', userId: 'override-user' }],
      diagnostics: []
    });

    const replaced = withEnv(db, { workspaceId: 'workspace-b' });
    expect(replaced.data).toBe(db.data);
    expect(getEnv(replaced)).toEqual({ workspaceId: 'workspace-b' });
    await expect(q(replaced, projected)).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-b', userId: undefined }],
      diagnostics: []
    });

    const updated = updateEnv(db, (current) => ({ ...current, workspaceId: 'workspace-c' }));
    expect(getEnv(updated)).toEqual({ workspaceId: 'workspace-c', userId: 'user-a' });
    expect(transact(updated, [todos.update('todo-a', { done: true })]).env).toEqual({
      workspaceId: 'workspace-c',
      userId: 'user-a'
    });
  });

  it('maps q rows after evaluation while preserving diagnostics', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', done: false }]
    });

    await expect(
      q(db, todoProjection, {
        mapRows: (rows) => rows.map((todoRow) => todoRow.text ?? `missing:${todoRow.id}`)
      })
    ).resolves.toEqual({
      rows: ['missing:todo-a'],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'missing required field text in relation todos',
          relation: 'todos',
          field: 'text'
        }
      ]
    });
  });

  it('evaluates named query batches against a db', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: true }
      ]
    });
    const doneTodos = pipe(
      from(todo),
      where(eq(todo.done, true)),
      project({
        id: todo.id
      })
    );

    await expect(qMany(db, { all: todoProjection, done: doneTodos })).resolves.toEqual({
      all: {
        rows: [
          { id: 'todo-a', text: 'Buy oat milk', done: false },
          { id: 'todo-b', text: 'Water basil', done: true }
        ],
        diagnostics: []
      },
      done: {
        rows: [{ id: 'todo-b' }],
        diagnostics: []
      }
    });
    await expect(q(db, { done: doneTodos })).resolves.toEqual({
      done: {
        rows: [{ id: 'todo-b' }],
        diagnostics: []
      }
    });
  });

  it('maps qMany rows while preserving named query result envelopes', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: true }
      ]
    });
    const doneTodos = pipe(
      from(todo),
      where(eq(todo.done, true)),
      project({
        id: todo.id
      })
    );

    await expect(
      qMany(db, { all: todoProjection, done: doneTodos }, { mapRows: (rows) => rows.map((todoRow) => todoRow.id) })
    ).resolves.toEqual({
      all: {
        rows: ['todo-a', 'todo-b'],
        diagnostics: []
      },
      done: {
        rows: ['todo-b'],
        diagnostics: []
      }
    });
    await expect(q(db, { done: doneTodos }, { mapRows: (rows) => rows.map((todoRow) => todoRow.id) })).resolves.toEqual({
      done: {
        rows: ['todo-b'],
        diagnostics: []
      }
    });
  });

  it('reads first-row and existence conveniences from a db', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: true }
      ]
    });
    const openTodos = pipe(
      from(todo),
      where(eq(todo.done, false)),
      project({
        id: todo.id,
        text: todo.text
      })
    );

    await expect(row(db, openTodos)).resolves.toEqual({ id: 'todo-a', text: 'Buy oat milk' });
    await expect(exists(db, openTodos)).resolves.toBe(true);
    await expect(exists(db, pipe(from(todo), where(eq(todo.id, 'todo-missing'))))).resolves.toBe(false);
  });

  it('queries a what-if transaction without changing the input db', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    await expect(
      whatIf(
        db,
        todoProjection,
        [todos.update('todo-a', { done: true }), todos.insert({ id: 'todo-b', text: 'Water basil', done: false })],
      )
    ).resolves.toEqual({
      rows: [
        { id: 'todo-a', text: 'Buy oat milk', done: true },
        { id: 'todo-b', text: 'Water basil', done: false }
      ],
      diagnostics: []
    });
    expect(db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('queries a what-if transaction with a named query batch', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });
    const openTodos = pipe(
      from(todo),
      where(eq(todo.done, false)),
      project({ id: todo.id })
    );

    await expect(
      whatIf(
        db,
        { all: todoProjection, open: openTodos },
        [todos.insert({ id: 'todo-b', text: 'Water basil', done: false })]
      )
    ).resolves.toEqual({
      all: {
        rows: [
          { id: 'todo-a', text: 'Buy oat milk', done: false },
          { id: 'todo-b', text: 'Water basil', done: false }
        ],
        diagnostics: []
      },
      open: {
        rows: [{ id: 'todo-a' }, { id: 'todo-b' }],
        diagnostics: []
      }
    });
  });

  it('maps what-if query rows after applying patches', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });
    const openTodos = pipe(
      from(todo),
      where(eq(todo.done, false)),
      project({ id: todo.id })
    );

    await expect(
      whatIf(
        db,
        { all: todoProjection, open: openTodos },
        [todos.insert({ id: 'todo-b', text: 'Water basil', done: false })],
        { mapRows: (rows) => rows.map((todoRow) => todoRow.id) }
      )
    ).resolves.toEqual({
      all: {
        rows: ['todo-a', 'todo-b'],
        diagnostics: []
      },
      open: {
        rows: ['todo-a', 'todo-b'],
        diagnostics: []
      }
    });
  });

  it('tryTransact returns a new db without mutating the input db', () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    });

    const result = tryTransact(db, [
      todos.update('todo-a', { done: true }),
      todos.insert({ id: 'todo-c', text: 'Review notes', done: false })
    ]);

    expect(result).toMatchObject({ patches: 2, applied: 2, committed: true, diagnostics: [] });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', text: 'Buy oat milk', done: true },
          { id: 'todo-c', text: 'Review notes', done: false }
        ],
        removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
      }
    ]);
    expect(result.db.data.todos).not.toBe(db.data.todos);
    expect(db.data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
    expect(result.db.data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-b', text: 'Water basil', done: false },
      { id: 'todo-c', text: 'Review notes', done: false }
    ]);
  });

  it('accepts single patch and callback transaction inputs', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    const inserted = tryTransact(db, todos.insert({ id: 'todo-b', text: 'Water basil', done: false }));

    expect(inserted).toMatchObject({ patches: 1, applied: 1, committed: true, diagnostics: [] });
    expect(inserted.db.data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
    expect(db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    const replaced = transact(inserted.db, (current) =>
      current.data.todos?.length === 2
        ? todos.replaceAll([{ id: 'todo-c', text: 'Review notes', done: false }])
        : todos.insert({ id: 'todo-missing', text: 'Unexpected branch', done: false })
    );

    expect(replaced.data.todos).toEqual([{ id: 'todo-c', text: 'Review notes', done: false }]);

    const updated = tryTransact(replaced, (current) => [
      todos.update('todo-c', { done: current.data.todos?.length === 1 }),
      todos.insert({ id: 'todo-d', text: 'Send update', done: false })
    ]);

    expect(updated).toMatchObject({ patches: 2, applied: 2, committed: true, diagnostics: [] });
    expect(updated.db.data.todos).toEqual([
      { id: 'todo-c', text: 'Review notes', done: true },
      { id: 'todo-d', text: 'Send update', done: false }
    ]);
  });

  it('tryTransact preserves write diagnostics without throwing', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    const result = tryTransact(db, [
      todos.insert({ id: 'todo-a', text: 'Duplicate', done: false }),
      todos.update('todo-missing', { done: true })
    ]);

    expect(result.patches).toBe(2);
    expect(result.applied).toBe(0);
    expect(result.committed).toBe(false);
    expect(result.deltas).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duplicate_key', 'invalid_row']);
    expect(result.db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
    expect(db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('tryTransact is all-or-nothing when a later patch fails', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    const result = tryTransact(db, [
      todos.update('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Broken', done: 'no' } as unknown as Todo)
    ]);

    expect(result).toMatchObject({
      patches: 2,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos', field: 'done' }]
    });
    expect(result.deltas).toEqual([]);
    expect(result.db).toBe(db);
    expect(result.db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('transact returns a db on clean writes and throws diagnostics on invalid writes', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    expect(transact(db, [todos.update('todo-a', { done: true })]).data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true }
    ]);

    let caught: unknown;
    try {
      transact(db, [todos.insert({ id: 'todo-a', text: 'Duplicate', done: false })]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DbTransactionError);
    if (caught instanceof DbTransactionError) {
      expect(caught.patches).toBe(1);
      expect(caught.applied).toBe(0);
      expect(caught.committed).toBe(false);
      expect(caught.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duplicate_key']);
      expect(caught.db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
    }
  });

  it('tryTransactConstrained commits only when writes and constraints pass', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    const result = await tryTransactConstrained(
      db,
      [todos.insert({ id: 'todo-b', text: 'Buy oat milk', done: false })],
      [unique(schema.todos, 'text')]
    );

    expect(result).toMatchObject({
      patches: 1,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'duplicate_key', relation: 'todos', field: 'text' }]
    });
    expect(result.deltas).toEqual([]);
    expect(result.db).toBe(db);
    expect(db.data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    await expect(
      tryTransactConstrained(
        db,
        [todos.insert({ id: 'todo-b', text: 'Water basil', done: false })],
        [unique(schema.todos, 'text')]
      )
    ).resolves.toMatchObject({
      patches: 1,
      applied: 1,
      committed: true,
      diagnostics: []
    });
  });

  it('transactConstrained throws constraint diagnostics on failure', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    let caught: unknown;
    try {
      await transactConstrained(
        db,
        [todos.insert({ id: 'todo-b', text: 'Buy oat milk', done: false })],
        [unique(schema.todos, 'text')]
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DbConstraintTransactionError);
    if (caught instanceof DbConstraintTransactionError) {
      expect(caught.committed).toBe(false);
      expect(caught.db).toBe(db);
      expect(caught.diagnostics).toMatchObject([{ code: 'duplicate_key', field: 'text' }]);
    }
  });
});
