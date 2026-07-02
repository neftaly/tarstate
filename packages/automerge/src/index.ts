import * as Automerge from '@automerge/automerge';
import type { QueryResult } from '@tarstate/core/evaluate';
import {
  createDb,
  q,
  type Db as CoreDb,
  type DbData,
  type DbEnv,
  type DbInputData,
  type DbInputEnv,
  type DbQueryOptions,
  type MappedQueryBatchResult,
  type QueryBatch,
  type QueryBatchResult
} from '@tarstate/core/db';
import {
  mat as materializeDb,
  type MaterializedDb,
  type SnapshotMaterializationOptions
} from '@tarstate/core/materialization';
import type {
  AdapterCommitResult,
  AdapterSnapshot,
  AdapterSource,
  RelationApplyReport,
  RelationAdapter,
  RelationDelta,
  RelationPatchTarget,
  RelationRuntime,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import {
  composeRelationRuntimes,
  tryApplyRelationPatches
} from '@tarstate/core/adapter';
import { isJsonValue, type FieldSpec, type RelationRef } from '@tarstate/core/schema';
import { queryKey, type PredicateData, type Query } from '@tarstate/core/query';
import { type RelationRangeBound } from '@tarstate/core/source';
import { writeInputPatches, type RelationKeyInput, type RelationRow, type WriteInput, type WritePatch } from '@tarstate/core/write';

export type AutomergeMapPath = readonly string[];

export type AutomergeMapRelation<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly path: AutomergeMapPath;
};

export type AutomergeMapStorageCodec = 'map-v1';

export type AutomergeMapStorageOptions = {
  readonly codec?: AutomergeMapStorageCodec;
};

export type AutomergeMapAdapterOptions<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation[];
  readonly onDocChange?: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
  readonly storage?: AutomergeMapStorageOptions;
};

export type AutomergeMapSourceOptions = {
  readonly relations: readonly AutomergeMapRelation[];
};

export type AutomergeMapSource = AdapterSource<Automerge.Heads>;
export type AutomergeDbVersion = Automerge.Heads | readonly unknown[];

export type AutomergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = RelationAdapter<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: () => void) => () => void;
};

export type AutomergeDbRelationRuntimeMetadata =
  | {
      readonly relation: RelationRef;
      readonly relations?: never;
    }
  | {
      readonly relation?: never;
      readonly relations: readonly (RelationRef | AutomergeMapRelation)[];
    };

export type AutomergeDbRelationRuntime<Version = unknown> =
  RelationRuntime<Version> & AutomergeDbRelationRuntimeMetadata;

export type AutomergeDbOptions<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = Omit<AutomergeMapAdapterOptions<DocumentShape>, 'doc'> & {
  readonly env?: AutomergeDbInputEnv;
  readonly runtimes?: readonly AutomergeDbRelationRuntime[];
};

export type AutomergeDbInputData = DbInputData;
export type AutomergeDbData = DbData;
export type AutomergeDbEnv = DbEnv;
export type AutomergeDbInputEnv = DbInputEnv;
export type Db = CoreDb;

export type AutomergeDbSnapshot = {
  readonly db: Db;
  readonly source: AdapterSource<AutomergeDbVersion>;
  readonly version?: AutomergeDbVersion;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type AutomergeDbTransactionInput = WriteInput | ((_db: Db) => WriteInput);

export type AutomergeDbTransactionResult = {
  readonly kind: 'automergeDbTransaction';
  readonly db: Db;
  readonly committed: boolean;
  readonly report: RelationApplyReport<AutomergeDbVersion>;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly version?: AutomergeDbVersion;
};

type AutomergeDbQueryTarget<Row = unknown> = Query<Row> | RelationRef | string;

type AutomergeDbQuery = {
  <Relation extends RelationRef, MappedRow>(
    relation: Relation,
    options: DbQueryOptions<RelationRow<Relation>, MappedRow> & {
      readonly mapRows: (rows: readonly RelationRow<Relation>[]) => readonly MappedRow[];
    }
  ): Promise<QueryResult<MappedRow>>;
  <Relation extends RelationRef>(
    relation: Relation,
    options?: DbQueryOptions<RelationRow<Relation>>
  ): Promise<QueryResult<RelationRow<Relation>>>;
  <MappedRow>(
    relationName: string,
    options: DbQueryOptions<unknown, MappedRow> & { readonly mapRows: (rows: readonly unknown[]) => readonly MappedRow[] }
  ): Promise<QueryResult<MappedRow>>;
  (relationName: string, options?: DbQueryOptions): Promise<QueryResult<unknown>>;
  <Row, MappedRow>(
    query: Query<Row>,
    options: DbQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
  ): Promise<QueryResult<MappedRow>>;
  <Row>(query: Query<Row>, options?: DbQueryOptions<Row>): Promise<QueryResult<Row>>;
  <const Queries extends QueryBatch, MappedRow>(
    queries: Queries,
    options: DbQueryOptions<unknown, MappedRow> & { readonly mapRows: (rows: readonly unknown[]) => readonly MappedRow[] }
  ): Promise<MappedQueryBatchResult<Queries, MappedRow>>;
  <const Queries extends QueryBatch>(
    queries: Queries,
    options?: DbQueryOptions
  ): Promise<QueryBatchResult<Queries>>;
};

export type AutomergeDbQuerySnapshot<Row = unknown> = {
  readonly kind: 'automergeDbQuerySnapshot';
  readonly id: string;
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly db: Db;
  readonly rows: readonly Row[];
  readonly diagnostics: QueryResult<Row>['diagnostics'];
};

export type AutomergeDbWatchTarget<Row extends Record<string, unknown> = Record<string, unknown>> = Query<Row> | RelationRef<Row>;
export type AutomergeDbWatchOptions<Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly label?: string;
  readonly immediate?: boolean;
  readonly keyBy?: readonly string[] | ((row: Row) => string);
};
export type AutomergeDbWatchEvent<Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly kind: 'automergeDbWatchEvent';
  readonly id: string;
  readonly target: AutomergeDbWatchTarget<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly label?: string;
};
export type AutomergeDbWatchListener<Row extends Record<string, unknown> = Record<string, unknown>> = (
  event: AutomergeDbWatchEvent<Row>
) => void | Promise<void>;
export type AutomergeDbWatchHandle<Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly kind: 'automergeDbWatch';
  readonly id: string;
  readonly target: AutomergeDbWatchTarget<Row>;
  readonly refresh: () => Promise<AutomergeDbWatchEvent<Row>>;
  readonly unwatch: () => void;
  readonly label?: string;
};

