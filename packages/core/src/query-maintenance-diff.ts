import { sameExecutionBudget, sameFunctionRegistry, sameOptionalJson } from './internal-query-equality.js';
import {
  indexedRelationInputs,
  indexedRelationRows,
  type IndexedRelationInput
} from './internal-query-relations.js';
import { queryValueEqual } from './internal-query-values.js';
import {
  adoptQueryMaintenanceUpdate
} from './internal-query-ownership.js';
import { comparePortableStrings } from './portable-order.js';
import type {
  QueryRecord,
  RelationInput
} from './query-model.js';
import type {
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  RelationInputChange,
  RelationRowChange
} from './query-incremental-model.js';

/** Owns the exact update once after comparing the caller's snapshot values. */
export const diffQueryMaintenanceSnapshots = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): QueryMaintenanceUpdate => {
  return adoptQueryMaintenanceUpdate(diffQueryMaintenanceSnapshotValues(previous, next));
};

/** Internal value transform; lifecycle shells choose how to own its output. */
export const diffQueryMaintenanceSnapshotValues = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): QueryMaintenanceUpdate => {
  if (!sameOptionalJson(previous.parameters, next.parameters) || !sameFunctionRegistry(previous.functions, next.functions) || !sameExecutionBudget(previous.executionBudget, next.executionBudget)) {
    throw new TypeError('Query maintenance parameters, functions, and execution budget are fixed for the session');
  }
  const previousInputs = indexedRelationInputs(previous.relations);
  const nextInputs = indexedRelationInputs(next.relations);
  const identities = [...new Set([...previousInputs.keys(), ...nextInputs.keys()])].sort(comparePortableStrings);
  const relations: RelationInputChange[] = [];
  for (const identity of identities) {
    const before = previousInputs.get(identity);
    const after = nextInputs.get(identity);
    const rows = diffRelationRows(before?.input, after?.input);
    if (before !== undefined && after !== undefined && before.index === after.index && before.input.completeness === after.input.completeness && sameOptionalJson(before.input.basis, after.input.basis) && rows.length === 0) continue;
    const input = after?.input ?? before?.input;
    if (input === undefined) continue;
    relations.push({
      relation: input.relation,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
      ...(before === undefined ? {} : { before: relationChangeState(before) }),
      ...(after === undefined ? {} : { after: relationChangeState(after) }),
      rows
    });
  }
  return {
    ...(previous.basis === undefined ? {} : { expectedBasis: previous.basis }),
    ...(next.basis === undefined ? {} : { basis: next.basis }),
    ...(previous.membershipRevision === undefined ? {} : { expectedMembershipRevision: previous.membershipRevision }),
    ...(next.membershipRevision === undefined ? {} : { membershipRevision: next.membershipRevision }),
    relations
  };
};

const diffRelationRows = (before: RelationInput | undefined, after: RelationInput | undefined): readonly RelationRowChange[] => {
  if (before === after || (before !== undefined && after !== undefined && before.rows === after.rows && before.occurrenceIds === after.occurrenceIds)) return [];
  const beforeIds = before?.occurrenceIds ?? [];
  const afterIds = after?.occurrenceIds ?? [];
  if ((before?.rows.length ?? 0) !== beforeIds.length || (after?.rows.length ?? 0) !== afterIds.length) throw new TypeError('Relation changes require complete occurrence IDs');
  if (beforeIds.length === afterIds.length) {
    const changes: RelationRowChange[] = [];
    let positional = true;
    for (let index = 0; index < beforeIds.length; index += 1) {
      const occurrenceId = beforeIds[index] as string;
      if (occurrenceId !== afterIds[index]) {
        positional = false;
        break;
      }
      const previousRow = before?.rows[index] as QueryRecord;
      const nextRow = after?.rows[index] as QueryRecord;
      if (previousRow === nextRow || queryValueEqual(previousRow, nextRow)) continue;
      changes.push({ occurrenceId, before: { index, row: previousRow }, after: { index, row: nextRow } });
    }
    if (positional) return changes;
  }
  const beforeRows = before === undefined ? new Map<string, { readonly index: number; readonly row: QueryRecord }>() : indexedRelationRows(before);
  const afterRows = after === undefined ? new Map<string, { readonly index: number; readonly row: QueryRecord }>() : indexedRelationRows(after);
  const changes: RelationRowChange[] = [];
  for (const occurrenceId of [...new Set([...beforeRows.keys(), ...afterRows.keys()])].sort(comparePortableStrings)) {
    const previousRow = beforeRows.get(occurrenceId);
    const nextRow = afterRows.get(occurrenceId);
    if (previousRow !== undefined && nextRow !== undefined && previousRow.index === nextRow.index && (previousRow.row === nextRow.row || queryValueEqual(previousRow.row, nextRow.row))) continue;
    changes.push({ occurrenceId, ...(previousRow === undefined ? {} : { before: previousRow }), ...(nextRow === undefined ? {} : { after: nextRow }) });
  }
  return changes;
};

const relationChangeState = ({ input, index }: IndexedRelationInput): NonNullable<RelationInputChange['before']> => ({
  index,
  completeness: input.completeness,
  ...(input.basis === undefined ? {} : { basis: input.basis })
});
