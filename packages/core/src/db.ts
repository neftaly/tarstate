import type { RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, validateRelationRow, type EvaluateEnv, type EvaluateOptions, type QueryResult } from './evaluate.js';
import { maintainMaterializations, queryRowsFromMaterialization } from './materialization.js';
import type { PredicateData, Query } from './query.js';
import type { RelationRef } from './schema.js';
import { fromObjectSource, type RelationSource } from './source.js';
import { transferConstraintAttachments } from './constraints-attachment.js';
import { validateAttachedConstraintsSync } from './constraints-validation.js';
import { transferWatches } from './watch.js';
import { applyWrites, type MutableObjectSourceData } from './write-apply.js';
import {
  deleteByKey as writeDeleteByKey,
  updateByKey as writeUpdateByKey,
  deleteExact as writeDeleteExact,
  deleteWhere as writeDeleteWhere,
  insert as writeInsert,
  insertIgnore as writeInsertIgnore,
  insertOrMerge as writeInsertOrMerge,
  insertOrReplace as writeInsertOrReplace,
  insertOrUpdate as writeInsertOrUpdate,
  replaceAll as writeReplaceAll,
  updateWhere as writeUpdateWhere,
  writeInputPatches,
  type DeleteByKeyPatch,
  type DeleteExactPatch,
  type DeletePatch,
  type InsertIgnorePatch,
  type InsertOrMergeOptions,
  type InsertOrMergePatch,
  type InsertOrReplacePatch,
  type InsertOrUpdateOptions,
  type InsertOrUpdatePatch,
  type InsertPatch,
  type RelationKeyInput,
  type RelationRow,
  type RelationRowUpdateInput,
  type ReplaceAllPatch,
  type UpdateByKeyPatch,
  type UpdatePatch,
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
export type DbOptions = {
  readonly env?: DbInputEnv;
};

type DbEngineTransactionResult = {
  readonly data: DbData;
  readonly engine: DbEngine;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly committed: boolean;
};

type DbEngine = {
  readonly kind: string;
  read(): DbData;
  transact(patches: readonly WritePatch[]): DbEngineTransactionResult;
  version(): unknown;
};

const dbEngineSymbol: unique symbol = Symbol('tarstate.dbEngine');

export type Db = {
  readonly data: DbData;
  readonly env: DbEnv;
  readonly [dbEngineSymbol]?: DbEngine;
};

export type DbTransactionResult = {
  readonly db: Db;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly committed: boolean;
};

export type DbTransactionBuilder = {
  readonly insert: <Relation extends RelationRef>(
    relation: Relation,
    row: RelationRow<Relation>
  ) => InsertPatch<Relation>;
  readonly insertIgnore: <Relation extends RelationRef>(
    relation: Relation,
    row: RelationRow<Relation>
  ) => InsertIgnorePatch<Relation>;
  readonly insertOrReplace: <Relation extends RelationRef>(
    relation: Relation,
    row: RelationRow<Relation>
  ) => InsertOrReplacePatch<Relation>;
  readonly updateByKey: <Relation extends RelationRef>(
    relation: Relation,
    key: RelationKeyInput,
    changes: RelationRowUpdateInput<Relation>
  ) => UpdateByKeyPatch<Relation>;
  readonly update: <Relation extends RelationRef>(
    relation: Relation,
    predicate: PredicateData,
    changes: RelationRowUpdateInput<Relation>
  ) => UpdatePatch<Relation>;
  readonly updateWhere: <Relation extends RelationRef>(
    relation: Relation,
    predicate: PredicateData,
    changes: RelationRowUpdateInput<Relation>
  ) => UpdatePatch<Relation>;
  readonly insertOrMerge: <Relation extends RelationRef>(
    relation: Relation,
    row: Partial<RelationRow<Relation>>,
    options?: InsertOrMergeOptions<Relation>
  ) => InsertOrMergePatch<Relation>;
  readonly insertOrUpdate: <Relation extends RelationRef>(
    relation: Relation,
    row: RelationRow<Relation>,
    options: InsertOrUpdateOptions<Relation>
  ) => InsertOrUpdatePatch<Relation>;
  readonly deleteByKey: <Relation extends RelationRef>(
    relation: Relation,
    key: RelationKeyInput
  ) => DeleteByKeyPatch<Relation>;
  readonly delete: <Relation extends RelationRef>(
    relation: Relation,
    predicate: PredicateData
  ) => DeletePatch<Relation>;
  readonly deleteWhere: <Relation extends RelationRef>(
    relation: Relation,
    predicate: PredicateData
  ) => DeletePatch<Relation>;
  readonly deleteExact: <Relation extends RelationRef>(
    relation: Relation,
    row: RelationRow<Relation>
  ) => DeleteExactPatch<Relation>;
  readonly replaceAll: <Relation extends RelationRef>(
    relation: Relation,
    rows: readonly RelationRow<Relation>[]
  ) => ReplaceAllPatch<Relation>;
};
export type DbTransactionContext = Db & DbTransactionBuilder;
export type DbTransactionInput =
  | WriteInput
  | ((_db: DbTransactionContext) => WriteInput)
  | ((_tx: DbTransactionContext, db: Db) => WriteInput);
export type DbTransactionInputs = readonly DbTransactionInput[];
export type DbWritePredicate<Relation extends RelationRef> = (
  row: RelationRow<Relation>,
  index: number,
  db: Db
) => boolean;
export type DbWriteKey = RelationKeyInput;
export type DbWriteMatcher<Relation extends RelationRef> = DbWriteKey | DbWritePredicate<Relation>;

type RelationQueryRow<QueryValue> = QueryValue extends Query<infer Row>
  ? Row
  : QueryValue extends RelationRef<infer Row>
    ? Row
    : unknown;
type QueryOrRelation<Row = unknown> = Query<Row> | RelationRef | string;
type QueryBatchRow<Queries extends QueryBatch> = RelationQueryRow<Queries[keyof Queries]>;
export type QueryBatch = Record<string, QueryOrRelation>;
export type QueryBatchResult<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: QueryResult<RelationQueryRow<Queries[Key]>>;
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

export function createDb(data: DbInputData = {}, options: DbInputEnv | DbOptions = {}): Db {
  const env = dbEnv(options);
  return dbFromEngine(createObjectDbEngine(frozenData(data)), env);
}

export const db = createDb;

export function dbSource(db: Db): RelationSource {
  return fromObjectSource(dbEngineFor(db).read());
}

export function stripMeta(db: Db): DbData;
export function stripMeta<Input>(input: Input): Input;
export function stripMeta(input: unknown): unknown {
  return isDb(input) ? input.data : input;
}

export function withEnv(db: Db, env: DbInputEnv): Db {
  return dbFromEngine(dbEngineFor(db), env);
}

export function getEnv(db: Db): DbEnv {
  return db.env;
}

export function updateEnv(db: Db, update: (env: DbEnv) => DbInputEnv): Db {
  return withEnv(db, update(db.env));
}

export function q<Row, MappedRow>(
  db: Db,
  query: QueryOrRelation<Row>,
  options: DbMapRowsOptions<Row, MappedRow>
): Promise<QueryResult<MappedRow>>;
export function q<Row>(db: Db, query: Query<Row>, options?: DbQueryOptions<Row>): Promise<QueryResult<Row>>;
export function q<Relation extends RelationRef>(
  db: Db,
  relation: Relation,
  options?: DbQueryOptions<RelationRow<Relation>>
): Promise<QueryResult<RelationRow<Relation>>>;
export function q(db: Db, relationName: string, options?: DbQueryOptions): Promise<QueryResult<unknown>>;
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
export function q(
  db: Db,
  queryOrQueries: Query | QueryBatch,
  options?: DbQueryOptions
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>>;
export async function q(
  db: Db,
  queryOrQueries: QueryOrRelation | QueryBatch,
  options: any = {}
): Promise<any> {
  if (isQueryBatch(queryOrQueries)) {
    return qMany(db, queryOrQueries, options);
  }

  if (isRelationRef(queryOrQueries) || typeof queryOrQueries === 'string') {
    return mappedResult(relationQueryResult(db, queryOrQueries), options);
  }

  const materializedRows = queryRowsFromMaterialization(db, queryOrQueries);
  if (materializedRows !== undefined) {
    return mappedResult({ rows: materializedRows, diagnostics: [] }, options);
  }

  return mappedResult(await evaluate(dbSource(db), queryOrQueries, evaluateOptions(db, options)), options);
}

export function qRows<Row, MappedRow>(
  db: Db,
  query: QueryOrRelation<Row>,
  options: DbMapRowsOptions<Row, MappedRow>
): Promise<readonly MappedRow[]>;
export function qRows<Row>(
  db: Db,
  query: QueryOrRelation<Row>,
  options?: DbQueryOptions<Row>
): Promise<readonly Row[]>;
export async function qRows(db: Db, query: QueryOrRelation, options?: DbQueryOptions): Promise<readonly unknown[]> {
  return (await q(db, query as never, options as never)).rows;
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
    await q(db, query as never, options as never)
  ] as const));
  return Object.fromEntries(entries);
}