export type AutomergeDb<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = {
  readonly kind: 'automergeDb';
  readonly adapter: AutomergeMapAdapter<DocumentShape>;
  readonly source: AdapterSource<AutomergeDbVersion>;
  readonly relations: readonly RelationRef[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly db: () => Promise<Db>;
  readonly getSnapshot: () => Promise<AutomergeDbSnapshot>;
  readonly q: AutomergeDbQuery;
  readonly tryTransact: (...inputs: readonly AutomergeDbTransactionInput[]) => Promise<AutomergeDbTransactionResult>;
  readonly transact: (...inputs: readonly AutomergeDbTransactionInput[]) => Promise<Db>;
  readonly mat: <Row>(
    query: Query<Row>,
    options?: SnapshotMaterializationOptions
  ) => Promise<Db & MaterializedDb>;
  readonly querySnapshot: <Row>(
    query: Query<Row>,
    options?: { readonly id?: string; readonly name?: string }
  ) => Promise<AutomergeDbQuerySnapshot<Row>>;
  readonly watch: <Row extends Record<string, unknown>>(
    target: AutomergeDbWatchTarget<Row>,
    listener: AutomergeDbWatchListener<Row>,
    options?: AutomergeDbWatchOptions<Row>
  ) => AutomergeDbWatchHandle<Row>;
  readonly subscribe: (listener: () => void) => () => void;
};

type RelationRows = {
  readonly rows: readonly Record<string, unknown>[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

type MutableRelationState = {
  readonly mapping: AutomergeMapRelation;
  readonly rows: Map<string, Record<string, unknown>>;
};

type PlannedApply = {
  readonly states: Map<string, MutableRelationState>;
  readonly deltas: readonly RelationDelta[];
};

type MutableDelta = {
  readonly relation: RelationRef;
  readonly added: unknown[];
  readonly removed: unknown[];
};

let nextAutomergeDbWatchId = 0;

export class AutomergeDbTransactionError extends Error {
  readonly result: AutomergeDbTransactionResult;

  constructor(result: AutomergeDbTransactionResult) {
    super(`transaction produced ${result.diagnostics.length} diagnostic(s)`);
    this.name = 'AutomergeDbTransactionError';
    this.result = result;
  }

  get db(): Db {
    return this.result.db;
  }

  get diagnostics(): readonly TarstateDiagnostic[] {
    return this.result.diagnostics;
  }
}

async function queryAutomergeDb<Row, MappedRow>(
  db: Db,
  query: AutomergeDbQueryTarget<Row>,
  options: DbQueryOptions<Row, MappedRow> & { readonly mapRows: (rows: readonly Row[]) => readonly MappedRow[] }
): Promise<QueryResult<MappedRow>>;
async function queryAutomergeDb<Row>(
  db: Db,
  query: AutomergeDbQueryTarget<Row>,
  options?: DbQueryOptions<Row>
): Promise<QueryResult<Row>>;
async function queryAutomergeDb<const Queries extends QueryBatch, MappedRow>(
  db: Db,
  queries: Queries,
  options: DbQueryOptions<unknown, MappedRow> & { readonly mapRows: (rows: readonly unknown[]) => readonly MappedRow[] }
): Promise<MappedQueryBatchResult<Queries, MappedRow>>;
async function queryAutomergeDb<const Queries extends QueryBatch>(
  db: Db,
  queries: Queries,
  options?: DbQueryOptions
): Promise<QueryBatchResult<Queries>>;
async function queryAutomergeDb(
  db: Db,
  queryOrQueries: AutomergeDbQueryTarget | QueryBatch,
  options: DbQueryOptions = {}
): Promise<QueryResult<unknown> | QueryBatchResult<QueryBatch>> {
  return q(db, queryOrQueries, options);
}

export function automergeDbRelationRuntime<Version>(
  runtime: RelationRuntime<Version>,
  relation: RelationRef
): AutomergeDbRelationRuntime<Version>;
export function automergeDbRelationRuntime<Version>(
  runtime: RelationRuntime<Version>,
  relations: readonly (RelationRef | AutomergeMapRelation)[]
): AutomergeDbRelationRuntime<Version>;
export function automergeDbRelationRuntime<Version>(
  runtime: RelationRuntime<Version>,
  relationOrRelations: RelationRef | readonly (RelationRef | AutomergeMapRelation)[]
): AutomergeDbRelationRuntime<Version> {
  const relations = normalizeRuntimeRelationInput(relationOrRelations);
  const relationRefs = relations.map((relationOrMapping) =>
    isAutomergeMapRelation(relationOrMapping) ? relationOrMapping.relation : relationOrMapping
  );
  const relationNames = uniqueRelationNames(relationRefs);

  return {
    ...runtime,
    source: {
      ...runtime.source,
      relationNames
    },
    ...(runtime.target === undefined
      ? {}
      : {
          target: {
            ...runtime.target,
            relationNames,
            ownsRelation: (relationName: string) => relationNames.includes(relationName)
          }
        }),
    relations
  };
}

export function automergeDb<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeDbOptions<DocumentShape>
): AutomergeDb<DocumentShape> {
  const adapter = automergeMapAdapter<DocumentShape>({ ...options, doc });
  const optionRuntimes = options.runtimes ?? [];
  const runtime: RelationRuntime<AutomergeDbVersion> = optionRuntimes.length === 0
    ? adapter
    : composeRelationRuntimes(adapter, ...optionRuntimes);
  const relations = uniqueRelations([
    ...adapter.relations.map((mapping) => mapping.relation),
    ...optionRuntimes.flatMap((runtimeValue, index) => runtimeRelations(runtimeValue, index))
  ]);
  const materializations = new Map<string, {
    readonly query: Query;
    readonly options: SnapshotMaterializationOptions;
  }>();

  const getSnapshot = async (): Promise<AutomergeDbSnapshot> => {
    const data = await snapshotData(runtime.source, relations);
    const version = await runtime.source.version?.();
    const diagnostics = await runtime.source.diagnostics?.() ?? [];

    return {
      db: materializeRegisteredQueries(createSnapshotDb(data)),
      source: runtime.source,
      ...(version === undefined ? {} : { version }),
      diagnostics
    };
  };
  const db = async () => (await getSnapshot()).db;
  const query = (async (
    queryOrQueries: Query | QueryBatch | RelationRef | string,
    queryOptions?: DbQueryOptions
  ) => (queryAutomergeDb as (
    db: Db,
    queryOrQueries: Query | QueryBatch | RelationRef | string,
    options?: DbQueryOptions
  ) => Promise<unknown>)(await db(), queryOrQueries, queryOptions)) as AutomergeDbQuery;
  const tryTransact = async (
    ...inputs: readonly AutomergeDbTransactionInput[]
  ): Promise<AutomergeDbTransactionResult> => {
    const before = await db();
    const patches = inputs.flatMap((input) =>
      Array.from(writeInputPatches(typeof input === 'function' ? input(before) : input))
    );
    const report = await tryApplyRelationPatches(runtime, patches, { readVersion: true });
    const snapshot = await getSnapshot();
    const committed = report.status === 'accepted' || report.status === 'partial';

    return {
      kind: 'automergeDbTransaction',
      db: snapshot.db,
      committed,
      report,
      patches: report.patches,
      applied: report.applied,
      deltas: report.deltas,
      diagnostics: report.diagnostics,
      ...(report.version === undefined ? {} : { version: report.version })
    };
  };

  return {
    kind: 'automergeDb',
    adapter,
    source: runtime.source,
    relations,
    getDoc: adapter.getDoc,
    setDoc: adapter.setDoc,
    db,
    getSnapshot,
    q: query,
    tryTransact,
    transact: async (...inputs) => {
      const result = await tryTransact(...inputs);

      if (!result.committed) {
        throw new AutomergeDbTransactionError(result);
      }

      return result.db;
    },
    mat: async (queryValue, matOptions = {}) => {
      const key = queryKey(queryValue);
      materializations.set(key, { query: queryValue, options: matOptions });
      return await db() as Db & MaterializedDb;
    },
    querySnapshot: async (queryValue, snapshotOptions) => {
      const snapshot = await db();
      const result = await queryAutomergeDb(snapshot, queryValue);
      const key = queryKey(queryValue);

      return {
        kind: 'automergeDbQuerySnapshot',
        id: snapshotOptions?.id ?? snapshotOptions?.name ?? key,
        queryKey: key,
        query: queryValue,
        db: snapshot,
        rows: result.rows,
        diagnostics: result.diagnostics
      };
    },
    watch: (target, listener, watchOptions) =>
      createAutomergeDbWatch(runtime.source, target, listener, watchOptions),
    subscribe: runtime.subscribe ?? adapter.subscribe
  };

  function materializeRegisteredQueries(input: Db): Db {
    let nextDb = input;
    for (const entry of materializations.values()) {
      nextDb = materializeDb(nextDb, entry.query, entry.options);
    }
    return nextDb;
  }

  function createSnapshotDb(data: DbInputData): Db {
    return options.env === undefined
      ? createDb(data)
      : createDb(data, { env: options.env });
  }
}

function createAutomergeDbWatch<Row extends Record<string, unknown>>(
  source: AdapterSource<AutomergeDbVersion>,
  target: AutomergeDbWatchTarget<Row>,
  listener: AutomergeDbWatchListener<Row>,
  options: AutomergeDbWatchOptions<Row> = {}
): AutomergeDbWatchHandle<Row> {
  const id = `automerge-watch-${nextAutomergeDbWatchId += 1}`;
  let previousRows: readonly Row[] = [];
  let closed = false;
  const handle: AutomergeDbWatchHandle<Row> = {
    kind: 'automergeDbWatch',
    id,
    target,
    refresh: async () => {
      if (closed) {
        return watchEvent(id, target, previousRows, previousRows, [], [], [], options);
      }

      const rows = await readWatchRows(source, target);
      const { addedRows, removedRows, changedRows } = diffWatchRows(previousRows, rows, options);
      const event = watchEvent(id, target, previousRows, rows, addedRows, removedRows, changedRows, options);
      previousRows = rows;
      await listener(event);
      return event;
    },
    unwatch: () => {
      closed = true;
    },
    ...(options.label === undefined ? {} : { label: options.label })
  };

  if (options.immediate === true) {
    void handle.refresh();
  }

  return handle;
}

async function readWatchRows<Row extends Record<string, unknown>>(
  source: AdapterSource,
  target: AutomergeDbWatchTarget<Row>
): Promise<readonly Row[]> {
  if (!isQuery(target)) {
    return await readRelationWatchRows(source, target);
  }

  const relations = uniqueRelations(Object.values(target.relations));
  const data = await snapshotData(source, relations);
  return (await queryAutomergeDb(createDb(data), target)).rows;
}

async function readRelationWatchRows<Row extends Record<string, unknown>>(
  source: AdapterSource,
  relation: RelationRef<Row>
): Promise<readonly Row[]> {
  const rows = await source.rows(relation);
  return rows.filter((row): row is Row => isRecord(row) && validateRow(relation, row).length === 0);
}

function diffWatchRows<Row extends Record<string, unknown>>(
  previousRows: readonly Row[],
  rows: readonly Row[],
  options: AutomergeDbWatchOptions<Row>
): {
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly changedRows: readonly Row[];
} {
  const previous = new Map(previousRows.map((row) => [watchRowKey(row, options), row]));
  const next = new Map(rows.map((row) => [watchRowKey(row, options), row]));
  const addedRows = rows.filter((row) => !previous.has(watchRowKey(row, options)));
  const removedRows = previousRows.filter((row) => !next.has(watchRowKey(row, options)));
  const changedRows = rows.filter((row) => {
    const before = previous.get(watchRowKey(row, options));
    return before !== undefined && JSON.stringify(before) !== JSON.stringify(row);
  });

  return { addedRows, removedRows, changedRows };
}

function watchEvent<Row extends Record<string, unknown>>(
  id: string,
  target: AutomergeDbWatchTarget<Row>,
  previousRows: readonly Row[],
  rows: readonly Row[],
  addedRows: readonly Row[],
  removedRows: readonly Row[],
  changedRows: readonly Row[],
  options: AutomergeDbWatchOptions<Row>
): AutomergeDbWatchEvent<Row> {
  return {
    kind: 'automergeDbWatchEvent',
    id,
    target,
    changed: addedRows.length > 0 || removedRows.length > 0 || changedRows.length > 0,
    previousRows,
    rows,
    addedRows,
    removedRows,
    diagnostics: [],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function watchRowKey<Row extends Record<string, unknown>>(row: Row, options: AutomergeDbWatchOptions<Row>): string {
  if (typeof options.keyBy === 'function') {
    return options.keyBy(row);
  }

  if (Array.isArray(options.keyBy)) {
    return JSON.stringify(options.keyBy.map((field) => row[field]));
  }

  return JSON.stringify(row);
}

export function automergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(options: AutomergeMapAdapterOptions<DocumentShape>): AutomergeMapAdapter<DocumentShape> {
  assertMapCodec(options.storage?.codec);

  let currentDoc = options.doc;
  const listeners = new Set<() => void>();
  const relations = options.relations.map((relation) => ({
    relation: relation.relation,
    path: [...relation.path]
  }));
  const relationNames = relations.map((relation) => relation.relation.name);
  const source = automergeMapSource(() => currentDoc, { relations });

  const commit = (patches: readonly WritePatch[]): AdapterCommitResult<Automerge.Heads> => {
    const planned = planPatches(currentDoc, relations, patches);

    if ('diagnostics' in planned) {
      return {
        status: 'rejected',
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics: planned.diagnostics,
        version: Automerge.getHeads(currentDoc)
      };
    }

    const message = typeof options.changeMessage === 'function'
      ? options.changeMessage(patches)
      : options.changeMessage;
    const nextDoc = Automerge.change(
      currentDoc,
      message === undefined ? applyPlannedChanges(planned) : message,
      message === undefined ? undefined : applyPlannedChanges(planned)
    );

    currentDoc = nextDoc;
    options.onDocChange?.(currentDoc);
    for (const listener of listeners) listener();

    return {
      status: 'accepted',
      patches: patches.length,
      applied: patches.length,
      deltas: planned.deltas,
      diagnostics: [],
      version: Automerge.getHeads(currentDoc)
    };
  };
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => relationNames.includes(relationName),
    apply: (patches) => ({ ...commit(patches), durability: 'durable' })
  };

  return {
    relations,
    source,
    target,
    commit,
    getDoc: () => currentDoc,
    setDoc: (doc) => {
      currentDoc = doc;
      for (const listener of listeners) listener();
    },
    snapshot: () => ({ source, version: Automerge.getHeads(currentDoc) }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function automergeMapSource<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  docOrGetDoc: Automerge.Doc<DocumentShape> | (() => Automerge.Doc<DocumentShape>),
  options: AutomergeMapSourceOptions
): AutomergeMapSource {
  const getDoc = typeof docOrGetDoc === 'function' ? docOrGetDoc : () => docOrGetDoc;
  const relationNames = options.relations.map((relation) => relation.relation.name);

  return {
    relationNames,
    rows: (relation) => materializeRelation(getDoc(), options.relations, relation).rows,
    lookup: (lookup) => materializeRelation(getDoc(), options.relations, lookup.relation)
      .rows.filter((row) => Object.is(row[lookup.field], lookup.value)),
    rangeLookup: (lookup) => materializeRelation(getDoc(), options.relations, lookup.relation)
      .rows.filter((row) => inRange(row[lookup.field], lookup.lower, lookup.upper)),
    version: () => Automerge.getHeads(getDoc()),
    diagnostics: () => options.relations.flatMap((relation) =>
      materializeMapping(getDoc(), relation).diagnostics
    )
  };
}

function uniqueRelations(relations: readonly RelationRef[]): readonly RelationRef[] {
  return Array.from(new Map(relations.map((relation) => [relation.name, relation])).values());
}

async function snapshotData(
  source: AdapterSource,
  relations: readonly RelationRef[]
): Promise<DbInputData> {
  const entries = await Promise.all(relations.map(async (relation): Promise<readonly [string, readonly unknown[]]> => [
    relation.name,
    await source.rows(relation)
  ]));

  return Object.fromEntries(entries);
}

function runtimeRelations(runtime: AutomergeDbRelationRuntime, index: number): readonly RelationRef[] {
  if (isRelationRef(runtime.relation)) {
    return [runtime.relation];
  }

  if (Array.isArray(runtime.relations) && runtime.relations.length > 0) {
    return runtime.relations.flatMap((relationOrMapping) =>
      isAutomergeMapRelation(relationOrMapping) ? [relationOrMapping.relation] : [relationOrMapping]
    );
  }

  throw new TypeError(
    `automergeDb runtimes[${index}] must declare relation metadata; ` +
    'pass a runtime with relation/relations or wrap it with automergeDbRelationRuntime(runtime, relation)'
  );
}

function normalizeRuntimeRelationInput(
  input: RelationRef | readonly (RelationRef | AutomergeMapRelation)[]
): readonly (RelationRef | AutomergeMapRelation)[] {
  const relations = Array.isArray(input) ? input : [input];

  if (relations.length === 0) {
    throw new TypeError('automergeDbRelationRuntime requires at least one relation');
  }

  for (const relation of relations) {
    if (!isRelationRef(relation) && !isAutomergeMapRelation(relation)) {
      throw new TypeError('automergeDbRelationRuntime relations must be RelationRef or AutomergeMapRelation values');
    }
  }

  return relations;
}

function uniqueRelationNames(relations: readonly RelationRef[]): readonly string[] {
  return Array.from(new Set(relations.map((relation) => relation.name)));
}

function isAutomergeMapRelation(input: unknown): input is AutomergeMapRelation {
  return isRecord(input) && 'relation' in input && 'path' in input;
}

function isRelationRef(input: unknown): input is RelationRef {
  return isRecord(input) && input.kind === 'relation' && typeof input.name === 'string';
}

function isQuery(input: unknown): input is Query {
  return isRecord(input) && 'data' in input && 'relations' in input;
}

function assertMapCodec(codec: AutomergeMapStorageCodec | undefined): void {
  if (codec !== undefined && codec !== 'map-v1') {
    throw new TypeError(`unsupported Automerge map storage codec "${String(codec)}"; expected map-v1`);
  }
}

function materializeRelation(
  doc: unknown,
  mappings: readonly AutomergeMapRelation[],
  relation: RelationRef
): RelationRows {
  const matchingMappings = mappings.filter((mapping) => mapping.relation.name === relation.name);

  return combineRelationRows(matchingMappings.map((mapping) => materializeMapping(doc, mapping)));
}

function materializeMapping(doc: unknown, mapping: AutomergeMapRelation): RelationRows {
  const mapValue = valueAtPath(doc, mapping.path);

  if (mapValue === undefined) {
    return { rows: [], diagnostics: [] };
  }

  if (!isRecord(mapValue)) {
    return {
      rows: [],
      diagnostics: [invalidRowDiagnostic(mapping.relation, undefined, undefined, 'mapped Automerge path is not an object')]
    };
  }

  const rows: Record<string, unknown>[] = [];
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [key, storedRow] of Object.entries(mapValue)) {
    if (!isPlainRecord(storedRow)) {
      diagnostics.push(invalidRowDiagnostic(mapping.relation, undefined, key, 'stored relation row is not an object'));
      continue;
    }

    const row = restoreRowKey(mapping.relation, key, storedRow);
    const rowDiagnostics = validateRow(mapping.relation, row, key);

    if (rowDiagnostics.length === 0) {
      rows.push(row);
    } else {
      diagnostics.push(...rowDiagnostics);
    }
  }

  return { rows, diagnostics };
}

function combineRelationRows(results: readonly RelationRows[]): RelationRows {
  return {
    rows: results.flatMap((result) => result.rows),
    diagnostics: results.flatMap((result) => result.diagnostics)
  };
}

function restoreRowKey(relation: RelationRef, key: string, storedRow: Record<string, unknown>): Record<string, unknown> {
  const row = { ...storedRow };
  const keyFields = relationKeyFields(relation);
  const keyValues = keyFields.length === 1 ? [key] : parseCompositeKey(key);

  for (const [index, field] of keyFields.entries()) {
    row[field] = keyValues[index];
  }

  return row;
}

function storedRowFor(relation: RelationRef, row: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...row };

  for (const field of relationKeyFields(relation)) {
    delete stored[field];
  }

  return stored;
}

function planPatches(
  doc: unknown,
  mappings: readonly AutomergeMapRelation[],
  patches: readonly WritePatch[]
): PlannedApply | { readonly diagnostics: readonly TarstateDiagnostic[] } {
  const states = new Map<string, MutableRelationState>();
  const deltas = new Map<string, MutableDelta>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const mapping of mappings) {
    const materialized = materializeMapping(doc, mapping);
    const rows = new Map<string, Record<string, unknown>>();

    for (const row of materialized.rows) {
      rows.set(rowMapKey(mapping.relation, row), row);
    }

    states.set(mapping.relation.name, { mapping, rows });
  }

  for (const patch of patches) {
    const state = states.get(patch.relation.name);

    if (state === undefined) {
      diagnostics.push({
        code: 'missing_ref',
        relation: patch.relation.name,
        message: `relation "${patch.relation.name}" is not mapped by this Automerge adapter`
      });
      continue;
    }

    diagnostics.push(...planPatch(state, patch, deltas));
  }

  return diagnostics.length === 0
    ? { states, deltas: publishDeltas(deltas) }
    : { diagnostics };
}

function planPatch(
  state: MutableRelationState,
  patch: WritePatch,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  switch (patch.op) {
    case 'insert':
      return planInsert(state, patch.row, deltas, 'reject');
    case 'insertIgnore':
      return planInsert(state, patch.row, deltas, 'ignore');
    case 'insertOrReplace':
      return planInsert(state, patch.row, deltas, 'replace');
    case 'insertOrUpdate':
      return state.rows.has(rowMapKey(state.mapping.relation, patch.row))
        ? planUpdateByKey(state, rowMapKey(state.mapping.relation, patch.row), patch.update, deltas)
        : planInsert(state, patch.row, deltas, 'reject');
    case 'insertOrMerge':
      return planInsertOrMerge(state, patch.row, patch.merge, deltas);
    case 'updateByKey':
      return planUpdateByKey(state, keyInputMapKey(patch.key), patch.changes, deltas);
    case 'update':
      return planPredicateUpdate(state, patch.predicate, patch.changes, deltas);
    case 'deleteByKey':
      return planDeleteByKey(state, keyInputMapKey(patch.key), deltas);
    case 'delete':
      return planPredicateDelete(state, patch.predicate, deltas);
    case 'deleteExact':
      return planDeleteExact(state, patch.row, deltas);
    case 'replaceAll':
      return planReplaceAll(state, patch.rows, deltas);
  }
}

function planInsert(
  state: MutableRelationState,
  row: Record<string, unknown>,
  deltas: Map<string, MutableDelta>,
  conflict: 'reject' | 'ignore' | 'replace'
): readonly TarstateDiagnostic[] {
  const diagnostics = firstDiagnostic(validateRow(
    state.mapping.relation,
    row,
    String(rowKeyValue(state.mapping.relation, row))
  ));

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  const key = rowMapKey(state.mapping.relation, row);
  const existing = state.rows.get(key);

  if (existing !== undefined && conflict === 'reject') {
    return [{
      code: 'duplicate_key',
      relation: state.mapping.relation.name,
      key,
      message: `relation "${state.mapping.relation.name}" already has row "${key}"`
    }];
  }

  if (existing !== undefined && conflict === 'ignore') {
    return [];
  }

  if (existing !== undefined) {
    recordRemoved(deltas, state.mapping.relation, existing);
  }

  state.rows.set(key, { ...row });
  recordAdded(deltas, state.mapping.relation, row);
  return [];
}

function planInsertOrMerge(
  state: MutableRelationState,
  row: Record<string, unknown>,
  merge: unknown,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const keyDiagnostics = validateKeyFields(state.mapping.relation, row);

  if (keyDiagnostics.length > 0) {
    return keyDiagnostics;
  }

  const key = rowMapKey(state.mapping.relation, row);
  const existing = state.rows.get(key);

  if (existing === undefined) {
    return planInsert(state, row, deltas, 'reject');
  }

  const fields = mergeFields(state.mapping.relation, row, merge);
  const changes = Object.fromEntries(fields.map((field) => [field, row[field]]));

  return planUpdateByKey(state, key, changes, deltas);
}

function planUpdateByKey(
  state: MutableRelationState,
  key: string,
  changes: Record<string, unknown>,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const existing = state.rows.get(key);

  if (existing === undefined) {
    return [missingRowDiagnostic(state.mapping.relation, key)];
  }

  const updated = { ...existing, ...changes };
  const diagnostics = firstDiagnostic(validateRow(state.mapping.relation, updated, key));

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  const updatedKey = rowMapKey(state.mapping.relation, updated);

  if (updatedKey !== key) {
    return [invalidRowDiagnostic(state.mapping.relation, relationKeyFields(state.mapping.relation)[0], key, 'updates cannot change relation keys')];
  }

  state.rows.set(key, updated);
  recordRemoved(deltas, state.mapping.relation, existing);
  recordAdded(deltas, state.mapping.relation, updated);
  return [];
}

function planPredicateUpdate(
  state: MutableRelationState,
  predicate: PredicateData,
  changes: Record<string, unknown>,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [key, row] of Array.from(state.rows.entries())) {
    const match = evaluatePredicate(predicate, row);

    if (match === undefined) {
      return [unsupportedPredicateDiagnostic(state.mapping.relation)];
    }

    if (match) {
      diagnostics.push(...planUpdateByKey(state, key, changes, deltas));
    }
  }

  return diagnostics;
}

function planDeleteByKey(
  state: MutableRelationState,
  key: string,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const existing = state.rows.get(key);

  if (existing === undefined) {
    return [missingRowDiagnostic(state.mapping.relation, key)];
  }

  state.rows.delete(key);
  recordRemoved(deltas, state.mapping.relation, existing);
  return [];
}

function planPredicateDelete(
  state: MutableRelationState,
  predicate: PredicateData,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  for (const [key, row] of Array.from(state.rows.entries())) {
    const match = evaluatePredicate(predicate, row);

    if (match === undefined) {
      return [unsupportedPredicateDiagnostic(state.mapping.relation)];
    }

    if (match) {
      state.rows.delete(key);
      recordRemoved(deltas, state.mapping.relation, row);
    }
  }

  return [];
}

function planDeleteExact(
  state: MutableRelationState,
  row: Record<string, unknown>,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const key = rowMapKey(state.mapping.relation, row);
  const existing = state.rows.get(key);

  if (existing === undefined || !deepEqual(existing, row)) {
    return [missingRowDiagnostic(state.mapping.relation, key)];
  }

  state.rows.delete(key);
  recordRemoved(deltas, state.mapping.relation, existing);
  return [];
}

function planReplaceAll(
  state: MutableRelationState,
  rows: readonly Record<string, unknown>[],
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];
  const replacement = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const key = rowMapKey(state.mapping.relation, row);
    const rowDiagnostics = firstDiagnostic(validateRow(state.mapping.relation, row, key));

    if (rowDiagnostics.length > 0) {
      diagnostics.push(...rowDiagnostics);
      continue;
    }

    if (replacement.has(key)) {
      diagnostics.push({
        code: 'duplicate_key',
        relation: state.mapping.relation.name,
        key,
        message: `replacement rows contain duplicate key "${key}"`
      });
      continue;
    }

    replacement.set(key, { ...row });
  }

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  for (const row of state.rows.values()) {
    recordRemoved(deltas, state.mapping.relation, row);
  }

  for (const row of replacement.values()) {
    recordAdded(deltas, state.mapping.relation, row);
  }

  state.rows.clear();
  for (const [key, row] of replacement) {
    state.rows.set(key, row);
  }

  return [];
}

