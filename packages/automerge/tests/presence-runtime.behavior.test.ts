import { Repo, type DocHandle } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  numberField,
  optional,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
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
  readonly activeAt?: number;
  readonly seenAt?: number;
  readonly isLocal?: boolean;
};

type PresenceChannels = Record<string, JsonValue | undefined>;
type PresenceDoc = {
  readonly presence?: PresenceChannels;
};

const schema = defineSchema({
  presence: relation<PresenceRow>({
    ephemeral: true,
    key: ['peer', 'topic'] as const,
    fields: {
      peer: idField('peer'),
      topic: stringField(),
      payload: optional(jsonField()),
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

const docHandle = undefined as unknown as DocHandle<PresenceDoc>;

describe('automerge presence runtime', () => {
  it('keeps presence exports on the ./presence subpath', async () => {
    const rootApi = await import('@tarstate/automerge');
    const presenceApi = await import('@tarstate/automerge/presence');
    const runtime = automergePresenceRuntime({
      handle: realDocHandle(),
      relation: schema.presence,
      fields,
      initialState: { color: 'blue' } satisfies PresenceChannels
    });

    expect(presenceApi.automergePresenceRuntime).toBe(automergePresenceRuntime);
    expect(presenceApi.defaultAutomergePresenceClearedValue).toBe(defaultAutomergePresenceClearedValue);
    expect('automergePresenceRuntime' in rootApi).toBe(false);
    expect(defaultAutomergePresenceClearedValue(undefined)).toBe(true);
    expect(defaultAutomergePresenceClearedValue(null)).toBe(false);
    expect(runtime.target).toBeUndefined();
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

  it('starts and stops explicitly and exposes local presence rows when requested', () => {
    const runtime = automergePresenceRuntime({
      handle: realDocHandle(),
      relation: schema.presence,
      fields,
      localPeerId: 'peer-local',
      includeLocalRows: true,
      initialState: { color: 'blue' } satisfies PresenceChannels,
      heartbeatMs: 60_000
    });
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    expect(runtime.source.rows(schema.presence)).toEqual([]);

    runtime.start();

    expect(runtime.getLocalState()).toEqual({ color: 'blue' });
    expect(runtime.source.rows(schema.presence)).toMatchObject([
      { peer: 'peer-local', topic: 'color', payload: 'blue', isLocal: true }
    ]);
    expect(runtime.snapshot().version).toMatchObject({ revision: 1, localPeerId: 'peer-local' });

    runtime.stop();
    unsubscribe();
    expect(notifications).toBe(2);
  });

  it('applies writable presence patches to local state only', async () => {
    const runtime = automergePresenceRuntime({
      handle: realDocHandle(),
      relation: schema.presence,
      fields,
      localPeerId: 'peer-local',
      includeLocalRows: true,
      initialState: { color: 'blue' } satisfies PresenceChannels
    });
    runtime.start();

    const result = await runtime.target.apply([
      write(schema.presence).insertOrReplace({ peer: 'peer-local', topic: 'color', payload: 'red' })
    ]);
    const rejected = await runtime.target.apply([
      write(schema.presence).insertOrReplace({ peer: 'peer-remote', topic: 'color', payload: 'green' })
    ]);
    const deleted = await runtime.target.apply([
      write(schema.presence).deleteByKey(['peer-local', 'color'] as const)
    ]);

    expect(result).toMatchObject({ status: 'accepted', applied: 1, durability: 'ephemeral' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.diagnostics[0]?.code).toBe('runtime_unsupported');
    expect(deleted).toMatchObject({ status: 'accepted', applied: 1 });
    expect(runtime.getLocalState().color).toBeUndefined();
    expect(runtime.source.rows(schema.presence)).toEqual([]);
    runtime.stop();
  });
});

function realDocHandle(): DocHandle<PresenceDoc> {
  const repo = new Repo({ peerId: 'peer-local' as never });
  return repo.create<PresenceDoc>({ presence: {} });
}
