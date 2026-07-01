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
import type {
  AdapterCommitResult,
  RelationAdapter,
  RelationApplyDurability,
  RelationDelta,
  RelationPatchTarget,
  RelationRuntime
} from '@tarstate/core/adapter';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { createDb, dbSource, tryTransact, type Db, type DbInputData } from '@tarstate/core/db';
import type { EvaluateOptions, QueryResult } from '@tarstate/core/evaluate';
import { queryKey, type ExprData, type ProjectionData, type Query, type QueryData } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import type { MaybePromise, RelationSource } from '@tarstate/core/source';
import type {
  StoreCommitInput as CoreStoreCommitInput,
  StoreCommitResult as CoreStoreCommitResult
} from '@tarstate/core/store';
import { writeInputPatches, type WritePatch } from '@tarstate/core/write';

export type TarstateReactDiagnostic = TarstateDiagnostic | {
  readonly code: string;
  readonly message: string;
  readonly relation?: string;
  readonly field?: string;
  readonly key?: string;
  readonly detail?: unknown;
};

export type QueryBatch = Record<string, Query>;
export type TarstateQueryResult<Row = unknown> = Omit<QueryResult<Row>, 'diagnostics'> & {
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};
export type QueryBatchResult<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: TarstateQueryResult<Queries[Key] extends Query<infer Row> ? Row : never>;
};

export type TarstateSnapshot<Version = unknown> = {
  readonly source: RelationSource;
  readonly revision: number;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly version?: Version;
};

export type TarstateDbSnapshot = TarstateSnapshot & {
  readonly db: Db;
};

export type TarstateCommitResult<Snapshot extends TarstateSnapshot = TarstateSnapshot> =
  CoreStoreCommitResult<Snapshot, TarstateReactDiagnostic>;
export type TarstateCommitInput = CoreStoreCommitInput;

export type TarstateQueryOptions<Row = unknown, MappedRow = Row> = EvaluateOptions & {
  readonly mapRows?: (rows: readonly Row[]) => readonly MappedRow[];
};
type TarstateMappedQueryOptions<Row, MappedRow> = TarstateQueryOptions<Row, MappedRow> & {
  readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
};

export type TarstateStoreView<Row = unknown, Snapshot extends TarstateSnapshot = TarstateSnapshot> = {
  readonly kind: 'view';
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: {
    <MappedRow>(options: TarstateQueryOptions<Row, MappedRow> & {
      readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
    }): Promise<TarstateQueryResult<MappedRow>>;
    (options?: TarstateQueryOptions<Row>): Promise<TarstateQueryResult<Row>>;
  };
  readonly rows: {
    <MappedRow>(options: TarstateQueryOptions<Row, MappedRow> & {
      readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
    }): Promise<readonly MappedRow[]>;
    (options?: TarstateQueryOptions<Row>): Promise<readonly Row[]>;
  };
  readonly refresh: (options?: TarstateQueryOptions<Row>) => Promise<TarstateQueryResult<Row>>;
};

export type TarstateStore<Snapshot extends TarstateSnapshot = TarstateSnapshot> = {
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly query?: {
    <Row, MappedRow>(query: Query<Row>, options: TarstateQueryOptions<Row, MappedRow> & {
      readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
    }): Promise<TarstateQueryResult<MappedRow>>;
    <Row>(query: Query<Row>, options?: TarstateQueryOptions<Row>): Promise<TarstateQueryResult<Row>>;
  };
  readonly queryMany?: <const Queries extends QueryBatch>(
    queries: Queries,
    options?: EvaluateOptions
  ) => Promise<QueryBatchResult<Queries>>;
  readonly view?: <Row>(query: Query<Row>) => TarstateStoreView<Row, Snapshot>;
  readonly commit: (patches: TarstateCommitInput) => Promise<TarstateCommitResult<Snapshot>>;
  readonly refresh: () => Promise<void>;
};

export type SourceStoreSnapshot<Version = unknown> = {
  readonly source: RelationSource;
  readonly version?: Version;
  readonly diagnostics?: readonly TarstateDiagnostic[];
};
export type SourceStoreSnapshotInput<Version = unknown> = RelationSource | SourceStoreSnapshot<Version>;

