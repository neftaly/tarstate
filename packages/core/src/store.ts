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
import type { WriteInput } from './write.js';

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

export function createStore(input: Db | DbInputData = createDb()): Store {
  const db = isDb(input) ? input : createDb(input);
  let snapshot = storeSnapshot(db, 0, []);
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const store: Store = {
    kind: 'store',
    getSnapshot: () => snapshot,
    subscribe,
    query: queryStore,
    queries: queryStores,
    view: <Row>(queryValue: Query<Row>) => createStoreView(queryValue, store),
    commit: async (patches) => {
      const result = tryTransact(snapshot.db, patches);
      const reflected = result.committed;

      if (reflected) {
        snapshot = storeSnapshot(result.db, snapshot.revision + 1, result.diagnostics);
        for (const listener of listeners) listener();
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
      for (const listener of listeners) listener();
      return snapshot;
    }
  };

  return store;

  function queryStore<Row, MappedRow>(
    queryValue: Query<Row>,
    options: StoreQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
  ): Promise<StoreQueryResult<MappedRow>>;
  function queryStore<Row>(queryValue: Query<Row>, options?: StoreQueryOptions<Row>): Promise<StoreQueryResult<Row>>;
  function queryStore(queryValue: Query, options?: StoreQueryOptions): Promise<StoreQueryResult> {
    return q(snapshot.db, queryValue, options);
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

function createStoreView<Row>(query: Query<Row>, store: Store): StoreView<Row> {
  return {
    kind: 'view',
    query,
    queryKey: queryKey(query),
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    read: readView,
    rows: readRows,
    refresh: async (options = {}) => store.query(query, options)
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

    return store.query(query);
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

    return (await readView()).rows;
  }
}

function storeSnapshot(db: Db, revision: number, diagnostics: readonly StoreDiagnostic[]): StoreSnapshot {
  return {
    db,
    source: dbSource(db),
    revision,
    diagnostics
  };
}

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}
