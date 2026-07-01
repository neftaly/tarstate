import * as Automerge from '@automerge/automerge';
import type { PeerId } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationAdapter, isRelationRuntime } from '@tarstate/core/adapter';
import { as, eq, from, pipe, project, where } from '@tarstate/core/query';
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
import { automergeDb } from '@tarstate/automerge';
import {
  automergePresenceRuntime,
  defaultAutomergePresenceClearedValue,
  type AutomergePresenceFieldNames,
  type AutomergePresenceRuntime,
  type AutomergePresenceWritableRuntime
} from '@tarstate/automerge/presence';

type PresenceRow = {
  readonly peer: string;
  readonly topic: string;
  readonly payload?: JsonValue;
  readonly activeAt?: number;
  readonly seenAt?: number;
  readonly isLocal?: boolean;
};

type PresenceChannels = Record<string, JsonValue | undefined>;

const schema = defineSchema({
  presence: relation<PresenceRow>({
    ephemeral: true,
    key: ['peer', 'topic'],
    fields: {
      peer: idField('peer'),
      topic: stringField(),
      payload: optional(nullable(jsonField())),
      activeAt: optional(numberField()),
      seenAt: optional(numberField()),
      isLocal: optional(booleanField())
    }
  })
});

const fields = {
  peerId: 'peer',
  channel: 'topic',
  value: 'payload',
  lastActiveAt: 'activeAt',
  lastSeenAt: 'seenAt',
  local: 'isLocal'
} satisfies AutomergePresenceFieldNames;

const presenceRows = write(schema.presence);