export type SourceStoreOptions<Version = unknown> = {
  readonly getSource: () => RelationSource;
  readonly getSnapshot?: () => SourceStoreSnapshotInput<Version>;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly getVersion?: () => MaybePromise<Version>;
};

type WritableSourceStoreOptions<Version = unknown> = SourceStoreOptions<Version> & {
  readonly target?: RelationPatchTarget<Version>;
  readonly commit?: (patches: readonly WritePatch[]) => MaybePromise<AdapterCommitResult<Version>>;
};

type TarstateCommitShellResult<Snapshot extends TarstateSnapshot> =
  Omit<TarstateCommitResult<Snapshot>, 'snapshot'> & {
    readonly snapshot?: Snapshot;
  };

export type TarstateProviderProps<Store extends TarstateStore = TarstateStore> = {
  readonly store: Store;
  readonly children?: ReactNode;
};

export type UseQueryOptions<Row, Selected> = EvaluateOptions & {
  readonly deps?: readonly unknown[];
  readonly select?: (rows: readonly Row[], result: TarstateQueryResult<Row>) => Selected;
};
type UseQuerySelectedOptions<Row, Selected> = EvaluateOptions & {
  readonly deps?: readonly unknown[];
  readonly select: (rows: readonly Row[], result: TarstateQueryResult<Row>) => Selected;
};

export type QueryHookState<Row, Selected = readonly Row[]> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly rows: readonly Row[];
  readonly data: Selected | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly result?: TarstateQueryResult<Row>;
  readonly error?: unknown;
};

export type QueriesHookState<Queries extends QueryBatch> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly results: QueryBatchResult<Queries> | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly revision: number;
  readonly refresh: () => void;
  readonly error?: unknown;
};

const TarstateContext = createContext<TarstateStore | undefined>(undefined);
const emptyDiagnostics: readonly TarstateReactDiagnostic[] = Object.freeze([]);
const emptyDeps: readonly unknown[] = Object.freeze([]);

export function createDbStore(
  input: Db | DbInputData = createDb()
): TarstateStore<TarstateDbSnapshot> {
  let db = isDb(input) ? input : createDb(input);
  return createSimpleStore(dbSnapshot(db, 0, []), (patches, current) => {
    const result = tryTransact(db, patches);
    if (result.committed) {
      db = result.db;
    }
    return {
      ...commitResult(result.committed ? 'accepted' : 'rejected', {
        patches: result.patches,
        applied: result.applied,
        deltas: result.deltas
      }, result.diagnostics),
      ...(result.committed ? { snapshot: dbSnapshot(db, current.revision + 1, result.diagnostics) } : {})
    };
  });
}

export function createAdapterStore<Version>(
  adapter: RelationAdapter<Version>
): TarstateStore<TarstateSnapshot<Version>> {
  return createSourceStoreInternal(sourceStoreOptionsForAdapter(adapter));
}

export function createRuntimeStore<Version>(
  runtime: RelationRuntime<Version>
): TarstateStore<TarstateSnapshot<Version>> {
  return createSourceStoreInternal(sourceStoreOptionsForRuntime(runtime));
}

export function createSourceStore<Version = unknown>(
  options: SourceStoreOptions<Version>
): TarstateStore<TarstateSnapshot<Version>> {
  return createSourceStoreInternal(options);
}

export function TarstateProvider<Store extends TarstateStore>({
  children,
  store
}: TarstateProviderProps<Store>) {
  return createElement(TarstateContext.Provider, { value: store }, children);
}

export function useTarstateStore<Store extends TarstateStore = TarstateStore>(): Store {
  const store = useContext(TarstateContext);
  if (store === undefined) {
    throw new Error('useTarstateStore requires a TarstateProvider');
  }
  return store as Store;
}

