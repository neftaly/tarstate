import { createIssue, type Issue } from './issues.js';
import { sameOptionalJson } from './internal-query-equality.js';
import {
  groupRelationInputs,
  indexedRelationInputs,
  relationInputKey,
  type IndexedRelationInput
} from './internal-query-relations.js';
import { queryValueEqual } from './internal-query-values.js';
import { comparePortableStrings } from './portable-order.js';
import type {
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  QueryRecord,
  RelationInput,
  RelationInputChange,
  RelationRowChange
} from './query-model.js';
import type { JsonValue } from './value.js';

type AppliedMaintenanceUpdate =
  | { readonly success: true; readonly value: QueryMaintenanceSnapshot }
  | { readonly success: false; readonly issues: readonly Issue[] };

export const validateMaintenanceSnapshot = (snapshot: QueryMaintenanceSnapshot): readonly Issue[] =>
  validateRelationInputs(snapshot.relations, 'incremental');

/** Validates attachment and occurrence identity before evaluation or state admission. */
export const validateRelationInputs = (inputs: readonly RelationInput[], mode: 'query' | 'incremental'): readonly Issue[] => {
  const identities = new Set<string>();
  const issues: Issue[] = [];
  for (const input of inputs) {
    const identity = relationInputKey(input);
    if (identities.has(identity)) {
      issues.push(mode === 'incremental'
        ? incrementalQueryIssue('query.incremental_relation_ambiguous', { relationId: input.relation.relationId, attachmentId: input.attachmentId ?? null })
        : createIssue({ code: 'query.input_identity_invalid', relationId: input.relation.relationId, details: { reason: 'duplicate_attachment_input', attachmentId: input.attachmentId ?? null } }));
      continue;
    }
    identities.add(identity);
    if ((mode === 'incremental' && input.rows.length > 0 && input.occurrenceIds === undefined) || input.occurrenceIds !== undefined && (input.occurrenceIds.length !== input.rows.length || new Set(input.occurrenceIds).size !== input.occurrenceIds.length)) {
      issues.push(mode === 'incremental'
        ? incrementalQueryIssue('query.incremental_identity_invalid', { relationId: input.relation.relationId, attachmentId: input.attachmentId ?? null })
        : createIssue({ code: 'query.input_identity_invalid', relationId: input.relation.relationId, details: { reason: 'invalid_occurrence_ids', attachmentId: input.attachmentId ?? null } }));
    }
  }
  return issues;
};

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
    for (const rowChange of change.rows) {
      if (rowChanges.has(rowChange.occurrenceId)) return rejectedMaintenanceUpdate('duplicate_occurrence_change', change.relation.relationId);
      rowChanges.set(rowChange.occurrenceId, rowChange);
    }
    const inserted = change.rows.filter(({ before, after }) => before === undefined && after !== undefined).length;
    const removed = change.rows.filter(({ before, after }) => before !== undefined && after === undefined).length;
    const nextRows = Array.from<QueryRecord | undefined>({ length: existingRows.length + inserted - removed });
    const nextOccurrences = Array.from<string | undefined>({ length: nextRows.length });
    const consumedChanges = new Set<string>();
    for (let index = 0; index < existingRows.length; index += 1) {
      const occurrenceId = existingOccurrences[index] as string;
      const row = existingRows[index] as QueryRecord;
      const rowChange = rowChanges.get(occurrenceId);
      if (rowChange === undefined) {
        nextRows[index] = row;
        nextOccurrences[index] = occurrenceId;
        continue;
      }
      consumedChanges.add(occurrenceId);
      if (!sameIndexedRow({ index, row }, rowChange.before)) return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
      if (rowChange.after !== undefined && !placeChangedRow(nextRows, nextOccurrences, occurrenceId, rowChange.after)) return rejectedMaintenanceUpdate('invalid_row_order', change.relation.relationId);
    }
    for (const rowChange of rowChanges.values()) {
      if (consumedChanges.has(rowChange.occurrenceId)) continue;
      if (rowChange.before !== undefined || rowChange.after === undefined || !placeChangedRow(nextRows, nextOccurrences, rowChange.occurrenceId, rowChange.after)) return rejectedMaintenanceUpdate('stale_occurrence_change', change.relation.relationId);
    }
    if (nextRows.some((row) => row === undefined) || nextOccurrences.some((occurrence) => occurrence === undefined)) return rejectedMaintenanceUpdate('invalid_row_order', change.relation.relationId);
    if (change.after === undefined) {
      if (nextRows.length > 0) return rejectedMaintenanceUpdate('relation_removal_incomplete', change.relation.relationId);
      current.delete(identity);
      continue;
    }
    const input: RelationInput = {
      relation: change.relation,
      rows: Object.freeze(nextRows as QueryRecord[]),
      occurrenceIds: Object.freeze(nextOccurrences as string[]),
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

export const changedRelationIds = (snapshot: QueryMaintenanceSnapshot, identities: ReadonlySet<string>): readonly string[] => {
  const byIdentity = groupRelationInputs(snapshot.relations);
  return [...new Set([...identities].map((identity) => byIdentity.get(identity)?.[0]?.relation.relationId ?? identity.split('\u0000').at(-1) as string))].sort(comparePortableStrings);
};

const incrementalQueryIssue = (code: string, details: JsonValue): Issue => createIssue({
  code,
  phase: 'query',
  severity: 'error',
  retry: code === 'query.incremental_session_input_changed' ? 'after_input' : 'after_refresh',
  details
});
