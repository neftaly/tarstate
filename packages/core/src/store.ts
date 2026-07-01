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
    query: (async (queryValue: Query, options?: StoreQueryOptions) => q(snapshot.db, queryValue, options)) as StoreQuery,
    queries: (async (queries: QueryBatch, options?: StoreQueryOptions) => qMany(snapshot.db, queries, options)) as StoreQueries,
    view: <Row>(queryValue: Query<Row>) => createStoreView(queryValue, store),
    commit: async (patches) => {
      const result = tryTransact(snapshot.db, patches);
      return {
        kind: 'tarstateCommit',
        status: result.committed ? 'accepted' : 'rejected',
        reflected: false,
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
}

function createStoreView<Row>(query: Query<Row>, store: Store): StoreView<Row> {
  const read = (async (options?: StoreViewReadOptions<Row>) => store.query(query, options)) as StoreView<Row>['read'];
  const rows = (async (options?: StoreViewReadOptions<Row>) => (await read(options as never)).rows) as StoreView<Row>['rows'];

  return {
    kind: 'view',
    query,
    queryKey: queryKey(query),
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    read,
    rows,
    refresh: async (options = {}) => store.query(query, options)
  };
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
