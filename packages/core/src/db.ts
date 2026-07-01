import type { RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, type EvaluateEnv, type EvaluateOptions, type QueryResult } from './evaluate.js';
import type { Query } from './query.js';
import type { RelationRef } from './schema.js';
import { fromObjectSource, type RelationSource } from './source.js';
import { applyWritesAtomic, type MutableObjectSourceData } from './write-apply.js';
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
  db: Db,
  queryOrQueries: Query | QueryBatch,
  options: DbQueryOptions = {}
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  if (isQueryBatch(queryOrQueries)) {
    return qMany(db, queryOrQueries, options);
  }

  return mappedResult(await evaluate(dbSource(db), queryOrQueries, evaluateOptions(db, options)), options);
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
export async function qRows(db: Db, query: Query, options?: DbQueryOptions): Promise<readonly unknown[]> {
  return (await q(db, query, options)).rows;
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
  db: Db,
  queries: QueryBatch,
  options: DbQueryOptions = {}
): Promise<QueryBatchResult<QueryBatch>> {
  const entries = await Promise.all(Object.entries(queries).map(async ([name, query]) => [
    name,
    await q(db, query, options)
  ] as const));
  return Object.fromEntries(entries);
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
  db: Db,
  queries: QueryBatch,
  options?: DbQueryOptions
): Promise<Record<string, readonly unknown[]>> {
  const result = await qMany(db, queries, options);
  return Object.fromEntries(Object.entries(result).map(([name, queryResult]) => [name, queryResult.rows]));
}

export async function row<Row>(db: Db, query: Query<Row>, options?: EvaluateOptions): Promise<Row | undefined> {
  return unwrapSingletonAlias((await qRows(db, query, options)).at(0)) as Row | undefined;
}

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
): (_db: Db) => readonly UpdateByKeyPatch<Relation>[];
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  keyOrPredicate: DbWriteMatcher<Relation>,
  changes: RelationRowUpdate<Relation>
): UpdateByKeyPatch<Relation> | ((_db: Db) => readonly UpdateByKeyPatch<Relation>[]) {
  return typeof keyOrPredicate === 'function'
    ? (db) => rowsMatching(db, relation, keyOrPredicate).map((row) =>
        writeUpdateByKey(relation, keyForDbWrite(relation, row), changes)
      )
    : writeUpdateByKey(relation, keyOrPredicate, changes);
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
  return typeof keyOrPredicate === 'function'
    ? (db) => rowsMatching(db, relation, keyOrPredicate).map((row) =>
        writeDeleteByKey(relation, keyForDbWrite(relation, row))
      )
    : writeDeleteByKey(relation, keyOrPredicate);
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
  patches: DbTransactionInput,
  options?: DbQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  const result = tryTransact(db, patches);
  const readDb = result.committed ? result.db : db;
  return isQueryBatch(queryOrQueries)
    ? qMany(readDb, queryOrQueries, options)
    : q(readDb, queryOrQueries, options);
}

export function transact(db: Db, ...inputs: DbTransactionInputs): Db {
  const result = tryTransact(db, ...inputs);
  if (!result.committed) {
    throw new DbTransactionError(result);
  }

  return result.db;
}

export function tryTransact(db: Db, ...inputs: DbTransactionInputs): DbTransactionResult {
  const patches = transactionPatches(db, inputs);
  const mutable = mutableData(db.data);
  const result = applyWritesAtomic(mutable, patches);
  const nextDb = result.committed ? createDb(mutable, db.env) : db;

  return {
    db: nextDb,
    patches: result.patches,
    applied: result.applied,
    deltas: result.deltas,
    diagnostics: result.diagnostics,
    committed: result.committed
  };
}

function transactionPatches(db: Db, inputs: DbTransactionInputs): readonly WritePatch[] {
  return inputs.flatMap((input) => Array.from(writeInputPatches(typeof input === 'function' ? input(db) : input)));
}

function mutableData(data: DbData): MutableObjectSourceData {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
}

function evaluateOptions(db: Db, options: EvaluateOptions): EvaluateOptions {
  return {
    ...options,
    env: { ...db.env, ...options.env }
  };
}

function mappedResult<Row, MappedRow>(
  result: QueryResult<Row>,
  options: DbQueryOptions<Row, MappedRow>
): QueryResult<Row> | QueryResult<MappedRow> {
  return options.mapRows === undefined ? result : { ...result, rows: options.mapRows(result.rows) };
}

function rowsMatching<Relation extends RelationRef>(
  db: Db,
  relation: Relation,
  predicate: DbWritePredicate<Relation>
): readonly RelationRow<Relation>[] {
  const rows = db.data[relation.name] ?? [];
  return rows.filter((row, index) =>
    isRecord(row) && predicate(row as RelationRow<Relation>, index, db)
  ) as readonly RelationRow<Relation>[];
}

function keyForDbWrite<Relation extends RelationRef>(relation: Relation, row: RelationRow<Relation>): DbWriteKey {
  if (Array.isArray(relation.key)) {
    return relation.key.map((field) => (row as Record<string, unknown>)[field]);
  }

  if (typeof relation.key !== 'string') {
    return '';
  }

  return (row as Record<string, unknown>)[relation.key] as DbWriteKey;
}

function isQueryBatch(input: Query | QueryBatch): input is QueryBatch {
  return !('data' in input && 'relations' in input);
}

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function unwrapSingletonAlias(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const entries = Object.entries(input);
  return entries.length === 1 && isRecord(entries[0]?.[1]) ? entries[0][1] : input;
}