export function useTarstateSnapshot<Snapshot extends TarstateSnapshot = TarstateSnapshot>(): Snapshot {
  const store = useTarstateStore<TarstateStore<Snapshot>>();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useTarstateQuery<Row>(
  query: Query<Row>,
  options?: Omit<UseQueryOptions<Row, readonly Row[]>, 'select'>
): QueryHookState<Row>;
export function useTarstateQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQuerySelectedOptions<Row, Selected>
): QueryHookState<Row, Selected>;
export function useTarstateQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQueryOptions<Row, Selected> = {}
): QueryHookState<Row, readonly Row[] | Selected> {
  const store = useTarstateStore();
  const snapshot = useTarstateSnapshot();
  const queryKeyValue = queryKey(query);
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [asyncState, setAsyncState] = useState<QueryHookInternalState<Row, readonly Row[] | Selected> | undefined>();
  const lastReady = useRef<QueryHookState<Row, readonly Row[] | Selected> | undefined>(undefined);
  const pending = useRef<PendingQueryEvaluation<Row, readonly Row[] | Selected> | undefined>(undefined);
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);
  const key = {
    store,
    revision: snapshot.revision,
    queryKey: queryKeyValue,
    depsVersion,
    refreshVersion
  };
  let renderState: QueryHookState<Row, readonly Row[] | Selected>;

  if (isMatchingQueryState(asyncState, key)) {
    if (asyncState.status === 'ready') {
      lastReady.current = withQueryRefresh(asyncState, refresh);
    }
    renderState = withQueryRefresh(asyncState, refresh);
  } else {
    const evaluated = evaluateQueryHookState(snapshot, query, queryKeyValue, options, refresh, lastReady.current);
    if (isPromiseLike(evaluated)) {
      pending.current = { ...key, promise: evaluated };
      renderState = loadingQueryState(queryKeyValue, snapshot.revision, refresh, lastReady.current);
    } else {
      if (evaluated.status === 'ready') {
        lastReady.current = evaluated;
      }
      renderState = evaluated;
    }
  }

  useEffect(() => {
    if (isMatchingQueryState(asyncState, key)) {
      return;
    }

    const current = pending.current;
    const evaluation = current !== undefined && isMatchingPendingQuery(current, key)
      ? current.promise
      : evaluateQueryHookState(snapshot, query, queryKeyValue, options, refresh, lastReady.current);

    if (!isPromiseLike(evaluation)) {
      setAsyncState({ ...evaluation, store, depsVersion, refreshVersion });
      return;
    }

    let active = true;
    evaluation.then(
      (nextState) => {
        if (active) {
          setAsyncState({ ...nextState, store, depsVersion, refreshVersion });
        }
      },
      (error: unknown) => {
        if (active) {
          setAsyncState({
            ...errorQueryState(queryKeyValue, snapshot.revision, refresh, error, lastReady.current),
            store,
            depsVersion,
            refreshVersion
          });
        }
      }
    );

    return () => {
      active = false;
    };
  }, [store, snapshot, queryKeyValue, depsVersion, refreshVersion, asyncState]);

  return renderState;
}

export function useTarstateQueries<const Queries extends QueryBatch>(
  queries: Queries,
  options: EvaluateOptions & { readonly deps?: readonly unknown[] } = {}
): QueriesHookState<Queries> {
  const store = useTarstateStore();
  const snapshot = useTarstateSnapshot();
  const depsVersion = useDependencyVersion(options.deps ?? emptyDeps);
  const batchKey = queryBatchKey(queries);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [asyncState, setAsyncState] = useState<QueriesHookInternalState<Queries> | undefined>();
  const pending = useRef<PendingQueriesEvaluation<Queries> | undefined>(undefined);
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);
  const key = {
    store,
    revision: snapshot.revision,
    queryKey: batchKey,
    depsVersion,
    refreshVersion
  };
  let renderState: QueriesHookState<Queries>;

  if (isMatchingQueriesState(asyncState, key)) {
    renderState = withQueriesRefresh(asyncState, refresh);
  } else {
    const evaluated = evaluateQueriesHookState(snapshot, queries, refresh);
    if (isPromiseLike(evaluated)) {
      pending.current = { ...key, promise: evaluated };
      renderState = loadingQueriesState(snapshot.revision, refresh);
    } else {
      renderState = evaluated;
    }
  }

  useEffect(() => {
    if (isMatchingQueriesState(asyncState, key)) {
      return;
    }

    const current = pending.current;
    const evaluation = current !== undefined && isMatchingPendingQueries(current, key)
      ? current.promise
      : evaluateQueriesHookState(snapshot, queries, refresh);

    if (!isPromiseLike(evaluation)) {
      setAsyncState({ ...evaluation, store, depsVersion, refreshVersion, queryKey: batchKey });
      return;
    }

    let active = true;
    evaluation.then(
      (nextState) => {
        if (active) {
          setAsyncState({ ...nextState, store, depsVersion, refreshVersion, queryKey: batchKey });
        }
      },
      (error: unknown) => {
        if (active) {
          setAsyncState({
            ...errorQueriesState(snapshot.revision, refresh, error),
            store,
            depsVersion,
            refreshVersion,
            queryKey: batchKey
          });
        }
      }
    );

    return () => {
      active = false;
    };
  }, [store, snapshot, batchKey, depsVersion, refreshVersion, asyncState]);

  return renderState;
}

