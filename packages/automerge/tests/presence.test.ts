import type { DocHandle, PeerId } from '@automerge/automerge-repo';
import { describe, expect, it } from 'vitest';
import { automergePresenceRuntime } from '@tarstate/automerge';
import { evaluate } from '@tarstate/core/evaluate';
import { as, eq, from, pipe, project, where } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  numberField,
  nullable,
  optional,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';

type PresenceRow = {
  readonly peerId: string;
  readonly channel: string;
  readonly value?: JsonValue;
  readonly lastActiveAt?: number;
  readonly lastSeenAt?: number;
  readonly local?: boolean;
};

const schema = defineSchema({
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

const presenceRows = write(schema.presence);
const presence = as(schema.presence, 'presence');
const colorPresence = pipe(
  from(presence),
  where(eq(presence.channel, 'color')),
  project({
    peerId: presence.peerId,
    value: presence.value,
    local: presence.local
  })
);

describe('Automerge Repo Presence runtime', () => {
  it('exposes local and remote presence as relation rows', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    try {
      expect(handle.broadcasts[0]).toEqual({ __presence: { type: 'snapshot', state: { color: 'blue' } } });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'blue', local: true }],
        diagnostics: []
      });

      handle.receive('peer-remote', {
        __presence: {
          type: 'snapshot',
          state: { color: 'red', ops: [{ action: 'move', path: ['piece-a'] }] }
        }
      });

      expect(notifications).toBe(1);
      expect(await runtime.source.lookup?.({ relation: schema.presence, field: 'channel', value: 'color' })).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true }),
        expect.objectContaining({ peerId: 'peer-remote', channel: 'color', value: 'red', local: false })
      ]);
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [
          { peerId: 'peer-local', value: 'blue', local: true },
          { peerId: 'peer-remote', value: 'red', local: false }
        ],
        diagnostics: []
      });
      expect(await runtime.source.version?.()).toEqual({ revision: 1, localPeerId: 'peer-local' });
    } finally {
      unsubscribe();
      runtime.stop();
    }
  });

  it('drops invalid remote presence rows from reads and reports diagnostics', async () => {
    const handle = new FakeDocHandle();
    const invalidValue = new Date('2026-01-01T00:00:00.000Z');
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      handle.receive('peer-remote', {
        __presence: {
          type: 'snapshot',
          state: {
            color: invalidValue,
            cursor: { x: 10, y: 20 }
          }
        }
      });

      expect(await runtime.source.rows(schema.presence)).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true }),
        expect.objectContaining({ peerId: 'peer-remote', channel: 'cursor', value: { x: 10, y: 20 }, local: false })
      ]);
      expect(await runtime.source.lookup?.({ relation: schema.presence, field: 'channel', value: 'color' })).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true })
      ]);
      await expect(evaluate(runtime.source, colorPresence)).resolves.toEqual({
        rows: [{ peerId: 'peer-local', value: 'blue', local: true }],
        diagnostics: [
          {
            code: 'invalid_row',
            message: 'invalid field value in relation presence',
            relation: 'presence',
            field: 'value',
            key: 'peer-remote:color',
            detail: invalidValue
          }
        ]
      });

      const snapshot = runtime.snapshot?.();

      if (snapshot === undefined) {
        throw new Error('expected presence runtime snapshot');
      }

      expect(await snapshot.source.rows(schema.presence)).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true }),
        expect.objectContaining({ peerId: 'peer-remote', channel: 'cursor', value: { x: 10, y: 20 }, local: false })
      ]);
      expect(await snapshot.source.diagnostics?.()).toEqual([
        {
          code: 'invalid_row',
          message: 'invalid field value in relation presence',
          relation: 'presence',
          field: 'value',
          key: 'peer-remote:color',
          detail: invalidValue
        }
      ]);
    } finally {
      runtime.stop();
    }
  });

  it('applies local presence patches and broadcasts changed channels', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.upsert({ peerId: 'peer-local', channel: 'color', value: 'green' })
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        accepted: true,
        patches: 1,
        applied: 1,
        diagnostics: [],
        durability: 'ephemeral',
        version: { revision: 1, localPeerId: 'peer-local' }
      });
      expect(runtime.getLocalState()).toMatchObject({ color: 'green' });
      expect(handle.broadcasts.at(-1)).toEqual({
        __presence: { type: 'update', channel: 'color', value: 'green' }
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'green', local: true }],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
  });

  it('notifies subscribers for local applies while keeping snapshots read-consistent', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });
    const before = runtime.snapshot?.();

    if (before === undefined) {
      throw new Error('expected presence runtime snapshot');
    }

    try {
      const result = await runtime.target.apply([
        presenceRows.upsert({ peerId: 'peer-local', channel: 'color', value: 'green' })
      ]);

      expect(result.status).toBe('accepted');
      expect(notifications).toBe(1);
      expect(before.version).toEqual({ revision: 0, localPeerId: 'peer-local' });
      await expect(evaluate(before.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'blue', local: true }],
        diagnostics: []
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'green', local: true }],
        diagnostics: []
      });
    } finally {
      unsubscribe();
      runtime.stop();
    }
  });

  it('clears local presence channels through delete patches', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.delete({ peerId: 'peer-local', channel: 'color' })
      ]);

      expect(result.status).toBe('accepted');
      expect(runtime.getLocalState()).toMatchObject({ color: undefined });
      expect(handle.broadcasts.at(-1)).toEqual({
        __presence: { type: 'update', channel: 'color', value: undefined }
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
  });

  it('clears local presence channels when a row value is omitted', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.upsert({ peerId: 'peer-local', channel: 'color' })
      ]);

      expect(result.status).toBe('accepted');
      expect(runtime.getLocalState()).toMatchObject({ color: undefined });
      expect(handle.broadcasts.at(-1)).toEqual({
        __presence: { type: 'update', channel: 'color', value: undefined }
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
  });

  it('keeps null as a presence value by default', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.upsert({ peerId: 'peer-local', channel: 'color', value: null })
      ]);

      expect(result.status).toBe('accepted');
      expect(runtime.getLocalState()).toMatchObject({ color: null });
      expect(handle.broadcasts.at(-1)).toEqual({
        __presence: { type: 'update', channel: 'color', value: null }
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: null, local: true }],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
  });

  it('allows the runtime owner to define additional cleared values', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000,
      isClearedValue: (value) => value === undefined || value === null
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.upsert({ peerId: 'peer-local', channel: 'color', value: null })
      ]);

      expect(result.status).toBe('accepted');
      expect(runtime.getLocalState()).toMatchObject({ color: undefined });
      expect(handle.broadcasts.at(-1)).toEqual({
        __presence: { type: 'update', channel: 'color', value: undefined }
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
  });

  it('rejects patches that try to write remote peer presence', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.upsert({ peerId: 'peer-remote', channel: 'color', value: 'red' })
      ]);

      expect(result).toMatchObject({
        status: 'rejected',
        accepted: false,
        applied: 0,
        deltas: [],
        durability: 'ephemeral',
        diagnostics: [{ code: 'invalid_row', relation: 'presence', field: 'peerId' }]
      });
      expect(runtime.getLocalState()).toMatchObject({ color: 'blue' });
      expect(handle.broadcasts).toEqual([{ __presence: { type: 'snapshot', state: { color: 'blue' } } }]);
    } finally {
      runtime.stop();
    }
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
