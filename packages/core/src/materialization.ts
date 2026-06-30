import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './delta.js';
import { diffRows } from './diff.js';
import {
  attachConstraints,
  clearConstraintAttachments,
  hasAttachedConstraints,
  isConstraintAttachmentInput,
  transferConstraintAttachments,
  type ConstrainedDb,
  type ConstraintAttachmentInput
} from './constraints-attachment.js';
import { evaluate, type EvaluateOptions } from './evaluate.js';
import { stableKey as stableRowKey } from './identity.js';
import {
  dependencies,
  queryKey,
  type ExprData,
  type OptionalProjection,
  type PredicateData,
  type ProjectionData,
  type Query,
  type QueryData,
  type SortData
} from './query.js';
import type { RelationRef } from './schema.js';
import { asRelationSource, tryRelationSource } from './source-input.js';
import type { RelationSource } from './source.js';

declare const materializedDb: unique symbol;

/** Structural database-like object accepted by materialization declarations. */
export type MaterializableDb = object;
export type ObjectBackedMaterializableDb = {
  readonly data: Record<string, readonly unknown[]>;
};
export type SnapshotMaterializationTarget = ObjectBackedMaterializableDb | RelationSource;

/** Phantom marker for DB objects declared as materialized through `mat`. */
export type MaterializedDb = {
  readonly [materializedDb]?: true;
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
  | TarstateDiagnostic;

export type MaterializationMode = 'snapshot' | 'incremental';
export type MaterializationMaintenanceKind = 'unsupported' | 'snapshot' | 'incremental';

export type MaterializationOptions = {
  readonly id?: string;
  readonly name?: string;
  readonly mode?: MaterializationMode;
};
export type SnapshotMaterializationOptions = MaterializationOptions & EvaluateOptions;
export type MaterializationMaintenanceOptions = EvaluateOptions & {
  readonly deltas?: readonly RelationDelta[];
};
export type SnapshotRefreshTarget<Row = unknown> = string | MaterializationMetadata<Row> | Query<Row>;
export type MaterializedSourceOptions = {
  /** Relation name exposed by the returned snapshot source. Defaults to metadata name, then id. */
  readonly relationName?: string;
};

export type MaterializationMetadata<Row = unknown> = {
  readonly kind: 'materialization';
  readonly id: string;
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly requestedMode: MaterializationMode;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly sourceVersion?: unknown;
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
  readonly sourceVersion?: unknown;
};

export type MaterializationMaintenanceChangeKind = 'carried' | 'incremental' | 'recomputed';

export type MaterializationMaintenanceChange<Row = unknown> = {
  readonly kind: 'materializationMaintenanceChange';
  readonly update: MaterializationMaintenanceChangeKind;
  readonly id: string;
  readonly queryKey: string;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly previousRowsAvailable: boolean;
  readonly previousRows: readonly Row[] | undefined;
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};

export type MaterializationMaintenanceResult<Row = unknown> = {
  readonly kind: 'materializationMaintenance';
  readonly maintained: number;
  readonly recomputed: number;
  readonly carried: number;
  readonly changes: readonly MaterializationMaintenanceChange<Row>[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly sourceVersion?: unknown;
};

/** Snapshot row set returned by `snapshotIndex`; this is not an operator-maintained index. */
export type MaterializationIndex<Row = unknown> = {
  readonly kind: 'set';
  readonly rows: ReadonlySet<Row>;
};

/** Hash lookup derived from cached snapshot rows; this is not an operator-maintained index. */
export type MaterializationHashIndex<Row = unknown, Value = unknown> = {
  readonly kind: 'hash';
  readonly field: string;
  readonly lookup: ReadonlyMap<Value, readonly Row[]>;
};

/** Result for reading cached snapshot rows as a set index. */
export type MaterializationIndexResult<Row = unknown> = {
  readonly kind: 'materializationIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly index?: MaterializationIndex<Row>;
};

/** Result for reading cached snapshot rows as a hash lookup. */
export type MaterializationHashIndexResult<Row = unknown, Value = unknown> = {
  readonly kind: 'materializationHashIndex';
  readonly indexed: boolean;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly id?: string;
  readonly queryKey?: string;
  readonly index?: MaterializationHashIndex<Row, Value>;
};

/** Result for reading cached snapshot rows for an exact structural query match. */
export type MaterializedQueryResult<Row = unknown> = {
  readonly kind: 'materializedQueryResult';
  readonly materialized: boolean;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly queryKey: string;
  readonly id?: string;
  readonly sourceVersion?: unknown;
};

type SnapshotEntry<Row = unknown> = {
  readonly rows: readonly Row[];
};
type CurrentMaterializationSourceVersion =
  | {
    readonly available: true;
    readonly sourceVersion: unknown;
    readonly diagnostics: readonly TarstateDiagnostic[];
  }
  | {
    readonly available: false;
    readonly diagnostics: readonly TarstateDiagnostic[];
  };
type MaterializationRuntimeInputs = {
  readonly envKey?: string;
};
type SnapshotHashIndexBuildResult<Row, Value> =
  | {
    readonly indexed: true;
    readonly index: MaterializationHashIndex<Row, Value>;
  }
  | {
    readonly indexed: false;
    readonly diagnostics: readonly MaterializationDiagnostic[];
  };
type SnapshotMaintenanceSupport = {
  readonly maintenance: Exclude<MaterializationMaintenanceKind, 'unsupported'>;
  readonly diagnostics: readonly MaterializationDiagnostic[];
};
type IncrementalPlanResult =
  | { readonly kind: 'supported'; readonly plan: IncrementalMaterializationPlan }
  | { readonly kind: 'unsupported'; readonly reason: string };
type IncrementalAggregateFieldsResult =
  | { readonly kind: 'supported'; readonly fields: readonly IncrementalAggregateField[] }
  | { readonly kind: 'unsupported'; readonly reason: string };
type IncrementalBaseMaterializationPlan = {
  readonly relation: RelationRef;
  readonly relationName: string;
  readonly alias: string;
  readonly filters?: readonly IncrementalPredicate[];
};
type IncrementalMaterializationPlan =
  | IncrementalRowMaterializationPlan
  | IncrementalAggregateMaterializationPlan
  | IncrementalJoinMaterializationPlan;
type IncrementalRowMaterializationPlan = IncrementalBaseMaterializationPlan & {
  readonly kind: 'rows';
  readonly transforms: readonly IncrementalTransform[];
  readonly sort?: readonly SortData[];
};
type IncrementalAggregateMaterializationPlan = IncrementalBaseMaterializationPlan & {
  readonly kind: 'aggregate';
  readonly groupBy: ProjectionData;
  readonly aggregateFields: readonly IncrementalAggregateField[];
};
type IncrementalJoinSidePlan = {
  readonly relation: RelationRef;
  readonly relationName: string;
  readonly alias: string;
  readonly field: string;
  readonly filters?: readonly IncrementalPredicate[];
};
type IncrementalJoinSideBasePlan = Omit<IncrementalJoinSidePlan, 'field'>;
type IncrementalJoinMaterializationPlan = {
  readonly kind: 'join';
  readonly joinKind: 'inner' | 'left';
  readonly left: IncrementalJoinSidePlan;
  readonly right: IncrementalJoinSidePlan;
  readonly transforms: readonly IncrementalTransform[];
};
type IncrementalAggregateField =
  | { readonly op: 'count'; readonly fieldName: string; readonly expr?: ExprData }
  | { readonly op: 'sum'; readonly fieldName: string; readonly expr: ExprData }
  | { readonly op: 'avg'; readonly fieldName: string; readonly expr: ExprData }
  | { readonly op: 'min'; readonly fieldName: string; readonly expr: ExprData }
  | { readonly op: 'max'; readonly fieldName: string; readonly expr: ExprData }
  | { readonly op: 'any'; readonly fieldName: string; readonly expr: ExprData }
  | { readonly op: 'notAny'; readonly fieldName: string; readonly expr: ExprData };
type IncrementalAggregateValues = Record<string, unknown>;
type IncrementalPredicate =
  | {
    readonly op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
    readonly field: string;
    readonly fieldSide: 'left' | 'right';
    readonly value: IncrementalValueExpr;
  }
  | { readonly op: 'and' | 'or'; readonly predicates: readonly IncrementalPredicate[] }
  | { readonly op: 'not'; readonly predicate: IncrementalPredicate };
type IncrementalValueExpr =
  | { readonly op: 'value'; readonly value: unknown }
  | { readonly op: 'env'; readonly name: string }
  | { readonly op: 'tuple'; readonly items: readonly IncrementalValueExpr[] };
type IncrementalTransform =
  | { readonly op: 'select'; readonly projection: ProjectionData }
  | { readonly op: 'extend'; readonly projection: ProjectionData }
  | { readonly op: 'without'; readonly fields: readonly string[] }
  | { readonly op: 'rename'; readonly fields: Record<string, string> }
  | { readonly op: 'qualify'; readonly alias: string };
type IncrementalMappedRow =
  | { readonly included: true; readonly row: Record<string, unknown> }
  | { readonly included: false };
type IncrementalDeltaChange = {
  readonly key: string;
  readonly row: Record<string, unknown> | undefined;
};
type IncrementalAggregateDeltaChange =
  | {
    readonly key: string;
    readonly included: true;
    readonly group: Record<string, unknown>;
    readonly groupKey: string;
    readonly values: IncrementalAggregateValues;
  }
  | {
    readonly key: string;
    readonly included: false;
  };
type IncrementalAggregateMappedGroup =
  | {
    readonly included: true;
    readonly group: Record<string, unknown>;
    readonly groupKey: string;
    readonly values: IncrementalAggregateValues;
  }
  | {
    readonly included: false;
  };
type IncrementalAggregateGroupState = {
  readonly group: Record<string, unknown>;
  readonly values: IncrementalAggregateValues;
};
type IncrementalAggregateGroupStateResult =
  | {
    readonly kind: 'groups';
    readonly groups: ReadonlyMap<string, IncrementalAggregateGroupState>;
    readonly order: readonly string[];
  }
  | { readonly kind: 'fallback'; readonly reason: string };
type IncrementalSnapshotRowsResult =
  | {
      readonly kind: 'maintained';
      readonly update: Extract<MaterializationMaintenanceChangeKind, 'incremental' | 'recomputed'>;
      readonly rows: readonly unknown[];
    }
  | { readonly kind: 'fallback'; readonly reason: string }
  | { readonly kind: 'unavailable' };
type IncrementalDeltaRowsResult =
  | { readonly kind: 'applied'; readonly rows: readonly unknown[] }
  | { readonly kind: 'fallback'; readonly reason: string };
type IncrementalDeltaRecordResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'fallback'; readonly reason: string };
type IncrementalRowUpdateResult =
  | { readonly kind: 'updated'; readonly rows: unknown[] }
  | { readonly kind: 'fallback'; readonly reason: string };
type IncrementalJoinDeltaSet = {
  readonly removed: ReadonlyMap<string, unknown>;
  readonly added: ReadonlyMap<string, unknown>;
};
type IncrementalJoinDeltaState = {
  readonly kind: 'state';
  readonly left: IncrementalJoinDeltaSet;
  readonly right: IncrementalJoinDeltaSet;
};
type IncrementalJoinRowState = {
  readonly key: string;
  readonly row: Record<string, unknown>;
  readonly joinValue: unknown;
};
type IncrementalJoinCurrentState =
  | {
    readonly kind: 'state';
    readonly leftRows: readonly IncrementalJoinRowState[];
    readonly rightRows: readonly IncrementalJoinRowState[];
    readonly leftByKey: ReadonlyMap<string, IncrementalJoinRowState>;
    readonly rightByKey: ReadonlyMap<string, IncrementalJoinRowState>;
    readonly leftByJoin: ReadonlyMap<unknown, readonly IncrementalJoinRowState[]>;
    readonly rightByJoin: ReadonlyMap<unknown, readonly IncrementalJoinRowState[]>;
    readonly order: readonly string[];
  }
  | { readonly kind: 'fallback'; readonly reason: string };
type IncrementalJoinSnapshotState =
  | {
    readonly kind: 'state';
    readonly rowsByPairKey: ReadonlyMap<string, Record<string, unknown>>;
    readonly pairKeysByLeftKey: ReadonlyMap<string, ReadonlySet<string>>;
    readonly pairKeysByRightKey: ReadonlyMap<string, ReadonlySet<string>>;
  }
  | { readonly kind: 'fallback'; readonly reason: string };

const metadataByTarget = new WeakMap<object, readonly MaterializationMetadata[]>();
const snapshotRowsByTarget = new WeakMap<object, ReadonlyMap<string, SnapshotEntry>>();
const runtimeInputsByTarget = new WeakMap<object, ReadonlyMap<string, MaterializationRuntimeInputs>>();
let nextMaterializationNumber = 1;

const incrementalAggregateSubsetReason =
  'aggregate maintenance is limited to count(), count(expr), sum/min/max(expr), any/notAny(expr), and avg(expr) with matching sum(expr)/count(expr) over a non-null numeric base field or numeric literal, all without options';

/**
 * Evaluate a query once and cache its snapshot rows.
 *
 * @remarks Alias for `materializeSnapshot`. Snapshot mode is recompute-backed.
 * Incremental mode uses the same supported subset and recompute fallback as
 * `materializeSnapshot`.
 */
export function mat<Db extends object>(
  db: Db,
  constraints: ConstraintAttachmentInput
): Promise<Db & ConstrainedDb>;
export function mat<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  query: Query<Row>,
  options?: SnapshotMaterializationOptions
): Promise<Db & MaterializedDb>;
export function mat<Db extends object, Row>(
  db: Db,
  target: ConstraintAttachmentInput | Query<Row>,
  options: SnapshotMaterializationOptions = {}
): Promise<(Db & ConstrainedDb) | (Db & MaterializedDb)> {
  if (isConstraintAttachmentInput(target)) {
    return Promise.resolve(attachConstraints(db, target));
  }

  return materializeSnapshot(db as Db & SnapshotMaterializationTarget, target, options);
}

/**
 * Evaluate a query once and cache the rows by materialization id.
 *
 * @remarks Snapshot mode is recompute-backed. Incremental mode is limited to a narrow
 * single-relation subset and falls back to recompute with diagnostics outside that subset.
 */
export async function materializeSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  query: Query<Row>,
  options: SnapshotMaterializationOptions = {}
): Promise<Db & MaterializedDb> {
  const source = sourceForSnapshot(db);
  const versionDiagnostics: TarstateDiagnostic[] = [];
  const [result, sourceVersion] = await Promise.all([
    evaluate(source, query, options),
    readSourceVersion(source, versionDiagnostics)
  ]);
  const id = options.id ?? nextMaterializationId();
  const rows = Object.freeze([...result.rows]);
  const requestedMode = options.mode ?? 'snapshot';
  const maintenance = snapshotMaintenanceSupport(query, requestedMode);
  const diagnostics = [...result.diagnostics, ...versionDiagnostics, ...maintenance.diagnostics];
  const metadata: MaterializationMetadata<Row> = {
    kind: 'materialization',
    id,
    queryKey: queryKey(query),
    query,
    requestedMode,
    maintenance: maintenance.maintenance,
    diagnostics,
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(options.name === undefined ? {} : { name: options.name })
  };

  appendMaterializationMetadata(db, metadata);
  cacheSnapshotRows(db, id, rows);
  cacheRuntimeInputs(db, id, runtimeInputsForMaterialization(query, requestedMode, options));
  return db as Db & MaterializedDb;
}

