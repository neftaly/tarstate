import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import {
  q,
  type Db,
  type DbInputData
} from '@tarstate/core/db';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import type { EvaluateOptions } from '@tarstate/core/evaluate';
import { queryKey, type Query } from '@tarstate/core/query';
import {
  readMaterializedQuery,
  type MaterializationDiagnostic,
  type MaterializedQueryResult
} from '@tarstate/core/materialization';
import {
  createStore,
  type Store,
  type StoreDiagnostic,
  type StoreQueryResult,
  type StoreView,
  type StoreSeedInput,
  type StoreSnapshot
} from '@tarstate/core/store';

export type TarstateReactDiagnostic =
  | TarstateDiagnostic
  | StoreDiagnostic
  | MaterializationDiagnostic
  | {
      readonly code: string;
      readonly message: string;
      readonly surface?: string;
      readonly detail?: unknown;
    };

export type TarstateDbInput = StoreSeedInput | DbInputData;

export type TarstateDbSnapshot = StoreSnapshot;
export type TarstateCommit = Store['commit'];

export type TarstateProviderProps = {
  readonly store?: Store;
  readonly db?: TarstateDbInput;
  readonly children?: ReactNode;
};

export type UseQueryOptions<Row, Selected> = EvaluateOptions & {
  readonly deps?: readonly unknown[];
  readonly select?: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

export type UseViewOptions = {
  readonly deps?: readonly unknown[];
};

type UseQuerySelectedOptions<Row, Selected> = UseQueryOptions<Row, Selected> & {
  readonly select: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

export type ViewHookState<Row> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly view?: StoreView<Row>;
  readonly snapshot?: ReactStoreViewSnapshot<Row>;
  readonly error?: unknown;
};

export type QueryHookState<Row, Selected = readonly Row[]> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly rows: readonly Row[];
  readonly data: Selected | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly result?: StoreQueryResult<Row>;
  readonly error?: unknown;
};

export type RowHookState<Row> = Omit<ViewHookState<Row>, 'rows'> & {
  readonly row: Row | undefined;
};

export type UseRowKeyOptions<Row, Key> = UseViewOptions & {
  readonly keyBy: (row: Row) => Key;
};

export type MaterializedHookState<Row> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly materialized: boolean;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly result?: MaterializedQueryResult<Row>;
  readonly error?: unknown;
};

export type WatchEvent<Row = unknown> = {
  readonly kind: 'watchEvent';
  readonly id: string;
  readonly target: Query<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly unknown[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};

export type WatchHookState<Row> = {
  readonly event: WatchEvent<Row> | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};

export type WatchListener<Row = unknown> = (event: WatchEvent<Row>) => void | Promise<void>;

export type WatchOptions<Row = unknown> = EvaluateOptions & {
  readonly label?: string;
  readonly immediate?: boolean;
  readonly keyBy?: readonly string[] | ((row: Row) => unknown);
};

const TarstateContext = createContext<Store | undefined>(undefined);
const emptyDiagnostics: readonly TarstateReactDiagnostic[] = Object.freeze([]);
const emptyDeps: readonly unknown[] = Object.freeze([]);

type ReactStoreViewSnapshot<Row> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly revision: number;
  readonly queryKey: string;
};

type ReactStoreView<Row> = {
  readonly queryKey: string;
  readonly getSnapshot: () => ReactStoreViewSnapshot<Row>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<ReactStoreViewSnapshot<Row>>;
};

