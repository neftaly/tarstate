import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createDbStore,
  TarstateProvider,
  useDb,
  useMaterialized,
  useQuery,
  useTarstateDb,
  useTarstateMaterialized,
  useTarstateQuery,
  useTarstateSnapshot,
  useTarstateTransact,
  useTarstateWatch,
  useTransact,
  useWatch,
  type MaterializedHookState,
  type QueryHookState,
  type TarstateDbSnapshot,
  type TarstateDbStore,
  type TarstateTransactResult,
  type WatchHookState
} from '@tarstate/react';
import { as, eq, from, pipe, project, where, type Query } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { insert, updateByKey } from '@tarstate/core/write';
import type { Db } from '@tarstate/core/db';

type ItemRow = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};

const schema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField(),
      done: booleanField()
    }
  })
});
const item = as(schema.items, 'item');
const itemQuery = pipe(
  from(item),
  project({
    id: item.id,
    label: item.label,
    done: item.done
  })
);
const openItemQuery = pipe(
  from(item),
  where(eq(item.done, false)),
  project({
    id: item.id,
    label: item.label
  })
);

describe('@tarstate/react DB-first hooks', () => {
  it('publishes provider, DB store, query, materialized, watch, and transact APIs', () => {
    expect(createDbStore).toBeTypeOf('function');
    expect(TarstateProvider).toBeTypeOf('function');
    expect(useDb).toBe(useTarstateDb);
    expect(useQuery).toBe(useTarstateQuery);
    expect(useTransact).toBe(useTarstateTransact);
    expect(useMaterialized).toBe(useTarstateMaterialized);
    expect(useWatch).toBe(useTarstateWatch);
    expect(createDbStore().close).toBeTypeOf('function');
  });

  it('renders core query rows and transacts through the provider DB', async () => {
    const store = createDbStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    await expect(store.rows(schema.items)).resolves.toEqual([
      { id: 'item-a', label: 'Alpha', done: false }
    ]);
    await expect(store.query('items')).resolves.toMatchObject({
      rows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    const probe = await renderProbe(store);

    await waitFor(() => probe.query.status === 'ready');

    expect(probe.db).toBe(store.getSnapshot().db);
    expect(probe.query.rows).toEqual([{ id: 'item-a', label: 'Alpha', done: false }]);
    expect(probe.query.data).toEqual(['Alpha']);
    expect(probe.snapshot.revision).toBe(0);

    let result: TarstateTransactResult | undefined;
    await act(async () => {
      result = await probe.transact(insert(schema.items, { id: 'item-b', label: 'Beta', done: true }));
    });
    await waitFor(() => probe.query.revision === 1 && probe.query.status === 'ready');

    expect(result).toMatchObject({
      kind: 'tarstateTransact',
      committed: true,
      patches: 1,
      applied: 1,
      revision: 1
    });
    expect(result?.changes).toEqual([
      expect.objectContaining({
        kind: 'trackedChange',
        changed: true,
        addedRows: [{ id: 'item-b', label: 'Beta', done: true }]
      })
    ]);
    expect(probe.query.rows).toEqual([
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: true }
    ]);
  });

  it('does not publish rejected transactions', async () => {
    const store = createDbStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    let publishes = 0;
    const unsubscribe = store.subscribe(() => {
      publishes += 1;
    });

    const result = await store.transact(insert(schema.items, { id: 'item-a', label: 'Duplicate', done: true }));

    expect(result.committed).toBe(false);
    expect(result.applied).toBe(0);
    expect(store.getSnapshot().revision).toBe(0);
    expect(publishes).toBe(0);

    unsubscribe();
  });

  it('closes DB stores idempotently and suppresses future notifications', async () => {
    const store = createDbStore({ items: [] });
    const notified: number[] = [];
    const unsubscribe = store.subscribe(() => {
      notified.push(store.getSnapshot().revision);
    });

    store.close();
    store.close();
    unsubscribe();
    const lateUnsubscribe = store.subscribe(() => {
      notified.push(-1);
    });

    await store.transact(insert(schema.items, { id: 'item-a', label: 'Alpha', done: false }));
    await store.replaceDb({
      items: [{ id: 'item-b', label: 'Beta', done: true }]
    });

    expect(store.getSnapshot().revision).toBe(2);
    expect(store.getSnapshot().db.data.items).toEqual([
      { id: 'item-b', label: 'Beta', done: true }
    ]);
    expect(notified).toEqual([]);
    expect(lateUnsubscribe()).toBeUndefined();
  });

  it('reads and refreshes materialized query rows from core materialization', async () => {
    const store = createDbStore({
      items: [
        { id: 'item-a', label: 'Alpha', done: false },
        { id: 'item-b', label: 'Beta', done: true }
      ]
    });
    await store.materialize(openItemQuery, { id: 'open-items' });
    const probe = await renderMaterializedProbe(store, openItemQuery);

    await waitFor(() => probe.materialized.status === 'ready');

    expect(probe.materialized).toMatchObject({
      status: 'ready',
      materialized: true,
      rows: [{ id: 'item-a', label: 'Alpha' }],
      revision: 1
    });

    await act(async () => {
      await store.transact(updateByKey(schema.items, 'item-b', { done: false }));
    });
    await waitFor(() => probe.materialized.revision === 2 && probe.materialized.status === 'ready');

    expect(probe.materialized.rows).toEqual([
      { id: 'item-a', label: 'Alpha' },
      { id: 'item-b', label: 'Beta' }
    ]);
  });

  it('delivers watch-derived notifications when transactions change query rows', async () => {
    const store = createDbStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    const probe = await renderWatchProbe(store, itemQuery);

    await waitFor(() => probe.watch.events.length === 1);
    expect(probe.watch.event).toMatchObject({
      changed: true,
      addedRows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });

    await act(async () => {
      await store.transact(insert(schema.items, { id: 'item-b', label: 'Beta', done: false }));
    });
    await waitFor(() => probe.watch.events.length === 2);

    expect(probe.watch.event).toMatchObject({
      changed: true,
      addedRows: [{ id: 'item-b', label: 'Beta', done: false }],
      previousRows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
  });

  it('updates watch listeners on transactions and cleans up after unmount', async () => {
    const store = createDbStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    const listenerEvents: Array<NonNullable<WatchHookState<ItemProjection>['event']>> = [];
    let current: WatchHookState<ItemProjection> | undefined;
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      current = useWatch(itemQuery, (event) => {
        listenerEvents.push(event);
      }, { keyBy: ['id'] });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
    });

    await waitFor(() => listenerEvents.length === 1 && current?.events.length === 1);
    expect(listenerEvents[0]).toMatchObject({
      changed: true,
      addedRows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });

    await act(async () => {
      await store.transact(insert(schema.items, { id: 'item-b', label: 'Beta', done: false }));
    });
    await waitFor(() => listenerEvents.length === 2 && current?.events.length === 2);

    expect(listenerEvents.at(-1)).toMatchObject({
      changed: true,
      addedRows: [{ id: 'item-b', label: 'Beta', done: false }],
      removedRows: []
    });

    assertDefined(renderer);
    const mountedRenderer = renderer;
    await act(async () => {
      mountedRenderer.unmount();
    });
    await act(async () => {
      await store.transact(insert(schema.items, { id: 'item-c', label: 'Gamma', done: false }));
      await Promise.resolve();
    });

    expect(store.getSnapshot().revision).toBe(2);
    expect(listenerEvents).toHaveLength(2);
  });

  it('replaces provider-owned DBs without reusing stale query rows', async () => {
    const firstDb = {
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    };
    const secondDb = {
      items: [{ id: 'item-b', label: 'Beta', done: true }]
    };
    const probe = await renderProviderDbProbe(firstDb);

    await waitFor(() => probe.query.status === 'ready');
    expect(probe.query.rows).toEqual([{ id: 'item-a', label: 'Alpha', done: false }]);

    await act(async () => {
      probe.renderer.update(createElement(TarstateProvider, { db: secondDb }, createElement(probe.Component)));
    });
    await waitFor(() => probe.query.revision === 1 && probe.query.status === 'ready');

    expect(probe.query.rows).toEqual([{ id: 'item-b', label: 'Beta', done: true }]);
    expect(probe.snapshot.db.data.items).toEqual(secondDb.items);
  });
});

type ProbeState = {
  readonly db: Db;
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
  readonly snapshot: TarstateDbSnapshot;
  readonly transact: TarstateDbStore['transact'];
};

type RenderedProbe = ProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderProbe(store: TarstateDbStore): Promise<RenderedProbe> {
  let current: ProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      db: useDb(),
      query: useQuery(itemQuery, { select: (rows) => rows.map((row) => row.label) }),
      snapshot: useTarstateSnapshot(),
      transact: useTransact()
    };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(renderer);
  assertDefined(current);
  return live(() => current, renderer);
}

