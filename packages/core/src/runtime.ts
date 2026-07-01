import type { TarstateDiagnostic } from './diagnostics.js';
import { tryTransact, type Db, type DbTransactionInput, type DbTransactionInputs, type DbTransactionResult } from './db.js';
import type { RelationDelta } from './delta.js';
import {
  isRelationAdapter,
  isRelationRuntime,
  tryApplyRelationPatches,
  tryCommitAdapter,
  type AdapterSource,
  type RelationApplyDurability,
  type RelationRuntime
} from './adapter.js';
import type {
  MaterializationDiagnostic,
  MaterializationMaintenanceResult
} from './materialization.js';
import type {
  TrackedChange,
  WatchDb,
  WatchDiagnostic,
  WatchRuntimeDiagnostic
} from './watch.js';
import { trackWatchedChanges } from './watch-tracking.js';
import type { WritePatch } from './write.js';

export type TrackTransactDiagnostic = WatchRuntimeDiagnostic | MaterializationDiagnostic | TarstateDiagnostic;
export type TrackRuntimeCommitDiagnostic = TrackTransactDiagnostic;
export type TrackTransactOutput<Db extends WatchDb = WatchDb> = Db | TrackTransactEnvelope<Db>;
export type TrackTransactCallback<Db extends WatchDb, Result extends TrackTransactOutput<Db>> =
  (db: Db) => Result | Promise<Result>;
