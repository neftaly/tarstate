import { Fragment, createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { TarstateDiagnostic } from '@tarstate/core';
import {
  TarstateProvider,
  useCommit,
  useDb,
  useQuery,
  useRow,
  useTarstateSnapshot,
  useTarstateMutation,
  useTarstateStore,
  useView,
  type QueryHookState,
  type RowHookState,
  type TarstateCommit,
  type TarstateDbInput,
  type TarstateDbSnapshot,
  type TarstateMutationState,
  type TarstateProviderProps,
  type TarstateReactDiagnostic,
  type UseQueryOptions,
  type UseQuerySelectedOptions,
  type UseViewOptions,
  type ViewHookState
} from '@tarstate/react';
import type { Db } from '@tarstate/core/db';
import { createStore, type Store, type StoreCommitResult, type StoreSnapshot, type StoreView, type StoreViewSnapshot } from '@tarstate/core/store';
import { as, from, pipe, project, queryKey } from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import type { RelationRef } from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';
import { replaceAll, type WritePatch } from '@tarstate/core/write';

type ItemRow = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
};

type MembershipRow = {
  readonly orgId: string;
  readonly itemId: string;
  readonly role: string;
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
const relationKeySchema = defineSchema({
  memberships: relation<MembershipRow, readonly ['orgId', 'itemId']>({
    key: ['orgId', 'itemId'],
    fields: {
      orgId: idField('org'),
      itemId: idField('item'),
      role: stringField()
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

describe('@tarstate/react API contract', () => {
  it('exports the provider and hook entry points', () => {
    expect(TarstateProvider).toBeTypeOf('function');
    expect(useTarstateStore).toBeTypeOf('function');
    expect(useTarstateSnapshot).toBeTypeOf('function');
    expect(useDb).toBeTypeOf('function');
    expect(useCommit).toBeTypeOf('function');
    expect(useTarstateMutation).toBeTypeOf('function');
    expect(useView).toBeTypeOf('function');
    expect(useRow).toBeTypeOf('function');
    expect(useQuery).toBeTypeOf('function');
  });

  it('keeps the provider seed API explicit', () => {
    assertType(() => expectTypeOf<TarstateProviderProps>().toMatchTypeOf<{
      readonly store?: Store;
      readonly initialDb?: TarstateDbInput;
      readonly resetKey?: string | number;
      readonly children?: unknown;
    }>());
    assertType(() => expectTypeOf<TarstateDbInput>().toMatchTypeOf<Parameters<typeof createStore>[0]>());
    assertType(() => expectTypeOf<TarstateDbSnapshot>().toMatchTypeOf<ReturnType<Store['getSnapshot']>>());
    assertType(() => expectTypeOf<TarstateCommit>().toEqualTypeOf<Store['commit']>());
    assertType(() => expectTypeOf<TarstateReactDiagnostic>().toEqualTypeOf<TarstateDiagnostic>());

    createElement(TarstateProvider, { initialDb: { items: [] }, resetKey: 'seed-a' });

    // @ts-expect-error provider seed prop was renamed to initialDb
    createElement(TarstateProvider, { db: { items: [] } });
  });

  it('keeps hook state shapes slim', () => {
    assertType(() => expectTypeOf<ViewHookState<ItemProjection>>()
      .toEqualTypeOf<Pick<StoreViewSnapshot<ItemProjection>, 'rows' | 'diagnostics' | 'revision' | 'queryKey'> & {
        readonly refresh: () => void;
      }>());
    assertType(() => expectTypeOf<QueryHookState<ItemProjection>>().toEqualTypeOf<{
      readonly data: readonly ItemProjection[];
      readonly diagnostics: readonly TarstateReactDiagnostic[];
      readonly queryKey: string;
      readonly revision: number;
      readonly refresh: () => void;
    }>());
    assertType(() => expectTypeOf<RowHookState<ItemProjection>>().toEqualTypeOf<{
      readonly row: ItemProjection | undefined;
      readonly diagnostics: readonly TarstateReactDiagnostic[];
      readonly queryKey: string;
      readonly revision: number;
      readonly refresh: () => void;
    }>());
    assertType(() => expectTypeOf<TarstateMutationState>().toEqualTypeOf<{
      readonly commit: TarstateCommit;
      readonly pending: boolean;
      readonly error: unknown;
      readonly result: StoreCommitResult | undefined;
      readonly reset: () => void;
    }>());

    const view = {} as ViewHookState<ItemProjection>;
    const query = {} as QueryHookState<ItemProjection>;

    assertType(() => {
      // @ts-expect-error hook status was removed
      return view.status;
    });
    assertType(() => {
      // @ts-expect-error internal StoreView is no longer exposed
      return view.view;
    });
    assertType(() => {
      // @ts-expect-error internal StoreViewSnapshot is no longer exposed
      return view.snapshot;
    });
    assertType(() => {
      // @ts-expect-error StoreViewSnapshot version is not exposed through React hook state
      return view.version;
    });
    assertType(() => {
      // @ts-expect-error query rows are exposed as data
      return query.rows;
    });
    assertType(() => {
      // @ts-expect-error query result is only passed to select
      return query.result;
    });
  });

  it('keeps view/query options resetKey-based', () => {
    assertType(() => expectTypeOf<UseViewOptions>().toEqualTypeOf<{
      readonly resetKey?: string | number;
    }>());
    assertType(() => expectTypeOf<UseQuerySelectedOptions<ItemProjection, readonly string[]>>()
      .toMatchTypeOf<UseQueryOptions<ItemProjection, readonly string[]>>());

    const defaultQueryOptions = {
      select: (rows) => rows
    } satisfies UseQueryOptions<ItemProjection>;
    assertType(() => expectTypeOf(defaultQueryOptions.select)
      .toEqualTypeOf<(rows: readonly ItemProjection[]) => readonly ItemProjection[]>());

    const queryOptions = {
      resetKey: 'labels',
      select: (rows, result) => rows.map((row) => `${row.label}:${result.diagnostics.length}`),
      equality: (left, right) => left.length === right.length
        && left.every((item, index) => item === right[index])
    } satisfies UseQueryOptions<ItemProjection, readonly string[]>;
    expect(queryOptions.select).toBeTypeOf('function');
    expect(queryOptions.equality).toBeTypeOf('function');

    function InvalidOptionsProbe() {
      // @ts-expect-error deps was removed; use resetKey for explicit view recreation
      useView(itemQuery, { deps: [] });
      // @ts-expect-error query deps was removed; use resetKey for explicit view recreation
      useQuery(itemQuery, { deps: [] });
      return null;
    }

    expect(InvalidOptionsProbe).toBeTypeOf('function');
  });

  it('keeps useRow relation keys and predicate selection without keyBy', () => {
    function TypeProbe() {
      const byRelationKey = useRow(schema.items, 'item-a');
      const byQueryPredicate = useRow(itemQuery, (row) => row.id === 'item-a');
      const byCompositeRelationKey = useRow(relationKeySchema.memberships, ['org-a', 'item-a']);
      assertType(() => expectTypeOf(byRelationKey).toEqualTypeOf<RowHookState<ItemRow>>());
      assertType(() => expectTypeOf(byQueryPredicate).toEqualTypeOf<RowHookState<ItemProjection>>());
      assertType(() => expectTypeOf(byCompositeRelationKey).toEqualTypeOf<RowHookState<MembershipRow>>());

      // @ts-expect-error relation keys must match the relation key value
      useRow(schema.items, 1);
      // @ts-expect-error composite relation keys must include each key field
      useRow(relationKeySchema.memberships, ['org-a']);
      // @ts-expect-error keyBy was removed; use useRow(relation, key) or useRow(query, predicate)
      useRow(itemQuery, 'item-a', { keyBy: (row: ItemProjection) => row.id });

      return null;
    }

    expect(TypeProbe).toBeTypeOf('function');
  });
});

describe('@tarstate/react hooks', () => {
  it('reads view, query, and row state from core store views', () => {
    const fake = createFakeItemStore([
      { id: 'item-a', label: 'Alpha' },
      { id: 'item-b', label: 'Beta' }
    ]);
    const states: {
      view?: ViewHookState<ItemProjection>;
      query?: QueryHookState<ItemProjection, readonly string[]>;
      rowByPredicate?: RowHookState<ItemProjection>;
      rowByRelation?: RowHookState<ItemRow>;
    } = {};

    function Probe() {
      states.view = useView(itemQuery);
      states.query = useQuery(itemQuery, {
        select: (rows, result) => rows.map((row) => `${row.label}:${result.revision}:${result.diagnostics.length}`)
      });
      states.rowByPredicate = useRow(itemQuery, (row) => row.id === 'item-b');
      states.rowByRelation = useRow(schema.items, 'item-a');
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(TarstateProvider, { store: fake.store }, createElement(Probe)));
    });

    expect(states.view?.rows).toEqual([
      { id: 'item-a', label: 'Alpha' },
      { id: 'item-b', label: 'Beta' }
    ]);
    expect(states.query?.data).toEqual(['Alpha:0:0', 'Beta:0:0']);
    expect(states.rowByPredicate?.row).toEqual({ id: 'item-b', label: 'Beta' });
    expect(states.rowByRelation?.row).toEqual({ id: 'item-a', label: 'Alpha' });

    act(() => {
      fake.setRows([{ id: 'item-c', label: 'Gamma' }]);
    });

    expect(states.view?.revision).toBe(1);
    expect(states.view?.rows).toEqual([{ id: 'item-c', label: 'Gamma' }]);
    expect(states.query?.data).toEqual(['Gamma:1:0']);
    expect(states.rowByPredicate?.row).toBeUndefined();
    expect(states.rowByRelation?.row).toBeUndefined();

    states.view?.refresh();
    expect(fake.viewRefreshes()).toBeGreaterThan(0);

    act(() => {
      renderer?.unmount();
    });
  });

  it('exposes commit, snapshot, and db updates from the active store', async () => {
    const fake = createFakeItemStore([{ id: 'item-a', label: 'Alpha' }]);
    const states: {
      commit?: TarstateCommit;
      snapshot?: TarstateDbSnapshot;
      db?: Db;
      labels?: readonly string[];
    } = {};

    function Probe() {
      states.commit = useCommit();
      states.snapshot = useTarstateSnapshot();
      states.db = useDb();
      states.labels = useQuery(itemQuery, {
        select: (rows) => rows.map((row) => row.label)
      }).data;
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(TarstateProvider, { store: fake.store }, createElement(Probe)));
    });

    expect(states.snapshot?.revision).toBe(0);
    expect(states.db?.data.items).toEqual([{ id: 'item-a', label: 'Alpha' }]);
    expect(states.labels).toEqual(['Alpha']);

    if (states.commit === undefined) throw new Error('commit hook was not captured');
    await act(async () => {
      await states.commit?.(replaceAll(schema.items, [{ id: 'item-b', label: 'Beta' }]));
    });

    expect(states.snapshot?.revision).toBe(1);
    expect(states.db?.data.items).toEqual([{ id: 'item-b', label: 'Beta' }]);
    expect(states.labels).toEqual(['Beta']);

    act(() => {
      renderer?.unmount();
    });
  });

  it('tracks mutation pending and result state around commits', async () => {
    const fake = createFakeItemStore([{ id: 'item-a', label: 'Alpha' }]);
    const deferred = createDeferred<StoreCommitResult>();
    const result: StoreCommitResult = {
      status: 'accepted',
      reflected: true,
      effects: {
        patches: 1,
        applied: 1,
        deltas: [],
        diagnostics: []
      },
      snapshot: fake.store.getSnapshot(),
      diagnostics: []
    };
    const store = {
      ...fake.store,
      commit: vi.fn(async () => deferred.promise) as Store['commit']
    } satisfies Store;
    const states: TarstateMutationState[] = [];

    function Probe() {
      states.push(useTarstateMutation());
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
    });

    expect(states.at(-1)?.pending).toBe(false);
    expect(states.at(-1)?.result).toBeUndefined();

    let commitPromise: Promise<StoreCommitResult> | undefined;
    act(() => {
      commitPromise = states.at(-1)?.commit(replaceAll(schema.items, [{ id: 'item-b', label: 'Beta' }]));
    });

    expect(store.commit).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.pending).toBe(true);
    expect(states.at(-1)?.result).toBeUndefined();

    await act(async () => {
      deferred.resolve(result);
      await commitPromise;
    });

    expect(states.at(-1)?.pending).toBe(false);
    expect(states.at(-1)?.result).toBe(result);
    expect(states.at(-1)?.error).toBeUndefined();

    act(() => {
      states.at(-1)?.reset();
    });

    expect(states.at(-1)?.pending).toBe(false);
    expect(states.at(-1)?.result).toBeUndefined();

    act(() => {
      renderer?.unmount();
    });
  });

  it('keeps selected query data stable across unrelated rerenders', () => {
    const fake = createFakeItemStore([{ id: 'item-a', label: 'Alpha' }]);
    const select = vi.fn((rows: readonly ItemProjection[]) => rows.map((row) => row.label));
    const selectedRefs: unknown[] = [];

    function Probe({ tick }: { readonly tick: number }) {
      const state = useQuery(itemQuery, { select });
      selectedRefs.push(state.data);
      return createElement('span', undefined, tick);
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(
        TarstateProvider,
        { store: fake.store },
        createElement(Probe, { tick: 0 })
      ));
    });
    act(() => {
      renderer?.update(createElement(
        TarstateProvider,
        { store: fake.store },
        createElement(Probe, { tick: 1 })
      ));
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(selectedRefs).toHaveLength(2);
    expect(selectedRefs[1]).toBe(selectedRefs[0]);

    act(() => {
      renderer?.unmount();
    });
  });

  it('unmounting useView releases its subscription while a matching useQuery keeps updating', () => {
    const fake = createFakeItemStore([{ id: 'item-a', label: 'Alpha' }]);
    const states: {
      viewRows?: readonly ItemProjection[];
      queryLabels?: string;
    } = {};

    function ViewProbe() {
      states.viewRows = useView(itemQuery).rows;
      return null;
    }

    function QueryProbe() {
      states.queryLabels = useQuery(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      }).data;
      return null;
    }

    function App({ showView }: { readonly showView: boolean }) {
      return createElement(
        TarstateProvider,
        { store: fake.store },
        createElement(
          Fragment,
          undefined,
          showView ? createElement(ViewProbe, { key: 'view' }) : null,
          createElement(QueryProbe, { key: 'query' })
        )
      );
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(App, { showView: true }));
    });

    expect(states.viewRows).toEqual([{ id: 'item-a', label: 'Alpha' }]);
    expect(states.queryLabels).toBe('Alpha');
    expect(fake.viewStats().map((stats) => stats.activeListeners)).toEqual([1, 1]);

    act(() => {
      renderer?.update(createElement(App, { showView: false }));
    });

    const afterUnmount = fake.viewStats();
    const unmountedViewReads = afterUnmount[0]?.snapshotReads;
    expect(afterUnmount.map((stats) => stats.activeListeners)).toEqual([0, 1]);
    expect(unmountedViewReads).toBeGreaterThan(0);

    act(() => {
      fake.setRows([{ id: 'item-b', label: 'Beta' }]);
    });

    const afterUpdate = fake.viewStats();
    expect(afterUpdate[0]?.snapshotReads).toBe(unmountedViewReads);
    expect(afterUpdate[1]?.snapshotReads).toBeGreaterThan(afterUnmount[1]?.snapshotReads ?? 0);
    expect(states.queryLabels).toBe('Beta');

    act(() => {
      renderer?.unmount();
    });
  });

  it('unmounting useQuery releases its subscription while a matching useView keeps updating', () => {
    const fake = createFakeItemStore([{ id: 'item-a', label: 'Alpha' }]);
    const states: {
      viewLabels?: string;
      queryLabels?: string;
    } = {};

    function ViewProbe() {
      states.viewLabels = useView(itemQuery).rows.map((row) => row.label).join('|');
      return null;
    }

    function QueryProbe() {
      states.queryLabels = useQuery(itemQuery, {
        select: (rows) => rows.map((row) => row.label).join('|')
      }).data;
      return null;
    }

    function App({ showQuery }: { readonly showQuery: boolean }) {
      return createElement(
        TarstateProvider,
        { store: fake.store },
        createElement(
          Fragment,
          undefined,
          createElement(ViewProbe, { key: 'view' }),
          showQuery ? createElement(QueryProbe, { key: 'query' }) : null
        )
      );
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(App, { showQuery: true }));
    });

    expect(states.viewLabels).toBe('Alpha');
    expect(states.queryLabels).toBe('Alpha');
    expect(fake.viewStats().map((stats) => stats.activeListeners)).toEqual([1, 1]);

    act(() => {
      renderer?.update(createElement(App, { showQuery: false }));
    });

    const afterUnmount = fake.viewStats();
    const unmountedQueryReads = afterUnmount[1]?.snapshotReads;
    expect(afterUnmount.map((stats) => stats.activeListeners)).toEqual([1, 0]);
    expect(unmountedQueryReads).toBeGreaterThan(0);

    act(() => {
      fake.setRows([{ id: 'item-b', label: 'Beta' }]);
    });

    const afterUpdate = fake.viewStats();
    expect(afterUpdate[0]?.snapshotReads).toBeGreaterThan(afterUnmount[0]?.snapshotReads ?? 0);
    expect(afterUpdate[1]?.snapshotReads).toBe(unmountedQueryReads);
    expect(states.viewLabels).toBe('Beta');

    act(() => {
      renderer?.unmount();
    });
  });
});

