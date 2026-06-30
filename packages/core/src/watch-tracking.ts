import { relationDeltaNames } from './delta.js';
import { diffRows, type RowDiff, type RowDiffDiagnostic } from './diff.js';
import type {
  MaterializationMaintenanceChange,
  MaterializationMaintenanceResult
} from './materialization.js';
import {
  dependencies,
  queryKey,
  type Query
} from './query.js';
import type { RelationSource } from './source.js';
import {
  activeWatchRegistrations,
  deliverWatchEvent,
  isWatchClosed,
  type WatchRegistration
} from './watch-registry.js';
import { readWatchRows } from './watch-read.js';
import {
  diffOptionsForTarget,
  type ChangeSet,
  type TrackedChange,
  type WatchDb,
  type WatchRuntimeDiagnostic,
  type WatchTarget
} from './watch.js';

type MaterializationChangeIndex = {
  readonly byQueryKey: ReadonlyMap<string, MaterializationMaintenanceChange>;
  readonly ambiguousQueryKeys: ReadonlySet<string>;
};

type MaterializedTrackedRows = {
  readonly previousRows: readonly unknown[];
  readonly rows: readonly unknown[];
};

/** Track registered watch targets across two source snapshots, reusing maintained materialization changes when safe. */
export async function trackWatchedChanges(
  db: WatchDb,
  sourceBefore: RelationSource,
  sourceAfter: RelationSource,
  changes: ChangeSet = emptyChangeSet(),
  materializations?: MaterializationMaintenanceResult
): Promise<readonly TrackedChange[]> {
  const changedRelations = changedRelationNames(changes);
  const materializationChanges = materializationChangeIndex(materializations);
  const registrations = activeWatchRegistrations(db).filter((registration) =>
    isTargetAffectedByChanges(registration.target, changedRelations)
  );

  return Promise.all(
    registrations.map(async (registration) =>
      trackedChange(registration, sourceBefore, sourceAfter, changes, materializationChanges)
    )
  );
}

async function trackedChange(
  registration: WatchRegistration,
  sourceBefore: RelationSource,
  sourceAfter: RelationSource,
  changes: ChangeSet,
  materializationChanges: MaterializationChangeIndex
): Promise<TrackedChange> {
  const materialized = materializedTrackedRows(registration, materializationChanges);

  if (materialized !== undefined) {
    return deliverTrackedChange(registration, materialized.previousRows, materialized.rows, changes);
  }

  const [before, after] = await Promise.all([
    readWatchRows(sourceBefore, registration.target, registration.options),
    readWatchRows(sourceAfter, registration.target, registration.options)
  ]);

  return deliverTrackedChange(
    registration,
    before.rows,
    after.rows,
    changes,
    [...before.diagnostics, ...after.diagnostics]
  );
}

async function deliverTrackedChange(
  registration: WatchRegistration,
  previousRows: readonly unknown[],
  rows: readonly unknown[],
  changes: ChangeSet,
  readDiagnostics: readonly WatchRuntimeDiagnostic[] = []
): Promise<TrackedChange> {
  const rowDiff = diffRows(previousRows, rows, diffOptionsForTarget(registration.target, registration.options));
  const diagnostics = [...readDiagnostics, ...rowChangeDiagnostics(rowDiff)];
  const resultDiff = visibleRowDiff(rowDiff);

  registration.setPreviousRows(rows);

  if (!isWatchClosed(registration.id)) {
    const listenerDiagnostics = await deliverWatchEvent(registration.listener, {
      kind: 'watchEvent',
      id: registration.id,
      target: registration.target,
      changed: rowDiffChanged(resultDiff),
      previousRows,
      rows,
      ...resultDiff,
      changes,
      diagnostics
    });

    return {
      kind: 'trackedChange',
      id: registration.id,
      target: registration.target,
      changed: rowDiffChanged(resultDiff),
      previousRows,
      rows,
      ...resultDiff,
      diagnostics: [...diagnostics, ...listenerDiagnostics]
    };
  }

  return {
    kind: 'trackedChange',
    id: registration.id,
    target: registration.target,
    changed: rowDiffChanged(resultDiff),
    previousRows,
    rows,
    ...resultDiff,
    diagnostics
  };
}

