import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
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
import { queryKey, type Query } from '@tarstate/core/query';
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
export type QueryBatchResult<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: QueryResult<Queries[Key] extends Query<infer Row> ? Row : never>;
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

export type TarstateStore<Snapshot extends TarstateSnapshot = TarstateSnapshot> = {
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
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
  readonly select?: (rows: readonly Row[], result: QueryResult<Row>) => Selected;
};

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

export type QueriesHookState<Queries extends QueryBatch> = {
  readonly status: 'loading' | 'ready' | 'error';
  readonly results: QueryBatchResult<Queries> | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly revision: number;
  readonly refresh: () => void;
  readonly error?: unknown;
};

const TarstateContext = createContext<TarstateStore | undefined>(undefined);
const emptyDiagnostics = Object.freeze([]) as readonly never[];

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

export function useTarstateQuery<Row, Selected = readonly Row[]>(
  query: Query<Row>,
  options: UseQueryOptions<Row, Selected> = {}
): QueryHookState<Row, Selected> {
  const snapshot = useTarstateSnapshot();
  const result = useMemo<QueryResult<Row>>(() => ({ rows: [], diagnostics: [] }), [snapshot.revision]);
  const refresh = useCallback(() => undefined, []);
  return {
    status: 'ready',
    rows: result.rows,
    data: options.select === undefined ? result.rows as Selected : options.select(result.rows, result),
    diagnostics: emptyDiagnostics,
    result,
    queryKey: queryKey(query),
    revision: snapshot.revision,
    refresh
  };
}

export function useTarstateQueries<const Queries extends QueryBatch>(
  _queries: Queries,
  _options: EvaluateOptions & { readonly deps?: readonly unknown[] } = {}
): QueriesHookState<Queries> {
  const snapshot = useTarstateSnapshot();
  const refresh = useCallback(() => undefined, []);
  return {
    status: 'ready',
    results: {} as QueryBatchResult<Queries>,
    diagnostics: emptyDiagnostics,
    revision: snapshot.revision,
    refresh
  };
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
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const refresh = async (): Promise<void> => {
    snapshot = refreshSnapshot === undefined
      ? { ...snapshot, revision: snapshot.revision + 1 }
      : await refreshSnapshot(snapshot);
    notify();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      const unsubscribeHost = subscribeHost?.(() => {
        void refresh();
      });
      return () => {
        unsubscribeHost?.();
        listeners.delete(listener);
      };
    },
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

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}
