import type { AdapterCommitStatus, RelationApplyDurability } from './adapter.js';
import {
  attachConstraints,
  hasAttachedConstraints,
  tryTransactConstrained,
  type ConstraintAttachmentInput
} from './constraints.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './delta.js';
import {
  createDb,
  dbSource,
  q,
  qMany,
  tryTransact,
  type Db,
  type DbInputData,
  type DbQueryOptions,
  type QueryBatch
} from './db.js';
import {
  materializationForQuery,
  materializedRowsForQuery,
  mat,
  readMaterializedQuery,
  refreshMaterializationSnapshot,
  type MaterializationDiagnostic,
  type MaterializationMaintenanceResult,
  type MaterializationMetadata,
  type SnapshotMaterializationOptions
} from './materialization.js';
import { queryKey, type Query } from './query.js';
import { trackTransact } from './runtime.js';
import type { RelationSource } from './source.js';
import type { TrackedChange, WatchRuntimeDiagnostic } from './watch.js';
import { writeInputPatches, type WriteInput } from './write.js';

type QueryRow<QueryValue> = QueryValue extends Query<infer Row> ? Row : never;
type QueryBatchRow<Queries extends QueryBatch> = QueryRow<Queries[keyof Queries]>;

export type StoreDiagnostic = TarstateDiagnostic | MaterializationDiagnostic | WatchRuntimeDiagnostic;

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

export type StoreSnapshot = {
  readonly source: RelationSource;
  readonly revision: number;
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly db: Db;
};

export type StoreCommitInput = WriteInput;

export type StoreCommitResult<Snapshot extends StoreSnapshot = StoreSnapshot> = {
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
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly snapshot: Snapshot;
};

export type StoreOptions = {
  /** Attach constraints to the object-backed Db used by this store. */
  readonly constraints?: ConstraintAttachmentInput;
};

export type StoreViewReadPolicy = 'prefer-cache' | 'ignore-cache';

export type StoreQueryOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;
export type StoreViewReadOptions<Row = unknown, MappedRow = Row> =
  StoreQueryOptions<Row, MappedRow> & {
    /** Prefer current materialized rows when available. Defaults to `prefer-cache`. */
    readonly cache?: StoreViewReadPolicy;
  };

export type StoreViewOptions = Pick<SnapshotMaterializationOptions, 'id' | 'name' | 'mode'> & {
  /** Default read policy for this view. */
  readonly cache?: StoreViewReadPolicy;
};

export type StoreMaterializationResult<Row = unknown> = {
  readonly kind: 'storeMaterialization';
  readonly materialized: boolean;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly metadata?: MaterializationMetadata<Row>;
};