/** Describe how a query would be materialized without evaluating or caching rows. */
export function explainMaterialization<Row>(
  query: Query<Row>,
  options: Pick<MaterializationOptions, 'mode'> = {}
): MaterializationExplanation<Row> {
  const requestedMode = options.mode ?? 'snapshot';
  const maintenance = snapshotMaintenanceSupport(query, requestedMode);

  return {
    kind: 'materializationExplanation',
    queryKey: queryKey(query),
    query,
    requestedMode,
    maintenance: maintenance.maintenance,
    dependencies: dependencies(query),
    diagnostics: maintenance.diagnostics
  };
}

/** Refresh an existing snapshot materialization by id, metadata, or structural query key. */
export async function refreshMaterializationSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  target: SnapshotRefreshTarget<Row>,
  options: EvaluateOptions = {}
): Promise<MaterializationRefreshResult<Row>> {
  const metadata = materializationForTarget(db, target);

  if (metadata === undefined) {
    return missingMaterializationRefreshResult(target);
  }

  const source = sourceForSnapshot(db);
  const versionDiagnostics: TarstateDiagnostic[] = [];
  const [result, sourceVersion] = await Promise.all([
    evaluate(source, metadata.query, options),
    readSourceVersion(source, versionDiagnostics)
  ]);
  const rows = Object.freeze([...result.rows]);
  const maintenance = snapshotMaintenanceSupport(metadata.query, metadata.requestedMode);
  const diagnostics = [...result.diagnostics, ...versionDiagnostics, ...maintenance.diagnostics];
  const nextMetadata = snapshotMetadata(metadata, diagnostics, sourceVersion, maintenance.maintenance);

  replaceMaterializationMetadata(db, nextMetadata);
  cacheSnapshotRows(db, metadata.id, rows);
  cacheRuntimeInputs(db, metadata.id, runtimeInputsForMaterialization(metadata.query, metadata.requestedMode, options));

  return {
    kind: 'materializationRefresh',
    id: metadata.id,
    queryKey: metadata.queryKey,
    refreshed: true,
    rows,
    diagnostics,
    ...(sourceVersion === undefined ? {} : { sourceVersion })
  };
}

/**
 * Carry materialization metadata from one DB/source object to another, refreshing snapshot rows.
 *
 * @remarks Maintenance is recompute-backed except for the explicit single-relation
 * incremental subset supported by `RelationDelta`.
 */
export async function maintainMaterializationSnapshots<Next extends SnapshotMaterializationTarget>(
  previous: object,
  next: Next,
  options: MaterializationMaintenanceOptions = {}
): Promise<MaterializationMaintenanceResult> {
  const existing = metadataListFor(previous);

  if (existing.length === 0) {
    transferConstraintAttachments(previous, next);
    return {
      kind: 'materializationMaintenance',
      maintained: 0,
      recomputed: 0,
      carried: 0,
      changes: [],
      diagnostics: []
    };
  }

  const source = sourceForSnapshot(next);
  const previousSnapshots = snapshotEntriesFor(previous);
  const previousRuntimeInputs = runtimeInputEntriesFor(previous);
  const changedRelations = changedRelationNames(options.deltas);
  const versionDiagnostics: TarstateDiagnostic[] = [];
  const sourceVersion = await readSourceVersion(source, versionDiagnostics);
  const nextMetadata: MaterializationMetadata[] = [];
  const nextSnapshots = new Map<string, SnapshotEntry>();
  const nextRuntimeInputs = new Map<string, MaterializationRuntimeInputs>();
  const changes: MaterializationMaintenanceChange[] = [];
  const diagnostics: MaterializationDiagnostic[] = [...versionDiagnostics];
  let maintained = 0;
  let recomputed = 0;
  let carried = 0;

  for (const metadata of existing) {
    if (metadata.maintenance === 'unsupported') {
      nextMetadata.push(metadata);
      copyRuntimeInputs(previousRuntimeInputs, nextRuntimeInputs, metadata.id);
      continue;
    }

    const previousSnapshot = previousSnapshots.get(metadata.id);
    const runtimeFallbackReason = incrementalRuntimeFallbackReason(
      metadata,
      previousRuntimeInputs.get(metadata.id),
      options
    );

    if (
      previousSnapshot !== undefined &&
      runtimeFallbackReason === undefined &&
      !isQueryAffectedByChanges(metadata.query, changedRelations)
    ) {
      const nextItem = snapshotMetadata(metadata, [...metadata.diagnostics, ...versionDiagnostics], sourceVersion);
      nextMetadata.push(nextItem);
      nextSnapshots.set(metadata.id, previousSnapshot);
      copyRuntimeInputs(previousRuntimeInputs, nextRuntimeInputs, metadata.id);
      changes.push(
        materializationMaintenanceChange(
          nextItem,
          'carried',
          previousSnapshot,
          previousSnapshot.rows,
          []
        )
      );
      maintained += 1;
      carried += 1;
      continue;
    }

    const incrementalRows = previousSnapshot === undefined || metadata.maintenance !== 'incremental'
      ? { kind: 'unavailable' } as const
      : runtimeFallbackReason === undefined
        ? await maintainIncrementalSnapshotRows(metadata, previousSnapshot, source, options.deltas, options)
        : { kind: 'fallback', reason: runtimeFallbackReason } as const;

    if (incrementalRows.kind === 'maintained') {
      const update = incrementalRows.update;
      const nextItem = snapshotMetadata(
        metadata,
        [...metadata.diagnostics, ...versionDiagnostics],
        sourceVersion,
        'incremental'
      );
      nextMetadata.push(nextItem);
      nextSnapshots.set(metadata.id, { rows: incrementalRows.rows });
      cacheRuntimeInputsInMap(
        nextRuntimeInputs,
        metadata.id,
        runtimeInputsForMaterialization(metadata.query, metadata.requestedMode, options)
      );
      changes.push(
        materializationMaintenanceChange(
          nextItem,
          update,
          previousSnapshot,
          incrementalRows.rows,
          []
        )
      );
      maintained += 1;
      if (update === 'recomputed') {
        recomputed += 1;
      }
      continue;
    }

    const result = await evaluate(source, metadata.query, options);
    const rows = Object.freeze([...result.rows]);
    const maintenance = snapshotMaintenanceSupport(metadata.query, metadata.requestedMode);
    const metadataDiagnostics = [...result.diagnostics, ...versionDiagnostics, ...maintenance.diagnostics];
    const changeDiagnostics: MaterializationDiagnostic[] = [...result.diagnostics, ...maintenance.diagnostics];
    const nextItem = snapshotMetadata(metadata, metadataDiagnostics, sourceVersion, maintenance.maintenance);

    nextMetadata.push(nextItem);
    nextSnapshots.set(metadata.id, { rows });
    cacheRuntimeInputsInMap(
      nextRuntimeInputs,
      metadata.id,
      runtimeInputsForMaterialization(metadata.query, metadata.requestedMode, options)
    );
    diagnostics.push(...result.diagnostics, ...maintenance.diagnostics);

    if (incrementalRows.kind === 'fallback') {
      const fallbackDiagnostic = incrementalFallbackMaterializationDiagnostic(metadata, incrementalRows.reason);
      diagnostics.push(fallbackDiagnostic);
      changeDiagnostics.push(fallbackDiagnostic);
    }

    changes.push(
      materializationMaintenanceChange(
        nextItem,
        'recomputed',
        previousSnapshot,
        rows,
        changeDiagnostics
      )
    );
    maintained += 1;
    recomputed += 1;
  }

  replaceAllMaterializationMetadata(next, nextMetadata);
  replaceAllSnapshotRows(next, nextSnapshots);
  replaceAllRuntimeInputs(next, nextRuntimeInputs);
  transferConstraintAttachments(previous, next);

  return {
    kind: 'materializationMaintenance',
    maintained,
    recomputed,
    carried,
    changes,
    diagnostics,
    ...(sourceVersion === undefined ? {} : { sourceVersion })
  };
}

/** Remove materialization metadata from a DB object and return the same object. */
export function demat<Db extends MaterializableDb>(
  db: Db,
  target?: string | MaterializationMetadata
): Db {
  if (target === undefined) {
    clearMaterializationState(db);
    clearConstraintAttachments(db);
    return db;
  }

  const id = typeof target === 'string' ? target : target.id;
  const remaining = metadataListFor(db).filter((metadata) => metadata.id !== id);

  replaceAllMaterializationMetadata(db, remaining);
  deleteSnapshotRows(db, id);
  deleteRuntimeInputs(db, id);

  return db;
}

/** Check whether a DB object has materialization metadata recorded by `mat`. */
export function isMaterialized(input: unknown): input is MaterializedDb {
  return typeof input === 'object' &&
    input !== null &&
    (hasMaterializationMetadata(input) || hasAttachedConstraints(input));
}

/** Read materialization metadata recorded for a DB object. */
export function materializationsFor(input: unknown): readonly MaterializationMetadata[] {
  return typeof input === 'object' && input !== null ? metadataListFor(input) : [];
}

/** Read the most recent materialization metadata for a structurally equivalent query. */
export function materializationForQuery<Row = unknown>(
  input: unknown,
  query: Query<Row>
): MaterializationMetadata<Row> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const key = queryKey(query);
  const metadata = latestMaterializationMetadata(input, (item) => item.queryKey === key);
  return metadata as MaterializationMetadata<Row> | undefined;
}

/** Read rows cached by a snapshot materialization id. */
export function materializedRowsFor<Row = unknown>(input: unknown, id: string): readonly Row[] | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  return snapshotRowsFor(input, id) as readonly Row[] | undefined;
}

/** Read rows cached by the most recent snapshot for a structurally equivalent query. */
export function materializedRowsForQuery<Row = unknown>(
  input: unknown,
  query: Query<Row>
): readonly Row[] | undefined {
  const metadata = materializationForQuery(input, query);
  return metadata === undefined ? undefined : materializedRowsFor<Row>(input, metadata.id);
}

/** Read cached snapshot rows for an exact structural query match without evaluating the query. */
export async function readMaterializedQuery<Row = unknown>(
  input: unknown,
  query: Query<Row>
): Promise<MaterializedQueryResult<Row>> {
  const key = queryKey(query);

  if (typeof input !== 'object' || input === null) {
    return missingMaterializedQueryResult(query, key);
  }

  const metadata = latestMaterializationMetadata(input, (item) => item.queryKey === key) as
    | MaterializationMetadata<Row>
    | undefined;

  if (metadata === undefined) {
    return missingMaterializedQueryResult(query, key);
  }

  const baseResult = materializedQueryResultBase<Row>(metadata);
  const entry = snapshotEntryFor(input, metadata.id);

  if (entry === undefined) {
    return {
      ...baseResult,
      materialized: false,
      rows: [],
      diagnostics: [...metadata.diagnostics, missingMaterializationRowsDiagnostic(metadata)]
    };
  }

  const version = await currentMaterializationSourceVersion(input);
  const versionDiagnostics = materializedQueryVersionDiagnostics(metadata, version);

  if (versionDiagnostics.length > 0) {
    return {
      ...baseResult,
      materialized: false,
      rows: [],
      diagnostics: [...metadata.diagnostics, ...versionDiagnostics]
    };
  }

  return {
    ...baseResult,
    materialized: true,
    rows: entry.rows as readonly Row[],
    diagnostics: metadata.diagnostics
  };
}

/** Expose cached snapshot rows as a read-only relation source. */
export function materializedSourceFor<Row = unknown>(
  input: unknown,
  target: SnapshotRefreshTarget<Row>,
  options: MaterializedSourceOptions = {}
): RelationSource {
  const state = materializedSourceState(input, target, options);
  const diagnostics = state.diagnostics as readonly TarstateDiagnostic[];

  return {
    relationNames: [state.relationName],
    rows: (relationRef) => relationRef.name === state.relationName ? state.rows : [],
    diagnostics: () => diagnostics,
    version: () => state.version
  };
}

/** Return a raw set index only when snapshot rows are cached for the requested materialization. */
export function snapshotIndex<Row = unknown>(
  input: unknown,
  target: SnapshotRefreshTarget<Row>
): MaterializationIndexResult<Row> {
  if (typeof input !== 'object' || input === null) {
    return {
      kind: 'materializationIndex',
      ...(typeof target === 'string' ? { id: target } : {}),
      ...(isQuery(target) ? { queryKey: queryKey(target) } : {}),
      indexed: false,
      diagnostics: [missingMaterializationDiagnostic(target)]
    };
  }

  const metadata = materializationForTarget(input, target);

  if (metadata === undefined) {
    return {
      kind: 'materializationIndex',
      ...(typeof target === 'string' ? { id: target } : {}),
      ...(isQuery(target) ? { queryKey: queryKey(target) } : {}),
      indexed: false,
      diagnostics: [missingMaterializationDiagnostic(target)]
    };
  }

  const entry = snapshotEntryFor(input, metadata.id);

  if (entry === undefined) {
    return {
      kind: 'materializationIndex',
      id: metadata.id,
      queryKey: metadata.queryKey,
      indexed: false,
      diagnostics: [unsupportedMaterializationIndexDiagnostic(metadata)]
    };
  }

  return {
    kind: 'materializationIndex',
    id: metadata.id,
    queryKey: metadata.queryKey,
    indexed: true,
    index: {
      kind: 'set',
      rows: new Set(entry.rows as readonly Row[])
    },
    diagnostics: []
  };
}

/**
 * Build a hash lookup from cached snapshot rows for the requested materialization.
 *
 * @remarks This is derived from the latest cached snapshot rows only. It is not an
 * operator-maintained index and has no incremental maintenance beyond the snapshot
 * rows already cached for the materialization.
 */
export function snapshotHashIndex<
  Row extends object,
  Field extends Extract<keyof Row, string> = Extract<keyof Row, string>
>(
  input: unknown,
  target: SnapshotRefreshTarget<Row>,
  field: Field
): MaterializationHashIndexResult<Row, Row[Field]>;
export function snapshotHashIndex<Row = unknown, Value = unknown>(
  input: unknown,
  target: SnapshotRefreshTarget<Row>,
  field: string
): MaterializationHashIndexResult<Row, Value>;
export function snapshotHashIndex<Row = unknown, Value = unknown>(
  input: unknown,
  target: SnapshotRefreshTarget<Row>,
  field: string
): MaterializationHashIndexResult<Row, Value> {
  if (typeof input !== 'object' || input === null) {
    return {
      kind: 'materializationHashIndex',
      ...(typeof target === 'string' ? { id: target } : {}),
      ...(isQuery(target) ? { queryKey: queryKey(target) } : {}),
      indexed: false,
      diagnostics: [missingMaterializationDiagnostic(target)]
    };
  }

  const metadata = materializationForTarget(input, target);

  if (metadata === undefined) {
    return {
      kind: 'materializationHashIndex',
      ...(typeof target === 'string' ? { id: target } : {}),
      ...(isQuery(target) ? { queryKey: queryKey(target) } : {}),
      indexed: false,
      diagnostics: [missingMaterializationDiagnostic(target)]
    };
  }

  const entry = snapshotEntryFor(input, metadata.id);

  if (entry === undefined) {
    return {
      kind: 'materializationHashIndex',
      id: metadata.id,
      queryKey: metadata.queryKey,
      indexed: false,
      diagnostics: [unsupportedMaterializationIndexDiagnostic(metadata)]
    };
  }

  const result = cachedSnapshotHashIndex<Row, Value>(metadata, entry, field);

  if (!result.indexed) {
    return {
      kind: 'materializationHashIndex',
      id: metadata.id,
      queryKey: metadata.queryKey,
      indexed: false,
      diagnostics: result.diagnostics
    };
  }

  return {
    kind: 'materializationHashIndex',
    id: metadata.id,
    queryKey: metadata.queryKey,
    indexed: true,
    index: result.index,
    diagnostics: []
  };
}

