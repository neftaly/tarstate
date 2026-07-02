import type { RelationApplyDurability, RelationApplyStatus, RelationDelta, RelationRuntime } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import {
  createDb,
  dbSource,
  q,
  qMany,
  tryTransact,
  type Db,
  type DbInputData,
  type DbInputEnv,
  type DbQueryOptions,
  type QueryBatch
} from './db.js';
import { maintainMaterializations } from './materialization.js';
import { queryKey, type Query } from './query.js';
import type { RelationRef } from './schema.js';
import type { RelationSource } from './source.js';
import { trackRuntimeCommit } from './runtime.js';
import { transferWatches } from './watch.js';
import { trackWatchedChanges } from './watch-tracking.js';
import { writeInputPatches, type RelationRow, type WriteInput } from './write.js';

type QueryRow<QueryValue> = QueryValue extends Query<infer Row>
  ? Row
  : QueryValue extends RelationRef<infer Row>
    ? Row
    : QueryValue extends string
      ? unknown
      : never;
type QueryBatchRow<Queries extends QueryBatch> = QueryRow<Queries[keyof Queries]>;
type StoreQueryTarget<Row = unknown> = Query<Row> | RelationRef | string;

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

export type StoreQueryBatchResult<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: StoreQueryResult<QueryRow<Queries[Key]>>;
};