export type TrackTransactOptions = {
  readonly label?: string;
  readonly throwOnUnsupported?: boolean;
};
export type TrackRuntimeCommitOptions = TrackTransactOptions & {
  readonly readVersion?: boolean;
};
export type TrackTransactResult<Db extends WatchDb = WatchDb> = {
  readonly kind: 'trackTransact';
  readonly db: Db;
  readonly result?: DbTransactionResult;
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
  'runtime' | 'status' | 'applied' | 'changes' | 'deltas'
> & {
  readonly runtime: unknown;
  readonly source?: AdapterSource<Version>;
  readonly supported: false;
  readonly status: 'rejected';
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

export class UnsupportedChangeTrackingError extends Error {
  readonly code = 'change_tracking_unsupported';
  readonly diagnostics: readonly WatchDiagnostic[];

  constructor(diagnostic: WatchDiagnostic) {
    super(diagnostic.message);
    this.name = 'UnsupportedChangeTrackingError';
    this.diagnostics = [diagnostic];
  }
}

export function trackTransact<Db extends WatchDb, Result extends TrackTransactOutput<Db>>(
  db: Db,
  transact: TrackTransactCallback<Db, Result>,
  options?: TrackTransactOptions
): Promise<TrackTransactResult<Db>>;
export function trackTransact(
  db: Db,
  ...inputs: DbTransactionInputs
): Promise<TrackTransactResult<Db>>;
export async function trackTransact(
  db: WatchDb,
  transactOrInput?: unknown,
  ...rest: readonly unknown[]
): Promise<TrackTransactResult<WatchDb>> {
  const typedRest = rest as readonly (DbTransactionInput | TrackTransactOptions)[];
  if (transactOrInput === undefined || typeof transactOrInput !== 'function' || isWriteTransactionInput(typedRest)) {
    const args = (transactOrInput === undefined ? rest : [transactOrInput, ...rest]) as readonly (
      DbTransactionInput | TrackTransactOptions
    )[];
    const inputs = args.filter((input): input is DbTransactionInput => !isTrackTransactOptions(input));
    const options = args.find(isTrackTransactOptions);
    if (!isDb(db)) {
      const diagnostic = unsupportedDiagnostic();
      if (options?.throwOnUnsupported === true) {
        throw new UnsupportedChangeTrackingError(diagnostic);
      }
      return {
        kind: 'trackTransact',
        db,
        supported: false,
        changes: [],
        deltas: [],
        diagnostics: [diagnostic],
        ...(options?.label === undefined ? {} : { label: options.label })
      };
    }

    const result = tryTransact(db, ...inputs);
    const tracked = result.committed
      ? await trackWatchedChanges(db, result.db, result.deltas)
      : { changes: [], diagnostics: [] };

    return {
      kind: 'trackTransact',
      db: result.db,
      result,
      supported: true,
      changes: tracked.changes,
      deltas: result.deltas,
      diagnostics: [...result.diagnostics, ...tracked.diagnostics]
    };
  }

  const options = (typedRest[0] ?? {}) as TrackTransactOptions;
  const transact = transactOrInput as TrackTransactCallback<WatchDb, TrackTransactOutput<WatchDb>>;
  const output: TrackTransactOutput<WatchDb> = await transact(db);
  const envelope = isTrackEnvelope(output);
  const nextDb = envelope ? output.db : output;
  const tracked = await trackWatchedChanges(db, nextDb, envelope ? output.deltas ?? [] : []);
  return {
    kind: 'trackTransact',
    db: nextDb,
    supported: true,
    changes: tracked.changes.length > 0 ? tracked.changes : deltasToChanges(envelope ? output.deltas ?? [] : []),
    deltas: envelope ? output.deltas ?? [] : [],
    diagnostics: [...(envelope ? output.diagnostics ?? [] : []), ...tracked.diagnostics],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

export function trackTransactPatches(
  _db: WatchDb,
  patches: Iterable<WritePatch>
): readonly WritePatch[] {
  return Array.from(patches);
}

export function trackRuntimeCommit<Version = unknown>(
  runtime: RelationRuntime<Version>,
  patches: Iterable<WritePatch>,
  options?: TrackRuntimeCommitOptions
): Promise<TrackRuntimeCommitResult<Version>>;
export function trackRuntimeCommit(
  runtime: unknown,
  patches: Iterable<WritePatch>,
  options?: TrackRuntimeCommitOptions
): Promise<TrackRuntimeCommitResult<unknown>>;
export async function trackRuntimeCommit<Version = unknown>(
  runtime: unknown,
  patches: Iterable<WritePatch>,
  options: TrackRuntimeCommitOptions = {}
): Promise<TrackRuntimeCommitResult<Version>> {
  const patchList = Array.from(patches);

  if (isRelationAdapter<Version>(runtime)) {
    const report = await tryCommitAdapter(runtime, patchList, options);
    return {
      kind: 'trackRuntimeCommit',
      runtime,
      source: report.source,
      supported: true,
      status: report.status,
      patches: report.patches,
      applied: report.applied,
      changes: deltasToChanges(report.deltas),
      deltas: report.deltas,
      diagnostics: report.diagnostics,
      ...(report.version === undefined ? {} : { version: report.version }),
      ...(report.durability === undefined ? {} : { durability: report.durability }),
      ...(options.label === undefined ? {} : { label: options.label })
    };
  }

  if (isRelationRuntime<Version>(runtime)) {
    const report = await tryApplyRelationPatches(runtime, patchList, options);
    return {
      kind: 'trackRuntimeCommit',
      runtime,
      source: report.source,
      supported: true,
      status: report.status,
      patches: report.patches,
      applied: report.applied,
      changes: deltasToChanges(report.deltas),
      deltas: report.deltas,
      diagnostics: report.diagnostics,
      ...(report.version === undefined ? {} : { version: report.version }),
      ...(report.durability === undefined ? {} : { durability: report.durability }),
      ...(options.label === undefined ? {} : { label: options.label })
    };
  }

  return {
    kind: 'trackRuntimeCommit',
    runtime,
    supported: false,
    status: 'rejected',
    patches: patchList.length,
    applied: 0,
    changes: [],
    deltas: [],
    diagnostics: [unsupportedDiagnostic()],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function isTrackEnvelope<Db extends WatchDb>(input: TrackTransactOutput<Db>): input is TrackTransactEnvelope<Db> {
  return typeof input === 'object' && input !== null && 'db' in input;
}

function isDb(input: WatchDb): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

function isWriteTransactionInput(inputs: readonly (DbTransactionInput | TrackTransactOptions)[]): boolean {
  return inputs.some((input) => !isTrackTransactOptions(input));
}

function isTrackTransactOptions(input: DbTransactionInput | TrackTransactOptions): input is TrackTransactOptions {
  return typeof input === 'object' &&
    input !== null &&
    !('op' in input) &&
    !(Symbol.iterator in input) &&
    ('label' in input || 'throwOnUnsupported' in input);
}

function unsupportedDiagnostic(): WatchDiagnostic {
  return {
    code: 'change_tracking_unsupported',
    message: 'runtime tracking implementation has been removed; regenerate this API implementation',
    surface: 'changeTracking'
  };
}

function deltasToChanges(deltas: readonly RelationDelta[]): readonly TrackedChange[] {
  return deltas.map((delta, index) => ({
    kind: 'trackedChange',
    id: `delta-${index + 1}`,
    target: delta.relation,
    changed: delta.added.length > 0 || delta.removed.length > 0,
    previousRows: delta.removed,
    rows: delta.added,
    addedRows: delta.added,
    removedRows: delta.removed,
    unchangedRows: [],
    rowChanges: [
      ...delta.removed.map((row) => ({ kind: 'removed' as const, key: JSON.stringify(row), row })),
      ...delta.added.map((row) => ({ kind: 'added' as const, key: JSON.stringify(row), row }))
    ],
    diagnostics: []
  }));
}
