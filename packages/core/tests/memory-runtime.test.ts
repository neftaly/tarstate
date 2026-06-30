import { describe, expect, it } from 'vitest';
import {
  composeRelationRuntimes,
  createMemoryRelationRuntime,
  tryApplyRelationPatches
} from '@tarstate/core';
import { booleanField, defineSchema, idField, numberField, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';

type Todo = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly rank: number;
};

type Presence = {
  readonly id: string;
  readonly targetTodoId: string;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      done: booleanField(),
      rank: numberField()
    }
  }),
  presence: relation<Presence>({
    ephemeral: true,
    key: 'id',
    fields: {
      id: idField('presence'),
      targetTodoId: idField('todo')
    }
  })
});

const todos = write(schema.todos);
const presence = write(schema.presence);

describe('memory relation runtime', () => {
  it('exposes object rows, equality lookups, range lookups, diagnostics, and version', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 },
        { id: 'todo-b', text: 'Water basil', done: true, rank: 5 }
      ]
    });

    expect(runtime.source.relationNames).toEqual(['todos']);
    expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 },
      { id: 'todo-b', text: 'Water basil', done: true, rank: 5 }
    ]);
    expect(Array.from(await runtime.source.lookup?.({
      relation: schema.todos,
      field: 'id',
      value: 'todo-b'
    }) ?? [])).toEqual([{ id: 'todo-b', text: 'Water basil', done: true, rank: 5 }]);
    expect(Array.from(await runtime.source.rangeLookup?.({
      relation: schema.todos,
      field: 'rank',
      lower: { value: 2, inclusive: false },
      upper: { value: 6, inclusive: true }
    }) ?? [])).toEqual([{ id: 'todo-b', text: 'Water basil', done: true, rank: 5 }]);
    expect(await runtime.source.rangeLookup?.({
      relation: schema.todos,
      field: 'done',
      lower: { value: false, inclusive: true }
    })).toBeUndefined();
    expect(Array.from(await runtime.source.diagnostics?.() ?? [])).toEqual([]);
    expect(await runtime.source.version?.()).toBe(0);
  });

  it('applies writes atomically, reports memory durability, emits deltas, and changes version', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }]
    });
    const notifications: number[] = [];
    const unsubscribe = runtime.subscribe?.(() => {
      notifications.push(1);
    });

    const result = await runtime.target?.apply([
      todos.update('todo-a', { done: true }),
      todos.insert({ id: 'todo-b', text: 'Water basil', done: false, rank: 5 })
    ]);

    expect(result).toEqual({
      status: 'accepted',
      accepted: true,
      patches: 2,
      applied: 2,
      deltas: [
        {
          relation: schema.todos,
          added: [
            { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 2 },
            { id: 'todo-b', text: 'Water basil', done: false, rank: 5 }
          ],
          removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }]
        }
      ],
      diagnostics: [],
      durability: 'memory',
      version: 1
    });
    expect(await runtime.source.version?.()).toBe(1);
    expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 2 },
      { id: 'todo-b', text: 'Water basil', done: false, rank: 5 }
    ]);
    expect(notifications).toEqual([1]);

    unsubscribe?.();
  });

  it('does not change version or notify subscribers for accepted no-op writes', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }]
    });
    let notifications = 0;
    const unsubscribe = runtime.subscribe?.(() => {
      notifications += 1;
    });

    const result = await runtime.target?.apply([
      todos.insertIgnore({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 })
    ]);

    expect(result).toMatchObject({
      status: 'accepted',
      accepted: true,
      patches: 1,
      applied: 1,
      deltas: [],
      durability: 'memory',
      version: 0
    });
    expect(await runtime.source.version?.()).toBe(0);
    expect(notifications).toBe(0);

    unsubscribe?.();
  });

  it('returns version-consistent snapshots independent of later writes', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }]
    });
    const snapshot = runtime.snapshot?.();

    await runtime.target?.apply([todos.update('todo-a', { done: true })]);

    expect(snapshot?.version).toBe(0);
    expect(await snapshot?.source.version?.()).toBe(0);
    expect(Array.from(await snapshot?.source.rows(schema.todos) ?? [])).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }
    ]);
    expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 2 }
    ]);
  });

  it('rejects invalid writes with useful diagnostics and leaves rows and version unchanged', async () => {
    const runtime = createMemoryRelationRuntime({
      todos: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }]
    });

    const result = await runtime.target?.apply([
      todos.update('todo-a', { done: true }),
      todos.delete('todo-missing')
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      accepted: false,
      patches: 2,
      applied: 0,
      deltas: [],
      durability: 'memory',
      version: 0,
      diagnostics: [{ code: 'invalid_row', relation: 'todos', key: '["todo-missing"]' }]
    });
    expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }
    ]);
    expect(await runtime.source.version?.()).toBe(0);
  });

  it('rejects writes for relations outside known memory source ownership', async () => {
    const runtime = createMemoryRelationRuntime({ todos: [] });

    const result = await runtime.target?.apply([
      presence.insert({ id: 'peer-a', targetTodoId: 'todo-a' })
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      accepted: false,
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        {
          code: 'source_error',
          relation: 'presence',
          message: 'memory runtime does not own relation presence'
        }
      ],
      durability: 'memory',
      version: 0
    });
    expect(runtime.source.relationNames).toEqual(['todos']);
    expect(await runtime.source.version?.()).toBe(0);
  });

  it('can start dynamic when no relation ownership is declared', async () => {
    const runtime = createMemoryRelationRuntime();

    const result = await runtime.target?.apply([
      todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 })
    ]);

    expect(result).toMatchObject({
      status: 'accepted',
      accepted: true,
      patches: 1,
      applied: 1,
      durability: 'memory',
      version: 1
    });
    expect(runtime.source.relationNames).toBeUndefined();
    expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }
    ]);
  });

  it('routes composed runtime writes by relation ownership', async () => {
    const todoRuntime = createMemoryRelationRuntime({ todos: [] });
    const presenceRuntime = createMemoryRelationRuntime({ presence: [] });
    const runtime = composeRelationRuntimes(todoRuntime, presenceRuntime);

    const result = await tryApplyRelationPatches(runtime, [
      todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }),
      presence.insert({ id: 'peer-a', targetTodoId: 'todo-a' })
    ]);

    expect(result).toMatchObject({
      status: 'accepted',
      accepted: true,
      patches: 2,
      applied: 2,
      diagnostics: [],
      version: [1, 1]
    });
    expect(Array.from(await todoRuntime.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 2 }
    ]);
    expect(Array.from(await presenceRuntime.source.rows(schema.presence))).toEqual([
      { id: 'peer-a', targetTodoId: 'todo-a' }
    ]);
  });
});
