import type { RelationDelta } from './delta.js';
import {
  materializationsFor,
  materializedRowsFor,
  type MaterializationMaintenanceResult
} from './materialization.js';
import type { RelationSource } from './source.js';
import {
  diffOptionsForTarget,
  isWatchMaterialization,
  trackedChangeFromMaterializationChange,
  trackedChangesForDbTransition,
  watchTargetKey
} from './watch.js';
import type { TrackedChange, WatchDb, WatchRuntimeDiagnostic } from './watch.js';
import { diffRows, rowDiffKey, type RowDiffOptions } from './diff.js';

export async function trackWatchedChanges(
  dbBefore: WatchDb | RelationSource,
  dbAfter: WatchDb | RelationSource,
  deltas: readonly RelationDelta[] | undefined,
  materializations?: MaterializationMaintenanceResult
): Promise<{
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
}> {
  const watched = await trackedChangesForDbTransition(dbBefore, dbAfter, deltas ?? [], materializations?.changes ?? []);
  const materialized = materializations === undefined
    ? materializedChangesForTransition(dbBefore, dbAfter)
    : materializedChangesFromMaintenance(dbBefore, dbAfter, materializations);

  return {
    changes: [...watched.changes, ...materialized.changes],
    diagnostics: [...watched.diagnostics, ...materialized.diagnostics]
  };
}

function materializedChangesFromMaintenance(
  before: WatchDb | RelationSource,
  after: WatchDb | RelationSource,
  materializations: MaterializationMaintenanceResult
): {
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
} {
  return {
    changes: materializations.changes.filter((change) =>
      !isWatchMaterialization(before, change.query) && !isWatchMaterialization(after, change.query)
    ).map((change) => trackedChangeFromMaterializationChange(change)),
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
    if (isWatchMaterialization(before, metadata.query) || isWatchMaterialization(after, metadata.query)) {
      continue;
    }

    const previousRows = materializedRowsFor(before, metadata.id) ?? [];
    const rows = materializedRowsFor(after, metadata.id) ?? [];
    const diff = diffRows(previousRows, rows, diffOptionsForTarget(metadata.query, {}));
    diagnostics.push(...diff.diagnostics);
    const added = diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
    const removed = diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
    changes.push({
      kind: 'trackedChange',
      id: metadata.id,
      targetKey: watchTargetKey(metadata.query),
      target: metadata.query,
      changed: diff.changes.length > 0,
      previousRows,
      rows,
      added,
      removed,
      unchanged: rowsUnchangedByChanges(rows, diff.changes, diffOptionsForTarget(metadata.query, {})),
      rowChanges: diff.changes,
      diagnostics: diff.diagnostics
    });
  }

  return { changes, diagnostics };
}

function rowsUnchangedByChanges<Row>(
  rows: readonly Row[],
  changes: readonly { readonly key: string }[],
  options: RowDiffOptions<Row>
): readonly Row[] {
  const changedKeys = new Set(changes.map((change) => change.key));
  return rows.filter((row) => !changedKeys.has(rowDiffKey(row, options)));
}
