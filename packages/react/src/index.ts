import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from 'react';
import type { Db, DbInputData } from '@tarstate/core/db';
import type { TarstateDiagnostic, TarstateDiagnosticMode, TarstateDiagnosticSeverity } from '@tarstate/core/diagnostics';
import type { EvaluateOptions } from '@tarstate/core/evaluate';
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
import type {
  WatchDiagnostic,
  WatchEvent as CoreWatchEvent,
  WatchListener as CoreWatchListener,
  WatchOptions as CoreWatchOptions,
  WatchTarget as CoreWatchTarget
} from '@tarstate/core/watch';

export type TarstateReactDiagnostic =
  | StoreDiagnostic
  | (TarstateDiagnostic & {
      readonly message: string;
      readonly surface?: string;
      readonly detail?: unknown;
    });

export type TarstateDbInput = StoreSeedInput | DbInputData;
export type TarstateDbSnapshot = StoreSnapshot;
export type TarstateCommit = Store['commit'];

export type TarstateProviderProps = {
  readonly store?: Store;
  readonly db?: TarstateDbInput;
  readonly resetKey?: string | number;
  readonly children?: ReactNode;
};

export type HookRuntimeKind = 'syncSeedStore' | 'asyncRuntime';
export type HookDiagnosticErrorPolicy = 'errorSeverityOnly' | 'thrownErrorsOnly' | 'errorSeverityOrThrown';
export type HookStatusOptions = {
  readonly runtimeKind?: HookRuntimeKind;
  readonly diagnosticMode?: TarstateDiagnosticMode;
  readonly errorPolicy?: HookDiagnosticErrorPolicy;
};

export type UseViewOptions = HookStatusOptions & {
  readonly deps?: readonly unknown[];
};

export type UseQueryOptions<Row, Selected> = EvaluateOptions & {
  readonly deps?: readonly unknown[];
  readonly select?: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

type UseQuerySelectedOptions<Row, Selected> = UseQueryOptions<Row, Selected> & {
  readonly select: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

export type HookStatus = 'loading' | 'ready' | 'error';
export type HookStatusMeaning = {
  readonly loading: {
    readonly runtimeKind: 'asyncRuntime';
    readonly description: 'Async runtime or hydration has not produced a readable snapshot yet.';
  };
  readonly ready: {
    readonly runtimeKind: HookRuntimeKind;
    readonly description: 'A synchronous seed store or hydrated async runtime snapshot is readable.';
  };
  readonly error: {
    readonly runtimeKind: HookRuntimeKind;
    readonly diagnosticSeverity: Extract<TarstateDiagnosticSeverity, 'error'>;
    readonly description: 'A thrown read error or error-severity diagnostic should be surfaced through error.';
  };
};

export type ViewHookState<Row> = {
  readonly status: HookStatus;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly view: StoreView<Row>;
  readonly snapshot: StoreViewSnapshot<Row>;
  readonly error?: unknown;
};

export type QueryHookState<Row, Selected = readonly Row[]> = {
  readonly status: HookStatus;
  readonly rows: readonly Row[];
  readonly data: Selected | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
  readonly result: StoreQueryResult<Row>;
  readonly error?: unknown;
};

export type RowHookState<Row> = Omit<ViewHookState<Row>, 'rows'> & {
  readonly row: Row | undefined;
};

export type UseRowKeyOptions<Row, Key> = UseViewOptions & {
  readonly keyBy: (row: Row) => Key;
};

export type WatchTarget<Row = unknown> = CoreWatchTarget<Row>;
export type WatchEvent<Row = unknown> = CoreWatchEvent<Row>;
export type WatchListener<Row = unknown> = CoreWatchListener<Row>;
export type WatchOptions<Row = unknown> = CoreWatchOptions<Row>;

export type WatchHookState<Row> = {
  readonly event: WatchEvent<Row> | undefined;
  readonly diagnostics: readonly WatchDiagnostic[];
};

const TarstateContext = createContext<Store | undefined>(undefined);
const emptyWatchDiagnostics: readonly WatchDiagnostic[] = Object.freeze([]);
const emptyDeps: readonly unknown[] = Object.freeze([]);

export function TarstateProvider({ children, db, resetKey, store }: TarstateProviderProps) {
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
  return useTarstateStore().getSnapshot();
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
  const snapshot = view.getSnapshot();
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
    row,
    ...(view.error === undefined ? {} : { error: view.error })
  };
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
    result,
    ...(view.error === undefined ? {} : { error: view.error })
  };
}

export function useWatch<Row>(
  _target: WatchTarget<Row>,
  _listener?: WatchListener<Row>,
  _options: WatchOptions<Row> & { readonly deps?: readonly unknown[] } = {}
): WatchHookState<Row> {
  return {
    event: undefined,
    diagnostics: emptyWatchDiagnostics
  };
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

function hasKeyBy<Row, Key>(options: UseViewOptions | UseRowKeyOptions<Row, Key>): options is UseRowKeyOptions<Row, Key> {
  return 'keyBy' in options;
}