export function useTarstateCommit<Snapshot extends TarstateSnapshot = TarstateSnapshot>(): TarstateStore<Snapshot>['commit'] {
  const store = useTarstateStore<TarstateStore<Snapshot>>();
  return useCallback((patches: TarstateCommitInput) => store.commit(patches), [store]);
}

export const useQuery = useTarstateQuery;
export const useQueries = useTarstateQueries;
export const useCommit = useTarstateCommit;

function createSourceStoreInternal<Version = unknown>(
  options: WritableSourceStoreOptions<Version>
): TarstateStore<TarstateSnapshot<Version>> {
  const input = sourceSnapshotInput(options);
  return createSimpleStore(
    sourceSnapshot(input.source, 0, input.diagnostics, input.version),
    async (patches, current) => {
      const patchList = Array.from(writeInputPatches(patches));
      let result: AdapterCommitResult<Version> | undefined;

      try {
        result = options.target === undefined
          ? await options.commit?.(patchList)
          : await options.target.apply(patchList);
      } catch (error) {
        return commitResult('rejected', {
          patches: patchList.length,
          applied: 0,
          deltas: []
        }, [sourceStoreDiagnostic('tarstate React source commit failed', error)]);
      }

      const base = commitResult(result?.status ?? 'rejected', {
        patches: result?.patches ?? patchList.length,
        applied: result?.applied ?? 0,
        deltas: result?.deltas ?? [],
        ...('durability' in (result ?? {}) && result?.durability !== undefined ? { durability: result.durability } : {})
      }, result?.diagnostics ?? [sourceStoreDiagnostic()]);

      return result === undefined || result.status === 'rejected'
        ? base
        : {
            ...base,
            snapshot: await readSourceSnapshot(options, current.revision + 1, result.diagnostics)
          };
    },
    (current) => readSourceSnapshot(options, current.revision + 1),
    options.subscribe
  );
}

function createSimpleStore<Snapshot extends TarstateSnapshot>(
  initialSnapshot: Snapshot,
  applyCommit: (patches: TarstateCommitInput, current: Snapshot) => MaybePromise<TarstateCommitShellResult<Snapshot>>,
  refreshSnapshot?: (current: Snapshot) => MaybePromise<Snapshot>,
  subscribeHost?: (listener: () => void) => () => void
): TarstateStore<Snapshot> {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  let unsubscribeHost: (() => void) | undefined;
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const refresh = async (): Promise<void> => {
    snapshot = refreshSnapshot === undefined
      ? { ...snapshot, revision: snapshot.revision + 1 }
      : await refreshSnapshot(snapshot);
    notify();
  };
  const queryStore = async <Row, MappedRow>(
    query: Query<Row>,
    options?: TarstateQueryOptions<Row, MappedRow>
  ): Promise<TarstateQueryResult<Row> | TarstateQueryResult<MappedRow>> => {
    const result = await evaluateStoreQuery(snapshot, query);
    if (options !== undefined && 'mapRows' in options && options.mapRows !== undefined) {
      return { ...result, rows: options.mapRows(result.rows) };
    }
    return result;
  };
  const queryManyStore = async <const Queries extends QueryBatch>(
    queries: Queries
  ): Promise<QueryBatchResult<Queries>> => await resolveQueryBatch(snapshot, queries);
  const subscribeStore = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      unsubscribeHost = subscribeHost?.(() => {
        void refresh().catch(() => undefined);
      });
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        unsubscribeHost?.();
        unsubscribeHost = undefined;
      }
    };
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: subscribeStore,
    query: queryStore,
    queryMany: queryManyStore,
    view: (query) => createTarstateStoreView(query, () => snapshot, subscribeStore, queryStore),
    commit: async (patches) => {
      const { snapshot: nextSnapshot, ...result } = await applyCommit(patches, snapshot);
      if (nextSnapshot !== undefined) {
        snapshot = nextSnapshot;
        notify();
      }
      return { ...result, snapshot };
    },
    refresh
  };
}