export type QueryBatchRows<Queries extends QueryBatch> = {
  readonly [Key in keyof Queries]: readonly RelationQueryRow<Queries[Key]>[];
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

export async function row<Row>(db: Db, query: QueryOrRelation<Row>, options?: EvaluateOptions): Promise<Row | undefined> {
  return unwrapSingletonAlias((await qRows(db, query, options)).at(0)) as Row | undefined;
}

export async function exists<Row>(db: Db, query: QueryOrRelation<Row>, options?: EvaluateOptions): Promise<boolean> {
  return (await row(db, query, options)) !== undefined;
}

export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  key: DbWriteKey,
  changes: RelationRowUpdateInput<Relation>
): UpdateByKeyPatch<Relation>;
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: DbWritePredicate<Relation>,
  changes: RelationRowUpdateInput<Relation>
): (_db: Db) => readonly UpdateByKeyPatch<Relation>[];
export function dbUpdateWhere<Relation extends RelationRef>(
  relation: Relation,
  keyOrPredicate: DbWriteMatcher<Relation>,
  changes: RelationRowUpdateInput<Relation>
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
  query: QueryOrRelation<Row>,
  ...inputs: readonly (DbTransactionInput | DbMapRowsOptions<Row, MappedRow>)[]
): Promise<QueryResult<MappedRow>>;
export function whatIf<Row>(
  db: Db,
  query: QueryOrRelation<Row>,
  ...inputs: readonly (DbTransactionInput | DbQueryOptions<Row>)[]
): Promise<QueryResult<Row>>;
export function whatIf<const Queries extends QueryBatch, MappedRow>(
  db: Db,
  queries: Queries,
  ...inputs: readonly (DbTransactionInput | DbMapRowsOptions<QueryBatchRow<Queries>, MappedRow>)[]
): Promise<MappedQueryBatchResult<Queries, MappedRow>>;
export function whatIf<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  ...inputs: readonly (DbTransactionInput | DbQueryOptions<QueryBatchRow<Queries>>)[]
): Promise<QueryBatchResult<Queries>>;
export function whatIf(
  db: Db,
  queryOrQueries: QueryOrRelation | QueryBatch,
  ...args: readonly (DbTransactionInput | DbQueryOptions)[]
): Promise<any> {
  const { inputs, options } = splitWhatIfArgs(args);
  const result = tryTransact(db, ...inputs);
  const readDb = result.committed ? result.db : db;
  return isQueryBatch(queryOrQueries)
    ? qMany(readDb, queryOrQueries, options)
    : q(readDb, queryOrQueries as never, options as never);
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
  const result = dbEngineFor(db).transact(patches);
  if (!result.committed) {
    return {
      db,
      patches: result.patches,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: result.diagnostics,
      committed: false
    };
  }

  const nextDb = dbFromEngine(result.engine, db.env);
  transferConstraintAttachments(db, nextDb);
  const validation = validateAttachedConstraintsSync(nextDb);
  if (!validation.valid) {
    return {
      db,
      patches: result.patches,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: [...result.diagnostics, ...validation.diagnostics],
      committed: false
    };
  }

  const materializations = maintainMaterializations(db, nextDb);
  transferWatches(db, nextDb);

  return {
    db: nextDb,
    patches: result.patches,
    applied: result.applied,
    deltas: result.deltas,
    diagnostics: [...result.diagnostics, ...materializations.diagnostics],
    committed: true
  };
}

