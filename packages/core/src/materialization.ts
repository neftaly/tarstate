import type { TarstateDiagnostic } from './diagnostics.js';
import { diffRows, type RowChange, type RowDiffDiagnostic } from './diff.js';
import {
  queryKey,
  queryRowKeyFields,
  relationDependencies,
  type ExprData,
  type OptionalProjection,
  type PredicateData,
  type ProjectionData,
  type Query,
  type QueryData,
  type SortData
} from './query.js';
import type { RelationRef } from './schema.js';
import { isRelationSource, type RelationSource } from './source.js';
import { attachConstraints, type ConstraintAttachmentInput } from './constraints-attachment.js';

declare const materializedDb: unique symbol;

export type MaterializableDb = object;
export type ObjectBackedMaterializableDb = {
  readonly data: Record<string, readonly unknown[]>;
};
export type SnapshotMaterializationTarget = ObjectBackedMaterializableDb | RelationSource;

export type MaterializedDb = {
  readonly [materializedDb]: true;
};

export type UnsupportedMaterializationDiagnostic = {
  readonly code: 'materialization_unsupported';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail?: unknown;
};
export type MissingMaterializationDiagnostic = {
  readonly code: 'materialization_missing';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail?: unknown;
};
export type UnsupportedMaterializationIndexDiagnostic = {
  readonly code: 'materialization_index_unsupported';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail?: unknown;
};
export type IncrementalFallbackMaterializationDiagnostic = {
  readonly code: 'materialization_incremental_fallback';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail: {
    readonly mode: 'incremental';
    readonly fallback: 'recompute';
    readonly id: string;
    readonly queryKey: string;
    readonly reason: string;
  };
};
export type MissingMaterializationRowsDiagnostic = {
  readonly code: 'materialization_rows_missing';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail: {
    readonly id: string;
    readonly queryKey: string;
  };
};
export type StaleMaterializationDiagnostic = {
  readonly code: 'materialization_stale';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail: {
    readonly id: string;
    readonly queryKey: string;
    readonly sourceVersion: unknown;
    readonly metadataSourceVersion: unknown;
  };
};
export type UnknownMaterializationVersionDiagnostic = {
  readonly code: 'materialization_version_unknown';
  readonly message: string;
  readonly surface: 'materialization';
  readonly detail: {
    readonly id: string;
    readonly queryKey: string;
    readonly reason: string;
    readonly sourceVersion?: unknown;
    readonly metadataSourceVersion?: unknown;
  };
};
export type MaterializationDiagnostic =
  | UnsupportedMaterializationDiagnostic
  | MissingMaterializationDiagnostic
  | UnsupportedMaterializationIndexDiagnostic
  | IncrementalFallbackMaterializationDiagnostic
  | MissingMaterializationRowsDiagnostic
  | StaleMaterializationDiagnostic
  | UnknownMaterializationVersionDiagnostic
  | RowDiffDiagnostic
  | TarstateDiagnostic;

export type MaterializationMode = 'snapshot' | 'incremental';
export type MaterializationMaintenanceKind = 'snapshot' | 'incremental';

export type MaterializationOptions = {
  readonly id?: string;
  readonly name?: string;
  readonly mode?: MaterializationMode;
};
export type SnapshotMaterializationOptions = MaterializationOptions;
export type MaterializationMaintenanceOptions = {
  readonly deltas?: readonly unknown[];
};
export type SnapshotRefreshTarget<Row = unknown> = string | MaterializationMetadata<Row> | Query<Row>;
export type MaterializedSourceOptions = {
  readonly relationName?: string;
};

