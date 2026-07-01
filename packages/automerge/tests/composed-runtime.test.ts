import * as Automerge from '@automerge/automerge';
import type { DocHandle } from '@automerge/automerge-repo';
import { describe, expect, it } from 'vitest';
import { automergePresenceRuntime, createAutomergeRelationAdapter } from '@tarstate/automerge';
import { composeRelationRuntimes, tryApplyRelationPatches } from '@tarstate/core/adapter';
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

type CompactPresenceRow = {
  readonly peerId: string;
  readonly channel: string;
  readonly value: JsonValue | undefined;
  readonly local: boolean | undefined;
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
const todoRelations = [{ relation: schema.todos, path: ['todos'] }] as const;

describe('composed Automerge runtime snapshots', () => {
  it('keeps composed snapshot rows and versions bound after child runtimes change', async () => {
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
      const snapshot = runtime.snapshot?.();

      if (snapshot === undefined) {
        throw new Error('expected composed runtime snapshot');
      }

      const originalVersion = [
        Automerge.getHeads(adapter.doc),
        { revision: 0, localPeerId: 'peer-local' }
      ];

      expect(snapshot.version).toEqual(originalVersion);
      const snapshotSourceVersion = await snapshot.source.version?.();

      expect(snapshotSourceVersion).toBe(snapshot.version);
      expect(snapshotSourceVersion).toEqual(originalVersion);
      expect(await snapshot.source.diagnostics?.()).toEqual([]);

      const result = await tryApplyRelationPatches(runtime, [
        todos.update('todo-a', { done: true }),
        presenceRows.upsert({ peerId: 'peer-local', channel: 'targetTodoId', value: 'todo-b' })
      ]);

      expect(result.status).toBe('accepted');
      expect(snapshot.version).toEqual(originalVersion);
      expect(await snapshot.source.version?.()).toBe(snapshot.version);
      expect(await snapshot.source.diagnostics?.()).toEqual([]);
      expect(Array.from(await snapshot.source.rows(schema.todos))).toEqual([
        { id: 'todo-a', text: 'Buy oat milk', done: false, rank: 1 },
        { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      ]);
      expect(compactPresenceRows(await snapshot.source.rows(schema.presence))).toEqual([
        { peerId: 'peer-local', channel: 'targetTodoId', value: 'todo-a', local: true }
      ]);

      const currentVersion = await runtime.source.version?.();

      expect(currentVersion).toEqual([
        Automerge.getHeads(adapter.doc),
        { revision: 1, localPeerId: 'peer-local' }
      ]);
      expect(currentVersion).not.toEqual(originalVersion);
      expect(await runtime.source.diagnostics?.()).toEqual([]);
      expect(Array.from(await runtime.source.rows(schema.todos))).toEqual([
        { id: 'todo-a', text: 'Buy oat milk', done: true, rank: 1 },
        { id: 'todo-b', text: 'Water basil', done: false, rank: 2 }
      ]);
      expect(compactPresenceRows(await runtime.source.rows(schema.presence))).toEqual([
        { peerId: 'peer-local', channel: 'targetTodoId', value: 'todo-b', local: true }
      ]);
    } finally {
      presenceRuntime.stop();
    }
  });
});

function compactPresenceRows(rows: Iterable<unknown>): readonly CompactPresenceRow[] {
  return Array.from(rows, (row) => {
    const presence = row as PresenceRow;

    return {
      peerId: presence.peerId,
      channel: presence.channel,
      value: presence.value,
      local: presence.local
    };
  });
}

class FakeDocHandle {
  readonly broadcasts: unknown[] = [];

  asHandle(): DocHandle<unknown> {
    return this as unknown as DocHandle<unknown>;
  }

  on(): void {}

  off(): void {}

  broadcast(message: unknown): void {
    this.broadcasts.push(message);
  }
}
