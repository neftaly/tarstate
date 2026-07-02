import type { RelationApplyDurability, RelationApplyStatus, RelationDelta, RelationRuntime } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import {
  createDb,
  dbSource,
  q,
  qMany,
  transactionPlan,
  tryTransact,
  type Db,
  type DbInputData,
  type DbInputEnv,
  type DbQueryOptions,
  type DbTransactionInput,
  type DbTransactionInputs,
  type QueryBatch
} from './db.js';
import { stableKey } from './identity.js';
import { maintainMaterializations } from './materialization.js';
import { queryKey, type Query } from './query.js';
import type { RelationRef } from './schema.js';
import type { RelationSource } from './source.js';
import { trackRuntimeCommit } from './runtime.js';
import { transferWatches } from './watch.js';
import { trackWatchedChanges } from './watch-tracking.js';
import type { RelationRow } from './write.js';

type QueryRow<QueryValue> = QueryValue extends Query<infer Row>
  ? Row
  : QueryValue extends StoreQueryBatchItemSpec<infer Target>
    ? QueryRow<Target>
  : QueryValue extends RelationRef<infer Row>
    ? Row
    : QueryValue extends string
      ? unknown
      : never;
type StoreQueryTarget<Row = unknown> = Query<Row> | RelationRef;
type StoreQueryBatchItemSpec<QueryValue extends StoreQueryTarget = StoreQueryTarget> =
  StoreQueryOptions<any, any> & {
    readonly q: QueryValue;
  };
type StoreQueryBatchItem = StoreQueryTarget | StoreQueryBatchItemSpec;
type StoreQueryBatch = Record<string, StoreQueryBatchItem>;
type QueryBatchRow<Queries extends StoreQueryBatch> = QueryRow<Queries[keyof Queries]>;

export type StoreDiagnostic = TarstateDiagnostic | {
  readonly code: string;
  readonly message: string;
  readonly relation?: string;
  readonly field?: string;
  readonly key?: string;
  readonly detail?: unknown;
};

export type StoreQueryResult<Row = unknown> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly StoreDiagnostic[];
};

export type StoreQueryBatchResult<Queries extends StoreQueryBatch> = {
  readonly [Key in keyof Queries]: StoreQueryResult<QueryRow<Queries[Key]>>;
};

export type StoreMappedQueryBatchResult<Queries extends StoreQueryBatch, MappedRow> = {
  readonly [Key in keyof Queries]: StoreQueryResult<MappedRow>;
};

export type StoreCommitSnapshot<Version = unknown> = {
  readonly source: RelationSource;
  readonly revision: number;
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly version?: Version;
};

export type StoreSnapshot<Version = unknown> = StoreCommitSnapshot<Version> & {
  readonly db: Db;
};

export type StoreCommitInput = DbTransactionInput;

export type StoreCommitEffects<Version = unknown> = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly durability?: RelationApplyDurability;
  readonly version?: Version;
};

export type StoreCommitStatus = RelationApplyStatus;

export type StoreCommitResult<
  Version = unknown,
  Diagnostic extends StoreDiagnostic = StoreDiagnostic
> = {
  readonly kind: 'tarstateCommit';
  readonly status: StoreCommitStatus;
  readonly reflected: boolean;
  readonly effects: StoreCommitEffects<Version>;
  readonly diagnostics: readonly Diagnostic[];
  readonly snapshot: StoreSnapshot<Version>;
};

export type StoreQueryOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;
export type StoreViewReadOptions<Row = unknown, MappedRow = Row> = StoreQueryOptions<Row, MappedRow>;
export type StoreViewSnapshot<Row = unknown, Version = unknown> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly revision: number;
  readonly queryKey: string;
  readonly snapshot: StoreSnapshot<Version>;
  readonly db: Db;
  readonly source: RelationSource;
  readonly version?: Version;
};