export type MaterializationMetadata<Row = unknown> = {
  readonly kind: 'materialization';
  readonly id: string;
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly requestedMode: MaterializationMode;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly dependencies: readonly string[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly name?: string;
};

export type MaterializationExplanation<Row = unknown> = {
  readonly kind: 'materializationExplanation';
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly requestedMode: MaterializationMode;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly dependencies: readonly string[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};

export type MaterializationRefreshResult<Row = unknown> = {
  readonly kind: 'materializationRefresh';
  readonly id?: string;
  readonly queryKey?: string;
  readonly refreshed: boolean;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};

export type MaterializationMaintenanceChangeKind = 'carried' | 'recomputed';

export type MaterializationMaintenanceChange<Row = unknown> = {
  readonly kind: 'materializationMaintenanceChange';
  readonly update: MaterializationMaintenanceChangeKind;
  readonly id: string;
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly previousRowsAvailable: boolean;
  readonly previousRows: readonly Row[] | undefined;
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};

export type MaterializationMaintenanceResult<Row = unknown> = {
  readonly kind: 'materializationMaintenance';
  readonly maintained: number;
  readonly recomputed: number;
  readonly carried: number;
  readonly changes: readonly MaterializationMaintenanceChange<Row>[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};

export type MaterializationIndex<Row = unknown> = {
  readonly kind: 'set';
  readonly rows: ReadonlySet<Row>;
};

export type MaterializationHashIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'hash';
  readonly field: string;
  readonly lookup: ReadonlyMap<Value, readonly Row[]>;
};

export type MaterializationBtreeIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'btree';
  readonly field: string;
  readonly lookup: ReadonlyMap<Value, readonly Row[]>;
  readonly ordered: readonly Value[];
};

export type MaterializationUniqueIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'unique';
  readonly field: string;
  readonly lookup: ReadonlyMap<Value, Row>;
};

export type MaterializationIndexResult<Row = unknown> = {
  readonly kind: 'materializationIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly index?: MaterializationIndex<Row>;
};

export type MaterializationHashIndexResult<Row = unknown, Value = unknown> = {
  readonly kind: 'materializationHashIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly index?: MaterializationHashIndex<Row, Value>;
};

export type MaterializationBtreeIndexResult<Row = unknown, Value = unknown> = {
  readonly kind: 'materializationBtreeIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly index?: MaterializationBtreeIndex<Row, Value>;
};

export type MaterializationUniqueIndexResult<Row = unknown, Value = unknown> = {
  readonly kind: 'materializationUniqueIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly index?: MaterializationUniqueIndex<Row, Value>;
};

export type MaterializedQueryResult<Row = unknown> = {
  readonly kind: 'materializedQueryResult';
  readonly materialized: boolean;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly queryKey: string;
  readonly id?: string;
};

export type MaterializationIndexOptions<Field extends string = string> =
  | { readonly kind?: 'set' }
  | { readonly kind: 'hash'; readonly field: Field }
  | { readonly kind: 'btree'; readonly field: Field }
  | { readonly kind: 'unique'; readonly field: Field };

type StoredMaterialization<Row = unknown> = {
  readonly metadata: MaterializationMetadata<Row>;
  readonly rows: readonly Row[];
};

const materializedDbs = new WeakSet<object>();
const materializationStore = new WeakMap<object, Map<string, StoredMaterialization>>();

export function mat<Db extends object>(
  db: Db,
  constraints: ConstraintAttachmentInput
): Db & import('./constraints-attachment.js').ConstrainedDb;
export function mat<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  query: Query<Row>,
  options?: SnapshotMaterializationOptions
): Db & MaterializedDb;
export function mat<Db extends object, Row>(
  db: Db,
  queryOrConstraints: Query<Row> | ConstraintAttachmentInput,
  options: SnapshotMaterializationOptions = {}
): Db {
  if (!isQuery(queryOrConstraints)) {
    return attachConstraints(db, queryOrConstraints);
  }

  return materializeDbSnapshot(db as Db & SnapshotMaterializationTarget, queryOrConstraints, options);
}

export function materializeSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  query: Query<Row>,
  options: SnapshotMaterializationOptions = {}
): Promise<Db & MaterializedDb> {
  return Promise.resolve(materializeDbSnapshot(db, query, options));
}