type StoreKey = {
  readonly store: TarstateStore;
  readonly revision: number;
  readonly queryKey: string;
  readonly depsVersion: number;
  readonly refreshVersion: number;
};

type QueryHookInternalState<Row, Selected> = QueryHookState<Row, Selected> & StoreKey;

type QueriesHookInternalState<Queries extends QueryBatch> = QueriesHookState<Queries> & StoreKey;

type PendingQueryEvaluation<Row, Selected> = StoreKey & {
  readonly promise: Promise<QueryHookState<Row, Selected>>;
};

type PendingQueriesEvaluation<Queries extends QueryBatch> = StoreKey & {
  readonly promise: Promise<QueriesHookState<Queries>>;
};

function createTarstateStoreView<Row, Snapshot extends TarstateSnapshot>(
  query: Query<Row>,
  getSnapshot: () => Snapshot,
  subscribe: (listener: () => void) => () => void,
  readQuery: NonNullable<TarstateStore<Snapshot>['query']>
): TarstateStoreView<Row, Snapshot> {
  return {
    kind: 'view',
    query,
    queryKey: queryKey(query),
    getSnapshot,
    subscribe,
    read: readView,
    rows: readRows,
    refresh: async (options = {}) => await readQuery(query, options)
  };

  function readView<MappedRow>(
    options: TarstateMappedQueryOptions<Row, MappedRow>
  ): Promise<TarstateQueryResult<MappedRow>>;
  function readView(options?: TarstateQueryOptions<Row>): Promise<TarstateQueryResult<Row>>;
  function readView<MappedRow>(
    options?: TarstateQueryOptions<Row, MappedRow>
  ): Promise<TarstateQueryResult<Row> | TarstateQueryResult<MappedRow>> {
    if (hasMapRows(options)) {
      return readQuery(query, options);
    }

    return readQuery(query);
  }

  function readRows<MappedRow>(
    options: TarstateMappedQueryOptions<Row, MappedRow>
  ): Promise<readonly MappedRow[]>;
  function readRows(options?: TarstateQueryOptions<Row>): Promise<readonly Row[]>;
  async function readRows<MappedRow>(
    options?: TarstateQueryOptions<Row, MappedRow>
  ): Promise<readonly Row[] | readonly MappedRow[]> {
    if (hasMapRows(options)) {
      return (await readView(options)).rows;
    }

    return (await readView()).rows;
  }
}

function hasMapRows<Row, MappedRow>(
  options: TarstateQueryOptions<Row, MappedRow> | undefined
): options is TarstateMappedQueryOptions<Row, MappedRow> {
  return options?.mapRows !== undefined;
}

function evaluateQueryHookState<Row, Selected>(
  snapshot: TarstateSnapshot,
  query: Query<Row>,
  queryKeyValue: string,
  options: UseQueryOptions<Row, Selected>,
  refresh: () => void,
  previousReady: QueryHookState<Row, Selected | readonly Row[]> | undefined
): QueryHookState<Row, Selected | readonly Row[]> | Promise<QueryHookState<Row, Selected | readonly Row[]>> {
  const result = evaluateStoreQuery(snapshot, query);
  if (isPromiseLike(result)) {
    return result.then(
      (resolved) => readyQueryState(resolved, queryKeyValue, snapshot.revision, refresh, options, previousReady),
      (error: unknown) => errorQueryState(queryKeyValue, snapshot.revision, refresh, error, previousReady)
    );
  }

  return readyQueryState(result, queryKeyValue, snapshot.revision, refresh, options, previousReady);
}

function readyQueryState<Row, Selected>(
  result: TarstateQueryResult<Row>,
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
    diagnostics: emptyDiagnostics,
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
  result?: TarstateQueryResult<Row>
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
  const previousResult = result ?? previousReady?.result;
  return previousResult === undefined ? state : { ...state, result: previousResult };
}

function withQueryRefresh<Row, Selected>(
  state: QueryHookState<Row, Selected>,
  refresh: () => void
): QueryHookState<Row, Selected> {
  return state.refresh === refresh ? state : { ...state, refresh };
}

