import type { RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { stableKey } from './identity.js';
import type { ExprData, PredicateData } from './query.js';
import type { RelationRef } from './schema.js';
import type { ConstraintData } from './constraints.js';
import { rowKey, validateRelationRow } from './evaluate.js';
import {
  writeInputPatches,
  type DeleteExactPatch,
  type RelationKeyInput,
  type RelationMergeInput,
  type ReplaceAllPatch,
  type UpdateByKeyPatch,
  type UpdatePatch,
  type WriteInput,
  type WritePatch
} from './write.js';

export type MutableObjectSourceData = Record<string, unknown[]>;

export type WriteApplyResult = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type AtomicWriteApplyResult = WriteApplyResult & {
  readonly committed: boolean;
};

export type WriteApplyOptions = {
  readonly constraints?: readonly ConstraintData[];
};

type MutableDelta = {
  readonly relation: RelationRef;
  readonly added: unknown[];
  readonly removed: unknown[];
};

type ApplyState = {
  readonly data: MutableObjectSourceData;
  readonly deltas: Map<string, MutableDelta>;
  readonly diagnostics: TarstateDiagnostic[];
  readonly constraints: readonly ConstraintData[];
  applied: number;
};
type ComputedChanges = Record<string, unknown> | ((row: Readonly<Record<string, unknown>>) => Record<string, unknown>);
type ComputedMerge = RelationMergeInput | ((
  existing: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>
) => Record<string, unknown>);
type ComputedUpsertUpdate =
  | ComputedChanges
  | ((
      existing: Readonly<Record<string, unknown>>,
      incoming: Readonly<Record<string, unknown>>
    ) => Record<string, unknown>);

export function applyWrites(
  data: MutableObjectSourceData,
  patches: WriteInput,
  options: WriteApplyOptions = {}
): WriteApplyResult {
  const expanded = expandCascadingDeletes(data, Array.from(writeInputPatches(patches)), options.constraints ?? []);
  const patchList = expanded.patches;
  const state: ApplyState = {
    data,
    deltas: new Map(),
    diagnostics: [...expanded.diagnostics],
    constraints: options.constraints ?? [],
    applied: 0
  };

  for (const patch of patchList) {
    applyPatch(state, patch);
  }

  return {
    patches: patchList.length,
    applied: state.applied,
    deltas: publishedDeltas(state.deltas),
    diagnostics: state.diagnostics
  };
}

export function applyWritesAtomic(
  data: MutableObjectSourceData,
  patches: WriteInput,
  options: WriteApplyOptions = {}
): AtomicWriteApplyResult {
  const patchList = Array.from(writeInputPatches(patches));
  const draft = cloneData(data);
  const result = applyWrites(draft, patchList, options);

  if (result.diagnostics.length > 0) {
    return { ...result, committed: false, applied: 0, deltas: [] };
  }

  for (const [name, rows] of Object.entries(draft)) {
    data[name] = rows;
  }

  return { ...result, committed: true };
}

function applyPatch(state: ApplyState, patch: WritePatch): void {
  switch (patch.op) {
    case 'insert':
      insertRow(state, patch.relation, patch.row, 'error');
      return;
    case 'insertIgnore':
      insertRow(state, patch.relation, patch.row, 'ignore');
      return;
    case 'insertOrReplace':
      insertRow(state, patch.relation, patch.row, 'replace');
      return;
    case 'updateByKey':
      updateByKey(state, patch as UpdateByKeyPatch & { readonly changes: ComputedChanges });
      return;
    case 'update':
      updateMatchingRows(state, patch as UpdatePatch & { readonly changes: ComputedChanges });
      return;
    case 'insertOrMerge':
      insertOrMerge(state, patch.relation, patch.row, patch.merge as ComputedMerge);
      return;
    case 'insertOrUpdate':
      insertOrUpdate(state, patch.relation, patch.row, patch.update as ComputedUpsertUpdate);
      return;
    case 'deleteByKey':
      deleteByKey(state, patch.relation, patch.key);
      return;
    case 'delete':
      deleteMatchingRows(state, patch);
      return;
    case 'deleteExact':
      deleteExact(state, patch);
      return;
    case 'replaceAll':
      replaceAllRows(state, patch);
      return;
  }
}

function expandCascadingDeletes(
  data: MutableObjectSourceData,
  patches: readonly WritePatch[],
  constraints: readonly ConstraintData[]
): { readonly patches: readonly WritePatch[]; readonly diagnostics: readonly TarstateDiagnostic[] } {
  if (constraints.length === 0) {
    return { patches, diagnostics: [] };
  }

  const working = cloneData(data);
  const expanded: WritePatch[] = [];
  const diagnostics: TarstateDiagnostic[] = [...unsupportedCascadeDiagnostics(constraints)];

  for (const patch of patches) {
    expanded.push(patch);
    const rowsToDelete = removeRowsForPatch(working, patch);
    if (rowsToDelete.length === 0) {
      continue;
    }

    const cascaded = cascadeDeletesForRows(working, patch.relation, rowsToDelete, constraints);
    expanded.push(...cascaded.patches);
    diagnostics.push(...cascaded.diagnostics);
  }

  return { patches: expanded, diagnostics };
}

function cascadeDeletesForRows(
  data: MutableObjectSourceData,
  relation: RelationRef,
  rowsToDelete: readonly unknown[],
  constraints: readonly ConstraintData[]
): { readonly patches: readonly WritePatch[]; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const patches: WritePatch[] = [];
  const diagnostics: TarstateDiagnostic[] = [];
  const queue: { readonly relation: RelationRef; readonly rows: readonly unknown[] }[] = [{ relation, rows: rowsToDelete }];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor] as { readonly relation: RelationRef; readonly rows: readonly unknown[] };
    for (const constraint of constraints) {
      if (!isSupportedCascadeConstraint(constraint) || constraint.target.name !== item.relation.name) {
        continue;
      }

      const sourceRows = relationRows(data, constraint.relation);
      const removedChildren = spliceRowsMatchingForeignKeys(sourceRows, item.rows, constraint.fields, constraint.targetFields);
      for (const child of removedChildren) {
        patches.push({ op: 'deleteExact', relation: constraint.relation, row: child as never });
      }
      if (removedChildren.length > 0) {
        queue.push({ relation: constraint.relation, rows: removedChildren });
      }
    }
  }

  return { patches, diagnostics };
}

