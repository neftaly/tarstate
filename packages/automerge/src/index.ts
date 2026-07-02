import * as Automerge from '@automerge/automerge';
import type { QueryResult } from '@tarstate/core/evaluate';
import {
  createDb,
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
import type {
  AdapterSnapshot,
  AdapterSource,
  RelationApplyReport,
  RelationDelta,
  RelationPatchTarget,
  RelationRuntime,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import {
  composeRelationRuntimes,
  tryApplyRelationPatches
} from '@tarstate/core/adapter';
import type { RowChange } from '@tarstate/core/diff';
import type { MaterializedDb, SnapshotMaterializationOptions } from '@tarstate/core/materialization';
import { queryKey, type Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import { type RelationRow, type WriteInput, type WritePatch } from '@tarstate/core/write';

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
> = RelationRuntime<Automerge.Heads> & {
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

type AutomergeDbQueryTarget<Row = unknown> = Query<Row> | RelationRef;

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
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
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

let nextWatchId = 0;

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

export function automergeMapSource<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeMapSourceOptions
): AutomergeMapSource {
  void doc;
  const relationNames = relationNamesFor(options.relations);

  return {
    relationNames,
    rows: () => [],
    lookup: () => [],
    rangeLookup: () => [],
    version: () => Automerge.getHeads(doc),
    diagnostics: () => [stubDiagnostic('automerge map source is not implemented')]
  };
}

export function automergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  options: AutomergeMapAdapterOptions<DocumentShape>
): AutomergeMapAdapter<DocumentShape> {
  assertSupportedStorage(options.storage);

  let doc = options.doc;
  const listeners = new Set<() => void>();
  const relationNames = relationNamesFor(options.relations);
  const source: AutomergeMapSource = {
    relationNames,
    rows: () => [],
    lookup: () => [],
    rangeLookup: () => [],
    version: () => Automerge.getHeads(doc),
    diagnostics: () => [stubDiagnostic('automerge map adapter source is not implemented')]
  };
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => relationNames.includes(relationName),
    apply: (patches) => ({
      status: 'rejected',
      patches: patches.length,
      applied: 0,
      deltas: [],
      diagnostics: [stubDiagnostic('automerge map adapter writes are not implemented')],
      durability: 'durable',
      version: Automerge.getHeads(doc)
    })
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    source,
    target,
    relations: options.relations,
    getDoc: () => doc,
    setDoc: (nextDoc) => {
      doc = nextDoc;
      options.onDocChange?.(doc);
      notify();
    },
    snapshot: () => ({
      source,
      version: Automerge.getHeads(doc),
      diagnostics: [stubDiagnostic('automerge map adapter snapshot is not implemented')]
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
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
  if (isReadonlyArray(relationOrRelations)) {
    return { ...runtime, relations: relationOrRelations };
  }

  return { ...runtime, relation: relationOrRelations };
}

export function automergeDb<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeDbOptions<DocumentShape>
): AutomergeDb<DocumentShape> {
  const adapter = automergeMapAdapter<DocumentShape>({ ...options, doc });
  const runtimes = options.runtimes ?? [];
  const runtime = runtimes.length === 0
    ? adapter as RelationRuntime<AutomergeDbVersion>
    : composeRelationRuntimes(adapter, ...runtimes);
  const relations = uniqueRelations([
    ...options.relations.map((mapping) => mapping.relation),
    ...runtimes.flatMap(runtimeRelations)
  ]);
  const snapshotDb = () => createDb({}, options.env === undefined ? {} : { env: options.env });
  const getSnapshot = async (): Promise<AutomergeDbSnapshot> => {
    const version = runtime.source.version?.();
    const diagnostics = runtime.source.diagnostics?.() ?? [];

    return {
      db: snapshotDb(),
      source: runtime.source,
      ...(version === undefined ? {} : { version }),
      diagnostics
    };
  };
  const db = async () => (await getSnapshot()).db;
  const query = (async (
    queryOrQueries: AutomergeDbQueryTarget | QueryBatch,
    queryOptions?: DbQueryOptions
  ) => {
    await db();
    if (isQueryBatch(queryOrQueries)) {
      return stubQueryResult(queryOrQueries, queryOptions);
    }

    return stubQueryResult(queryOrQueries, queryOptions);
  }) as AutomergeDbQuery;
  const tryTransact = async (
    ...inputs: readonly AutomergeDbTransactionInput[]
  ): Promise<AutomergeDbTransactionResult> => {
    const currentDb = await db();
    const patches = inputs.flatMap((input) => writeInputPatches(typeof input === 'function' ? input(currentDb) : input));
    const report = await tryApplyRelationPatches(runtime, patches, { readVersion: true });
    const nextSnapshot = await getSnapshot();
    const committed = report.status === 'accepted' || report.status === 'partial';

    return {
      kind: 'automergeDbTransaction',
      db: nextSnapshot.db,
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
    mat: async () => await db() as Db & MaterializedDb,
    querySnapshot: async <Row>(
      queryValue: Query<Row>,
      snapshotOptions?: { readonly id?: string; readonly name?: string }
    ) => {
      const snapshot = await db();
      const result = stubQueryResult(queryValue) as QueryResult<Row>;
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
    watch: (target, listener, watchOptions) => createStubWatch(target, listener, watchOptions),
    subscribe: runtime.subscribe ?? adapter.subscribe
  };
}

function relationNamesFor(relations: readonly AutomergeMapRelation[]): readonly string[] {
  return Array.from(new Set(relations.map((mapping) => mapping.relation.name)));
}

function runtimeRelations(runtime: AutomergeDbRelationRuntime): readonly RelationRef[] {
  if ('relation' in runtime && runtime.relation !== undefined) {
    return [runtime.relation];
  }

  return runtime.relations.map((relationOrMapping) =>
    isMapRelation(relationOrMapping) ? relationOrMapping.relation : relationOrMapping
  );
}

function uniqueRelations(relations: readonly RelationRef[]): readonly RelationRef[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    if (seen.has(relation.name)) {
      return false;
    }

    seen.add(relation.name);
    return true;
  });
}

function isMapRelation(input: RelationRef | AutomergeMapRelation): input is AutomergeMapRelation {
  return 'relation' in input && 'path' in input;
}

function isReadonlyArray<Value>(input: Value | readonly Value[]): input is readonly Value[] {
  return Array.isArray(input);
}

function writeInputPatches(input: WriteInput): readonly WritePatch[] {
  if (isWritePatch(input)) {
    return [input];
  }

  return Array.from(input);
}

function isWritePatch(input: WriteInput): input is WritePatch {
  return typeof input === 'object' &&
    input !== null &&
    'op' in input &&
    'relation' in input;
}

function createStubWatch<Row extends Record<string, unknown>>(
  target: AutomergeDbWatchTarget<Row>,
  listener: AutomergeDbWatchListener<Row>,
  options: AutomergeDbWatchOptions<Row> = {}
): AutomergeDbWatchHandle<Row> {
  const id = `automerge-watch-${nextWatchId += 1}`;
  let closed = false;
  const handle: AutomergeDbWatchHandle<Row> = {
    kind: 'automergeDbWatch',
    id,
    target,
    refresh: async () => {
      const event: AutomergeDbWatchEvent<Row> = {
        kind: 'automergeDbWatchEvent',
        id,
        target,
        changed: false,
        previousRows: [],
        rows: [],
        added: [],
        removed: [],
        unchanged: [],
        rowChanges: [],
        diagnostics: closed ? [] : [stubDiagnostic('automerge DB watches are not implemented')],
        ...(options.label === undefined ? {} : { label: options.label })
      };

      if (!closed) {
        await listener(event);
      }

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

function stubQueryResult<Row, MappedRow>(
  queryOrQueries: AutomergeDbQueryTarget<Row>,
  options?: DbQueryOptions<Row, MappedRow>
): QueryResult<Row | MappedRow>;
function stubQueryResult<const Queries extends QueryBatch, MappedRow>(
  queryOrQueries: Queries,
  options?: DbQueryOptions<unknown, MappedRow>
): QueryBatchResult<Queries> | MappedQueryBatchResult<Queries, MappedRow>;
function stubQueryResult(
  queryOrQueries: AutomergeDbQueryTarget | QueryBatch,
  options: DbQueryOptions = {}
): QueryResult<unknown> | QueryBatchResult<QueryBatch> {
  if (isQueryBatch(queryOrQueries)) {
    return Object.fromEntries(
      Object.keys(queryOrQueries).map((key) => [key, emptyQueryResult(options)])
    ) as QueryBatchResult<QueryBatch>;
  }

  return emptyQueryResult(options);
}

function emptyQueryResult(options: DbQueryOptions): QueryResult<unknown> {
  const rows = options.mapRows?.([]) ?? [];
  return {
    rows,
    diagnostics: []
  };
}

function isQueryBatch(input: AutomergeDbQueryTarget | QueryBatch): input is QueryBatch {
  return typeof input === 'object' &&
    input !== null &&
    !('kind' in input && input.kind === 'relation') &&
    !('data' in input && 'relations' in input);
}

function assertSupportedStorage(storage: AutomergeMapStorageOptions | undefined): void {
  if (storage?.codec !== undefined && storage.codec !== 'map-v1') {
    throw new Error(`unsupported Automerge storage codec: ${String(storage.codec)}`);
  }
}

function stubDiagnostic(message: string): TarstateDiagnostic {
  return {
    code: 'not_implemented',
    message
  };
}