function materializedSourceState<Row>(
  input: unknown,
  target: SnapshotRefreshTarget<Row>,
  options: MaterializedSourceOptions
): {
  readonly relationName: string;
  readonly rows: readonly Row[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly version: unknown;
} {
  if (typeof input !== 'object' || input === null) {
    const relationName = materializedSourceRelationName(undefined, target, options);
    const diagnostics = [missingMaterializationDiagnostic(target)];

    return {
      relationName,
      rows: [],
      diagnostics,
      version: materializedSourceVersion(relationName, target, undefined, undefined, diagnostics)
    };
  }

  const metadata = materializationForTarget(input, target);

  if (metadata === undefined) {
    const relationName = materializedSourceRelationName(undefined, target, options);
    const diagnostics = [missingMaterializationDiagnostic(target)];

    return {
      relationName,
      rows: [],
      diagnostics,
      version: materializedSourceVersion(relationName, target, undefined, undefined, diagnostics)
    };
  }

  const relationName = materializedSourceRelationName(metadata, target, options);
  const entry = snapshotEntryFor(input, metadata.id);

  if (entry === undefined) {
    const diagnostics = [unsupportedMaterializationIndexDiagnostic(metadata)];

    return {
      relationName,
      rows: [],
      diagnostics,
      version: materializedSourceVersion(relationName, target, metadata, undefined, diagnostics)
    };
  }

  return {
    relationName,
    rows: entry.rows as readonly Row[],
    diagnostics: [],
    version: materializedSourceVersion(relationName, target, metadata, entry.rows, [])
  };
}

function materializedSourceRelationName<Row>(
  metadata: MaterializationMetadata<Row> | undefined,
  target: SnapshotRefreshTarget<Row>,
  options: MaterializedSourceOptions
): string {
  if (options.relationName !== undefined) {
    return options.relationName;
  }

  if (metadata !== undefined) {
    return metadata.name ?? metadata.id;
  }

  if (isMaterializationMetadata(target)) {
    return target.name ?? target.id;
  }

  return typeof target === 'string' ? target : queryKey(target);
}

function materializedSourceVersion<Row>(
  relationName: string,
  target: SnapshotRefreshTarget<Row>,
  metadata: MaterializationMetadata<Row> | undefined,
  rows: readonly unknown[] | undefined,
  diagnostics: readonly MaterializationDiagnostic[]
): unknown {
  const id = metadata?.id ?? (typeof target === 'string'
    ? target
    : isMaterializationMetadata(target)
      ? target.id
      : undefined);
  const targetQueryKey = metadata?.queryKey ?? (isQuery(target)
    ? queryKey(target)
    : isMaterializationMetadata(target)
      ? target.queryKey
      : undefined);

  return {
    kind: 'materializedSource',
    relationName,
    ...(id === undefined ? {} : { id }),
    ...(targetQueryKey === undefined ? {} : { queryKey: targetQueryKey }),
    ...(rows === undefined ? {} : { rows }),
    diagnostics
  };
}

function materializationForTarget<Row>(
  input: object,
  target: SnapshotRefreshTarget<Row>
): MaterializationMetadata<Row> | undefined {
  if (typeof target === 'string') {
    return latestMaterializationMetadata(input, (metadata) => metadata.id === target) as
      | MaterializationMetadata<Row>
      | undefined;
  }

  if (isMaterializationMetadata(target)) {
    return latestMaterializationMetadata(input, (metadata) => metadata.id === target.id) as
      | MaterializationMetadata<Row>
      | undefined;
  }

  return materializationForQuery(input, target);
}

function appendMaterializationMetadata<Row>(input: object, metadata: MaterializationMetadata<Row>): void {
  replaceAllMaterializationMetadata(input, [...metadataListFor(input), metadata]);
}

function replaceMaterializationMetadata<Row>(input: object, metadata: MaterializationMetadata<Row>): void {
  const existing = metadataListFor(input);
  const next = existing.map((item) => item.id === metadata.id ? metadata : item);
  replaceAllMaterializationMetadata(input, next);
}

function replaceAllMaterializationMetadata(input: object, metadata: readonly MaterializationMetadata[]): void {
  if (metadata.length === 0) {
    metadataByTarget.delete(input);
    return;
  }

  metadataByTarget.set(input, metadata);
}

function latestMaterializationMetadata(
  input: object,
  predicate: (metadata: MaterializationMetadata) => boolean
): MaterializationMetadata | undefined {
  return [...metadataListFor(input)].reverse().find(predicate);
}

function metadataListFor(input: object): readonly MaterializationMetadata[] {
  return metadataByTarget.get(input) ?? [];
}

function hasMaterializationMetadata(input: object): boolean {
  return metadataByTarget.has(input);
}

function cacheSnapshotRows<Row>(input: object, id: string, rows: readonly Row[]): void {
  const snapshots = new Map(snapshotEntriesFor(input));
  snapshots.set(id, { rows });
  replaceAllSnapshotRows(input, snapshots);
}

function replaceAllSnapshotRows(input: object, snapshots: ReadonlyMap<string, SnapshotEntry>): void {
  if (snapshots.size === 0) {
    snapshotRowsByTarget.delete(input);
    return;
  }

  snapshotRowsByTarget.set(input, snapshots);
}

function deleteSnapshotRows(input: object, id: string): void {
  const remaining = new Map(snapshotEntriesFor(input));
  remaining.delete(id);
  replaceAllSnapshotRows(input, remaining);
}

function cacheRuntimeInputs(
  input: object,
  id: string,
  runtimeInputs: MaterializationRuntimeInputs | undefined
): void {
  const inputs = new Map(runtimeInputEntriesFor(input));
  cacheRuntimeInputsInMap(inputs, id, runtimeInputs);
  replaceAllRuntimeInputs(input, inputs);
}

function cacheRuntimeInputsInMap(
  inputs: Map<string, MaterializationRuntimeInputs>,
  id: string,
  runtimeInputs: MaterializationRuntimeInputs | undefined
): void {
  if (runtimeInputs === undefined) {
    inputs.delete(id);
    return;
  }

  inputs.set(id, runtimeInputs);
}

function copyRuntimeInputs(
  from: ReadonlyMap<string, MaterializationRuntimeInputs>,
  to: Map<string, MaterializationRuntimeInputs>,
  id: string
): void {
  cacheRuntimeInputsInMap(to, id, from.get(id));
}

function replaceAllRuntimeInputs(
  input: object,
  runtimeInputs: ReadonlyMap<string, MaterializationRuntimeInputs>
): void {
  if (runtimeInputs.size === 0) {
    runtimeInputsByTarget.delete(input);
    return;
  }

  runtimeInputsByTarget.set(input, runtimeInputs);
}

function deleteRuntimeInputs(input: object, id: string): void {
  const remaining = new Map(runtimeInputEntriesFor(input));
  remaining.delete(id);
  replaceAllRuntimeInputs(input, remaining);
}

function clearMaterializationState(input: object): void {
  metadataByTarget.delete(input);
  snapshotRowsByTarget.delete(input);
  runtimeInputsByTarget.delete(input);
}

function snapshotRowsFor(input: object, id: string): readonly unknown[] | undefined {
  return snapshotEntryFor(input, id)?.rows;
}

function snapshotEntryFor(input: object, id: string): SnapshotEntry | undefined {
  return snapshotEntriesFor(input).get(id);
}

function snapshotEntriesFor(input: object): ReadonlyMap<string, SnapshotEntry> {
  return snapshotRowsByTarget.get(input) ?? new Map();
}

function runtimeInputEntriesFor(input: object): ReadonlyMap<string, MaterializationRuntimeInputs> {
  return runtimeInputsByTarget.get(input) ?? new Map();
}

async function currentMaterializationSourceVersion(input: object): Promise<CurrentMaterializationSourceVersion> {
  const source = tryRelationSource(input);

  if (source?.version === undefined) {
    return { available: false, diagnostics: [] };
  }

  const diagnostics: TarstateDiagnostic[] = [];
  const sourceVersion = await readSourceVersion(source, diagnostics);

  return sourceVersion === undefined
    ? { available: false, diagnostics }
    : { available: true, sourceVersion, diagnostics };
}

function materializedQueryVersionDiagnostics(
  metadata: MaterializationMetadata,
  current: CurrentMaterializationSourceVersion
): readonly MaterializationDiagnostic[] {
  const diagnostics: MaterializationDiagnostic[] = [...current.diagnostics];

  if (current.diagnostics.length > 0) {
    diagnostics.push(unknownMaterializationVersionDiagnostic(
      metadata,
      'current source version could not be read'
    ));
    return diagnostics;
  }

  if (!current.available) {
    return [
      unknownMaterializationVersionDiagnostic(
        metadata,
        'current source version is unavailable'
      )
    ];
  }

  if (metadata.sourceVersion === undefined) {
    return [
      unknownMaterializationVersionDiagnostic(
        metadata,
        'materialization metadata has no source version',
        current.sourceVersion
      )
    ];
  }

  return Object.is(current.sourceVersion, metadata.sourceVersion)
    ? []
    : [staleMaterializationDiagnostic(metadata, current.sourceVersion, metadata.sourceVersion)];
}

function materializedQueryResultBase<Row>(
  metadata: MaterializationMetadata<Row>
): Pick<MaterializedQueryResult<Row>, 'kind' | 'id' | 'queryKey' | 'sourceVersion'> {
  return {
    kind: 'materializedQueryResult',
    id: metadata.id,
    queryKey: metadata.queryKey,
    ...(metadata.sourceVersion === undefined ? {} : { sourceVersion: metadata.sourceVersion })
  };
}

function missingMaterializedQueryResult<Row>(
  query: Query<Row>,
  key: string
): MaterializedQueryResult<Row> {
  return {
    kind: 'materializedQueryResult',
    queryKey: key,
    materialized: false,
    rows: [],
    diagnostics: [missingMaterializationDiagnostic(query)]
  };
}

function cachedSnapshotHashIndex<Row, Value>(
  metadata: MaterializationMetadata,
  entry: SnapshotEntry,
  field: string
): SnapshotHashIndexBuildResult<Row, Value> {
  const buckets = new Map<Value, Row[]>();
  const rows = entry.rows as readonly Row[];

  for (const [rowIndex, row] of rows.entries()) {
    const record = snapshotRowRecord(row);

    if (record === undefined) {
      return {
        indexed: false,
        diagnostics: [
          unsupportedMaterializationIndexDiagnostic(
            metadata,
            `cached snapshot row ${rowIndex} is not an object`,
            { field, rowIndex }
          )
        ]
      };
    }

    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return {
        indexed: false,
        diagnostics: [
          unsupportedMaterializationIndexDiagnostic(
            metadata,
            `cached snapshot row ${rowIndex} does not contain field ${field}`,
            { field, rowIndex }
          )
        ]
      };
    }

    const value = record[field] as Value;
    const bucket = buckets.get(value);

    if (bucket === undefined) {
      buckets.set(value, [row]);
    } else {
      bucket.push(row);
    }
  }

  const lookup = new Map<Value, readonly Row[]>();
  for (const [value, bucket] of buckets) {
    lookup.set(value, Object.freeze([...bucket]));
  }

  return {
    indexed: true,
    index: {
      kind: 'hash',
      field,
      lookup
    }
  };
}

function snapshotRowRecord(row: unknown): Record<string, unknown> | undefined {
  return typeof row === 'object' && row !== null ? row as Record<string, unknown> : undefined;
}

function materializationMaintenanceChange<Row>(
  metadata: MaterializationMetadata<Row>,
  update: MaterializationMaintenanceChangeKind,
  previousSnapshot: SnapshotEntry<Row> | undefined,
  rows: readonly Row[],
  diagnostics: readonly MaterializationDiagnostic[]
): MaterializationMaintenanceChange<Row> {
  if (previousSnapshot === undefined) {
    return {
      kind: 'materializationMaintenanceChange',
      update,
      id: metadata.id,
      queryKey: metadata.queryKey,
      maintenance: metadata.maintenance,
      previousRowsAvailable: false,
      previousRows: undefined,
      rows,
      addedRows: [],
      removedRows: [],
      diagnostics
    };
  }

  const diff = diffRows(previousSnapshot.rows, rows);

  return {
    kind: 'materializationMaintenanceChange',
    update,
    id: metadata.id,
    queryKey: metadata.queryKey,
    maintenance: metadata.maintenance,
    previousRowsAvailable: true,
    previousRows: previousSnapshot.rows,
    rows,
    addedRows: Object.freeze([...diff.addedRows]),
    removedRows: Object.freeze([...diff.removedRows]),
    diagnostics
  };
}

function snapshotMetadata<Row>(
  previous: MaterializationMetadata<Row>,
  diagnostics: readonly MaterializationDiagnostic[],
  sourceVersion: unknown,
  maintenance: Exclude<MaterializationMaintenanceKind, 'unsupported'> = previous.maintenance === 'incremental'
    ? 'incremental'
    : 'snapshot'
): MaterializationMetadata<Row> {
  return {
    kind: 'materialization',
    id: previous.id,
    queryKey: previous.queryKey,
    query: previous.query,
    requestedMode: previous.requestedMode,
    maintenance,
    diagnostics,
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(previous.name === undefined ? {} : { name: previous.name })
  };
}

function missingMaterializationRefreshResult<Row>(
  target: SnapshotRefreshTarget<Row>
): MaterializationRefreshResult<Row> {
  const query = isQuery(target) ? target : undefined;

  return {
    kind: 'materializationRefresh',
    ...(typeof target === 'string' ? { id: target } : {}),
    ...(query === undefined ? {} : { queryKey: queryKey(query) }),
    refreshed: false,
    rows: [],
    diagnostics: [missingMaterializationDiagnostic(target)]
  };
}

function sourceForSnapshot(input: SnapshotMaterializationTarget): RelationSource {
  return asRelationSource(input);
}

function changedRelationNames(deltas: readonly RelationDelta[] | undefined): ReadonlySet<string> | undefined {
  if (deltas === undefined) {
    return undefined;
  }

  const names = new Set<string>();

  for (const delta of deltas) {
    if (delta.added.length > 0 || delta.removed.length > 0) {
      names.add(delta.relation.name);
    }
  }

  return names;
}

function isQueryAffectedByChanges(query: Query, changedRelations: ReadonlySet<string> | undefined): boolean {
  if (changedRelations === undefined) {
    return true;
  }

  return dependencies(query).some((relationName) => changedRelations.has(relationName));
}

function snapshotMaintenanceSupport(
  query: Query,
  requestedMode: MaterializationMode
): SnapshotMaintenanceSupport {
  if (requestedMode !== 'incremental') {
    return { maintenance: 'snapshot', diagnostics: [] };
  }

  const incremental = incrementalPlanFor(query);

  if (incremental.kind === 'supported') {
    return { maintenance: 'incremental', diagnostics: [] };
  }

  return {
    maintenance: 'snapshot',
    diagnostics: [unsupportedMaterializationDiagnostic('incremental', incremental.reason, query)]
  };
}

