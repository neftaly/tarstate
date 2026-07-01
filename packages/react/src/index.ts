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
  tryCommitAdapter,
  tryApplyRelationPatches,
  type AdapterCommitResult,
  type AdapterCommitStatus,
  type AdapterSource,
  type RelationAdapter,
  type RelationApplyDurability,
  type RelationDelta,
  type RelationApplyResult,
  type RelationPatchTarget,
  type RelationRuntime
} from '@tarstate/core/adapter';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { createDb, dbSource, tryTransact, type Db, type DbInputData } from '@tarstate/core/db';
import { evaluate, type EvaluateOptions, type QueryResult } from '@tarstate/core/evaluate';
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
type SnapshotQueryEvaluation<Row> = {
  readonly result: QueryResult<Row>;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
};
type SnapshotQueryBatchEvaluation<Queries extends QueryBatch> = {
  readonly results: QueryBatchResult<Queries>;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
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
type NormalizedSourceStoreSnapshot<Version = unknown> = Omit<SourceStoreSnapshot<Version>, 'diagnostics'> & {
  readonly diagnostics: readonly TarstateDiagnostic[];
};

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
const emptyRows = Object.freeze([]) as readonly never[];
const emptyDiagnostics = Object.freeze([]) as readonly never[];
type QueryRelation = Query['relations'][string];

export function createDbStore(
  input: Db | DbInputData = createDb()
): TarstateStore<TarstateDbSnapshot> {
  let db = isDb(input) ? input : createDb(input);

  let revision = 0;
  let snapshot = dbSnapshot(db, revision, []);
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setDb = (nextDb: Db, diagnostics: readonly TarstateReactDiagnostic[] = []): TarstateDbSnapshot => {
    db = nextDb;
    revision += 1;
    snapshot = dbSnapshot(db, revision, diagnostics);
    notify();
    return snapshot;
  };

  const store: TarstateStore<TarstateDbSnapshot> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit: async (patches) => {
      const patchList = Array.from(writeInputPatches(patches));
      const result = tryTransact(db, patchList);

      if (!result.committed) {
        return {
          kind: 'tarstateCommit',
          status: 'rejected',
          reflected: false,
          effects: {
            patches: result.patches,
            applied: result.applied,
            deltas: result.deltas
          },
          diagnostics: result.diagnostics,
          snapshot
        };
      }

      const nextSnapshot = setDb(result.db, result.diagnostics);
      const reflected = commitReflected(result.deltas);

      return {
        kind: 'tarstateCommit',
        status: 'accepted',
        reflected,
          effects: {
            patches: result.patches,
            applied: result.applied,
            deltas: result.deltas
          },
        diagnostics: result.diagnostics,
        snapshot: nextSnapshot
      };
    },
    refresh: async () => {
      snapshot = dbSnapshot(db, revision + 1, []);
      revision = snapshot.revision;
      notify();
    }
  };

  return store;
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

function createSourceStoreInternal<Version = unknown>(
  options: WritableSourceStoreOptions<Version>
): TarstateStore<TarstateSnapshot<Version>> {
  let revision = 0;
  const initialSnapshot = sourceSnapshotInput(options);
  let snapshot = sourceSnapshot<Version>(
    initialSnapshot.source,
    revision,
    initialSnapshot.diagnostics,
    initialSnapshot.version
  );
  const listeners = new Set<() => void>();
  let unsubscribeHost: (() => void) | undefined;
  let commitDepth = 0;
  let hostRefreshQueued = false;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const readSnapshot = async (
    nextRevision: number,
    diagnostics: readonly TarstateDiagnostic[] = [],
    versionHint?: Version
  ): Promise<TarstateSnapshot<Version>> => {
    const snapshotInput = sourceSnapshotInput(options);
    const source = snapshotInput.source;
    const [version, sourceDiagnostics] = await Promise.all([
      snapshotInput.version === undefined
        ? versionHint === undefined ? readVersion(source, options.getVersion) : versionHint
        : snapshotInput.version,
      readDiagnostics(source)
    ]);

    return sourceSnapshot<Version>(
      source,
      nextRevision,
      [...diagnostics, ...snapshotInput.diagnostics, ...sourceDiagnostics],
      version
    );
  };

  const refresh = async (): Promise<void> => {
    const refreshedSnapshot = await readSnapshot(revision + 1);
    snapshot = refreshedSnapshot;
    revision = snapshot.revision;
    notify();
  };

  const store: TarstateStore<TarstateSnapshot<Version>> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);

      if (listeners.size === 1 && options.subscribe !== undefined) {
        unsubscribeHost = options.subscribe(() => {
          if (commitDepth > 0) {
            hostRefreshQueued = true;
            return;
          }

          void refresh();
        });
      }

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) {
          unsubscribeHost?.();
          unsubscribeHost = undefined;
        }
      };
    },
    commit: async (patches) => {
      const patchList = Array.from(writeInputPatches(patches));

      const target = relationTargetForOptions(options);

      if (target === undefined && options.commit === undefined) {
        const diagnostic: TarstateDiagnostic = {
          code: 'source_error',
          message: 'tarstate source store does not support commits'
        };

        return {
          kind: 'tarstateCommit',
          status: 'rejected',
          reflected: false,
          effects: {
            patches: patchList.length,
            applied: 0,
            deltas: []
          },
          diagnostics: [diagnostic],
          snapshot
        };
      }

      commitDepth += 1;
      const result = await (async () => {
        try {
          return target === undefined
            ? await tryCommitAdapter<Version>(
                {
                  source: adapterSource(options.getSource(), options.getVersion),
                  commit: async (nextPatches) => {
                    return await (
                      options.commit as NonNullable<WritableSourceStoreOptions<Version>['commit']>
                    )(nextPatches);
                  }
                },
                patchList,
                { readVersion: false }
              )
            : await tryApplyRelationPatches<Version>(
                {
                  source: adapterSource(options.getSource(), options.getVersion),
                  target: {
                    apply: async (nextPatches) => {
                      return await target.apply(nextPatches);
                    }
                  }
                },
                patchList,
                { readVersion: false }
              );
        } finally {
          commitDepth -= 1;
        }
      })();

      let diagnostics: readonly TarstateReactDiagnostic[] = result.diagnostics;

      if (result.status !== 'rejected') {
        hostRefreshQueued = false;
        const refreshedSnapshot = await readSnapshot(revision + 1, result.diagnostics, result.version);
        diagnostics = refreshedSnapshot.diagnostics;
        snapshot = refreshedSnapshot;
        revision = snapshot.revision;
        notify();
      } else if (hostRefreshQueued) {
        hostRefreshQueued = false;
        await refresh();
      }

      return {
        kind: 'tarstateCommit',
        status: tarstateStatusForApplyResult(result),
        reflected: commitReflected(result.deltas),
        effects: {
          patches: result.patches,
          applied: result.applied,
          deltas: result.deltas,
          ...tarstateDurability(result)
        },
        diagnostics,
        snapshot
      };
    },
    refresh
  };

  return store;
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
  const key = queryKey(query);
  const deps = options.deps ?? emptyRows;
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestId = useRef(0);
  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);
  const [state, setState] = useState<QueryHookState<Row, Selected>>(() =>
    loadingQueryState(key, snapshot.revision, refresh)
  );

  useEffect(() => {
    const id = requestId.current + 1;
    requestId.current = id;
    let active = true;
    const { deps: _deps, select, ...evaluateOptions } = options;
    const snapshotEvaluateOptions = evaluateOptionsForSnapshot(snapshot, evaluateOptions);

    setState(loadingQueryState(key, snapshot.revision, refresh));

    void evaluateSnapshotQuery(snapshot, query, snapshotEvaluateOptions).then(
      (evaluation) => {
        if (!active || requestId.current !== id) {
          return;
        }

        const result = evaluation.result;

        setState({
          status: 'ready',
          rows: result.rows,
          data: select === undefined ? (result.rows as Selected) : select(result.rows, result),
          diagnostics: evaluation.diagnostics,
          result,
          queryKey: key,
          revision: snapshot.revision,
          refresh
        });
      },
      (error: unknown) => {
        if (active && requestId.current === id) {
          setState({
            status: 'error',
            rows: emptyRows,
            data: undefined,
            diagnostics: emptyDiagnostics,
            error,
            queryKey: key,
            revision: snapshot.revision,
            refresh
          });
        }
      }
    );

    return () => {
      active = false;
    };
  }, [snapshot.source, snapshot.revision, key, refreshNonce, ...deps]);

  return withSelectedData(state, options.select);
}

