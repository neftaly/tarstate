import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './adapter.js';
import { diffRows, type RowChange, type RowDiffDiagnostic } from './diff.js';
import {
  queryKey,
  queryRowKeyFields,
  relationDependencies,
  type ExprData,
  type NullSortOrder,
  type OptionalProjection,
  type PredicateData,
  type ProjectionData,
  type Query,
  type QueryData,
  type SortData
} from './query.js';
import type { RelationRef } from './schema.js';
import { isRelationSource, type RelationSource } from './source.js';
import {
  attachConstraints,
  isConstraintAttachmentInput,
  type ConstraintAttachmentInput
} from './constraints-attachment.js';
import { stableKey } from './identity.js';
import { equalityJoinPlan, type FieldExpression } from './join-planner.js';
import {
  buildIncrementalMaterialization,
  maintainIncrementalMaterialization,
  planIncrementalMaterialization,
  type IncrementalMaterialization,
  type IncrementalMaterializationPlan
} from './materialization-plan.js';

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
export type MaterializationMaintenanceDecision = 'skipped' | 'carried' | 'recomputed' | 'incremental';

export type MaterializationIndexSpec =
  | { readonly kind: 'set' }
  | { readonly kind: 'hash'; readonly expression: ExprData; readonly field?: string; readonly unique?: boolean }
  | { readonly kind: 'unique'; readonly expression: ExprData; readonly field?: string; readonly unique: true }
  | { readonly kind: 'btree'; readonly expression: ExprData; readonly field?: string };

export type MaterializationOptions = {
  readonly id?: string;
  readonly name?: string;
  readonly mode?: MaterializationMode;
};
export type SnapshotMaterializationOptions = MaterializationOptions;
export type MaterializationQueryBatch<Row = unknown> = Record<string, Query<Row>>;
export type MaterializationMaintenanceOptions = {
  readonly deltas?: readonly RelationDelta[];
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
  readonly maintenanceReason: string;
  readonly dependencies: readonly string[];
  readonly indexSpecs: readonly MaterializationIndexSpec[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly name?: string;
};

export type MaterializationExplanation<Row = unknown> = {
  readonly kind: 'materializationExplanation';
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly requestedMode: MaterializationMode;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly maintenanceReason: string;
  readonly dependencies: readonly string[];
  readonly indexSpecs: readonly MaterializationIndexSpec[];
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

export type MaterializationMaintenanceChangeKind = MaterializationMaintenanceDecision;

export type MaterializationMaintenanceChange<Row = unknown> = {
  readonly kind: 'materializationMaintenanceChange';
  readonly update: MaterializationMaintenanceChangeKind;
  readonly recomputed: boolean;
  readonly reason: string;
  readonly id: string;
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly dependencies: readonly string[];
  readonly touchedDependencies: readonly string[];
  readonly indexSpecs: readonly MaterializationIndexSpec[];
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
  readonly skipped: number;
  readonly changes: readonly MaterializationMaintenanceChange<Row>[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};

export type MaterializationIndex<Row = unknown> = {
  readonly kind: 'set';
  readonly rows: ReadonlySet<Row>;
  readonly raw: ReadonlySet<Row>;
  readonly has: (row: Row) => boolean;
  readonly values: () => IterableIterator<Row>;
};

export type MaterializationNestedRows<Row = unknown> =
  | ReadonlySet<Row>
  | ReadonlyMap<unknown, MaterializationNestedRows<Row>>;

export type MaterializationNestedUniqueRows<Row = unknown> =
  | Row
  | ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>>;

export type MaterializationSetLike<Row = unknown> = {
  readonly size: number;
  readonly has: (row: Row) => boolean;
  readonly values: () => IterableIterator<Row>;
  readonly keys: () => IterableIterator<Row>;
  readonly entries: () => IterableIterator<[Row, Row]>;
  readonly forEach: (
    callbackfn: (value: Row, key: Row, set: ReadonlySet<Row>) => void,
    thisArg?: unknown
  ) => void;
  readonly [Symbol.iterator]: () => IterableIterator<Row>;
};

export type MaterializationMapLike<Key = unknown, Value = unknown> = {
  readonly size: number;
  readonly get: (key: Key) => Value | undefined;
  readonly has: (key: Key) => boolean;
  readonly keys: () => IterableIterator<Key>;
  readonly values: () => IterableIterator<Value>;
  readonly entries: () => IterableIterator<[Key, Value]>;
  readonly forEach: (
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown
  ) => void;
  readonly [Symbol.iterator]: () => IterableIterator<[Key, Value]>;
};

export type MaterializationHashIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'hash';
  readonly field?: string;
  readonly fields: readonly string[];
  readonly lookup: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly raw: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly get: (value: Value) => readonly Row[];
  readonly rowsFor: (...values: readonly unknown[]) => readonly Row[];
  readonly has: (value: Value) => boolean;
};

export type MaterializationRangeBound<Value = unknown> =
  | Value
  | {
      readonly value: Value;
      readonly inclusive?: boolean;
    };

export type MaterializationRange<Value = unknown> = {
  readonly lower?: MaterializationRangeBound<Value>;
  readonly upper?: MaterializationRangeBound<Value>;
};

export type MaterializationBtreeIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'btree';
  readonly field?: string;
  readonly fields: readonly string[];
  readonly lookup: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly raw: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly ordered: readonly Value[];
  readonly get: (value: Value) => readonly Row[];
  readonly rowsFor: (...values: readonly unknown[]) => readonly Row[];
  readonly has: (value: Value) => boolean;
  readonly range: (bounds?: MaterializationRange<Value>) => readonly Row[];
};

export type MaterializationUniqueIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'unique';
  readonly field?: string;
  readonly fields: readonly string[];
  readonly lookup: ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>>;
  readonly raw: ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>>;
  readonly get: (value: Value) => Row | undefined;
  readonly rowFor: (...values: readonly unknown[]) => Row | undefined;
  readonly has: (value: Value) => boolean;
};

export type MaterializationIndexResult<Row = unknown> = MaterializationSetLike<Row> & {
  readonly kind: 'materializationIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly rows: ReadonlySet<Row>;
  readonly raw: ReadonlySet<Row>;
  readonly index?: MaterializationIndex<Row>;
};