export type StoreMappedQueryBatchResult<Queries extends QueryBatch, MappedRow> = {
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

export type StoreCommitInput = WriteInput;

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
  <MappedRow>(
    relationName: string,
    options: StoreQueryOptions<unknown, MappedRow> & {
      readonly mapRows: (rows: readonly unknown[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  (relationName: string, options?: StoreQueryOptions<unknown>): Promise<StoreQueryResult<unknown>>;
};

export type StoreQueries = {
  <const Queries extends QueryBatch, MappedRow>(
    queries: Queries,
    options: StoreQueryOptions<QueryBatchRow<Queries>, MappedRow> & {
      readonly mapRows: (rows: readonly QueryBatchRow<Queries>[]) => readonly MappedRow[];
    }
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  <const Queries extends QueryBatch>(
    queries: Queries,
    options?: StoreQueryOptions<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
};

export type StoreViewRead<Row = unknown> = {
    <MappedRow>(
      options: StoreViewReadOptions<Row, MappedRow> & {
        readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
      }
    ): Promise<StoreQueryResult<MappedRow>>;
    (options?: StoreViewReadOptions<Row>): Promise<StoreQueryResult<Row>>;
};

export type StoreView<Row = unknown, Version = unknown> = {
  readonly kind: 'view';
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly getSnapshot: () => StoreSnapshot<Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: StoreViewRead<Row>;
  readonly rows: {
    <MappedRow>(
      options: StoreViewReadOptions<Row, MappedRow> & {
        readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
      }
    ): Promise<readonly MappedRow[]>;
    (options?: StoreViewReadOptions<Row>): Promise<readonly Row[]>;
  };
  readonly refresh: StoreViewRead<Row>;
};

export type Store<Version = unknown> = {
  readonly kind: 'store';
  readonly getSnapshot: () => StoreSnapshot<Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly query: StoreQuery;
  readonly queries: StoreQueries;
  readonly view: <Row>(query: Query<Row>) => StoreView<Row, Version>;
  readonly commit: (patches: StoreCommitInput) => Promise<StoreCommitResult<Version>>;
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
    view: <Row>(queryValue: Query<Row>) => createStoreView(queryValue, store),
    commit: async (patches) => {
      const previousDb = snapshot.db;
      const result = tryTransact(previousDb, patches);
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
  function queryStore<MappedRow>(
    relationName: string,
    options: StoreQueryOptions<unknown, MappedRow> & {
      readonly mapRows: (rows: readonly unknown[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  function queryStore(relationName: string, options?: StoreQueryOptions<unknown>): Promise<StoreQueryResult<unknown>>;
  function queryStore(queryValue: StoreQueryTarget, options?: StoreQueryOptions<any, any>): Promise<any> {
    return queryOne(snapshot.db, queryValue, options);
  }

  function queryStores<const Queries extends QueryBatch, MappedRow>(
    queries: Queries,
    options: StoreQueryOptions<QueryBatchRow<Queries>, MappedRow> & {
      readonly mapRows: (rows: readonly QueryBatchRow<Queries>[]) => readonly MappedRow[];
    }
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  function queryStores<const Queries extends QueryBatch>(
    queries: Queries,
    options?: StoreQueryOptions<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
  function queryStores(queries: QueryBatch, options?: StoreQueryOptions): Promise<StoreQueryBatchResult<QueryBatch>> {
    return qMany(snapshot.db, queries, options);
  }
}

export async function createRuntimeStore<Version>(input: StoreRuntimeInput<Version>): Promise<Store<Version>> {
  const relationList = uniqueRelations(input.relations);
  let snapshot = await runtimeStoreSnapshot(input.runtime, relationList, 0, [], input.env);
  const listeners = new Set<() => void>();
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
    view: <Row>(queryValue: Query<Row>) => createStoreView(queryValue, store),
    commit: async (patches) => {
      const patchList = Array.from(writeInputPatches(patches));
      applyingCommit = true;
      const result = await trackRuntimeCommit(input.runtime, patchList, { readVersion: true })
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
  async function queryRuntimeStore<MappedRow>(
    relationName: string,
    options: StoreQueryOptions<unknown, MappedRow> & {
      readonly mapRows: (rows: readonly unknown[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  async function queryRuntimeStore(relationName: string, options?: StoreQueryOptions<unknown>): Promise<StoreQueryResult<unknown>>;
  async function queryRuntimeStore(queryValue: StoreQueryTarget, options?: StoreQueryOptions<any, any>): Promise<any> {
    return queryOne(snapshot.db, queryValue, options);
  }

  async function queryRuntimeStores<const Queries extends QueryBatch, MappedRow>(
    queries: Queries,
    options: StoreQueryOptions<QueryBatchRow<Queries>, MappedRow> & {
      readonly mapRows: (rows: readonly QueryBatchRow<Queries>[]) => readonly MappedRow[];
    }
  ): Promise<StoreMappedQueryBatchResult<Queries, MappedRow>>;
  async function queryRuntimeStores<const Queries extends QueryBatch>(
    queries: Queries,
    options?: StoreQueryOptions<QueryBatchRow<Queries>>
  ): Promise<StoreQueryBatchResult<Queries>>;
  async function queryRuntimeStores(
    queries: QueryBatch,
    options?: StoreQueryOptions
  ): Promise<StoreQueryBatchResult<QueryBatch>> {
    return qMany(snapshot.db, queries, options);
  }
}

function createStoreView<Row, Version>(query: Query<Row>, store: Store<Version>): StoreView<Row, Version> {
  return {
    kind: 'view',
    query,
    queryKey: queryKey(query),
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    read: readView,
    rows: readRows,
    refresh: readView
  };

  function readView<MappedRow>(
    options: StoreViewReadOptions<Row, MappedRow> & {
      readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
    }
  ): Promise<StoreQueryResult<MappedRow>>;
  function readView(options?: StoreViewReadOptions<Row>): Promise<StoreQueryResult<Row>>;
  function readView<MappedRow>(
    options?: StoreViewReadOptions<Row, MappedRow>
  ): Promise<StoreQueryResult<Row> | StoreQueryResult<MappedRow>> {
    if (options?.mapRows !== undefined) {
      return store.query(query, options as StoreQueryOptions<Row, MappedRow> & {
        readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
      });
    }

    return store.query(query, viewReadOptionsWithoutMapRows(options));
  }

  function readRows<MappedRow>(
    options: StoreViewReadOptions<Row, MappedRow> & {
      readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
    }
  ): Promise<readonly MappedRow[]>;
  function readRows(options?: StoreViewReadOptions<Row>): Promise<readonly Row[]>;
  async function readRows<MappedRow>(
    options?: StoreViewReadOptions<Row, MappedRow>
  ): Promise<readonly Row[] | readonly MappedRow[]> {
    if (options?.mapRows !== undefined) {
      return (await readView(options as StoreViewReadOptions<Row, MappedRow> & {
        readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
      })).rows;
    }

    return (await readView(viewReadOptionsWithoutMapRows(options))).rows;
  }
}

function viewReadOptionsWithoutMapRows<Row>(
  options: StoreViewReadOptions<Row, unknown> | undefined
): StoreQueryOptions<Row> | undefined {
  if (options === undefined) {
    return undefined;
  }
  const { mapRows: _mapRows, ...rowOptions } = options;
  return rowOptions;
}

function queryOne(
  db: Db,
  target: StoreQueryTarget,
  options: StoreQueryOptions | undefined
): Promise<StoreQueryResult> {
  return q(db, target, options) as Promise<StoreQueryResult>;
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
