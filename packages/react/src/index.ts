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
  type RelationApply,
  type RelationApplyDurability,
  type RelationApplyResult,
  type RelationPatchTarget,
  type RelationRuntime
} from '@tarstate/core/adapter';
import {
  attachConstraints,
  hasAttachedConstraints,
  tryTransactConstrained,
  type ConstraintAttachmentInput
} from '@tarstate/core/constraints';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import type { RelationDelta } from '@tarstate/core/delta';
import { createDb, dbSource, tryTransact, type Db, type DbInputData } from '@tarstate/core/db';
import { evaluate, type EvaluateOptions, type QueryResult } from '@tarstate/core/evaluate';
import {
  materializationsFor,
  maintainMaterializationSnapshots,
  readMaterializedQuery,
  type MaterializationDiagnostic,
  type MaterializationMaintenanceResult
} from '@tarstate/core/materialization';
import { queryKey, type Query } from '@tarstate/core/query';
import { trackTransact } from '@tarstate/core/runtime';
import type { MaybePromise, RelationSource } from '@tarstate/core/source';
import type { TrackedChange, WatchRuntimeDiagnostic } from '@tarstate/core/watch';
import type { WritePatch } from '@tarstate/core/write';

export type TarstateReactDiagnostic = MaterializationDiagnostic | WatchRuntimeDiagnostic;

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

export type TarstateCommitResult<Snapshot extends TarstateSnapshot = TarstateSnapshot> = {
  readonly kind: 'tarstateCommit';
  readonly status: AdapterCommitStatus;
  /** True when any patch effects were reflected in the backing store. */
  readonly reflected: boolean;
  /** True when the full patch batch was accepted. */
  readonly fullyCommitted: boolean;
  readonly committed: boolean;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly changes?: readonly TrackedChange[];
  readonly durability?: RelationApplyDurability;
  readonly materializations?: MaterializationMaintenanceResult;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly snapshot: Snapshot;
};

export type TarstateStore<Snapshot extends TarstateSnapshot = TarstateSnapshot> = {
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly commit: (patches: Iterable<WritePatch>) => Promise<TarstateCommitResult<Snapshot>>;
  readonly refresh: () => Promise<void>;
};

