import type { RelationDelta } from './delta.js';
import type { MaterializationMaintenanceResult } from './materialization.js';
import type { RelationSource } from './source.js';
import type { TrackedChange, WatchDb, WatchRuntimeDiagnostic } from './watch.js';

export async function trackWatchedChanges(
  _dbBefore: WatchDb | RelationSource,
  _dbAfter: WatchDb | RelationSource,
  _deltas: readonly RelationDelta[] | undefined,
  _materializations?: MaterializationMaintenanceResult
): Promise<{
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
}> {
  return { changes: [], diagnostics: [] };
}
