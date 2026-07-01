import type { RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import type { EvaluateEnv, EvaluateOptions, QueryResult } from './evaluate.js';
import type { Query } from './query.js';
import type { RelationRef } from './schema.js';
import { fromObjectSource, type RelationSource } from './source.js';
import { stubDiagnostic } from './stub.js';
import {
  deleteByKey as writeDeleteByKey,
  updateByKey as writeUpdateByKey,
  writeInputPatches,
  type DeleteByKeyPatch,
  type RelationKeyInput,
  type RelationRow,
  type RelationRowUpdate,
  type UpdateByKeyPatch,
  type WriteInput
} from './write.js';

export type DbInputData = {
  readonly [relationName: string]: readonly unknown[];
};

export type DbData = {
  readonly [relationName: string]: readonly unknown[];
};

export type DbEnv = EvaluateEnv;
export type DbInputEnv = Readonly<Record<string, unknown>>;

export type Db = {
  readonly data: DbData;
  readonly env: DbEnv;
};

export type DbTransactionResult = {
  readonly db: Db;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly committed: boolean;
};

export type DbTransactionInput = WriteInput | ((_db: Db) => WriteInput);
export type DbTransactionInputs = readonly DbTransactionInput[];
export type DbWritePredicate<Relation extends RelationRef> = (
  row: RelationRow<Relation>,
  index: number,
  db: Db
) => boolean;
export type DbWriteKey = RelationKeyInput;
export type DbWriteMatcher<Relation extends RelationRef> = DbWriteKey | DbWritePredicate<Relation>;

type QueryRow<QueryValue> = QueryValue extends Query<infer Row> ? Row : never;
type QueryBatchRow<Queries extends QueryBatch> = QueryRow<Queries[keyof Queries]>;
export type QueryBatch = Record<string, Query>;
export type QueryBatchResult<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: QueryResult<QueryRow<Queries[Key]>>;
};
export type MappedQueryBatchResult<Queries extends QueryBatch, MappedRow> = {
  readonly [Key in keyof Queries]: QueryResult<MappedRow>;
};
export type DbQueryOptions<Row = unknown, MappedRow = Row> = EvaluateOptions & {
  readonly mapRows?: (rows: readonly Row[]) => readonly MappedRow[];
};
type DbMapRowsOptions<Row, MappedRow> = EvaluateOptions & {
  readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[];
};

export class DbTransactionError extends Error {
  readonly result: DbTransactionResult;

  constructor(result: DbTransactionResult) {
    super(`transaction produced ${result.diagnostics.length} diagnostic(s)`);
    this.name = 'DbTransactionError';
    this.result = result;
  }

  get db(): Db {
    return this.result.db;
  }

  get diagnostics(): readonly TarstateDiagnostic[] {
    return this.result.diagnostics;
  }

  get patches(): number {
    return this.result.patches;
  }

  get applied(): number {
    return this.result.applied;
  }

  get committed(): boolean {
    return this.result.committed;
  }
}

export function createDb(data: DbInputData = {}, env: DbInputEnv = {}): Db {
  return Object.freeze({
    data: Object.freeze(Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, Object.freeze([...rows])]))),
    env: Object.freeze({ ...env })
  });
}

export function dbSource(db: Db): RelationSource {
  return fromObjectSource(db.data);
}

export function stripMeta(db: Db): DbData;
export function stripMeta<Input>(input: Input): Input;
export function stripMeta(input: unknown): unknown {
  return isDb(input) ? input.data : input;
}

export function withEnv(db: Db, env: DbInputEnv): Db {
  return createDb(db.data, env);
}

export function getEnv(db: Db): DbEnv {
  return db.env;
}

export function updateEnv(db: Db, update: (env: DbEnv) => DbInputEnv): Db {
  return withEnv(db, update(db.env));
}

export function q<Row, MappedRow>(
  db: Db,
  query: Query<Row>,
  options: DbMapRowsOptions<Row, MappedRow>
): Promise<QueryResult<MappedRow>>;
export function q<Row>(db: Db, query: Query<Row>, options?: DbQueryOptions<Row>): Promise<QueryResult<Row>>;
export function q<const Queries extends QueryBatch, MappedRow>(
  db: Db,
  queries: Queries,
  options: DbMapRowsOptions<QueryBatchRow<Queries>, MappedRow>
): Promise<MappedQueryBatchResult<Queries, MappedRow>>;
export function q<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  options?: DbQueryOptions<QueryBatchRow<Queries>>
): Promise<QueryBatchResult<Queries>>;
export async function q(
  _db: Db,
  queryOrQueries: Query | QueryBatch,
  _options?: DbQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  if (isQueryBatch(queryOrQueries)) {
    return Object.fromEntries(Object.keys(queryOrQueries).map((name) => [name, emptyQueryResult()]));
  }

  return emptyQueryResult();
}

export function qRows<Row, MappedRow>(
  db: Db,
  query: Query<Row>,
  options: DbMapRowsOptions<Row, MappedRow>
): Promise<readonly MappedRow[]>;
export function qRows<Row>(
  db: Db,
  query: Query<Row>,
  options?: DbQueryOptions<Row>
): Promise<readonly Row[]>;
export async function qRows(_db: Db, _query: Query, _options?: DbQueryOptions): Promise<readonly unknown[]> {
  return [];
}