export function useTarstateQueries<const Queries extends QueryBatch>(
  queries: Queries,
  options: EvaluateOptions & { readonly deps?: readonly unknown[] } = {}
): QueriesHookState<Queries> {
  const snapshot = useTarstateSnapshot();
  const deps = options.deps ?? emptyRows;
  const batchKey = queryBatchKey(queries);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestId = useRef(0);
  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);
  const [state, setState] = useState<QueriesHookState<Queries>>(() => ({
    status: 'loading',
    results: undefined,
    diagnostics: emptyDiagnostics,
    revision: snapshot.revision,
    refresh
  }));

  useEffect(() => {
    const id = requestId.current + 1;
    requestId.current = id;
    let active = true;
    const { deps: _deps, ...evaluateOptions } = options;
    const snapshotEvaluateOptions = evaluateOptionsForSnapshot(snapshot, evaluateOptions);

    setState({
      status: 'loading',
      results: undefined,
      diagnostics: emptyDiagnostics,
      revision: snapshot.revision,
      refresh
    });

    void evaluateBatch(snapshot, queries, snapshotEvaluateOptions).then(
      (evaluation) => {
        if (active && requestId.current === id) {
          setState({
            status: 'ready',
            results: evaluation.results,
            diagnostics: evaluation.diagnostics,
            revision: snapshot.revision,
            refresh
          });
        }
      },
      (error: unknown) => {
        if (active && requestId.current === id) {
          setState({
            status: 'error',
            results: undefined,
            diagnostics: emptyDiagnostics,
            error,
            revision: snapshot.revision,
            refresh
          });
        }
      }
    );

    return () => {
      active = false;
    };
  }, [snapshot.source, snapshot.revision, batchKey, refreshNonce, ...deps]);

  return state;
}