async function maintainIncrementalSnapshotRows(
  metadata: MaterializationMetadata,
  previousSnapshot: SnapshotEntry,
  source: RelationSource,
  deltas: readonly RelationDelta[] | undefined,
  options: EvaluateOptions
): Promise<IncrementalSnapshotRowsResult> {
  if (deltas === undefined) {
    return { kind: 'unavailable' };
  }

  const incremental = incrementalPlanFor(metadata.query);

  if (incremental.kind !== 'supported') {
    return { kind: 'unavailable' };
  }

  const rows = await applyIncrementalDeltas(previousSnapshot.rows, incremental.plan, deltas, options.env, source);

  return rows.kind === 'applied'
      ? {
        kind: 'maintained',
        update: incremental.plan.kind === 'rows' && incremental.plan.sort !== undefined ? 'recomputed' : 'incremental',
        rows: rows.rows
      }
    : rows;
}

function runtimeInputsForMaterialization(
  query: Query,
  requestedMode: MaterializationMode,
  options: EvaluateOptions
): MaterializationRuntimeInputs | undefined {
  if (requestedMode !== 'incremental') {
    return undefined;
  }

  const incremental = incrementalPlanFor(query);

  if (incremental.kind !== 'supported' || !incrementalPlanUsesEnv(incremental.plan)) {
    return undefined;
  }

  return { envKey: stableRowKey(options.env ?? {}) };
}

function incrementalRuntimeFallbackReason(
  metadata: MaterializationMetadata,
  previousRuntimeInputs: MaterializationRuntimeInputs | undefined,
  options: EvaluateOptions
): string | undefined {
  if (metadata.maintenance !== 'incremental') {
    return undefined;
  }

  const currentRuntimeInputs = runtimeInputsForMaterialization(metadata.query, metadata.requestedMode, options);

  if (currentRuntimeInputs === undefined) {
    return undefined;
  }

  if (previousRuntimeInputs === undefined) {
    return 'cached incremental predicate env inputs are unavailable';
  }

  return previousRuntimeInputs.envKey === currentRuntimeInputs.envKey
    ? undefined
    : 'incremental predicate env inputs changed';
}

function incrementalPlanUsesEnv(plan: IncrementalMaterializationPlan): boolean {
  return plan.kind === 'join'
    ? [
        ...(plan.left.filters ?? []),
        ...(plan.right.filters ?? [])
      ].some(incrementalPredicateUsesEnv)
    : plan.filters?.some(incrementalPredicateUsesEnv) ?? false;
}

function incrementalPredicateUsesEnv(predicate: IncrementalPredicate): boolean {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return incrementalValueExprUsesEnv(predicate.value);
    case 'and':
    case 'or':
      return predicate.predicates.some(incrementalPredicateUsesEnv);
    case 'not':
      return incrementalPredicateUsesEnv(predicate.predicate);
  }
}

function incrementalValueExprUsesEnv(expr: IncrementalValueExpr): boolean {
  switch (expr.op) {
    case 'value':
      return false;
    case 'env':
      return true;
    case 'tuple':
      return expr.items.some(incrementalValueExprUsesEnv);
  }
}

function incrementalPlanFor(query: Query): IncrementalPlanResult {
  const operations: QueryData[] = [];
  let current = query.data;

  while (hasUnaryInput(current)) {
    if (current.op !== 'keyBy') {
      operations.push(current);
    }
    current = current.input;
  }

  if (current.op === 'join') {
    return incrementalJoinPlanFor(query, current, operations);
  }

  if (current.op !== 'from') {
    return { kind: 'unsupported', reason: `expected from(...) base, found ${current.op}` };
  }

  const relation = query.relations[current.relation];

  if (relation === undefined) {
    return { kind: 'unsupported', reason: `unknown relation ${current.relation}` };
  }

  if (operations[0]?.op === 'aggregate') {
    return incrementalAggregatePlanFor(current, relation, operations[0], operations.slice(1));
  }

  if (operations.some((operation) => operation.op === 'aggregate')) {
    return { kind: 'unsupported', reason: 'aggregate is only supported as the final incremental operator' };
  }

  return incrementalRowPlanFor(current, relation, operations);
}

function incrementalJoinPlanFor(
  query: Query,
  join: Extract<QueryData, { readonly op: 'join' }>,
  operations: readonly QueryData[]
): IncrementalPlanResult {
  const leftSide = incrementalJoinSidePlanFor(query, join.left, 'left');

  if (leftSide.kind === 'unsupported') {
    return leftSide;
  }

  const rightSide = incrementalJoinSidePlanFor(query, join.right, 'right');

  if (rightSide.kind === 'unsupported') {
    return rightSide;
  }

  if (leftSide.plan.relationName === rightSide.plan.relationName) {
    return { kind: 'unsupported', reason: 'incremental join support does not yet include same-relation self joins' };
  }

  if (leftSide.plan.alias === rightSide.plan.alias) {
    return { kind: 'unsupported', reason: 'incremental join support requires distinct left and right aliases' };
  }

  const equality = incrementalJoinEqualityFor(join.on, leftSide.plan.alias, rightSide.plan.alias);

  if (equality === undefined) {
    return {
      kind: 'unsupported',
      reason: 'incremental join support is limited to equality between one left base field and one right base field'
    };
  }

  const transforms = incrementalJoinTransformsFor(operations);

  if (transforms.kind === 'unsupported') {
    return transforms;
  }

  return {
    kind: 'supported',
    plan: {
      kind: 'join',
      joinKind: join.kind,
      left: {
        ...leftSide.plan,
        field: equality.leftField
      },
      right: {
        ...rightSide.plan,
        field: equality.rightField
      },
      transforms: transforms.transforms
    }
  };
}

function incrementalJoinSidePlanFor(
  query: Query,
  input: QueryData,
  side: 'left' | 'right'
): {
  readonly kind: 'supported';
  readonly plan: IncrementalJoinSideBasePlan;
} | {
  readonly kind: 'unsupported';
  readonly reason: string;
} {
  const operations: QueryData[] = [];
  let current = input;

  while (hasUnaryInput(current)) {
    if (current.op !== 'keyBy') {
      operations.push(current);
    }
    current = current.input;
  }

  if (current.op !== 'from') {
    return {
      kind: 'unsupported',
      reason: `incremental join ${side} input is limited to from(...) with optional hash/where filters`
    };
  }

  const relation = query.relations[current.relation];

  if (relation === undefined) {
    return { kind: 'unsupported', reason: `unknown relation ${current.relation}` };
  }

  let hasHash = false;
  let filters: readonly IncrementalPredicate[] | undefined;

  for (const operation of [...operations].reverse()) {
    switch (operation.op) {
      case 'hash':
        if (hasHash) {
          return { kind: 'unsupported', reason: `incremental join ${side} input supports only one hash declaration` };
        }

        if (!isSupportedHash(operation, current.alias)) {
          return { kind: 'unsupported', reason: `incremental join ${side} hash support is limited to one field on the base alias` };
        }

        hasHash = true;
        continue;
      case 'where': {
        const predicate = incrementalPredicateFor(operation.predicate, current.alias);

        if (predicate === undefined) {
          return {
            kind: 'unsupported',
            reason: `incremental join ${side} where is limited to base-field comparisons against literal/env values with and/or/not composition`
          };
        }

        filters = filters === undefined
          ? [predicate]
          : [...filters, predicate];
        continue;
      }
      default:
        return {
          kind: 'unsupported',
          reason: `operator ${operation.op} is outside the incremental join ${side} input subset`
        };
    }
  }

  return {
    kind: 'supported',
    plan: {
      relation,
      relationName: current.relation,
      alias: current.alias,
      ...(filters === undefined ? {} : { filters })
    }
  };
}

function incrementalJoinTransformsFor(operations: readonly QueryData[]): {
  readonly kind: 'supported';
  readonly transforms: readonly IncrementalTransform[];
} | {
  readonly kind: 'unsupported';
  readonly reason: string;
} {
  const transforms: IncrementalTransform[] = [];
  let hasProject = false;

  for (const operation of [...operations].reverse()) {
    switch (operation.op) {
      case 'select':
        if (hasProject) {
          return { kind: 'unsupported', reason: 'only one post-join project/select step is supported' };
        }

        if (!isSupportedProjection(operation.projection)) {
          return { kind: 'unsupported', reason: 'post-join project is limited to field, literal, and tuple expressions' };
        }

        hasProject = true;
        transforms.push({ op: 'select', projection: operation.projection });
        continue;
      case 'extend':
        if (!isSupportedProjection(operation.projection)) {
          return { kind: 'unsupported', reason: 'post-join extend is limited to field, literal, and tuple expressions' };
        }

        transforms.push({ op: 'extend', projection: operation.projection });
        continue;
      case 'without':
        transforms.push({ op: 'without', fields: operation.fields });
        continue;
      case 'rename':
        transforms.push({ op: 'rename', fields: operation.fields });
        continue;
      case 'qualify':
        transforms.push({ op: 'qualify', alias: operation.alias });
        continue;
      default:
        return { kind: 'unsupported', reason: `operator ${operation.op} is outside the incremental join output subset` };
    }
  }

  return { kind: 'supported', transforms };
}

function incrementalRowPlanFor(
  base: Extract<QueryData, { readonly op: 'from' }>,
  relation: RelationRef,
  operations: readonly QueryData[]
): IncrementalPlanResult {
  const finalSort = operations[0]?.op === 'sort' ? operations[0] : undefined;

  if (operations.some((operation, index) => operation.op === 'sort' && index !== 0)) {
    return { kind: 'unsupported', reason: 'sort is only supported as the final incremental row operator' };
  }

  if (finalSort !== undefined && !isSupportedSort(finalSort.order)) {
    return { kind: 'unsupported', reason: 'sort is limited to field, literal, and tuple expressions' };
  }

  let phase: 'source' | 'filter' | 'output' = 'source';
  let hasHash = false;
  let hasProject = false;
  const plan: IncrementalBaseMaterializationPlan = {
    relation,
    relationName: base.relation,
    alias: base.alias
  };
  const transforms: IncrementalTransform[] = [];
  let filters: readonly IncrementalPredicate[] | undefined;
  let sort: readonly SortData[] | undefined;

  for (const operation of [...operations].reverse()) {
    switch (operation.op) {
      case 'hash':
        if (phase !== 'source' || hasHash) {
          return { kind: 'unsupported', reason: 'hash is only supported once directly after from(...)' };
        }

        if (!isSupportedHash(operation, base.alias)) {
          return { kind: 'unsupported', reason: 'incremental hash support is limited to one field on the base alias' };
        }

        hasHash = true;
        continue;
      case 'where': {
        if (phase === 'output') {
          return { kind: 'unsupported', reason: 'where is only supported before projection transforms' };
        }

        const predicate = incrementalPredicateFor(operation.predicate, base.alias);

        if (predicate === undefined) {
          return {
            kind: 'unsupported',
            reason: 'where is limited to base-field comparisons against literal/env values with and/or/not composition'
          };
        }

        phase = 'filter';
        filters = filters === undefined
          ? [predicate]
          : [...filters, predicate];
        continue;
      }
      case 'select':
        if (hasProject) {
          return { kind: 'unsupported', reason: 'only one project/select step is supported' };
        }

        if (!isSupportedProjection(operation.projection)) {
          return { kind: 'unsupported', reason: 'project is limited to field, literal, and tuple expressions' };
        }

        hasProject = true;
        phase = 'output';
        transforms.push({ op: 'select', projection: operation.projection });
        continue;
      case 'extend':
        if (!isSupportedProjection(operation.projection)) {
          return { kind: 'unsupported', reason: 'extend is limited to field, literal, and tuple expressions' };
        }

        phase = 'output';
        transforms.push({ op: 'extend', projection: operation.projection });
        continue;
      case 'without':
        phase = 'output';
        transforms.push({ op: 'without', fields: operation.fields });
        continue;
      case 'rename':
        phase = 'output';
        transforms.push({ op: 'rename', fields: operation.fields });
        continue;
      case 'qualify':
        phase = 'output';
        transforms.push({ op: 'qualify', alias: operation.alias });
        continue;
      case 'sort':
        phase = 'output';
        sort = operation.order;
        continue;
      default:
        return { kind: 'unsupported', reason: `operator ${operation.op} is outside the incremental subset` };
    }
  }

  return {
    kind: 'supported',
    plan: {
      ...plan,
      kind: 'rows',
      ...(filters === undefined ? {} : { filters }),
      transforms,
      ...(sort === undefined ? {} : { sort })
    }
  };
}

function incrementalAggregatePlanFor(
  base: Extract<QueryData, { readonly op: 'from' }>,
  relation: RelationRef,
  aggregate: Extract<QueryData, { readonly op: 'aggregate' }>,
  operations: readonly QueryData[]
): IncrementalPlanResult {
  if (!isSupportedProjection(aggregate.groupBy)) {
    return { kind: 'unsupported', reason: 'aggregate groupBy is limited to field, literal, and tuple expressions' };
  }

  const aggregateFields = incrementalAggregateFieldsFor(aggregate.aggregates, relation, base.alias);

  if (aggregateFields.kind === 'unsupported') {
    return {
      kind: 'unsupported',
      reason: aggregateFields.reason
    };
  }

  if (projectionFieldsOverlap(aggregate.groupBy, aggregate.aggregates)) {
    return { kind: 'unsupported', reason: 'aggregate output fields cannot overlap groupBy fields' };
  }

  let phase: 'source' | 'filter' = 'source';
  let hasHash = false;
  let filters: readonly IncrementalPredicate[] | undefined;

  for (const operation of [...operations].reverse()) {
    switch (operation.op) {
      case 'hash':
        if (phase !== 'source' || hasHash) {
          return { kind: 'unsupported', reason: 'hash is only supported once directly after from(...)' };
        }

        if (!isSupportedHash(operation, base.alias)) {
          return { kind: 'unsupported', reason: 'incremental hash support is limited to one field on the base alias' };
        }

        hasHash = true;
        continue;
      case 'where': {
        const predicate = incrementalPredicateFor(operation.predicate, base.alias);

        if (predicate === undefined) {
          return {
            kind: 'unsupported',
            reason: 'where is limited to base-field comparisons against literal/env values with and/or/not composition'
          };
        }

        phase = 'filter';
        filters = filters === undefined
          ? [predicate]
          : [...filters, predicate];
        continue;
      }
      default:
        return {
          kind: 'unsupported',
          reason: `operator ${operation.op} is outside the aggregate incremental subset`
        };
    }
  }

  return {
    kind: 'supported',
    plan: {
      kind: 'aggregate',
      relation,
      relationName: base.relation,
      alias: base.alias,
      ...(filters === undefined ? {} : { filters }),
      groupBy: aggregate.groupBy,
      aggregateFields: aggregateFields.fields
    }
  };
}

function hasUnaryInput(data: QueryData): data is QueryData & { readonly input: QueryData } {
  return 'input' in data;
}

function isSupportedHash(data: Extract<QueryData, { readonly op: 'hash' }>, alias: string): boolean {
  const [expression] = data.expressions;

  return data.expressions.length === 1 &&
    expression !== undefined &&
    expression.op === 'field' &&
    expression.alias === alias;
}

function incrementalJoinEqualityFor(
  predicate: PredicateData,
  leftAlias: string,
  rightAlias: string
): { readonly leftField: string; readonly rightField: string } | undefined {
  if (predicate.op !== 'eq' || predicate.left.op !== 'field' || predicate.right.op !== 'field') {
    return undefined;
  }

  if (predicate.left.alias === leftAlias && predicate.right.alias === rightAlias) {
    return { leftField: predicate.left.field, rightField: predicate.right.field };
  }

  if (predicate.left.alias === rightAlias && predicate.right.alias === leftAlias) {
    return { leftField: predicate.right.field, rightField: predicate.left.field };
  }

  return undefined;
}