export function explainMaterialization<Row>(
  query: Query<Row>,
  options: MaterializationOptions = {}
): MaterializationExplanation<Row> {
  const key = queryKey(query);
  const requestedMode = options.mode ?? 'snapshot';
  return {
    kind: 'materializationExplanation',
    queryKey: key,
    query,
    requestedMode,
    maintenance: requestedMode === 'incremental' ? 'snapshot' : 'snapshot',
    dependencies: relationDependencies(query),
    diagnostics: requestedMode === 'incremental'
      ? [incrementalFallbackDiagnostic(options.id ?? options.name ?? key, key)]
      : []
  };
}

export function refreshMaterializationSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  target: SnapshotRefreshTarget<Row>
): Promise<MaterializationRefreshResult<Row>> {
  const refreshed = refreshMaterialization(db, target);
  return Promise.resolve(refreshed);
}

export function refreshMaterialization<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  target: SnapshotRefreshTarget<Row>
): MaterializationRefreshResult<Row> {
  const stored = resolveMaterialization(db, target);
  if (stored === undefined) {
    return {
      kind: 'materializationRefresh',
      ...targetIdentity(target),
      refreshed: false,
      rows: [],
      diagnostics: [missingDiagnostic()]
    };
  }

  const rows = evaluateTargetRows(db, stored.metadata.query);
  storeMaterialization(db, { metadata: stored.metadata, rows });
  return {
    kind: 'materializationRefresh',
    id: stored.metadata.id,
    queryKey: stored.metadata.queryKey,
    refreshed: true,
    rows,
    diagnostics: []
  };
}

export function maintainMaterializationSnapshots<Next extends SnapshotMaterializationTarget>(
  previous: SnapshotMaterializationTarget,
  next: Next,
  _options: MaterializationMaintenanceOptions = {}
): Promise<Next & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult }> {
  maintainMaterializations(previous, next);
  return Promise.resolve(markMaterialized(next) as Next & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult });
}

export function maintainMaterializations<Next extends SnapshotMaterializationTarget>(
  previous: SnapshotMaterializationTarget,
  next: Next
): MaterializationMaintenanceResult {
  if (!isObject(previous) || !isObject(next)) {
    return emptyMaintenance();
  }

  const previousStore = materializationStore.get(previous);
  if (previousStore === undefined) {
    return emptyMaintenance();
  }

  const nextStore = new Map<string, StoredMaterialization>();
  const changes: MaterializationMaintenanceChange[] = [];

  for (const stored of uniqueMaterializations(previousStore)) {
    const rows = evaluateTargetRows(next, stored.metadata.query);
    const diff = diffRows(stored.rows, rows, materializationDiffOptions(stored.metadata.query));
    const change: MaterializationMaintenanceChange = {
      kind: 'materializationMaintenanceChange',
      update: diff.changes.length === 0 ? 'carried' : 'recomputed',
      id: stored.metadata.id,
      queryKey: stored.metadata.queryKey,
      query: stored.metadata.query,
      maintenance: stored.metadata.maintenance,
      previousRowsAvailable: true,
      previousRows: stored.rows,
      rows,
      addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
      removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
      rowChanges: diff.changes,
      diagnostics: diff.diagnostics
    };
    changes.push(change);
    storeMaterializationIn(nextStore, { metadata: stored.metadata, rows });
  }

  materializationStore.set(next, nextStore);
  materializedDbs.add(next);

  return {
    kind: 'materializationMaintenance',
    maintained: changes.length,
    recomputed: changes.filter((change) => change.update === 'recomputed').length,
    carried: changes.filter((change) => change.update === 'carried').length,
    changes,
    diagnostics: changes.flatMap((change) => change.diagnostics)
  };
}

export function demat<Db extends MaterializableDb>(db: Db, target?: string | Query | MaterializationMetadata): Db {
  if (target === undefined) {
    materializedDbs.delete(db);
    materializationStore.delete(db);
    return db;
  }

  const store = materializationStore.get(db);
  if (store === undefined) {
    return db;
  }

  const stored = resolveMaterialization(db, target);
  if (stored === undefined) {
    return db;
  }

  store.delete(stored.metadata.id);
  store.delete(stored.metadata.queryKey);
  if (store.size === 0) {
    materializedDbs.delete(db);
    materializationStore.delete(db);
  }
  return db;
}

