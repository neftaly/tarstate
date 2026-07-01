import type { AdapterCommitStatus, RelationApplyDurability, RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
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
import { queryKey, type Query } from './query.js';
import type { RelationSource } from './source.js';
import { writeInputPatches, type WriteInput } from './write.js';

type QueryRow<QueryValue> = QueryValue extends Query<infer Row> ? Row : never;
type QueryBatchRow<Queries extends QueryBatch> = QueryRow<Queries[keyof Queries]>;

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

export type StoreCommitSnapshot = {
  readonly source: RelationSource;
  readonly revision: number;
  readonly diagnostics: readonly StoreDiagnostic[];
};

export type StoreSnapshot = StoreCommitSnapshot & {
  readonly db: Db;
};

export type StoreCommitInput = WriteInput;

export type StoreCommitEffects = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly durability?: RelationApplyDurability;
};

export type StoreCommitResult<
  Snapshot extends StoreCommitSnapshot = StoreSnapshot,
  Diagnostic extends StoreDiagnostic = StoreDiagnostic
> = {
  readonly kind: 'tarstateCommit';
  readonly status: AdapterCommitStatus;
  /** True when any patch effects were reflected in the backing store. */
  readonly reflected: boolean;
  readonly effects: StoreCommitEffects;
  readonly diagnostics: readonly Diagnostic[];
  readonly snapshot: Snapshot;
};

export type StoreQueryOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;
export type StoreViewReadOptions<Row = unknown, MappedRow = Row> = StoreQueryOptions<Row, MappedRow>;

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
  readonly getSnapshot: () => StoreSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
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
  readonly refresh: (options?: StoreQueryOptions<Row>) => Promise<StoreQueryResult<Row>>;
};

export type Store = {
  readonly kind: 'store';
  readonly getSnapshot: () => StoreSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly query: StoreQuery;
  readonly queries: StoreQueries;
  readonly view: <Row>(query: Query<Row>) => StoreView<Row>;
  readonly commit: (patches: StoreCommitInput) => Promise<StoreCommitResult>;
  readonly refresh: () => Promise<StoreSnapshot>;
};

/** Create the small renderer-independent Tarstate store facade over an object-backed `Db`. */
export function createStore(input: Db | DbInputData = createDb()): Store {
  let db = isDb(input) ? input : createDb(input);

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
    view: <Row>(query: Query<Row>) =>
      createStoreView(query, store),
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
    refresh: async () => setDb(db)
  };

  return store;
}

function createStoreView<Row>(
  query: Query<Row>,
  store: Store
): StoreView<Row> {
  const viewKey = queryKey(query);
  const read = (async (readOptions?: StoreViewReadOptions<Row>) =>
    readView(store.getSnapshot().db, query, readOptions)) as StoreView<Row>['read'];
  const rows = (async (readOptions?: StoreViewReadOptions<Row>) =>
    (await read(readOptions as never)).rows) as StoreView<Row>['rows'];

  return {
    kind: 'view',
    query,
    queryKey: viewKey,
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    read,
    rows,
    refresh: async (refreshOptions = {}) => store.query(query, refreshOptions)
  };
}

async function readView<Row, MappedRow = Row>(
  db: Db,
  query: Query<Row>,
  readOptions: StoreViewReadOptions<Row, MappedRow> = {}
): Promise<StoreQueryResult<Row> | StoreQueryResult<MappedRow>> {
  return queryDb(db, query, readOptions);
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