function removeRowsForPatch(data: MutableObjectSourceData, patch: WritePatch): readonly unknown[] {
  switch (patch.op) {
    case 'deleteByKey':
      return removeRowsByPredicate(data, patch.relation, (row) =>
        keyFromRow(patch.relation, row) === keyFromInput(patch.key)
      );
    case 'delete':
      return removeRowsByPredicate(data, patch.relation, (row) => evaluateWritePredicate(patch.predicate, row));
    case 'deleteExact':
      return removeRowsByPredicate(data, patch.relation, (row) => isExactMatch(row, patch.row));
    case 'replaceAll': {
      const replacementKeys = new Set(patch.rows.filter(isRecord).map((row) => keyFromRow(patch.relation, row)));
      return removeRowsByPredicate(data, patch.relation, (row) => !replacementKeys.has(keyFromRow(patch.relation, row)));
    }
    default:
      return [];
  }
}

function removeRowsByPredicate(
  data: MutableObjectSourceData,
  relation: RelationRef,
  predicate: (row: Record<string, unknown>) => boolean
): readonly unknown[] {
  const rows = relationRows(data, relation);
  const removed: unknown[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (isRecord(row) && predicate(row)) {
      removed.push(...rows.splice(index, 1));
    }
  }
  return removed;
}

function spliceRowsMatchingForeignKeys(
  rows: unknown[],
  targetRows: readonly unknown[],
  fields: readonly string[],
  targetFields: readonly string[]
): readonly unknown[] {
  const removed: unknown[] = [];
  const targetKeys = new Set(targetRows.map((row) => stableKeyValue(valuesFor(row, targetFields))));

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (targetKeys.has(stableKeyValue(valuesFor(row, fields)))) {
      removed.push(...rows.splice(index, 1));
    }
  }

  return removed;
}

function unsupportedCascadeDiagnostics(constraints: readonly ConstraintData[]): readonly TarstateDiagnostic[] {
  return constraints.flatMap((constraint) => {
    if (constraint.op !== 'fk' || constraint.cascade === undefined || constraint.cascade === false) {
      return [];
    }

    if (isSupportedCascadeConstraint(constraint)) {
      return [];
    }

    return [{
      code: 'constraint_fk_cascade_unsupported',
      message: constraint.cascade === true || constraint.cascade === 'delete'
        ? 'foreign key cascade is only supported for direct relation foreign keys'
        : `unsupported foreign key cascade mode ${String(constraint.cascade)}`,
      relation: cascadeDiagnosticRelation(constraint),
      field: constraint.fields.join(','),
      detail: {
        kind: 'fk',
        cascade: constraint.cascade,
        fields: constraint.fields,
        targetFields: constraint.targetFields
      }
    } satisfies TarstateDiagnostic];
  });
}