export function isMaterialized(input: unknown): input is MaterializedDb {
  return isObject(input) && materializedDbs.has(input);
}

export function materializationsFor(input: unknown): readonly MaterializationMetadata[] {
  return isObject(input)
    ? uniqueMaterializations(materializationStore.get(input) ?? new Map()).map((entry) => entry.metadata)
    : [];
}

export function materializationForQuery<Row = unknown>(
  input: unknown,
  query: Query<Row>
): MaterializationMetadata<Row> | undefined {
  return resolveMaterialization(input, query)?.metadata as MaterializationMetadata<Row> | undefined;
}

export function materializedRowsFor<Row = unknown>(input: unknown, id: string): readonly Row[] | undefined {
  return resolveMaterialization(input, id)?.rows as readonly Row[] | undefined;
}

export function materializedRowsForQuery<Row = unknown>(
  input: unknown,
  query: Query<Row>
): readonly Row[] | undefined {
  return resolveMaterialization(input, query)?.rows as readonly Row[] | undefined;
}

export function queryRowsFromMaterialization<Row = unknown>(
  input: unknown,
  query: Query<Row>
): readonly Row[] | undefined {
  return materializedRowsForQuery(input, query);
}

export function readMaterializedQuery<Row = unknown>(
  input: unknown,
  query: Query<Row>
): Promise<MaterializedQueryResult<Row>> {
  const stored = resolveMaterialization(input, query);
  if (stored !== undefined) {
    return Promise.resolve({
      kind: 'materializedQueryResult',
      materialized: true,
      rows: stored.rows as readonly Row[],
      diagnostics: [],
      queryKey: stored.metadata.queryKey,
      id: stored.metadata.id
    });
  }

  return Promise.resolve({
    kind: 'materializedQueryResult',
    materialized: false,
    rows: [],
    diagnostics: [missingDiagnostic()],
    queryKey: queryKey(query)
  });
}

export function materializedSourceFor<Row = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: MaterializedSourceOptions = {}
): RelationSource {
  const relationName = options.relationName ?? 'materialized';
  return {
    relationNames: [relationName],
    rows: () => resolveMaterialization(input, target)?.rows ?? []
  };
}

export function index<Row = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options?: { readonly kind?: 'set' }
): MaterializationIndexResult<Row>;
export function index<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: { readonly kind: 'hash'; readonly field: string }
): MaterializationHashIndexResult<Row, Value>;
export function index<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: { readonly kind: 'btree'; readonly field: string }
): MaterializationBtreeIndexResult<Row, Value>;
export function index<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: { readonly kind: 'unique'; readonly field: string }
): MaterializationUniqueIndexResult<Row, Value>;
export function index<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: MaterializationIndexOptions = {}
):
  | MaterializationIndexResult<Row>
  | MaterializationHashIndexResult<Row, Value>
  | MaterializationBtreeIndexResult<Row, Value>
  | MaterializationUniqueIndexResult<Row, Value> {
  const stored = resolveMaterialization(input, target);
  if (stored === undefined) {
    return missingIndexResult<Row, Value>(options.kind);
  }

  switch (options.kind) {
    case 'hash':
      return withTarget(stored, {
        kind: 'materializationHashIndex',
        indexed: true,
        diagnostics: [],
        index: { kind: 'hash', field: options.field, lookup: groupRowsByField(stored.rows as readonly Row[], options.field) }
      });
    case 'btree':
      return withTarget(stored, {
        kind: 'materializationBtreeIndex',
        indexed: true,
        diagnostics: [],
        index: btreeIndex(stored.rows as readonly Row[], options.field)
      });
    case 'unique':
      return uniqueIndexResult<Row, Value>(stored, options.field);
    default:
      return withTarget(stored, {
        kind: 'materializationIndex',
        indexed: true,
        diagnostics: [],
        index: { kind: 'set', rows: new Set(stored.rows as readonly Row[]) }
      });
  }
}