function isMatchingQueryState<Row, Selected>(
  state: QueryHookInternalState<Row, Selected> | undefined,
  key: StoreKey
): state is QueryHookInternalState<Row, Selected> {
  return state !== undefined &&
    state.store === key.store &&
    state.revision === key.revision &&
    state.queryKey === key.queryKey &&
    state.depsVersion === key.depsVersion &&
    state.refreshVersion === key.refreshVersion;
}

function isMatchingPendingQuery<Row, Selected>(
  state: PendingQueryEvaluation<Row, Selected>,
  key: StoreKey
): boolean {
  return state.store === key.store &&
    state.revision === key.revision &&
    state.queryKey === key.queryKey &&
    state.depsVersion === key.depsVersion &&
    state.refreshVersion === key.refreshVersion;
}

function evaluateQueriesHookState<const Queries extends QueryBatch>(
  snapshot: TarstateSnapshot,
  queries: Queries,
  refresh: () => void
): QueriesHookState<Queries> | Promise<QueriesHookState<Queries>> {
  const results = resolveQueryBatch(snapshot, queries);
  if (isPromiseLike(results)) {
    return results.then(
      (resolved) => readyQueriesState(snapshot.revision, refresh, resolved),
      (error: unknown) => errorQueriesState(snapshot.revision, refresh, error)
    );
  }
  return readyQueriesState(snapshot.revision, refresh, results);
}

function readyQueriesState<const Queries extends QueryBatch>(
  revision: number,
  refresh: () => void,
  results: QueryBatchResult<Queries>
): QueriesHookState<Queries> {
  return {
    status: 'ready',
    results,
    diagnostics: batchDiagnostics(results),
    revision,
    refresh
  };
}

function loadingQueriesState<const Queries extends QueryBatch>(
  revision: number,
  refresh: () => void
): QueriesHookState<Queries> {
  return {
    status: 'loading',
    results: undefined,
    diagnostics: emptyDiagnostics,
    revision,
    refresh
  };
}

function errorQueriesState<const Queries extends QueryBatch>(
  revision: number,
  refresh: () => void,
  error: unknown
): QueriesHookState<Queries> {
  return {
    status: 'error',
    results: undefined,
    diagnostics: emptyDiagnostics,
    revision,
    refresh,
    error
  };
}

function withQueriesRefresh<const Queries extends QueryBatch>(
  state: QueriesHookState<Queries>,
  refresh: () => void
): QueriesHookState<Queries> {
  return state.refresh === refresh ? state : { ...state, refresh };
}

function isMatchingQueriesState<const Queries extends QueryBatch>(
  state: QueriesHookInternalState<Queries> | undefined,
  key: StoreKey
): state is QueriesHookInternalState<Queries> {
  return state !== undefined &&
    state.store === key.store &&
    state.revision === key.revision &&
    state.queryKey === key.queryKey &&
    state.depsVersion === key.depsVersion &&
    state.refreshVersion === key.refreshVersion;
}

function isMatchingPendingQueries<const Queries extends QueryBatch>(
  state: PendingQueriesEvaluation<Queries>,
  key: StoreKey
): boolean {
  return state.store === key.store &&
    state.revision === key.revision &&
    state.queryKey === key.queryKey &&
    state.depsVersion === key.depsVersion &&
    state.refreshVersion === key.refreshVersion;
}

function evaluateStoreQuery<Row>(
  snapshot: TarstateSnapshot,
  query: Query<Row>
): TarstateQueryResult<Row> | Promise<TarstateQueryResult<Row>> {
  const rows = evaluateQueryRows(snapshot.source, query.data, query.relations);
  const diagnostics = readSourceDiagnostics(snapshot.source, snapshot.diagnostics);
  if (isPromiseLike(rows) || isPromiseLike(diagnostics)) {
    return Promise.all([rows, diagnostics]).then(([resolvedRows, resolvedDiagnostics]) => ({
      rows: resolvedRows as readonly Row[],
      diagnostics: resolvedDiagnostics
    }));
  }

  return {
    rows: rows as readonly Row[],
    diagnostics
  };
}

