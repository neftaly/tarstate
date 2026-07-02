import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DependencyList,
  type ReactElement,
  type ReactNode
} from 'react';
import type { Db } from '@tarstate/core/db';
import { queryKey } from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import {
  createStore,
  type Store,
  type StoreDiagnostic,
  type StoreQueryResult,
  type StoreSeedInput,
  type StoreSnapshot,
  type StoreView,
  type StoreViewSnapshot
} from '@tarstate/core/store';

export type TarstateReactDiagnostic = StoreDiagnostic;

export type TarstateDbInput = StoreSeedInput;
export type TarstateDbSnapshot = StoreSnapshot;
export type TarstateCommit = Store['commit'];

export type TarstateProviderProps = {
  readonly store?: Store;
  readonly db?: TarstateDbInput;
  readonly resetKey?: string | number;
  readonly children?: ReactNode;
};

export type UseViewOptions = {
  readonly deps?: DependencyList;
};

export type UseQueryOptions<Row, Selected = readonly Row[]> = {
  readonly deps?: DependencyList;
  readonly select?: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

export type UseQuerySelectedOptions<Row, Selected> = UseQueryOptions<Row, Selected> & {
  readonly select: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

export type HookStatus = 'ready';

export type ViewHookState<Row> = {
  readonly status: HookStatus;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly view: StoreView<Row>;
  readonly snapshot: StoreViewSnapshot<Row>;
};

export type QueryHookState<Row, Selected = readonly Row[]> = {
  readonly status: HookStatus;
  readonly rows: readonly Row[];
  readonly data: Selected;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly result: StoreQueryResult<Row>;
};

export type RowHookState<Row> = Omit<ViewHookState<Row>, 'rows'> & {
  readonly row: Row | undefined;
};

export type UseRowKeyOptions<Row, Key> = UseViewOptions & {
  readonly keyBy: (row: Row) => Key;
};

const TarstateContext = createContext<Store | undefined>(undefined);
const emptyDeps: DependencyList = Object.freeze([]);

export function TarstateProvider({ children, db, resetKey, store }: TarstateProviderProps): ReactElement {
  const ownedStore = useRef<{ readonly resetKey: string | number | undefined; readonly store: Store } | undefined>(undefined);

  if (store === undefined) {
    if (ownedStore.current === undefined || !Object.is(ownedStore.current.resetKey, resetKey)) {
      ownedStore.current = { resetKey, store: createStore(db) };
    }
  } else {
    ownedStore.current = undefined;
  }

  const activeStore = store ?? ownedStore.current?.store;

  useEffect(() => {
    if (store !== undefined || activeStore === undefined) {
      return;
    }

    return () => {
      activeStore.close();
    };
  }, [activeStore, store]);

  return createElement(TarstateContext.Provider, { value: activeStore }, children);
}

export function useTarstateStore(): Store {
  const store = useContext(TarstateContext);
  if (store === undefined) {
    throw new Error('useTarstateStore requires a TarstateProvider');
  }
  return store;
}

export function useTarstateSnapshot(): TarstateDbSnapshot {
  const store = useTarstateStore();
  const getSnapshot = useStableStoreSnapshot(store);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useDb(): Db {
  return useTarstateSnapshot().db;
}

export function useCommit(): TarstateCommit {
  return useTarstateStore().commit;
}

export function useView<Row>(
  query: Query<Row>,
  options: UseViewOptions = {}
): ViewHookState<Row> {
  const store = useTarstateStore();
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const key = queryKey(query);
  const view = useMemo(() => store.view(query), [store, key, depsVersion]);
  const getSnapshot = useStableViewSnapshot(view);
  const snapshot = useSyncExternalStore(view.subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    void view.refresh();
  }, [view]);

  return {
    status: 'ready',
    rows: snapshot.rows,
    diagnostics: snapshot.diagnostics,
    queryKey: snapshot.queryKey,
    revision: snapshot.revision,
    refresh,
    view,
    snapshot
  };
}

export function useRow<Row>(
  query: Query<Row>,
  predicate: (row: Row) => boolean,
  options?: UseViewOptions
): RowHookState<Row>;
export function useRow<Row, Key>(
  query: Query<Row>,
  key: Key,
  options: UseRowKeyOptions<Row, Key>
): RowHookState<Row>;
export function useRow<Row, Key>(
  query: Query<Row>,
  keyOrPredicate: Key | ((row: Row) => boolean),
  options: UseViewOptions | UseRowKeyOptions<Row, Key> = {}
): RowHookState<Row> {
  const view = useView(query, options);
  const predicate = typeof keyOrPredicate === 'function' && !hasKeyBy(options)
    ? keyOrPredicate as (row: Row) => boolean
    : (row: Row) => Object.is((options as UseRowKeyOptions<Row, Key>).keyBy(row), keyOrPredicate);
  const row = view.rows.find(predicate);

  return {
    status: view.status,
    diagnostics: view.diagnostics,
    queryKey: view.queryKey,
    revision: view.revision,
    refresh: view.refresh,
    view: view.view,
    snapshot: view.snapshot,
    row
  };
}

export function useQuery<Row>(
  query: Query<Row>,
  options?: UseViewOptions
): QueryHookState<Row>;
export function useQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQuerySelectedOptions<Row, Selected>
): QueryHookState<Row, Selected>;
export function useQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQueryOptions<Row, Selected> = {}
): QueryHookState<Row, readonly Row[] | Selected> {
  const view = useView(query, options);
  const result: StoreQueryResult<Row> = {
    rows: view.rows,
    diagnostics: view.diagnostics,
    revision: view.revision
  };
  const data = options.select === undefined ? view.rows : options.select(view.rows, result);

  return {
    status: view.status,
    rows: view.rows,
    data,
    diagnostics: view.diagnostics,
    queryKey: view.queryKey,
    revision: view.revision,
    refresh: view.refresh,
    result
  };
}