function incrementalPredicateFor(predicate: PredicateData, alias: string): IncrementalPredicate | undefined {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return incrementalComparisonPredicateFor(predicate, alias);
    case 'and':
    case 'or': {
      const predicates: IncrementalPredicate[] = [];

      for (const item of predicate.predicates) {
        const nested = incrementalPredicateFor(item, alias);

        if (nested === undefined) {
          return undefined;
        }

        predicates.push(nested);
      }

      return { op: predicate.op, predicates };
    }
    case 'not': {
      const nested = incrementalPredicateFor(predicate.predicate, alias);
      return nested === undefined ? undefined : { op: 'not', predicate: nested };
    }
  }
}

function incrementalComparisonPredicateFor(
  predicate: Extract<PredicateData, { readonly op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' }>,
  alias: string
): IncrementalPredicate | undefined {
  const leftField = incrementalFieldOperandFor(predicate.left, alias);
  const rightField = incrementalFieldOperandFor(predicate.right, alias);
  const leftValue = incrementalValueExprFor(predicate.left);
  const rightValue = incrementalValueExprFor(predicate.right);

  if (leftField !== undefined && rightValue !== undefined && rightField === undefined) {
    return { op: predicate.op, field: leftField, fieldSide: 'left', value: rightValue };
  }

  if (rightField !== undefined && leftValue !== undefined && leftField === undefined) {
    return { op: predicate.op, field: rightField, fieldSide: 'right', value: leftValue };
  }

  return undefined;
}

function incrementalFieldOperandFor(expr: ExprData, alias: string): string | undefined {
  return expr.op === 'field' && expr.alias === alias ? expr.field : undefined;
}

function incrementalValueExprFor(expr: ExprData): IncrementalValueExpr | undefined {
  switch (expr.op) {
    case 'value':
      return { op: 'value', value: expr.value };
    case 'env':
      return { op: 'env', name: expr.name };
    case 'tuple': {
      const items: IncrementalValueExpr[] = [];

      for (const item of expr.items) {
        const value = incrementalValueExprFor(item);

        if (value === undefined) {
          return undefined;
        }

        items.push(value);
      }

      return { op: 'tuple', items };
    }
    case 'field':
    case 'call':
    case 'aggregateCall':
    case 'subquery':
      return undefined;
  }
}

function isSupportedProjection(projection: ProjectionData): boolean {
  return Object.values(projection).every((expr) => isSupportedIncrementalExpr(projectionExpr(expr)));
}

function isSupportedSort(order: readonly SortData[]): boolean {
  return order.every((item) => isSupportedIncrementalExpr(item.expr));
}

function incrementalAggregateFieldsFor(
  projection: ProjectionData,
  relation: RelationRef,
  alias: string
): IncrementalAggregateFieldsResult {
  const entries = Object.entries(projection);

  if (entries.length === 0) {
    return { kind: 'unsupported', reason: incrementalAggregateSubsetReason };
  }

  const fields: IncrementalAggregateField[] = [];

  for (const [fieldName, input] of entries) {
    const expr = projectionExpr(input);

    if (expr.op !== 'aggregateCall' || expr.distinct || expr.count !== undefined) {
      return { kind: 'unsupported', reason: incrementalAggregateSubsetReason };
    }

    if (expr.name === 'count' && (expr.expr === undefined || isSupportedIncrementalExpr(expr.expr))) {
      fields.push(expr.expr === undefined
        ? { op: 'count', fieldName }
        : { op: 'count', fieldName, expr: expr.expr });
      continue;
    }

    if (expr.name === 'sum' && expr.expr !== undefined && isSupportedIncrementalExpr(expr.expr)) {
      fields.push({ op: 'sum', fieldName, expr: expr.expr });
      continue;
    }

    if (expr.name === 'avg' && expr.expr !== undefined && isSupportedIncrementalExpr(expr.expr)) {
      if (
        isSupportedIncrementalAverageExpr(expr.expr, relation, alias) &&
        hasMatchingAggregateCall(entries, 'sum', expr.expr) &&
        hasMatchingAggregateCall(entries, 'count', expr.expr)
      ) {
        fields.push({ op: 'avg', fieldName, expr: expr.expr });
        continue;
      }

      return { kind: 'unsupported', reason: incrementalAggregateSubsetReason };
    }

    if ((expr.name === 'min' || expr.name === 'max') && expr.expr !== undefined && isSupportedIncrementalExpr(expr.expr)) {
      fields.push({ op: expr.name, fieldName, expr: expr.expr });
      continue;
    }

    if ((expr.name === 'any' || expr.name === 'notAny') && expr.expr !== undefined && isSupportedIncrementalExpr(expr.expr)) {
      fields.push({ op: expr.name, fieldName, expr: expr.expr });
      continue;
    }

    return { kind: 'unsupported', reason: incrementalAggregateSubsetReason };
  }

  return { kind: 'supported', fields };
}

function hasMatchingAggregateCall(
  entries: readonly (readonly [string, ExprData | OptionalProjection])[],
  name: 'count' | 'sum',
  expr: ExprData
): boolean {
  const key = stableRowKey(expr);

  for (const [, input] of entries) {
    const aggregate = projectionExpr(input);

    if (
      aggregate.op === 'aggregateCall' &&
      aggregate.name === name &&
      !aggregate.distinct &&
      aggregate.count === undefined &&
      aggregate.expr !== undefined &&
      stableRowKey(aggregate.expr) === key
    ) {
      return true;
    }
  }

  return false;
}

function isSupportedIncrementalAverageExpr(expr: ExprData, relation: RelationRef, alias: string): boolean {
  if (expr.op === 'value') {
    return typeof expr.value === 'number';
  }

  if (expr.op !== 'field' || expr.alias !== alias) {
    return false;
  }

  const spec = relation.fields[expr.field];
  return spec?.valueKind === 'number' && !spec.optional && !spec.nullable;
}

function projectionFieldsOverlap(left: ProjectionData, right: ProjectionData): boolean {
  const rightFields = new Set(Object.keys(right));

  return Object.keys(left).some((fieldName) => rightFields.has(fieldName));
}

function isSupportedIncrementalExpr(expr: ExprData): boolean {
  switch (expr.op) {
    case 'field':
    case 'value':
      return true;
    case 'tuple':
      return expr.items.every(isSupportedIncrementalExpr);
    case 'call':
    case 'aggregateCall':
    case 'env':
    case 'subquery':
      return false;
  }
}

async function applyIncrementalDeltas(
  previousRows: readonly unknown[],
  plan: IncrementalMaterializationPlan,
  deltas: readonly RelationDelta[],
  env: EvaluateOptions['env'],
  source: RelationSource
): Promise<IncrementalDeltaRowsResult> {
  switch (plan.kind) {
    case 'aggregate':
      return applyIncrementalAggregateDeltas(previousRows, plan, deltas, env);
    case 'join':
      return applyIncrementalJoinDeltas(previousRows, plan, deltas, source, env);
    case 'rows':
      return applyIncrementalRowDeltas(previousRows, plan, deltas, env, source);
  }
}

async function applyIncrementalRowDeltas(
  previousRows: readonly unknown[],
  plan: IncrementalRowMaterializationPlan,
  deltas: readonly RelationDelta[],
  env: EvaluateOptions['env'],
  source: RelationSource
): Promise<IncrementalDeltaRowsResult> {
  const removedChanges = new Map<string, IncrementalDeltaChange>();
  const addedChanges = new Map<string, IncrementalDeltaChange>();

  for (const delta of deltas) {
    if (delta.relation.name !== plan.relationName) {
      continue;
    }

    const removed = recordIncrementalDeltaRows(removedChanges, plan, delta.removed, 'removed', env);

    if (removed.kind === 'fallback') {
      return removed;
    }

    const added = recordIncrementalDeltaRows(addedChanges, plan, delta.added, 'added', env);

    if (added.kind === 'fallback') {
      return added;
    }
  }

  if (removedChanges.size === 0 && addedChanges.size === 0) {
    return { kind: 'applied', rows: Object.freeze([...previousRows]) };
  }

  if (plan.sort !== undefined) {
    return recomputeSortedIncrementalRowRows(plan, plan.sort, source, env);
  }

  let hasUnpairedRemoved = false;
  let hasUnpairedAdded = false;

  for (const key of removedChanges.keys()) {
    if (!addedChanges.has(key)) {
      hasUnpairedRemoved = true;
    }
  }

  for (const key of addedChanges.keys()) {
    if (!removedChanges.has(key)) {
      hasUnpairedAdded = true;
    }
  }

  if (hasUnpairedRemoved && hasUnpairedAdded) {
    return {
      kind: 'fallback',
      reason: 'delta batch mixes unpaired additions and removals without ordering information'
    };
  }

  let rows = [...previousRows];

  for (const removed of removedChanges.values()) {
    const added = addedChanges.get(removed.key);
    const nextRows = added === undefined
      ? removeIncrementalRow(rows, removed.row)
      : replaceIncrementalRow(rows, removed.row, added.row);

    if (nextRows.kind === 'fallback') {
      return nextRows;
    }

    rows = nextRows.rows;
  }

  for (const [key, added] of addedChanges) {
    if (removedChanges.has(key) || added.row === undefined) {
      continue;
    }

    rows.push(added.row);
  }

  return { kind: 'applied', rows: Object.freeze(rows) };
}

async function recomputeSortedIncrementalRowRows(
  plan: IncrementalRowMaterializationPlan,
  sort: readonly SortData[],
  source: RelationSource,
  env: EvaluateOptions['env']
): Promise<IncrementalDeltaRowsResult> {
  let sourceRows: readonly unknown[];

  try {
    sourceRows = Array.from(await source.rows(plan.relation));
  } catch {
    return { kind: 'fallback', reason: `current ${plan.relationName} rows could not be read` };
  }

  const rows: Record<string, unknown>[] = [];

  for (const [index, row] of sourceRows.entries()) {
    if (!isRecord(row)) {
      return { kind: 'fallback', reason: `current ${plan.relationName} row ${index} is not an object` };
    }

    const mapped = incrementalOutputForRelationRow(plan, row, env);

    if (mapped === undefined) {
      return { kind: 'fallback', reason: `current ${plan.relationName} row ${index} cannot be mapped through the incremental query` };
    }

    if (mapped.included) {
      rows.push(mapped.row);
    }
  }

  const sortedRows = sortIncrementalRows(rows, sort);

  return sortedRows.kind === 'fallback'
    ? sortedRows
    : { kind: 'applied', rows: Object.freeze(sortedRows.rows) };
}

function applyIncrementalAggregateDeltas(
  previousRows: readonly unknown[],
  plan: IncrementalAggregateMaterializationPlan,
  deltas: readonly RelationDelta[],
  env: EvaluateOptions['env']
): IncrementalDeltaRowsResult {
  const previousGroups = aggregateGroupStatesForSnapshotRows(previousRows, plan);

  if (previousGroups.kind === 'fallback') {
    return previousGroups;
  }

  const removedChanges = new Map<string, IncrementalAggregateDeltaChange>();
  const addedChanges = new Map<string, IncrementalAggregateDeltaChange>();

  for (const delta of deltas) {
    if (delta.relation.name !== plan.relationName) {
      continue;
    }

    const removed = recordIncrementalAggregateDeltaRows(removedChanges, plan, delta.removed, 'removed', env);

    if (removed.kind === 'fallback') {
      return removed;
    }

    const added = recordIncrementalAggregateDeltaRows(addedChanges, plan, delta.added, 'added', env);

    if (added.kind === 'fallback') {
      return added;
    }
  }

  if (removedChanges.size === 0 && addedChanges.size === 0) {
    return { kind: 'applied', rows: Object.freeze([...previousRows]) };
  }

  return Object.keys(plan.groupBy).length === 0
    ? applyUngroupedAggregateDeltas(previousGroups.groups, plan, removedChanges, addedChanges)
    : applyGroupedAggregateDeltas(previousGroups, plan, removedChanges, addedChanges);
}

async function applyIncrementalJoinDeltas(
  previousRows: readonly unknown[],
  plan: IncrementalJoinMaterializationPlan,
  deltas: readonly RelationDelta[],
  source: RelationSource,
  env: EvaluateOptions['env']
): Promise<IncrementalDeltaRowsResult> {
  const deltaState = incrementalJoinDeltaStateFor(plan, deltas);

  if (deltaState.kind === 'fallback') {
    return deltaState;
  }

  if (!incrementalJoinDeltaStateHasChanges(deltaState)) {
    return { kind: 'applied', rows: Object.freeze([...previousRows]) };
  }

  const currentState = await incrementalJoinCurrentStateFor(source, plan, env);

  if (currentState.kind === 'fallback') {
    return currentState;
  }

  if (plan.joinKind === 'left' || plan.transforms.length > 0) {
    return {
      kind: 'applied',
      rows: Object.freeze(incrementalJoinOutputRows(currentState, plan))
    };
  }

  const snapshotState = incrementalJoinSnapshotStateFor(previousRows, plan);

  if (snapshotState.kind === 'fallback') {
    return snapshotState;
  }

  const affectedPairKeys = new Set<string>();
  const currentAffectedRows = new Map<string, Record<string, unknown>>();

  for (const key of incrementalJoinChangedKeys(deltaState.left)) {
    addIncrementalJoinSnapshotPairKeys(affectedPairKeys, snapshotState.pairKeysByLeftKey, key);
    addCurrentIncrementalJoinRowsForLeftKey(currentAffectedRows, currentState, plan, key);
  }

  for (const key of incrementalJoinChangedKeys(deltaState.right)) {
    addIncrementalJoinSnapshotPairKeys(affectedPairKeys, snapshotState.pairKeysByRightKey, key);
    addCurrentIncrementalJoinRowsForRightKey(currentAffectedRows, currentState, plan, key);
  }

  const rowsByPairKey = new Map(snapshotState.rowsByPairKey);

  for (const pairKey of affectedPairKeys) {
    rowsByPairKey.delete(pairKey);
  }

  for (const [pairKey, row] of currentAffectedRows) {
    rowsByPairKey.set(pairKey, row);
  }

  const currentOrder = new Set(currentState.order);
  const rows: unknown[] = [];

  for (const pairKey of currentState.order) {
    const row = rowsByPairKey.get(pairKey);

    if (row === undefined) {
      return {
        kind: 'fallback',
        reason: 'cached join snapshot is missing an unaffected joined row'
      };
    }

    rows.push(row);
  }

  for (const pairKey of rowsByPairKey.keys()) {
    if (!currentOrder.has(pairKey)) {
      return {
        kind: 'fallback',
        reason: 'cached join snapshot contains a joined row that is not present in the current source rows'
      };
    }
  }

  return { kind: 'applied', rows: Object.freeze(rows) };
}

type IncrementalJoinDeltaStateResult =
  | IncrementalJoinDeltaState
  | { readonly kind: 'fallback'; readonly reason: string };

function incrementalJoinDeltaStateFor(
  plan: IncrementalJoinMaterializationPlan,
  deltas: readonly RelationDelta[]
): IncrementalJoinDeltaStateResult {
  const state = {
    kind: 'state' as const,
    left: { removed: new Map<string, unknown>(), added: new Map<string, unknown>() },
    right: { removed: new Map<string, unknown>(), added: new Map<string, unknown>() }
  };

  for (const delta of deltas) {
    if (delta.relation.name === plan.left.relationName) {
      const recorded = recordIncrementalJoinSideDeltaRows(state.left, plan.left, delta);

      if (recorded.kind === 'fallback') {
        return recorded;
      }
      continue;
    }

    if (delta.relation.name === plan.right.relationName) {
      const recorded = recordIncrementalJoinSideDeltaRows(state.right, plan.right, delta);

      if (recorded.kind === 'fallback') {
        return recorded;
      }
    }
  }

  return state;
}

function recordIncrementalJoinSideDeltaRows(
  state: { readonly removed: Map<string, unknown>; readonly added: Map<string, unknown> },
  side: IncrementalJoinSidePlan,
  delta: RelationDelta
): IncrementalDeltaRecordResult {
  const removed = recordIncrementalJoinDeltaRows(state.removed, side, delta.removed, 'removed');

  if (removed.kind === 'fallback') {
    return removed;
  }

  return recordIncrementalJoinDeltaRows(state.added, side, delta.added, 'added');
}

function recordIncrementalJoinDeltaRows(
  changes: Map<string, unknown>,
  side: IncrementalJoinSidePlan,
  rows: readonly unknown[],
  change: 'added' | 'removed'
): IncrementalDeltaRecordResult {
  for (const row of rows) {
    const key = relationRowKey(side.relation, row);

    if (key === undefined) {
      return {
        kind: 'fallback',
        reason: `${change} delta row is missing a usable ${side.relationName} key`
      };
    }

    if (changes.has(key)) {
      return {
        kind: 'fallback',
        reason: `delta batch contains multiple ${change} rows for the same ${side.relationName} key`
      };
    }

    changes.set(key, row);
  }

  return { kind: 'recorded' };
}

function incrementalJoinDeltaStateHasChanges(state: IncrementalJoinDeltaState): boolean {
  return state.left.removed.size > 0 ||
    state.left.added.size > 0 ||
    state.right.removed.size > 0 ||
    state.right.added.size > 0;
}

function incrementalJoinChangedKeys(state: IncrementalJoinDeltaSet): ReadonlySet<string> {
  return new Set([...state.removed.keys(), ...state.added.keys()]);
}

function incrementalJoinSnapshotStateFor(
  rows: readonly unknown[],
  plan: IncrementalJoinMaterializationPlan
): IncrementalJoinSnapshotState {
  const rowsByPairKey = new Map<string, Record<string, unknown>>();
  const pairKeysByLeftKey = new Map<string, Set<string>>();
  const pairKeysByRightKey = new Map<string, Set<string>>();

  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      return { kind: 'fallback', reason: `cached join row ${index} is not an object` };
    }

    const leftRow = row[plan.left.alias];
    const rightRow = row[plan.right.alias];

    if (!isRecord(leftRow) || !isRecord(rightRow)) {
      return {
        kind: 'fallback',
        reason: `cached join row ${index} does not contain raw ${plan.left.alias}/${plan.right.alias} relation rows`
      };
    }

    const leftKey = relationRowKey(plan.left.relation, leftRow);
    const rightKey = relationRowKey(plan.right.relation, rightRow);

    if (leftKey === undefined || rightKey === undefined) {
      return { kind: 'fallback', reason: `cached join row ${index} is missing a usable relation key` };
    }

    const pairKey = incrementalJoinPairKey(leftKey, rightKey);

    if (rowsByPairKey.has(pairKey)) {
      return { kind: 'fallback', reason: 'cached join snapshot contains duplicate relation-key pairs' };
    }

    rowsByPairKey.set(pairKey, row);
    addIncrementalJoinPairKey(pairKeysByLeftKey, leftKey, pairKey);
    addIncrementalJoinPairKey(pairKeysByRightKey, rightKey, pairKey);
  }

  return {
    kind: 'state',
    rowsByPairKey,
    pairKeysByLeftKey,
    pairKeysByRightKey
  };
}

