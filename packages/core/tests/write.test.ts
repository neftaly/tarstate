import { describe, expect, expectTypeOf, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { as, from, pipe, project } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  nullable,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { fromObjectSource } from '@tarstate/core/source';
import {
  applyWrites,
  deleteRow,
  insert,
  update,
  upsert,
  write,
  type InsertPatch,
  type MutableObjectSourceData,
  type RelationRow,
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
    const standalone = update(schema.todos, 'todo-a', { done: true });
    const patches = [
      patch,
      standalone,
      upsert(schema.assignments, { todoId: 'todo-a', assignee: 'Mina' }),
      deleteRow(schema.todos, 'todo-b')
    ] satisfies readonly WritePatch[];

    expectTypeOf<RelationRow<typeof schema.todos>>().toEqualTypeOf<Todo>();
    expectTypeOf(patch).toEqualTypeOf<InsertPatch<typeof schema.todos>>();
    expectTypeOf(standalone).toEqualTypeOf<UpdatePatch<typeof schema.todos>>();
    expect(patches.map((item) => item.op)).toEqual(['insert', 'update', 'upsert', 'delete']);

    if (process.env.TARSTATE_TYPECHECK_ONLY === '1') {
      // @ts-expect-error insert rows must include required relation fields.
      todos.insert({ id: 'todo-b', done: false });
      // @ts-expect-error updates reject unknown relation fields.
      todos.update('todo-a', { complete: true });
      // @ts-expect-error upsert rows reject unknown relation fields.
      todos.upsert({ id: 'todo-c', text: 'Plan', done: false, extra: true });
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

    expect(result).toEqual({ patches: 5, applied: 5, diagnostics: [] });
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
});