export type StoreQuery = {
  <Row, MappedRow>(
    query: Query<Row>,
    options: StoreQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
  ): Promise<StoreQueryResult<MappedRow>>;
  <Row>(query: Query<Row>, options?: StoreQueryOptions<Row>): Promise<StoreQueryResult<Row>>;
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

export type StoreView<Row = unknown> = {
  readonly kind: 'view';
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly id?: string;
  readonly getSnapshot: () => StoreSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly materialization: () => MaterializationMetadata<Row> | undefined;
  readonly read: {
    <MappedRow>(
      options: StoreViewReadOptions<Row, MappedRow> & {
        readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
      }
    ): Promise<StoreQueryResult<MappedRow>>;
    (options?: StoreViewReadOptions<Row>): Promise<StoreQueryResult<Row>>;
  };
  readonly rows: {
    <MappedRow>(
      options: StoreViewReadOptions<Row, MappedRow> & {
        readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
      }
    ): Promise<readonly MappedRow[]>;
    (options?: StoreViewReadOptions<Row>): Promise<readonly Row[]>;
  };
  readonly materialize: (options?: SnapshotMaterializationOptions) => Promise<StoreMaterializationResult<Row>>;
  readonly refresh: (options?: StoreQueryOptions<Row>) => Promise<StoreQueryResult<Row>>;
};

export type Store = {
  readonly kind: 'store';
  readonly getSnapshot: () => StoreSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly query: StoreQuery;
  readonly queries: StoreQueries;
  readonly view: <Row>(query: Query<Row>, options?: StoreViewOptions) => StoreView<Row>;
  readonly materialize: <Row>(
    query: Query<Row>,
    options?: SnapshotMaterializationOptions
  ) => Promise<StoreMaterializationResult<Row>>;
  readonly commit: (patches: StoreCommitInput) => Promise<StoreCommitResult>;
  readonly refresh: () => Promise<StoreSnapshot>;
};

/** Create the small renderer-independent Tarstate store facade over an object-backed `Db`. */
export function createStore(input: Db | DbInputData = createDb(), options: StoreOptions = {}): Store {
  let db = isDb(input) ? input : createDb(input);

  if (options.constraints !== undefined) {
    db = attachConstraints(db, options.constraints);
  }

  let revision = 0;
  let snapshot = storeSnapshot(db, revision, []);
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setDb = (nextDb: Db, diagnostics: readonly StoreDiagnostic[] = []): StoreSnapshot => {
    db = nextDb;
    revision += 1;
    snapshot = storeSnapshot(db, revision, diagnostics);
    notify();
    return snapshot;
  };

  const store: Store = {
    kind: 'store',
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    query: (async (query: Query, queryOptions?: StoreQueryOptions) =>
      q(db, query, queryOptions)) as StoreQuery,
    queries: (async (queries: QueryBatch, queryOptions?: StoreQueryOptions) =>
      qMany(db, queries, queryOptions)) as StoreQueries,
    view: <Row>(query: Query<Row>, viewOptions: StoreViewOptions = {}) =>
      createStoreView(query, viewOptions, store),
    materialize: async <Row>(query: Query<Row>, materializeOptions: SnapshotMaterializationOptions = {}) =>
      store.view(query, materializeOptions).materialize(materializeOptions),
    commit: async (patches) => {
      const patchList = Array.from(writeInputPatches(patches));
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
      const reflected = commitReflected(tracked.deltas);

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
    refresh: async () => setDb(db)
  };

  return store;
}

function createStoreView<Row>(
  query: Query<Row>,
  viewOptions: StoreViewOptions,
  store: Store
): StoreView<Row> {
  const viewKey = queryKey(query);
  const read = (async (readOptions?: StoreViewReadOptions<Row>) =>
    readView(store.getSnapshot().db, query, viewOptions, readOptions)) as StoreView<Row>['read'];
  const rows = (async (readOptions?: StoreViewReadOptions<Row>) =>
    (await read(readOptions as never)).rows) as StoreView<Row>['rows'];

  return {
    kind: 'view',
    query,
    queryKey: viewKey,
    ...(viewOptions.id === undefined ? {} : { id: viewOptions.id }),
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    materialization: () => materializationForQuery(store.getSnapshot().db, query),
    read,
    rows,
    materialize: async (materializeOptions = {}) => {
      const snapshot = store.getSnapshot();
      await mat(snapshot.db, query, {
        ...viewMaterializationOptions(viewOptions),
        ...materializeOptions
      });
      await store.refresh();

      const metadata = materializationForQuery<Row>(store.getSnapshot().db, query);
      const rows = materializedRowsForQuery<Row>(store.getSnapshot().db, query) ?? [];

      return {
        kind: 'storeMaterialization',
        materialized: metadata !== undefined,
        rows,
        diagnostics: metadata?.diagnostics ?? [],
        ...(metadata === undefined ? {} : { metadata })
      };
    },
    refresh: async (refreshOptions = {}) => {
      const snapshot = store.getSnapshot();
      const metadata = materializationForQuery<Row>(snapshot.db, query);

      if (metadata === undefined) {
        return store.query(query, refreshOptions);
      }

      const refreshed = await refreshMaterializationSnapshot(snapshot.db, metadata, refreshOptions);
      await store.refresh();

      return {
        rows: refreshed.rows,
        diagnostics: refreshed.diagnostics
      };
    }
  };
}

async function readView<Row, MappedRow = Row>(
  db: Db,
  query: Query<Row>,
  viewOptions: StoreViewOptions,
  readOptions: StoreViewReadOptions<Row, MappedRow> = {}
): Promise<StoreQueryResult<Row> | StoreQueryResult<MappedRow>> {
  const cachePolicy = readOptions.cache ?? viewOptions.cache ?? 'prefer-cache';

  if (cachePolicy === 'prefer-cache' && readOptions.env === undefined && readOptions.functions === undefined) {
    const cached = await readMaterializedQuery<Row>(db, query);

    if (cached.materialized) {
      return mapStoreResult(
        {
          rows: cached.rows,
          diagnostics: cached.diagnostics
        },
        readOptions
      );
    }
  }

  const queryOptions = queryReadOptions(readOptions);

  return queryDb(db, query, queryOptions);
}

function queryDb<Row, MappedRow = Row>(
  db: Db,
  query: Query<Row>,
  options?: StoreQueryOptions<Row, MappedRow>
): Promise<StoreQueryResult<Row> | StoreQueryResult<MappedRow>> {
  const run = q as unknown as (
    db: Db,
    query: Query<Row>,
    options?: StoreQueryOptions<Row, MappedRow>
  ) => Promise<StoreQueryResult<Row> | StoreQueryResult<MappedRow>>;

  return run(db, query, options);
}

function mapStoreResult<Row, MappedRow>(
  result: StoreQueryResult<Row>,
  options: StoreQueryOptions<Row, MappedRow>
): StoreQueryResult<Row> | StoreQueryResult<MappedRow> {
  if (options.mapRows === undefined) {
    return result;
  }

  return {
    rows: options.mapRows(result.rows),
    diagnostics: result.diagnostics
  };
}

function queryReadOptions<Row, MappedRow>(
  options: StoreViewReadOptions<Row, MappedRow>
): StoreQueryOptions<Row, MappedRow> {
  const { cache: _cache, ...queryOptions } = options;
  return queryOptions;
}

function viewMaterializationOptions(options: StoreViewOptions): SnapshotMaterializationOptions {
  return {
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.mode === undefined ? {} : { mode: options.mode })
  };
}

function storeSnapshot(
  db: Db,
  revision: number,
  diagnostics: readonly StoreDiagnostic[]
): StoreSnapshot {
  return {
    source: dbSource(db),
    revision,
    diagnostics,
    db
  };
}

function commitReflected(deltas: readonly RelationDelta[]): boolean {
  return deltas.some((delta) => delta.added.length > 0 || delta.removed.length > 0);
}

function isDb(input: Db | DbInputData): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}