function applyPlannedChanges<DocumentShape extends Record<string, unknown>>(
  planned: PlannedApply
): (doc: DocumentShape) => void {
  return (draft) => {
    for (const state of planned.states.values()) {
      const map = ensureMutableMapAtPath(draft, state.mapping.path);

      for (const key of Object.keys(map)) {
        delete map[key];
      }

      for (const [key, row] of state.rows) {
        map[key] = storedRowFor(state.mapping.relation, row);
      }
    }
  };
}

function ensureMutableMapAtPath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let current = root;

  for (const segment of path) {
    const next = current[segment];

    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  return current;
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function validateRow(relation: RelationRef, row: Record<string, unknown>, key?: string): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [field, spec] of Object.entries(relation.fields)) {
    const value = row[field];

    if (!isFieldValueValid(spec, value)) {
      diagnostics.push(invalidRowDiagnostic(relation, field, key, `invalid value for field "${field}"`));
    }
  }

  return diagnostics;
}

function firstDiagnostic(diagnostics: readonly TarstateDiagnostic[]): readonly TarstateDiagnostic[] {
  const [diagnostic] = diagnostics;
  return diagnostic === undefined ? [] : [diagnostic];
}

function validateKeyFields(relation: RelationRef, row: Record<string, unknown>): readonly TarstateDiagnostic[] {
  return relationKeyFields(relation).flatMap((field) =>
    isFieldValueValid(relation.fields[field], row[field])
      ? []
      : [invalidRowDiagnostic(relation, field, undefined, `invalid value for key field "${field}"`)]
  );
}