export type MaterializationHashIndexResult<Row = unknown, Value = unknown> =
  MaterializationMapLike<Value, MaterializationNestedRows<Row>> & {
  readonly kind: 'materializationHashIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly field?: string;
  readonly fields: readonly string[];
  readonly lookup: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly raw: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly index?: MaterializationHashIndex<Row, Value>;
};

export type MaterializationBtreeIndexResult<Row = unknown, Value = unknown> =
  MaterializationMapLike<Value, MaterializationNestedRows<Row>> & {
  readonly kind: 'materializationBtreeIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly field?: string;
  readonly fields: readonly string[];
  readonly lookup: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly raw: ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  readonly ordered: readonly Value[];
  readonly range: (bounds?: MaterializationRange<Value>) => readonly Row[];
  readonly index?: MaterializationBtreeIndex<Row, Value>;
};

export type MaterializationUniqueIndexResult<Row = unknown, Value = unknown> =
  MaterializationMapLike<Value, MaterializationNestedUniqueRows<Row>> & {
  readonly kind: 'materializationUniqueIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly field?: string;
  readonly fields: readonly string[];
  readonly lookup: ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>>;
  readonly raw: ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>>;
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

type MaterializationIndexFieldOptions<Field extends string = string> =
  | { readonly field: Field; readonly fields?: never }
  | { readonly field?: never; readonly fields: readonly [Field, ...Field[]] };

export type MaterializationIndexOptions<Field extends string = string> =
  | { readonly kind?: 'set' }
  | ({ readonly kind: 'hash' } & MaterializationIndexFieldOptions<Field>)
  | ({ readonly kind: 'btree' } & MaterializationIndexFieldOptions<Field>)
  | ({ readonly kind: 'unique' } & MaterializationIndexFieldOptions<Field>);

type StoredMaterialization<Row = unknown> = {
  readonly metadata: MaterializationMetadata<Row>;
  readonly rows: readonly Row[];
  readonly incremental?: IncrementalMaterialization<Row>;
};
type MaterializationEvalTarget = {
  readonly source: RelationSource;
  readonly query: Query;
  readonly env: Readonly<Record<string, unknown>>;
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
export function mat<Db extends SnapshotMaterializationTarget>(
  db: Db,
  queries: MaterializationQueryBatch,
  options?: SnapshotMaterializationOptions
): Db & MaterializedDb;
export function mat<Db extends object, Row>(
  db: Db,
  queryOrConstraints: Query<Row> | MaterializationQueryBatch | ConstraintAttachmentInput,
  options: SnapshotMaterializationOptions = {}
): Db {
  if (isConstraintAttachmentInput(queryOrConstraints)) {
    return attachConstraints(db, queryOrConstraints);
  }

  if (isQuery(queryOrConstraints)) {
    return materializeDbSnapshot(db as Db & SnapshotMaterializationTarget, queryOrConstraints, options);
  }

  if (isQueryBatch(queryOrConstraints)) {
    return materializeDbSnapshots(db as Db & SnapshotMaterializationTarget, queryOrConstraints, options);
  }

  return attachConstraints(db, queryOrConstraints as ConstraintAttachmentInput);
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
  const planned = requestedMode === 'incremental' ? planIncrementalMaterialization(query) : undefined;
  const maintenance = planned?.supported === true ? 'incremental' : 'snapshot';
  const id = options.id ?? options.name ?? key;
  return {
    kind: 'materializationExplanation',
    queryKey: key,
    query,
    requestedMode,
    maintenance,
    maintenanceReason: planned === undefined
      ? maintenanceReasonForMode(requestedMode)
      : planned.reason,
    dependencies: relationDependencies(query),
    indexSpecs: materializationIndexSpecs(query),
    diagnostics: planned?.supported === false
      ? [incrementalFallbackDiagnostic(id, key, planned.reason)]
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

  const refreshed = recomputeMaterializationEntry(db, stored);
  storeMaterialization(db, refreshed);
  return {
    kind: 'materializationRefresh',
    id: stored.metadata.id,
    queryKey: stored.metadata.queryKey,
    refreshed: true,
    rows: refreshed.rows,
    diagnostics: []
  };
}

export function maintainMaterializationSnapshots<Next extends SnapshotMaterializationTarget>(
  previous: SnapshotMaterializationTarget,
  next: Next,
  options: MaterializationMaintenanceOptions = {}
): Promise<Next & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult }> {
  maintainMaterializations(previous, next, options);
  return Promise.resolve(markMaterialized(next) as Next & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult });
}

export function maintainMaterializations<Next extends SnapshotMaterializationTarget>(
  previous: SnapshotMaterializationTarget,
  next: Next,
  options: MaterializationMaintenanceOptions = {}
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
  const touchedRelations = options.deltas === undefined ? undefined : new Set(options.deltas.map((delta) => delta.relation.name));

  for (const stored of uniqueMaterializations(previousStore)) {
    const touchedDependencies = touchedRelations === undefined
      ? stored.metadata.dependencies
      : stored.metadata.dependencies.filter((dependency) => touchedRelations.has(dependency));

    if (touchedRelations !== undefined && touchedDependencies.length === 0) {
      const change: MaterializationMaintenanceChange = {
        kind: 'materializationMaintenanceChange',
        update: 'skipped',
        recomputed: false,
        reason: 'dependencies untouched by transaction',
        id: stored.metadata.id,
        queryKey: stored.metadata.queryKey,
        query: stored.metadata.query,
        maintenance: stored.metadata.maintenance,
        dependencies: stored.metadata.dependencies,
        touchedDependencies,
        indexSpecs: stored.metadata.indexSpecs,
        previousRowsAvailable: true,
        previousRows: stored.rows,
        rows: stored.rows,
        addedRows: [],
        removedRows: [],
        rowChanges: [],
        diagnostics: []
      };
      changes.push(change);
      storeMaterializationIn(nextStore, stored);
      continue;
    }

    const incrementalFallbackDiagnostics: MaterializationDiagnostic[] = [];
    if (stored.metadata.maintenance === 'incremental') {
      if (options.deltas === undefined) {
        incrementalFallbackDiagnostics.push(incrementalFallbackDiagnostic(
          stored.metadata.id,
          stored.metadata.queryKey,
          'transaction deltas are required for incremental maintenance'
        ));
      } else if (stored.incremental === undefined) {
        incrementalFallbackDiagnostics.push(incrementalFallbackDiagnostic(
          stored.metadata.id,
          stored.metadata.queryKey,
          'incremental materialization state is missing'
        ));
      } else {
        const rootRelation = stored.metadata.query.relations[stored.incremental.plan.rootRelation];
        if (rootRelation === undefined) {
          incrementalFallbackDiagnostics.push(incrementalFallbackDiagnostic(
            stored.metadata.id,
            stored.metadata.queryKey,
            `relation ${stored.incremental.plan.rootRelation} is not available for incremental maintenance`
          ));
        } else {
          const maintained = maintainIncrementalMaterialization(
            stored.incremental,
            rootRelation,
            options.deltas,
            envFor(next)
          );
          if (maintained.updated) {
            const diff = diffRows(stored.rows, maintained.rows, materializationDiffOptions(stored.metadata.query));
            const change: MaterializationMaintenanceChange = {
              kind: 'materializationMaintenanceChange',
              update: 'incremental',
              recomputed: false,
              reason: diff.changes.length === 0
                ? 'dependencies touched; incrementally maintained rows unchanged'
                : maintained.reason,
              id: stored.metadata.id,
              queryKey: stored.metadata.queryKey,
              query: stored.metadata.query,
              maintenance: stored.metadata.maintenance,
              dependencies: stored.metadata.dependencies,
              touchedDependencies,
              indexSpecs: stored.metadata.indexSpecs,
              previousRowsAvailable: true,
              previousRows: stored.rows,
              rows: maintained.rows,
              addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
              removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
              rowChanges: diff.changes,
              diagnostics: diff.diagnostics
            };
            changes.push(change);
            storeMaterializationIn(nextStore, {
              metadata: stored.metadata,
              rows: maintained.rows,
              incremental: {
                plan: stored.incremental.plan,
                state: maintained.state
              }
            });
            continue;
          }

          incrementalFallbackDiagnostics.push(incrementalFallbackDiagnostic(
            stored.metadata.id,
            stored.metadata.queryKey,
            maintained.reason
          ));
        }
      }
    }

    const entry = recomputeMaterializationEntry(next, stored);
    const diff = diffRows(stored.rows, entry.rows, materializationDiffOptions(stored.metadata.query));
    const change: MaterializationMaintenanceChange = {
      kind: 'materializationMaintenanceChange',
      update: diff.changes.length === 0 ? 'carried' : 'recomputed',
      recomputed: true,
      reason: diff.changes.length === 0
        ? 'dependencies touched; recomputed rows unchanged'
        : 'dependencies touched; recomputed rows changed',
      id: stored.metadata.id,
      queryKey: stored.metadata.queryKey,
      query: stored.metadata.query,
      maintenance: stored.metadata.maintenance,
      dependencies: stored.metadata.dependencies,
      touchedDependencies,
      indexSpecs: stored.metadata.indexSpecs,
      previousRowsAvailable: true,
      previousRows: stored.rows,
      rows: entry.rows,
      addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
      removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
      rowChanges: diff.changes,
      diagnostics: [...incrementalFallbackDiagnostics, ...diff.diagnostics]
    };
    changes.push(change);
    storeMaterializationIn(nextStore, entry);
  }

  materializationStore.set(next, nextStore);
  materializedDbs.add(next);

  return {
    kind: 'materializationMaintenance',
    maintained: changes.length,
    recomputed: changes.filter((change) => change.recomputed).length,
    carried: changes.filter((change) => change.update === 'carried').length,
    skipped: changes.filter((change) => change.update === 'skipped').length,
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
  options: { readonly kind: 'hash'; readonly field: string } | { readonly kind: 'hash'; readonly fields: readonly [string, ...string[]] }
): MaterializationHashIndexResult<Row, Value>;
export function index<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: { readonly kind: 'btree'; readonly field: string } | { readonly kind: 'btree'; readonly fields: readonly [string, ...string[]] }
): MaterializationBtreeIndexResult<Row, Value>;
export function index<Row = unknown, Value = unknown>(
  input: unknown,
  target: string | Query<Row> | MaterializationMetadata<Row>,
  options: { readonly kind: 'unique'; readonly field: string } | { readonly kind: 'unique'; readonly fields: readonly [string, ...string[]] }
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
      return hashIndexResult<Row, Value>(stored, indexFields(options));
    case 'btree':
      return btreeIndexResult<Row, Value>(stored, indexFields(options));
    case 'unique':
      return uniqueIndexResult<Row, Value>(stored, indexFields(options));
    default:
      return setIndexResult(stored);
  }
}