function transactionPatches(db: Db, inputs: DbTransactionInputs): readonly WritePatch[] {
  const context = transactionContext(db);
  return inputs.flatMap((input) =>
    Array.from(writeInputPatches(typeof input === 'function' ? input(context, db) : input))
  );
}

function evaluateOptions(db: Db, options: EvaluateOptions): EvaluateOptions {
  return {
    ...options,
    env: { ...db.env, ...options.env }
  };
}

function dbEnv(options: DbInputEnv | DbOptions): DbInputEnv {
  return isDbOptions(options) ? options.env ?? {} : options;
}

function isDbOptions(input: DbInputEnv | DbOptions): input is DbOptions {
  return isRecord(input) && isRecord(input.env);
}

function relationQueryResult(db: Db, relationOrName: RelationRef | string): QueryResult<unknown> {
  const relationName = typeof relationOrName === 'string' ? relationOrName : relationOrName.name;
  const rows = dbEngineFor(db).read()[relationName] ?? [];
  if (typeof relationOrName === 'string') {
    return { rows, diagnostics: [] };
  }

  const diagnostics = rows.flatMap((candidate) =>
    isRecord(candidate)
      ? validateRelationRow(relationOrName, candidate)
      : [{
          code: 'invalid_row',
          message: 'row is not an object',
          relation: relationOrName.name
        }]
  );

  return {
    rows: diagnostics.length === 0 ? rows : rows.filter((candidate) =>
      isRecord(candidate) && validateRelationRow(relationOrName, candidate).length === 0
    ),
    diagnostics
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
  const rows = dbEngineFor(db).read()[relation.name] ?? [];
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

function transactionContext(db: Db): DbTransactionContext {
  return {
    ...db,
    insert: writeInsert,
    insertIgnore: writeInsertIgnore,
    insertOrReplace: writeInsertOrReplace,
    updateByKey: writeUpdateByKey,
    update: writeUpdateWhere,
    updateWhere: writeUpdateWhere,
    insertOrMerge: writeInsertOrMerge,
    insertOrUpdate: writeInsertOrUpdate,
    deleteByKey: writeDeleteByKey,
    delete: writeDeleteWhere,
    deleteWhere: writeDeleteWhere,
    deleteExact: writeDeleteExact,
    replaceAll: writeReplaceAll
  };
}

function splitWhatIfArgs(
  args: readonly (DbTransactionInput | DbQueryOptions)[]
): { readonly inputs: readonly DbTransactionInput[]; readonly options: DbQueryOptions } {
  const last = args.at(-1);
  if (last !== undefined && isQueryOptions(last)) {
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

function isQueryOptions(input: DbTransactionInput | DbQueryOptions): input is DbQueryOptions {
  return isRecord(input) &&
    !isWritePatchLike(input) &&
    ('env' in input || 'functions' in input || 'mapRows' in input);
}

function isWritePatchLike(input: unknown): input is WritePatch {
  return isRecord(input) && typeof input.op === 'string' && 'relation' in input;
}

function isQueryBatch(input: QueryOrRelation | QueryBatch): input is QueryBatch {
  return typeof input === 'object' &&
    input !== null &&
    !isRelationRef(input) &&
    !('data' in input && 'relations' in input);
}

function isRelationRef(input: unknown): input is RelationRef {
  return isRecord(input) &&
    input.kind === 'relation' &&
    typeof input.name === 'string' &&
    isRecord(input.fields);
}

function isDb(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

function dbFromEngine(engine: DbEngine, env: DbInputEnv): Db {
  const value = {
    data: engine.read(),
    env: Object.freeze({ ...env })
  } as Db;

  Object.defineProperty(value, dbEngineSymbol, {
    value: engine,
    enumerable: false
  });

  return Object.freeze(value);
}

function dbEngineFor(db: Db): DbEngine {
  return db[dbEngineSymbol] ?? createObjectDbEngine(frozenData(db.data));
}

function createObjectDbEngine(data: DbData, version = 0): DbEngine {
  return {
    kind: 'object',
    read: () => data,
    version: () => version,
    transact(patches) {
      const draft = mutableData(data);
      const result = applyWrites(draft, patches);
      if (result.diagnostics.length > 0) {
        return {
          ...result,
          applied: 0,
          deltas: [],
          data,
          engine: this,
          committed: false
        };
      }

      const nextData = frozenData(draft);
      return {
        ...result,
        data: nextData,
        engine: createObjectDbEngine(nextData, version + 1),
        committed: true
      };
    }
  };
}

function frozenData(data: DbInputData): DbData {
  return Object.freeze(Object.fromEntries(
    Object.entries(data).map(([name, rows]) => [name, Object.freeze([...rows])])
  ));
}

function mutableData(data: DbData): MutableObjectSourceData {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
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