function isFieldValueValid(spec: FieldSpec | undefined, value: unknown): boolean {
  if (spec === undefined) {
    return true;
  }

  if (value === undefined) {
    return spec.optional;
  }

  if (value === null) {
    return spec.nullable;
  }

  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return isJsonValue(value);
  }
}

function rowMapKey(relation: RelationRef, row: Record<string, unknown>): string {
  const fields = relationKeyFields(relation);
  const values = fields.map((field) => row[field]);

  return fields.length === 1 ? String(values[0]) : JSON.stringify(values);
}

function rowKeyValue(relation: RelationRef, row: Record<string, unknown>): unknown {
  const fields = relationKeyFields(relation);
  const values = fields.map((field) => row[field]);

  return fields.length === 1 ? values[0] : values;
}

function keyInputMapKey(key: RelationKeyInput): string {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function parseCompositeKey(key: string): readonly unknown[] {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) ? parsed : [key];
  } catch {
    return [key];
  }
}

function relationKeyFields(relation: RelationRef): readonly string[] {
  const key = relation.key;
  return Array.isArray(key) ? key : [key as string];
}

function mergeFields(relation: RelationRef, row: Record<string, unknown>, merge: unknown): readonly string[] {
  const keyFields = new Set(relationKeyFields(relation));

  if (Array.isArray(merge)) {
    return merge.filter((field): field is string => typeof field === 'string' && !keyFields.has(field));
  }

  if (merge === 'all') {
    return Object.keys(relation.fields).filter((field) => !keyFields.has(field) && field in row);
  }

  return Object.keys(row).filter((field) => !keyFields.has(field));
}