async function incrementalJoinCurrentStateFor(
  source: RelationSource,
  plan: IncrementalJoinMaterializationPlan,
  env: EvaluateOptions['env']
): Promise<IncrementalJoinCurrentState> {
  const leftRows = await incrementalJoinCurrentRowsForSide(source, plan.left, env);

  if (leftRows.kind === 'fallback') {
    return leftRows;
  }

  const rightRows = await incrementalJoinCurrentRowsForSide(source, plan.right, env);

  if (rightRows.kind === 'fallback') {
    return rightRows;
  }

  const leftByKey = incrementalJoinRowsByKey(leftRows.rows);
  const rightByKey = incrementalJoinRowsByKey(rightRows.rows);
  const leftByJoin = incrementalJoinRowsByJoin(leftRows.rows);
  const rightByJoin = incrementalJoinRowsByJoin(rightRows.rows);
  const order: string[] = [];

  for (const left of leftRows.rows) {
    for (const right of rightByJoin.get(left.joinValue) ?? []) {
      order.push(incrementalJoinPairKey(left.key, right.key));
    }
  }

  return {
    kind: 'state',
    leftRows: leftRows.rows,
    rightRows: rightRows.rows,
    leftByKey,
    rightByKey,
    leftByJoin,
    rightByJoin,
    order
  };
}

async function incrementalJoinCurrentRowsForSide(
  source: RelationSource,
  side: IncrementalJoinSidePlan,
  env: EvaluateOptions['env']
): Promise<
  | { readonly kind: 'rows'; readonly rows: readonly IncrementalJoinRowState[] }
  | { readonly kind: 'fallback'; readonly reason: string }
> {
  let sourceRows: readonly unknown[];

  try {
    sourceRows = Array.from(await source.rows(side.relation));
  } catch {
    return { kind: 'fallback', reason: `current ${side.relationName} rows could not be read` };
  }

  const rows: IncrementalJoinRowState[] = [];
  const seenKeys = new Set<string>();

  for (const [index, row] of sourceRows.entries()) {
    if (!isRecord(row)) {
      return { kind: 'fallback', reason: `current ${side.relationName} row ${index} is not an object` };
    }

    if (side.filters !== undefined && !matchesIncrementalFilters(row, side.filters, env)) {
      continue;
    }

    const key = relationRowKey(side.relation, row);

    if (key === undefined) {
      return { kind: 'fallback', reason: `current ${side.relationName} row ${index} is missing a usable key` };
    }

    if (seenKeys.has(key)) {
      return { kind: 'fallback', reason: `current ${side.relationName} rows contain duplicate relation keys` };
    }

    seenKeys.add(key);
    rows.push({ key, row, joinValue: row[side.field] });
  }

  return { kind: 'rows', rows };
}

function incrementalJoinRowsByKey(
  rows: readonly IncrementalJoinRowState[]
): ReadonlyMap<string, IncrementalJoinRowState> {
  const byKey = new Map<string, IncrementalJoinRowState>();

  for (const row of rows) {
    byKey.set(row.key, row);
  }

  return byKey;
}

function incrementalJoinRowsByJoin(
  rows: readonly IncrementalJoinRowState[]
): ReadonlyMap<unknown, readonly IncrementalJoinRowState[]> {
  const byJoin = new Map<unknown, IncrementalJoinRowState[]>();

  for (const row of rows) {
    const bucket = byJoin.get(row.joinValue);

    if (bucket === undefined) {
      byJoin.set(row.joinValue, [row]);
    } else {
      bucket.push(row);
    }
  }

  return byJoin;
}

function addCurrentIncrementalJoinRowsForLeftKey(
  rowsByPairKey: Map<string, Record<string, unknown>>,
  state: Extract<IncrementalJoinCurrentState, { readonly kind: 'state' }>,
  plan: IncrementalJoinMaterializationPlan,
  leftKey: string
): void {
  const left = state.leftByKey.get(leftKey);

  if (left === undefined) {
    return;
  }

  for (const right of state.rightByJoin.get(left.joinValue) ?? []) {
    rowsByPairKey.set(
      incrementalJoinPairKey(left.key, right.key),
      incrementalJoinOutputRow(plan, left.row, right.row)
    );
  }
}

function incrementalJoinOutputRows(
  state: Extract<IncrementalJoinCurrentState, { readonly kind: 'state' }>,
  plan: IncrementalJoinMaterializationPlan
): unknown[] {
  const rows: unknown[] = [];

  for (const left of state.leftRows) {
    const rightRows = state.rightByJoin.get(left.joinValue) ?? [];

    if (rightRows.length === 0 && plan.joinKind === 'left') {
      rows.push(applyIncrementalJoinTransforms(
        incrementalJoinOutputRow(plan, left.row, null),
        plan.transforms
      ));
      continue;
    }

    for (const right of rightRows) {
      rows.push(applyIncrementalJoinTransforms(
        incrementalJoinOutputRow(plan, left.row, right.row),
        plan.transforms
      ));
    }
  }

  return rows;
}

function applyIncrementalJoinTransforms(
  row: Record<string, unknown>,
  transforms: readonly IncrementalTransform[]
): Record<string, unknown> {
  let output = row;

  for (const transform of transforms) {
    output = applyIncrementalTransform(output, transform);
  }

  return output;
}

function addCurrentIncrementalJoinRowsForRightKey(
  rowsByPairKey: Map<string, Record<string, unknown>>,
  state: Extract<IncrementalJoinCurrentState, { readonly kind: 'state' }>,
  plan: IncrementalJoinMaterializationPlan,
  rightKey: string
): void {
  const right = state.rightByKey.get(rightKey);

  if (right === undefined) {
    return;
  }

  for (const left of state.leftByJoin.get(right.joinValue) ?? []) {
    rowsByPairKey.set(
      incrementalJoinPairKey(left.key, right.key),
      incrementalJoinOutputRow(plan, left.row, right.row)
    );
  }
}

function addIncrementalJoinSnapshotPairKeys(
  target: Set<string>,
  pairKeysByRelationKey: ReadonlyMap<string, ReadonlySet<string>>,
  relationKey: string
): void {
  for (const pairKey of pairKeysByRelationKey.get(relationKey) ?? []) {
    target.add(pairKey);
  }
}

function addIncrementalJoinPairKey(
  target: Map<string, Set<string>>,
  relationKey: string,
  pairKey: string
): void {
  const existing = target.get(relationKey);

  if (existing === undefined) {
    target.set(relationKey, new Set([pairKey]));
    return;
  }

  existing.add(pairKey);
}

function incrementalJoinOutputRow(
  plan: IncrementalJoinMaterializationPlan,
  leftRow: Record<string, unknown>,
  rightRow: Record<string, unknown> | null
): Record<string, unknown> {
  return {
    [plan.left.alias]: leftRow,
    [plan.right.alias]: rightRow
  };
}

function incrementalJoinPairKey(leftKey: string, rightKey: string): string {
  return stableRowKey([leftKey, rightKey]);
}

function applyUngroupedAggregateDeltas(
  previousGroups: ReadonlyMap<string, IncrementalAggregateGroupState>,
  plan: IncrementalAggregateMaterializationPlan,
  removedChanges: ReadonlyMap<string, IncrementalAggregateDeltaChange>,
  addedChanges: ReadonlyMap<string, IncrementalAggregateDeltaChange>
): IncrementalDeltaRowsResult {
  const groupKey = stableRowKey({});
  const previousGroup = previousGroups.get(groupKey);

  if (previousGroup === undefined) {
    return { kind: 'fallback', reason: 'cached aggregate snapshot is missing the ungrouped row' };
  }

  const values = { ...previousGroup.values };

  for (const removed of removedChanges.values()) {
    if (removed.included) {
      const added = addedChanges.get(removed.key);
      const fallbackReason = added?.included === true
        ? applyAggregateReplacement(values, plan.aggregateFields, removed.values, added.values)
        : applyAggregateContribution(values, plan.aggregateFields, removed.values, -1);

      if (fallbackReason !== undefined) {
        return { kind: 'fallback', reason: fallbackReason };
      }
    }
  }

  for (const added of addedChanges.values()) {
    if (removedChanges.get(added.key)?.included === true || !added.included) {
      continue;
    }

    const fallbackReason = applyAggregateContribution(values, plan.aggregateFields, added.values, 1);

    if (fallbackReason !== undefined) {
      return { kind: 'fallback', reason: fallbackReason };
    }
  }

  if (hasInvalidCountAggregateValue(values, plan.aggregateFields)) {
    return { kind: 'fallback', reason: 'aggregate count delta would make the cached count negative' };
  }

  return {
    kind: 'applied',
    rows: Object.freeze([aggregateOutputRow({}, plan.aggregateFields, values)])
  };
}

function applyGroupedAggregateDeltas(
  previousGroups: Extract<IncrementalAggregateGroupStateResult, { readonly kind: 'groups' }>,
  plan: IncrementalAggregateMaterializationPlan,
  removedChanges: ReadonlyMap<string, IncrementalAggregateDeltaChange>,
  addedChanges: ReadonlyMap<string, IncrementalAggregateDeltaChange>
): IncrementalDeltaRowsResult {
  const groups = new Map<string, { group: Record<string, unknown>; values: IncrementalAggregateValues }>();
  const appendedGroupKeys: string[] = [];
  const decrementedGroupKeys = new Set<string>();

  for (const [groupKey, state] of previousGroups.groups) {
    groups.set(groupKey, { group: state.group, values: { ...state.values } });
  }

  for (const removed of removedChanges.values()) {
    const added = addedChanges.get(removed.key);

    if (removed.included && added?.included === true && sameIncludedAggregateGroup(removed, added)) {
      const group = groups.get(removed.groupKey);

      if (group === undefined) {
        return { kind: 'fallback', reason: 'updated aggregate group was not present in the cached snapshot' };
      }

      const fallbackReason = applyAggregateReplacement(group.values, plan.aggregateFields, removed.values, added.values);

      if (fallbackReason !== undefined) {
        return { kind: 'fallback', reason: fallbackReason };
      }

      if (hasInvalidCountAggregateValue(group.values, plan.aggregateFields)) {
        return { kind: 'fallback', reason: 'aggregate count delta would make the cached count negative' };
      }

      continue;
    }

    if (!removed.included) {
      continue;
    }

    if (!hasCountAggregateField(plan.aggregateFields)) {
      return {
        kind: 'fallback',
        reason: 'cached aggregate snapshot is missing count() needed to determine removed group cardinality'
      };
    }

    const group = groups.get(removed.groupKey);

    if (group === undefined) {
      return { kind: 'fallback', reason: 'removed aggregate group was not present in the cached snapshot' };
    }

    const fallbackReason = applyAggregateContribution(
      group.values,
      plan.aggregateFields,
      removed.values,
      -1,
      { skipExtremumFallback: aggregateGroupWillBeEmptyAfterRemoval(group.values, plan.aggregateFields, removed.values) }
    );

    if (fallbackReason !== undefined) {
      return { kind: 'fallback', reason: fallbackReason };
    }

    decrementedGroupKeys.add(removed.groupKey);

    if (hasInvalidCountAggregateValue(group.values, plan.aggregateFields)) {
      return { kind: 'fallback', reason: 'aggregate count delta would make the cached count negative' };
    }
  }

  for (const added of addedChanges.values()) {
    const removed = removedChanges.get(added.key);

    if ((removed?.included === true && added.included && sameIncludedAggregateGroup(removed, added)) || !added.included) {
      continue;
    }

    if (removed !== undefined) {
      return {
        kind: 'fallback',
        reason: 'delta update would add an aggregate group member without enough ordering information'
      };
    }

    const group = groups.get(added.groupKey);

    if (group === undefined) {
      groups.set(added.groupKey, { group: added.group, values: { ...added.values } });
      appendedGroupKeys.push(added.groupKey);
    } else {
      const fallbackReason = applyAggregateContribution(group.values, plan.aggregateFields, added.values, 1);

      if (fallbackReason !== undefined) {
        return { kind: 'fallback', reason: fallbackReason };
      }
    }
  }

  for (const groupKey of decrementedGroupKeys) {
    const group = groups.get(groupKey);

    if (group !== undefined && !isEmptyAggregateGroup(group.values, plan.aggregateFields)) {
      return {
        kind: 'fallback',
        reason: 'aggregate group removal is ambiguous because the removed row may have determined group order'
      };
    }
  }

  const rows: unknown[] = [];

  for (const groupKey of previousGroups.order) {
    const group = groups.get(groupKey);

    if (group === undefined || isEmptyAggregateGroup(group.values, plan.aggregateFields)) {
      continue;
    }

    rows.push(aggregateOutputRow(group.group, plan.aggregateFields, group.values));
  }

  for (const groupKey of appendedGroupKeys) {
    const group = groups.get(groupKey);

    if (group !== undefined && !isEmptyAggregateGroup(group.values, plan.aggregateFields)) {
      rows.push(aggregateOutputRow(group.group, plan.aggregateFields, group.values));
    }
  }

  return { kind: 'applied', rows: Object.freeze(rows) };
}

