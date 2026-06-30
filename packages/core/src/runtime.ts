import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './delta.js';
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

export type TrackTransactDiagnostic = WatchRuntimeDiagnostic | MaterializationDiagnostic | TarstateDiagnostic;

export type TrackTransactOutput<Db extends WatchDb = WatchDb> =
  | Db
  | TrackTransactEnvelope<Db>;
export type TrackTransactCallback<Db extends WatchDb, Result extends TrackTransactOutput<Db>> =
  (db: Db) => Result | Promise<Result>;

export type TrackTransactOptions = {
  readonly label?: string;
  readonly throwOnUnsupported?: boolean;
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

type TrackTransactEnvelope<Db extends WatchDb> = {
  readonly db: Db;
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
