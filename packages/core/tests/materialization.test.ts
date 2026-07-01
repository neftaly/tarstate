import { describe, expect, expectTypeOf, it } from 'vitest';
import { constrain, hasAttachedConstraints, req, unique } from '@tarstate/core/experimental/constraints';
import { createDb } from '@tarstate/core/db';
import {
  demat,
  index,
  isMaterialized,
  mat,
  materializationForQuery,
  materializationsFor,
  materializedRowsFor,
  materializedRowsForQuery,
  readMaterializedQuery,
  type MaterializationBtreeIndexResult,
  type MaterializationUniqueIndexResult
} from '@tarstate/core/experimental/materialization';
import { as, from, keyBy, pipe, project } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';

type Todo = {
  readonly id: string;
  readonly text: string;
};

type TodoRow = {
  readonly id: string;
  readonly text: string;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField()
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

describe('tarstate materialization', () => {
  it('materializes snapshot rows and metadata through mat', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ]
    });

    await expect(mat(db, todoRows, { id: 'todos-view', name: 'Todos' })).resolves.toBe(db);

    expect(isMaterialized(db)).toBe(true);
    expect(materializedRowsFor<TodoRow>(db, 'todos-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);
    expect(materializedRowsForQuery<TodoRow>(db, todoRows)).toBe(materializedRowsFor<TodoRow>(db, 'todos-view'));
    expect(materializationForQuery(db, todoRows)).toBeDefined();
    expect(materializationsFor(db)).toHaveLength(1);
  });

  it('clears materialized rows, metadata, and attached constraints through demat', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const constraints = constrain(req(schema.todos, 'text'), unique(schema.todos, 'id'));

    await mat(db, todoRows, { id: 'todos-view' });
    await mat(db, constraints);

    expect(isMaterialized(db)).toBe(true);
    expect(hasAttachedConstraints(db)).toBe(true);

    expect(demat(db, 'todos-view')).toBe(db);
    expect(materializedRowsFor(db, 'todos-view')).toBeUndefined();
    expect(materializationForQuery(db, todoRows)).toBeUndefined();
    expect(isMaterialized(db)).toBe(true);

    expect(demat(db)).toBe(db);
    expect(materializationsFor(db)).toHaveLength(0);
    expect(hasAttachedConstraints(db)).toBe(false);
    expect(isMaterialized(db)).toBe(false);
  });

  it('reads materialized query result envelopes without evaluating rows', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ]
    });
    const keyedTodoRows = keyBy('id')(todoRows);

    await mat(db, todoRows, { id: 'todos-view' });

    const hit = await readMaterializedQuery<TodoRow>(db, todoRows);
    expect(hit).toMatchObject({
      materialized: true,
      rows: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ]
    });
    expect(hit.rows).toBe(materializedRowsFor<TodoRow>(db, 'todos-view'));

    const structuralMiss = await readMaterializedQuery<TodoRow>(db, keyedTodoRows);
    expect(structuralMiss).toMatchObject({
      materialized: false,
      rows: []
    });
    expect(structuralMiss.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_missing' })])
    );
    expect(structuralMiss).not.toHaveProperty('id');
  });

  it('returns miss and stale envelopes from readMaterializedQuery', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const missing = await readMaterializedQuery<TodoRow>(db, todoRows);

    expect(missing).toMatchObject({
      materialized: false,
      rows: []
    });
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_missing' })])
    );
    expect(missing).not.toHaveProperty('id');

    const rows: readonly Todo[] = [{ id: 'todo-a', text: 'Buy oat milk' }];
    let version = 'v1';
    const versionedSource: RelationSource = {
      rows: (relationRef) => relationRef.name === 'todos' ? rows : [],
      version: () => version
    };

    await mat(versionedSource, todoRows, { id: 'todos-source-view' });
    version = 'v2';

    await expect(readMaterializedQuery<TodoRow>(versionedSource, todoRows)).resolves.toMatchObject({
      materialized: false,
      rows: []
    });
    const stale = await readMaterializedQuery<TodoRow>(versionedSource, todoRows);
    expect(stale.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_stale' })])
    );
  });

  it('returns set and hash index result shapes from materialized rows', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Same label' },
        { id: 'todo-b', text: 'Same label' },
        { id: 'todo-c', text: 'Unique label' }
      ]
    });

    await mat(db, todoRows, { id: 'todos-view' });

    const setResult = index<TodoRow>(db, 'todos-view');
    expect(setResult).toMatchObject({
      kind: 'materializationIndex',
      id: 'todos-view',
      indexed: true,
      diagnostics: [],
      index: { kind: 'set' }
    });
    expect(Array.from(setResult.index?.rows ?? [])).toEqual([
      { id: 'todo-a', text: 'Same label' },
      { id: 'todo-b', text: 'Same label' },
      { id: 'todo-c', text: 'Unique label' }
    ]);

    const hashResult = index<TodoRow>(db, 'todos-view', { kind: 'hash', field: 'text' });
    expect(hashResult).toMatchObject({
      kind: 'materializationHashIndex',
      id: 'todos-view',
      indexed: true,
      diagnostics: [],
      index: { kind: 'hash', field: 'text' }
    });
    expect(hashResult.index?.lookup.get('Same label')).toEqual([
      { id: 'todo-a', text: 'Same label' },
      { id: 'todo-b', text: 'Same label' }
    ]);
    expect(hashResult.index?.lookup.get('Unique label')).toEqual([
      { id: 'todo-c', text: 'Unique label' }
    ]);
    expect(hashResult.index?.lookup.get('Missing label')).toBeUndefined();
  });

  it('returns explicit unsupported facade results for btree and unique index requests', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await mat(db, todoRows, { id: 'todos-view' });

    const btreeResult = index<TodoRow>(db, 'todos-view', { kind: 'btree', field: 'text' });
    expectTypeOf(btreeResult).toEqualTypeOf<MaterializationBtreeIndexResult<TodoRow, string>>();
    expect(btreeResult).toMatchObject({
      indexed: false
    });
    expect(btreeResult.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_index_unsupported' })])
    );
    expect(btreeResult).not.toHaveProperty('index');

    const uniqueResult = index<TodoRow>(db, 'todos-view', { kind: 'unique', field: 'id' });
    expectTypeOf(uniqueResult).toEqualTypeOf<MaterializationUniqueIndexResult<TodoRow, string>>();
    expect(uniqueResult).toMatchObject({
      indexed: false
    });
    expect(uniqueResult.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_index_unsupported' })])
    );
    expect(uniqueResult).not.toHaveProperty('index');
  });

  it('returns explicit diagnostics for missing materialization indexes', () => {
    const db = createDb();

    expect(index<TodoRow>(db, 'missing-view')).toMatchObject({
      indexed: false
    });
    expect(index<TodoRow>(db, 'missing-view').diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_missing' })])
    );
    expect(index<TodoRow>(db, 'missing-view', { kind: 'hash', field: 'id' })).toMatchObject({
      indexed: false
    });
    expect(index<TodoRow>(db, 'missing-view', { kind: 'hash', field: 'id' }).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_missing' })])
    );
    expect(index<TodoRow>(db, todoRows)).toMatchObject({
      indexed: false
    });
    expect(index<TodoRow>(db, todoRows).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'materialization_missing' })])
    );
  });
});
