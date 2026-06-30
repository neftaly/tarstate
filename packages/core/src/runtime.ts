import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './delta.js';
import {
  isRelationAdapter,
  isRelationRuntime,
  tryApplyRelationPatches,
  tryCommitAdapter,
  type AdapterCommitResult,
  type AdapterSnapshot,
  type AdapterSource,
  type RelationAdapter,
  type RelationApplyDurability,
  type RelationApplyResult,
  type RelationRuntime
} from './adapter.js';
import {
  attachedConstraintsFor,
  transferConstraintAttachments
} from './constraints-attachment.js';
import { validateConstraints } from './constraints-validation.js';
import {
  maintainMaterializationSnapshots,
  type MaterializationDiagnostic,
  type MaterializationMaintenanceResult,
  type SnapshotMaterializationTarget
} from './materialization.js';
import { isObjectBackedRelationData, tryRelationSource } from './source-input.js';
import type { RelationSource } from './source.js';
import {
  type TrackedChange,
  type WatchDb,
  type WatchDiagnostic,
  type WatchRuntimeDiagnostic
} from './watch.js';
import { transferWatchRegistrations } from './watch-registry.js';
import { trackWatchedChanges } from './watch-tracking.js';
import type { WritePatch } from './write.js';

export type TrackTransactDiagnostic = WatchRuntimeDiagnostic | MaterializationDiagnostic | TarstateDiagnostic;
export type TrackRuntimeCommitDiagnostic = TrackTransactDiagnostic;

export type TrackTransactOutput<Db extends WatchDb = WatchDb> =
  | Db
  | TrackTransactEnvelope<Db>;
export type TrackTransactCallback<Db extends WatchDb, Result extends TrackTransactOutput<Db>> =
  (db: Db) => Result | Promise<Result>;

export type TrackTransactOptions = {
  readonly label?: string;
  readonly throwOnUnsupported?: boolean;
};
export type TrackRuntimeCommitOptions = TrackTransactOptions & {
  /** Read `runtime.source.version()` when the apply/commit result omits a version. Defaults to true. */
  readonly readVersion?: boolean;
};

export type TrackTransactResult<Db extends WatchDb = WatchDb> = {
  readonly kind: 'trackTransact';
  readonly db: Db;
  readonly supported: boolean;
  readonly changes: readonly TrackedChange[];
  readonly deltas: readonly RelationDelta[];
  readonly materializations?: MaterializationMaintenanceResult;
  readonly diagnostics: readonly TrackTransactDiagnostic[];
  readonly label?: string;
};
export type TrackRuntimeCommitStatus = 'accepted' | 'partial' | 'rejected';
type TrackRuntimeCommitResultBase<Version = unknown> = {
  readonly kind: 'trackRuntimeCommit';
  readonly runtime: RelationRuntime<Version>;
  readonly status: TrackRuntimeCommitStatus;
  readonly accepted: boolean;
  readonly patches: number;
  readonly applied: number;
  readonly changes: readonly TrackedChange[];
  readonly deltas: readonly RelationDelta[];
  readonly materializations?: MaterializationMaintenanceResult;
  readonly diagnostics: readonly TrackRuntimeCommitDiagnostic[];
  readonly version?: Version;
  readonly durability?: RelationApplyDurability;
  readonly label?: string;
};
export type TrackRuntimeCommitSupportedResult<Version = unknown> = TrackRuntimeCommitResultBase<Version> & {
  readonly source: AdapterSource<Version>;
  readonly supported: true;
};
export type TrackRuntimeCommitUnsupportedResult<Version = unknown> = Omit<
  TrackRuntimeCommitResultBase<Version>,
  'runtime' | 'status' | 'accepted' | 'applied' | 'changes' | 'deltas'
> & {
  readonly runtime: unknown;
  readonly source?: AdapterSource<Version> | undefined;
  readonly supported: false;
  readonly status: 'rejected';
  readonly accepted: false;
  readonly applied: 0;
  readonly changes: readonly [];
  readonly deltas: readonly [];
};
export type TrackRuntimeCommitResult<Version = unknown> =
  | TrackRuntimeCommitSupportedResult<Version>
  | TrackRuntimeCommitUnsupportedResult<Version>;