function useDependencyVersion(deps: DependencyList): number {
  const state = useRef<{ readonly deps: DependencyList; version: number }>({ deps, version: 0 });
  if (!shallowEqualDeps(state.current.deps, deps)) {
    state.current = { deps, version: state.current.version + 1 };
  }
  return state.current.version;
}

function useStableStoreSnapshot(store: Store): () => StoreSnapshot {
  return useMemo(() => {
    let current = store.getSnapshot();
    return () => {
      const next = store.getSnapshot();
      if (sameStoreSnapshot(current, next)) {
        return current;
      }
      current = next;
      return current;
    };
  }, [store]);
}

function useStableViewSnapshot<Row>(view: StoreView<Row>): () => StoreViewSnapshot<Row> {
  return useMemo(() => {
    let current = view.getSnapshot();
    return () => {
      const next = view.getSnapshot();
      if (sameViewSnapshot(current, next)) {
        return current;
      }
      current = next;
      return current;
    };
  }, [view]);
}

function sameStoreSnapshot(left: StoreSnapshot, right: StoreSnapshot): boolean {
  return left.revision === right.revision
    && left.db === right.db
    && left.version === right.version
    && shallowEqualDiagnostics(left.diagnostics, right.diagnostics);
}

function sameViewSnapshot<Row>(left: StoreViewSnapshot<Row>, right: StoreViewSnapshot<Row>): boolean {
  return left.revision === right.revision
    && left.queryKey === right.queryKey
    && left.db === right.db
    && left.version === right.version
    && shallowEqualDeps(left.rows, right.rows)
    && shallowEqualDiagnostics(left.diagnostics, right.diagnostics);
}

function shallowEqualDiagnostics(
  left: readonly TarstateReactDiagnostic[],
  right: readonly TarstateReactDiagnostic[]
): boolean {
  return left.length === right.length
    && left.every((diagnostic, index) => {
      const other = right[index];
      return other !== undefined
        && diagnostic.code === other.code
        && diagnostic.severity === other.severity
        && diagnostic.message === other.message
        && diagnostic.relation === other.relation
        && diagnostic.field === other.field
        && diagnostic.surface === other.surface
        && Object.is(diagnostic.detail, other.detail);
    });
}

function shallowEqualDeps(left: DependencyList, right: DependencyList): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function hasKeyBy<Row, Key>(options: UseViewOptions | UseRowKeyOptions<Row, Key>): options is UseRowKeyOptions<Row, Key> {
  return 'keyBy' in options;
}