function setIndexResult<Row>(stored: StoredMaterialization<Row>): MaterializationIndexResult<Row> {
  const rows = new Set(stored.rows as readonly Row[]);
  return withSetLike(rows, withTarget(stored, {
    kind: 'materializationIndex',
    indexed: true,
    diagnostics: [],
    rows,
    raw: rows,
    index: setIndex(rows)
  }));
}

function hashIndexResult<Row, Value>(
  stored: StoredMaterialization<Row>,
  fields: readonly string[]
): MaterializationHashIndexResult<Row, Value> {
  const lookup = groupRowsByFields<Row, Value>(stored.rows as readonly Row[], fields);
  const facade = hashIndex<Row, Value>(lookup, fields);
  return withMapLike(lookup, withTarget(stored, {
        kind: 'materializationHashIndex',
        indexed: true,
        diagnostics: [],
        ...indexFieldShape(fields),
        fields,
        lookup,
        raw: lookup,
        index: facade
      }));
}

function btreeIndexResult<Row, Value>(
  stored: StoredMaterialization<Row>,
  fields: readonly string[]
): MaterializationBtreeIndexResult<Row, Value> {
  const lookup = sortNestedLookup(groupRowsByFields<Row, Value>(stored.rows as readonly Row[], fields)) as ReadonlyMap<Value, MaterializationNestedRows<Row>>;
  const facade = btreeIndex<Row, Value>(lookup, fields);
  return withMapLike(lookup, withTarget(stored, {
    kind: 'materializationBtreeIndex',
    indexed: true,
    diagnostics: [],
    ...indexFieldShape(fields),
    fields,
    lookup,
    raw: lookup,
    ordered: facade.ordered,
    range: facade.range,
    index: facade
  }));
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
  const id = options.id ?? options.name ?? key;
  const planned = requestedMode === 'incremental' ? planIncrementalMaterialization(query) : undefined;
  const maintenance = planned?.supported === true ? 'incremental' : 'snapshot';
  const metadata: MaterializationMetadata<Row> = {
    kind: 'materialization',
    id,
    queryKey: key,
    query,
    requestedMode,
    maintenance,
    maintenanceReason: planned === undefined
      ? maintenanceReasonForMode(requestedMode)
      : planned.reason,
    dependencies: relationDependencies(query),
    indexSpecs: materializationIndexSpecs(query),
    diagnostics: planned?.supported === false
      ? [incrementalFallbackDiagnostic(id, key, planned.reason)]
      : [],
    ...(options.name === undefined ? {} : { name: options.name })
  };
  storeMaterialization(db, materializationEntryFor(db, metadata, planned?.supported === true ? planned.plan : undefined));
  return markMaterialized(db);
}

