import * as Automerge from '@automerge/automerge';
import type { DocHandle, PeerId } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { composeRelationRuntimes, tryApplyRelationPatches, tryCommitAdapter } from '@tarstate/core/adapter';
import { evaluate } from '@tarstate/core/evaluate';
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
  automergePresenceRuntime,
  createAutomergeRelationAdapter,
  rowsFromAutomergeMapPath,
  type AutomergeMapAdapter
} from '@tarstate/automerge';

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
  })
});

const todos = write(schema.todos);
const presenceRows = write(schema.presence);
const todo = as(schema.todos, 'todo');
const presence = as(schema.presence, 'presence');
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
const todoRelations = [{ relation: schema.todos, path: ['todos'] }] as const;

describe('@tarstate/automerge', () => {
  it('exports the public package adapter surface', () => {
    expectTypeOf(createAutomergeRelationAdapter<TodoDocument>).returns.toMatchTypeOf<AutomergeMapAdapter<TodoDocument>>();
    expectTypeOf(rowsFromAutomergeMapPath<TodoDocument>).returns.toEqualTypeOf<readonly unknown[]>();
  });

  it('reads rows, lookups, range lookups, and versions from a real Automerge document', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
      }
    });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });

    expect(await adapter.source.version?.()).toEqual(Automerge.getHeads(doc));
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

  it('commits Tarstate write patches through Automerge.change and returns real heads', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });

    const beforeDoc = adapter.doc;
    const result = await tryCommitAdapter(
      adapter,
      [
        todos.update('todo-a', { done: true }),
        todos.insert({ id: 'todo-b', text: 'Water basil', done: false, rank: 2 })
      ],
      { readVersion: false }
    );

    expect(result).toMatchObject({
      status: 'committed',
      committed: true,
      patches: 2,
      applied: 2,
      diagnostics: []
    });
    expect(adapter.doc).not.toBe(beforeDoc);
    expect(result.version).toEqual(Automerge.getHeads(adapter.doc));
    expect(adapter.doc.todos['todo-a']).toEqual({ text: 'Buy oat milk', done: true, rank: 1 });
    expect(adapter.doc.todos['todo-b']).toEqual({ text: 'Water basil', done: false, rank: 2 });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 1 },
          { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
        ],
        removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }]
      }
    ]);
  });

  it('composes durable Automerge rows and Repo Presence rows as one runtime', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      }
    });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });
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
      expect(runtime.source.relationNames).toEqual(['todos', 'presence']);
      await expect(evaluate(runtime.source, focusedTodos)).resolves.toEqual({
        rows: [{ todoId: 'todo-a', text: 'Buy oat milk', peerId: 'peer-local' }],
        diagnostics: []
      });

      const result = await tryApplyRelationPatches(runtime, [
        todos.update('todo-a', { done: true }),
        presenceRows.upsert({ peerId: 'peer-local', channel: 'targetTodoId', value: 'todo-b' })
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        accepted: true,
        patches: 2,
        applied: 2,
        diagnostics: []
      });
      expect(result.version).toEqual([
        Automerge.getHeads(adapter.doc),
        { revision: 1, localPeerId: 'peer-local' }
      ]);
      expect(adapter.doc.todos['todo-a']).toEqual({ text: 'Buy oat milk', done: true, rank: 1 });
      expect(handle.broadcasts.at(-1)).toEqual({
        __presence: { type: 'update', channel: 'targetTodoId', value: 'todo-b' }
      });
      await expect(evaluate(runtime.source, focusedTodos)).resolves.toEqual({
        rows: [{ todoId: 'todo-b', text: 'Water basil', peerId: 'peer-local' }],
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
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });
    const beforeDoc = adapter.doc;
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const mismatch = await tryCommitAdapter(adapter, [
      todos.deleteExact({ id: 'todo-a', text: 'Wrong item', done: false, rank: 1 })
    ]);

    expect(mismatch).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 1,
      applied: 0,
      deltas: [],
      version: beforeHeads
    });
    expect(mismatch.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        relation: 'todos',
        message: 'row ["todo-a"] in relation todos does not match exact delete row'
      }
    ]);
    expect(adapter.doc).toBe(beforeDoc);
    expect(adapter.doc.todos['todo-a']).toEqual({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 });

    const exact = await tryCommitAdapter(adapter, [
      todos.deleteExact({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 })
    ]);

    expect(exact).toMatchObject({
      status: 'committed',
      committed: true,
      patches: 1,
      applied: 1,
      diagnostics: []
    });
    expect(exact.version).toEqual(Automerge.getHeads(adapter.doc));
    expect(exact.deltas).toEqual([
      {
        relation: schema.todos,
        added: [],
        removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }]
      }
    ]);
    expect(adapter.doc).not.toBe(beforeDoc);
    expect(adapter.doc.todos).toEqual({
      'todo-b': { text: 'Water basil', done: false, rank: 2 }
    });
  });

  it('commits replaceAll as a single-patch adapter batch against the Automerge document', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
      }
    });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });

    const result = await tryCommitAdapter(adapter, [
      todos.replaceAll([{ id: 'todo-c', text: 'Review notes', done: false, rank: 3 }])
    ]);

    expect(result).toMatchObject({
      status: 'committed',
      committed: true,
      patches: 1,
      applied: 1,
      diagnostics: []
    });
    expect(result.version).toEqual(Automerge.getHeads(adapter.doc));
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [{ id: 'todo-c', text: 'Review notes', done: false, rank: 3 }],
        removed: [
          { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
          { id: 'todo-b', text: 'Water basil', done: true, rank: 2 }
        ]
      }
    ]);
    expect(adapter.doc.todos).toEqual({
      'todo-c': { text: 'Review notes', done: false, rank: 3 }
    });
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
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });
    const beforeDoc = adapter.doc;
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const result = await tryCommitAdapter(adapter, [
      todos.update('todo-a', { done: true }),
      todos.delete('todo-missing')
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 2,
      applied: 0,
      deltas: [],
      version: beforeHeads
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref', key: 'todo-missing' }]);
    expect(adapter.doc).toBe(beforeDoc);
    expect(adapter.doc.todos['todo-a']).toEqual({ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 });
  });

  it('can follow a host-supplied Automerge document snapshot', async () => {
    const doc = Automerge.from<TodoDocument>({ todos: {} });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });
    const nextDoc = Automerge.change(adapter.doc, (draft) => {
      draft.todos['todo-a'] = { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 };
    });

    adapter.setDoc(nextDoc);

    expect(await adapter.source.version?.()).toEqual(Automerge.getHeads(nextDoc));
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
  });

  it('exposes version-bound source snapshots', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });
    const before = adapter.snapshot?.();
    const nextDoc = Automerge.change(adapter.doc, (draft) => {
      draft.todos['todo-b'] = { id: 'todo-b', text: 'Water basil', done: false, rank: 2 };
    });

    adapter.setDoc(nextDoc);

    expect(before).toBeDefined();
    if (before === undefined || adapter.snapshot === undefined) {
      throw new Error('expected automerge adapter snapshots');
    }
    expect(before.version).toEqual(Automerge.getHeads(doc));
    expect(Array.from(await before.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
    expect(Array.from(await adapter.snapshot().source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
      { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
    ]);
  });

  it('uses Automerge map keys as authoritative relation keys', async () => {
    const doc = Automerge.from<TodoDocument>({
      todos: {
        'todo-a': { id: 'wrong-id', text: 'Buy oat milk', done: false, rank: 1 }
      }
    });
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });

    expect(rowsFromAutomergeMapPath(doc, ['todos'], schema.todos)).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
  });

  it('reports blocked relation paths through adapter source diagnostics', async () => {
    const doc = Automerge.from<{ readonly todos: string }>({ todos: 'not a relation map' });
    const adapter = createAutomergeRelationAdapter({ doc, relations: todoRelations });

    expect(rowsFromAutomergeMapPath(doc, ['todos'], schema.todos)).toEqual([]);
    expect(await adapter.source.diagnostics?.()).toMatchObject([
      {
        code: 'source_error',
        message: 'automerge path todos is not a map',
        detail: 'not a relation map'
      }
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
    const adapter = createAutomergeRelationAdapter({ doc, relations: todoRelations });

    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }
    ]);
    expect(await adapter.source.lookup?.({ relation: schema.todos, field: 'id', value: 'todo-b' })).toEqual([]);

    await expect(evaluate(adapter.source, todoRows)).resolves.toEqual({
      rows: [{ id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 }],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'missing required field done in relation todos',
          relation: 'todos',
          field: 'done',
          key: 'todo-b'
        },
        {
          code: 'invalid_row',
          message: 'invalid field rank in relation todos',
          relation: 'todos',
          field: 'rank',
          key: 'todo-c',
          detail: '3'
        },
        {
          code: 'invalid_row',
          message: 'row for relation todos is not an object',
          relation: 'todos',
          key: 'todo-d',
          detail: 'not a row'
        }
      ]
    });
  });

  it('rejects commits against Automerge relations with invalid stored rows', async () => {
    const doc = Automerge.from<{ readonly todos: Record<string, unknown> }>({
      todos: {
        'todo-a': { text: 'Buy oat milk', done: false, rank: 1 },
        'todo-b': { text: 'Missing done', rank: 2 }
      }
    });
    const adapter = createAutomergeRelationAdapter({ doc, relations: todoRelations });
    const beforeDoc = adapter.doc;
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const result = await tryCommitAdapter(
      adapter,
      [todos.insert({ id: 'todo-c', text: 'Water basil', done: false, rank: 3 })],
      { readVersion: false }
    );

    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        {
          code: 'invalid_row',
          relation: 'todos',
          field: 'done',
          key: 'todo-b'
        }
      ],
      version: beforeHeads
    });
    expect(adapter.doc).toBe(beforeDoc);
    expect(adapter.doc.todos).not.toHaveProperty('todo-c');
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
    const adapter = createAutomergeRelationAdapter<TodoDocument>({ doc, relations: todoRelations });
    const result = await tryCommitAdapter(adapter, [
      write(otherSchema.tags).insert({ id: 'tag-a', label: 'Errand' })
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
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
  readonly broadcasts: unknown[] = [];
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

  broadcast(message: unknown): void {
    this.broadcasts.push(message);
  }

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