export function TarstateProvider({ children, db, store }: TarstateProviderProps) {
  const dbRevision = useDependencyVersion(db === undefined ? emptyDeps : [db]);
  const ownedStore = useRef<{ readonly dbRevision: number; readonly store: Store } | undefined>(undefined);

  if (store === undefined) {
    if (ownedStore.current === undefined || ownedStore.current.dbRevision !== dbRevision) {
      ownedStore.current = { dbRevision, store: createStore(db) };
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
  }, [store, activeStore]);

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
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useDb(): Db {
  return useTarstateSnapshot().db;
}

export function useCommit(): TarstateCommit {
  const store = useTarstateStore();
  return store.commit;
}

export function useView<Row>(
  query: Query<Row>,
  options: UseViewOptions = {}
): ViewHookState<Row> {
  const store = useTarstateStore();
  const view = store.view(query) as unknown as ReactStoreView<Row>;
  const viewSnapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  const key = view.queryKey;
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<ViewRefreshState>();
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);
  useEffect(() => {
    let active = true;
    setState({ status: 'loading', queryKey: key, depsVersion, refreshVersion });
    view.refresh().then(
      () => {
        if (active) {
          setState({ status: 'ready', queryKey: key, depsVersion, refreshVersion });
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ status: 'error', queryKey: key, depsVersion, refreshVersion, error });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [view, key, depsVersion, refreshVersion]);

  const status = state !== undefined &&
      state.queryKey === key &&
      state.depsVersion === depsVersion &&
      state.refreshVersion === refreshVersion
    ? state.status
    : 'loading';

  return {
    status,
    rows: viewSnapshot.rows,
    diagnostics: viewSnapshot.diagnostics,
    queryKey: key,
    revision: viewSnapshot.revision,
    refresh,
    view: view as unknown as StoreView<Row>,
    snapshot: viewSnapshot,
    ...(status === 'error' && state?.error !== undefined ? { error: state.error } : {})
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
  const { rows: _rows, ...rest } = view;
  return { ...rest, row };
}

export function useQuery<Row>(
  query: Query<Row>,
  options?: Omit<UseQueryOptions<Row, readonly Row[]>, 'select'>
): QueryHookState<Row>;
export function useQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQuerySelectedOptions<Row, Selected>
): QueryHookState<Row, Selected>;
export function useQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQueryOptions<Row, Selected> = {}
): QueryHookState<Row, readonly Row[] | Selected> {
  const store = useTarstateStore();
  const { revision } = useTarstateSnapshot();
  const key = queryKey(query);
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<QueryInternalState<Row, readonly Row[] | Selected>>();
  const lastReady = useRef<QueryHookState<Row, readonly Row[] | Selected> | undefined>(undefined);
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);
  const identity = { store, revision, queryKey: key, depsVersion, refreshVersion };

  useEffect(() => {
    let active = true;
    setState((current) => current !== undefined && matches(current, identity)
      ? current
      : { ...loadingQueryState(key, revision, refresh, lastReady.current), ...identity });
    store.query(query, options).then(
      (result) => {
        if (!active) return;
        const next = readyQueryState(result, key, revision, refresh, options, lastReady.current);
        if (next.status === 'ready') {
          lastReady.current = next;
        }
        setState({ ...next, ...identity });
      },
      (error: unknown) => {
        if (active) {
          setState({ ...errorQueryState(key, revision, refresh, error, lastReady.current), ...identity });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [store, revision, key, depsVersion, refreshVersion]);

  if (state !== undefined && matches(state, identity)) {
    return withQueryRefresh(state, refresh);
  }

  return loadingQueryState(key, revision, refresh, lastReady.current);
}

export function useMaterialized<Row>(
  query: Query<Row>,
  options: { readonly deps?: readonly unknown[] } = {}
): MaterializedHookState<Row> {
  const store = useTarstateStore();
  const { revision } = useTarstateSnapshot();
  const key = queryKey(query);
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<MaterializedInternalState<Row>>();
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);
  const identity = { store, revision, queryKey: key, depsVersion, refreshVersion };

  useEffect(() => {
    let active = true;
    setState((current) => current !== undefined && matches(current, identity)
      ? current
      : { ...loadingMaterializedState(key, revision, refresh), ...identity });
    readMaterializedQuery(store.getSnapshot().db, query).then(
      (result) => {
        if (active) {
          setState({ ...readyMaterializedState(result, key, revision, refresh), ...identity });
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ ...errorMaterializedState(key, revision, refresh, error), ...identity });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [store, revision, key, depsVersion, refreshVersion]);

  if (state !== undefined && matches(state, identity)) {
    return withMaterializedRefresh(state, refresh);
  }

  return loadingMaterializedState(key, revision, refresh);
}

export function useWatch<Row>(
  target: Query<Row>,
  listener?: WatchListener<Row>,
  options: WatchOptions<Row> & { readonly deps?: readonly unknown[] } = {}
): WatchHookState<Row> {
  const { db, revision } = useTarstateSnapshot();
  const targetKey = queryKey(target);
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const [event, setEvent] = useState<WatchEvent<Row> | undefined>();
  const [diagnostics, setDiagnostics] = useState<readonly TarstateReactDiagnostic[]>(emptyDiagnostics);
  const listenerRef = useRef<WatchListener<Row> | undefined>(listener);
  const previousRowsRef = useRef<readonly Row[]>([]);

  listenerRef.current = listener;

  useEffect(() => {
    previousRowsRef.current = [];
    setEvent(undefined);
    setDiagnostics(emptyDiagnostics);
  }, [targetKey, depsVersion]);

  useEffect(() => {
    let active = true;
    q(db, target, options).then(async (result) => {
      if (!active) return;
      const previousRows = previousRowsRef.current;
      const rowDiff = diffRows(previousRows, result.rows, options.keyBy);
      const event: WatchEvent<Row> = {
        kind: 'watchEvent',
        id: `watch-${targetKey}`,
        target,
        changed: rowDiff.added.length > 0 || rowDiff.removed.length > 0,
        previousRows,
        rows: result.rows,
        added: rowDiff.added,
        removed: rowDiff.removed,
        unchanged: rowDiff.unchanged,
        rowChanges: rowDiff.rowChanges,
        diagnostics: result.diagnostics
      };
      previousRowsRef.current = result.rows;
      setEvent(event);
      setDiagnostics(result.diagnostics);
      await listenerRef.current?.(event);
    }, (error: unknown) => {
      if (active) {
        setDiagnostics([reactDiagnostic('tarstate React watch failed', error)]);
      }
    });
    return () => {
      active = false;
    };
  }, [db, revision, targetKey, depsVersion]);

  return {
    event,
    diagnostics
  };
}

function readyQueryState<Row, Selected>(
  result: StoreQueryResult<Row>,
  queryKeyValue: string,
  revision: number,
  refresh: () => void,
  options: UseQueryOptions<Row, Selected>,
  previousReady: QueryHookState<Row, Selected | readonly Row[]> | undefined
): QueryHookState<Row, Selected | readonly Row[]> {
  try {
    const data = options.select === undefined ? result.rows : options.select(result.rows, result);
    return {
      status: 'ready',
      rows: result.rows,
      data,
      diagnostics: result.diagnostics,
      result,
      queryKey: queryKeyValue,
      revision,
      refresh
    };
  } catch (error) {
    return errorQueryState(queryKeyValue, revision, refresh, error, previousReady, result);
  }
}

function loadingQueryState<Row, Selected>(
  queryKeyValue: string,
  revision: number,
  refresh: () => void,
  previousReady: QueryHookState<Row, Selected> | undefined
): QueryHookState<Row, Selected> {
  return {
    status: 'loading',
    rows: previousReady?.rows ?? [],
    data: previousReady?.data,
    diagnostics: previousReady?.diagnostics ?? emptyDiagnostics,
    queryKey: queryKeyValue,
    revision,
    refresh
  };
}

function errorQueryState<Row, Selected>(
  queryKeyValue: string,
  revision: number,
  refresh: () => void,
  error: unknown,
  previousReady: QueryHookState<Row, Selected> | undefined,
  result?: StoreQueryResult<Row>
): QueryHookState<Row, Selected> {
  const state: QueryHookState<Row, Selected> = {
    status: 'error',
    rows: previousReady?.rows ?? result?.rows ?? [],
    data: previousReady?.data,
    diagnostics: result?.diagnostics ?? previousReady?.diagnostics ?? emptyDiagnostics,
    queryKey: queryKeyValue,
    revision,
    refresh,
    error
  };
  return result === undefined ? state : { ...state, result };
}

function withQueryRefresh<Row, Selected>(
  state: QueryHookState<Row, Selected>,
  refresh: () => void
): QueryHookState<Row, Selected> {
  return state.refresh === refresh ? state : { ...state, refresh };
}

function loadingMaterializedState<Row>(
  queryKeyValue: string,
  revision: number,
  refresh: () => void
): MaterializedHookState<Row> {
  return {
    status: 'loading',
    materialized: false,
    rows: [],
    diagnostics: emptyDiagnostics,
    queryKey: queryKeyValue,
    revision,
    refresh
  };
}

function readyMaterializedState<Row>(
  result: MaterializedQueryResult<Row>,
  queryKeyValue: string,
  revision: number,
  refresh: () => void
): MaterializedHookState<Row> {
  return {
    status: 'ready',
    materialized: result.materialized,
    rows: result.rows,
    diagnostics: result.diagnostics,
    result,
    queryKey: queryKeyValue,
    revision,
    refresh
  };
}

function errorMaterializedState<Row>(
  queryKeyValue: string,
  revision: number,
  refresh: () => void,
  error: unknown
): MaterializedHookState<Row> {
  return {
    status: 'error',
    materialized: false,
    rows: [],
    diagnostics: emptyDiagnostics,
    queryKey: queryKeyValue,
    revision,
    refresh,
    error
  };
}

function withMaterializedRefresh<Row>(
  state: MaterializedHookState<Row>,
  refresh: () => void
): MaterializedHookState<Row> {
  return state.refresh === refresh ? state : { ...state, refresh };
}

type Identity = {
  readonly store: Store;
  readonly revision: number;
  readonly queryKey: string;
  readonly depsVersion: number;
  readonly refreshVersion: number;
};

type QueryInternalState<Row, Selected> = QueryHookState<Row, Selected> & Identity;
type MaterializedInternalState<Row> = MaterializedHookState<Row> & Identity;
type ViewRefreshState = {
  readonly status: ViewHookState<unknown>['status'];
  readonly queryKey: string;
  readonly depsVersion: number;
  readonly refreshVersion: number;
  readonly error?: unknown;
};

function matches(state: Identity, identity: Identity): boolean {
  return state.store === identity.store &&
    state.revision === identity.revision &&
    state.queryKey === identity.queryKey &&
    state.depsVersion === identity.depsVersion &&
    state.refreshVersion === identity.refreshVersion;
}

function useDependencyVersion(deps: readonly unknown[]): number {
  const state = useRef<{ readonly deps: readonly unknown[]; version: number }>({ deps, version: 0 });
  if (!shallowEqualDeps(state.current.deps, deps)) {
    state.current = { deps, version: state.current.version + 1 };
  }
  return state.current.version;
}

function shallowEqualDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function hasKeyBy<Row, Key>(options: UseViewOptions | UseRowKeyOptions<Row, Key>): options is UseRowKeyOptions<Row, Key> {
  return 'keyBy' in options;
}

function diffRows<Row>(
  previousRows: readonly Row[],
  rows: readonly Row[],
  keyBy: WatchOptions<Row>['keyBy']
): {
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly unknown[];
} {
  const previousByKey = new Map(previousRows.map((row) => [rowKey(row, keyBy), row]));
  const nextByKey = new Map(rows.map((row) => [rowKey(row, keyBy), row]));
  const added = rows.filter((row) => !previousByKey.has(rowKey(row, keyBy)));
  const removed = previousRows.filter((row) => !nextByKey.has(rowKey(row, keyBy)));
  const unchanged = rows.filter((row) => previousByKey.has(rowKey(row, keyBy)));
  return {
    added,
    removed,
    unchanged,
    rowChanges: [
      ...removed.map((row) => ({ kind: 'removed', key: rowKey(row, keyBy), row })),
      ...added.map((row) => ({ kind: 'added', key: rowKey(row, keyBy), row }))
    ]
  };
}

function rowKey<Row>(row: Row, keyBy: WatchOptions<Row>['keyBy']): string {
  if (typeof keyBy === 'function') return JSON.stringify(keyBy(row));
  if (Array.isArray(keyBy) && isRecord(row)) {
    return JSON.stringify(keyBy.map((field) => row[field]));
  }
  return JSON.stringify(row);
}

function reactDiagnostic(message: string, error: unknown): TarstateReactDiagnostic {
  return {
    code: 'react_error',
    message,
    surface: 'react',
    detail: error
  };
}