export type DbStoreOptions = {
  /** Attach constraints to the object-backed Db used by this store. */
  readonly constraints?: ConstraintAttachmentInput;
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
  readonly target?: RelationPatchTarget<Version>;
  readonly apply?: RelationApply<Version>;
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
  input: Db | DbInputData = createDb(),
  options: DbStoreOptions = {}
): TarstateStore<TarstateDbSnapshot> {
  let db = isDb(input) ? input : createDb(input);
  if (options.constraints !== undefined) {
    db = attachConstraints(db, options.constraints);
  }

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
      const patchList = Array.from(patches);
      const result = hasAttachedConstraints(db)
        ? await tryTransactConstrained(db, patchList)
        : tryTransact(db, patchList);

      if (!result.committed) {
        return {
          kind: 'tarstateCommit',
          status: 'rejected',
          reflected: false,
          fullyCommitted: false,
          committed: false,
          patches: result.patches,
          applied: result.applied,
          deltas: result.deltas,
          diagnostics: result.diagnostics,
          snapshot
        };
      }

      const tracked = await trackTransact(db, () => result);
      const nextSnapshot = setDb(tracked.db, tracked.diagnostics);
      const reflected = commitReflected(result.deltas);

      return {
        kind: 'tarstateCommit',
        status: 'committed',
        reflected,
        fullyCommitted: true,
        committed: true,
        patches: result.patches,
        applied: result.applied,
        deltas: tracked.deltas,
        changes: tracked.changes,
        ...(tracked.materializations === undefined ? {} : { materializations: tracked.materializations }),
        diagnostics: tracked.diagnostics,
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
  return createSourceStore({
    getSource: () => adapter.source,
    getSnapshot: () => adapter.snapshot?.() ?? adapter.source,
    ...(adapter.subscribe === undefined ? {} : { subscribe: adapter.subscribe }),
    ...(adapter.target === undefined ? { commit: adapter.commit } : { target: adapter.target })
  });
}

export function createRuntimeStore<Version>(
  runtime: RelationRuntime<Version>
): TarstateStore<TarstateSnapshot<Version>> {
  return createSourceStore({
    getSource: () => runtime.source,
    getSnapshot: () => runtime.snapshot?.() ?? runtime.source,
    ...(runtime.subscribe === undefined ? {} : { subscribe: runtime.subscribe }),
    ...(runtime.target === undefined ? {} : { target: runtime.target })
  });
}

export function createSourceStore<Version = unknown>(
  options: SourceStoreOptions<Version>
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
    const maintainedSnapshot = await maintainSourceSnapshotMaterializations(
      snapshot.source,
      refreshedSnapshot
    );
    snapshot = maintainedSnapshot.snapshot;
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
      const patchList = Array.from(patches);
      const previousSnapshot = snapshot;

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
          fullyCommitted: false,
          committed: false,
          patches: patchList.length,
          applied: 0,
          deltas: [],
          diagnostics: [diagnostic],
          snapshot
        };
      }

      commitDepth += 1;
      let reportedDeltas: readonly RelationDelta[] | undefined;
      const result = await (async () => {
        try {
          return target === undefined
            ? await tryCommitAdapter<Version>(
                {
                  source: adapterSource(options.getSource(), options.getVersion),
                  commit: async (nextPatches) => {
                    const commitResult = await (
                      options.commit as NonNullable<SourceStoreOptions<Version>['commit']>
                    )(nextPatches);
                    reportedDeltas = ownRelationDeltas(commitResult);
                    return commitResult;
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
                      const applyResult = await target.apply(nextPatches);
                      reportedDeltas = ownRelationDeltas(applyResult);
                      return applyResult;
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

      let maintenance: MaterializationMaintenanceResult | undefined;
      let changes: readonly TrackedChange[] | undefined;
      let diagnostics: readonly TarstateReactDiagnostic[] = result.diagnostics;

      if (result.status !== 'rejected') {
        hostRefreshQueued = false;
        const refreshedSnapshot = await readSnapshot(revision + 1, result.diagnostics, result.version);
        const trackedSnapshot = await trackSourceSnapshotCommit(
          previousSnapshot.source,
          refreshedSnapshot,
          reportedDeltas === undefined ? undefined : result.deltas
        );
        maintenance = trackedSnapshot.materializations;
        changes = trackedSnapshot.changes;
        diagnostics = [...result.diagnostics, ...trackedSnapshot.diagnostics];
        snapshot = trackedSnapshot.snapshot;
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
        fullyCommitted: tarstateFullyCommitted(result),
        committed: tarstateFullyCommitted(result),
        patches: result.patches,
        applied: result.applied,
        deltas: result.deltas,
        ...(changes === undefined ? {} : { changes }),
        ...tarstateDurability(result),
        ...(maintenance === undefined ? {} : { materializations: maintenance }),
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
  return useCallback((patches) => store.commit(patches), [store]);
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

async function maintainSourceSnapshotMaterializations<Version>(
  previousSource: RelationSource,
  nextSnapshot: TarstateSnapshot<Version>
): Promise<{
  readonly snapshot: TarstateSnapshot<Version>;
  readonly materializations?: MaterializationMaintenanceResult;
}> {
  if (materializationsFor(previousSource).length === 0) {
    return { snapshot: nextSnapshot };
  }

  const materializations = await maintainMaterializationSnapshots(previousSource, nextSnapshot.source);

  return {
    snapshot: sourceSnapshot(
      nextSnapshot.source,
      nextSnapshot.revision,
      [...nextSnapshot.diagnostics, ...materializations.diagnostics],
      nextSnapshot.version
    ),
    materializations
  };
}

async function trackSourceSnapshotCommit<Version>(
  previousSource: RelationSource,
  nextSnapshot: TarstateSnapshot<Version>,
  deltas: readonly RelationDelta[] | undefined
): Promise<{
  readonly snapshot: TarstateSnapshot<Version>;
  readonly changes: readonly TrackedChange[];
  readonly materializations?: MaterializationMaintenanceResult;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
}> {
  const hadMaterializations = materializationsFor(previousSource).length > 0;
  // Source replacement does not guarantee that relation deltas carry enough ordering information
  // to keep materialized query rows in refreshed source order.
  const trackingDeltas = hadMaterializations ? undefined : deltas;
  const tracked = await trackTransact(previousSource, () => ({
    db: nextSnapshot.source,
    ...(trackingDeltas === undefined ? {} : { deltas: trackingDeltas })
  }));

  return {
    snapshot: sourceSnapshot(
      tracked.db,
      nextSnapshot.revision,
      [...nextSnapshot.diagnostics, ...tracked.diagnostics],
      nextSnapshot.version
    ),
    changes: tracked.changes,
    ...(hadMaterializations && tracked.materializations !== undefined
      ? { materializations: tracked.materializations }
      : {}),
    diagnostics: tracked.diagnostics
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
  options: SourceStoreOptions<Version>
): RelationPatchTarget<Version> | undefined {
  if (options.target !== undefined) {
    return options.target;
  }

  return options.apply === undefined ? undefined : { apply: options.apply };
}

function tarstateStatusForApplyResult(result: AdapterCommitResult | RelationApplyResult): AdapterCommitStatus {
  switch (result.status) {
    case 'accepted':
      return 'committed';
    case 'committed':
      return 'committed';
    case 'partial':
      return 'partial';
    case 'rejected':
      return 'rejected';
  }
}

function tarstateFullyCommitted(result: AdapterCommitResult | RelationApplyResult): boolean {
  switch (result.status) {
    case 'accepted':
      return result.accepted;
    case 'committed':
      return result.committed;
    case 'partial':
    case 'rejected':
      return false;
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
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, query]) => {
      const materialized = await readSnapshotMaterializedQuery(snapshot, query);

      return {
        name,
        query,
        diagnostics: materialized === undefined ? emptyDiagnostics : materialized.diagnostics,
        result: materialized?.materialized === true
          ? { rows: materialized.rows, diagnostics: [] }
          : undefined
      };
    })
  );
  const misses = entries.filter((entry) => entry.result === undefined);
  const capturedSource = misses.length === 0
    ? undefined
    : await captureQuerySource(snapshot.source, misses.map((entry) => entry.query));
  const evaluated = await Promise.all(
    misses.map(async (entry) => ({
      name: entry.name,
      result: await evaluate(capturedSource as RelationSource, entry.query, options)
    }))
  );
  const evaluatedByName = new Map(evaluated.map((entry) => [entry.name, entry.result]));
  const resultEntries = entries.map((entry) => {
    const result = entry.result ?? evaluatedByName.get(entry.name);

    if (result === undefined) {
      throw new Error(`missing query batch result for ${entry.name}`);
    }

    return [entry.name, result] as const;
  });
  const diagnostics = entries.flatMap((entry) => [
    ...entry.diagnostics,
    ...(entry.result === undefined ? evaluatedByName.get(entry.name)?.diagnostics ?? [] : [])
  ]);

  return {
    results: Object.fromEntries(resultEntries) as QueryBatchResult<Queries>,
    diagnostics
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
  const materialized = await readSnapshotMaterializedQuery(snapshot, query);

  if (materialized?.materialized === true) {
    return {
      result: { rows: materialized.rows, diagnostics: [] },
      diagnostics: materialized.diagnostics
    };
  }

  const result = await evaluate(await captureQuerySource(snapshot.source, [query]), query, options);

  return {
    result,
    diagnostics: [
      ...(materialized?.diagnostics ?? []),
      ...result.diagnostics
    ]
  };
}

async function readSnapshotMaterializedQuery<Row>(
  snapshot: TarstateSnapshot,
  query: Query<Row>
): Promise<Awaited<ReturnType<typeof readMaterializedQuery<Row>>> | undefined> {
  if (!canReadMaterializedQuery(query)) {
    return undefined;
  }

  const result = await readMaterializedQuery(materializationInputForSnapshot(snapshot), query);
  return result.materialized || result.id !== undefined ? result : undefined;
}

function materializationInputForSnapshot(snapshot: TarstateSnapshot): unknown {
  return isTarstateDbSnapshot(snapshot) ? snapshot.db : snapshot.source;
}

function canReadMaterializedQuery(query: Query): boolean {
  return !queryUsesRuntimeInputs(query);
}

function queryUsesRuntimeInputs(query: Query): boolean {
  return queryPartUsesRuntimeInputs(query.data);
}

function queryPartUsesRuntimeInputs(input: unknown): boolean {
  if (Array.isArray(input)) {
    return input.some(queryPartUsesRuntimeInputs);
  }

  if (!isRecord(input)) {
    return false;
  }

  if (input.op === 'env' || input.op === 'call') {
    return true;
  }

  return Object.values(input).some(queryPartUsesRuntimeInputs);
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

function ownRelationDeltas(input: unknown): readonly RelationDelta[] | undefined {
  if (!isRecord(input) || !Object.hasOwn(input, 'deltas')) {
    return undefined;
  }

  return Array.isArray(input.deltas) ? input.deltas as readonly RelationDelta[] : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
