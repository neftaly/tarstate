import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './delta.js';
import type { EvaluateOptions } from './evaluate.js';
import { queryKey, type Query } from './query.js';
import type { RelationSource } from './source.js';
import {
  attachConstraints,
  type ConstraintAttachmentInput
} from './constraints-attachment.js';

declare const materializedDb: unique symbol;

export type MaterializableDb = object;
export type ObjectBackedMaterializableDb = {
  readonly data: Record<string, readonly unknown[]>;
};
export type SnapshotMaterializationTarget = ObjectBackedMaterializableDb | RelationSource;

export type MaterializedDb = {
  readonly [materializedDb]: true;
};

const materializedDbs = new WeakSet<object>();

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
  readonly sourceVersion?: unknown;
};

export type MaterializationIndexOptions<Field extends string = string> =
  | { readonly kind?: 'set' }
  | { readonly kind: 'hash'; readonly field: Field }
  | { readonly kind: 'btree'; readonly field: Field }
  | { readonly kind: 'unique'; readonly field: Field };

export function mat<Db extends object>(
  db: Db,
  constraints: ConstraintAttachmentInput
): Db & import('./constraints-attachment.js').ConstrainedDb;
export function mat<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  query: Query<Row>,
  options?: SnapshotMaterializationOptions
): Promise<Db & MaterializedDb>;
export function mat<Db extends object, Row>(
  db: Db,
  queryOrConstraints: Query<Row> | ConstraintAttachmentInput,
  _options: SnapshotMaterializationOptions = {}
): Db | Promise<Db & MaterializedDb> {
  return isQuery(queryOrConstraints) ? Promise.resolve(markMaterialized(db)) : attachConstraints(db, queryOrConstraints);
}

export async function materializeSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  db: Db,
  _query: Query<Row>,
  _options: SnapshotMaterializationOptions = {}
): Promise<Db & MaterializedDb> {
  return markMaterialized(db);
}

export function explainMaterialization<Row>(
  query: Query<Row>,
  options: MaterializationOptions = {}
): MaterializationExplanation<Row> {
  return {
    kind: 'materializationExplanation',
    queryKey: queryKey(query),
    query,
    requestedMode: options.mode ?? 'snapshot',
    maintenance: 'unsupported',
    dependencies: [],
    diagnostics: [unsupportedDiagnostic()]
  };
}

export async function refreshMaterializationSnapshot<Db extends SnapshotMaterializationTarget, Row>(
  _db: Db,
  target: SnapshotRefreshTarget<Row>,
  _options: EvaluateOptions = {}
): Promise<MaterializationRefreshResult<Row>> {
  return {
    kind: 'materializationRefresh',
    ...(typeof target === 'string' ? { id: target } : {}),
    ...(!isQuery(target) && typeof target !== 'string' ? { id: target.id, queryKey: target.queryKey } : {}),
    ...(isQuery(target) ? { queryKey: queryKey(target) } : {}),
    refreshed: false,
    rows: [],
    diagnostics: [missingDiagnostic()]
  };
}

export async function maintainMaterializationSnapshots<Next extends SnapshotMaterializationTarget>(
  _previous: SnapshotMaterializationTarget,
  next: Next,
  _options: MaterializationMaintenanceOptions = {}
): Promise<Next & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult }> {
  return markMaintainedMaterialized(next);
}

export function demat<Db extends MaterializableDb>(db: Db, _target?: string | Query | MaterializationMetadata): Db {
  materializedDbs.delete(db);
  return db;
}

export function isMaterialized(input: unknown): input is MaterializedDb {
  return isObject(input) && materializedDbs.has(input);
}

export function materializationsFor(_input: unknown): readonly MaterializationMetadata[] {
  return [];
}

export function materializationForQuery<Row = unknown>(
  _input: unknown,
  _query: Query<Row>
): MaterializationMetadata<Row> | undefined {
  return undefined;
}

export function materializedRowsFor<Row = unknown>(_input: unknown, _id: string): readonly Row[] | undefined {
  return undefined;
}

export function materializedRowsForQuery<Row = unknown>(
  _input: unknown,
  _query: Query<Row>
): readonly Row[] | undefined {
  return undefined;
}

export async function readMaterializedQuery<Row = unknown>(
  _input: unknown,
  query: Query<Row>
): Promise<MaterializedQueryResult<Row>> {
  return {
    kind: 'materializedQueryResult',
    materialized: false,
    rows: [],
    diagnostics: [missingDiagnostic()],
    queryKey: queryKey(query)
  };
}

export function materializedSourceFor<Row = unknown>(
  _input: unknown,
  _target: string | Query<Row> | MaterializationMetadata<Row>,
  options: MaterializedSourceOptions = {}
): RelationSource {
  const relationName = options.relationName ?? 'materialized';
  return {
    relationNames: [relationName],
    rows: () => []
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
  switch (options.kind) {
    case 'hash':
      return materializationHashIndexResult<Row, Value>(input, target);
    case 'btree':
      return { kind: 'materializationBtreeIndex', indexed: false, diagnostics: [unsupportedIndexDiagnostic()] };
    case 'unique':
      return { kind: 'materializationUniqueIndex', indexed: false, diagnostics: [unsupportedIndexDiagnostic()] };
    default:
      return snapshotIndex(input, target);
  }
}

export function snapshotIndex<Row = unknown>(
  _input: unknown,
  _target: string | Query<Row> | MaterializationMetadata<Row>
): MaterializationIndexResult<Row> {
  return {
    kind: 'materializationIndex',
    indexed: false,
    diagnostics: [missingDiagnostic()]
  };
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
  _fieldOrOptions: string | { readonly field: string }
): MaterializationHashIndexResult<Row, Value> {
  return materializationHashIndexResult<Row, Value>(input, target);
}

function materializationHashIndexResult<Row, Value>(
  _input: unknown,
  _target: string | Query<Row> | MaterializationMetadata<Row>
): MaterializationHashIndexResult<Row, Value> {
  return {
    kind: 'materializationHashIndex',
    indexed: false,
    diagnostics: [missingDiagnostic()]
  };
}

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function markMaterialized<Db extends object>(db: Db): Db & MaterializedDb {
  materializedDbs.add(db);
  return db as Db & MaterializedDb;
}

function markMaintainedMaterialized<Db extends object>(
  db: Db
): Db & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult } {
  materializedDbs.add(db);
  return db as Db & MaterializedDb & { readonly materializations?: MaterializationMaintenanceResult };
}

function isObject(input: unknown): input is object {
  return typeof input === 'object' && input !== null;
}

function unsupportedDiagnostic(): UnsupportedMaterializationDiagnostic {
  return {
    code: 'materialization_unsupported',
    message: 'materialization implementation has been removed; regenerate this API implementation',
    surface: 'materialization'
  };
}

function missingDiagnostic(): MissingMaterializationDiagnostic {
  return {
    code: 'materialization_missing',
    message: 'materialization implementation has been removed; regenerate this API implementation',
    surface: 'materialization'
  };
}

function unsupportedIndexDiagnostic(): UnsupportedMaterializationIndexDiagnostic {
  return {
    code: 'materialization_index_unsupported',
    message: 'materialization index implementation has been removed; regenerate this API implementation',
    surface: 'materialization'
  };
}