export function useTarstateCommit<Snapshot extends TarstateSnapshot = TarstateSnapshot>(): TarstateStore<Snapshot>['commit'] {
  const store = useTarstateStore<TarstateStore<Snapshot>>();
  return useCallback((patches: TarstateCommitInput) => store.commit(patches), [store]);
}

export const useQuery = useTarstateQuery;
export const useQueries = useTarstateQueries;
export const useCommit = useTarstateCommit;

function dbSnapshot(db: Db, revision: number, diagnostics: readonly TarstateReactDiagnostic[]): TarstateDbSnapshot {
  return {
    db,
    source: dbSource(db),
    revision,
    diagnostics
  };
}

type SourceStoreReadOptions<Version> = Pick<SourceStoreOptions<Version>, 'getSource' | 'getSnapshot' | 'subscribe'>;
type SourceStoreWriteOptions<Version> = Pick<WritableSourceStoreOptions<Version>, 'target' | 'commit'>;

function sourceStoreOptionsForAdapter<Version>(adapter: RelationAdapter<Version>): WritableSourceStoreOptions<Version> {
  return {
    ...sourceStoreReadOptions(adapter),
    ...sourceStoreWriteOptionsForAdapter(adapter)
  };
}

function sourceStoreOptionsForRuntime<Version>(runtime: RelationRuntime<Version>): WritableSourceStoreOptions<Version> {
  return {
    ...sourceStoreReadOptions(runtime),
    ...(runtime.target === undefined ? {} : { target: runtime.target })
  };
}