type TrackTransactEnvelope<Db extends WatchDb> = {
  readonly db: Db;
  readonly committed?: boolean;
  readonly deltas?: readonly RelationDelta[];
  readonly diagnostics?: readonly TrackTransactDiagnostic[];
};
type ConstraintEnforcementResult =
  | {
    readonly kind: 'none' | 'valid' | 'skipped';
    readonly diagnostics: readonly TarstateDiagnostic[];
  }
  | {
    readonly kind: 'invalid' | 'unsupported';
    readonly diagnostics: readonly TarstateDiagnostic[];
  };
type RuntimeCommitReport<Version> = Pick<
  TrackRuntimeCommitSupportedResult<Version>,
  'status' | 'accepted' | 'patches' | 'applied' | 'deltas' | 'diagnostics' | 'source' | 'version' | 'durability'
>;
type RuntimePatchAttempt<Version> = {
  readonly report: RuntimeCommitReport<Version>;
  readonly deltas: readonly RelationDelta[] | undefined;
};

export class UnsupportedChangeTrackingError extends Error {
  readonly code = 'change_tracking_unsupported';
  readonly diagnostics: readonly WatchDiagnostic[];

  constructor(diagnostic: WatchDiagnostic) {
    super(diagnostic.message);
    this.name = 'UnsupportedChangeTrackingError';
    this.diagnostics = [diagnostic];
  }
}

/**
 * Run a transaction callback, maintain snapshot materializations, and report watched target changes.
 *
 * @remarks This is recompute-backed orchestration. Future incremental maintenance should keep this result shape.
 */