export function snapshotIndex<Row = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>
): MaterializationIndexResult<Row> {
  return index(input, target);
}

export function snapshotHashIndex<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  field: string
): MaterializationHashIndexResult<Row, Value>;
export function snapshotHashIndex<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: { readonly field: string }
): MaterializationHashIndexResult<Row, Value>;
export function snapshotHashIndex<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  fieldOrOptions: string | { readonly field: string }
): MaterializationHashIndexResult<Row, Value> {
  const field = typeof fieldOrOptions === 'string' ? fieldOrOptions : fieldOrOptions.field;
  return index(input, target, { kind: 'hash', field });
}

export function evaluateDbQueryRows<Row>(
  db: ObjectBackedMaterializableDb,
  query: Query<Row>
): readonly Row[] {
  return evaluateTargetRows(db, query);
}

function materializeDbSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  query: Query<Row>,
  options: SnapshotMaterializationOptions
): Db & MaterializedDb {
  const key = queryKey(query);
  const requestedMode = options.mode ?? 'snapshot';
  const metadata: MaterializationMetadata<Row> = {
    kind: 'materialization',
    id: options.id ?? options.name ?? key,
    queryKey: key,
    query,
    requestedMode,
    maintenance: 'snapshot',
    dependencies: relationDependencies(query),
    diagnostics: requestedMode === 'incremental'
      ? [incrementalFallbackDiagnostic(options.id ?? options.name ?? key, key)]
      : [],
    ...(options.name === undefined ? {} : { name: options.name })
  };
  storeMaterialization(db, { metadata, rows: evaluateTargetRows(db, query) });
  return markMaterialized(db);
}

function evaluateTargetRows<Row>(target: SnapshotMaterializationTarget, query: Query<Row>): readonly Row[] {
  const source = sourceFor(target);
  return evaluateData(source, query.data, query) as readonly Row[];
}

function evaluateData(source: RelationSource, data: QueryData, query: Query): readonly unknown[] {
  switch (data.op) {
    case 'from': {
      const relation = query.relations[data.relation];
      return relation === undefined ? [] : readRows(source, relation).map((row) => ({ [data.alias]: row }));
    }
    case 'lookup': {
      const relation = query.relations[data.relation];
      if (relation === undefined) return [];
      const value = exprValue({}, data.value);
      return readRows(source, relation)
        .filter((row) => isRecord(row) && Object.is(row[data.field], value))
        .map((row) => ({ [data.alias]: row }));
    }
    case 'constRows':
      return data.rows;
    case 'where':
      return evaluateData(source, data.input, query).filter((row) => matchesPredicate(row, data.predicate));
    case 'hash':
    case 'btree':
    case 'keyBy':
      return evaluateData(source, data.input, query);
    case 'select':
      return evaluateData(source, data.input, query).map((row) => projectRow(row, data.projection));
    case 'extend':
      return evaluateData(source, data.input, query).map((row) => ({ ...asRecord(row), ...projectRow(row, data.projection) }));
    case 'without':
      return evaluateData(source, data.input, query).map((row) => {
        const output = { ...asRecord(row) };
        for (const field of data.fields) {
          delete output[field];
        }
        return output;
      });
    case 'sort':
      return sortRows(evaluateData(source, data.input, query), data.order);
    case 'limit':
      return evaluateData(source, data.input, query).slice(data.offset ?? 0, (data.offset ?? 0) + data.count);
    case 'sortLimit':
      return sortRows(evaluateData(source, data.input, query), data.order).slice(0, data.count);
    case 'rename':
      return evaluateData(source, data.input, query).map((row) => renameRow(row, data.fields));
    case 'qualify':
      return evaluateData(source, data.input, query).map((row) => ({ [data.alias]: row }));
    default:
      return [];
  }
}

