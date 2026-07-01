import * as Automerge from '@automerge/automerge';
import type { DocHandle, PeerId } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  composeRelationRuntimes,
  isRelationAdapter,
  isRelationRuntime,
  tryApplyRelationPatches,
  tryCommitAdapter
} from '@tarstate/core/adapter';
import { evaluate } from '@tarstate/core/evaluate';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { as, eq, from, join, pipe, project, where } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  numberField,
  optional,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource,
  type AutomergeMapAdapter,
  type AutomergeMapSource
} from '@tarstate/automerge';
import { automergePresenceRuntime } from '@tarstate/automerge/presence';

type TodoRow = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly rank: number;
};

type TodoDocument = {
  readonly todos: Record<string, TodoRow>;
};

type PresenceRow = {
  readonly peerId: string;
  readonly channel: string;
  readonly value?: JsonValue;
  readonly lastActiveAt?: number;
  readonly lastSeenAt?: number;
  readonly local?: boolean;
};

type NoteRow = {
  readonly id: string;
  readonly todoId: string;
  readonly body: string;
};

const schema = defineSchema({
  todos: relation<TodoRow>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      done: booleanField(),
      rank: numberField()
    }
  }),
  presence: relation<PresenceRow>({
    ephemeral: true,
    key: ['peerId', 'channel'],
    fields: {
      peerId: idField('peer'),
      channel: stringField(),
      value: optional(nullable(jsonField())),
      lastActiveAt: optional(numberField()),
      lastSeenAt: optional(numberField()),
      local: optional(booleanField())
    }
  }),
  notes: relation<NoteRow>({
    key: 'id',
    fields: {
      id: idField('note'),
      todoId: stringField(),
      body: stringField()
    }
  })
});

const todos = write(schema.todos);
const presenceRows = write(schema.presence);
const notes = write(schema.notes);
const todo = as(schema.todos, 'todo');
const presence = as(schema.presence, 'presence');
const note = as(schema.notes, 'note');
const todoRows = pipe(
  from(todo),
  project({
    id: todo.id,
    text: todo.text,
    done: todo.done,
    rank: todo.rank
  })
);
const focusedTodos = pipe(
  from(todo),
  join(
    pipe(
      from(presence),
      where(eq(presence.channel, 'targetTodoId'))
    ),
    eq(todo.id, presence.value)
  ),
  project({
    todoId: todo.id,
    text: todo.text,
    peerId: presence.peerId
  })
);
const focusedTodoNotes = pipe(
  from(todo),
  join(
    pipe(
      from(presence),
      where(eq(presence.channel, 'targetTodoId'))
    ),
    eq(todo.id, presence.value)
  ),
  join(from(note), eq(todo.id, note.todoId)),
  project({
    todoId: todo.id,
    text: todo.text,
    peerId: presence.peerId,
    note: note.body
  })
);
const todoRelations = [{ relation: schema.todos, path: ['todos'] }] as const;

