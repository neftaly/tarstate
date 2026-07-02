import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationRuntime } from '@tarstate/core/adapter';
import { defineSchema, idField, jsonField, optional, relation, stringField, type JsonValue } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
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
};

type PresenceChannels = Record<string, JsonValue | undefined>;

const schema = defineSchema({
  presence: relation<PresenceRow>({
    ephemeral: true,
    key: ['peer', 'topic'],
    fields: {
      peer: idField('peer'),
      topic: stringField(),
      payload: optional(jsonField())
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

describe('automerge presence subpath contract', () => {
  it('keeps presence exports on the ./presence subpath', async () => {
    const rootApi = await import('@tarstate/automerge');
    const presenceApi = await import('@tarstate/automerge/presence');
    const runtime = presenceRuntime({ color: 'blue' }, false);

    expect(presenceApi.automergePresenceRuntime).toBe(automergePresenceRuntime);
    expect(presenceApi.defaultAutomergePresenceClearedValue).toBe(defaultAutomergePresenceClearedValue);
    expect('automergePresenceRuntime' in rootApi).toBe(false);
    expect(defaultAutomergePresenceClearedValue(undefined)).toBe(true);
    expect(defaultAutomergePresenceClearedValue(null)).toBe(false);
    expect(isRelationRuntime(runtime)).toBe(true);
    expectTypeOf(automergePresenceRuntime<PresenceChannels>).returns.toMatchTypeOf<
      AutomergePresenceRuntime<PresenceChannels>
    >();
  });

  it('creates a writable presence runtime facade with empty stub rows', async () => {
    const runtime = presenceRuntime({ color: 'blue', cleared: undefined }, false);

    expect(runtime.relation).toBe(schema.presence);
    expect(runtime.fields).toEqual(fields);
    expect(runtime.source.relationNames).toEqual(['presence']);
    expect(runtime.target.relationNames).toEqual(['presence']);
    expect(runtime.target.ownsRelation?.('presence')).toBe(true);
    expect(runtime.getLocalState()).toEqual({ color: 'blue' });
    expect(runtime.getPeerStates()).toEqual([]);
    expect(runtime.source.rows(schema.presence)).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({
      version: { revision: 0, localPeerId: 'peer-local' },
      diagnostics: [expect.objectContaining({ code: 'not_implemented' })]
    });
  });

  it('reports presence writes as unimplemented and keeps state unchanged', async () => {
    const runtime = presenceRuntime({ color: 'blue' }, false);

    const result = await runtime.target.apply([
      presenceRows.insertOrUpdate(
        { peer: 'peer-local', topic: 'color', payload: 'green' },
        { update: { payload: 'green' } }
      )
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      durability: 'ephemeral',
      diagnostics: [expect.objectContaining({ code: 'not_implemented' })]
    });
    expect(runtime.getLocalState()).toEqual({ color: 'blue' });
  });

  it('omits the write target when no local peer id is provided', () => {
    const runtime = automergePresenceRuntime({
      handle: fakeHandle(),
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels,
      start: false
    });

    expect(runtime.target).toBeUndefined();
    expectTypeOf(runtime).toMatchTypeOf<AutomergePresenceRuntime<PresenceChannels>>();
  });
});

function presenceRuntime(
  initialState: PresenceChannels,
  start: boolean
): AutomergePresenceWritableRuntime<PresenceChannels> {
  return automergePresenceRuntime({
    handle: fakeHandle(),
    relation: schema.presence,
    fields,
    localPeerId: 'peer-local',
    initialState,
    start
  });
}

function fakeHandle() {
  return {
    on: () => {},
    off: () => {},
    broadcast: () => {}
  };
}
