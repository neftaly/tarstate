import { describe, expect, expectTypeOf, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { as, eq, from, pipe, project } from '@tarstate/core/query';
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
} from '@tarstate/core/experimental/write-apply';
import {
  deleteByKey,
  deleteExact,
  deleteWhere,
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  replaceAll,
  update,
  updateByKey,
  updateWhere,
  write,
  type DeleteWherePatch,
  type InsertIgnorePatch,
  type InsertOrMergePatch,
  type InsertOrUpdatePatch,
  type InsertOrReplacePatch,
  type InsertPatch,
  type RelationRow,
  type ReplaceAllPatch,
  type UpdateByKeyPatch,
  type UpdatePatch,
  type UpdateWherePatch,
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
    const standaloneInsert = insert(schema.todos, { id: 'todo-e', text: 'Charge lamp', done: false });
    const ignored = todos.insertIgnore({ id: 'todo-c', text: 'Plan route', done: false });
    const merged = insertOrMerge(schema.todos, { id: 'todo-a', done: true });
    const replaced = todos.insertOrReplace({ id: 'todo-a', text: 'Buy almond milk', done: true });
    const insertUpdated = todos.insertOrUpdate(
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { update: { done: true } }
    );
    const descriptorInsertUpdated = todos.insertOrUpdate(
      { id: 'todo-f', text: 'Sweep porch', done: false },
      { update: { done: true } }
    );
    const standalone = updateByKey(schema.todos, 'todo-a', { done: true });
    const predicateUpdate = update(schema.todos, eq(todo.done, false), { done: true });
    const standaloneWhere = updateWhere(schema.todos, eq(todo.done, false), { done: true });
    const scopedWhere = todos.updateWhere(eq(todo.text, 'Buy oat milk'), { done: true });
    const replacedAll = todos.replaceAll([{ id: 'todo-z', text: 'Reset list', done: false }]);
    const exactDelete = deleteExact(schema.todos, { id: 'todo-b', text: 'Water basil', done: false });
    const standaloneDeleteWhere = deleteWhere(schema.todos, eq(todo.done, true));
    const scopedDeleteWhere = todos.deleteWhere(eq(todo.text, 'Water basil'));
    const patches = [
      patch,
      standaloneInsert,
      ignored,
      merged,
      replaced,
      insertUpdated,
      descriptorInsertUpdated,
      standalone,
      predicateUpdate,
      standaloneWhere,
      scopedWhere,
      insertIgnore(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      insertOrMerge(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      insertOrMerge(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      insertOrUpdate(
        schema.assignments,
        { todoId: 'todo-a', assignee: 'Mina' },
        { update: { assignee: 'Rafi' } }
      ),
      insertOrUpdate(
        schema.assignments,
        { todoId: 'todo-b', assignee: 'Mina' },
        { update: { assignee: 'Rafi' } }
      ),
      replaceAll(schema.assignments, [{ todoId: 'todo-a', assignee: 'Mina' }]),
      replacedAll,
      exactDelete,
      standaloneDeleteWhere,
      scopedDeleteWhere,
      deleteByKey(schema.todos, 'todo-a'),
      deleteByKey(schema.todos, 'todo-b')
    ] satisfies readonly WritePatch[];

    expectTypeOf<RelationRow<typeof schema.todos>>().toEqualTypeOf<Todo>();
    expectTypeOf(patch).toEqualTypeOf<InsertPatch<typeof schema.todos>>();
    expectTypeOf(standaloneInsert).toEqualTypeOf<InsertPatch<typeof schema.todos>>();
    expectTypeOf(ignored).toEqualTypeOf<InsertIgnorePatch<typeof schema.todos>>();
    expectTypeOf(merged).toEqualTypeOf<InsertOrMergePatch<typeof schema.todos>>();
    expectTypeOf(replaced).toEqualTypeOf<InsertOrReplacePatch<typeof schema.todos>>();
    expectTypeOf(insertUpdated).toEqualTypeOf<InsertOrUpdatePatch<typeof schema.todos>>();
    expectTypeOf(descriptorInsertUpdated).toEqualTypeOf<InsertOrUpdatePatch<typeof schema.todos>>();
    expectTypeOf(replacedAll).toEqualTypeOf<ReplaceAllPatch<typeof schema.todos>>();
    expectTypeOf(standalone).toEqualTypeOf<UpdateByKeyPatch<typeof schema.todos>>();
    expectTypeOf(predicateUpdate).toEqualTypeOf<UpdatePatch<typeof schema.todos>>();
    expectTypeOf(standaloneWhere).toEqualTypeOf<UpdateWherePatch<typeof schema.todos>>();
    expectTypeOf(scopedWhere).toEqualTypeOf<UpdateWherePatch<typeof schema.todos>>();
    expectTypeOf(standaloneDeleteWhere).toEqualTypeOf<DeleteWherePatch<typeof schema.todos>>();
    expectTypeOf(scopedDeleteWhere).toEqualTypeOf<DeleteWherePatch<typeof schema.todos>>();
    expect(ignored.op).toBe('insertIgnore');
    expect(merged.op).toBe('insertOrMerge');
    expect(replaced.op).toBe('insertOrReplace');
    expect(insertUpdated).toEqual({
      op: 'insertOrUpdate',
      relation: schema.todos,
      row: { id: 'todo-a', text: 'Buy oat milk', done: false },
      update: { done: true }
    });
    expect(descriptorInsertUpdated).toEqual({
      op: 'insertOrUpdate',
      relation: schema.todos,
      row: { id: 'todo-f', text: 'Sweep porch', done: false },
      update: { done: true }
    });
    expect(standaloneWhere).toEqual({
      op: 'update',
      relation: schema.todos,
      predicate: eq(todo.done, false),
      changes: { done: true }
    });
    expect(standaloneDeleteWhere).toEqual({
      op: 'delete',
      relation: schema.todos,
      predicate: eq(todo.done, true)
    });
    expect(patches.map((item) => item.op)).toEqual([
      'insert',
      'insert',
      'insertIgnore',
      'insertOrMerge',
      'insertOrReplace',
      'insertOrUpdate',
      'insertOrUpdate',
      'updateByKey',
      'update',
      'update',
      'update',
      'insertIgnore',
      'insertOrMerge',
      'insertOrMerge',
      'insertOrUpdate',
      'insertOrUpdate',
      'replaceAll',
      'replaceAll',
      'deleteExact',
      'delete',
      'delete',
      'deleteByKey',
      'deleteByKey'
    ]);

    if (process.env.TARSTATE_TYPECHECK_ONLY === '1') {
      // @ts-expect-error insert rows must include required relation fields.
      todos.insert({ id: 'todo-b', done: false });
      // @ts-expect-error insert-ignore rows must include required relation fields.
      todos.insertIgnore({ id: 'todo-b', done: false });
      // @ts-expect-error updates reject unknown relation fields.
      todos.updateByKey('todo-a', { complete: true });
      // @ts-expect-error insert-or-merge rows reject unknown relation fields.
      todos.insertOrMerge({ id: 'todo-c', complete: true });
      // @ts-expect-error insert-or-replace rows must include required relation fields.
      todos.insertOrReplace({ id: 'todo-c', done: false });
      // @ts-expect-error insert-or-replace rows reject unknown relation fields.
      todos.insertOrReplace({ id: 'todo-c', text: 'Plan', done: false, complete: true });
      // @ts-expect-error insert-or-update requires an explicit update descriptor.
      todos.insertOrUpdate({ id: 'todo-c', text: 'Plan', done: false });
      // @ts-expect-error insert-or-update descriptor rows reject unknown relation fields.
      todos.insertOrUpdate({ id: 'todo-c', text: 'Plan', done: false, complete: true }, { update: { done: true } });
      // @ts-expect-error insert-or-update descriptor rows must include required relation fields.
      todos.insertOrUpdate({ id: 'todo-c', done: false }, { update: { done: true } });
      // @ts-expect-error insert-or-update descriptor updates reject unknown relation fields.
      todos.insertOrUpdate({ id: 'todo-c', text: 'Plan', done: false }, { update: { complete: true } });
      // @ts-expect-error update-where changes reject unknown relation fields.
      todos.updateWhere(eq(todo.done, false), { complete: true });
      // @ts-expect-error delete-exact rows must include required relation fields.
      todos.deleteExact({ id: 'todo-c' });
      // @ts-expect-error replace-all rows must include required relation fields.
      todos.replaceAll([{ id: 'todo-c', done: false }]);
    }
  });

  it('applies insert, update, insert-or-update, and delete patches in order', async () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.updateByKey('todo-a', { done: true }),
      todos.insertOrUpdate(
        { id: 'todo-c', text: 'Review notes', done: false },
        { update: { text: 'Review notes', done: false } }
      ),
      todos.insertOrUpdate(
        { id: 'todo-b', text: 'Water herbs', done: true },
        { update: { text: 'Water herbs', done: true } }
      ),
      todos.deleteByKey('todo-c'),
      insert(schema.todos, { id: 'todo-d', text: 'Send update', done: false })
    ]);

    expect(result).toMatchObject({ patches: 5, applied: 5, diagnostics: [] });
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

  it('supports Relic-style insert-ignore, insert-or-merge/update/replace, and delete-exact APIs', () => {
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
      todos.insertOrUpdate(
        { id: 'todo-a', text: 'Ignored insert row', done: false },
        { update: { text: 'Buy almond milk' } }
      ),
      insertOrUpdate(
        schema.todos,
        { id: 'todo-d', text: 'Draft update', done: false },
        { update: { done: true } }
      ),
      todos.insertOrUpdate(
        { id: 'todo-b', text: 'Water herbs', done: true },
        { update: { text: 'Water herbs', done: true } }
      ),
      todos.deleteExact({ id: 'todo-c', text: 'Review notes', done: false })
    ]);

    expect(result).toMatchObject({ patches: 7, applied: 7, diagnostics: [] });
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy almond milk', done: true },
      { id: 'todo-b', text: 'Water herbs', done: true },
      { id: 'todo-d', text: 'Draft update', done: false }
    ]);
  });

  it('applies insert-or-replace as full-row replacement on key conflict', () => {
    const maybeTodos = write(schema.maybeTodos);
    const data: MutableObjectSourceData = {
      maybeTodos: [
        { id: 'todo-a', label: 'Old label', archivedAt: null }
      ]
    };

    const result = applyWrites(data, [
      maybeTodos.insertOrReplace({ id: 'todo-a', archivedAt: null }),
      insertOrReplace(schema.maybeTodos, { id: 'todo-b', label: 'New label', archivedAt: null })
    ]);

    expect(result).toMatchObject({ patches: 2, applied: 2, diagnostics: [] });
    expect(data.maybeTodos).toEqual([
      { id: 'todo-a', archivedAt: null },
      { id: 'todo-b', label: 'New label', archivedAt: null }
    ]);
  });

  it('applies insert-or-update descriptors by inserting the row or updating existing rows', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false }
      ]
    };

    const result = applyWrites(data, [
      todos.insertOrUpdate(
        { id: 'todo-a', text: 'Ignored insert row', done: false },
        { update: { done: true } }
      ),
      insertOrUpdate(
        schema.todos,
        { id: 'todo-b', text: 'Review notes', done: false },
        { update: { done: true } }
      )
    ]);

    expect(result).toMatchObject({ patches: 2, applied: 2, diagnostics: [] });
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-b', text: 'Review notes', done: false }
    ]);
  });

  it('reports predicate write patches as unsupported for object-backed apply', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false },
        { id: 'todo-b', text: 'Water basil', done: true }
      ]
    };

    const result = applyWrites(data, [
      todos.updateWhere(eq(todo.done, false), { done: true }),
      deleteWhere(schema.todos, eq(todo.done, true))
    ]);

    expect(result).toMatchObject({
      patches: 2,
      applied: 0,
      diagnostics: [
        {
          code: 'unsupported_expression',
          relation: 'todos'
        },
        {
          code: 'unsupported_expression',
          relation: 'todos'
        }
      ]
    });
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false },
      { id: 'todo-b', text: 'Water basil', done: true }
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
      todos.deleteByKey('todo-b')
    ]);

    expect(result).toMatchObject({
      patches: 2,
      applied: 1,
      diagnostics: [
        {
          code: 'invalid_row',
          relation: 'todos'
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
      todos.updateByKey('todo-c', { done: true }),
      todos.deleteByKey('todo-b')
    ]);

    expect(result).toMatchObject({ patches: 3, applied: 3, diagnostics: [] });
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
    const updateResult = applyWrites(updateData, [
      todos.insertOrUpdate(
        { id: 'todo-a', done: true } as unknown as Todo,
        { update: { done: true } }
      )
    ]);

    expect(mergeResult.applied).toBe(0);
    expect(mergeResult.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        relation: 'todos',
        field: 'text'
      }
    ]);
    expect(data.todos).toEqual([]);
    expect(updateResult).toMatchObject({
      applied: 0,
      diagnostics: [{ code: 'invalid_row', relation: 'todos', field: 'text' }]
    });
    expect(updateData.todos).toBeUndefined();
  });

  it('reports validation diagnostics and skips invalid mutations', () => {
    const todos = write(schema.todos);
    const data: MutableObjectSourceData = {
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    };

    const result = applyWrites(data, [
      todos.insert({ id: 'todo-a', text: 'Duplicate', done: false }),
      todos.insert({ id: 'todo-b', text: 'Broken', done: 'no' } as unknown as Todo),
      todos.updateByKey('todo-a', { done: 'yes' } as unknown as Partial<Todo>),
      todos.updateByKey('todo-missing', { done: true }),
      todos.deleteByKey('todo-missing')
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
      todos.updateByKey('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Broken', done: 'no' } as unknown as Todo)
    ]);

    expect(failed).toMatchObject({
      patches: 2,
      applied: 0,
      committed: false,
      diagnostics: [{ code: 'invalid_row', relation: 'todos', field: 'done' }]
    });
    expect(data.todos).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    const committed = applyWritesAtomic(data, [
      todos.updateByKey('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Water basil', done: false })
    ]);

    expect(committed).toMatchObject({ patches: 2, applied: 2, committed: true, diagnostics: [] });
    expect(data.todos).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
  });

  it('accepts tuple keys for composite-key rows', () => {
    const presence = write(schema.presence);
    const data: MutableObjectSourceData = {};

    const result = applyWrites(data, [
      presence.insert({
        workspaceId: 'workspace-a',
        peerId: 'peer-a',
        clientId: 'client-a',
        targetTodoId: 'todo-a'
      }),
      presence.updateByKey(
        ['workspace-a', 'peer-a', 'client-a'],
        { clientId: 'client-b', targetTodoId: 'todo-b' }
      ),
      presence.insert({
        workspaceId: 'workspace-a',
        peerId: 'peer-a',
        clientId: 'client-b'
      }),
      presence.deleteByKey(['workspace-a', 'peer-a']),
      presence.deleteByKey(['workspace-a', 'peer-a', 'client-b'])
    ]);

    expect(result.patches).toBe(5);
    expect(result.applied).toBe(3);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['duplicate_key', 'invalid_row']);
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
      todos.updateByKey('todo-a', { id: 'todo-c', text: 'Buy soy milk' }),
      todos.updateByKey('todo-c', { done: true }),
      todos.deleteByKey('todo-a'),
      todos.updateByKey('todo-b', { id: 'todo-c' })
    ]);

    expect(result.patches).toBe(4);
    expect(result.applied).toBe(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['invalid_row', 'duplicate_key']);
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
      maybeTodos.updateByKey('maybe-a', { label: 'Later', archivedAt: '2026-01-01' }),
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
