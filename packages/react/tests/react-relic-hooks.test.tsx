import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  TarstateProvider,
  useCommit,
  useDb,
  useQuery,
  useRow,
  useTarstateSnapshot,
  useView,
  useWatch,
  type QueryHookState,
  type RowHookState,
  type TarstateDbSnapshot,
  type ViewHookState,
  type WatchHookState
} from '@tarstate/react';
import { createStore, type Store, type StoreCommitResult } from '@tarstate/core/store';
import { as, eq, from, pipe, project, where, type Query } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { insert, updateByKey } from '@tarstate/core/write';
import { createDb, type Db } from '@tarstate/core/db';
import { materializeSnapshot } from '@tarstate/core/materialization';

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
  it('publishes provider, store, view, query, row, watch, and commit APIs', () => {
    expect(TarstateProvider).toBeTypeOf('function');
    expect(useCommit).toBeTypeOf('function');
    expect(useDb).toBeTypeOf('function');
    expect(useQuery).toBeTypeOf('function');
    expect(useView).toBeTypeOf('function');
    expect(useRow).toBeTypeOf('function');
    expect(useWatch).toBeTypeOf('function');
  });

  it('renders core view rows and commits through the provider Store', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    await expect(store.query(schema.items)).resolves.toMatchObject({
      rows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    await expect(store.query(schema.items)).resolves.toMatchObject({
      rows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    const probe = await renderProbe(store);

    await waitFor(() => probe.query.status === 'ready');

    expect(probe.db).toBe(store.getSnapshot().db);
    expect(probe.view).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-a', label: 'Alpha', done: false }],
      revision: 0
    });
    expect(probe.view.queryKey).toBe(probe.view.view?.queryKey);
    expect(probe.query.rows).toEqual([{ id: 'item-a', label: 'Alpha', done: false }]);
    expect(probe.query.data).toEqual(['Alpha']);
    expect(probe.snapshot.revision).toBe(0);

    let result: StoreCommitResult | undefined;
    await act(async () => {
      result = await probe.commit(insert(schema.items, { id: 'item-b', label: 'Beta', done: true }));
    });
    await waitFor(() => probe.query.revision === 1 && probe.query.status === 'ready');

    expect(result).toMatchObject({
      kind: 'tarstateCommit',
      status: 'accepted',
      reflected: true,
      effects: {
        patches: 1,
        applied: 1
      },
      snapshot: {
        revision: 1
      }
    });
    expect(probe.query.rows).toEqual([
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: true }
    ]);
    expect(probe.view.rows).toEqual(probe.query.rows);
  });

  it('selects a single row by predicate or explicit key mapper', async () => {
    const store = createStore({
      items: [
        { id: 'item-a', label: 'Alpha', done: false },
        { id: 'item-b', label: 'Beta', done: true }
      ]
    });
    const probe = await renderRowProbe(store);

    await waitFor(() => probe.byPredicate.status === 'ready' && probe.byKey.status === 'ready');

    expect(probe.byPredicate.row).toEqual({ id: 'item-a', label: 'Alpha', done: false });
    expect(probe.byKey.row).toEqual({ id: 'item-b', label: 'Beta', done: true });

    await act(async () => {
      await store.commit(updateByKey(schema.items, 'item-a', { done: true }));
    });
    await waitFor(() => probe.byPredicate.revision === 1 && probe.byPredicate.status === 'ready');

    expect(probe.byPredicate.row).toBeUndefined();
    expect(probe.byKey.row).toEqual({ id: 'item-b', label: 'Beta', done: true });
  });

  it('does not publish rejected commits', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    let publishes = 0;
    const unsubscribe = store.subscribe(() => {
      publishes += 1;
    });

    const result = await store.commit(insert(schema.items, { id: 'item-a', label: 'Duplicate', done: true }));

    expect(result.status).toBe('rejected');
    expect(result.reflected).toBe(false);
    expect(result.effects.applied).toBe(0);
    expect(store.getSnapshot().revision).toBe(0);
    expect(publishes).toBe(0);

    unsubscribe();
  });

  it('closes core Stores idempotently and suppresses future notifications', async () => {
    const store = createStore({ items: [] });
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

    await store.commit(insert(schema.items, { id: 'item-a', label: 'Alpha', done: false }));

    expect(store.getSnapshot().revision).toBe(1);
    expect(store.getSnapshot().db.data.items).toEqual([
      { id: 'item-a', label: 'Alpha', done: false }
    ]);
    expect(notified).toEqual([]);
    expect(lateUnsubscribe()).toBeUndefined();
  });

  it('reads and refreshes materialized query rows through useView', async () => {
    const db = await materializeSnapshot(createDb({
      items: [
        { id: 'item-a', label: 'Alpha', done: false },
        { id: 'item-b', label: 'Beta', done: true }
      ]
    }), openItemQuery, { id: 'open-items' });
    const store = createStore(db);
    const probe = await renderMaterializedProbe(store, openItemQuery);

    await waitFor(() => probe.view.status === 'ready');

    expect(probe.view).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-a', label: 'Alpha' }],
      revision: 0
    });

    await act(async () => {
      await store.commit(updateByKey(schema.items, 'item-b', { done: false }));
    });
    await waitFor(() => probe.view.revision === 1 && probe.view.status === 'ready');

    expect(probe.view.rows).toEqual([
      { id: 'item-a', label: 'Alpha' },
      { id: 'item-b', label: 'Beta' }
    ]);
  });

  it('delivers watch-derived notifications when transactions change query rows', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    const probe = await renderWatchProbe(store, itemQuery);

    await waitFor(() => probe.watch.event !== undefined);
    expect(probe.watch.event).toMatchObject({
      changed: true,
      added: [{ id: 'item-a', label: 'Alpha', done: false }]
    });

    await act(async () => {
      await store.commit(insert(schema.items, { id: 'item-b', label: 'Beta', done: false }));
    });
    await waitFor(() => probe.watch.event?.rows.length === 2);

    expect(probe.watch.event).toMatchObject({
      changed: true,
      added: [{ id: 'item-b', label: 'Beta', done: false }],
      previousRows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
  });

  it('watches typed relation refs and reports updated rows', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    let current: WatchHookState<ItemRow> | undefined;
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      current = useWatch(schema.items, undefined, { keyBy: ['id'] });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
    });
    await waitFor(() => current?.event !== undefined);

    expect(current?.event).toMatchObject({
      added: [{ id: 'item-a', label: 'Alpha', done: false }],
      removed: []
    });

    await act(async () => {
      await store.commit(updateByKey(schema.items, 'item-a', { label: 'Alpha updated' }));
    });
    await waitFor(() => current?.event?.rowChanges.some((change) => change.kind === 'updated') === true);

    expect(current?.event).toMatchObject({
      added: [{ id: 'item-a', label: 'Alpha updated', done: false }],
      removed: [{ id: 'item-a', label: 'Alpha', done: false }]
    });

    assertDefined(renderer);
    renderer.unmount();
  });

  it('updates watch listeners on transactions and cleans up after unmount', async () => {
    const store = createStore({
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

    await waitFor(() => listenerEvents.length === 1 && current?.event !== undefined);
    expect(listenerEvents[0]).toMatchObject({
      changed: true,
      added: [{ id: 'item-a', label: 'Alpha', done: false }]
    });

    await act(async () => {
      await store.commit(insert(schema.items, { id: 'item-b', label: 'Beta', done: false }));
    });
    await waitFor(() => listenerEvents.length === 2 && current?.event?.rows.length === 2);

    expect(listenerEvents.at(-1)).toMatchObject({
      changed: true,
      added: [{ id: 'item-b', label: 'Beta', done: false }],
      removed: []
    });

    assertDefined(renderer);
    const mountedRenderer = renderer;
    await act(async () => {
      mountedRenderer.unmount();
    });
    await act(async () => {
      await store.commit(insert(schema.items, { id: 'item-c', label: 'Gamma', done: false }));
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
    await waitFor(() => probe.query.revision === 0 && probe.query.status === 'ready');

    expect(probe.query.rows).toEqual([{ id: 'item-b', label: 'Beta', done: true }]);
    expect(probe.snapshot.db.data.items).toEqual(secondDb.items);
  });

  it('creates a fresh provider-owned Store after rendering with a caller Store', async () => {
    const firstDb = {
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    };
    const callerStore = createStore({
      items: [{ id: 'item-b', label: 'Beta', done: true }]
    });
    const nextDb = {
      items: [{ id: 'item-c', label: 'Gamma', done: false }]
    };
    const probe = await renderProviderDbProbe(firstDb);

    await waitFor(() => probe.query.status === 'ready');
    expect(probe.query.rows).toEqual([{ id: 'item-a', label: 'Alpha', done: false }]);

    await act(async () => {
      probe.renderer.update(createElement(TarstateProvider, { store: callerStore }, createElement(probe.Component)));
    });
    await waitFor(() => probe.query.rows.some((row) => row.id === 'item-b') && probe.query.status === 'ready');

    await act(async () => {
      probe.renderer.update(createElement(TarstateProvider, { db: nextDb }, createElement(probe.Component)));
    });
    await waitFor(() => probe.query.rows.some((row) => row.id === 'item-c') && probe.query.status === 'ready');

    expect(probe.query.rows).toEqual([{ id: 'item-c', label: 'Gamma', done: false }]);
    expect(probe.snapshot.db.data.items).toEqual(nextDb.items);
  });
});

type ProbeState = {
  readonly db: Db;
  readonly view: ViewHookState<ItemProjection>;
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
  readonly snapshot: TarstateDbSnapshot;
  readonly commit: Store['commit'];
};

type RenderedProbe = ProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderProbe(store: Store): Promise<RenderedProbe> {
  let current: ProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      db: useDb(),
      view: useView(itemQuery),
      query: useQuery(itemQuery, { select: (rows) => rows.map((row) => row.label) }),
      snapshot: useTarstateSnapshot(),
      commit: useCommit()
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

type RowProbeState = {
  readonly byPredicate: RowHookState<ItemProjection>;
  readonly byKey: RowHookState<ItemProjection>;
};

type RenderedRowProbe = RowProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderRowProbe(store: Store): Promise<RenderedRowProbe> {
  let current: RowProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      byPredicate: useRow(itemQuery, (row) => !row.done),
      byKey: useRow(itemQuery, 'item-b', { keyBy: (row) => row.id })
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
  readonly view: ViewHookState<{ readonly id: string; readonly label: string }>;
};

type RenderedMaterializedProbe = MaterializedProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderMaterializedProbe(
  store: Store,
  query: Query<{ readonly id: string; readonly label: string }>
): Promise<RenderedMaterializedProbe> {
  let current: MaterializedProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      view: useView(query)
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
  store: Store,
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