type MaterializedProbeState = {
  readonly materialized: MaterializedHookState<{ readonly id: string; readonly label: string }>;
};

type RenderedMaterializedProbe = MaterializedProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderMaterializedProbe(
  store: TarstateDbStore,
  query: Query<{ readonly id: string; readonly label: string }>
): Promise<RenderedMaterializedProbe> {
  let current: MaterializedProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      materialized: useMaterialized(query)
    };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(renderer);
  assertDefined(current);
  return live(() => current, renderer);
}

type WatchProbeState = {
  readonly watch: WatchHookState<ItemProjection>;
};

type RenderedWatchProbe = WatchProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderWatchProbe(
  store: TarstateDbStore,
  query: Query<ItemProjection>
): Promise<RenderedWatchProbe> {
  let current: WatchProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      watch: useWatch(query, undefined, { keyBy: ['id'] })
    };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(renderer);
  assertDefined(current);
  return live(() => current, renderer);
}

type ProviderDbProbeState = {
  readonly query: QueryHookState<ItemProjection>;
  readonly snapshot: TarstateDbSnapshot;
};

type RenderedProviderDbProbe = ProviderDbProbeState & {
  readonly Component: () => null;
  readonly renderer: ReactTestRenderer;
};

async function renderProviderDbProbe(db: Record<string, readonly ItemRow[]>): Promise<RenderedProviderDbProbe> {
  let current: ProviderDbProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      query: useQuery(itemQuery),
      snapshot: useTarstateSnapshot()
    };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { db }, createElement(Probe)));
  });

  assertDefined(renderer);
  assertDefined(current);
  return Object.assign(live(() => current, renderer), { Component: Probe });
}

function live<State extends object>(
  read: () => State | undefined,
  renderer: ReactTestRenderer
): State & { readonly renderer: ReactTestRenderer } {
  return new Proxy({ renderer } as State & { readonly renderer: ReactTestRenderer }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      const current = read();
      assertDefined(current);
      return Reflect.get(current, property, receiver);
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  expect(predicate()).toBe(true);
}

function assertDefined<Value>(value: Value | undefined): asserts value is Value {
  expect(value).toBeDefined();
}
