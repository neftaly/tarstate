import type { DocHandle } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineSchema, idField, jsonField, optional, relation, stringField, type JsonValue } from '@tarstate/core/schema';
import {
  automergePresenceRuntime,
  defaultAutomergePresenceClearedValue,
  type AutomergePresenceFieldNames,
  type AutomergePresenceRuntime,
  type AutomergePresenceRuntimeOptions,
  type AutomergePresenceWritableRuntime
} from '@tarstate/automerge/presence';

type PresenceRow = {
  readonly peer: string;
  readonly topic: string;
  readonly payload?: JsonValue;
};

type PresenceChannels = Record<string, JsonValue | undefined>;
type PresenceDoc = {
  readonly presence?: PresenceChannels;
};

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

const docHandle = undefined as unknown as DocHandle<PresenceDoc>;

describe('automerge presence subpath API contract', () => {
  it('keeps presence exports on the ./presence subpath as API stubs', async () => {
    const rootApi = await import('@tarstate/automerge');
    const presenceApi = await import('@tarstate/automerge/presence');

    expect(presenceApi.automergePresenceRuntime).toBe(automergePresenceRuntime);
    expect(presenceApi.defaultAutomergePresenceClearedValue).toBe(defaultAutomergePresenceClearedValue);
    expect('automergePresenceRuntime' in rootApi).toBe(false);
    expect(defaultAutomergePresenceClearedValue(undefined)).toBe(true);
    expect(defaultAutomergePresenceClearedValue(null)).toBe(false);
    expect(() => automergePresenceRuntime({
      handle: docHandle,
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels
    })).toThrow(/not implemented/);
  });

  it('requires an honest DocHandle and no constructor start option', () => {
    const runtimeOptions = {
      handle: docHandle,
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels
    } satisfies AutomergePresenceRuntimeOptions<PresenceChannels, PresenceDoc>;
    const fakeHandle = {
      on: () => {},
      off: () => {},
      broadcast: () => {}
    };
    const fakeHandleOptions = {
      // @ts-expect-error presence handle must be a real DocHandle type.
      handle: fakeHandle,
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels
    } satisfies AutomergePresenceRuntimeOptions<PresenceChannels, PresenceDoc>;
    const legacyStartOptions = {
      handle: docHandle,
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels,
      // @ts-expect-error start option was removed; call runtime.start() explicitly.
      start: true
    } satisfies AutomergePresenceRuntimeOptions<PresenceChannels, PresenceDoc>;

    void runtimeOptions;
    void fakeHandleOptions;
    void legacyStartOptions;
  });

  it('keeps explicit presence lifecycle and writable return types', () => {
    const createRuntime = () => automergePresenceRuntime({
      handle: docHandle,
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels
    });
    const createWritableRuntime = () => automergePresenceRuntime({
      handle: docHandle,
      relation: schema.presence,
      fields,
      localPeerId: 'peer-local',
      initialState: { color: 'blue' } satisfies PresenceChannels
    });

    expectTypeOf(createRuntime).returns.toMatchTypeOf<AutomergePresenceRuntime<PresenceChannels>>();
    expectTypeOf(createWritableRuntime).returns.toMatchTypeOf<AutomergePresenceWritableRuntime<PresenceChannels>>();
    expectTypeOf<AutomergePresenceRuntime<PresenceChannels>['start']>().toEqualTypeOf<() => void>();
    expectTypeOf<AutomergePresenceRuntime<PresenceChannels>['stop']>().toEqualTypeOf<() => void>();
  });
});