function sourceStoreReadOptions<Version>(runtime: RelationRuntime<Version>): SourceStoreReadOptions<Version> {
  return {
    getSource: () => runtime.source,
    getSnapshot: () => runtime.snapshot?.() ?? runtime.source,
    ...(runtime.subscribe === undefined ? {} : { subscribe: runtime.subscribe })
  };
}

function sourceStoreWriteOptionsForAdapter<Version>(
  adapter: RelationAdapter<Version>
): SourceStoreWriteOptions<Version> {
  // Relation targets use the runtime apply path; adapter commits are retained for legacy adapters.
  return adapter.target === undefined ? { commit: adapter.commit } : { target: adapter.target };
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

function sourceSnapshotInput<Version>(options: SourceStoreOptions<Version>): NormalizedSourceStoreSnapshot<Version> {
  const input = options.getSnapshot === undefined ? options.getSource() : options.getSnapshot();

  if (isSourceStoreSnapshot<Version>(input)) {
    return {
      source: input.source,
      diagnostics: input.diagnostics ?? emptyDiagnostics,
      ...(input.version === undefined ? {} : { version: input.version })
    };
  }

  return {
    source: input,
    diagnostics: emptyDiagnostics
  };
}

function isSourceStoreSnapshot<Version>(input: SourceStoreSnapshotInput<Version>): input is SourceStoreSnapshot<Version> {
  return typeof input === 'object' && input !== null && 'source' in input;
}

function relationTargetForOptions<Version>(
  options: WritableSourceStoreOptions<Version>
): RelationPatchTarget<Version> | undefined {
  return options.target;
}

function tarstateStatusForApplyResult(result: AdapterCommitResult | RelationApplyResult): AdapterCommitStatus {
  switch (result.status) {
    case 'accepted':
      return 'accepted';
    case 'partial':
      return 'partial';
    case 'rejected':
      return 'rejected';
  }
}

function tarstateDurability(
  result: AdapterCommitResult | RelationApplyResult
): { readonly durability?: RelationApplyDurability } {
  return 'durability' in result && result.durability !== undefined
    ? { durability: result.durability }
    : {};
}

function adapterSource<Version>(
  source: RelationSource,
  getVersion: (() => MaybePromise<Version>) | undefined
): AdapterSource<Version> {
  return {
    rows: source.rows,
    ...(source.relationNames === undefined ? {} : { relationNames: source.relationNames }),
    ...(source.lookup === undefined ? {} : { lookup: source.lookup }),
    ...(source.rangeLookup === undefined ? {} : { rangeLookup: source.rangeLookup }),
    ...(source.diagnostics === undefined ? {} : { diagnostics: source.diagnostics }),
    ...(getVersion === undefined && source.version === undefined
      ? {}
      : { version: getVersion ?? (source.version as () => MaybePromise<Version>) })
  };
}

function withSelectedData<Row, Selected>(
  state: QueryHookState<Row, Selected>,
  select: ((rows: readonly Row[], result: QueryResult<Row>) => Selected) | undefined
): QueryHookState<Row, Selected> {
  if (state.result === undefined) {
    return state;
  }

  return {
    ...state,
    data: select === undefined ? (state.result.rows as Selected) : select(state.result.rows, state.result)
  };
}

async function readVersion<Version>(
  source: RelationSource,
  getVersion: (() => MaybePromise<Version>) | undefined
): Promise<Version | undefined> {
  return getVersion === undefined ? (source.version?.() as MaybePromise<Version | undefined>) : getVersion();
}

async function readDiagnostics(source: RelationSource): Promise<readonly TarstateDiagnostic[]> {
  if (source.diagnostics === undefined) {
    return [];
  }

  try {
    return Array.from(await source.diagnostics());
  } catch (error) {
    return [
      {
        code: 'source_error',
        message: 'source diagnostics failed',
        detail: error
      }
    ];
  }
}

function loadingQueryState<Row, Selected>(
  key: string,
  revision: number,
  refresh: () => void
): QueryHookState<Row, Selected> {
  return {
    status: 'loading',
    rows: emptyRows,
    data: undefined,
    diagnostics: emptyDiagnostics,
    queryKey: key,
    revision,
    refresh
  };
}

async function evaluateBatch<const Queries extends QueryBatch>(
  snapshot: TarstateSnapshot,
  queries: Queries,
  options: EvaluateOptions
): Promise<SnapshotQueryBatchEvaluation<Queries>> {
  const capturedSource = await captureQuerySource(snapshot.source, Object.values(queries));
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, query]) => ({
      name,
      result: await evaluate(capturedSource, query, options)
    }))
  );

  return {
    results: Object.fromEntries(entries.map((entry) => [entry.name, entry.result])) as QueryBatchResult<Queries>,
    diagnostics: entries.flatMap((entry) => entry.result.diagnostics)
  };
}

