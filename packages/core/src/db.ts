import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, type EvaluateEnv, type EvaluateOptions, type QueryResult } from './evaluate.js';
import type { Query } from './query.js';
import type { RelationRef } from './schema.js';
import { fromObjectSource, type RelationSource } from './source.js';
import { applyWrites, type MutableObjectSourceData } from './write-apply.js';
import type { RelationDelta } from './adapter.js';
import {
  deleteByKey as writeDeleteByKey,
  updateByKey as writeUpdateByKey,
  writeInputPatches,
  type DeleteByKeyPatch,
  type RelationKeyInput,
  type RelationRow,
  type RelationRowUpdate,
  type UpdateByKeyPatch,
  type WriteInput,
  type WritePatch
} from './write.js';

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
export type DbTransactionResult = {
  readonly db: Db;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly committed: boolean;
};

/** Object-backed DB transaction input, either immediate patches or a callback resolved against the input `Db`. */
export type DbTransactionInput = WriteInput | ((db: Db) => WriteInput);
export type DbTransactionInputs = readonly DbTransactionInput[];
/** Predicate accepted by object-backed DB patch facades. */
export type DbWritePredicate<Relation extends RelationRef> = (
  row: RelationRow<Relation>,
  index: number,
  db: Db
) => boolean;
/** Relation key input accepted by object-backed DB patch facades. */
export type DbWriteKey = RelationKeyInput;
/** Limited DB write matcher: either a relation key input or an object-row predicate. */
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

export function stripMeta(db: Db): DbData;
export function stripMeta<Input>(input: Input): Input;
/**
 * Return plain relation data for a `Db`, or pass through non-Db values.
 *
 * @remarks Tarstate metadata lives outside `Db.data`, so the stripped form is
 * the normalized row data.
 */
export function stripMeta(input: unknown): unknown {
  return isDb(input) ? input.data : input;
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
/** Evaluate one query and return only rows, preserving `q` for diagnostics-aware callers. */
export async function qRows(
  db: Db,
  query: Query,
  options?: DbAnyQueryOptions
): Promise<readonly unknown[]> {
  return (await qOne(db, query, options)).rows;
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
/** Evaluate a named query batch and return only row arrays by query name. */
export async function qManyRows(
  db: Db,
  queries: QueryBatch,
  options?: DbAnyQueryOptions
): Promise<Record<string, readonly unknown[]>> {
  const result = await qManyInternal(db, queries, options);
  return Object.fromEntries(Object.entries(result).map(([name, item]) => [name, item.rows]));
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

export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  key: DbWriteKey,
  changes: RelationRowUpdate<Relation>
): UpdateByKeyPatch<Relation>;
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: DbWritePredicate<Relation>,
  changes: RelationRowUpdate<Relation>
): (db: Db) => readonly UpdateByKeyPatch<Relation>[];
/**
 * Create update patches for a scalar/tuple relation key or rows matching a JS predicate.
 */
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  keyOrPredicate: DbWriteMatcher<Relation>,
  changes: RelationRowUpdate<Relation>
): UpdateByKeyPatch<Relation> | ((db: Db) => readonly UpdateByKeyPatch<Relation>[]) {
  if (typeof keyOrPredicate !== 'function') {
    return writeUpdateByKey(relation, keyOrPredicate, changes);
  }

  const predicate = keyOrPredicate as DbWritePredicate<Relation>;

  return (db) =>
    dbRelationRows(db, relation).flatMap((relationRow, index) =>
      predicate(relationRow, index, db)
        ? [writeUpdateByKey(relation, relationKeyInputFromRow(relation, relationRow), changes)]
        : []
    );
}

export function dbDeleteWhere<Relation extends RelationRef>(
  relation: Relation,
  key: DbWriteKey
): DeleteByKeyPatch<Relation>;
export function dbDeleteWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: DbWritePredicate<Relation>
): (db: Db) => readonly DeleteByKeyPatch<Relation>[];
/**
 * Create delete patches for a scalar/tuple relation key or rows matching a JS predicate.
 */
export function dbDeleteWhere<Relation extends RelationRef>(
  relation: Relation,
  keyOrPredicate: DbWriteMatcher<Relation>
): DeleteByKeyPatch<Relation> | ((db: Db) => readonly DeleteByKeyPatch<Relation>[]) {
  if (typeof keyOrPredicate !== 'function') {
    return writeDeleteByKey(relation, keyOrPredicate);
  }

  const predicate = keyOrPredicate as DbWritePredicate<Relation>;

  return (db) =>
    dbRelationRows(db, relation).flatMap((relationRow, index) =>
      predicate(relationRow, index, db)
        ? [writeDeleteByKey(relation, relationKeyInputFromRow(relation, relationRow))]
        : []
    );
}

function relationKeyInputFromRow<Relation extends RelationRef>(
  relation: Relation,
  relationRow: RelationRow<Relation>
): RelationKeyInput {
  const row = relationRow as Record<string, unknown>;
  const keyFields = typeof relation.key === 'string' ? [relation.key] : relation.key;
  const values = keyFields.map((fieldName) => row[fieldName]);

  if (values.length === 1) {
    const value = values[0];

    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }
  }

  return values;
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
 * Apply one or more write patch inputs and return the next `Db`.
 *
 * @remarks Variadic inputs are flattened into one all-or-nothing patch batch. Callback inputs
 * are resolved against the transaction input `Db`, before any patches in the batch are applied.
 *
 * @throws DbTransactionError when any write diagnostics are produced. Use `tryTransact`
 * to keep the diagnostic result without throwing.
 */
export function transact(db: Db, ...inputs: DbTransactionInputs): Db {
  const result = tryTransact(db, ...inputs);

  if (result.diagnostics.length > 0) {
    throw new DbTransactionError(result);
  }

  return result.db;
}

/** Apply one or more write patch inputs and return diagnostics without mutating the input `Db`. */
export function tryTransact(db: Db, ...inputs: DbTransactionInputs): DbTransactionResult {
  const data = cloneMutableData(db.data);
  const result = applyWrites(data, transactionInputPatches(db, inputs));
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

function transactionInputPatches(db: Db, inputs: DbTransactionInputs): readonly WritePatch[] {
  return inputs.flatMap((input) => {
    const patches = typeof input === 'function' ? input(db) : input;
    return Array.from(writeInputPatches(patches));
  });
}

function dbRelationRows<Relation extends RelationRef>(
  db: Db,
  relation: Relation
): readonly RelationRow<Relation>[] {
  return (db.data[relation.name] ?? []) as readonly RelationRow<Relation>[];
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

function isDb(input: unknown): input is Db {
  return isRecord(input) && isDbData(input.data) && isRecord(input.env);
}

function isDbData(input: unknown): input is DbData {
  return isRecord(input) && Object.values(input).every((rows) => Array.isArray(rows));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
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
