import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import type { RelationDelta } from '@tarstate/core/adapter';
import {
  createDb,
  q,
  qRows,
  tryTransact,
  type Db,
  type DbInputData,
  type DbQueryOptions,
  type DbTransactionInput,
  type DbTransactionResult,
  type QueryBatch,
  type QueryBatchResult
} from '@tarstate/core/db';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import type { EvaluateOptions, QueryResult } from '@tarstate/core/evaluate';
import { queryKey, type Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import {
  materializeSnapshot,
  readMaterializedQuery,
  type MaterializationDiagnostic,
  type MaterializedQueryResult,
  type SnapshotMaterializationOptions
} from '@tarstate/core/experimental/materialization';

export type TarstateReactDiagnostic =
  | TarstateDiagnostic
  | MaterializationDiagnostic
  | {
      readonly code: string;
      readonly message: string;
      readonly surface?: string;
      readonly detail?: unknown;
    };

export type TarstateDbInput = Db | DbInputData;

export type TarstateDbSnapshot = {
  readonly db: Db;
  readonly revision: number;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};

export type TarstateTransactResult = DbTransactionResult & {
  readonly kind: 'tarstateTransact';
  readonly previousDb: Db;
  readonly revision: number;
  readonly changes: readonly TrackedChange[];
  readonly trackingDiagnostics: readonly TarstateReactDiagnostic[];
};

export type TarstateDbStore = {
  readonly getSnapshot: () => TarstateDbSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly replaceDb: (input: TarstateDbInput, diagnostics?: readonly TarstateReactDiagnostic[]) => Promise<void>;
  readonly query: {
    <Row, MappedRow>(
      query: StoreQueryTarget<Row>,
      options: DbQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
    ): Promise<QueryResult<MappedRow>>;
    <Row>(query: StoreQueryTarget<Row>, options?: DbQueryOptions<Row>): Promise<QueryResult<Row>>;
    <const Queries extends QueryBatch>(queries: Queries, options?: DbQueryOptions): Promise<QueryBatchResult<Queries>>;
  };
  readonly rows: {
    <Row, MappedRow>(
      query: StoreQueryTarget<Row>,
      options: DbQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
    ): Promise<readonly MappedRow[]>;
    <Row>(query: StoreQueryTarget<Row>, options?: DbQueryOptions<Row>): Promise<readonly Row[]>;
  };
  readonly transact: (...inputs: readonly DbTransactionInput[]) => Promise<TarstateTransactResult>;
  readonly materialize: <Row>(
    query: Query<Row>,
    options?: SnapshotMaterializationOptions
  ) => Promise<TarstateDbSnapshot>;
  readonly readMaterialized: <Row>(query: Query<Row>) => Promise<MaterializedQueryResult<Row>>;
};

export type TarstateProviderProps = {
  readonly store?: TarstateDbStore;
  readonly db?: TarstateDbInput;
  readonly children?: ReactNode;
};

export type UseQueryOptions<Row, Selected> = EvaluateOptions & {
  readonly deps?: readonly unknown[];
  readonly select?: (rows: readonly Row[], result: QueryResult<Row>) => Selected;
};

type UseQuerySelectedOptions<Row, Selected> = UseQueryOptions<Row, Selected> & {
  readonly select: (rows: readonly Row[], result: QueryResult<Row>) => Selected;
};

type StoreQueryTarget<Row = unknown> = Query<Row> | RelationRef | string;

export type QueryHookState<Row, Selected = readonly Row[]> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly rows: readonly Row[];
  readonly data: Selected | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly result?: QueryResult<Row>;
  readonly error?: unknown;
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
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly unknown[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};

export type WatchListener<Row = unknown> = (event: WatchEvent<Row>) => void | Promise<void>;

export type WatchOptions<Row = unknown> = EvaluateOptions & {
  readonly label?: string;
  readonly immediate?: boolean;
  readonly keyBy?: readonly string[] | ((row: Row) => unknown);
};

export type TrackedChange<Row = unknown> = {
  readonly kind: 'trackedChange';
  readonly id: string;
  readonly target: string;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly unknown[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};

export type WatchHookState<Row> = {
  readonly event: WatchEvent<Row> | undefined;
  readonly events: readonly WatchEvent<Row>[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};

const TarstateContext = createContext<TarstateDbStore | undefined>(undefined);
const emptyDiagnostics: readonly TarstateReactDiagnostic[] = Object.freeze([]);
const emptyDeps: readonly unknown[] = Object.freeze([]);

export function createDbStore(input: TarstateDbInput = createDb()): TarstateDbStore {
  let snapshot: TarstateDbSnapshot = {
    db: normalizeDb(input),
    revision: 0,
    diagnostics: emptyDiagnostics
  };
  const listeners = new Set<() => void>();
  const materializations = new Map<string, {
    readonly query: Query;
    readonly options: SnapshotMaterializationOptions;
  }>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const publish = async (
    db: Db,
    diagnostics: readonly TarstateReactDiagnostic[] = emptyDiagnostics
  ): Promise<TarstateDbSnapshot> => {
    let nextDb = db;
    for (const entry of materializations.values()) {
      nextDb = await materializeSnapshot(nextDb, entry.query, entry.options);
    }
    snapshot = {
      db: nextDb,
      revision: snapshot.revision + 1,
      diagnostics
    };
    notify();
    return snapshot;
  };

  const store: TarstateDbStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replaceDb: async (input, diagnostics = emptyDiagnostics) => {
      await publish(normalizeDb(input), diagnostics);
    },
    query: ((queryOrQueries: Query | QueryBatch, options?: DbQueryOptions) =>
      queryDb(snapshot.db, queryOrQueries, options)) as TarstateDbStore['query'],
    rows: ((queryValue: Query, options?: DbQueryOptions) =>
      qRows(snapshot.db, queryValue, options)) as TarstateDbStore['rows'],
    transact: async (...inputs) => {
      const previousDb = snapshot.db;
      const result = tryTransact(previousDb, ...inputs);
      if (result.committed) {
        await publish(result.db, result.diagnostics);
      }
      return {
        kind: 'tarstateTransact',
        ...result,
        previousDb,
        revision: snapshot.revision,
        changes: deltasToChanges(result.deltas),
        trackingDiagnostics: result.diagnostics
      };
    },
    materialize: async (queryValue, options = {}) => {
      materializations.set(queryKey(queryValue), { query: queryValue, options });
      return publish(snapshot.db);
    },
    readMaterialized: (queryValue) => readMaterializedQuery(snapshot.db, queryValue)
  };

  return store;
}

export function TarstateProvider({ children, db, store }: TarstateProviderProps) {
  const fallbackStore = useMemo(() => createDbStore(db), []);
  const activeStore = store ?? fallbackStore;
  const dbRevision = useDependencyVersion(db === undefined ? emptyDeps : [db]);
  const previousDb = useRef(db);

  useEffect(() => {
    if (store === undefined && db !== undefined && previousDb.current !== db) {
      void activeStore.replaceDb(db);
    }
    previousDb.current = db;
  }, [activeStore, store, dbRevision]);

  return createElement(TarstateContext.Provider, { value: activeStore }, children);
}

export function useTarstateStore(): TarstateDbStore {
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

export const useTarstateDb = useDb;

export function useTransact(): TarstateDbStore['transact'] {
  const store = useTarstateStore();
  return useCallback((...inputs: readonly DbTransactionInput[]) => store.transact(...inputs), [store]);
}

export const useTarstateTransact = useTransact;

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

export const useTarstateQuery = useQuery;

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
    store.readMaterialized(query).then(
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

export const useTarstateMaterialized = useMaterialized;

export function useWatch<Row>(
  target: Query<Row>,
  listener?: WatchListener<Row>,
  options: WatchOptions<Row> & { readonly deps?: readonly unknown[] } = {}
): WatchHookState<Row> {
  const { db, revision } = useTarstateSnapshot();
  const targetKey = queryKey(target);
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const [events, setEvents] = useState<readonly WatchEvent<Row>[]>([]);
  const [diagnostics, setDiagnostics] = useState<readonly TarstateReactDiagnostic[]>(emptyDiagnostics);
  const listenerRef = useRef<WatchListener<Row> | undefined>(listener);
  const previousRowsRef = useRef<readonly Row[]>([]);

  listenerRef.current = listener;

  useEffect(() => {
    previousRowsRef.current = [];
    setEvents([]);
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
        changed: rowDiff.addedRows.length > 0 || rowDiff.removedRows.length > 0,
        previousRows,
        rows: result.rows,
        addedRows: rowDiff.addedRows,
        removedRows: rowDiff.removedRows,
        unchangedRows: rowDiff.unchangedRows,
        rowChanges: rowDiff.rowChanges,
        diagnostics: result.diagnostics
      };
      previousRowsRef.current = result.rows;
      setEvents((current) => [...current, event]);
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
    event: events.at(-1),
    events,
    diagnostics
  };
}

export const useTarstateWatch = useWatch;

function normalizeDb(input: TarstateDbInput | undefined): Db {
  if (isDb(input)) return input;
  return createDb(input ?? {});
}

function queryDb<Row, MappedRow>(
  db: Db,
  query: StoreQueryTarget<Row>,
  options: DbQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
): Promise<QueryResult<MappedRow>>;
function queryDb<Row>(db: Db, query: StoreQueryTarget<Row>, options?: DbQueryOptions<Row>): Promise<QueryResult<Row>>;
function queryDb<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  options?: DbQueryOptions
): Promise<QueryBatchResult<Queries>>;
function queryDb(
  db: Db,
  queryOrQueries: StoreQueryTarget | QueryBatch,
  options?: DbQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>>;
function queryDb(
  db: Db,
  queryOrQueries: StoreQueryTarget | QueryBatch,
  options?: DbQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  return q(db, queryOrQueries as never, options as never);
}

function readyQueryState<Row, Selected>(
  result: QueryResult<Row>,
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
  result?: QueryResult<Row>
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
  readonly store: TarstateDbStore;
  readonly revision: number;
  readonly queryKey: string;
  readonly depsVersion: number;
  readonly refreshVersion: number;
};

type QueryInternalState<Row, Selected> = QueryHookState<Row, Selected> & Identity;
type MaterializedInternalState<Row> = MaterializedHookState<Row> & Identity;

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

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function diffRows<Row>(
  previousRows: readonly Row[],
  rows: readonly Row[],
  keyBy: WatchOptions<Row>['keyBy']
): {
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly unknown[];
} {
  const previousByKey = new Map(previousRows.map((row) => [rowKey(row, keyBy), row]));
  const nextByKey = new Map(rows.map((row) => [rowKey(row, keyBy), row]));
  const addedRows = rows.filter((row) => !previousByKey.has(rowKey(row, keyBy)));
  const removedRows = previousRows.filter((row) => !nextByKey.has(rowKey(row, keyBy)));
  const unchangedRows = rows.filter((row) => previousByKey.has(rowKey(row, keyBy)));
  return {
    addedRows,
    removedRows,
    unchangedRows,
    rowChanges: [
      ...removedRows.map((row) => ({ kind: 'removed', key: rowKey(row, keyBy), row })),
      ...addedRows.map((row) => ({ kind: 'added', key: rowKey(row, keyBy), row }))
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

function deltasToChanges(deltas: readonly RelationDelta[]): readonly TrackedChange[] {
  return deltas.map((delta, index) => ({
    kind: 'trackedChange',
    id: `delta-${index + 1}`,
    target: delta.relation.name,
    changed: delta.added.length > 0 || delta.removed.length > 0,
    previousRows: delta.removed,
    rows: delta.added,
    addedRows: delta.added,
    removedRows: delta.removed,
    unchangedRows: [],
    rowChanges: [
      ...delta.removed.map((row) => ({ kind: 'removed', key: JSON.stringify(row), row })),
      ...delta.added.map((row) => ({ kind: 'added', key: JSON.stringify(row), row }))
    ],
    diagnostics: []
  }));
}

function reactDiagnostic(message: string, error: unknown): TarstateReactDiagnostic {
  return {
    code: 'react_error',
    message,
    surface: 'react',
    detail: error
  };
}
