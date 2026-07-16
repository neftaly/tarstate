import { createIssue, type Issue } from '../../issues.js';
import { validateRelationInputs } from './input-validation.js';
import { sameOptionalJson } from './equality.js';
import {
  indexedRelationInputs,
  relationInputKey,
  type IndexedRelationInput
} from './relations.js';
import { queryValueEqual } from './values.js';
import { comparePortableStrings } from '../../portable-order.js';
import type {
  QueryRecord,
  RelationInput
} from '../model.js';
import type {
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  RelationInputChange,
  RelationRowChange
} from '../incremental-model.js';
import type { JsonValue } from '../../value.js';

type AppliedMaintenanceUpdate =
  | { readonly success: true; readonly value: QueryMaintenanceSnapshot }
  | { readonly success: false; readonly issues: readonly Issue[] };

export const validateMaintenanceSnapshot = (snapshot: QueryMaintenanceSnapshot): readonly Issue[] =>
  validateRelationInputs(snapshot.relations, 'incremental');

/** Applies one optimistic, occurrence-keyed transition without mutating accepted state. */
export const applyQueryMaintenanceUpdate = (previous: QueryMaintenanceSnapshot, update: QueryMaintenanceUpdate): AppliedMaintenanceUpdate => {
  if (!sameOptionalJson(previous.basis, update.expectedBasis) || previous.membershipRevision !== update.expectedMembershipRevision) {
    return rejectedMaintenanceUpdate('stale_update_basis');
  }
  let current: Map<string, IndexedRelationInput>;
  try { current = new Map(indexedRelationInputs(previous.relations)); } catch { return rejectedMaintenanceUpdate('ambiguous_relation_input'); }
  const changedInputs = new Set<string>();
  for (const change of update.relations) {
    if (change.before === undefined && change.after === undefined) return rejectedMaintenanceUpdate('empty_relation_change', change.relation.relationId);
    const identity = relationInputKey({ relation: change.relation, rows: [], completeness: 'exact', ...(change.sourceId === undefined ? {} : { sourceId: change.sourceId }), ...(change.attachmentId === undefined ? {} : { attachmentId: change.attachmentId }) });
    if (changedInputs.has(identity)) return rejectedMaintenanceUpdate('duplicate_relation_change', change.relation.relationId);
    changedInputs.add(identity);
    const existing = current.get(identity);
    if (!sameRelationChangeState(existing, change.before)) return rejectedMaintenanceUpdate('stale_relation_change', change.relation.relationId);
    const existingRows = existing?.input.rows ?? [];
    const existingOccurrences = existing?.input.occurrenceIds ?? [];
    if (existingRows.length !== existingOccurrences.length) return rejectedMaintenanceUpdate('invalid_occurrence_ids', change.relation.relationId);
    const rowChanges = new Map<string, RelationRowChange>();
    let inserted = 0;
    let removed = 0;
    for (const rowChange of change.rows) {
      if (rowChanges.has(rowChange.occurrenceId)) return rejectedMaintenanceUpdate('duplicate_occurrence_change', change.relation.relationId);
      rowChanges.set(rowChange.occurrenceId, rowChange);
      if (rowChange.before === undefined && rowChange.after !== undefined) inserted += 1;
      else if (rowChange.before !== undefined && rowChange.after === undefined) removed += 1;
    }
    let nextRows: readonly QueryRecord[];
    let nextOccurrences: readonly string[];
    const stableReplacements = inserted === 0
      && removed === 0
      && [...rowChanges.values()].every((row) => row.before !== undefined && row.after !== undefined && row.before.index === row.after.index);
    if (stableReplacements) {
      const replacedRows = rowChanges.size === 0 ? existingRows : [...existingRows];
      for (const rowChange of rowChanges.values()) {
        const before = rowChange.before as NonNullable<RelationRowChange['before']>;
        const after = rowChange.after as NonNullable<RelationRowChange['after']>;
        const row = existingRows[before.index];
        if (row === undefined
          || existingOccurrences[before.index] !== rowChange.occurrenceId
          || !sameIndexedRow({ index: before.index, row }, before)) {
          return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
        }
        (replacedRows as QueryRecord[])[after.index] = after.row;
      }
      nextRows = replacedRows;
      nextOccurrences = existingOccurrences;
    } else {
      const placedRows = Array.from<QueryRecord | undefined>({ length: existingRows.length + inserted - removed });
      const placedOccurrences = Array.from<string | undefined>({ length: placedRows.length });
      const consumedChanges = new Set<string>();
      for (let index = 0; index < existingRows.length; index += 1) {
        const occurrenceId = existingOccurrences[index] as string;
        const row = existingRows[index] as QueryRecord;
        const rowChange = rowChanges.get(occurrenceId);
        if (rowChange === undefined) {
          placedRows[index] = row;
          placedOccurrences[index] = occurrenceId;
          continue;
        }
        consumedChanges.add(occurrenceId);
        if (!sameIndexedRow({ index, row }, rowChange.before)) return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
        if (rowChange.after !== undefined && !placeChangedRow(placedRows, placedOccurrences, occurrenceId, rowChange.after)) return rejectedMaintenanceUpdate('invalid_row_order', change.relation.relationId);
      }
      for (const rowChange of rowChanges.values()) {
        if (consumedChanges.has(rowChange.occurrenceId)) continue;
        if (rowChange.before !== undefined || rowChange.after === undefined || !placeChangedRow(placedRows, placedOccurrences, rowChange.occurrenceId, rowChange.after)) return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
      }
      if (placedRows.some((row) => row === undefined) || placedOccurrences.some((occurrence) => occurrence === undefined)) return rejectedMaintenanceUpdate('invalid_row_order', change.relation.relationId);
      nextRows = placedRows as QueryRecord[];
      nextOccurrences = placedOccurrences as string[];
    }
    if (change.after === undefined) {
      if (nextRows.length > 0) return rejectedMaintenanceUpdate('relation_removal_incomplete', change.relation.relationId);
      current.delete(identity);
      continue;
    }
    const input: RelationInput = {
      relation: change.relation,
      rows: Object.isFrozen(nextRows) ? nextRows : Object.freeze(nextRows),
      occurrenceIds: Object.isFrozen(nextOccurrences) ? nextOccurrences : Object.freeze(nextOccurrences),
      completeness: change.after.completeness,
      ...(change.sourceId === undefined ? {} : { sourceId: change.sourceId }),
      ...(change.attachmentId === undefined ? {} : { attachmentId: change.attachmentId }),
      ...(change.after.basis === undefined ? {} : { basis: change.after.basis })
    };
    current.set(identity, { input: Object.freeze(input), index: change.after.index });
  }
  const orderedInputs = [...current.values()].sort((left, right) => left.index - right.index);
  if (orderedInputs.some(({ index }, expected) => index !== expected)) return rejectedMaintenanceUpdate('invalid_relation_order');
  const value: QueryMaintenanceSnapshot = {
    relations: Object.freeze(orderedInputs.map(({ input }) => input)),
    ...(previous.parameters === undefined ? {} : { parameters: previous.parameters }),
    ...(previous.functions === undefined ? {} : { functions: previous.functions }),
    ...(previous.executionBudget === undefined ? {} : { executionBudget: previous.executionBudget }),
    ...(update.basis === undefined ? {} : { basis: update.basis }),
    ...(update.membershipRevision === undefined ? {} : { membershipRevision: update.membershipRevision })
  };
  return { success: true, value: Object.freeze(value) };
};