function assertType(assertion: () => void): void {
  expect(assertion).not.toThrow();
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FakeItemStore = {
  readonly store: Store;
  readonly setRows: (rows: readonly ItemRow[]) => void;
  readonly viewRefreshes: () => number;
  readonly viewStats: () => readonly FakeItemViewStats[];
};

type FakeItemViewStats = {
  readonly activeListeners: number;
  readonly snapshotReads: number;
  readonly refreshes: number;
};

function createFakeItemStore(initialRows: readonly ItemRow[]): FakeItemStore {
  let rows = initialRows;
  let revision = 0;
  let db = createItemDb(rows);
  let closeCalls = 0;
  const diagnostics: readonly TarstateDiagnostic[] = [];
  const storeListeners = new Set<() => void>();
  const views: { readonly listeners: Set<() => void>; refreshes: number; snapshotReads: number }[] = [];
  const source: RelationSource = {
    relationNames: ['items'],
    rows: (relationRef) => relationRef.name === 'items' ? rows : []
  };
  const getSnapshot = (): StoreSnapshot => ({ db, source, revision, diagnostics });
  const notify = (): void => {
    for (const listener of storeListeners) listener();
    for (const view of views) {
      for (const listener of view.listeners) listener();
    }
  };
  const setRows = (nextRows: readonly ItemRow[]): void => {
    rows = nextRows;
    db = createItemDb(rows);
    revision += 1;
    notify();
  };
  const commit = (async (inputOrInputs: unknown): Promise<StoreCommitResult> => {
    const patches = fakeWritePatches(inputOrInputs);
    const replaceAllPatch = patches.find(isItemsReplaceAllPatch);
    if (replaceAllPatch !== undefined) setRows(replaceAllPatch.rows as readonly ItemRow[]);

    return {
      status: 'accepted',
      reflected: true,
      effects: {
        patches: patches.length,
        applied: patches.length,
        deltas: [],
        diagnostics
      },
      snapshot: getSnapshot(),
      diagnostics
    };
  }) as Store['commit'];
  const createView = <Row,>(query: Query<Row>): StoreView<Row> => {
    const key = queryKey(query);
    const viewState = { listeners: new Set<() => void>(), refreshes: 0, snapshotReads: 0 };
    const view: StoreView<Row> = {
      query,
      queryKey: key,
      getSnapshot: () => {
        viewState.snapshotReads += 1;
        return {
          rows: rows as readonly Row[],
          diagnostics,
          revision,
          queryKey: key
        };
      },
      subscribe: (listener) => {
        viewState.listeners.add(listener);
        return () => {
          viewState.listeners.delete(listener);
        };
      },
      refresh: async () => {
        viewState.refreshes += 1;
        return view.getSnapshot();
      }
    };

    views.push(viewState);
    return view;
  };
  const store = {
    getSnapshot,
    subscribe: (listener) => {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
    query: <Row,>(_target: Query<Row> | RelationRef, _options?: unknown) => ({
      rows: rows as readonly Row[],
      diagnostics,
      revision
    }),
    queries: (() => {
      throw new Error('fake store does not implement queries');
    }) as Store['queries'],
    whatIf: (() => {
      throw new Error('fake store does not implement whatIf');
    }) as Store['whatIf'],
    view: createView,
    commit,
    refresh: async () => getSnapshot(),
    close: () => {
      closeCalls += 1;
    }
  } satisfies Store;

  expect(closeCalls).toBe(0);
  return {
    store,
    setRows,
    viewRefreshes: () => views.reduce((total, view) => total + view.refreshes, 0),
    viewStats: () => views.map((view) => ({
      activeListeners: view.listeners.size,
      snapshotReads: view.snapshotReads,
      refreshes: view.refreshes
    }))
  };
}

function createItemDb(rows: readonly ItemRow[]): Db {
  return {
    data: { items: rows },
    env: {}
  };
}

function fakeWritePatches(input: unknown): readonly WritePatch[] {
  if (Array.isArray(input)) return input.flatMap((item) => fakeWritePatches(item));
  return isWritePatch(input) ? [input] : [];
}

function isWritePatch(input: unknown): input is WritePatch {
  return typeof input === 'object'
    && input !== null
    && 'op' in input
    && typeof input.op === 'string';
}

function isItemsReplaceAllPatch(
  patch: WritePatch
): patch is WritePatch & { readonly op: 'replaceAll'; readonly rows: readonly unknown[] } {
  return patch.op === 'replaceAll' && patch.relation.name === 'items';
}
