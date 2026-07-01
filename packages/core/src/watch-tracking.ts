import type { RelationDelta } from './delta.js';
import {
  materializationsFor,
  materializedRowsFor,
  type MaterializationMaintenanceResult
} from './materialization.js';
import type { RelationSource } from './source.js';
import { diffOptionsForTarget, trackedChangesForDbTransition } from './watch.js';
import type { TrackedChange, WatchDb, WatchRuntimeDiagnostic } from './watch.js';
import { diffRows } from './diff.js';

export async function trackWatchedChanges(
  dbBefore: WatchDb | RelationSource,
  dbAfter: WatchDb | RelationSource,
  deltas: readonly RelationDelta[] | undefined,
  materializations?: MaterializationMaintenanceResult
): Promise<{
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
}> {
  const watched = await trackedChangesForDbTransition(dbBefore, dbAfter, deltas ?? []);
  const materialized = materializations === undefined
    ? materializedChangesForTransition(dbBefore, dbAfter)
    : materializedChangesFromMaintenance(materializations);

  return {
    changes: [...watched.changes, ...materialized.changes],
    diagnostics: [...watched.diagnostics, ...materialized.diagnostics]
  };
}

function materializedChangesFromMaintenance(
  materializations: MaterializationMaintenanceResult
): {
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
} {
  return {
    changes: materializations.changes.map((change) => ({
      kind: 'trackedChange',
      id: change.id,
      target: change.query,
      changed: change.rowChanges.length > 0,
      previousRows: change.previousRows ?? [],
      rows: change.rows,
      addedRows: change.addedRows,
      removedRows: change.removedRows,
      unchangedRows: unchangedRows(change.rows, change.rowChanges),
      rowChanges: change.rowChanges,
      diagnostics: change.diagnostics
    })),
    diagnostics: materializations.diagnostics
  };
}

function materializedChangesForTransition(
  before: WatchDb | RelationSource,
  after: WatchDb | RelationSource
): {
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
} {
  const changes: TrackedChange[] = [];
  const diagnostics: WatchRuntimeDiagnostic[] = [];

  for (const metadata of materializationsFor(before)) {
    const previousRows = materializedRowsFor(before, metadata.id) ?? [];
    const rows = materializedRowsFor(after, metadata.id) ?? [];
    const diff = diffRows(previousRows, rows, diffOptionsForTarget(metadata.query, {}));
    diagnostics.push(...diff.diagnostics);
    changes.push({
      kind: 'trackedChange',
      id: metadata.id,
      target: metadata.query,
      changed: diff.changes.length > 0,
      previousRows,
      rows,
      addedRows: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
      removedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
      unchangedRows: unchangedRows(rows, diff.changes),
      rowChanges: diff.changes,
      diagnostics: diff.diagnostics
    });
  }

  return { changes, diagnostics };
}

function unchangedRows<Row>(rows: readonly Row[], changes: readonly { readonly key: string }[]): readonly Row[] {
  const changedKeys = new Set(changes.map((change) => change.key));
  return rows.filter((row) => !changedKeys.has(JSON.stringify(row)));
}
