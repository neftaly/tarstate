import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TarstateProvider,
  useCommit,
  useDb,
  useQuery,
  useRow,
  useTarstateSnapshot,
  useTarstateStore,
  useView,
  useWatch,
  type QueryHookState,
  type RowHookState,
  type TarstateCommit,
  type TarstateDbInput,
  type TarstateDbSnapshot,
  type TarstateProviderProps,
  type UseQueryOptions,
  type UseRowKeyOptions,
  type UseViewOptions,
  type ViewHookState,
  type WatchHookState,
  type WatchOptions
} from '@tarstate/react';
import { createStore, type Store } from '@tarstate/core/store';
import { as, from, pipe, project, type Query } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { insert } from '@tarstate/core/write';

type ItemRow = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
};

const schema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField()
    }
  })
});
const item = as(schema.items, 'item');
const itemQuery = pipe(
  from(item),
  project({
    id: item.id,
    label: item.label
  })
);

describe('@tarstate/react future hook facade contract', () => {
  it('keeps the public provider and hook exports available', () => {
    expect(TarstateProvider).toBeTypeOf('function');
    expect(useTarstateStore).toBeTypeOf('function');
    expect(useTarstateSnapshot).toBeTypeOf('function');
    expect(useDb).toBeTypeOf('function');
    expect(useCommit).toBeTypeOf('function');
    expect(useView).toBeTypeOf('function');
    expect(useRow).toBeTypeOf('function');
    expect(useQuery).toBeTypeOf('function');
    expect(useWatch).toBeTypeOf('function');
  });

  it('keeps public state and options types assignable', () => {
    expectTypeOf<TarstateProviderProps>().toMatchTypeOf<{ readonly children?: unknown }>();
    expectTypeOf<TarstateDbInput>().toMatchTypeOf<Parameters<typeof createStore>[0]>();
    expectTypeOf<TarstateDbSnapshot>().toMatchTypeOf<ReturnType<Store['getSnapshot']>>();
    expectTypeOf<TarstateCommit>().toEqualTypeOf<Store['commit']>();
    expectTypeOf<UseViewOptions>().toMatchTypeOf<{ readonly deps?: readonly unknown[] }>();
    const queryOptions = {
      select: (rows, result) => rows.map((row) => `${row.label}:${result.diagnostics.length}`)
    } satisfies UseQueryOptions<ItemProjection, readonly string[]>;
    expect(queryOptions.select).toBeTypeOf('function');
    expectTypeOf<UseRowKeyOptions<ItemProjection, string>>().toMatchTypeOf<{
      readonly keyBy: (row: ItemProjection) => string;
    }>();
    expectTypeOf<WatchOptions<ItemProjection>>().toMatchTypeOf<{
      readonly immediate?: boolean;
      readonly keyBy?: readonly string[] | ((row: ItemProjection) => unknown);
    }>();
  });

  it('throws a clear error when hooks are used outside a provider', async () => {
    function Probe() {
      useTarstateStore();
      return null;
    }

    await expect(act(async () => {
      create(createElement(Probe));
    })).rejects.toThrow('useTarstateStore requires a TarstateProvider');
  });

  it('exposes store, snapshot, db, and commit through the provider context', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha' }]
    });
    let current: {
      readonly store: Store;
      readonly snapshot: TarstateDbSnapshot;
      readonly db: TarstateDbSnapshot['db'];
      readonly commit: TarstateCommit;
    } | undefined;

    function Probe() {
      current = {
        store: useTarstateStore(),
        snapshot: useTarstateSnapshot(),
        db: useDb(),
        commit: useCommit()
      };
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
    });

    assertDefined(current);
    expect(current.store).toBe(store);
    expect(current.snapshot.revision).toBe(store.getSnapshot().revision);
    expect(current.snapshot.db.data).toEqual(store.getSnapshot().db.data);
    expect(current.db.data).toEqual(store.getSnapshot().db.data);
    expect(current.commit).toBe(store.commit);

    renderer?.unmount();
  });

  it('returns synchronous view and query states shaped around StoreView.getSnapshot()', async () => {
    const store = createStore({
      items: [{ id: 'item-a', label: 'Alpha' }]
    });
    const probe = await renderHookProbe(store, itemQuery);

    expect(probe.view.status).toBe('ready');
    expect(probe.view.rows).toBe(probe.view.snapshot.rows);
    expect(probe.view.queryKey).toBe(probe.view.snapshot.queryKey);
    expect(probe.view.view.getSnapshot().queryKey).toBe(probe.view.queryKey);
    expect(probe.query.status).toBe('ready');
    expect(probe.query.rows).toEqual(probe.view.rows);
    expect(probe.query.data).toEqual(probe.query.rows.map((row) => row.label));
    expect(probe.query.result).toEqual({
      rows: probe.query.rows,
      diagnostics: probe.query.diagnostics,
      revision: probe.query.revision
    });

    probe.renderer.unmount();
  });

  it('selects rows from the current synchronous view snapshot', async () => {
    const store = createStore({ items: [] });
    const probe = await renderRowProbe(store);

    expect(probe.byPredicate.status).toBe('ready');
    expect(probe.byKey.status).toBe('ready');
    expect(probe.byPredicate.row).toBeUndefined();
    expect(probe.byKey.row).toBeUndefined();

    probe.renderer.unmount();
  });

  it('keeps useWatch as a typed no-op placeholder until watch reactivity is rebuilt', async () => {
    const store = createStore({ items: [] });
    let current: WatchHookState<ItemProjection> | undefined;
    let renderer: ReactTestRenderer | undefined;

    function Probe() {
      current = useWatch(itemQuery);
      return null;
    }

    await act(async () => {
      renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
    });

    expect(current).toEqual({
      event: undefined,
      diagnostics: []
    });

    renderer?.unmount();
  });

  it('closes provider-owned stores created from initial db on unmount', async () => {
    let ownedStore: Store | undefined;

    function Probe() {
      ownedStore = useTarstateStore();
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(TarstateProvider, { db: { items: [] } }, createElement(Probe)));
    });

    assertDefined(ownedStore);
    await act(async () => {
      renderer?.unmount();
    });

    let notified = false;
    ownedStore.subscribe(() => {
      notified = true;
    });
    await ownedStore.commit(insert(schema.items, { id: 'item-a', label: 'Alpha' }));

    expect(notified).toBe(false);
  });

  it.todo('synchronously exposes evaluated query rows once core StoreView initialization is sync');
  it.todo('delivers watch events once watch reactivity is rebuilt on top of the new core APIs');
});

type HookProbeState = {
  readonly view: ViewHookState<ItemProjection>;
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
};

type RenderedHookProbe = HookProbeState & {
  readonly renderer: ReactTestRenderer;
};

async function renderHookProbe(store: Store, query: Query<ItemProjection>): Promise<RenderedHookProbe> {
  let current: HookProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    current = {
      view: useView(query),
      query: useQuery(query, { select: (rows) => rows.map((row) => row.label) })
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
      byPredicate: useRow(itemQuery, (row) => row.id === 'item-a'),
      byKey: useRow(itemQuery, 'item-a', { keyBy: (row) => row.id })
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

function live<State extends object>(
  current: () => State | undefined,
  renderer: ReactTestRenderer
): State & { readonly renderer: ReactTestRenderer } {
  return new Proxy({} as State & { readonly renderer: ReactTestRenderer }, {
    get(_target, property) {
      if (property === 'renderer') return renderer;
      const state = current();
      assertDefined(state);
      return state[property as keyof State];
    }
  });
}

function assertDefined<Value>(value: Value): asserts value is NonNullable<Value> {
  expect(value).toBeDefined();
}