function readRows(source: RelationSource, relation: RelationRef): readonly unknown[] {
  const rows = source.rows(relation);
  return Array.isArray(rows) ? rows : [];
}

function projectRow(row: unknown, projection: ProjectionData): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([field, item]) => [
    field,
    exprValue(row, projectionExpr(item))
  ]));
}

function renameRow(row: unknown, fields: Record<string, string>): Record<string, unknown> {
  const output = { ...asRecord(row) };
  for (const [from, to] of Object.entries(fields)) {
    output[to] = output[from];
    delete output[from];
  }
  return output;
}

function matchesPredicate(row: unknown, predicate: PredicateData): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(exprValue(row, predicate.left), exprValue(row, predicate.right));
    case 'neq':
      return !Object.is(exprValue(row, predicate.left), exprValue(row, predicate.right));
    case 'lt':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) < 0;
    case 'lte':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) <= 0;
    case 'gt':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) > 0;
    case 'gte':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => matchesPredicate(row, item));
    case 'or':
      return predicate.predicates.some((item) => matchesPredicate(row, item));
    case 'not':
      return !matchesPredicate(row, predicate.predicate);
  }
}

function exprValue(row: unknown, expr: ExprData): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'field': {
      const aliased = isRecord(row) ? row[expr.alias] : undefined;
      return isRecord(aliased) ? aliased[expr.field] : isRecord(row) ? row[expr.field] : undefined;
    }
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item));
    default:
      return undefined;
  }
}

function sortRows(rows: readonly unknown[], order: readonly SortData[]): readonly unknown[] {
  return [...rows].sort((left, right) => {
    for (const item of order) {
      const compared = compareValues(exprValue(left, item.expr), exprValue(right, item.expr));
      if (compared !== 0) {
        return item.direction === 'desc' ? -compared : compared;
      }
    }
    return 0;
  });
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}

function sourceFor(target: SnapshotMaterializationTarget): RelationSource {
  if (isRelationSource(target)) return target;
  return {
    relationNames: Object.keys(target.data),
    rows: (relation) => target.data[relation.name] ?? []
  };
}

function storeMaterialization<Row>(db: object, entry: StoredMaterialization<Row>): void {
  const store = materializationStore.get(db) ?? new Map<string, StoredMaterialization>();
  storeMaterializationIn(store, entry);
  materializationStore.set(db, store);
}

function storeMaterializationIn<Row>(store: Map<string, StoredMaterialization>, entry: StoredMaterialization<Row>): void {
  store.set(entry.metadata.id, entry);
  store.set(entry.metadata.queryKey, entry);
}

function resolveMaterialization<Row>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>
): StoredMaterialization<Row> | undefined {
  if (!isObject(input)) return undefined;
  const store = materializationStore.get(input);
  if (store === undefined) return undefined;
  if (typeof target === 'string') return store.get(target) as StoredMaterialization<Row> | undefined;
  if (isQuery(target)) return store.get(queryKey(target)) as StoredMaterialization<Row> | undefined;
  return store.get(target.id) as StoredMaterialization<Row> | undefined;
}

function uniqueMaterializations(store: Map<string, StoredMaterialization>): readonly StoredMaterialization[] {
  return Array.from(new Set(store.values()));
}

function materializationDiffOptions<Row>(query: Query<Row>): { readonly keyBy?: readonly string[] } {
  const keyBy = queryRowKeyFields(query);
  return keyBy === undefined ? {} : { keyBy };
}

function groupRowsByField<Row, Value>(rows: readonly Row[], field: string): ReadonlyMap<Value, readonly Row[]> {
  const lookup = new Map<Value, Row[]>();
  for (const row of rows) {
    const key = fieldValue(row, field) as Value;
    lookup.set(key, [...lookup.get(key) ?? [], row]);
  }
  return lookup;
}

function btreeIndex<Row, Value>(rows: readonly Row[], field: string): MaterializationBtreeIndex<Row, Value> {
  const lookup = groupRowsByField<Row, Value>(rows, field);
  const ordered = Array.from(lookup.keys()).sort(compareValues) as Value[];
  return { kind: 'btree', field, lookup: new Map(ordered.map((key) => [key, lookup.get(key) ?? []])), ordered };
}