function materializeDbSnapshots<Db extends SnapshotMaterializationTarget>(
  db: Db,
  queries: MaterializationQueryBatch,
  options: SnapshotMaterializationOptions
): Db & MaterializedDb {
  for (const [name, query] of Object.entries(queries)) {
    materializeDbSnapshot(db, query, materializationOptionsForBatchItem(name, options));
  }
  return markMaterialized(db);
}

function materializationOptionsForBatchItem(
  name: string,
  options: SnapshotMaterializationOptions
): SnapshotMaterializationOptions {
  const baseId = options.id ?? options.name;
  return {
    ...options,
    id: baseId === undefined ? name : `${baseId}:${name}`,
    name: baseId === undefined ? name : `${baseId}:${name}`
  };
}

function materializationEntryFor<Row>(
  target: SnapshotMaterializationTarget,
  metadata: MaterializationMetadata<Row>,
  plan?: IncrementalMaterializationPlan
): StoredMaterialization<Row> {
  if (plan !== undefined) {
    const relation = metadata.query.relations[plan.rootRelation];
    if (relation !== undefined) {
      const built = buildIncrementalMaterialization<Row>(
        plan,
        relation,
        readRows(sourceFor(target), relation),
        envFor(target)
      );
      if (!built.supported) {
        return {
          metadata: metadataWithIncrementalFallback(metadata, built.reason),
          rows: evaluateTargetRows(target, metadata.query)
        };
      }

      return {
        metadata,
        rows: built.rows,
        incremental: {
          plan: built.plan,
          state: built.state
        }
      };
    }
  }

  return { metadata, rows: evaluateTargetRows(target, metadata.query) };
}

function metadataWithIncrementalFallback<Row>(
  metadata: MaterializationMetadata<Row>,
  reason: string
): MaterializationMetadata<Row> {
  if (metadata.requestedMode !== 'incremental') {
    return metadata;
  }

  return {
    ...metadata,
    maintenance: 'snapshot',
    maintenanceReason: reason,
    diagnostics: [
      ...metadata.diagnostics,
      incrementalFallbackDiagnostic(metadata.id, metadata.queryKey, reason)
    ]
  };
}

function recomputeMaterializationEntry<Row>(
  target: SnapshotMaterializationTarget,
  stored: StoredMaterialization<Row>
): StoredMaterialization<Row> {
  return materializationEntryFor(target, stored.metadata, stored.incremental?.plan);
}

function evaluateTargetRows<Row>(target: SnapshotMaterializationTarget, query: Query<Row>): readonly Row[] {
  return evaluateData({ source: sourceFor(target), query, env: envFor(target) }, query.data) as readonly Row[];
}

function evaluateData(target: MaterializationEvalTarget, data: QueryData, outerRow: Record<string, unknown> = {}): readonly unknown[] {
  switch (data.op) {
    case 'from': {
      const relation = target.query.relations[data.relation];
      return relation === undefined ? [] : readRows(target.source, relation).map((row) => ({ ...outerRow, [data.alias]: row }));
    }
    case 'lookup': {
      const relation = target.query.relations[data.relation];
      if (relation === undefined) return [];
      const value = exprValue(outerRow, data.value, target);
      return readRows(target.source, relation)
        .filter((row) => isRecord(row) && Object.is(row[data.field], value))
        .map((row) => ({ ...outerRow, [data.alias]: row }));
    }
    case 'constRows':
      return data.rows.map((row) => ({ ...outerRow, ...row }));
    case 'where':
      return evaluateData(target, data.input, outerRow).filter((row) => matchesPredicate(row, data.predicate, target));
    case 'hash':
    case 'btree':
    case 'keyBy':
      return evaluateData(target, data.input, outerRow);
    case 'join':
      return joinRows(target, data.kind, data.left, data.right, data.on, outerRow);
    case 'select':
      return evaluateData(target, data.input, outerRow).map((row) => projectRow(row, data.projection, target));
    case 'extend':
      return evaluateData(target, data.input, outerRow).map((row) => ({ ...asRecord(row), ...projectRow(row, data.projection, target) }));
    case 'expand':
      return expandRows(target, data.input, data.collection, data.alias, data.fields, outerRow);
    case 'without':
      return evaluateData(target, data.input, outerRow).map((row) => {
        const output = { ...asRecord(row) };
        for (const field of data.fields) {
          delete output[field];
        }
        return output;
      });
    case 'sort':
      return sortRows(evaluateData(target, data.input, outerRow), data.order, target);
    case 'limit':
      return evaluateData(target, data.input, outerRow).slice(data.offset ?? 0, (data.offset ?? 0) + data.count);
    case 'sortLimit':
      return sortRows(evaluateData(target, data.input, outerRow), data.order, target).slice(0, data.count);
    case 'union':
      return setUnion(data.inputs.map((input) => evaluateData(target, input, outerRow)));
    case 'intersection':
      return setIntersection(data.inputs.map((input) => evaluateData(target, input, outerRow)));
    case 'difference':
      return setDifference(evaluateData(target, data.left, outerRow), evaluateData(target, data.right, outerRow));
    case 'rename':
      return evaluateData(target, data.input, outerRow).map((row) => renameRow(row, data.fields));
    case 'qualify':
      return evaluateData(target, data.input, outerRow).map((row) => ({ [data.alias]: row }));
    case 'aggregate':
      return aggregateRows(
        evaluateData(target, data.input, outerRow),
        data.groupBy,
        data.aggregates,
        target
      );
  }
}

function readRows(source: RelationSource, relation: RelationRef): readonly unknown[] {
  const rows = source.rows(relation);
  return Array.isArray(rows) ? rows : [];
}

function projectRow(
  row: unknown,
  projection: ProjectionData,
  target: MaterializationEvalTarget
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([field, item]) => [
    field,
    exprValue(row, projectionExpr(item), target)
  ]));
}