export function qMany<const Queries extends QueryBatch, MappedRow>(
  db: Db,
  queries: Queries,
  options: DbMapRowsOptions<QueryBatchRow<Queries>, MappedRow>
): Promise<MappedQueryBatchResult<Queries, MappedRow>>;
export function qMany<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  options?: DbQueryOptions<QueryBatchRow<Queries>>
): Promise<QueryBatchResult<Queries>>;
export async function qMany(
  _db: Db,
  queries: QueryBatch,
  _options?: DbQueryOptions
): Promise<QueryBatchResult<QueryBatch>> {
  return Object.fromEntries(Object.keys(queries).map((name) => [name, emptyQueryResult()]));
}

export type QueryBatchRows<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: readonly QueryRow<Queries[Key]>[];
};
export type MappedQueryBatchRows<Queries extends QueryBatch, MappedRow> = {
  readonly [Key in keyof Queries]: readonly MappedRow[];
};

export function qManyRows<const Queries extends QueryBatch, MappedRow>(
  db: Db,
  queries: Queries,
  options: DbMapRowsOptions<QueryBatchRow<Queries>, MappedRow>
): Promise<MappedQueryBatchRows<Queries, MappedRow>>;
export function qManyRows<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  options?: DbQueryOptions<QueryBatchRow<Queries>>
): Promise<QueryBatchRows<Queries>>;
export async function qManyRows(
  _db: Db,
  queries: QueryBatch,
  _options?: DbQueryOptions
): Promise<Record<string, readonly unknown[]>> {
  return Object.fromEntries(Object.keys(queries).map((name) => [name, []]));
}

export async function row<Row>(_db: Db, _query: Query<Row>, _options?: EvaluateOptions): Promise<Row | undefined> {
  return undefined;
}

export async function exists<Row>(_db: Db, _query: Query<Row>, _options?: EvaluateOptions): Promise<boolean> {
  return false;
}

export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  key: DbWriteKey,
  changes: RelationRowUpdate<Relation>
): UpdateByKeyPatch<Relation>;
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: DbWritePredicate<Relation>,
  changes: RelationRowUpdate<Relation>
): (_db: Db) => readonly UpdateByKeyPatch<Relation>[];
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  keyOrPredicate: DbWriteMatcher<Relation>,
  changes: RelationRowUpdate<Relation>
): UpdateByKeyPatch<Relation> | ((_db: Db) => readonly UpdateByKeyPatch<Relation>[]) {
  return typeof keyOrPredicate === 'function' ? () => [] : writeUpdateByKey(relation, keyOrPredicate, changes);
}

export function dbDeleteWhere<Relation extends RelationRef>(
  relation: Relation,
  key: DbWriteKey
): DeleteByKeyPatch<Relation>;
export function dbDeleteWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: DbWritePredicate<Relation>
): (_db: Db) => readonly DeleteByKeyPatch<Relation>[];
export function dbDeleteWhere<Relation extends RelationRef>(
  relation: Relation,
  keyOrPredicate: DbWriteMatcher<Relation>
): DeleteByKeyPatch<Relation> | ((_db: Db) => readonly DeleteByKeyPatch<Relation>[]) {
  return typeof keyOrPredicate === 'function' ? () => [] : writeDeleteByKey(relation, keyOrPredicate);
}

export function whatIf<Row, MappedRow>(
  db: Db,
  query: Query<Row>,
  patches: DbTransactionInput,
  options: DbMapRowsOptions<Row, MappedRow>
): Promise<QueryResult<MappedRow>>;
export function whatIf<Row>(
  db: Db,
  query: Query<Row>,
  patches: DbTransactionInput,
  options?: DbQueryOptions<Row>
): Promise<QueryResult<Row>>;
export function whatIf<const Queries extends QueryBatch, MappedRow>(
  db: Db,
  queries: Queries,
  patches: DbTransactionInput,
  options: DbMapRowsOptions<QueryBatchRow<Queries>, MappedRow>
): Promise<MappedQueryBatchResult<Queries, MappedRow>>;
export function whatIf<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  patches: DbTransactionInput,
  options?: DbQueryOptions<QueryBatchRow<Queries>>
): Promise<QueryBatchResult<Queries>>;
export function whatIf(
  db: Db,
  queryOrQueries: Query | QueryBatch,
  _patches: DbTransactionInput,
  options?: DbQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  return isQueryBatch(queryOrQueries)
    ? qMany(db, queryOrQueries, options)
    : q(db, queryOrQueries, options);
}

export function transact(db: Db, ...inputs: DbTransactionInputs): Db {
  const result = tryTransact(db, ...inputs);
  throw new DbTransactionError(result);
}

export function tryTransact(db: Db, ...inputs: DbTransactionInputs): DbTransactionResult {
  return {
    db,
    patches: transactionPatchCount(db, inputs),
    applied: 0,
    deltas: [],
    diagnostics: [stubDiagnostic('db')],
    committed: false
  };
}

function transactionPatchCount(db: Db, inputs: DbTransactionInputs): number {
  return inputs.reduce((total, input) => {
    const patches = typeof input === 'function' ? input(db) : input;
    return total + Array.from(writeInputPatches(patches)).length;
  }, 0);
}

function emptyQueryResult<Row = unknown>(): QueryResult<Row> {
  return { rows: [], diagnostics: [] };
}

function isQueryBatch(input: Query | QueryBatch): input is QueryBatch {
  return !('data' in input && 'relations' in input);
}

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}