function resolveQueryBatch<const Queries extends QueryBatch>(
  snapshot: TarstateSnapshot,
  queries: Queries
): QueryBatchResult<Queries> | Promise<QueryBatchResult<Queries>> {
  const keys = objectKeys(queries);
  const entries = keys.map((key) => [key, evaluateStoreQuery(snapshot, queries[key] as Queries[typeof key])] as const);
  if (entries.some(([, result]) => isPromiseLike(result))) {
    return Promise.all(entries.map(async ([key, result]) => [key, await result] as const)).then((resolved) =>
      Object.fromEntries(resolved) as QueryBatchResult<Queries>
    );
  }

  return Object.fromEntries(entries) as QueryBatchResult<Queries>;
}

function evaluateQueryRows(
  source: RelationSource,
  data: QueryData,
  relations: Record<string, RelationRef>
): readonly unknown[] | Promise<readonly unknown[]> {
  switch (data.op) {
    case 'from': {
      const rows = source.rows(relationFor(data.relation, relations));
      return mapMaybePromise(rows, (resolvedRows) => resolvedRows.map((row) => ({ [data.alias]: row })));
    }
    case 'lookup': {
      const lookupValue = evaluateExpr(data.value, {});
      const relation = relationFor(data.relation, relations);
      const lookupRows = source.lookup?.({ relation, field: data.field, value: lookupValue });
      const rows = lookupRows ?? source.rows(relation);
      return mapMaybePromise(rows, (resolvedRows) =>
        (resolvedRows ?? []).map((row) => ({ [data.alias]: row }))
      );
    }
    case 'constRows':
      return data.rows;
    case 'select': {
      const rows = evaluateQueryRows(source, data.input, relations);
      return mapMaybePromise(rows, (resolvedRows) =>
        resolvedRows.map((row) => projectRow(row as Record<string, unknown>, data.projection))
      );
    }
    case 'keyBy':
    case 'hash':
    case 'btree':
      return evaluateQueryRows(source, data.input, relations);
    case 'limit': {
      const rows = evaluateQueryRows(source, data.input, relations);
      return mapMaybePromise(rows, (resolvedRows) =>
        resolvedRows.slice(data.offset ?? 0, (data.offset ?? 0) + data.count)
      );
    }
    default:
      return [];
  }
}

function projectRow(row: Record<string, unknown>, projection: ProjectionData): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(projection)) {
    output[field] = isOptionalProjection(expr)
      ? evaluateExpr(expr.expr, row)
      : evaluateExpr(expr, row);
  }
  return output;
}

function evaluateExpr(expr: ExprData, row: Record<string, unknown>): unknown {
  switch (expr.op) {
    case 'field': {
      const aliasValue = row[expr.alias];
      if (isRecord(aliasValue)) {
        return aliasValue[expr.field];
      }
      return row[expr.field];
    }
    case 'value':
      return expr.value;
    case 'tuple':
      return expr.items.map((item) => evaluateExpr(item, row));
    default:
      return undefined;
  }
}

function readSourceDiagnostics(
  source: RelationSource,
  snapshotDiagnostics: readonly TarstateReactDiagnostic[]
): readonly TarstateReactDiagnostic[] | Promise<readonly TarstateReactDiagnostic[]> {
  if (source.diagnostics === undefined) {
    return snapshotDiagnostics;
  }

  try {
    const diagnostics = source.diagnostics();
    return mapMaybePromise(diagnostics, (resolved) => [...snapshotDiagnostics, ...resolved]);
  } catch (error) {
    return [...snapshotDiagnostics, sourceStoreDiagnostic('tarstate React source diagnostics failed', error)];
  }
}

function batchDiagnostics<const Queries extends QueryBatch>(
  results: QueryBatchResult<Queries>
): readonly TarstateReactDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: TarstateReactDiagnostic[] = [];
  for (const result of Object.values(results) as TarstateQueryResult<unknown>[]) {
    for (const diagnostic of result.diagnostics) {
      const key = JSON.stringify(diagnostic);
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diagnostic);
      }
    }
  }
  return diagnostics;
}

function relationFor(name: string, relations: Record<string, RelationRef>): RelationRef {
  return relations[name] ?? ({ name, fields: {} } as RelationRef);
}

function mapMaybePromise<Input, Output>(
  input: MaybePromise<Input>,
  map: (input: Input) => Output
): Output | Promise<Output> {
  return isPromiseLike(input) ? input.then(map) : map(input);
}