function aggregateGroupStatesForSnapshotRows(
  rows: readonly unknown[],
  plan: IncrementalAggregateMaterializationPlan
): IncrementalAggregateGroupStateResult {
  const groups = new Map<string, IncrementalAggregateGroupState>();
  const order: string[] = [];
  const groupFields = Object.keys(plan.groupBy);

  if (groupFields.length === 0 && rows.length !== 1) {
    return { kind: 'fallback', reason: 'cached ungrouped aggregate snapshot must contain exactly one row' };
  }

  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      return { kind: 'fallback', reason: `cached aggregate row ${index} is not an object` };
    }

    const group: Record<string, unknown> = {};

    for (const fieldName of groupFields) {
      if (!Object.hasOwn(row, fieldName)) {
        return { kind: 'fallback', reason: `cached aggregate row ${index} is missing group field ${fieldName}` };
      }

      group[fieldName] = row[fieldName];
    }

    const groupKey = stableRowKey(group);

    if (groups.has(groupKey)) {
      return { kind: 'fallback', reason: 'cached aggregate snapshot contains duplicate group rows' };
    }

    const values = aggregateValuesForSnapshotAggregateRow(row, plan.aggregateFields);

    if (values === undefined) {
      return { kind: 'fallback', reason: `cached aggregate row ${index} has invalid aggregate fields` };
    }

    groups.set(groupKey, { group, values });
    order.push(groupKey);
  }

  return { kind: 'groups', groups, order };
}

function aggregateValuesForSnapshotAggregateRow(
  row: Record<string, unknown>,
  aggregateFields: readonly IncrementalAggregateField[]
): IncrementalAggregateValues | undefined {
  const values: IncrementalAggregateValues = {};
  const valueByAccumulator = new Map<string, unknown>();

  for (const field of aggregateFields) {
    if (!Object.hasOwn(row, field.fieldName)) {
      return undefined;
    }

    const value = row[field.fieldName];

    if (!isValidAggregateSnapshotValue(field, value)) {
      return undefined;
    }

    const accumulatorKey = aggregateAccumulatorKey(field);
    if (valueByAccumulator.has(accumulatorKey) && !Object.is(valueByAccumulator.get(accumulatorKey), value)) {
      return undefined;
    }

    valueByAccumulator.set(accumulatorKey, value);
    values[field.fieldName] = field.op === 'notAny' ? !value : value;
  }

  return hasConsistentAverageAggregateValues(values, aggregateFields) ? values : undefined;
}

function isValidAggregateSnapshotValue(field: IncrementalAggregateField, value: unknown): boolean {
  switch (field.op) {
    case 'count':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    case 'sum':
      return typeof value === 'number';
    case 'avg':
      return typeof value === 'number' || value === undefined;
    case 'min':
    case 'max':
      return value !== null;
    case 'any':
    case 'notAny':
      return typeof value === 'boolean';
  }
}

function aggregateAccumulatorKey(field: IncrementalAggregateField): string {
  return field.op === 'count'
    ? field.expr === undefined ? 'count' : `count:${stableRowKey(field.expr)}`
    : `${field.op}:${stableRowKey(field.expr)}`;
}

function hasConsistentAverageAggregateValues(
  values: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[]
): boolean {
  for (const field of aggregateFields) {
    if (field.op !== 'avg') {
      continue;
    }

    const accumulators = averageAccumulatorFields(field, aggregateFields);

    if (accumulators === undefined) {
      return false;
    }

    const count = aggregateNumberValue(values[accumulators.count.fieldName]);
    const sum = aggregateNumberValue(values[accumulators.sum.fieldName]);
    const expected = count === 0 ? undefined : sum / count;

    if (!Object.is(values[field.fieldName], expected)) {
      return false;
    }
  }

  return true;
}

function refreshAverageAggregateValues(
  target: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[]
): string | undefined {
  for (const field of aggregateFields) {
    if (field.op !== 'avg') {
      continue;
    }

    const accumulators = averageAccumulatorFields(field, aggregateFields);

    if (accumulators === undefined) {
      return `avg aggregate ${field.fieldName} is missing matching sum/count accumulator fields`;
    }

    const count = aggregateNumberValue(target[accumulators.count.fieldName]);
    const sum = aggregateNumberValue(target[accumulators.sum.fieldName]);
    target[field.fieldName] = count === 0 ? undefined : sum / count;
  }

  return undefined;
}

function averageAccumulatorFields(
  field: Extract<IncrementalAggregateField, { readonly op: 'avg' }>,
  aggregateFields: readonly IncrementalAggregateField[]
): {
  readonly sum: Extract<IncrementalAggregateField, { readonly op: 'sum' }>;
  readonly count: Extract<IncrementalAggregateField, { readonly op: 'count' }>;
} | undefined {
  const key = stableRowKey(field.expr);
  let sumField: Extract<IncrementalAggregateField, { readonly op: 'sum' }> | undefined;
  let countField: Extract<IncrementalAggregateField, { readonly op: 'count' }> | undefined;

  for (const candidate of aggregateFields) {
    if (candidate.expr === undefined || stableRowKey(candidate.expr) !== key) {
      continue;
    }

    if (candidate.op === 'sum') {
      sumField = candidate;
      continue;
    }

    if (candidate.op === 'count') {
      countField = candidate;
    }
  }

  return sumField === undefined || countField === undefined
    ? undefined
    : { sum: sumField, count: countField };
}

function evaluateIncrementalAggregateValues(
  context: Record<string, unknown>,
  aggregateFields: readonly IncrementalAggregateField[]
): IncrementalAggregateValues {
  const values: IncrementalAggregateValues = {};

  for (const field of aggregateFields) {
    switch (field.op) {
      case 'count':
        values[field.fieldName] = field.expr === undefined
          ? 1
          : evaluateIncrementalExpr(context, field.expr) == null ? 0 : 1;
        break;
      case 'sum':
        values[field.fieldName] = numericAggregateValue(evaluateIncrementalExpr(context, field.expr));
        break;
      case 'avg':
        values[field.fieldName] = numericAggregateValue(evaluateIncrementalExpr(context, field.expr));
        break;
      case 'min':
      case 'max':
        values[field.fieldName] = extremumAggregateInputValue(evaluateIncrementalExpr(context, field.expr));
        break;
      case 'any':
      case 'notAny':
        values[field.fieldName] = Boolean(evaluateIncrementalExpr(context, field.expr));
        break;
    }
  }

  return values;
}

function numericAggregateValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function extremumAggregateInputValue(value: unknown): unknown {
  return value == null ? undefined : value;
}

function applyAggregateContribution(
  target: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[],
  contribution: IncrementalAggregateValues,
  sign: 1 | -1,
  options: { readonly skipExtremumFallback?: boolean } = {}
): string | undefined {
  for (const field of aggregateFields) {
    switch (field.op) {
      case 'count':
      case 'sum':
        target[field.fieldName] = aggregateNumberValue(target[field.fieldName]) +
          sign * aggregateNumberValue(contribution[field.fieldName]);
        continue;
      case 'avg':
        continue;
      case 'min':
      case 'max':
        if (sign === 1) {
          target[field.fieldName] = applyExtremumAddition(
            target[field.fieldName],
            contribution[field.fieldName],
            field.op
          );
          continue;
        }

        if (
          options.skipExtremumFallback !== true &&
          extremumRemovalNeedsFallback(target[field.fieldName], contribution[field.fieldName])
        ) {
          return removedExtremumFallbackReason(field);
        }
        continue;
      case 'any':
      case 'notAny':
        if (sign === 1) {
          target[field.fieldName] = Boolean(target[field.fieldName]) || Boolean(contribution[field.fieldName]);
          continue;
        }

        if (
          options.skipExtremumFallback !== true &&
          booleanRemovalNeedsFallback(Boolean(target[field.fieldName]), Boolean(contribution[field.fieldName]))
        ) {
          return removedBooleanAggregateFallbackReason(field);
        }

        if (options.skipExtremumFallback === true && Boolean(contribution[field.fieldName])) {
          target[field.fieldName] = false;
        }
        continue;
    }
  }

  return refreshAverageAggregateValues(target, aggregateFields);
}

function applyAggregateReplacement(
  target: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[],
  removed: IncrementalAggregateValues,
  added: IncrementalAggregateValues
): string | undefined {
  for (const field of aggregateFields) {
    switch (field.op) {
      case 'count':
      case 'sum':
        target[field.fieldName] = aggregateNumberValue(target[field.fieldName]) -
          aggregateNumberValue(removed[field.fieldName]) +
          aggregateNumberValue(added[field.fieldName]);
        continue;
      case 'avg':
        continue;
      case 'min':
      case 'max': {
        const fallbackReason = applyExtremumReplacement(
          target,
          field,
          removed[field.fieldName],
          added[field.fieldName]
        );

        if (fallbackReason !== undefined) {
          return fallbackReason;
        }
        continue;
      }
      case 'any':
      case 'notAny': {
        const fallbackReason = applyBooleanReplacement(
          target,
          field,
          Boolean(removed[field.fieldName]),
          Boolean(added[field.fieldName])
        );

        if (fallbackReason !== undefined) {
          return fallbackReason;
        }
        continue;
      }
    }
  }

  return refreshAverageAggregateValues(target, aggregateFields);
}

function applyExtremumReplacement(
  target: IncrementalAggregateValues,
  field: { readonly op: 'min' | 'max'; readonly fieldName: string },
  removed: unknown,
  added: unknown
): string | undefined {
  const current = target[field.fieldName];

  if (isIgnoredExtremumValue(removed)) {
    target[field.fieldName] = applyExtremumAddition(current, added, field.op);
    return undefined;
  }

  if (extremumValuesCompareEqual(current, removed)) {
    if (isIgnoredExtremumValue(added)) {
      return removedExtremumFallbackReason(field);
    }

    const comparison = compareAggregateValues(added, current);

    if ((field.op === 'min' && comparison <= 0) || (field.op === 'max' && comparison >= 0)) {
      target[field.fieldName] = added;
      return undefined;
    }

    return removedExtremumFallbackReason(field);
  }

  if (current === undefined) {
    return removedExtremumFallbackReason(field);
  }

  target[field.fieldName] = applyExtremumAddition(current, added, field.op);
  return undefined;
}

function applyExtremumAddition(current: unknown, added: unknown, op: 'min' | 'max'): unknown {
  if (isIgnoredExtremumValue(added)) {
    return current;
  }

  if (current === undefined) {
    return added;
  }

  const comparison = compareAggregateValues(added, current);
  return (op === 'min' && comparison < 0) || (op === 'max' && comparison > 0)
    ? added
    : current;
}

function extremumRemovalNeedsFallback(current: unknown, removed: unknown): boolean {
  if (isIgnoredExtremumValue(removed)) {
    return false;
  }

  if (current === undefined) {
    return true;
  }

  return extremumValuesCompareEqual(current, removed);
}

function removedExtremumFallbackReason(field: { readonly op: 'min' | 'max'; readonly fieldName: string }): string {
  return `removed ${field.op} aggregate value may have determined the cached ${field.op} for ${field.fieldName}`;
}

function applyBooleanReplacement(
  target: IncrementalAggregateValues,
  field: { readonly op: 'any' | 'notAny'; readonly fieldName: string },
  removed: boolean,
  added: boolean
): string | undefined {
  if (!removed && added) {
    target[field.fieldName] = true;
    return undefined;
  }

  if (removed && !added && Boolean(target[field.fieldName])) {
    return removedBooleanAggregateFallbackReason(field);
  }

  return undefined;
}

function booleanRemovalNeedsFallback(current: boolean, removed: boolean): boolean {
  return removed && current;
}

function removedBooleanAggregateFallbackReason(
  field: { readonly op: 'any' | 'notAny'; readonly fieldName: string }
): string {
  return `removed ${field.op} aggregate value may have determined the cached ${field.fieldName}`;
}

function aggregateNumberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function isIgnoredExtremumValue(value: unknown): boolean {
  return value == null;
}

function extremumValuesCompareEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return compareAggregateValues(left, right) === 0;
}

function compareAggregateValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : 1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : 1;
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  const leftKey = stableRowKey(left);
  const rightKey = stableRowKey(right);

  if (leftKey === rightKey) {
    return 0;
  }

  return leftKey < rightKey ? -1 : 1;
}

function aggregateGroupWillBeEmptyAfterRemoval(
  values: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[],
  removed: IncrementalAggregateValues
): boolean {
  for (const field of aggregateFields) {
    if (field.op === 'count') {
      return aggregateNumberValue(values[field.fieldName]) - aggregateNumberValue(removed[field.fieldName]) === 0;
    }
  }

  return false;
}

function hasInvalidCountAggregateValue(
  values: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[]
): boolean {
  for (const field of aggregateFields) {
    if (field.op !== 'count') {
      continue;
    }

    const value = values[field.fieldName];

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return true;
    }
  }

  return false;
}

function hasCountAggregateField(aggregateFields: readonly IncrementalAggregateField[]): boolean {
  return aggregateFields.some((field) => field.op === 'count' && field.expr === undefined);
}

function isEmptyAggregateGroup(
  values: IncrementalAggregateValues,
  aggregateFields: readonly IncrementalAggregateField[]
): boolean {
  for (const field of aggregateFields) {
    if (field.op === 'count' && field.expr === undefined) {
      return values[field.fieldName] === 0;
    }
  }

  return false;
}

function recordIncrementalAggregateDeltaRows(
  changes: Map<string, IncrementalAggregateDeltaChange>,
  plan: IncrementalAggregateMaterializationPlan,
  rows: readonly unknown[],
  side: 'added' | 'removed',
  env: EvaluateOptions['env']
): IncrementalDeltaRecordResult {
  for (const row of rows) {
    const key = relationRowKey(plan.relation, row);

    if (key === undefined) {
      return {
        kind: 'fallback',
        reason: `${side} delta row is missing a usable ${plan.relationName} key`
      };
    }

    if (changes.has(key)) {
      return {
        kind: 'fallback',
        reason: `delta batch contains multiple ${side} rows for the same ${plan.relationName} key`
      };
    }

    const mapped = incrementalAggregateGroupForRelationRow(plan, row, env);

    if (mapped === undefined) {
      return {
        kind: 'fallback',
        reason: `${side} delta row cannot be mapped through the incremental aggregate query`
      };
    }

    changes.set(key, mapped.included
      ? {
          key,
          included: true,
          group: mapped.group,
          groupKey: mapped.groupKey,
          values: mapped.values
        }
      : { key, included: false });
  }

  return { kind: 'recorded' };
}

