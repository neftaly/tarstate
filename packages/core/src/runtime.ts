import type { TarstateDiagnostic } from './diagnostics.js';
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

export async function trackTransact<Db extends WatchDb, Result extends TrackTransactOutput<Db>>(
  db: Db,
  transact: TrackTransactCallback<Db, Result>,
  options: TrackTransactOptions = {}
): Promise<TrackTransactResult<Db>> {
  const output: TrackTransactOutput<Db> = await transact(db);
  const envelope = isTrackEnvelope(output);
  const nextDb = envelope ? output.db : output;
  return {
    kind: 'trackTransact',
    db: nextDb,
    supported: false,
    changes: [],
    deltas: envelope ? output.deltas ?? [] : [],
    diagnostics: [unsupportedDiagnostic()],
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
      changes: [],
      deltas: report.deltas,
      diagnostics: [unsupportedDiagnostic(), ...report.diagnostics],
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
      changes: [],
      deltas: report.deltas,
      diagnostics: [unsupportedDiagnostic(), ...report.diagnostics],
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

function unsupportedDiagnostic(): WatchDiagnostic {
  return {
    code: 'change_tracking_unsupported',
    message: 'runtime tracking implementation has been removed; regenerate this API implementation',
    surface: 'changeTracking'
  };
}