function joinRows(
  target: MaterializationEvalTarget,
  kind: 'inner' | 'left',
  leftData: QueryData,
  rightData: QueryData,
  on: PredicateData,
  outerRow: Record<string, unknown>
): readonly unknown[] {
  const left = evaluateData(target, leftData, outerRow);
  const right = evaluateData(target, rightData, outerRow);
  const indexed = equalityJoinRows(target, kind, left, right, on);
  if (indexed !== undefined) {
    return indexed;
  }

  const output: unknown[] = [];

  for (const leftRow of left) {
    let matched = false;

    for (const rightRow of right) {
      const merged = { ...asRecord(leftRow), ...asRecord(rightRow) };
      if (matchesPredicate(merged, on, target)) {
        matched = true;
        output.push(merged);
      }
    }

    if (!matched && kind === 'left') {
      output.push(leftRow);
    }
  }

  return output;
}

function equalityJoinRows(
  target: MaterializationEvalTarget,
  kind: 'inner' | 'left',
  left: readonly unknown[],
  right: readonly unknown[],
  on: PredicateData
): readonly unknown[] | undefined {
  const equality = equalityJoinPlan(on, (expr) => expressionSide(expr, left, right));
  if (equality === undefined) {
    return undefined;
  }

  if (right.length === 0) {
    return kind === 'left' ? left : [];
  }

  const rightIndex = new Map<unknown, { readonly row: unknown; readonly value: unknown }[]>();
  for (const rightRow of right) {
    const value = exprValue(rightRow, equality.right, target);
    const rows = rightIndex.get(value);
    if (rows === undefined) {
      rightIndex.set(value, [{ row: rightRow, value }]);
    } else {
      rows.push({ row: rightRow, value });
    }
  }

  const output: unknown[] = [];
  for (const leftRow of left) {
    const leftValue = exprValue(leftRow, equality.left, target);
    const candidates = rightIndex.get(leftValue) ?? [];
    let matched = false;

    for (const candidate of candidates) {
      if (!Object.is(leftValue, candidate.value)) {
        continue;
      }

      const merged = { ...asRecord(leftRow), ...asRecord(candidate.row) };
      if (!equality.needsPredicateCheck || matchesPredicate(merged, on, target)) {
        matched = true;
        output.push(merged);
      }
    }

    if (!matched && kind === 'left') {
      output.push(leftRow);
    }
  }

  return output;
}

function expressionSide(
  expr: FieldExpression,
  left: readonly unknown[],
  right: readonly unknown[]
): 'left' | 'right' | undefined {
  const inLeft = rowsHaveField(left, expr);
  const inRight = rowsHaveField(right, expr);

  if (inLeft === inRight) {
    return undefined;
  }

  return inLeft ? 'left' : 'right';
}

function rowsHaveField(rows: readonly unknown[], expr: FieldExpression): boolean {
  return rows.some((row) => {
    const record = asRecord(row);
    return Object.hasOwn(record, expr.alias) || Object.hasOwn(record, expr.field);
  });
}

function expandRows(
  target: MaterializationEvalTarget,
  inputData: QueryData,
  collection: ExprData,
  alias: string | undefined,
  fields: readonly string[] | undefined,
  outerRow: Record<string, unknown>
): readonly unknown[] {
  const output: unknown[] = [];

  for (const row of evaluateData(target, inputData, outerRow)) {
    const value = exprValue(row, collection, target);
    if (value === null || value === undefined || !isIterable(value)) {
      continue;
    }

    for (const item of value) {
      if (alias !== undefined) {
        output.push({ ...asRecord(row), [alias]: item });
      } else if (isRecord(item)) {
        output.push({ ...asRecord(row), ...pickFields(item, fields) });
      }
    }
  }

  return output;
}

function renameRow(row: unknown, fields: Record<string, string>): Record<string, unknown> {
  const output = { ...asRecord(row) };
  for (const [from, to] of Object.entries(fields)) {
    output[to] = output[from];
    delete output[from];
  }
  return output;
}

function aggregateRows(
  rows: readonly unknown[],
  groupBy: ProjectionData,
  aggregates: ProjectionData,
  target: MaterializationEvalTarget
): readonly unknown[] {
  const groups = new Map<string, { readonly group: Record<string, unknown>; readonly rows: unknown[] }>();

  for (const row of rows) {
    const group = projectRow(row, groupBy, target);
    const key = stableKey(group);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { group, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  if (groups.size === 0 && Object.keys(groupBy).length === 0) {
    groups.set(stableKey({}), { group: {}, rows: [] });
  }

  return Array.from(groups.values()).map(({ group, rows: groupRows }) => {
    const output: Record<string, unknown> = { ...group };
    for (const [name, item] of Object.entries(aggregates)) {
      output[name] = evaluateAggregate(projectionExpr(item), groupRows, target);
    }
    return output;
  });
}

function evaluateAggregate(
  expr: ExprData,
  rows: readonly unknown[],
  target: MaterializationEvalTarget
): unknown {
  if (expr.op !== 'aggregateCall') {
    return exprValue(rows[0] ?? {}, expr, target);
  }

  const values = expr.expr === undefined
    ? rows
    : rows.map((row) => exprValue(row, expr.expr as ExprData, target));
  const aggregateValues = expr.distinct ? distinctValues(values) : values;

  switch (expr.name) {
    case 'count':
      return expr.expr === undefined
        ? rows.length
        : aggregateValues.filter((value) => value !== null && value !== undefined).length;
    case 'sum':
      return aggregateValues.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
    case 'avg': {
      const numbers = aggregateValues.filter((value): value is number => typeof value === 'number');
      return numbers.length === 0 ? undefined : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    case 'min':
      return orderedValues(aggregateValues).at(0);
    case 'max':
      return orderedValues(aggregateValues).at(-1);
    case 'any':
      return aggregateValues.some(Boolean);
    case 'notAny':
      return !aggregateValues.some(Boolean);
    case 'setConcat':
      return new Set(aggregateValues.flatMap((value) => {
        if (value instanceof Set) return Array.from(value);
        if (Array.isArray(value)) return value;
        return [value];
      }));
    case 'top':
      return [...orderedValues(aggregateValues)].reverse().slice(0, expr.count ?? 0);
    case 'bottom':
      return orderedValues(aggregateValues).slice(0, expr.count ?? 0);
    case 'topBy':
      return rowsByAggregate(rows, expr.expr, target, 'desc').slice(0, expr.count ?? 0);
    case 'bottomBy':
      return rowsByAggregate(rows, expr.expr, target, 'asc').slice(0, expr.count ?? 0);
  }
}

function rowsByAggregate(
  rows: readonly unknown[],
  expr: ExprData | undefined,
  target: MaterializationEvalTarget,
  direction: 'asc' | 'desc'
): readonly unknown[] {
  if (expr === undefined) {
    return rows;
  }

  return rows.map((row) => ({ row, value: exprValue(row, expr, target) }))
    .sort((left, right) => compareSortValues(left.value, right.value, direction, 'last'))
    .map((item) => item.row);
}

function distinctValues(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];

  for (const value of values) {
    const key = stableKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }

  return output;
}

function orderedValues(values: readonly unknown[]): readonly unknown[] {
  return [...values]
    .filter((value) => value !== null && value !== undefined)
    .sort(compareValues);
}

function setUnion(inputs: readonly (readonly unknown[])[]): readonly unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];

  for (const rows of inputs) {
    for (const row of rows) {
      const key = stableKey(row);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(row);
      }
    }
  }

  return output;
}

