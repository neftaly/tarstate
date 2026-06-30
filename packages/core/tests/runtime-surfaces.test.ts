import { describe, expect, it } from 'vitest';
import { check, constrain, fk, req, unique } from '@tarstate/core/constraints';
import { createDb } from '@tarstate/core/db';
import { demat, isMaterialized, mat, materializationsFor, materializedRowsFor } from '@tarstate/core/materialization';
import { as, eq, from, pipe, project } from '@tarstate/core/query';
import { UnsupportedChangeTrackingError, trackTransact } from '@tarstate/core/runtime';
import { defineSchema, idField, refField, relation, stringField } from '@tarstate/core/schema';
import { unwatch, watch } from '@tarstate/core/watch';

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
    const constraints = constrain(
      req(schema.todos, 'text'),
      unique(schema.todos, 'id'),
      fk(schema.assignments, 'todoId', schema.todos, 'id'),
      check(eq(todo.id, 'todo-a'), { name: 'todo-id-check' })
    );

    expect(constraints).toMatchObject({
      kind: 'constraintSet',
      constraints: [
        { kind: 'constraint', op: 'req', relation: schema.todos, field: 'text' },
        { kind: 'constraint', op: 'unique', relation: schema.todos, fields: ['id'] },
        {
          kind: 'constraint',
          op: 'fk',
          relation: schema.assignments,
          fields: ['todoId'],
          target: schema.todos,
          targetFields: ['id'],
          optional: false
        },
        { kind: 'constraint', op: 'check', name: 'todo-id-check' }
      ]
    });
  });

  it('materializes snapshot rows through mat', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const materialized = await mat(db, todoRows, { id: 'todos-view', mode: 'incremental' });

    expect(materialized).toBe(db);
    expect(isMaterialized(db)).toBe(true);
    expect(materializationsFor(db)).toMatchObject([
      {
        kind: 'materialization',
        id: 'todos-view',
        query: todoRows,
        requestedMode: 'incremental',
        maintenance: 'incremental',
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor(db, 'todos-view')).toEqual([{ id: 'todo-a', text: 'Buy oat milk' }]);

    expect(demat(db, 'todos-view')).toBe(db);
    expect(isMaterialized(db)).toBe(false);
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