function isSupportedCascadeConstraint(
  constraint: ConstraintData
): constraint is Extract<ConstraintData, { readonly op: 'fk' }> & { readonly relation: RelationRef; readonly target: RelationRef } {
  return constraint.op === 'fk' &&
    'relation' in constraint &&
    !('data' in constraint.target) &&
    (constraint.cascade === true || constraint.cascade === 'delete');
}

function cascadeDiagnosticRelation(constraint: Extract<ConstraintData, { readonly op: 'fk' }>): string {
  return 'relation' in constraint ? constraint.relation.name : 'query';
}

function insertRow(
  state: ApplyState,
  relation: RelationRef,
  row: unknown,
  conflict: 'error' | 'ignore' | 'replace'
): void {
  if (!isRecord(row)) {
    state.diagnostics.push(invalidPatchDiagnostic(relation, 'insert row must be an object'));
    return;
  }

  const diagnostics = validateCandidateRow(state, relation, row);
  if (diagnostics.length > 0) {
    state.diagnostics.push(...diagnostics);
    return;
  }

  const rows = relationRows(state.data, relation);
  const existingIndex = conflict === 'replace'
    ? conflictIndex(state, rows, relation, row)
    : indexByKey(rows, relation, keyFromRow(relation, row));
  if (existingIndex !== -1) {
    if (conflict === 'ignore') {
      return;
    }

    if (conflict === 'error') {
      state.diagnostics.push({
        code: 'duplicate_key',
        message: 'duplicate relation key',
        relation: relation.name,
        key: keyFromRow(relation, row)
      });
      return;
    }

    const before = rows[existingIndex];
    rows[existingIndex] = row;
    state.applied += 1;
    recordDelta(state, relation, before, row);
    return;
  }

  rows.push(row);
  state.applied += 1;
  recordDelta(state, relation, undefined, row);
}

function updateByKey(state: ApplyState, patch: UpdateByKeyPatch & { readonly changes: ComputedChanges }): void {
  const rows = relationRows(state.data, patch.relation);
  const index = indexByKey(rows, patch.relation, keyFromInput(patch.key));
  if (index === -1) {
    return;
  }

  updateRowAt(state, patch.relation, rows, index, patch.changes);
}

function updateMatchingRows(state: ApplyState, patch: UpdatePatch & { readonly changes: ComputedChanges }): void {
  const rows = relationRows(state.data, patch.relation);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (isRecord(row) && evaluateWritePredicate(patch.predicate, row)) {
      updateRowAt(state, patch.relation, rows, index, patch.changes);
    }
  }
}

function updateRowAt(
  state: ApplyState,
  relation: RelationRef,
  rows: unknown[],
  index: number,
  changes: ComputedChanges
): void {
  const before = rows[index];
  if (!isRecord(before)) {
    return;
  }

  const resolvedChanges = resolveChanges(changes, before);
  const after = { ...before, ...resolvedChanges };
  const diagnostics = validateCandidateRow(state, relation, after);
  if (diagnostics.length > 0) {
    state.diagnostics.push(...diagnostics);
    return;
  }

  rows[index] = after;
  state.applied += 1;
  recordDelta(state, relation, before, after);
}

function insertOrMerge(
  state: ApplyState,
  relation: RelationRef,
  row: Record<string, unknown>,
  merge: ComputedMerge
): void {
  const key = keyFromRow(relation, row);
  const rows = relationRows(state.data, relation);
  const index = conflictIndex(state, rows, relation, row, key);

  if (index === -1) {
    insertRow(state, relation, row, 'error');
    return;
  }

  const before = rows[index];
  if (!isRecord(before)) {
    return;
  }

  const changes = mergeChanges(before, row, merge);
  updateRowAt(state, relation, rows, index, changes);
}

function insertOrUpdate(
  state: ApplyState,
  relation: RelationRef,
  row: Record<string, unknown>,
  update: ComputedUpsertUpdate
): void {
  const rows = relationRows(state.data, relation);
  const index = indexByKey(rows, relation, keyFromRow(relation, row));

  if (index === -1) {
    insertRow(state, relation, row, 'error');
  } else {
    const before = rows[index];
    updateRowAt(state, relation, rows, index, isRecord(before) && isTwoArgFunction(update)
      ? update(before, row)
      : update as ComputedChanges);
  }
}