function queryBatchKey(queries: QueryBatch): string {
  return Object.entries(queries)
    .map(([name, query]) => `${name}:${queryKey(query)}`)
    .join('\n');
}

function isDb(input: Db | DbInputData): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

async function evaluateSnapshotQuery<Row>(
  snapshot: TarstateSnapshot,
  query: Query<Row>,
  options: EvaluateOptions
): Promise<SnapshotQueryEvaluation<Row>> {
  const result = await evaluate(await captureQuerySource(snapshot.source, [query]), query, options);

  return {
    result,
    diagnostics: result.diagnostics
  };
}

async function captureQuerySource(source: RelationSource, queries: readonly Query[]): Promise<RelationSource> {
  const rowsByRelation: Record<string, readonly unknown[]> = {};
  const diagnostics: TarstateDiagnostic[] = [];

  await Promise.all(
    relationRefsForQueries(queries).map(async (relationRef) => {
      rowsByRelation[relationRef.name] = await readRelationRows(source, relationRef, diagnostics);
    })
  );

  diagnostics.push(...(await readDiagnostics(source)));

  return {
    relationNames: Object.keys(rowsByRelation),
    rows: (relationRef) => rowsByRelation[relationRef.name] ?? emptyRows,
    ...(diagnostics.length === 0 ? {} : { diagnostics: () => diagnostics })
  };
}

function relationRefsForQueries(queries: readonly Query[]): readonly QueryRelation[] {
  const refsByName = new Map<string, QueryRelation>();

  for (const query of queries) {
    for (const relationRef of Object.values(query.relations)) {
      refsByName.set(relationRef.name, relationRef);
    }
  }

  return Array.from(refsByName.values());
}

async function readRelationRows(
  source: RelationSource,
  relationRef: QueryRelation,
  diagnostics: TarstateDiagnostic[]
): Promise<readonly unknown[]> {
  try {
    return Object.freeze(Array.from(await source.rows(relationRef)));
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `source rows failed for relation ${relationRef.name}`,
      relation: relationRef.name,
      detail: error
    });
    return emptyRows;
  }
}

function evaluateOptionsForSnapshot(
  snapshot: TarstateSnapshot,
  options: EvaluateOptions
): EvaluateOptions {
  if (!isTarstateDbSnapshot(snapshot)) {
    return options;
  }

  return {
    ...(options.functions === undefined ? {} : { functions: options.functions }),
    env: options.env === undefined ? snapshot.db.env : { ...snapshot.db.env, ...options.env }
  };
}

function isTarstateDbSnapshot(snapshot: TarstateSnapshot): snapshot is TarstateDbSnapshot {
  return 'db' in snapshot && isDb(snapshot.db as Db | DbInputData);
}

function commitReflected(deltas: readonly RelationDelta[]): boolean {
  return deltas.some((delta) => delta.added.length > 0 || delta.removed.length > 0);
}
