import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, type EvaluateEnv, type EvaluateOptions, type QueryResult } from './evaluate.js';
import type { Query } from './query.js';
import { fromObjectSource, type RelationSource } from './source.js';
import { applyWrites, type MutableObjectSourceData, type WriteApplyResult } from './write-apply.js';
import type { WriteInput } from './write.js';

/** Object-backed relation rows accepted by `createDb`. */
export type DbInputData = {
  readonly [relationName: string]: readonly unknown[];
};

/** Frozen relation arrays stored by a `Db`. */
export type DbData = {
  readonly [relationName: string]: readonly unknown[];
};

/** Frozen environment values stored separately from relation rows by a `Db`. */
export type DbEnv = EvaluateEnv;

/** Object-backed environment accepted by `createDb` and env helpers. */
export type DbInputEnv = Readonly<Record<string, unknown>>;

/** Immutable-ish object-backed database facade. */
export type Db = {
  readonly data: DbData;
  readonly env: DbEnv;
};

/** Nonthrowing transaction result, including the next database and write diagnostics. */
export type DbTransactionResult = WriteApplyResult & {
  readonly db: Db;
  readonly committed: boolean;
};

/** Object-backed DB transaction input, either immediate patches or a callback using the current DB. */
export type DbTransactionInput = WriteInput | ((db: Db) => WriteInput);

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
type DbAnyQueryOptions = EvaluateOptions & {
  readonly mapRows?: (rows: readonly never[]) => readonly unknown[];
};

/** Error thrown by `transact` when write diagnostics are produced. */
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

/** Create an object-backed database with cloned, frozen relation arrays and environment values. */
export function createDb(data: DbInputData = {}, env: DbInputEnv = {}): Db {
  return dbFromMutableData(cloneMutableData(data), env);
}

/** Expose a `Db` as a relation source for lower-level evaluator APIs. */
export function dbSource(db: Db): RelationSource {
  return fromObjectSource(db.data);
}

/** Return a copy of a `Db` with replaced environment values. */
export function withEnv(db: Db, env: DbInputEnv): Db {
  return dbFromData(db.data, env);
}

/** Read frozen environment values from a `Db`. */
export function getEnv(db: Db): DbEnv {
  return db.env;
}

/** Return a copy of a `Db` with environment values derived from the current env. */
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
/** Evaluate one query or a named query batch against a `Db`. */
export function q(
  db: Db,
  queryOrQueries: Query | QueryBatch,
  options?: DbAnyQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  return isQueryBatch(queryOrQueries)
    ? qManyInternal(db, queryOrQueries, options)
    : qOne(db, queryOrQueries, options);
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
/** Evaluate multiple named queries against the same `Db`. */
export function qMany(
  db: Db,
  queries: QueryBatch,
  options?: DbAnyQueryOptions
): Promise<QueryBatchResult<QueryBatch>> {
  return qManyInternal(db, queries, options);
}

async function qManyInternal(
  db: Db,
  queries: QueryBatch,
  options?: DbAnyQueryOptions
): Promise<QueryBatchResult<QueryBatch>> {
  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => [key, await qOne(db, query, options)] as const)
  );

  return Object.fromEntries(entries) as QueryBatchResult<QueryBatch>;
}

/** Return the first row for a query against a `Db`, if any. */
export async function row<Row>(db: Db, query: Query<Row>, options?: EvaluateOptions): Promise<Row | undefined> {
  const result = await q(db, query, options);
  return result.rows[0];
}

/** Return whether a query has at least one result row against a `Db`. */
export async function exists<Row>(db: Db, query: Query<Row>, options?: EvaluateOptions): Promise<boolean> {
  return (await row(db, query, options)) !== undefined;
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
/** Evaluate one query or a named query batch against the DB produced by applying write patches. */
export function whatIf(
  db: Db,
  queryOrQueries: Query | QueryBatch,
  patches: DbTransactionInput,
  options?: DbAnyQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  const nextDb = transact(db, patches);
  return isQueryBatch(queryOrQueries)
    ? qManyInternal(nextDb, queryOrQueries, options)
    : qOne(nextDb, queryOrQueries, options);
}

/**
 * Apply write patches and return the next `Db`.
 *
 * @throws DbTransactionError when any write diagnostics are produced. Use `tryTransact`
 * to keep the diagnostic result without throwing.
 */
export function transact(db: Db, patches: DbTransactionInput): Db {
  const result = tryTransact(db, patches);

  if (result.diagnostics.length > 0) {
    throw new DbTransactionError(result);
  }

  return result.db;
}

/** Apply write patches and return diagnostics without mutating the input `Db`. */
export function tryTransact(db: Db, patches: DbTransactionInput): DbTransactionResult {
  const data = cloneMutableData(db.data);
  const result = applyWrites(data, transactionInputPatches(db, patches));
  const committed = result.diagnostics.length === 0;

  return {
    db: committed ? dbFromMutableData(data, db.env) : db,
    patches: result.patches,
    applied: committed ? result.applied : 0,
    committed,
    deltas: committed ? result.deltas : [],
    diagnostics: result.diagnostics
  };
}

function transactionInputPatches(db: Db, patches: DbTransactionInput): WriteInput {
  return typeof patches === 'function' ? patches(db) : patches;
}

function cloneMutableData(data: DbInputData): MutableObjectSourceData {
  const output: MutableObjectSourceData = {};

  for (const [relationName, rows] of Object.entries(data)) {
    output[relationName] = Array.from(rows);
  }

  return output;
}

function dbFromMutableData(data: MutableObjectSourceData, env: DbInputEnv): Db {
  const output: Record<string, readonly unknown[]> = {};

  for (const [relationName, rows] of Object.entries(data)) {
    output[relationName] = Object.freeze(rows);
  }

  return dbFromData(Object.freeze(output), env);
}

function dbFromData(data: DbData, env: DbInputEnv): Db {
  return Object.freeze({
    data,
    env: Object.freeze({ ...env })
  });
}

function isQueryBatch(input: Query | QueryBatch): input is QueryBatch {
  return !('data' in input && 'relations' in input);
}

async function qOne<Row>(
  db: Db,
  query: Query<Row>,
  options?: DbAnyQueryOptions
): Promise<QueryResult<Row> | QueryResult<unknown>> {
  const result = await evaluate(dbSource(db), query, evaluatorOptions(db, options));

  return mapResultRows(result, options);
}

function evaluatorOptions(db: Db, options: EvaluateOptions | undefined): EvaluateOptions {
  return {
    ...(options?.functions === undefined ? {} : { functions: options.functions }),
    env: options?.env === undefined ? db.env : { ...db.env, ...options.env }
  };
}

function mapResultRows<Row>(
  result: QueryResult<Row>,
  options: DbAnyQueryOptions | undefined
): QueryResult<Row> | QueryResult<unknown> {
  if (options?.mapRows === undefined) {
    return result;
  }
  const mapRows = options.mapRows as (rows: readonly Row[]) => readonly unknown[];

  return {
    rows: mapRows(result.rows),
    diagnostics: result.diagnostics
  };
}