function materializedTrackedRows(
  registration: WatchRegistration,
  materializationChanges: MaterializationChangeIndex
): MaterializedTrackedRows | undefined {
  const target = registration.target;

  if (!isQuery(target) || queryUsesRuntimeInputs(target)) {
    return undefined;
  }

  const key = queryKey(target);

  if (materializationChanges.ambiguousQueryKeys.has(key)) {
    return undefined;
  }

  const change = materializationChanges.byQueryKey.get(key);

  if (!isCompleteMaterializationChange(change)) {
    return undefined;
  }

  const structuralDiff = diffRows(change.previousRows, change.rows);

  if (
    !sameRowSequence(structuralDiff.addedRows, change.addedRows) ||
    !sameRowSequence(structuralDiff.removedRows, change.removedRows)
  ) {
    return undefined;
  }

  return {
    previousRows: change.previousRows,
    rows: change.rows
  };
}

function materializationChangeIndex(
  materializations: MaterializationMaintenanceResult | undefined
): MaterializationChangeIndex {
  const byQueryKey = new Map<string, MaterializationMaintenanceChange>();
  const ambiguousQueryKeys = new Set<string>();

  for (const change of materializations?.changes ?? []) {
    if (ambiguousQueryKeys.has(change.queryKey)) {
      continue;
    }

    if (byQueryKey.has(change.queryKey)) {
      byQueryKey.delete(change.queryKey);
      ambiguousQueryKeys.add(change.queryKey);
      continue;
    }

    byQueryKey.set(change.queryKey, change);
  }

  return { byQueryKey, ambiguousQueryKeys };
}

function isCompleteMaterializationChange(
  change: MaterializationMaintenanceChange | undefined
): change is MaterializationMaintenanceChange & { readonly previousRows: readonly unknown[] } {
  return change !== undefined &&
    change.previousRowsAvailable &&
    change.previousRows !== undefined &&
    change.diagnostics.length === 0;
}

function sameRowSequence(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((row, index) => row === right[index]);
}

function queryUsesRuntimeInputs(query: Query): boolean {
  return queryPartUsesRuntimeInputs(query.data);
}

// Materialization changes do not expose the EvaluateOptions used to compute their rows.
function queryPartUsesRuntimeInputs(input: unknown): boolean {
  if (Array.isArray(input)) {
    return input.some(queryPartUsesRuntimeInputs);
  }

  if (!isRecord(input)) {
    return false;
  }

  if (input.op === 'env' || input.op === 'call') {
    return true;
  }

  return Object.values(input).some(queryPartUsesRuntimeInputs);
}

function changedRelationNames(changes: ChangeSet): ReadonlySet<string> | undefined {
  if (changes.deltas === undefined) {
    return undefined;
  }

  return relationDeltaNames(changes.deltas);
}

function isTargetAffectedByChanges(target: WatchTarget, changedRelations: ReadonlySet<string> | undefined): boolean {
  if (changedRelations === undefined) {
    return true;
  }

  const targetRelations = isQuery(target) ? dependencies(target) : [target.name];
  return targetRelations.some((relationName) => changedRelations.has(relationName));
}

function emptyChangeSet(): ChangeSet {
  return { diagnostics: [] };
}

function visibleRowDiff<Row>(
  rowDiff: RowDiff<Row>
): Pick<RowDiff<Row>, 'addedRows' | 'removedRows' | 'unchangedRows' | 'rowChanges'> {
  return {
    addedRows: rowDiff.addedRows,
    removedRows: rowDiff.removedRows,
    unchangedRows: rowDiff.unchangedRows,
    rowChanges: rowDiff.rowChanges
  };
}

function rowDiffChanged<Row>(rowDiff: Pick<RowDiff<Row>, 'addedRows' | 'removedRows' | 'rowChanges'>): boolean {
  return rowDiff.addedRows.length > 0 || rowDiff.removedRows.length > 0 || rowDiff.rowChanges.length > 0;
}

function rowChangeDiagnostics<Row>(rowDiff: RowDiff<Row>): readonly RowDiffDiagnostic<Row>[] {
  return rowDiff.rowChangeDiagnostics ?? [];
}

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
