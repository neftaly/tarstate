import { describe, expect, expectTypeOf, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { as, from, pipe, project } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  optional,
  refField,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { fromObjectSource } from '@tarstate/core/source';
import {
  applyWritesAtomic,
  applyWrites,
  type MutableObjectSourceData
} from '@tarstate/core/write-apply';
import {
  deleteExact,
  deleteRow,
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  replaceAll,
  update,
  upsert,
  write,
  type InsertIgnorePatch,
  type InsertOrMergePatch,
  type InsertOrUpdatePatch,
  type InsertPatch,
  type RelationRow,
  type ReplaceAllPatch,
  type UpdatePatch,
  type WritePatch
} from '@tarstate/core/write';

type Todo = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
};

type Assignment = {
  readonly todoId: string;
  readonly assignee: string;
};

type Presence = {
  readonly workspaceId: string;
  readonly peerId: string;
  readonly clientId: string;
  readonly targetTodoId?: string;
};

type MaybeTodo = {
  readonly id: string;
  readonly label?: string;
  readonly archivedAt: string | null;
};

type PresenceIntent = {
  readonly id: string;
  readonly payload?: JsonValue;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      done: booleanField()
    }
  }),
  assignments: relation<Assignment>({
    key: 'todoId',
    fields: {
      todoId: refField('todos.id'),
      assignee: stringField()
    }
  }),
  presence: relation<Presence>({
    key: ['workspaceId', 'peerId', 'clientId'],
    ephemeral: true,
    fields: {
      workspaceId: idField('workspace'),
      peerId: idField('peer'),
      clientId: stringField(),
      targetTodoId: optional(refField('todos.id'))
    }
  }),
  maybeTodos: relation<MaybeTodo>({
    key: 'id',
    fields: {
      id: idField('maybe-todo'),
      label: optional(stringField()),
      archivedAt: nullable(stringField())
    }
  }),
  presenceIntents: relation<PresenceIntent>({
    key: 'id',
    ephemeral: true,
    fields: {
      id: idField('presence-intent'),
      payload: optional(jsonField())
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

describe('tarstate writes', () => {
  it('offers relation-scoped typed patch constructors', () => {
    const todos = write(schema.todos);
    const patch = todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false });
    const tersePatch = insert(schema.todos)({ id: 'todo-e', text: 'Charge lamp', done: false });
    const ignored = todos.insertIgnore({ id: 'todo-c', text: 'Plan route', done: false });
    const merged = insertOrMerge(schema.todos, { id: 'todo-a', done: true });
    const insertUpdated = todos.insertOrUpdate({ id: 'todo-a', done: true });
    const standalone = update(schema.todos, 'todo-a', { done: true });
    const replaced = todos.insertOrReplace({ id: 'todo-b', text: 'Water basil', done: false });
    const replacedAll = todos.replaceAll([{ id: 'todo-z', text: 'Reset list', done: false }]);
    const exactDelete = deleteExact(schema.todos, { id: 'todo-b', text: 'Water basil', done: false });
    const patches = [
      patch,
      tersePatch,
      ignored,
      merged,
      insertUpdated,
      standalone,
      insertIgnore(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      upsert(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      insertOrReplace(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      insertOrUpdate(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      replaced,
      replaceAll(schema.assignments, [{ todoId: 'todo-a', assignee: 'Mina' }]),
      replacedAll,
      exactDelete,
      deleteRow(schema.todos, 'todo-b')
    ] satisfies readonly WritePatch[];

    expectTypeOf<RelationRow<typeof schema.todos>>().toEqualTypeOf<Todo>();
    expectTypeOf(patch).toEqualTypeOf<InsertPatch<typeof schema.todos>>();
    expectTypeOf(tersePatch).toEqualTypeOf<InsertPatch<typeof schema.todos>>();
    expectTypeOf(ignored).toEqualTypeOf<InsertIgnorePatch<typeof schema.todos>>();
    expectTypeOf(merged).toEqualTypeOf<InsertOrMergePatch<typeof schema.todos>>();
    expectTypeOf(insertUpdated).toEqualTypeOf<InsertOrUpdatePatch<typeof schema.todos>>();
    expectTypeOf<InsertOrUpdatePatch<typeof schema.todos>>().toEqualTypeOf<
      InsertOrMergePatch<typeof schema.todos>
    >();
    expectTypeOf(replacedAll).toEqualTypeOf<ReplaceAllPatch<typeof schema.todos>>();
    expectTypeOf(standalone).toEqualTypeOf<UpdatePatch<typeof schema.todos>>();
    expect(ignored.onConflict).toBe('ignore');
    expect(merged.mode).toBe('merge');
    expect(insertUpdated).toEqual(merged);
    expect(patches.map((item) => item.op)).toEqual([
      'insert',
      'insert',
      'insert',
      'upsert',
      'upsert',
      'update',
      'insert',
      'upsert',
      'upsert',
      'upsert',
      'upsert',
      'replaceAll',
      'replaceAll',
      'deleteExact',
      'delete'
    ]);

    if (process.env.TARSTATE_TYPECHECK_ONLY === '1') {
      // @ts-expect-error insert rows must include required relation fields.
      todos.insert({ id: 'todo-b', done: false });
      // @ts-expect-error insert-ignore rows must include required relation fields.
      todos.insertIgnore({ id: 'todo-b', done: false });
      // @ts-expect-error updates reject unknown relation fields.
      todos.update('todo-a', { complete: true });
      // @ts-expect-error upsert rows reject unknown relation fields.
      todos.upsert({ id: 'todo-c', text: 'Plan', done: false, extra: true });
      // @ts-expect-error insert-or-replace rows reject unknown relation fields.
      todos.insertOrReplace({ id: 'todo-c', text: 'Plan', done: false, extra: true });
      // @ts-expect-error insert-or-merge rows reject unknown relation fields.
      todos.insertOrMerge({ id: 'todo-c', complete: true });
      // @ts-expect-error insert-or-update rows reject unknown relation fields.
      todos.insertOrUpdate({ id: 'todo-c', complete: true });
      // @ts-expect-error delete-exact rows must include required relation fields.
      todos.deleteExact({ id: 'todo-c' });
      // @ts-expect-error replace-all rows must include required relation fields.
      todos.replaceAll([{ id: 'todo-c', done: false }]);
    }
  });

  it('applies insert, update, upsert, and delete patches in order', async () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.update('todo-a', { done: true }),
      todos.upsert({ id: 'todo-c', text: 'Review notes', done: false }),
      todos.upsert({ id: 'todo-b', text: 'Water herbs', done: true }),
      todos.delete({ id: 'todo-c' }),
      insert(schema.todos, { id: 'todo-d', text: 'Send update', done: false })
    ]);

    expect(result).toMatchObject({ patches: 5, applied: 5, diagnostics: [] });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', text: 'Buy oat milk', done: true },
          { id: 'todo-c', text: 'Review notes', done: false },
          { id: 'todo-b', text: 'Water herbs', done: true },
          { id: 'todo-d', text: 'Send update', done: false }
        ],
        removed: [
          { id: 'todo-a', text: 'Buy oat milk', done: false },
          { id: 'todo-b', text: 'Water basil', done: false },
          { id: 'todo-c', text: 'Review notes', done: false }
        ]
      }
    ]);
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-b', text: 'Water herbs', done: true },
      { id: 'todo-d', text: 'Send update', done: false }
    ]);

    await expect(evaluate(fromObjectSource(data), todoProjection)).resolves.toEqual({
      rows: [
        { id: 'todo-a', text: 'Buy oat milk', done: true },
        { id: 'todo-b', text: 'Water herbs', done: true },
        { id: 'todo-d', text: 'Send update', done: false }
      ],
      diagnostics: []
    });
  });

  it('supports Relic-style insert-ignore, insert-or-merge/update, insert-or-replace, and delete-exact APIs', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.insertIgnore({ id: 'todo-a', text: 'Duplicate', done: true }),
      todos.insertIgnore({ id: 'todo-c', text: 'Review notes', done: false }),
      todos.insertOrMerge({ id: 'todo-a', done: true }),
      todos.insertOrUpdate({ id: 'todo-a', text: 'Buy almond milk' }),
      insertOrUpdate(schema.todos, { id: 'todo-d', text: 'Draft update', done: false }),
      todos.insertOrReplace({ id: 'todo-b', text: 'Water herbs', done: true }),
      todos.deleteExact({ id: 'todo-c', text: 'Review notes', done: false })
    ]);

    expect(result).toMatchObject({ patches: 7, applied: 7, diagnostics: [] });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-c', text: 'Review notes', done: false },
          { id: 'todo-a', text: 'Buy oat milk', done: true },
          { id: 'todo-a', text: 'Buy almond milk', done: true },
          { id: 'todo-d', text: 'Draft update', done: false },
          { id: 'todo-b', text: 'Water herbs', done: true }
        ],
        removed: [
          { id: 'todo-a', text: 'Buy oat milk', done: false },
          { id: 'todo-a', text: 'Buy oat milk', done: true },
          { id: 'todo-b', text: 'Water basil', done: false },
          { id: 'todo-c', text: 'Review notes', done: false }
        ]
      }
    ]);
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy almond milk', done: true },
      { id: 'todo-b', text: 'Water herbs', done: true },
      { id: 'todo-d', text: 'Draft update', done: false }
    ]);
  });

  it('rejects delete-exact patches when non-key fields do not match', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.deleteExact({ id: 'todo-a', text: 'Buy almond milk', done: false }),
      todos.delete('todo-b')
    ]);

    expect(result).toMatchObject({
      patches: 2,
      applied: 1,
      diagnostics: [
        {
          code: 'invalid_row',
          relation: 'todos',
          key: '["todo-a"]'
        }
      ]
    });
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);
  });

  it('replaces all rows for one relation as a single write patch', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.replaceAll([
        { id: 'todo-b', text: 'Water herbs', done: true },
        { id: 'todo-c', text: 'Review notes', done: false }
      ]),
      todos.update('todo-c', { done: true }),
      todos.delete('todo-b')
    ]);

    expect(result).toMatchObject({ patches: 3, applied: 3, diagnostics: [] });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-b', text: 'Water herbs', done: true },
          { id: 'todo-c', text: 'Review notes', done: false },
          { id: 'todo-c', text: 'Review notes', done: true }
        ],
        removed: [
          { id: 'todo-a', text: 'Buy oat milk', done: false },
          { id: 'todo-b', text: 'Water basil', done: false },
          { id: 'todo-c', text: 'Review notes', done: false },
          { id: 'todo-b', text: 'Water herbs', done: true }
        ]
      }
    ]);
    expect(data.todos).toEqual([{ id: 'todo-c', text: 'Review notes', done: true }]);
  });

  it('rejects invalid replace-all rows without mutating the relation', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.replaceAll([
        { id: 'todo-c', text: 'Review notes', done: false },
        { id: 'todo-c', text: 'Duplicate notes', done: false },
        { id: 'todo-d', done: true } as unknown as Todo
      ])
    ]);

    expect(result.applied).toBe(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duplicate_key', 'invalid_row']);
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
  });

  it('accepts a single write patch as object write input', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {};

    const result = applyWrites(data, todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false }));

    expect(result).toMatchObject({ patches: 1, applied: 1, diagnostics: [] });
    expect(data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('validates insert-or-merge and insert-or-update as full rows when they insert', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {};
    const updateData: MutableObjectSourceData = {};

    const mergeResult = applyWrites(data, [todos.insertOrMerge({ id: 'todo-a', done: true })]);
    const updateResult = applyWrites(updateData, [todos.insertOrUpdate({ id: 'todo-a', done: true })]);

    expect(mergeResult.applied).toBe(0);
    expect(mergeResult.diagnostics).toEqual([
      {
        code: 'invalid_row',
        message: 'missing required field text in relation todos',
        relation: 'todos',
        field: 'text'
      }
    ]);
    expect(data.todos).toEqual([]);
    expect(updateResult).toMatchObject({ applied: 0, diagnostics: mergeResult.diagnostics });
    expect(updateData.todos).toEqual([]);
  });

  it('reports validation diagnostics and skips invalid mutations', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    };

    const result = applyWrites(data, [
      todos.insert({ id: 'todo-a', text: 'Duplicate', done: false }),
      todos.insert({ id: 'todo-b', text: 'Broken', done: 'no' } as unknown as Todo),
      todos.update('todo-a', { done: 'yes' } as unknown as Partial<Todo>),
      todos.update('todo-missing', { done: true }),
      todos.delete('todo-missing')
    ]);

    expect(result.applied).toBe(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'duplicate_key',
      'invalid_row',
      'invalid_row',
      'invalid_row',
      'invalid_row'
    ]);
    expect(data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);
  });

  it('applies object writes atomically when requested', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    };

    const failed = applyWritesAtomic(data, [
      todos.update('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Broken', done: 'no' } as unknown as Todo)
    ]);

    expect(failed).toMatchObject({
      patches: 2,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos', field: 'done' }]
    });
    expect(failed.deltas).toEqual([]);
    expect(data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    const committed = applyWritesAtomic(data, [
      todos.update('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Water basil', done: false })
    ]);

    expect(committed).toMatchObject({ patches: 2, applied: 2, committed: true, diagnostics: [] });
    expect(committed.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', text: 'Buy oat milk', done: true },
          { id: 'todo-b', text: 'Water basil', done: false }
        ],
        removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
      }
    ]);
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
  });

  it('accepts object or tuple keys for composite-key rows', () => {
    const presence = write(schema.presence);
    const data: MutableObjectSourceData = {};

    const result = applyWrites(data, [
      presence.insert({
        workspaceId: 'workspace-a',
        peerId: 'peer-a',
        clientId: 'client-a',
        targetTodoId: 'todo-a'
      }),
      presence.update(
        {
          workspaceId: 'workspace-a',
          peerId: 'peer-a',
          clientId: 'client-a'
        },
        { clientId: 'client-b', targetTodoId: 'todo-b' }
      ),
      presence.insert({
        workspaceId: 'workspace-a',
        peerId: 'peer-a',
        clientId: 'client-b'
      }),
      presence.delete({
        workspaceId: 'workspace-a',
        peerId: 'peer-a'
      }),
      presence.delete(['workspace-a', 'peer-a', 'client-b'])
    ]);

    expect(result.patches).toBe(5);
    expect(result.applied).toBe(3);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duplicate_key', 'invalid_row']);
    expect(result.diagnostics[0]?.key).toBe('["workspace-a","peer-a","client-b"]');
    expect(data.presence).toEqual([]);
  });

  it('keeps single-field primitive key indexes current across key changes', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.update('todo-a', { id: 'todo-c', text: 'Buy soy milk' }),
      todos.update('todo-c', { done: true }),
      todos.delete('todo-a'),
      todos.update('todo-b', { id: 'todo-c' })
    ]);

    expect(result.patches).toBe(4);
    expect(result.applied).toBe(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['invalid_row', 'duplicate_key']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.key)).toEqual(['["todo-a"]', '["todo-c"]']);
    expect(data.todos).toEqual([
      { id: 'todo-c', text: 'Buy soy milk', done: true },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
  });

  it('validates optional and nullable fields without mutating invalid rows', () => {
    const maybeTodos = write(schema.maybeTodos);
    const data: MutableObjectSourceData = {
      maybeTodos: [{ id: 'maybe-a', archivedAt: null }]
    };

    const result = applyWrites(data, [
      maybeTodos.update('maybe-a', { label: 'Later', archivedAt: '2026-01-01' }),
      maybeTodos.insert({ id: 'maybe-b', archivedAt: null }),
      maybeTodos.insert({ id: 'maybe-c' } as unknown as MaybeTodo),
      maybeTodos.insert({ id: 'maybe-d', label: null, archivedAt: null } as unknown as MaybeTodo)
    ]);

    expect(result.patches).toBe(4);
    expect(result.applied).toBe(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['invalid_row', 'invalid_row']);
    expect(result.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(['archivedAt', 'label']);
    expect(data.maybeTodos).toEqual([
      { id: 'maybe-a', label: 'Later', archivedAt: '2026-01-01' },
      { id: 'maybe-b', archivedAt: null }
    ]);
  });

  it('validates JSON fields without mutating invalid rows', () => {
    const intents = write(schema.presenceIntents);
    const data: MutableObjectSourceData = {};

    const result = applyWrites(data, [
      intents.insert({
        id: 'intent-a',
        payload: [{ action: 'focus', path: ['piece-a'] }]
      }),
      intents.insert({
        id: 'intent-b',
        payload: { value: Number.NaN } as unknown as JsonValue
      }),
      intents.insert({
        id: 'intent-c',
        payload: () => 'not-json'
      } as unknown as PresenceIntent)
    ]);

    expect(result.patches).toBe(3);
    expect(result.applied).toBe(1);
    expect(result.diagnostics).toMatchObject([
      { code: 'invalid_row', relation: 'presenceIntents', field: 'payload' },
      { code: 'invalid_row', relation: 'presenceIntents', field: 'payload' }
    ]);
    expect(data.presenceIntents).toEqual([
      {
        id: 'intent-a',
        payload: [{ action: 'focus', path: ['piece-a'] }]
      }
    ]);
  });
});