function uniqueIndexResult<Row, Value>(
  stored: StoredMaterialization<Row>,
  field: string
): MaterializationUniqueIndexResult<Row, Value> {
  const lookup = new Map<Value, Row>();
  const diagnostics: MaterializationDiagnostic[] = [];

  for (const row of stored.rows as readonly Row[]) {
    const key = fieldValue(row, field) as Value;
    if (lookup.has(key)) {
      diagnostics.push({
        code: 'materialization_index_unsupported',
        message: `unique materialization index has duplicate value for ${field}`,
        surface: 'materialization',
        detail: { field, key }
      });
      continue;
    }
    lookup.set(key, row);
  }

  return withTarget(stored, {
    kind: 'materializationUniqueIndex',
    indexed: diagnostics.length === 0,
    diagnostics,
    index: { kind: 'unique', field, lookup }
  });
}

function fieldValue(row: unknown, field: string): unknown {
  return isRecord(row) ? row[field] : undefined;
}

function missingIndexResult<Row, Value>(kind: MaterializationIndexOptions['kind']):
  | MaterializationIndexResult<Row>
  | MaterializationHashIndexResult<Row, Value>
  | MaterializationBtreeIndexResult<Row, Value>
  | MaterializationUniqueIndexResult<Row, Value> {
  const diagnostics = [missingDiagnostic()];
  switch (kind) {
    case 'hash':
      return { kind: 'materializationHashIndex', indexed: false, diagnostics };
    case 'btree':
      return { kind: 'materializationBtreeIndex', indexed: false, diagnostics };
    case 'unique':
      return { kind: 'materializationUniqueIndex', indexed: false, diagnostics };
    default:
      return { kind: 'materializationIndex', indexed: false, diagnostics };
  }
}

function withTarget<Result extends object>(
  stored: StoredMaterialization,
  result: Result
): Result & { readonly id: string; readonly queryKey: string } {
  return {
    ...result,
    id: stored.metadata.id,
    queryKey: stored.metadata.queryKey
  };
}

function targetIdentity(target: SnapshotRefreshTarget): { readonly id?: string; readonly queryKey?: string } {
  if (typeof target === 'string') return { id: target };
  if (isQuery(target)) return { queryKey: queryKey(target) };
  return { id: target.id, queryKey: target.queryKey };
}

function missingDiagnostic(): MissingMaterializationDiagnostic {
  return {
    code: 'materialization_missing',
    message: 'materialization is not attached to this database value',
    surface: 'materialization'
  };
}

function incrementalFallbackDiagnostic(id: string, key: string): IncrementalFallbackMaterializationDiagnostic {
  return {
    code: 'materialization_incremental_fallback',
    message: 'incremental materialization is not available; snapshot recompute will be used',
    surface: 'materialization',
    detail: {
      mode: 'incremental',
      fallback: 'recompute',
      id,
      queryKey: key,
      reason: 'snapshot-first Relic implementation'
    }
  };
}

function emptyMaintenance(): MaterializationMaintenanceResult {
  return {
    kind: 'materializationMaintenance',
    maintained: 0,
    recomputed: 0,
    carried: 0,
    changes: [],
    diagnostics: []
  };
}

function markMaterialized<Db extends object>(db: Db): Db & MaterializedDb {
  materializedDbs.add(db);
  return db as Db & MaterializedDb;
}

function projectionExpr(input: ProjectionData[string]): ExprData {
  return isOptionalProjection(input) ? input.expr : input;
}

function isOptionalProjection(input: ProjectionData[string]): input is OptionalProjection {
  return isRecord(input) && 'kind' in input && input.kind === 'optionalProjection';
}

function isQuery(input: unknown): input is Query {
  return isRecord(input) && 'data' in input && 'relations' in input;
}

function asRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isObject(input: unknown): input is object {
  return typeof input === 'object' && input !== null;
}
