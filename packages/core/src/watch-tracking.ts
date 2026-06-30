import { relationDeltaNames, type RelationDelta } from './delta.js';
import { diffRows, stableRowKey, type RowChange, type RowDiff, type RowDiffDiagnostic } from './diff.js';
import type {
  MaterializationMaintenanceChange,
  MaterializationMaintenanceResult
} from './materialization.js';
import {
  dependencies,
  queryKey,
  type Query
} from './query.js';
import type { RelationRef } from './schema.js';
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

type ReadRowsResult = {
  readonly rows: readonly unknown[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
};

type KeyedDeltaRow = {
  readonly key: string;
  readonly row: unknown;
};

type KeyedDeltaRows = {
  readonly entries: readonly KeyedDeltaRow[];
  readonly byKey: ReadonlyMap<string, KeyedDeltaRow>;
};

type RelationDeltaChange = {
  readonly addedByKey: ReadonlyMap<string, KeyedDeltaRow>;
  readonly removedByKey: ReadonlyMap<string, KeyedDeltaRow>;
  readonly unpairedAddedKeys: ReadonlySet<string>;
  readonly rowChanges: readonly RowChange<unknown>[];
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

  const deltaBacked = await deltaBackedRelationTrackedChange(
    registration,
    sourceBefore,
    sourceAfter,
    changes
  );

  if (deltaBacked !== undefined) {
    return deltaBacked;
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
  readDiagnostics: readonly WatchRuntimeDiagnostic[] = [],
  suppliedRowDiff?: RowDiff<unknown>
): Promise<TrackedChange> {
  const rowDiff = suppliedRowDiff ??
    diffRows(previousRows, rows, diffOptionsForTarget(registration.target, registration.options));
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

async function deltaBackedRelationTrackedChange(
  registration: WatchRegistration,
  sourceBefore: RelationSource,
  sourceAfter: RelationSource,
  changes: ChangeSet
): Promise<TrackedChange | undefined> {
  const target = registration.target;

  if (isQuery(target) || changes.deltas === undefined) {
    return undefined;
  }

  const deltaChange = relationDeltaChange(target, changes.deltas);

  if (deltaChange === undefined) {
    return undefined;
  }

  const before = await readWatchRows(sourceBefore, target, registration.options);

  if (before.diagnostics.length > 0) {
    return recomputeRelationTrackedChange(registration, sourceAfter, changes, before);
  }

  const previousRowsByKey = uniqueRowsByRelationKey(before.rows, target);

  if (previousRowsByKey === undefined) {
    return recomputeRelationTrackedChange(registration, sourceAfter, changes, before);
  }

  if (canReconstructRelationRows(deltaChange, previousRowsByKey)) {
    const rows = applyRelationDeltaRows(before.rows, target, deltaChange);
    const rowDiff = relationDeltaRowDiff(before.rows, rows, deltaChange.rowChanges);

    return deliverTrackedChange(registration, before.rows, rows, changes, before.diagnostics, rowDiff);
  }

  const after = await readWatchRows(sourceAfter, target, registration.options);

  if (
    after.diagnostics.length > 0 ||
    !relationDeltaMatchesSnapshots(before.rows, after.rows, target, deltaChange)
  ) {
    return deliverTrackedChange(
      registration,
      before.rows,
      after.rows,
      changes,
      [...before.diagnostics, ...after.diagnostics]
    );
  }

  const rowDiff = relationDeltaRowDiff(before.rows, after.rows, deltaChange.rowChanges);

  return deliverTrackedChange(
    registration,
    before.rows,
    after.rows,
    changes,
    [...before.diagnostics, ...after.diagnostics],
    rowDiff
  );
}

async function recomputeRelationTrackedChange(
  registration: WatchRegistration,
  sourceAfter: RelationSource,
  changes: ChangeSet,
  before: ReadRowsResult
): Promise<TrackedChange> {
  const after = await readWatchRows(sourceAfter, registration.target, registration.options);

  return deliverTrackedChange(
    registration,
    before.rows,
    after.rows,
    changes,
    [...before.diagnostics, ...after.diagnostics]
  );
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

function relationDeltaChange(
  target: RelationRef,
  deltas: readonly RelationDelta[]
): RelationDeltaChange | undefined {
  const relevantDeltas = deltas.filter((delta) => delta.relation.name === target.name);

  if (relevantDeltas.length !== 1) {
    return undefined;
  }

  const delta = relevantDeltas[0] as RelationDelta;
  const added = keyedDeltaRows(delta.added, target);
  const removed = keyedDeltaRows(delta.removed, target);

  if (added === undefined || removed === undefined) {
    return undefined;
  }

  const rowChanges = deltaRowChanges(added, removed);
  const unpairedAddedKeys = new Set(
    added.entries.filter((entry) => !removed.byKey.has(entry.key)).map((entry) => entry.key)
  );

  return {
    addedByKey: added.byKey,
    removedByKey: removed.byKey,
    unpairedAddedKeys,
    rowChanges
  };
}

function keyedDeltaRows(rows: readonly unknown[], relation: RelationRef): KeyedDeltaRows | undefined {
  const entries: KeyedDeltaRow[] = [];
  const byKey = new Map<string, KeyedDeltaRow>();

  for (const row of rows) {
    const key = relationRowKey(row, relation);

    if (key === undefined || byKey.has(key)) {
      return undefined;
    }

    const entry = { key, row };
    entries.push(entry);
    byKey.set(key, entry);
  }

  return { entries, byKey };
}

function deltaRowChanges(added: KeyedDeltaRows, removed: KeyedDeltaRows): readonly RowChange<unknown>[] {
  const rowChanges: RowChange<unknown>[] = [];

  for (const addedEntry of added.entries) {
    const removedEntry = removed.byKey.get(addedEntry.key);

    if (removedEntry === undefined) {
      rowChanges.push({ op: 'insert', key: addedEntry.key, after: addedEntry.row });
      continue;
    }

    if (!sameStructuralRow(removedEntry.row, addedEntry.row)) {
      rowChanges.push({
        op: 'update',
        key: addedEntry.key,
        before: removedEntry.row,
        after: addedEntry.row
      });
    }
  }

  for (const removedEntry of removed.entries) {
    if (!added.byKey.has(removedEntry.key)) {
      rowChanges.push({ op: 'delete', key: removedEntry.key, before: removedEntry.row });
    }
  }

  return rowChanges;
}

function canReconstructRelationRows(
  change: RelationDeltaChange,
  previousRowsByKey: ReadonlyMap<string, unknown>
): boolean {
  if (change.unpairedAddedKeys.size > 0) {
    return false;
  }

  for (const [key, removed] of change.removedByKey) {
    const previousRow = previousRowsByKey.get(key);

    if (previousRow === undefined || !sameStructuralRow(previousRow, removed.row)) {
      return false;
    }
  }

  return true;
}

function applyRelationDeltaRows(
  previousRows: readonly unknown[],
  relation: RelationRef,
  change: RelationDeltaChange
): readonly unknown[] {
  return previousRows.flatMap((row) => {
    const key = relationRowKey(row, relation) as string;

    if (!change.removedByKey.has(key)) {
      return [row];
    }

    const added = change.addedByKey.get(key);
    return added === undefined ? [] : [added.row];
  });
}

function relationDeltaMatchesSnapshots(
  previousRows: readonly unknown[],
  rows: readonly unknown[],
  relation: RelationRef,
  change: RelationDeltaChange
): boolean {
  const previousRowsByKey = uniqueRowsByRelationKey(previousRows, relation);
  const rowsByKey = uniqueRowsByRelationKey(rows, relation);

  if (previousRowsByKey === undefined || rowsByKey === undefined) {
    return false;
  }

  for (const [key, removed] of change.removedByKey) {
    const previousRow = previousRowsByKey.get(key);

    if (previousRow === undefined || !sameStructuralRow(previousRow, removed.row)) {
      return false;
    }
  }

  for (const [key, added] of change.addedByKey) {
    const row = rowsByKey.get(key);

    if (row === undefined || !sameStructuralRow(row, added.row)) {
      return false;
    }
  }

  for (const [key, previousRow] of previousRowsByKey) {
    if (change.removedByKey.has(key)) {
      continue;
    }

    const row = rowsByKey.get(key);

    if (row === undefined || !sameStructuralRow(previousRow, row)) {
      return false;
    }
  }

  for (const [key, row] of rowsByKey) {
    if (change.addedByKey.has(key)) {
      continue;
    }

    const previousRow = previousRowsByKey.get(key);

    if (previousRow === undefined || !sameStructuralRow(previousRow, row)) {
      return false;
    }
  }

  return true;
}

function relationDeltaRowDiff(
  previousRows: readonly unknown[],
  rows: readonly unknown[],
  rowChanges: readonly RowChange<unknown>[]
): RowDiff<unknown> {
  return {
    ...diffRows(previousRows, rows),
    rowChanges
  };
}

function uniqueRowsByRelationKey(
  rows: readonly unknown[],
  relation: RelationRef
): ReadonlyMap<string, unknown> | undefined {
  const rowsByKey = new Map<string, unknown>();

  for (const row of rows) {
    const key = relationRowKey(row, relation);

    if (key === undefined || rowsByKey.has(key)) {
      return undefined;
    }

    rowsByKey.set(key, row);
  }

  return rowsByKey;
}

function relationRowKey(row: unknown, relation: RelationRef): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const keyFields = relationKeyFields(relation);

  for (const field of keyFields) {
    if (!(field in row) || row[field] === undefined) {
      return undefined;
    }
  }

  if (keyFields.length === 1) {
    return stableRowKey(row[keyFields[0] as string]);
  }

  return stableRowKey(Object.fromEntries(keyFields.map((field) => [field, row[field]])));
}

function relationKeyFields(relation: RelationRef): readonly string[] {
  return typeof relation.key === 'string' ? [relation.key] : relation.key;
}

function sameStructuralRow(left: unknown, right: unknown): boolean {
  return stableRowKey(left) === stableRowKey(right);
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