describe('@tarstate/automerge', () => {
  it('exports the public package adapter surface', async () => {
    const api = await import('@tarstate/automerge');
    const presenceApi = await import('@tarstate/automerge/presence');
    const doc = Automerge.from<TodoDocument>({ todos: {} });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    expect(adapter.getDoc()).toBe(doc);
    expect('doc' in adapter).toBe(false);
    expect('createAutomergeMapAdapter' in api).toBe(false);
    expect('createAutomergeRelationAdapter' in api).toBe(false);
    expect('createAutomergeMapSource' in api).toBe(false);
    expect('createAutomergeRelationSource' in api).toBe(false);
    expect('createAutomergePresenceRuntime' in api).toBe(false);
    expect('automergePresenceRuntime' in api).toBe(false);
    expect('rowsFromAutomergeMapPath' in api).toBe(false);
    expect(automergeMapAdapter).toEqual(expect.any(Function));
    expect(automergeMapSource).toEqual(expect.any(Function));
    expect(presenceApi.automergePresenceRuntime).toBe(automergePresenceRuntime);
    expect(Array.from(await automergeMapSource(doc, { relations: todoRelations }).rows(schema.todos))).toEqual([]);
    expectTypeOf(automergeMapAdapter<TodoDocument>).returns.toMatchTypeOf<AutomergeMapAdapter<TodoDocument>>();
    expectTypeOf(automergeMapSource<TodoDocument>).returns.toMatchTypeOf<AutomergeMapSource>();
  });

  it('reads rows, lookups, range lookups, and exposes source versions', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const version = await adapter.source.version?.();
    const snapshot = adapter.snapshot();

    expect(isRelationAdapter(adapter)).toBe(true);
    expect(isRelationRuntime(adapter)).toBe(true);
    expect(adapter.source.relationNames).toEqual(['todos']);
    expect(adapter.target.relationNames).toEqual(['todos']);
    expect(adapter.target.ownsRelation?.('todos')).toBe(true);
    expect(adapter.target.ownsRelation?.('presence')).toBe(false);
    expect(adapter.snapshot).toEqual(expect.any(Function));
    expect(version).toBeDefined();
    expect(snapshot.version).toBeDefined();
    expect(await snapshot.source.version?.()).toBeDefined();
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
      { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
    ]);
    expect(await adapter.source.lookup?.({ relation: schema.todos, field: 'id', value: 'todo-b' })).toEqual([
      { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
    ]);
    expect(
      await adapter.source.rangeLookup?.({
        relation: schema.todos,
        field: 'rank',
        lower: { value: 2, inclusive: true },
        upper: { value: 3, inclusive: false }
      })
    ).toEqual([{ id: 'todo-b', text: 'Water basil', done: true, rank: 2 }]);
  });

  it('commits Tarstate write patches and exposes updated relation rows', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const result = await tryCommitAdapter(
      adapter,
      [
        todos.updateByKey('todo-a', { done: true }),
        todos.insert({ id: 'todo-b', text: 'Water basil', done: false, rank: 2 })
      ],
      { readVersion: false }
    );

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 2,
      applied: 2,
      diagnostics: []
    });
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['todos']);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 1 },
      { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
    ]);
  });

  it('applies durable relation patches through the generic runtime target', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const result = await tryApplyRelationPatches(
      adapter,
      [todos.updateByKey('todo-a', { done: true })],
      { readVersion: false }
    );

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: [],
      durability: 'durable'
    });
    expect('committed' in result).toBe(false);
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['todos']);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 1 }
    ]);
  });

  it('rejects invalid durable runtime target patches without leaking commit fields', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const result = await tryApplyRelationPatches(
      adapter,
      [todos.insert({ id: 'todo-b', text: 'Missing done', rank: 2 } as unknown as TodoRow)],
      { readVersion: false }
    );

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        {
          code: 'invalid_row',
          relation: 'todos',
          field: 'done'
        }
      ],
      durability: 'durable'
    });
    expect('committed' in result).toBe(false);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
  });

  it('composes durable Automerge rows and Repo Presence rows as one runtime', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });
    const handle = new FakeDocHandle();
    const presenceRuntime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { targetTodoId: 'todo-a' },
      heartbeatMs: 60_000
    });
    const runtime = composeRelationRuntimes(adapter, presenceRuntime);

    try {
      expect(isRelationRuntime(runtime)).toBe(true);
      expect(runtime.source.relationNames).toEqual(['todos', 'presence']);
      expect(runtime.target?.relationNames).toEqual(['todos', 'presence']);
      expect(runtime.target?.ownsRelation?.('todos')).toBe(true);
      expect(runtime.target?.ownsRelation?.('presence')).toBe(true);
      expect(runtime.target?.ownsRelation?.('notes')).toBe(false);
      expect(runtime.snapshot).toEqual(expect.any(Function));
      expect(runtime.subscribe).toEqual(expect.any(Function));
      await expect(evaluate(runtime.source, focusedTodos)).resolves.toEqual({
        rows: [{ todoId: 'todo-a', text: 'Buy oat milk', peerId: 'peer-local' }],
        diagnostics: []
      });

      const result = await tryApplyRelationPatches(runtime, [
        todos.updateByKey('todo-a', { done: true }),
        presenceRows.insertOrUpdate(
          { peerId: 'peer-local', channel: 'targetTodoId', value: 'todo-b' },
          { update: { value: 'todo-b' } }
        )
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        patches: 2,
        applied: 2,
        diagnostics: []
      });
      await expect(evaluate(runtime.source, focusedTodos)).resolves.toEqual({
        rows: [{ todoId: 'todo-b', text: 'Water basil', peerId: 'peer-local' }],
        diagnostics: []
      });
    } finally {
      presenceRuntime.stop();
    }
  });

  it('partially applies composed writes when durable Automerge accepts and remote presence rejects', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });
    const handle = new FakeDocHandle();
    const presenceRuntime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { targetTodoId: 'todo-a' },
      heartbeatMs: 60_000
    });
    const runtime = composeRelationRuntimes(adapter, presenceRuntime);

    try {
      const result = await tryApplyRelationPatches(runtime, [
        todos.updateByKey('todo-a', { done: true }),
        presenceRows.insertOrUpdate(
          { peerId: 'peer-remote', channel: 'targetTodoId', value: 'todo-b' },
          { update: { value: 'todo-b' } }
        )
      ]);

      expect(result).toMatchObject({
        status: 'partial',
        patches: 2,
        applied: 1,
        diagnostics: [
          {
            code: 'invalid_row',
            relation: 'presence',
            field: 'peerId'
          }
        ]
      });
      expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['todos']);
      expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
        { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 1 },
        { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      ]);
      await expect(evaluate(runtime.source, focusedTodos)).resolves.toEqual({
        rows: [{ todoId: 'todo-a', text: 'Buy oat milk', peerId: 'peer-local' }],
        diagnostics: []
      });
    } finally {
      presenceRuntime.stop();
    }
  });

  it('composes durable, presence, and memory runtimes through one query and write path', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });
    const handle = new FakeDocHandle();
    const presenceRuntime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { targetTodoId: 'todo-a' },
      heartbeatMs: 60_000
    });
    const memoryRuntime = createMemoryRelationRuntime({
      notes: [{ id: 'note-a', todoId: 'todo-a', body: 'Initial note' }]
    }, { relationNames: ['notes'] });
    const runtime = composeRelationRuntimes(adapter, presenceRuntime, memoryRuntime);

    try {
      expect(runtime.source.relationNames).toEqual(['todos', 'presence', 'notes']);
      await expect(evaluate(runtime.source, focusedTodoNotes)).resolves.toEqual({
        rows: [
          {
            todoId: 'todo-a',
            text: 'Buy oat milk',
            peerId: 'peer-local',
            note: 'Initial note'
          }
        ],
        diagnostics: []
      });

      const result = await tryApplyRelationPatches(runtime, [
        todos.updateByKey('todo-b', { rank: 3 }),
        presenceRows.insertOrUpdate(
          { peerId: 'peer-local', channel: 'targetTodoId', value: 'todo-b' },
          { update: { value: 'todo-b' } }
        ),
        notes.insert({ id: 'note-b', todoId: 'todo-b', body: 'Presence moved here' })
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        patches: 3,
        applied: 3,
        diagnostics: []
      });
      expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['todos', 'presence', 'notes']);
      await expect(evaluate(runtime.source, focusedTodoNotes)).resolves.toEqual({
        rows: [
          {
            todoId: 'todo-b',
            text: 'Water basil',
            peerId: 'peer-local',
            note: 'Presence moved here'
          }
        ],
        diagnostics: []
      });
    } finally {
      presenceRuntime.stop();
    }
  });

  it('rejects deleteExact when the keyed row does not match and commits matching exact deletes', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const mismatch = await tryCommitAdapter(adapter, [
      todos.deleteExact({ id: 'todo-a', text: 'Wrong item', done: false, rank: 1 })
    ]);

    expect(mismatch).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: []
    });
    expect(mismatch.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        relation: 'todos'
      }
    ]);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
      { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
    ]);

    const exact = await tryCommitAdapter(adapter, [
      todos.deleteExact({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 })
    ]);

    expect(exact).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: []
    });
    expect(exact.deltas.map((delta) => delta.relation.name)).toEqual(['todos']);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
    ]);
  });

  it('commits replaceAll as a single-patch adapter batch against the Automerge document', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const result = await tryCommitAdapter(adapter, [
      todos.replaceAll([{ id: 'todo-c', text: 'Review notes', done: false, rank: 3 }])
    ]);

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: []
    });
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['todos']);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-c', text: 'Review notes', done: false, rank: 3 }
    ]);
  });

  it('rejects invalid writes atomically without changing the Automerge document', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });

    const result = await tryCommitAdapter(adapter, [
      todos.updateByKey('todo-a', { done: true }),
      todos.deleteByKey('todo-missing')
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 2,
      applied: 0,
      deltas: []
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref' }]);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
  });

  it('can follow a host-supplied Automerge document snapshot', async () => {
    const doc = Automerge.from<TodoDocument>({ todos: {} });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });
    const nextDoc = Automerge.change(adapter.getDoc(), (draft) => {
      draft.todos['todo-a'] = { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 };
    });

    adapter.setDoc(nextDoc);

    expect(await adapter.source.version?.()).toBeDefined();
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
  });

  it('exposes source snapshots bound to their rows', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });
    const before = adapter.snapshot?.();
    const nextDoc = Automerge.change(adapter.getDoc(), (draft) => {
      draft.todos['todo-b'] = { id: 'todo-b', text: 'Water basil', done: false, rank: 2 };
    });

    adapter.setDoc(nextDoc);

    expect(before).toBeDefined();
    if (before === undefined || adapter.snapshot === undefined) {
      throw new Error('expected automerge adapter snapshots');
    }
    expect(Array.from(await before.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
    const after = adapter.snapshot();

    expect(Array.from(await after.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
      { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
    ]);
  });

  it('drops invalid Automerge relation rows from reads and reports diagnostics', async () => {
    const doc = Automerge.from<{ readonly todos: Record<string, unknown> }>({
      todos: {
        'todo-a': { text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { text: 'Missing done', rank: 2 },
        'todo-c': { text: 'Bad rank', done: false, rank: '3' },
        'todo-d': 'not a row'
      }
    });
    const adapter = automergeMapAdapter({ doc, relations: todoRelations });

    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
    expect(await adapter.source.lookup?.({ relation: schema.todos, field: 'id', value: 'todo-b' })).toEqual([]);

    const evaluated = await evaluate(adapter.source, todoRows);

    expect(evaluated.rows).toEqual([{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }]);
    expect(evaluated.diagnostics).toHaveLength(3);
    for (const diagnostic of evaluated.diagnostics) {
      expect(diagnostic).toMatchObject({ code: 'invalid_row', relation: 'todos' });
    }
    expect(evaluated.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_row', relation: 'todos', field: 'done' }),
      expect.objectContaining({ code: 'invalid_row', relation: 'todos', field: 'rank' })
    ]));
  });

  it('rejects commits against Automerge relations with invalid stored rows', async () => {
    const doc = Automerge.from<{ readonly todos: Record<string, unknown> }>({
      todos: {
        'todo-a': { text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { text: 'Missing done', rank: 2 }
      }
    });
    const adapter = automergeMapAdapter({ doc, relations: todoRelations });

    const result = await tryCommitAdapter(
      adapter,
      [todos.insert({ id: 'todo-c', text: 'Water basil', done: false, rank: 3 })],
      { readVersion: false }
    );

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        {
          code: 'invalid_row',
          relation: 'todos',
          field: 'done'
        }
      ]
    });
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
  });

  it('reports unsupported configuration and relation ownership explicitly', async () => {
    const otherSchema = defineSchema({
      tags: relation<{ readonly id: string; readonly label: string }>({
        key: 'id',
        fields: {
          id: idField('tag'),
          label: stringField()
        }
      })
    });
    const doc = Automerge.from<TodoDocument>({ todos: {} });
    const adapter = automergeMapAdapter<TodoDocument>({ doc, relations: todoRelations });
    const result = await tryCommitAdapter(adapter, [
      write(otherSchema.tags).insert({ id: 'tag-a', label: 'Errand' })
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: []
    });
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        relation: 'tags'
      }
    ]);
  });
});

class FakeDocHandle {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  asHandle(): DocHandle<unknown> {
    return this as unknown as DocHandle<unknown>;
  }

  on(eventName: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(eventName);

    if (listeners === undefined) {
      this.listeners.set(eventName, new Set([listener]));
    } else {
      listeners.add(listener);
    }
  }

  off(eventName: string, listener: (payload: unknown) => void): void {
    this.listeners.get(eventName)?.delete(listener);
  }

  broadcast(): void {}

  receive(senderId: string, message: unknown): void {
    this.emit('ephemeral-message', {
      handle: this,
      senderId: senderId as PeerId,
      message
    });
  }

  private emit(eventName: string, payload: unknown): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(payload);
    }
  }
}