function evaluatePredicate(predicate: PredicateData, row: Record<string, unknown>): boolean | undefined {
  switch (predicate.op) {
    case 'and': {
      for (const child of predicate.predicates) {
        const value = evaluatePredicate(child, row);
        if (value === undefined || !value) return value;
      }
      return true;
    }
    case 'or': {
      let unsupported = false;
      for (const child of predicate.predicates) {
        const value = evaluatePredicate(child, row);
        if (value === true) return true;
        if (value === undefined) unsupported = true;
      }
      return unsupported ? undefined : false;
    }
    case 'not': {
      const value = evaluatePredicate(predicate.predicate, row);
      return value === undefined ? undefined : !value;
    }
    default: {
      const left = evaluatePredicateExpr(predicate.left, row);
      const right = evaluatePredicateExpr(predicate.right, row);

      if (left.unsupported || right.unsupported) {
        return undefined;
      }

      return compareValues(left.value, right.value, predicate.op);
    }
  }
}

function evaluatePredicateExpr(
  expr: PredicateData extends infer _Predicate ? { readonly op: string } & Record<string, unknown> : never,
  row: Record<string, unknown>
): { readonly unsupported: boolean; readonly value?: unknown } {
  if (expr.op === 'field' && typeof expr.field === 'string') {
    return { unsupported: false, value: row[expr.field] };
  }

  if (expr.op === 'value') {
    return { unsupported: false, value: expr.value };
  }

  return { unsupported: true };
}

