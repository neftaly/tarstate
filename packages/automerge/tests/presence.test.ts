import type { DocHandle, PeerId } from '@automerge/automerge-repo';
import { describe, expect, it } from 'vitest';
import { automergePresenceRuntime } from '@tarstate/automerge/presence';
import { isRelationAdapter, isRelationRuntime } from '@tarstate/core/adapter';
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
      expect(isRelationRuntime(runtime)).toBe(true);
      expect(isRelationAdapter(runtime)).toBe(false);
      expect(runtime.source.relationNames).toEqual(['presence']);
      expect(runtime.target.relationNames).toEqual(['presence']);
      expect(runtime.target.ownsRelation?.('presence')).toBe(true);
      expect(runtime.target.ownsRelation?.('todos')).toBe(false);
      expect(runtime.snapshot).toEqual(expect.any(Function));
      expect(runtime.subscribe).toEqual(expect.any(Function));
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'blue', local: true }],
        diagnostics: []
      });

      handle.receivePresenceSnapshot('peer-remote', { color: 'red', ops: [{ action: 'move', path: ['piece-a'] }] });

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
      const snapshot = runtime.snapshot();

      expect(await runtime.source.version?.()).toBeDefined();
      expect(snapshot.version).toBeDefined();
      expect(await snapshot.source.version?.()).toBeDefined();
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
      handle.receivePresenceSnapshot('peer-remote', {
        color: invalidValue,
        cursor: { x: 10, y: 20 }
      });

      expect(await runtime.source.rows(schema.presence)).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true }),
        expect.objectContaining({ peerId: 'peer-remote', channel: 'cursor', value: { x: 10, y: 20 }, local: false })
      ]);
      expect(await runtime.source.lookup?.({ relation: schema.presence, field: 'channel', value: 'color' })).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true })
      ]);
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'blue', local: true }],
        diagnostics: [
          {
            code: 'invalid_row',
            relation: 'presence',
            field: 'value'
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
      expect(await snapshot.source.diagnostics?.()).toMatchObject([
        {
          code: 'invalid_row',
          relation: 'presence',
          field: 'value'
        }
      ]);
    } finally {
      runtime.stop();
    }
  });

  it('answers presence range lookups only for schema-supported ordered fields', async () => {
    const handle = new FakeDocHandle();
    const runtime = automergePresenceRuntime({
      handle: handle.asHandle(),
      relation: schema.presence,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' },
      heartbeatMs: 60_000
    });

    try {
      expect(await runtime.source.rangeLookup?.({
        relation: schema.presence,
        field: 'lastSeenAt',
        lower: { value: 0, inclusive: true }
      })).toEqual([
        expect.objectContaining({ peerId: 'peer-local', channel: 'color', value: 'blue', local: true })
      ]);
      expect(await runtime.source.rangeLookup?.({
        relation: schema.presence,
        field: 'value',
        lower: { value: 'a', inclusive: true },
        upper: { value: 'z', inclusive: true }
      })).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it('applies local presence patches through the runtime target', async () => {
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
        presenceRows.insertOrUpdate(
          { peerId: 'peer-local', channel: 'color', value: 'green' },
          { update: { value: 'green' } }
        )
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        patches: 1,
        applied: 1,
        diagnostics: [],
        durability: 'ephemeral'
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
        presenceRows.insertOrUpdate(
          { peerId: 'peer-local', channel: 'color', value: 'green' },
          { update: { value: 'green' } }
        )
      ]);

      expect(result.status).toBe('accepted');
      expect(notifications).toBe(1);
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
        presenceRows.deleteByKey(['peer-local', 'color'])
      ]);

      expect(result.status).toBe('accepted');
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
        presenceRows.insertOrUpdate(
          { peerId: 'peer-local', channel: 'color', value: null },
          { update: { value: null } }
        )
      ]);

      expect(result.status).toBe('accepted');
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
        presenceRows.insertOrUpdate(
          { peerId: 'peer-local', channel: 'color', value: null },
          { update: { value: null } }
        )
      ]);

      expect(result.status).toBe('accepted');
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
        presenceRows.insertOrUpdate(
          { peerId: 'peer-remote', channel: 'color', value: 'red' },
          { update: { value: 'red' } }
        )
      ]);

      expect(result).toMatchObject({
        status: 'rejected',
        applied: 0,
        deltas: [],
        durability: 'ephemeral',
        diagnostics: [{ code: 'invalid_row', relation: 'presence', field: 'peerId' }]
      });
      await expect(evaluate(runtime.source, colorPresence)).resolves.toMatchObject({
        rows: [{ peerId: 'peer-local', value: 'blue', local: true }],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
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

  receivePresenceSnapshot(senderId: string, state: Record<string, unknown>): void {
    this.receive(senderId, {
      __presence: {
        type: 'snapshot',
        state
      }
    });
  }

  private receive(senderId: string, message: unknown): void {
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