function setIntersection(inputs: readonly (readonly unknown[])[]): readonly unknown[] {
  const [first = [], ...rest] = inputs;
  return first.filter((row) => rest.every((rows) => rows.some((candidate) => stableKey(candidate) === stableKey(row))));
}

function setDifference(left: readonly unknown[], right: readonly unknown[]): readonly unknown[] {
  const rightKeys = new Set(right.map((row) => stableKey(row)));
  return left.filter((row) => !rightKeys.has(stableKey(row)));
}

function matchesPredicate(
  row: unknown,
  predicate: PredicateData,
  target: MaterializationEvalTarget
): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(exprValue(row, predicate.left, target), exprValue(row, predicate.right, target));
    case 'neq':
      return !Object.is(exprValue(row, predicate.left, target), exprValue(row, predicate.right, target));
    case 'lt':
      return compareValues(exprValue(row, predicate.left, target), exprValue(row, predicate.right, target)) < 0;
    case 'lte':
      return compareValues(exprValue(row, predicate.left, target), exprValue(row, predicate.right, target)) <= 0;
    case 'gt':
      return compareValues(exprValue(row, predicate.left, target), exprValue(row, predicate.right, target)) > 0;
    case 'gte':
      return compareValues(exprValue(row, predicate.left, target), exprValue(row, predicate.right, target)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => matchesPredicate(row, item, target));
    case 'or':
      return predicate.predicates.some((item) => matchesPredicate(row, item, target));
    case 'not':
      return !matchesPredicate(row, predicate.predicate, target);
  }
}

function exprValue(row: unknown, expr: ExprData, target: MaterializationEvalTarget): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'env':
      return target.env[expr.name];
    case 'call':
      return undefined;
    case 'hostCall': {
      if (expr.fn === undefined) {
        return undefined;
      }
      try {
        return expr.fn(...expr.args.map((arg) => exprValue(row, arg, target)));
      } catch {
        return undefined;
      }
    }
    case 'field': {
      const aliased = isRecord(row) ? row[expr.alias] : undefined;
      return isRecord(aliased) ? aliased[expr.field] : isRecord(row) ? row[expr.field] : undefined;
    }
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item, target));
    case 'aggregateCall':
      return evaluateAggregate(expr, [row], target);
    case 'subquery': {
      const rows = evaluateData(target, expr.query, asRecord(row));
      return expr.mode === 'one' ? rows.at(0) : rows;
    }
    default:
      return undefined;
  }
}