function compareValues(left: unknown, right: unknown, op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'): boolean {
  const canCompare = comparable(left, right);
  const comparableLeft = left as string | number;
  const comparableRight = right as string | number;

  switch (op) {
    case 'eq':
      return Object.is(left, right);
    case 'neq':
      return !Object.is(left, right);
    case 'lt':
      return canCompare && comparableLeft < comparableRight;
    case 'lte':
      return canCompare && comparableLeft <= comparableRight;
    case 'gt':
      return canCompare && comparableLeft > comparableRight;
    case 'gte':
      return canCompare && comparableLeft >= comparableRight;
  }
}

function comparable(left: unknown, right: unknown): left is string | number {
  return (typeof left === 'string' && typeof right === 'string') ||
    (typeof left === 'number' && typeof right === 'number');
}

function inRange(value: unknown, lower?: RelationRangeBound, upper?: RelationRangeBound): boolean {
  if (lower !== undefined && !boundMatches(value, lower, 'lower')) {
    return false;
  }

  if (upper !== undefined && !boundMatches(value, upper, 'upper')) {
    return false;
  }

  return true;
}

function boundMatches(value: unknown, bound: RelationRangeBound, side: 'lower' | 'upper'): boolean {
  if (!comparable(value, bound.value)) {
    return false;
  }

  const comparableValue = value as string | number;
  const comparableBound = bound.value as string | number;

  if (side === 'lower') {
    return bound.inclusive ? comparableValue >= comparableBound : comparableValue > comparableBound;
  }

  return bound.inclusive ? comparableValue <= comparableBound : comparableValue < comparableBound;
}

