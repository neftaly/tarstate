import { describe, expect, it } from 'vitest';
import { createDb } from '@tarstate/core/db';
import { check, constrain, fk, req, unique } from '@tarstate/core/experimental/constraints';
import { as, eq, from, pipe, project } from '@tarstate/core/query';
import { UnsupportedChangeTrackingError, trackTransact } from '@tarstate/core/experimental/runtime';
import { defineSchema, idField, refField, relation, stringField } from '@tarstate/core/schema';
import { unwatch, watch } from '@tarstate/core/experimental/watch';

type Todo = {
  readonly id: string;
  readonly text: string;
};

type Assignment = {
  readonly todoId: string;
  readonly assignee: string;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField()
    }
  }),
  assignments: relation<Assignment>({
    key: 'todoId',
    fields: {
      todoId: refField('todos.id'),
      assignee: stringField()
    }
  })
});

const todo = as(schema.todos, 'todo');
const todoRows = pipe(
  from(todo),
  project({
    id: todo.id,
    text: todo.text
  })
);

describe('tarstate runtime surfaces', () => {
  it('builds constraint descriptors for validation and attachment', () => {
    const queryBoundConstraints = constrain(
      todoRows,
      req(todoRows, 'text'),
      unique(todoRows, 'id'),
      fk(todoRows, 'id', schema.todos, 'id')
    );
    const constraints = constrain(
      req(schema.todos, 'text'),
      unique(schema.todos, 'id'),
      fk(schema.assignments, 'todoId', schema.todos, 'id'),
      check(eq(todo.id, 'todo-a'), { name: 'todo-id-check' })
    );

    expect(constraints.constraints).toHaveLength(4);
    expect(queryBoundConstraints.query).toBe(todoRows);
    expect(queryBoundConstraints.constraints).toHaveLength(3);
  });

  it('returns manual watch handles and explicit unsupported change-tracking results', async () => {
    const db = createDb();
    const handle = watch(db, todoRows, () => undefined, { label: 'todos' });

    expect(handle).toMatchObject({
      kind: 'watch',
      db,
      target: todoRows,
      supported: true,
      mode: 'manual',
      label: 'todos',
      diagnostics: []
    });
    expect(unwatch(handle)).toMatchObject({ kind: 'unwatch', id: handle.id, closed: true, diagnostics: [] });
    expect(unwatch(handle)).toMatchObject({
      kind: 'unwatch',
      id: handle.id,
      closed: false,
      diagnostics: [{ code: 'watch_already_closed' }]
    });
    await expect(trackTransact({}, () => ({}))).resolves.toMatchObject({
      kind: 'trackTransact',
      db: {},
      supported: false,
      changes: [],
      diagnostics: [{ code: 'change_tracking_unsupported' }]
    });
    await expect(trackTransact({}, () => ({}), { throwOnUnsupported: true })).rejects.toThrow(
      UnsupportedChangeTrackingError
    );
  });
});