function isPromiseLike<Value>(input: MaybePromise<Value>): input is Promise<Value> {
  return typeof input === 'object' && input !== null && typeof (input as Promise<Value>).then === 'function';
}

function isOptionalProjection(input: unknown): input is { readonly kind: 'optionalProjection'; readonly expr: ExprData } {
  return isRecord(input) && input.kind === 'optionalProjection' && isRecord(input.expr);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function queryBatchKey(queries: QueryBatch): string {
  return objectKeys(queries).map((key) => `${String(key)}:${queryKey(queries[key] as Query)}`).join('|');
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

function commitResult<Snapshot extends TarstateSnapshot>(
  status: TarstateCommitResult<Snapshot>['status'],
  effects: {
    readonly patches: number;
    readonly applied: number;
    readonly deltas: readonly RelationDelta[];
    readonly durability?: RelationApplyDurability;
  },
  diagnostics: readonly TarstateReactDiagnostic[]
): Omit<TarstateCommitResult<Snapshot>, 'snapshot'> {
  return {
    kind: 'tarstateCommit',
    status,
    reflected: false,
    effects,
    diagnostics
  };
}

function dbSnapshot(db: Db, revision: number, diagnostics: readonly TarstateReactDiagnostic[]): TarstateDbSnapshot {
  return { db, source: dbSource(db), revision, diagnostics };
}

function sourceSnapshot<Version>(
  source: RelationSource,
  revision: number,
  diagnostics: readonly TarstateReactDiagnostic[],
  version?: Version
): TarstateSnapshot<Version> {
  return {
    source,
    revision,
    diagnostics,
    ...(version === undefined ? {} : { version })
  };
}

function sourceSnapshotInput<Version>(options: SourceStoreOptions<Version>): {
  readonly source: RelationSource;
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly version?: Version;
} {
  const input = options.getSnapshot === undefined ? options.getSource() : options.getSnapshot();
  if (typeof input === 'object' && input !== null && 'source' in input) {
    return {
      source: input.source,
      diagnostics: input.diagnostics ?? [],
      ...(input.version === undefined ? {} : { version: input.version })
    };
  }
  return { source: input, diagnostics: [] };
}

async function readSourceSnapshot<Version>(
  options: SourceStoreOptions<Version>,
  revision: number,
  extraDiagnostics: readonly TarstateReactDiagnostic[] = []
): Promise<TarstateSnapshot<Version>> {
  const input = sourceSnapshotInput(options);
  const diagnostics = [...input.diagnostics, ...extraDiagnostics];

  try {
    const version = input.version ?? await options.getVersion?.();
    return sourceSnapshot(input.source, revision, diagnostics, version);
  } catch (error) {
    return sourceSnapshot(
      input.source,
      revision,
      [...diagnostics, sourceStoreDiagnostic('tarstate React source version failed', error)],
      input.version
    );
  }
}

function sourceStoreOptionsForAdapter<Version>(adapter: RelationAdapter<Version>): WritableSourceStoreOptions<Version> {
  return {
    getSource: () => adapter.source,
    getSnapshot: () => adapter.snapshot?.() ?? adapter.source,
    ...(adapter.subscribe === undefined ? {} : { subscribe: adapter.subscribe }),
    ...(adapter.target === undefined ? { commit: adapter.commit } : { target: adapter.target })
  };
}

function sourceStoreOptionsForRuntime<Version>(runtime: RelationRuntime<Version>): WritableSourceStoreOptions<Version> {
  return {
    getSource: () => runtime.source,
    getSnapshot: () => runtime.snapshot?.() ?? runtime.source,
    ...(runtime.subscribe === undefined ? {} : { subscribe: runtime.subscribe }),
    ...(runtime.target === undefined ? {} : { target: runtime.target })
  };
}

function sourceStoreDiagnostic(
  message = 'tarstate React implementation has been removed; regenerate this API implementation',
  detail?: unknown
): TarstateReactDiagnostic {
  return {
    code: 'source_error',
    message,
    ...(detail === undefined ? {} : { detail })
  };
}

function objectKeys<ObjectValue extends object>(input: ObjectValue): (keyof ObjectValue)[] {
  return Object.keys(input) as (keyof ObjectValue)[];
}

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}