function recordAdded(deltas: Map<string, MutableDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).added.push(row);
}

function recordRemoved(deltas: Map<string, MutableDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).removed.push(row);
}

function deltaFor(deltas: Map<string, MutableDelta>, relation: RelationRef): MutableDelta {
  const existing = deltas.get(relation.name);

  if (existing !== undefined) {
    return existing;
  }

  const delta = { relation, added: [], removed: [] };
  deltas.set(relation.name, delta);
  return delta;
}

function publishDeltas(deltas: Map<string, MutableDelta>): readonly RelationDelta[] {
  return Array.from(deltas.values(), (delta) => ({
    relation: delta.relation,
    added: [...delta.added],
    removed: [...delta.removed]
  }));
}

function invalidRowDiagnostic(
  relation: RelationRef,
  field: string | undefined,
  key: string | undefined,
  message: string
): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    relation: relation.name,
    ...(field === undefined ? {} : { field }),
    ...(key === undefined ? {} : { key }),
    message
  };
}

function missingRowDiagnostic(relation: RelationRef, key: string): TarstateDiagnostic {
  return {
    code: 'missing_ref',
    relation: relation.name,
    key,
    message: `relation "${relation.name}" has no row "${key}"`
  };
}

function unsupportedPredicateDiagnostic(relation: RelationRef): TarstateDiagnostic {
  return {
    code: 'unsupported_expression',
    relation: relation.name,
    message: `relation "${relation.name}" write predicate is not supported by the Automerge adapter`
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && Object.prototype.toString.call(input) === '[object Object]';
}