function deleteByKey(state: ApplyState, relation: RelationRef, key: RelationKeyInput): void {
  const rows = relationRows(state.data, relation);
  const index = indexByKey(rows, relation, keyFromInput(key));

  if (index === -1) {
    state.applied += 1;
    return;
  }

  const removed = rows.splice(index, 1)[0];
  state.applied += 1;
  recordDelta(state, relation, removed, undefined);
}

function deleteMatchingRows(state: ApplyState, patch: Extract<WritePatch, { readonly op: 'delete' }>): void {
  const rows = relationRows(state.data, patch.relation);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (isRecord(row) && evaluateWritePredicate(patch.predicate, row)) {
      rows.splice(index, 1);
      state.applied += 1;
      recordDelta(state, patch.relation, row, undefined);
    }
  }
}

function deleteExact(state: ApplyState, patch: DeleteExactPatch): void {
  const rows = relationRows(state.data, patch.relation);
  const index = rows.findIndex((row) => isRecord(row) && isExactMatch(row, patch.row));

  if (index === -1) {
    return;
  }

  const removed = rows.splice(index, 1)[0];
  state.applied += 1;
  recordDelta(state, patch.relation, removed, undefined);
}

function replaceAllRows(state: ApplyState, patch: ReplaceAllPatch): void {
  const diagnostics = patch.rows.flatMap((row) =>
    isRecord(row)
      ? validateCandidateRow(state, patch.relation, row)
      : [invalidPatchDiagnostic(patch.relation, 'replaceAll rows must be objects')]
  );
  if (diagnostics.length > 0) {
    state.diagnostics.push(...diagnostics);
    return;
  }

  const before = relationRows(state.data, patch.relation);
  state.data[patch.relation.name] = [...patch.rows];
  state.applied += 1;

  for (const row of before) recordDelta(state, patch.relation, row, undefined);
  for (const row of patch.rows) recordDelta(state, patch.relation, undefined, row);
}

function validateCandidateRow(
  state: ApplyState,
  relation: RelationRef,
  row: Record<string, unknown>
): readonly TarstateDiagnostic[] {
  return [
    ...validateRelationRow(relation, row),
    ...validateRefs(state.data, relation, row)
  ];
}

function validateRefs(
  data: MutableObjectSourceData,
  relation: RelationRef,
  row: Record<string, unknown>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];
  const key = rowKey(relation, row);

  for (const [field, spec] of Object.entries(relation.fields)) {
    if (spec.valueKind !== 'ref' || spec.ref === undefined) {
      continue;
    }

    const value = row[field];
    if (value === null || value === undefined) {
      continue;
    }

    const [targetRelation, targetField] = spec.ref.split('.');
    if (targetRelation === undefined || targetField === undefined) {
      diagnostics.push({
        code: 'unreadable_ref',
        message: `unreadable ref ${spec.ref}`,
        relation: relation.name,
        field,
        ...(key === undefined ? {} : { key })
      });
      continue;
    }

    const targetRows = data[targetRelation] ?? [];
    if (!targetRows.some((target) => isRecord(target) && Object.is(target[targetField], value))) {
      diagnostics.push({
        code: 'missing_ref',
        message: `missing ref ${spec.ref}`,
        relation: relation.name,
        field,
        ...(key === undefined ? {} : { key })
      });
    }
  }

  return diagnostics;
}

function evaluateWritePredicate(predicate: PredicateData, row: Record<string, unknown>): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(evaluateWriteExpr(predicate.left, row), evaluateWriteExpr(predicate.right, row));
    case 'neq':
      return !Object.is(evaluateWriteExpr(predicate.left, row), evaluateWriteExpr(predicate.right, row));
    case 'lt':
      return compareValues(evaluateWriteExpr(predicate.left, row), evaluateWriteExpr(predicate.right, row)) < 0;
    case 'lte':
      return compareValues(evaluateWriteExpr(predicate.left, row), evaluateWriteExpr(predicate.right, row)) <= 0;
    case 'gt':
      return compareValues(evaluateWriteExpr(predicate.left, row), evaluateWriteExpr(predicate.right, row)) > 0;
    case 'gte':
      return compareValues(evaluateWriteExpr(predicate.left, row), evaluateWriteExpr(predicate.right, row)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => evaluateWritePredicate(item, row));
    case 'or':
      return predicate.predicates.some((item) => evaluateWritePredicate(item, row));
    case 'not':
      return !evaluateWritePredicate(predicate.predicate, row);
  }
}