function sortRows(
  rows: readonly unknown[],
  order: readonly SortData[],
  target: MaterializationEvalTarget
): readonly unknown[] {
  return [...rows].sort((left, right) => {
    for (const item of order) {
      const compared = compareValues(exprValue(left, item.expr, target), exprValue(right, item.expr, target));
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

function compareSortValues(
  left: unknown,
  right: unknown,
  direction: 'asc' | 'desc',
  nulls: NullSortOrder | undefined
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    const nullOrder = nulls ?? 'last';
    return leftNull === (nullOrder === 'first') ? -1 : 1;
  }

  const comparison = compareValues(left, right);
  return direction === 'asc' ? comparison : -comparison;
}

function sourceFor(target: SnapshotMaterializationTarget): RelationSource {
  if (isRelationSource(target)) return target;
  return {
    relationNames: Object.keys(target.data),
    rows: (relation) => target.data[relation.name] ?? []
  };
}

function envFor(target: SnapshotMaterializationTarget): Readonly<Record<string, unknown>> {
  const candidate = target as { readonly env?: unknown };
  return isRecord(candidate.env) ? candidate.env : {};
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

function maintenanceReasonForMode(mode: MaterializationMode): string {
  return mode === 'incremental'
    ? 'incremental maintenance requested'
    : 'snapshot maintenance with dependency-aware invalidation';
}

function materializationIndexSpecs(query: Query): readonly MaterializationIndexSpec[] {
  const specs: MaterializationIndexSpec[] = [{ kind: 'set' }];
  collectIndexSpecs(query.data, specs);
  return specs;
}

function collectIndexSpecs(data: QueryData, specs: MaterializationIndexSpec[]): void {
  switch (data.op) {
    case 'hash':
      collectIndexSpecs(data.input, specs);
      for (const expression of data.expressions) {
        specs.push({
          kind: data.unique === true ? 'unique' : 'hash',
          expression,
          ...indexFieldForExpression(expression),
          ...(data.unique === true ? { unique: true } : {})
        });
      }
      return;
    case 'btree':
      collectIndexSpecs(data.input, specs);
      for (const expression of data.expressions) {
        specs.push({ kind: 'btree', expression, ...indexFieldForExpression(expression) });
      }
      return;
    case 'where':
    case 'keyBy':
    case 'select':
    case 'extend':
    case 'expand':
    case 'without':
    case 'sort':
    case 'limit':
    case 'sortLimit':
    case 'rename':
    case 'qualify':
    case 'aggregate':
      collectIndexSpecs(data.input, specs);
      return;
    case 'join':
      collectIndexSpecs(data.left, specs);
      collectIndexSpecs(data.right, specs);
      return;
    case 'union':
    case 'intersection':
      for (const input of data.inputs) {
        collectIndexSpecs(input, specs);
      }
      return;
    case 'difference':
      collectIndexSpecs(data.left, specs);
      collectIndexSpecs(data.right, specs);
      return;
    case 'from':
    case 'lookup':
    case 'constRows':
      return;
  }
}

function indexFieldForExpression(expression: ExprData): { readonly field?: string } {
  return expression.op === 'field' ? { field: expression.field } : {};
}

function indexFields(options: MaterializationIndexOptions): readonly string[] {
  if ('fields' in options && options.fields !== undefined) {
    return options.fields;
  }
  if ('field' in options && options.field !== undefined) {
    return [options.field];
  }
  return [];
}

function indexFieldShape(fields: readonly string[]): { readonly field?: string } {
  const field = fields[0];
  return fields.length === 1 && field !== undefined ? { field } : {};
}

function groupRowsByFields<Row, Value>(
  rows: readonly Row[],
  fields: readonly string[]
): ReadonlyMap<Value, MaterializationNestedRows<Row>> {
  const lookup = new Map<unknown, MaterializationNestedRows<Row>>();
  for (const row of rows) {
    addRowToNestedLookup(lookup, fields, row);
  }
  return lookup as ReadonlyMap<Value, MaterializationNestedRows<Row>>;
}

function addRowToNestedLookup<Row>(
  lookup: Map<unknown, MaterializationNestedRows<Row>>,
  fields: readonly string[],
  row: Row
): void {
  if (fields.length === 0) {
    return;
  }

  let cursor = lookup;
  for (let index = 0; index < fields.length; index += 1) {
    const key = fieldValue(row, fields[index] as string);
    if (index === fields.length - 1) {
      const existing = cursor.get(key);
      const rows = existing instanceof Set ? existing : new Set<Row>();
      rows.add(row);
      cursor.set(key, rows);
      return;
    }

    const existing = cursor.get(key);
    const next = existing instanceof Map ? existing : new Map<unknown, MaterializationNestedRows<Row>>();
    cursor.set(key, next);
    cursor = next;
  }
}

function groupUniqueRowsByFields<Row, Value>(
  rows: readonly Row[],
  fields: readonly string[],
  diagnostics: MaterializationDiagnostic[]
): ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>> {
  const lookup = new Map<unknown, MaterializationNestedUniqueRows<Row>>();
  for (const row of rows) {
    addRowToNestedUniqueLookup(lookup, fields, row, diagnostics);
  }
  return lookup as ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>>;
}

function addRowToNestedUniqueLookup<Row>(
  lookup: Map<unknown, MaterializationNestedUniqueRows<Row>>,
  fields: readonly string[],
  row: Row,
  diagnostics: MaterializationDiagnostic[]
): void {
  if (fields.length === 0) {
    return;
  }

  let cursor = lookup;
  for (let index = 0; index < fields.length; index += 1) {
    const key = fieldValue(row, fields[index] as string);
    if (index === fields.length - 1) {
      if (cursor.has(key)) {
        diagnostics.push({
          code: 'materialization_index_unsupported',
          message: `unique materialization index has duplicate value for ${fields.join(',')}`,
          surface: 'materialization',
          detail: { fields, key }
        });
        return;
      }
      cursor.set(key, row);
      return;
    }

    const existing = cursor.get(key);
    const next = existing instanceof Map ? existing : new Map<unknown, MaterializationNestedUniqueRows<Row>>();
    cursor.set(key, next);
    cursor = next;
  }
}

function setIndex<Row>(rows: ReadonlySet<Row>): MaterializationIndex<Row> {
  return {
    kind: 'set',
    rows,
    raw: rows,
    has: (row) => rows.has(row),
    values: () => rows.values()
  };
}

function hashIndex<Row, Value>(
  lookup: ReadonlyMap<Value, MaterializationNestedRows<Row>>,
  fields: readonly string[]
): MaterializationHashIndex<Row, Value> {
  return optionalField({
    kind: 'hash',
    fields,
    lookup,
    raw: lookup,
    get: (value) => rowsFromNestedLookup(lookup.get(value)),
    rowsFor: (...values) => rowsFromLookupPath(lookup, values),
    has: (value) => lookup.has(value)
  }, fields);
}

function btreeIndex<Row, Value>(
  lookup: ReadonlyMap<Value, MaterializationNestedRows<Row>>,
  fields: readonly string[]
): MaterializationBtreeIndex<Row, Value> {
  const ordered = Array.from(lookup.keys()).sort(compareValues) as Value[];
  return optionalField({
    kind: 'btree',
    fields,
    lookup,
    raw: lookup,
    ordered,
    get: (value) => rowsFromNestedLookup(lookup.get(value)),
    rowsFor: (...values) => rowsFromLookupPath(lookup, values),
    has: (value) => lookup.has(value),
    range: (bounds = {}) => ordered
      .filter((value) => inRange(value, bounds))
      .flatMap((value) => rowsFromNestedLookup(lookup.get(value)))
  }, fields);
}

function uniqueIndexResult<Row, Value>(
  stored: StoredMaterialization<Row>,
  fields: readonly string[]
): MaterializationUniqueIndexResult<Row, Value> {
  const diagnostics: MaterializationDiagnostic[] = [];
  const lookup = groupUniqueRowsByFields<Row, Value>(stored.rows as readonly Row[], fields, diagnostics);
  const facade = uniqueIndex<Row, Value>(lookup, fields);

  return withMapLike(lookup, withTarget(stored, {
    kind: 'materializationUniqueIndex',
    indexed: diagnostics.length === 0,
    diagnostics,
    ...indexFieldShape(fields),
    fields,
    lookup,
    raw: lookup,
    index: facade
  }));
}

function uniqueIndex<Row, Value>(
  lookup: ReadonlyMap<Value, MaterializationNestedUniqueRows<Row>>,
  fields: readonly string[]
): MaterializationUniqueIndex<Row, Value> {
  return optionalField({
    kind: 'unique',
    fields,
    lookup,
    raw: lookup,
    get: (value) => fields.length === 1 ? rowFromUniqueLookupPath(lookup, [value]) : undefined,
    rowFor: (...values) => values.length === fields.length ? rowFromUniqueLookupPath(lookup, values) : undefined,
    has: (value) => lookup.has(value)
  }, fields);
}

function optionalField<T extends object>(shape: T, fields: readonly string[]): T & { readonly field?: string } {
  const field = fields[0];
  return fields.length === 1 && field !== undefined ? { ...shape, field } : shape;
}

function rowsFromLookupPath<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>,
  values: readonly unknown[]
): readonly Row[] {
  return rowsFromNestedLookup(nestedRowsAtPath(lookup, values));
}

function nestedRowsAtPath<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>,
  values: readonly unknown[]
): MaterializationNestedRows<Row> | undefined {
  let current: MaterializationNestedRows<Row> | undefined = lookup;
  for (const value of values) {
    if (!(current instanceof Map)) {
      return undefined;
    }
    current = current.get(value);
  }
  return current;
}

function rowsFromNestedLookup<Row>(value: MaterializationNestedRows<Row> | undefined): readonly Row[] {
  if (value === undefined) {
    return [];
  }
  if (value instanceof Map) {
    return Array.from(value.values()).flatMap((item) => rowsFromNestedLookup(item));
  }
  return Array.from(value as ReadonlySet<Row>);
}

function rowFromUniqueLookupPath<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>>,
  values: readonly unknown[]
): Row | undefined {
  let current: MaterializationNestedUniqueRows<Row> | ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>> | undefined = lookup;
  for (const value of values) {
    if (!(current instanceof Map)) {
      return undefined;
    }
    current = current.get(value);
  }
  return current === undefined ? undefined : current as Row;
}

function sortNestedLookup<Row>(lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>): ReadonlyMap<unknown, MaterializationNestedRows<Row>> {
  return new Map(
    Array.from(lookup.entries())
      .sort(([left], [right]) => compareValues(left, right))
      .map(([key, value]) => [
        key,
        value instanceof Map ? sortNestedLookup(value) : value
      ])
  );
}

function withSetLike<Row, Result extends object>(
  rows: ReadonlySet<Row>,
  result: Result
): Result & MaterializationSetLike<Row> {
  return Object.assign(result, {
    size: rows.size,
    has: (row: Row) => rows.has(row),
    values: () => rows.values(),
    keys: () => rows.keys(),
    entries: () => rows.entries(),
    forEach: (
      callbackfn: (value: Row, key: Row, set: ReadonlySet<Row>) => void,
      thisArg?: unknown
    ) => rows.forEach((value, key) => callbackfn.call(thisArg, value, key, rows)),
    [Symbol.iterator]: () => rows[Symbol.iterator]()
  });
}

function withMapLike<Key, Value, Result extends object>(
  lookup: ReadonlyMap<Key, Value>,
  result: Result
): Result & MaterializationMapLike<Key, Value> {
  return Object.assign(result, {
    size: lookup.size,
    get: (key: Key) => lookup.get(key),
    has: (key: Key) => lookup.has(key),
    keys: () => lookup.keys(),
    values: () => lookup.values(),
    entries: () => lookup.entries(),
    forEach: (
      callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
      thisArg?: unknown
    ) => lookup.forEach((value, key) => callbackfn.call(thisArg, value, key, lookup)),
    [Symbol.iterator]: () => lookup[Symbol.iterator]()
  });
}

function inRange<Value>(value: Value, bounds: MaterializationRange<Value>): boolean {
  const lower = normalizeRangeBound(bounds.lower, true);
  const upper = normalizeRangeBound(bounds.upper, true);

  if (lower !== undefined) {
    const comparison = compareValues(value, lower.value);
    if (comparison < 0 || (comparison === 0 && !lower.inclusive)) {
      return false;
    }
  }

  if (upper !== undefined) {
    const comparison = compareValues(value, upper.value);
    if (comparison > 0 || (comparison === 0 && !upper.inclusive)) {
      return false;
    }
  }

  return true;
}

function normalizeRangeBound<Value>(
  bound: MaterializationRangeBound<Value> | undefined,
  defaultInclusive: boolean
): { readonly value: Value; readonly inclusive: boolean } | undefined {
  if (bound === undefined) {
    return undefined;
  }

  if (isRecord(bound) && 'value' in bound) {
    return {
      value: bound.value as Value,
      inclusive: typeof bound.inclusive === 'boolean' ? bound.inclusive : defaultInclusive
    };
  }

  return { value: bound as Value, inclusive: defaultInclusive };
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
    case 'hash': {
      const lookup = new Map<Value, MaterializationNestedRows<Row>>();
      return withMapLike(lookup, {
        kind: 'materializationHashIndex',
        indexed: false,
        diagnostics,
        fields: [],
        lookup,
        raw: lookup
      });
    }
    case 'btree': {
      const lookup = new Map<Value, MaterializationNestedRows<Row>>();
      return withMapLike(lookup, {
        kind: 'materializationBtreeIndex',
        indexed: false,
        diagnostics,
        fields: [],
        lookup,
        raw: lookup,
        ordered: [],
        range: () => []
      });
    }
    case 'unique': {
      const lookup = new Map<Value, MaterializationNestedUniqueRows<Row>>();
      return withMapLike(lookup, {
        kind: 'materializationUniqueIndex',
        indexed: false,
        diagnostics,
        fields: [],
        lookup,
        raw: lookup
      });
    }
    default: {
      const rows = new Set<Row>();
      return withSetLike(rows, {
        kind: 'materializationIndex',
        indexed: false,
        diagnostics,
        rows,
        raw: rows
      });
    }
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

function incrementalFallbackDiagnostic(
  id: string,
  key: string,
  reason = 'snapshot-first Relic implementation'
): IncrementalFallbackMaterializationDiagnostic {
  return {
    code: 'materialization_incremental_fallback',
    message: 'incremental materialization is not available; snapshot recompute will be used',
    surface: 'materialization',
    detail: {
      mode: 'incremental',
      fallback: 'recompute',
      id,
      queryKey: key,
      reason
    }
  };
}

function emptyMaintenance(): MaterializationMaintenanceResult {
  return {
    kind: 'materializationMaintenance',
    maintained: 0,
    recomputed: 0,
    carried: 0,
    skipped: 0,
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

function isQueryBatch(input: unknown): input is MaterializationQueryBatch {
  return isRecord(input) && Object.values(input).every(isQuery);
}

function asRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function pickFields(input: Record<string, unknown>, fields: readonly string[] | undefined): Record<string, unknown> {
  if (fields === undefined) {
    return input;
  }

  return Object.fromEntries(fields.map((field) => [field, input[field]]));
}

function isIterable(input: unknown): input is Iterable<unknown> {
  return typeof input === 'object' &&
    input !== null &&
    Symbol.iterator in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isObject(input: unknown): input is object {
  return typeof input === 'object' && input !== null;
}