export type StoreQuery = {
  <Row, MappedRow>(
    query: Query<Row>,
    options: StoreQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
  ): Promise<StoreQueryResult<MappedRow>>;
  <Row>(query: Query<Row>, options?: StoreQueryOptions<Row>): Promise<StoreQueryResult<Row>>;
  <Relation extends RelationRef, MappedRow>(
    relation: Relation,
    options: StoreQueryOptions<RelationRow<Relation>, MappedRow> & {
      readonly mapRows: (rows: readonly RelationRow<Relation>[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  <Relation extends RelationRef>(
    relation: Relation,
    options?: StoreQueryOptions<RelationRow<Relation>>
  ): Promise<StoreQueryResult<RelationRow<Relation>>>;
};

export type StoreQueries = {
  <const Queries extends StoreQueryBatch, MappedRow>(
    queries: Queries,
    options: StoreQueryOptions<QueryBatchRow<Queries>, MappedRow> & {
      readonly mapRows: (rows: readonly QueryBatchRow<Queries>[]) => readonly MappedRow[];
    }
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  <const Queries extends StoreQueryBatch>(
    queries: Queries,
    options?: StoreQueryOptions<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
};

type StoreWhatIfArgs<Row, MappedRow = Row> = readonly (
  DbTransactionInput |
  StoreQueryOptions<Row, MappedRow>
)[];
type StoreMappedWhatIfArgs<Row, MappedRow> = readonly [
  ...DbTransactionInput[],
  StoreQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
];

export type StoreWhatIf = {
  <Row, MappedRow>(
    query: Query<Row>,
    ...inputs: StoreMappedWhatIfArgs<Row, MappedRow>
  ): Promise<StoreQueryResult<MappedRow>>;
  <Row>(query: Query<Row>, ...inputs: StoreWhatIfArgs<Row>): Promise<StoreQueryResult<Row>>;
  <Relation extends RelationRef, MappedRow>(
    relation: Relation,
    ...inputs: StoreMappedWhatIfArgs<RelationRow<Relation>, MappedRow>
  ): Promise<StoreQueryResult<MappedRow>>;
  <Relation extends RelationRef>(
    relation: Relation,
    ...inputs: StoreWhatIfArgs<RelationRow<Relation>>
  ): Promise<StoreQueryResult<RelationRow<Relation>>>;
  <const Queries extends StoreQueryBatch, MappedRow>(
    queries: Queries,
    ...inputs: StoreMappedWhatIfArgs<QueryBatchRow<Queries>, MappedRow>
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  <const Queries extends StoreQueryBatch>(
    queries: Queries,
    ...inputs: StoreWhatIfArgs<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
};

export type StoreViewRead<Row = unknown, Version = unknown> = () => StoreViewSnapshot<Row, Version>;

export type StoreView<Row = unknown, Version = unknown> = {
  readonly kind: 'view';
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly getSnapshot: () => StoreViewSnapshot<Row, Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: StoreViewRead<Row, Version>;
  readonly rows: () => readonly Row[];
  readonly refresh: () => Promise<StoreViewSnapshot<Row, Version>>;
};

export type Store<Version = unknown> = {
  readonly kind: 'store';
  readonly getSnapshot: () => StoreSnapshot<Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly query: StoreQuery;
  readonly queries: StoreQueries;
  readonly whatIf: StoreWhatIf;
  readonly view: <Row>(query: Query<Row>) => StoreView<Row, Version>;
  readonly commit: (...inputs: DbTransactionInputs) => Promise<StoreCommitResult<Version>>;
  readonly refresh: () => Promise<StoreSnapshot<Version>>;
  readonly close: () => void;
};

export type StoreRuntimeInput<Version = unknown> = {
  readonly runtime: RelationRuntime<Version>;
  readonly relations: readonly RelationRef[];
  readonly env?: DbInputEnv;
};

export type StoreSeedInput = Db | DbInputData;

export function createStore(input?: StoreSeedInput): Store;
export function createStore(input: StoreSeedInput = createDb()): Store {
  const db = isDb(input) ? input : createDb(input);
  let snapshot = storeSnapshot(db, 0, []);
  const listeners = new Set<() => void>();
  const views = new Map<string, StoreView<unknown>>();
  let closed = false;
  const subscribe = (listener: () => void): (() => void) => {
    if (closed) {
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const notify = (): void => {
    if (closed) return;
    for (const listener of listeners) listener();
  };

  const store: Store = {
    kind: 'store',
    getSnapshot: () => snapshot,
    subscribe,
    query: queryStore,
    queries: queryStores,
    whatIf: whatIfStore as StoreWhatIf,
    view: viewStore,
    commit: async (...inputs) => {
      const previousDb = snapshot.db;
      const result = tryTransact(previousDb, ...inputs);
      const reflected = result.committed;

      if (reflected) {
        snapshot = storeSnapshot(result.db, snapshot.revision + 1, result.diagnostics);
        void trackWatchedChanges(previousDb, result.db, result.deltas, result.materializations);
        notify();
      }

      return {
        kind: 'tarstateCommit',
        status: result.committed ? 'accepted' : 'rejected',
        reflected,
        effects: {
          patches: result.patches,
          applied: result.applied,
          deltas: result.deltas
        },
        diagnostics: result.diagnostics,
        snapshot
      };
    },
    refresh: async () => {
      snapshot = storeSnapshot(snapshot.db, snapshot.revision + 1, []);
      notify();
      return snapshot;
    },
    close: () => {
      if (closed) return;
      closed = true;
      listeners.clear();
    }
  };

  return store;

  function viewStore<Row>(queryValue: Query<Row>): StoreView<Row> {
    const key = queryKey(queryValue);
    const existing = views.get(key);
    if (existing !== undefined) {
      return existing as StoreView<Row>;
    }

    const view = createStoreView(queryValue, store);
    views.set(key, view as StoreView<unknown>);
    return view;
  }

  function queryStore<Row, MappedRow>(
    queryValue: Query<Row>,
    options: StoreQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
  ): Promise<StoreQueryResult<MappedRow>>;
  function queryStore<Row>(queryValue: Query<Row>, options?: StoreQueryOptions<Row>): Promise<StoreQueryResult<Row>>;
  function queryStore<Relation extends RelationRef, MappedRow>(
    relation: Relation,
    options: StoreQueryOptions<RelationRow<Relation>, MappedRow> & {
      readonly mapRows: (rows: readonly RelationRow<Relation>[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  function queryStore<Relation extends RelationRef>(
    relation: Relation,
    options?: StoreQueryOptions<RelationRow<Relation>>
  ): Promise<StoreQueryResult<RelationRow<Relation>>>;
  function queryStore(queryValue: StoreQueryTarget, options?: StoreQueryOptions<any, any>): Promise<any> {
    return queryOne(snapshot.db, queryValue, options);
  }

  function queryStores<const Queries extends StoreQueryBatch, MappedRow>(
    queries: Queries,
    options: StoreQueryOptions<QueryBatchRow<Queries>, MappedRow> & {
      readonly mapRows: (rows: readonly QueryBatchRow<Queries>[]) => readonly MappedRow[];
    }
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  function queryStores<const Queries extends StoreQueryBatch>(
    queries: Queries,
    options?: StoreQueryOptions<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
  function queryStores(queries: StoreQueryBatch, options?: StoreQueryOptions): Promise<StoreQueryBatchResult<StoreQueryBatch>> {
    return qMany(snapshot.db, queries as QueryBatch, options) as Promise<StoreQueryBatchResult<StoreQueryBatch>>;
  }

  function whatIfStore(queryOrQueries: StoreQueryTarget | StoreQueryBatch, ...args: StoreWhatIfArgs<any, any>): Promise<any> {
    return queryWhatIf(snapshot.db, queryOrQueries, args);
  }
}

export async function createRuntimeStore<Version>(input: StoreRuntimeInput<Version>): Promise<Store<Version>> {
  const relationList = uniqueRelations(input.relations);
  let snapshot = await runtimeStoreSnapshot(input.runtime, relationList, 0, [], input.env);
  const listeners = new Set<() => void>();
  const views = new Map<string, StoreView<unknown, Version>>();
  let applyingCommit = false;
  let closed = false;
  const notify = (): void => {
    if (closed) return;
    for (const listener of listeners) listener();
  };
  const publish = async (
    diagnostics: readonly StoreDiagnostic[] = [],
    deltas: readonly RelationDelta[] = []
  ): Promise<StoreSnapshot<Version>> => {
    const previousDb = snapshot.db;
    snapshot = await runtimeStoreSnapshot(input.runtime, relationList, snapshot.revision + 1, diagnostics, input.env);
    const materializations = maintainMaterializations(previousDb, snapshot.db, { deltas });
    transferWatches(previousDb, snapshot.db);
    void trackWatchedChanges(previousDb, snapshot.db, deltas, materializations);
    notify();
    return snapshot;
  };
  const unsubscribeRuntime = input.runtime.subscribe?.(() => {
    if (!closed && !applyingCommit) {
      void publish();
    }
  });
  const store: Store<Version> = {
    kind: 'store',
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    query: queryRuntimeStore,
    queries: queryRuntimeStores,
    whatIf: whatIfRuntimeStore as StoreWhatIf,
    view: viewRuntimeStore,
    commit: async (...inputs) => {
      const transaction = transactionPlan(snapshot.db, inputs);
      if (transaction.envUpdates > 0) {
        const diagnostics = [{
          code: 'unsupported_runtime_env_transaction',
          message: 'runtime-backed stores cannot apply environment transactions'
        }] satisfies readonly StoreDiagnostic[];
        return {
          kind: 'tarstateCommit',
          status: 'rejected',
          reflected: false,
          effects: {
            patches: transaction.patches.length,
            applied: 0,
            deltas: []
          },
          diagnostics,
          snapshot
        };
      }

      applyingCommit = true;
      const result = await trackRuntimeCommit(input.runtime, transaction.patches, { readVersion: true })
        .finally(() => {
          applyingCommit = false;
        });
      const reflected = result.status !== 'rejected';

      if (reflected) {
        await publish(result.diagnostics, result.deltas);
      }

      return {
        kind: 'tarstateCommit',
        status: result.status,
        reflected,
        effects: {
          patches: result.patches,
          applied: result.applied,
          deltas: result.deltas,
          ...(result.durability === undefined ? {} : { durability: result.durability }),
          ...(result.version === undefined ? {} : { version: result.version })
        },
        diagnostics: result.diagnostics,
        snapshot
      };
    },
    refresh: async () => publish(),
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribeRuntime?.();
      listeners.clear();
    }
  };

  return store;

  function viewRuntimeStore<Row>(queryValue: Query<Row>): StoreView<Row, Version> {
    const key = queryKey(queryValue);
    const existing = views.get(key);
    if (existing !== undefined) {
      return existing as StoreView<Row, Version>;
    }

    const view = createStoreView(queryValue, store);
    views.set(key, view as StoreView<unknown, Version>);
    return view;
  }

  async function queryRuntimeStore<Row, MappedRow>(
    queryValue: Query<Row>,
    options: StoreQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
  ): Promise<StoreQueryResult<MappedRow>>;
  async function queryRuntimeStore<Row>(queryValue: Query<Row>, options?: StoreQueryOptions<Row>): Promise<StoreQueryResult<Row>>;
  async function queryRuntimeStore<Relation extends RelationRef, MappedRow>(
    relation: Relation,
    options: StoreQueryOptions<RelationRow<Relation>, MappedRow> & {
      readonly mapRows: (rows: readonly RelationRow<Relation>[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  async function queryRuntimeStore<Relation extends RelationRef>(
    relation: Relation,
    options?: StoreQueryOptions<RelationRow<Relation>>
  ): Promise<StoreQueryResult<RelationRow<Relation>>>;
  async function queryRuntimeStore(queryValue: StoreQueryTarget, options?: StoreQueryOptions<any, any>): Promise<any> {
    return queryOne(snapshot.db, queryValue, options);
  }

  async function queryRuntimeStores<const Queries extends StoreQueryBatch, MappedRow>(
    queries: Queries,
    options: StoreQueryOptions<QueryBatchRow<Queries>, MappedRow> & {
      readonly mapRows: (rows: readonly QueryBatchRow<Queries>[]) => readonly MappedRow[];
    }
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  async function queryRuntimeStores<const Queries extends StoreQueryBatch>(
    queries: Queries,
    options?: StoreQueryOptions<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
  async function queryRuntimeStores(
    queries: StoreQueryBatch,
    options?: StoreQueryOptions
  ): Promise<StoreQueryBatchResult<StoreQueryBatch>> {
    return qMany(snapshot.db, queries as QueryBatch, options) as Promise<StoreQueryBatchResult<StoreQueryBatch>>;
  }

  function whatIfRuntimeStore(queryOrQueries: StoreQueryTarget | StoreQueryBatch, ...args: StoreWhatIfArgs<any, any>): Promise<any> {
    return queryWhatIf(snapshot.db, queryOrQueries, args);
  }
}

function createStoreView<Row, Version>(query: Query<Row>, store: Store<Version>): StoreView<Row, Version> {
  const key = queryKey(query);
  const listeners = new Set<() => void>();
  let current: StoreViewSnapshot<Row, Version> = viewSnapshot<Row, Version>([], [], store.getSnapshot(), key);
  let initialized = false;
  let evaluatedRevision: number | undefined;
  let pendingRevision: number | undefined;
  let pendingRefresh: Promise<StoreViewSnapshot<Row, Version>> | undefined;
  let refreshSerial = 0;

  store.subscribe(() => {
    const previous = current;
    void refreshView().then((next) => {
      if (next !== previous) {
        notify();
      }
    });
  });

  void refreshView();

  return {
    kind: 'view',
    query,
    queryKey: key,
    getSnapshot: () => current,
    subscribe,
    read: () => current,
    rows: () => current.rows,
    refresh: refreshView
  };

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function refreshView(): Promise<StoreViewSnapshot<Row, Version>> {
    const storeSnapshotValue = store.getSnapshot();
    if (initialized && storeSnapshotValue.revision === evaluatedRevision) {
      return Promise.resolve(current);
    }
    if (pendingRevision === storeSnapshotValue.revision && pendingRefresh !== undefined) {
      return pendingRefresh;
    }

    const serial = ++refreshSerial;
    pendingRevision = storeSnapshotValue.revision;
    pendingRefresh = store.query(query).then((result) => {
      const next = nextViewSnapshot(result, storeSnapshotValue);
      if (serial === refreshSerial) {
        current = next;
        initialized = true;
        evaluatedRevision = storeSnapshotValue.revision;
      }
      return next;
    }).finally(() => {
      if (serial === refreshSerial) {
        pendingRevision = undefined;
        pendingRefresh = undefined;
      }
    });
    return pendingRefresh;
  }

  function nextViewSnapshot(
    result: StoreQueryResult<Row>,
    storeSnapshotValue: StoreSnapshot<Version>
  ): StoreViewSnapshot<Row, Version> {
    if (sameResult(current, result)) {
      return current;
    }

    return viewSnapshot(result.rows, result.diagnostics, storeSnapshotValue, key);
  }
}

function viewSnapshot<Row, Version>(
  rows: readonly Row[],
  diagnostics: readonly StoreDiagnostic[],
  snapshot: StoreSnapshot<Version>,
  queryKeyValue: string
): StoreViewSnapshot<Row, Version> {
  return {
    rows,
    diagnostics,
    revision: snapshot.revision,
    queryKey: queryKeyValue,
    snapshot,
    db: snapshot.db,
    source: snapshot.source,
    ...(snapshot.version === undefined ? {} : { version: snapshot.version })
  };
}

function sameResult<Row>(
  snapshot: StoreViewSnapshot<Row>,
  result: StoreQueryResult<Row>
): boolean {
  return stableKey(snapshot.rows) === stableKey(result.rows) &&
    stableKey(snapshot.diagnostics) === stableKey(result.diagnostics);
}

function queryOne(
  db: Db,
  target: StoreQueryTarget,
  options: StoreQueryOptions | undefined
): Promise<StoreQueryResult> {
  return q(db, target, options) as Promise<StoreQueryResult>;
}

async function queryWhatIf(
  db: Db,
  queryOrQueries: StoreQueryTarget | StoreQueryBatch,
  args: StoreWhatIfArgs<unknown>
): Promise<StoreQueryResult | StoreQueryBatchResult<StoreQueryBatch>> {
  const { inputs, options } = splitStoreWhatIfArgs(args);
  const result = tryTransact(db, ...inputs);
  const readDb = result.committed ? result.db : db;
  const queryResult = isStoreQueryBatch(queryOrQueries)
    ? await qMany(readDb, queryOrQueries as QueryBatch, options)
    : await queryOne(readDb, queryOrQueries, options);

  return withTransactionDiagnostics(queryResult, result.diagnostics);
}

function splitStoreWhatIfArgs(
  args: StoreWhatIfArgs<unknown>
): { readonly inputs: readonly DbTransactionInput[]; readonly options: StoreQueryOptions } {
  const last = args.at(-1);
  if (last !== undefined && isStoreQueryOptions(last)) {
    return {
      inputs: args.slice(0, -1) as readonly DbTransactionInput[],
      options: last
    };
  }

  return {
    inputs: args as readonly DbTransactionInput[],
    options: {}
  };
}

function isStoreQueryOptions(input: DbTransactionInput | StoreQueryOptions): input is StoreQueryOptions {
  return isRecord(input) &&
    !('op' in input) &&
    ('env' in input || 'functions' in input || 'mapRows' in input || 'sort' in input || 'rsort' in input);
}

function withTransactionDiagnostics<Result extends StoreQueryResult | StoreQueryBatchResult<StoreQueryBatch>>(
  result: Result,
  diagnostics: readonly StoreDiagnostic[]
): Result {
  if (diagnostics.length === 0) return result;

  if (isStoreQueryResult(result)) {
    return {
      ...result,
      diagnostics: [...result.diagnostics, ...diagnostics]
    } as Result;
  }

  return Object.fromEntries(Object.entries(result).map(([name, queryResult]) => [
    name,
    {
      ...queryResult,
      diagnostics: [...queryResult.diagnostics, ...diagnostics]
    }
  ])) as Result;
}

function isStoreQueryResult(input: StoreQueryResult | StoreQueryBatchResult<StoreQueryBatch>): input is StoreQueryResult {
  return 'rows' in input && 'diagnostics' in input;
}

function isStoreQueryBatch(input: StoreQueryTarget | StoreQueryBatch): input is StoreQueryBatch {
  return isRecord(input) &&
    !isRelationRef(input) &&
    !('data' in input && 'relations' in input);
}

function isRelationRef(input: unknown): input is RelationRef {
  return isRecord(input) &&
    input.kind === 'relation' &&
    typeof input.name === 'string' &&
    isRecord(input.fields);
}

function storeSnapshot<Version = unknown>(
  db: Db,
  revision: number,
  diagnostics: readonly StoreDiagnostic[],
  source: RelationSource = dbSource(db),
  version?: Version
): StoreSnapshot<Version> {
  return {
    db,
    source,
    revision,
    diagnostics,
    ...(version === undefined ? {} : { version })
  };
}

async function runtimeStoreSnapshot<Version>(
  runtime: RelationRuntime<Version>,
  relations: readonly RelationRef[],
  revision: number,
  diagnostics: readonly StoreDiagnostic[],
  env: DbInputEnv | undefined
): Promise<StoreSnapshot<Version>> {
  const runtimeSnapshot = runtime.snapshot?.();
  const source = runtimeSnapshot?.source ?? runtime.source;
  const db = await sourceDb(source, relations, env);
  const version = runtimeSnapshot?.version ?? await source.version?.();
  const sourceDiagnostics = await source.diagnostics?.() ?? [];
  return storeSnapshot(db, revision, [...sourceDiagnostics, ...diagnostics], source, version);
}

async function sourceDb(
  source: RelationSource,
  relations: readonly RelationRef[],
  env: DbInputEnv | undefined
): Promise<Db> {
  const entries = await Promise.all(relations.map(async (relation): Promise<readonly [string, readonly unknown[]]> => [
    relation.name,
    await source.rows(relation)
  ]));
  const data = Object.fromEntries(entries);
  return env === undefined ? createDb(data) : createDb(data, { env });
}

function uniqueRelations(relations: readonly RelationRef[]): readonly RelationRef[] {
  return Array.from(new Map(relations.map((relation) => [relation.name, relation])).values());
}

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