function evaluateWriteExpr(expr: ExprData, row: Record<string, unknown>): unknown {
  switch (expr.op) {
    case 'field':
      return row[expr.field];
    case 'value':
      return expr.value;
    case 'tuple':
      return expr.items.map((item) => evaluateWriteExpr(item, row));
    default:
      return undefined;
  }
}

function relationRows(data: MutableObjectSourceData, relation: RelationRef): unknown[] {
  const rows = data[relation.name] ?? [];
  data[relation.name] = rows;
  return rows;
}

function cloneData(data: MutableObjectSourceData): MutableObjectSourceData {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
}

function conflictIndex(
  state: ApplyState,
  rows: readonly unknown[],
  relation: RelationRef,
  row: Record<string, unknown>,
  key = keyFromRow(relation, row)
): number {
  const keyIndex = indexByKey(rows, relation, key);
  if (keyIndex !== -1) {
    return keyIndex;
  }

  return uniqueConflictIndex(state.constraints, rows, relation, row);
}

function uniqueConflictIndex(
  constraints: readonly ConstraintData[],
  rows: readonly unknown[],
  relation: RelationRef,
  row: Record<string, unknown>
): number {
  for (const constraint of constraints) {
    if (constraint.op !== 'unique' || !('relation' in constraint) || constraint.relation.name !== relation.name) {
      continue;
    }

    const values = constraint.fields.map((field) => row[field]);
    if (values.some((value) => value === undefined || value === null)) {
      continue;
    }

    const index = rows.findIndex((candidate) =>
      isRecord(candidate) &&
      values.every((value, valueIndex) => Object.is(candidate[constraint.fields[valueIndex] as string], value))
    );
    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

function indexByKey(rows: readonly unknown[], relation: RelationRef, key: string): number {
  return rows.findIndex((row) => isRecord(row) && keyFromRow(relation, row) === key);
}

function keyFromRow(relation: RelationRef, row: Record<string, unknown>): string {
  const key = rowKey(relation, row);
  return key ?? stableKey(row);
}

function keyFromInput(key: RelationKeyInput): string {
  return Array.isArray(key) ? stableKey(key) : String(key);
}

function mergeChanges(
  existing: Record<string, unknown>,
  row: Record<string, unknown>,
  merge: ComputedMerge
): Record<string, unknown> {
  if (typeof merge === 'function') {
    return merge(existing, row) as Record<string, unknown>;
  }

  if (merge === 'all') {
    return row;
  }

  if (merge === 'provided') {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
  }

  return Object.fromEntries(merge.map((field) => [field, row[field]]));
}

function resolveChanges(changes: ComputedChanges, row: Record<string, unknown>): Record<string, unknown> {
  return typeof changes === 'function' ? changes(row) : changes;
}

function valuesFor(row: unknown, fields: readonly string[]): readonly unknown[] {
  return fields.map((field) => isRecord(row) ? row[field] : undefined);
}

function stableKeyValue(values: readonly unknown[]): string {
  return stableKey(values.length === 1 ? values[0] : values);
}

function isTwoArgFunction(input: ComputedUpsertUpdate): input is (
  existing: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>
) => Record<string, unknown> {
  return typeof input === 'function' && input.length >= 2;
}

function recordDelta(state: ApplyState, relation: RelationRef, removed: unknown, added: unknown): void {
  let delta = state.deltas.get(relation.name);
  if (delta === undefined) {
    delta = { relation, added: [], removed: [] };
    state.deltas.set(relation.name, delta);
  }

  if (removed !== undefined) {
    delta.removed.push(removed);
  }

  if (added !== undefined) {
    delta.added.push(added);
  }
}

function publishedDeltas(deltas: ReadonlyMap<string, MutableDelta>): readonly RelationDelta[] {
  return Array.from(deltas.values())
    .filter((delta) => delta.added.length > 0 || delta.removed.length > 0)
    .map((delta) => ({
      relation: delta.relation,
      added: [...delta.added],
      removed: [...delta.removed]
    }));
}

function invalidPatchDiagnostic(relation: RelationRef, message: string): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    message,
    relation: relation.name
  };
}

function isExactMatch(row: Record<string, unknown>, expected: unknown): boolean {
  return isRecord(expected) &&
    Object.entries(expected).every(([field, value]) => Object.is(row[field], value));
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if ((typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string')) {
    return left < right ? -1 : 1;
  }
  return String(left) < String(right) ? -1 : 1;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