describe('automerge presence runtime contract', () => {
  it('exposes the public presence API only from @tarstate/automerge/presence', async () => {
    const mapApi = await import('@tarstate/automerge');
    const presenceApi = await import('@tarstate/automerge/presence');
    const runtime = presenceRuntime({ color: 'blue' });

    try {
      expect(presenceApi.automergePresenceRuntime).toBe(automergePresenceRuntime);
      expect(presenceApi.defaultAutomergePresenceClearedValue).toBe(defaultAutomergePresenceClearedValue);
      expect(defaultAutomergePresenceClearedValue(undefined)).toBe(true);
      expect(defaultAutomergePresenceClearedValue(null)).toBe(false);
      expect('automergePresenceRuntime' in mapApi).toBe(false);
      expect('createAutomergePresenceRuntime' in presenceApi).toBe(false);
      expect(isRelationRuntime(runtime)).toBe(true);
      expect(isRelationAdapter(runtime)).toBe(false);
      expectTypeOf(automergePresenceRuntime<PresenceChannels>).returns.toMatchTypeOf<
        AutomergePresenceRuntime<PresenceChannels>
      >();
    } finally {
      runtime.stop();
    }
  });

  it('reads local and remote presence rows with custom fields, versions, diagnostics, and notifications', async () => {
    const handle = new FakeDocHandle();
    const runtime = presenceRuntime({ color: 'blue', cursor: { x: 1, y: 2 } }, handle);
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    try {
      handle.receivePresenceSnapshot('peer-remote', {
        color: 'red',
        cursor: { x: 5, y: 8 },
        invalid: new Date('2026-01-01T00:00:00.000Z')
      });

      expect(notifications).toBe(1);
      expect(runtime.fields).toEqual(fields);
      expect(runtime.source.relationNames).toEqual(['presence']);
      expect(runtime.target.relationNames).toEqual(['presence']);
      expect(runtime.target.ownsRelation?.('presence')).toBe(true);
      expect(runtime.target.ownsRelation?.('tasks')).toBe(false);
      expect(await runtime.source.version?.()).toEqual(expect.objectContaining({
        revision: expect.any(Number),
        localPeerId: 'peer-local'
      }));
      expect(await runtime.source.rows(schema.presence)).toEqual(expect.arrayContaining([
        expect.objectContaining({ peer: 'peer-local', topic: 'color', payload: 'blue', isLocal: true }),
        expect.objectContaining({ peer: 'peer-local', topic: 'cursor', payload: { x: 1, y: 2 }, isLocal: true }),
        expect.objectContaining({ peer: 'peer-remote', topic: 'color', payload: 'red', isLocal: false }),
        expect.objectContaining({ peer: 'peer-remote', topic: 'cursor', payload: { x: 5, y: 8 }, isLocal: false })
      ]));
      expect(await runtime.source.lookup?.({ relation: schema.presence, field: 'topic', value: 'color' })).toEqual([
        expect.objectContaining({ peer: 'peer-local', topic: 'color', payload: 'blue', isLocal: true }),
        expect.objectContaining({ peer: 'peer-remote', topic: 'color', payload: 'red', isLocal: false })
      ]);
      expect(await runtime.source.rangeLookup?.({
        relation: schema.presence,
        field: 'seenAt',
        lower: { value: 0, inclusive: true }
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({ peer: 'peer-local', topic: 'color' }),
        expect.objectContaining({ peer: 'peer-remote', topic: 'color' })
      ]));
      expect(await runtime.source.diagnostics?.()).toEqual([
        expect.objectContaining({ code: 'invalid_row', relation: 'presence', field: 'payload' })
      ]);
      expect(runtime.snapshot().version).toEqual(await runtime.source.version?.());
    } finally {
      unsubscribe();
      runtime.stop();
    }
  });

  it('composes presence as an optional relation source for automergeDb q and transactions', async () => {
    const runtime = presenceRuntime({ color: 'blue' });
    const presence = as(schema.presence, 'presence');
    const query = pipe(
      from(presence),
      where(eq(presence.topic, 'color')),
      project({ peer: presence.peer, payload: presence.payload, isLocal: presence.isLocal })
    );
    const relic = automergeDb(Automerge.from<Record<string, unknown>>({}), {
      relations: [],
      runtimes: [runtime]
    });

    try {
      await expect(relic.q(query)).resolves.toMatchObject({
        rows: [{ peer: 'peer-local', payload: 'blue', isLocal: true }],
        diagnostics: []
      });

      await expect(relic.tryTransact(presenceRows.insertOrUpdate(
        { peer: 'peer-local', topic: 'color', payload: 'green' },
        { update: { payload: 'green' } }
      ))).resolves.toMatchObject({
        committed: true,
        applied: 1,
        diagnostics: []
      });
      await expect(relic.q(query)).resolves.toMatchObject({
        rows: [{ peer: 'peer-local', payload: 'green', isLocal: true }],
        diagnostics: []
      });
    } finally {
      runtime.stop();
    }
  });

  it('applies set and delete patches to local presence with ephemeral deltas', async () => {
    const runtime = presenceRuntime({ color: 'blue', mood: 'focused' });
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.insertOrUpdate(
          { peer: 'peer-local', topic: 'color', payload: 'green' },
          { update: { payload: 'green' } }
        ),
        presenceRows.deleteByKey(['peer-local', 'mood'])
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        patches: 2,
        applied: 2,
        diagnostics: [],
        durability: 'ephemeral'
      });
      expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['presence']);
      expect(notifications).toBe(1);
      expect(runtime.getLocalState()).toEqual({ color: 'green' });
      expect(await runtime.source.lookup?.({ relation: schema.presence, field: 'topic', value: 'color' })).toEqual([
        expect.objectContaining({ peer: 'peer-local', topic: 'color', payload: 'green', isLocal: true })
      ]);
      expect(await runtime.source.lookup?.({ relation: schema.presence, field: 'topic', value: 'mood' })).toEqual([]);
    } finally {
      unsubscribe();
      runtime.stop();
    }
  });

  it('rejects writes for remote peers without changing local or remote presence', async () => {
    const handle = new FakeDocHandle();
    const runtime = presenceRuntime({ color: 'blue' }, handle);

    try {
      handle.receivePresenceSnapshot('peer-remote', { color: 'red' });
      const beforeRows = await runtime.source.rows(schema.presence);

      const result = await runtime.target.apply([
        presenceRows.insertOrUpdate(
          { peer: 'peer-remote', topic: 'color', payload: 'purple' },
          { update: { payload: 'purple' } }
        )
      ]);

      expect(result).toMatchObject({
        status: 'rejected',
        patches: 1,
        applied: 0,
        deltas: [],
        durability: 'ephemeral',
        diagnostics: [{ code: 'invalid_row', relation: 'presence', field: 'peer' }]
      });
      expect(await runtime.source.rows(schema.presence)).toEqual(beforeRows);
      expect(runtime.getPeerStates()).toEqual(expect.arrayContaining([
        expect.objectContaining({ peerId: 'peer-remote', state: { color: 'red' } })
      ]));
    } finally {
      runtime.stop();
    }
  });

  it('clears local state with custom peer and key fields and stops notifications after unsubscribe', async () => {
    const handle = new FakeDocHandle();
    const runtime = presenceRuntime({ color: 'blue', mood: 'focused' }, handle);
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    try {
      const result = await runtime.target.apply([
        presenceRows.deleteByKey(['peer-local', 'color']),
        presenceRows.deleteByKey(['peer-local', 'mood'])
      ]);

      expect(result).toMatchObject({
        status: 'accepted',
        patches: 2,
        applied: 2,
        diagnostics: [],
        durability: 'ephemeral'
      });
      expect(runtime.getLocalState()).toEqual({});
      expect(await runtime.source.rows(schema.presence)).toEqual([]);
      expect(notifications).toBe(1);

      unsubscribe();
      handle.receivePresenceSnapshot('peer-remote', { color: 'red' });

      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
      runtime.stop();
    }
  });

  it('rejects remote deletes and relation rewrites without changing presence state', async () => {
    const handle = new FakeDocHandle();
    const runtime = presenceRuntime({ color: 'blue' }, handle);

    try {
      handle.receivePresenceSnapshot('peer-remote', { color: 'red' });
      const beforeRows = await runtime.source.rows(schema.presence);

      const result = await runtime.target.apply([
        presenceRows.deleteByKey(['peer-remote', 'color']),
        presenceRows.replaceAll([{ peer: 'peer-local', topic: 'color', payload: 'green' }])
      ]);

      expect(result).toMatchObject({
        status: 'rejected',
        patches: 2,
        applied: 0,
        deltas: [],
        durability: 'ephemeral',
        diagnostics: [expect.objectContaining({ code: 'invalid_row', relation: 'presence', field: 'peer' })]
      });
      expect(await runtime.source.rows(schema.presence)).toEqual(beforeRows);
      expect(runtime.getLocalState()).toEqual({ color: 'blue' });
      expect(runtime.getPeerStates()).toEqual(expect.arrayContaining([
        expect.objectContaining({ peerId: 'peer-remote', state: { color: 'red' } })
      ]));
    } finally {
      runtime.stop();
    }
  });
});

function presenceRuntime(
  initialState: PresenceChannels,
  handle = new FakeDocHandle()
): AutomergePresenceWritableRuntime<PresenceChannels> {
  return automergePresenceRuntime({
    handle: handle.asHandle(),
    relation: schema.presence,
    fields,
    localPeerId: 'peer-local',
    initialState,
    heartbeatMs: 60_000,
    start: true
  });
}

class FakeDocHandle {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  asHandle() {
    return {
      on: this.on.bind(this),
      off: this.off.bind(this),
      broadcast: this.broadcast.bind(this)
    };
  }

  on(eventName: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(eventName);

    if (listeners === undefined) {
      this.listeners.set(eventName, new Set([listener]));
      return;
    }

    listeners.add(listener);
  }

  off(eventName: string, listener: (payload: unknown) => void): void {
    this.listeners.get(eventName)?.delete(listener);
  }

  broadcast(): void {}

  receivePresenceSnapshot(senderId: string, state: Record<string, unknown>): void {
    this.emit('ephemeral-message', {
      handle: this,
      senderId: senderId as PeerId,
      message: {
        __presence: {
          type: 'snapshot',
          state
        }
      }
    });
  }

  private emit(eventName: string, payload: unknown): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(payload);
    }
  }
}