export async function trackTransact<Db extends WatchDb, Result extends TrackTransactOutput<Db>>(
  db: Db,
  transact: TrackTransactCallback<Db, Result>,
  options: TrackTransactOptions = {}
): Promise<TrackTransactResult<Db>> {
  const sourceBefore = sourceForRuntime(db);

  if (sourceBefore === undefined) {
    return unsupportedTrackTransactResult(db, options);
  }

  const output = await transact(db);
  const nextDb = trackedOutputDb(output);
  const sourceAfter = sourceForRuntime(nextDb);
  const deltas = trackedOutputDeltas(output);

  if (sourceAfter === undefined) {
    return unsupportedTrackTransactResult(nextDb, options);
  }

  const constraintEnforcement = await enforceAttachedConstraints(db, nextDb, output);

  if (constraintEnforcement.kind === 'invalid') {
    return {
      kind: 'trackTransact',
      db,
      supported: true,
      changes: [],
      deltas: [],
      diagnostics: [
        ...trackedOutputDiagnostics(output),
        ...constraintEnforcement.diagnostics
      ],
      ...(options.label === undefined ? {} : { label: options.label })
    };
  }

  const materializationMaintenance = await maintainMaterializationSnapshots(
    db,
    nextDb as SnapshotMaterializationTarget,
    trackedMaterializationOptions(deltas)
  );
  const changes = await trackWatchedChanges(
    db,
    sourceBefore,
    sourceAfter,
    trackedChangeSet(deltas),
    materializationMaintenance
  );
  const diagnostics = [
    ...trackedOutputDiagnostics(output),
    ...constraintEnforcement.diagnostics,
    ...materializationMaintenance.diagnostics,
    ...changes.flatMap((change) => change.diagnostics)
  ];

  transferConstraintAttachments(db, nextDb);
  transferWatchRegistrations(db, nextDb);

  return {
    kind: 'trackTransact',
    db: nextDb,
    supported: true,
    changes,
    deltas: deltas ?? [],
    materializations: materializationMaintenance,
    diagnostics,
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

/**
 * Apply relation patches through a runtime/adapter, maintain materialized snapshots, and report watched changes.
 *
 * @remarks Relation deltas are used for tracking only when the runtime/adapter actually reports a `deltas`
 * property. Missing deltas are treated as unknown and force recompute-backed tracking.
 */
export function trackRuntimeCommit<Version = unknown>(
  runtime: RelationAdapter<Version>,
  patches: Iterable<WritePatch>,
  options?: TrackRuntimeCommitOptions
): Promise<TrackRuntimeCommitSupportedResult<Version>>;
export function trackRuntimeCommit<Version = unknown>(
  runtime: RelationRuntime<Version>,
  patches: Iterable<WritePatch>,
  options?: TrackRuntimeCommitOptions
): Promise<TrackRuntimeCommitSupportedResult<Version>>;
export function trackRuntimeCommit(
  runtime: unknown,
  patches: Iterable<WritePatch>,
  options?: TrackRuntimeCommitOptions
): Promise<TrackRuntimeCommitResult>;
export async function trackRuntimeCommit<Version = unknown>(
  runtime: unknown,
  patches: Iterable<WritePatch>,
  options: TrackRuntimeCommitOptions = {}
): Promise<TrackRuntimeCommitResult<Version>> {
  const patchList = Array.from(patches);

  if (!isRelationRuntime(runtime) && !isRelationAdapter(runtime)) {
    return unsupportedTrackRuntimeCommitResult(runtime, patchList.length, options);
  }

  const trackedRuntime = runtime as RelationRuntime<Version> | RelationAdapter<Version>;
  const snapshotBefore = runtimeSnapshot(trackedRuntime);
  const attempt = await applyRuntimePatches(trackedRuntime, patchList, options);
  const report = attempt.report;

  if (report.status === 'rejected') {
    return {
      kind: 'trackRuntimeCommit',
      runtime: trackedRuntime,
      source: report.source,
      supported: true,
      status: report.status,
      accepted: report.accepted,
      patches: report.patches,
      applied: report.applied,
      changes: [],
      deltas: [],
      diagnostics: [
        ...snapshotDiagnostics(snapshotBefore),
        ...report.diagnostics
      ],
      ...versionProperty(report.version),
      ...durabilityProperty(report.durability),
      ...(options.label === undefined ? {} : { label: options.label })
    };
  }

  const snapshotAfter = runtimeSnapshot(trackedRuntime);
  const materializationMaintenance = await maintainMaterializationSnapshots(
    trackedRuntime.source,
    trackedRuntime.source as SnapshotMaterializationTarget
  );
  const changes = await trackWatchedChanges(
    trackedRuntime.source,
    snapshotBefore.source,
    snapshotAfter.source,
    trackedChangeSet(attempt.deltas),
    materializationMaintenance
  );
  const diagnostics = [
    ...snapshotDiagnostics(snapshotBefore),
    ...report.diagnostics,
    ...snapshotDiagnostics(snapshotAfter),
    ...materializationMaintenance.diagnostics,
    ...changes.flatMap((change) => change.diagnostics)
  ];

  return {
    kind: 'trackRuntimeCommit',
    runtime: trackedRuntime,
    source: report.source,
    supported: true,
    status: report.status,
    accepted: report.accepted,
    patches: report.patches,
    applied: report.applied,
    changes,
    deltas: attempt.deltas ?? [],
    materializations: materializationMaintenance,
    diagnostics,
    ...versionProperty(report.version),
    ...durabilityProperty(report.durability),
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

async function applyRuntimePatches<Version>(
  runtime: RelationRuntime<Version> | RelationAdapter<Version>,
  patches: readonly WritePatch[],
  options: TrackRuntimeCommitOptions
): Promise<RuntimePatchAttempt<Version>> {
  return isRelationAdapter(runtime)
    ? applyAdapterRuntimePatches(runtime, patches, options)
    : applyRelationRuntimePatches(runtime, patches, options);
}

async function applyAdapterRuntimePatches<Version>(
  adapter: RelationAdapter<Version>,
  patches: readonly WritePatch[],
  options: TrackRuntimeCommitOptions
): Promise<RuntimePatchAttempt<Version>> {
  let reportedDeltas: readonly RelationDelta[] | undefined;
  const trackedAdapter: RelationAdapter<Version> = {
    source: adapter.source,
    commit: async (patchList) => {
      const result = await adapter.commit(patchList);
      reportedDeltas = ownDeltas(result);
      return result;
    }
  };
  const result = await tryCommitAdapter(trackedAdapter, patches, options);

  return {
    report: {
      status: adapterRuntimeStatus(result),
      accepted: result.status === 'committed',
      patches: result.patches,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: result.diagnostics,
      source: result.source,
      ...versionProperty(result.version)
    },
    deltas: reportedDeltas === undefined ? undefined : result.deltas
  };
}

async function applyRelationRuntimePatches<Version>(
  runtime: RelationRuntime<Version>,
  patches: readonly WritePatch[],
  options: TrackRuntimeCommitOptions
): Promise<RuntimePatchAttempt<Version>> {
  let reportedDeltas: readonly RelationDelta[] | undefined;
  const trackedRuntime: RelationRuntime<Version> = {
    source: runtime.source,
    ...(runtime.target === undefined
      ? {}
      : {
          target: {
            apply: async (patchList) => {
              const result = await runtime.target?.apply(patchList);
              reportedDeltas = ownDeltas(result);
              return result as RelationApplyResult<Version>;
            }
          }
        })
  };
  const result = await tryApplyRelationPatches(trackedRuntime, patches, options);

  return {
    report: {
      status: result.status,
      accepted: result.accepted,
      patches: result.patches,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: result.diagnostics,
      source: result.source,
      ...versionProperty(result.version),
      ...durabilityProperty(result.durability)
    },
    deltas: reportedDeltas === undefined ? undefined : result.deltas
  };
}

function runtimeSnapshot<Version>(
  runtime: RelationRuntime<Version>
): AdapterSnapshot<Version> {
  if (runtime.snapshot === undefined) {
    return { source: runtime.source };
  }

  try {
    return runtime.snapshot();
  } catch (error) {
    return {
      source: runtime.source,
      diagnostics: [runtimeSnapshotDiagnostic(error)]
    };
  }
}

function unsupportedTrackRuntimeCommitResult<Version>(
  runtime: unknown,
  patches: number,
  options: TrackRuntimeCommitOptions
): TrackRuntimeCommitUnsupportedResult<Version> {
  const diagnostic = unsupportedRuntimeCommitDiagnostic();

  if (options.throwOnUnsupported === true) {
    throw new UnsupportedChangeTrackingError(diagnostic);
  }

  return {
    kind: 'trackRuntimeCommit',
    runtime,
    source: (runtime as RelationRuntime<Version>).source,
    supported: false,
    status: 'rejected',
    accepted: false,
    patches,
    applied: 0,
    changes: [],
    deltas: [],
    diagnostics: [diagnostic],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function adapterRuntimeStatus(result: AdapterCommitResult): TrackRuntimeCommitStatus {
  return result.status === 'committed' ? 'accepted' : result.status;
}

function ownDeltas(input: unknown): readonly RelationDelta[] | undefined {
  if (!isRecord(input) || !Object.hasOwn(input, 'deltas')) {
    return undefined;
  }

  const deltas = input.deltas;
  return Array.isArray(deltas) ? deltas as readonly RelationDelta[] : undefined;
}

function snapshotDiagnostics(snapshot: AdapterSnapshot): readonly TarstateDiagnostic[] {
  return snapshot.diagnostics ?? [];
}

async function enforceAttachedConstraints<Db extends WatchDb>(
  previous: Db,
  next: Db,
  output: TrackTransactOutput<Db>
): Promise<ConstraintEnforcementResult> {
  const constraints = attachedConstraintsFor(previous);

  if (constraints.length === 0) {
    return { kind: 'none', diagnostics: [] };
  }

  if (trackedOutputDiagnostics(output).length > 0 || trackedOutputCommitted(output) === false) {
    return { kind: 'skipped', diagnostics: [] };
  }

  if (!isObjectBackedRelationData(previous) || !isObjectBackedRelationData(next)) {
    return {
      kind: 'unsupported',
      diagnostics: [unsupportedConstraintEnforcementDiagnostic(constraints.length)]
    };
  }

  const validation = await validateConstraints(sourceForRuntime(next) as RelationSource, constraints);

  return validation.valid
    ? { kind: 'valid', diagnostics: [] }
    : { kind: 'invalid', diagnostics: validation.diagnostics };
}

function unsupportedTrackTransactResult<Db extends WatchDb>(
  db: Db,
  options: TrackTransactOptions
): TrackTransactResult<Db> {
  const diagnostic = unsupportedChangeTrackingDiagnostic();

  if (options.throwOnUnsupported === true) {
    throw new UnsupportedChangeTrackingError(diagnostic);
  }

  return {
    kind: 'trackTransact',
    db,
    supported: false,
    changes: [],
    deltas: [],
    diagnostics: [diagnostic],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function trackedOutputDb<Db extends WatchDb>(output: TrackTransactOutput<Db>): Db {
  return isTrackedTransactionResult(output) ? output.db : output;
}

function trackedOutputDeltas<Db extends WatchDb>(output: TrackTransactOutput<Db>): readonly RelationDelta[] | undefined {
  return isTrackedTransactionResult(output) && Object.hasOwn(output, 'deltas') ? output.deltas : undefined;
}

function trackedOutputDiagnostics<Db extends WatchDb>(
  output: TrackTransactOutput<Db>
): readonly TrackTransactDiagnostic[] {
  return isTrackedTransactionResult(output) ? output.diagnostics ?? [] : [];
}

function trackedOutputCommitted<Db extends WatchDb>(output: TrackTransactOutput<Db>): boolean | undefined {
  if (!isTrackedTransactionResult(output) || !Object.hasOwn(output, 'committed')) {
    return undefined;
  }

  const committed = (output as { readonly committed?: unknown }).committed;
  return typeof committed === 'boolean' ? committed : undefined;
}

function isTrackedTransactionResult<Db extends WatchDb>(input: TrackTransactOutput<Db>): input is TrackTransactEnvelope<Db> {
  return isRecord(input) && 'db' in input;
}

function trackedMaterializationOptions(
  deltas: readonly RelationDelta[] | undefined
): { readonly deltas?: readonly RelationDelta[] } {
  return deltas === undefined ? {} : { deltas };
}

function trackedChangeSet(deltas: readonly RelationDelta[] | undefined): { readonly deltas?: readonly RelationDelta[]; readonly diagnostics: [] } {
  return deltas === undefined ? { diagnostics: [] } : { deltas, diagnostics: [] };
}

function sourceForRuntime(input: WatchDb | RelationSource): RelationSource | undefined {
  return tryRelationSource(input);
}

function unsupportedChangeTrackingDiagnostic(): WatchDiagnostic {
  return {
    code: 'change_tracking_unsupported',
    message: 'trackTransact requires a readable DB/source before and after the transaction',
    surface: 'changeTracking'
  };
}

function unsupportedRuntimeCommitDiagnostic(): WatchDiagnostic {
  return {
    code: 'change_tracking_unsupported',
    message: 'trackRuntimeCommit requires a readable RelationRuntime or RelationAdapter source',
    surface: 'changeTracking'
  };
}

function runtimeSnapshotDiagnostic(error: unknown): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: 'relation runtime snapshot failed',
    detail: error
  };
}

function unsupportedConstraintEnforcementDiagnostic(constraints: number): TarstateDiagnostic {
  return {
    code: 'unsupported_lookup',
    message: 'attached constraints can only be automatically enforced for object-backed DB transactions',
    detail: {
      surface: 'constraints',
      constraints
    }
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function versionProperty<Version>(version: Version | undefined): { readonly version?: Version } {
  return version === undefined ? {} : { version };
}

function durabilityProperty(
  durability: RelationApplyDurability | undefined
): { readonly durability?: RelationApplyDurability } {
  return durability === undefined ? {} : { durability };
}
