import { describe, expect, it } from 'vitest';
import {
  attachConstraints,
  attachedConstraintsFor,
  check,
  constrain,
  constraintAttachmentsFor,
  detachConstraints,
  fk,
  hasAttachedConstraints,
  req,
  tryTransactConstrained,
  unique,
  validateAttachedConstraints,
  validateConstraints
} from '@tarstate/core/constraints';
import { createDb } from '@tarstate/core/db';
import { as, call, eq, from } from '@tarstate/core/query';
import { defineSchema, idField, refField, relation, stringField } from '@tarstate/core/schema';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import { write } from '@tarstate/core/write';

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
const todos = write(schema.todos);

describe('tarstate constraint validation', () => {
  it('validates required, unique, and foreign-key descriptors by scanning a source', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [
          { id: 'todo-a', text: 'Buy oat milk' },
          { id: 'todo-b', text: 'Water basil' }
        ],
        assignments: [{ todoId: 'todo-a', assignee: 'Mina' }]
      }),
      [req(schema.todos, 'text'), unique(schema.todos, 'id'), fk(schema.assignments, 'todoId', schema.todos, 'id')]
    );

    expect(result).toEqual({
      kind: 'constraintValidation',
      valid: true,
      diagnostics: []
    });
  });

  it('reuses relation scans across constraints in one validation pass', async () => {
    const rowsByRelation: Record<string, readonly unknown[]> = {
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ],
      assignments: [{ todoId: 'todo-a', assignee: 'Mina' }]
    };
    const calls = new Map<string, number>();
    const source: RelationSource = {
      rows: (relationRef) => {
        calls.set(relationRef.name, (calls.get(relationRef.name) ?? 0) + 1);
        return rowsByRelation[relationRef.name] ?? [];
      }
    };

    const result = await validateConstraints(source, [
      req(schema.todos, 'text'),
      unique(schema.todos, 'id'),
      fk(schema.assignments, 'todoId', schema.todos, 'id')
    ]);

    expect(result.valid).toBe(true);
    expect(calls).toEqual(new Map([
      ['todos', 1],
      ['assignments', 1]
    ]));
  });

  it('reports actionable diagnostics for required, unique, and foreign-key violations', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [
          { id: 'todo-a', text: 'Buy oat milk' },
          { id: 'todo-b' },
          { id: 'todo-c', text: 'Review notes' },
          { id: 'todo-c', text: 'Duplicate' }
        ],
        assignments: [{ todoId: 'todo-missing', assignee: 'Mina' }]
      }),
      constrain(
        req(schema.todos, 'text'),
        unique(schema.todos, 'id'),
        fk(schema.assignments, 'todoId', schema.todos, 'id')
      )
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        relation: 'todos',
        field: 'text'
      },
      {
        code: 'duplicate_key',
        relation: 'todos',
        field: 'id',
        key: '["todo-c"]'
      },
      {
        code: 'missing_ref',
        relation: 'assignments',
        field: 'todoId',
        key: '["todo-missing"]'
      }
    ]);
  });

  it('skips null or undefined optional foreign keys', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [{ id: 'todo-a', text: 'Buy oat milk' }],
        assignments: [
          { assignee: 'Unassigned' },
          { todoId: null, assignee: 'Later' },
          { todoId: 'todo-a', assignee: 'Mina' }
        ]
      }),
      [fk(schema.assignments, 'todoId', schema.todos, 'id', { optional: true })]
    );

    expect(result).toEqual({
      kind: 'constraintValidation',
      valid: true,
      diagnostics: []
    });
  });

  it('validates query-bound check constraints', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [
          { id: 'todo-a', text: 'Buy oat milk' },
          { id: 'todo-b', text: 'Water basil' }
        ]
      }),
      constrain(check(from(todo), eq(todo.id, 'todo-a'), { name: 'only-todo-a' }))
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        message: 'check constraint failed',
        detail: {
          op: 'check',
          name: 'only-todo-a',
          row: {
            todo: { id: 'todo-b', text: 'Water basil' }
          }
        }
      }
    ]);
  });

  it('passes query-bound check constraints when every row matches', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
      }),
      constrain(check(from(todo), eq(todo.id, 'todo-a')))
    );

    expect(result).toEqual({
      kind: 'constraintValidation',
      valid: true,
      diagnostics: []
    });
  });

  it('passes evaluator options through query-bound check validation', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
      }),
      constrain(check(from(todo), eq(call('slug', todo.text), 'buy-oat-milk'))),
      {
        functions: {
          slug: (value) => typeof value === 'string' ? value.toLowerCase().replaceAll(' ', '-') : undefined
        }
      }
    );

    expect(result).toEqual({
      kind: 'constraintValidation',
      valid: true,
      diagnostics: []
    });
  });


  it('returns an explicit diagnostic for unsupported check validation', async () => {
    const result = await validateConstraints(
      fromObjectSource({
        todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
      }),
      constrain(check(eq(todo.id, 'todo-a'), { name: 'todo-id-check' }))
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'unsupported_lookup',
        message: 'check constraints cannot be validated until checks carry relation metadata or a relation-bound query',
        detail: {
          op: 'check',
          name: 'todo-id-check'
        }
      }
    ]);
  });

  it('attaches constraints to DB lifecycle objects for later validation', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-a', text: 'Duplicate' }
      ]
    });
    const constraints = constrain(req(schema.todos, 'text'), unique(schema.todos, 'id'));

    expect(attachConstraints(db, constraints)).toBe(db);
    expect(hasAttachedConstraints(db)).toBe(true);
    expect(attachedConstraintsFor(db)).toEqual(constraints.constraints);
    expect(constraintAttachmentsFor(db)).toMatchObject([
      {
        kind: 'constraintAttachment',
        constraints: constraints.constraints
      }
    ]);

    await expect(validateAttachedConstraints(db)).resolves.toMatchObject({
      valid: false,
      diagnostics: [{ code: 'duplicate_key', relation: 'todos', field: 'id' }]
    });

    expect(detachConstraints(db)).toBe(db);
    expect(hasAttachedConstraints(db)).toBe(false);
  });

  it('uses attached constraints when explicitly running constrained object-backed transactions', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    attachConstraints(db, constrain(unique(schema.todos, 'text')));

    await expect(tryTransactConstrained(db, [
      todos.insert({ id: 'todo-b', text: 'Buy oat milk' })
    ])).resolves.toMatchObject({
      db,
      committed: false,
      applied: 0,
      diagnostics: [{ code: 'duplicate_key', relation: 'todos', field: 'text' }]
    });
  });
});