function incrementalAggregateGroupForRelationRow(
  plan: IncrementalAggregateMaterializationPlan,
  row: unknown,
  env: EvaluateOptions['env']
): IncrementalAggregateMappedGroup | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  if (plan.filters !== undefined && !matchesIncrementalFilters(row, plan.filters, env)) {
    return { included: false };
  }

  const context = { [plan.alias]: row };
  const group = evaluateIncrementalProjection(context, plan.groupBy);

  if (!hasValidAverageAggregateInputs(context, plan.aggregateFields)) {
    return undefined;
  }

  const values = evaluateIncrementalAggregateValues(context, plan.aggregateFields);

  return {
    included: true,
    group,
    groupKey: stableRowKey(group),
    values
  };
}

function hasValidAverageAggregateInputs(
  context: Record<string, unknown>,
  aggregateFields: readonly IncrementalAggregateField[]
): boolean {
  for (const field of aggregateFields) {
    if (field.op === 'avg' && typeof evaluateIncrementalExpr(context, field.expr) !== 'number') {
      return false;
    }
  }

  return true;
}

function sameIncludedAggregateGroup(
  left: IncrementalAggregateDeltaChange | undefined,
  right: IncrementalAggregateDeltaChange | undefined
): boolean {
  return left?.included === true && right?.included === true && left.groupKey === right.groupKey;
}

function aggregateOutputRow(
  group: Record<string, unknown>,
  aggregateFields: readonly IncrementalAggregateField[],
  values: IncrementalAggregateValues
): Record<string, unknown> {
  const row: Record<string, unknown> = { ...group };

  for (const field of aggregateFields) {
    if (field.op === 'min' || field.op === 'max' || field.op === 'any' || field.op === 'avg') {
      row[field.fieldName] = values[field.fieldName];
      continue;
    }

    if (field.op === 'notAny') {
      row[field.fieldName] = !values[field.fieldName];
      continue;
    }

    row[field.fieldName] = aggregateNumberValue(values[field.fieldName]);
  }

  return row;
}

function recordIncrementalDeltaRows(
  changes: Map<string, IncrementalDeltaChange>,
  plan: IncrementalRowMaterializationPlan,
  rows: readonly unknown[],
  side: 'added' | 'removed',
  env: EvaluateOptions['env']
): IncrementalDeltaRecordResult {
  for (const row of rows) {
    const key = relationRowKey(plan.relation, row);

    if (key === undefined) {
      return {
        kind: 'fallback',
        reason: `${side} delta row is missing a usable ${plan.relationName} key`
      };
    }

    if (changes.has(key)) {
      return {
        kind: 'fallback',
        reason: `delta batch contains multiple ${side} rows for the same ${plan.relationName} key`
      };
    }

    const mapped = incrementalOutputForRelationRow(plan, row, env);

    if (mapped === undefined) {
      return {
        kind: 'fallback',
        reason: `${side} delta row cannot be mapped through the incremental query`
      };
    }

    changes.set(key, {
      key,
      row: mapped.included ? mapped.row : undefined
    });
  }

  return { kind: 'recorded' };
}

function replaceIncrementalRow(
  rows: readonly unknown[],
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): IncrementalRowUpdateResult {
  if (before === undefined) {
    return after === undefined
      ? { kind: 'updated', rows: [...rows] }
      : {
        kind: 'fallback',
        reason: 'delta update would add a newly matching filtered row without enough ordering information'
      };
  }

  if (after === undefined) {
    return removeIncrementalRow(rows, before);
  }

  const beforeKey = stableRowKey(before);
  const afterKey = stableRowKey(after);

  if (beforeKey !== afterKey && rowKeyCount(rows, beforeKey) > 1) {
    return {
      kind: 'fallback',
      reason: 'projected output update is ambiguous because multiple cached rows match the removed projection'
    };
  }

  const index = rows.findIndex((row) => stableRowKey(row) === beforeKey);

  if (index === -1) {
    return {
      kind: 'fallback',
      reason: 'removed projected row was not present in the cached snapshot'
    };
  }

  const next = [...rows];
  next[index] = after;
  return { kind: 'updated', rows: next };
}

function removeIncrementalRow(
  rows: readonly unknown[],
  row: Record<string, unknown> | undefined
): IncrementalRowUpdateResult {
  if (row === undefined) {
    return { kind: 'updated', rows: [...rows] };
  }

  const key = stableRowKey(row);
  const index = rows.findIndex((item) => stableRowKey(item) === key);

  if (index === -1) {
    return {
      kind: 'fallback',
      reason: 'removed projected row was not present in the cached snapshot'
    };
  }

  return { kind: 'updated', rows: [...rows.slice(0, index), ...rows.slice(index + 1)] };
}

function rowKeyCount(rows: readonly unknown[], key: string): number {
  let count = 0;

  for (const row of rows) {
    if (stableRowKey(row) === key) {
      count += 1;
    }
  }

  return count;
}

function sortIncrementalRows(
  rows: readonly unknown[],
  order: readonly SortData[]
): IncrementalRowUpdateResult {
  const keyedRows: {
    readonly row: unknown;
    readonly keys: readonly unknown[];
  }[] = [];

  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      return { kind: 'fallback', reason: `cached sort row ${index} is not an object` };
    }

    keyedRows.push({
      row,
      keys: order.map((item) => evaluateIncrementalExpr(row, item.expr))
    });
  }

  return {
    kind: 'updated',
    rows: keyedRows.sort((left, right) => {
      for (let index = 0; index < order.length; index += 1) {
        const item = order[index] as SortData;
        const comparison = compareIncrementalSortValues(
          left.keys[index],
          right.keys[index],
          item
        );

        if (comparison !== 0) {
          return comparison;
        }
      }

      return 0;
    }).map((item) => item.row)
  };
}

function compareIncrementalSortValues(left: unknown, right: unknown, sort: SortData): number {
  const leftNull = left == null;
  const rightNull = right == null;

  if (leftNull || rightNull) {
    if (leftNull && rightNull) {
      return 0;
    }

    const nulls = sort.nulls ?? 'last';
    const nullComparison = leftNull ? -1 : 1;
    return nulls === 'first' ? nullComparison : -nullComparison;
  }

  const comparison = compareIncrementalValues(left, right);
  return sort.direction === 'asc' ? comparison : -comparison;
}

function incrementalOutputForRelationRow(
  plan: IncrementalRowMaterializationPlan,
  row: unknown,
  env: EvaluateOptions['env']
): IncrementalMappedRow | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  if (plan.filters !== undefined && !matchesIncrementalFilters(row, plan.filters, env)) {
    return { included: false };
  }

  let output: Record<string, unknown> = { [plan.alias]: row };

  for (const transform of plan.transforms) {
    output = applyIncrementalTransform(output, transform);
  }

  return { included: true, row: output };
}

function matchesIncrementalFilters(
  row: Record<string, unknown>,
  filters: readonly IncrementalPredicate[],
  env: EvaluateOptions['env']
): boolean {
  for (const filter of filters) {
    if (!evaluateIncrementalPredicate(row, filter, env)) {
      return false;
    }
  }

  return true;
}

function evaluateIncrementalPredicate(
  row: Record<string, unknown>,
  predicate: IncrementalPredicate,
  env: EvaluateOptions['env']
): boolean {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const fieldValue = row[predicate.field];
      const value = evaluateIncrementalValueExpr(predicate.value, env);
      const left = predicate.fieldSide === 'left' ? fieldValue : value;
      const right = predicate.fieldSide === 'left' ? value : fieldValue;

      return evaluateIncrementalComparison(predicate.op, left, right);
    }
    case 'and':
      for (const item of predicate.predicates) {
        if (!evaluateIncrementalPredicate(row, item, env)) {
          return false;
        }
      }
      return true;
    case 'or':
      for (const item of predicate.predicates) {
        if (evaluateIncrementalPredicate(row, item, env)) {
          return true;
        }
      }
      return false;
    case 'not':
      return !evaluateIncrementalPredicate(row, predicate.predicate, env);
  }
}

function evaluateIncrementalComparison(
  op: Extract<IncrementalPredicate['op'], 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'>,
  left: unknown,
  right: unknown
): boolean {
  switch (op) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'lt':
      return compareIncrementalValues(left, right) < 0;
    case 'lte':
      return compareIncrementalValues(left, right) <= 0;
    case 'gt':
      return compareIncrementalValues(left, right) > 0;
    case 'gte':
      return compareIncrementalValues(left, right) >= 0;
  }
}

function evaluateIncrementalValueExpr(expr: IncrementalValueExpr, env: EvaluateOptions['env']): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'env':
      return env?.[expr.name];
    case 'tuple':
      return expr.items.map((item) => evaluateIncrementalValueExpr(item, env));
  }
}

function compareIncrementalValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : 1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : 1;
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  const leftKey = stableRowKey(left);
  const rightKey = stableRowKey(right);

  if (leftKey === rightKey) {
    return 0;
  }

  return leftKey < rightKey ? -1 : 1;
}

function applyIncrementalTransform(
  row: Record<string, unknown>,
  transform: IncrementalTransform
): Record<string, unknown> {
  switch (transform.op) {
    case 'select':
      return evaluateIncrementalProjection(row, transform.projection);
    case 'extend':
      return { ...row, ...evaluateIncrementalProjection(row, transform.projection) };
    case 'without':
      return omitFields(row, transform.fields);
    case 'rename':
      return renameFields(row, transform.fields);
    case 'qualify':
      return { [transform.alias]: row };
  }
}

function evaluateIncrementalProjection(
  context: Record<string, unknown>,
  projection: ProjectionData
): Record<string, unknown> {
  const row: Record<string, unknown> = {};

  for (const [fieldName, expr] of Object.entries(projection)) {
    row[fieldName] = evaluateIncrementalExpr(context, projectionExpr(expr));
  }

  return row;
}

function projectionExpr(input: ExprData | OptionalProjection): ExprData {
  return isOptionalProjection(input) ? input.expr : input;
}

function isOptionalProjection(input: ExprData | OptionalProjection): input is OptionalProjection {
  return 'kind' in input && input.kind === 'optionalProjection';
}

function evaluateIncrementalExpr(context: Record<string, unknown>, expr: ExprData): unknown {
  switch (expr.op) {
    case 'field':
      return evaluateIncrementalField(context, expr.alias, expr.field);
    case 'value':
      return expr.value;
    case 'tuple':
      return expr.items.map((item) => evaluateIncrementalExpr(context, item));
    case 'env':
    case 'call':
    case 'aggregateCall':
    case 'subquery':
      return undefined;
  }
}

function evaluateIncrementalField(context: Record<string, unknown>, alias: string, field: string): unknown {
  if (alias.length === 0) {
    return context[field];
  }

  const row = context[alias];
  return isRecord(row) ? row[field] : undefined;
}

function relationRowKey(relation: RelationRef, row: unknown): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const values: unknown[] = [];
  const keyFields = typeof relation.key === 'string' ? [relation.key] : relation.key;

  for (const field of keyFields) {
    const value = row[field];

    if (value === undefined) {
      return undefined;
    }

    values.push(value);
  }

  return stableRowKey(values);
}

function omitFields(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const output = { ...row };

  for (const field of fields) {
    delete output[field];
  }

  return output;
}

function renameFields(row: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
  const output = { ...row };

  for (const [from, to] of Object.entries(fields)) {
    if (Object.hasOwn(output, from)) {
      output[to] = output[from];
      delete output[from];
    }
  }

  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function isMaterializationMetadata(input: unknown): input is MaterializationMetadata {
  return typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'materialization';
}

async function readSourceVersion(
  source: RelationSource,
  diagnostics: TarstateDiagnostic[]
): Promise<unknown> {
  try {
    return await source.version?.();
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: 'source version failed',
      detail: error
    });
    return undefined;
  }
}

function nextMaterializationId(): string {
  const id = `mat:${nextMaterializationNumber}`;
  nextMaterializationNumber += 1;
  return id;
}

function unsupportedMaterializationDiagnostic(
  mode: MaterializationMode,
  reason = 'requested materialization mode is unsupported for this query',
  query?: Query
): MaterializationDiagnostic {
  const message = mode === 'incremental'
    ? `materialization mode incremental is unsupported for this query: ${reason}`
    : `materialization mode ${mode} is unsupported for this query: ${reason}`;

  return {
    code: 'materialization_unsupported',
    message,
    surface: 'materialization',
    detail: {
      mode,
      reason,
      ...(query === undefined ? {} : { queryKey: queryKey(query) })
    }
  };
}

function incrementalFallbackMaterializationDiagnostic(
  metadata: MaterializationMetadata,
  reason: string
): MaterializationDiagnostic {
  return {
    code: 'materialization_incremental_fallback',
    message: `incremental materialization fell back to recompute for this delta batch: ${reason}`,
    surface: 'materialization',
    detail: {
      mode: 'incremental',
      fallback: 'recompute',
      id: metadata.id,
      queryKey: metadata.queryKey,
      reason
    }
  };
}

function missingMaterializationRowsDiagnostic(metadata: MaterializationMetadata): MaterializationDiagnostic {
  return {
    code: 'materialization_rows_missing',
    message: 'materialization metadata exists but cached snapshot rows are unavailable',
    surface: 'materialization',
    detail: { id: metadata.id, queryKey: metadata.queryKey }
  };
}

function staleMaterializationDiagnostic(
  metadata: MaterializationMetadata,
  sourceVersion: unknown,
  metadataSourceVersion: unknown
): MaterializationDiagnostic {
  return {
    code: 'materialization_stale',
    message: 'cached materialization source version does not match the current source version',
    surface: 'materialization',
    detail: {
      id: metadata.id,
      queryKey: metadata.queryKey,
      sourceVersion,
      metadataSourceVersion
    }
  };
}

function unknownMaterializationVersionDiagnostic(
  metadata: MaterializationMetadata,
  reason: string,
  sourceVersion?: unknown
): MaterializationDiagnostic {
  return {
    code: 'materialization_version_unknown',
    message: `materialization source version could not be verified: ${reason}`,
    surface: 'materialization',
    detail: {
      id: metadata.id,
      queryKey: metadata.queryKey,
      reason,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
      ...(metadata.sourceVersion === undefined ? {} : { metadataSourceVersion: metadata.sourceVersion })
    }
  };
}

function missingMaterializationDiagnostic(target: SnapshotRefreshTarget): MaterializationDiagnostic {
  return {
    code: 'materialization_missing',
    message: 'snapshot materialization does not exist for the requested target',
    surface: 'materialization',
    detail: { target }
  };
}

function unsupportedMaterializationIndexDiagnostic(
  metadata: MaterializationMetadata,
  reason = 'snapshot rows are not cached',
  detail: Record<string, unknown> = {}
): MaterializationDiagnostic {
  return {
    code: 'materialization_index_unsupported',
    message: `materialization index is unavailable because ${reason}`,
    surface: 'materialization',
    detail: { id: metadata.id, queryKey: metadata.queryKey, ...detail }
  };
}
