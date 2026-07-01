import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DbTransactionError,
  createDb,
  dbSource,
  type DbWriteKey,
  dbDeleteWhere,
  dbUpdateWhere,
  exists,
  getEnv,
  q,
  qMany,
  qManyRows,
  qRows,
  row,
  stripMeta,
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
} from '@tarstate/core/experimental/constraints';
import { as, call, env, eq, from, pipe, project, where } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { insertOrUpdate, write } from '@tarstate/core/write';

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
    const todoRows = qRows(db, todoProjection);
    const todoIds = qRows(db, todoProjection, { mapRows: (rows) => rows.map((todoRow) => todoRow.id) });

    expectTypeOf(todoRows).toMatchTypeOf<
      Promise<readonly { readonly id: string; readonly text: string; readonly done: boolean }[]>
    >();
    expectTypeOf(todoIds).toMatchTypeOf<Promise<readonly string[]>>();
    await expect(todoRows).resolves.toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);
    await expect(todoIds).resolves.toEqual(['todo-a']);
    expect(Array.from(await dbSource(db).rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);
  });

  it('strips db metadata to normalized relation data', () => {
    const data = {
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    };
    const db = createDb(data, { workspaceId: 'workspace-a' });
    const plain = { todos: [] };
    const plainWithMetadataNames = { data: 'not-db-data', env: {} };

    expect(stripMeta(db)).toEqual(data);
    expect(stripMeta(plain)).toBe(plain);
    expect(stripMeta(plainWithMetadataNames)).toBe(plainWithMetadataNames);
  });

  it('preserves query diagnostics from evaluate', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', done: false }]
    });

    const result = await q(db, todoProjection);

    expect(result.rows).toEqual([{ id: 'todo-a', text: undefined, done: false }]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
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
    await expect(q(db, projected)).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-a', userId: 'user-a' }],
      diagnostics: []
    });
    await expect(q(db, projected, { env: { userId: 'override-user' } })).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-a', userId: 'override-user' }],
      diagnostics: []
    });

    const replaced = withEnv(db, { workspaceId: 'workspace-b' });
    expect(stripMeta(replaced)).toEqual(stripMeta(db));
    expect(getEnv(replaced)).toEqual({ workspaceId: 'workspace-b' });
    await expect(q(replaced, projected)).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-b', userId: undefined }],
      diagnostics: []
    });

    const updated = updateEnv(db, (current) => ({ ...current, workspaceId: 'workspace-c' }));
    expect(getEnv(updated)).toEqual({ workspaceId: 'workspace-c', userId: 'user-a' });
    expect(getEnv(transact(updated, [todos.updateByKey('todo-a', { done: true })]))).toEqual({
      workspaceId: 'workspace-c',
      userId: 'user-a'
    });
  });

  it('maps q rows after evaluation while preserving diagnostics', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', done: false }]
    });

    await expect(q(db, todoProjection, {
      mapRows: (rows) => rows.map((todoRow) => todoRow.text ?? `missing:${todoRow.id}`)
    })).resolves.toMatchObject({
      rows: ['missing:todo-a'],
      diagnostics: [
        {
          code: 'invalid_row',
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
    const rowBatch = qManyRows(db, { all: todoProjection, done: doneTodos });

    expectTypeOf(rowBatch).toMatchTypeOf<Promise<{
      readonly all: readonly { readonly id: string; readonly text: string; readonly done: boolean }[];
      readonly done: readonly { readonly id: string }[];
    }>>();
    await expect(rowBatch).resolves.toEqual({
      all: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: true }
      ],
      done: [{ id: 'todo-b' }]
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
        [todos.updateByKey('todo-a', { done: true }), todos.insert({ id: 'todo-b', text: 'Water basil', done: false })],
      )
    ).resolves.toEqual({
      rows: [
        { id: 'todo-a', text: 'Buy oat milk', done: true },
        { id: 'todo-b', text: 'Water basil', done: false }
      ],
      diagnostics: []
    });
    await expect(qRows(db, todoProjection)).resolves.toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
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
      todos.updateByKey('todo-a', { done: true }),
      todos.insert({ id: 'todo-c', text: 'Review notes', done: false })
    ]);

    expect(result).toMatchObject({ patches: 2, applied: 2, committed: true, diagnostics: [] });
    expect(stripMeta(db).todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
    expect(stripMeta(result.db).todos).toEqual([
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
    expect(stripMeta(inserted.db).todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
    expect(stripMeta(db).todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    const replaced = transact(inserted.db, (current) =>
      stripMeta(current).todos?.length === 2
        ? todos.replaceAll([{ id: 'todo-c', text: 'Review notes', done: false }])
        : todos.insert({ id: 'todo-missing', text: 'Unexpected branch', done: false })
    );

    expect(stripMeta(replaced).todos).toEqual([{ id: 'todo-c', text: 'Review notes', done: false }]);

    const updated = tryTransact(
      replaced,
      todos.updateByKey('todo-c', { done: true }),
      (current) => todos.insert({
        id: 'todo-d',
        text: 'Send update',
        done: (stripMeta(current).todos?.[0] as Todo | undefined)?.done ?? false
      })
    );

    expect(updated).toMatchObject({ patches: 2, applied: 2, committed: true, diagnostics: [] });
    expect(stripMeta(updated.db).todos).toEqual([
      { id: 'todo-c', text: 'Review notes', done: true },
      { id: 'todo-d', text: 'Send update', done: false }
    ]);
  });

  it('creates keyed update/delete transaction inputs alongside explicit write patches', () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    });

    const result = tryTransact(
      db,
      dbUpdateWhere(schema.todos, 'todo-a', { done: true }),
      dbDeleteWhere(schema.todos, 'todo-b'),
      insertOrUpdate(
        schema.todos,
        { id: 'todo-c', text: 'Review notes', done: false },
        { update: { text: 'Review notes' } }
      ),
      insertOrUpdate(
        schema.todos,
        { id: 'todo-c', text: 'Review notes', done: false },
        { update: { text: 'Review updated notes' } }
      )
    );

    expect(result).toMatchObject({ patches: 4, applied: 4, committed: true, diagnostics: [] });
    expect(stripMeta(result.db).todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-c', text: 'Review updated notes', done: false }
    ]);
    expect(stripMeta(db).todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
  });

  it('creates predicate update/delete transaction inputs by scanning current db rows', () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false },
        { id: 'todo-c', text: 'Review notes', done: true }
      ]
    });
    const seen: string[] = [];

    const result = tryTransact(
      db,
      dbUpdateWhere(
        schema.todos,
        (todoRow, _index, current) => {
          expect(current).toBe(db);
          seen.push(todoRow.id);
          return !todoRow.done;
        },
        { done: true }
      ),
      dbDeleteWhere(schema.todos, (todoRow) => todoRow.text === 'Water basil')
    );

    expect(seen).toHaveLength(3);
    expect(seen).toEqual(expect.arrayContaining(['todo-a', 'todo-b', 'todo-c']));
    expect(result).toMatchObject({ patches: 3, applied: 3, committed: true, diagnostics: [] });
    expect(stripMeta(result.db).todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-c', text: 'Review notes', done: true }
    ]);
  });

  it('rejects malformed tuple and object keys instead of treating them as structural filters', () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    });

    const updateResult = tryTransact(db, dbUpdateWhere(schema.todos, ['todo-a', 'extra'], { done: true }));
    const deleteResult = tryTransact(db, dbDeleteWhere(schema.todos, ['todo-a', 'extra']));
    const updateObjectResult = tryTransact(
      db,
      dbUpdateWhere(schema.todos, { id: 'todo-a' } as unknown as DbWriteKey, { done: true })
    );
    const deleteBooleanResult = tryTransact(db, dbDeleteWhere(schema.todos, true as unknown as DbWriteKey));

    expect(updateResult).toMatchObject({
      patches: 1,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos' }]
    });
    expect(updateResult.db).toBe(db);
    expect(deleteResult).toMatchObject({
      patches: 1,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos' }]
    });
    expect(deleteResult.db).toBe(db);
    expect(updateObjectResult).toMatchObject({
      patches: 1,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos' }]
    });
    expect(updateObjectResult.db).toBe(db);
    expect(deleteBooleanResult).toMatchObject({
      patches: 1,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos' }]
    });
    expect(deleteBooleanResult.db).toBe(db);
  });

  it('tryTransact preserves write diagnostics without throwing', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    const result = tryTransact(db, [
      todos.insert({ id: 'todo-a', text: 'Duplicate', done: false }),
      todos.updateByKey('todo-missing', { done: true })
    ]);

    expect(result.patches).toBe(2);
    expect(result.applied).toBe(0);
    expect(result.committed).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duplicate_key', 'invalid_row']);
    expect(stripMeta(result.db).todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
    expect(stripMeta(db).todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('tryTransact is all-or-nothing when a later patch fails', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    const result = tryTransact(db, [
      todos.updateByKey('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Broken', done: 'no' } as unknown as Todo)
    ]);

    expect(result).toMatchObject({
      patches: 2,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos', field: 'done' }]
    });
    expect(result.db).toBe(db);
    expect(stripMeta(result.db).todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('transact returns a db on clean writes and throws diagnostics on invalid writes', () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    });

    expect(stripMeta(transact(db, [todos.updateByKey('todo-a', { done: true })])).todos).toEqual([
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
      expect(stripMeta(caught.db).todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
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
    expect(result.db).toBe(db);
    expect(stripMeta(db).todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

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