const sameRelationChangeState = (current: IndexedRelationInput | undefined, expected: RelationInputChange['before']): boolean => {
  if (current === undefined || expected === undefined) return current === undefined && expected === undefined;
  return current.index === expected.index && current.input.completeness === expected.completeness && sameOptionalJson(current.input.basis, expected.basis);
};

const sameIndexedRow = (current: { readonly index: number; readonly row: QueryRecord } | undefined, expected: RelationRowChange['before']): boolean => {
  if (current === undefined || expected === undefined) return current === undefined && expected === undefined;
  return current.index === expected.index && queryValueEqual(current.row, expected.row);
};

const placeChangedRow = (
  rows: (QueryRecord | undefined)[],
  occurrences: (string | undefined)[],
  occurrenceId: string,
  changed: NonNullable<RelationRowChange['after']>
): boolean => {
  if (changed.index < 0 || changed.index >= rows.length || rows[changed.index] !== undefined || occurrences[changed.index] !== undefined) return false;
  rows[changed.index] = changed.row;
  occurrences[changed.index] = occurrenceId;
  return true;
};

const rejectedMaintenanceUpdate = (reason: string, relationId?: string): AppliedMaintenanceUpdate => ({
  success: false,
  issues: [incrementalQueryIssue('query.incremental_identity_invalid', { reason, ...(relationId === undefined ? {} : { relationId }) })]
});

export const changedRelationIds = (changes: readonly RelationInputChange[]): readonly string[] => {
  const relationIds = new Set<string>();
  for (const change of changes) relationIds.add(change.relation.relationId);
  return Object.freeze([...relationIds].sort(comparePortableStrings));
};

const incrementalQueryIssue = (code: string, details: JsonValue): Issue => createIssue({
  code,
  phase: 'query',
  severity: 'error',
  retry: code === 'query.incremental_session_input_changed' ? 'after_input' : 'after_refresh',
  details
});
