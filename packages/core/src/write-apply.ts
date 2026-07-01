import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './adapter.js';
import {
  createRelationDeltaAccumulator,
  recordAddedDelta,
  recordRemovedDelta,
  relationDeltasFromAccumulator,
  type RelationDeltaAccumulator
} from './delta-accumulator.js';
import { stableKey } from './identity.js';
import { isJsonValue, type FieldSpec, type RelationRef } from './schema.js';
import { writeInputPatches } from './write.js';
import type {
  DeleteExactPatch,
  DeleteByKeyPatch,
  DeletePatch,
  InsertIgnorePatch,
  InsertOrMergePatch,
  InsertOrReplacePatch,
  InsertOrUpdatePatch,
  InsertPatch,
  RelationKeyInput,
  ReplaceAllPatch,
  UpdateByKeyPatch,
  UpdatePatch,
  WriteInput,
  WritePatch
} from './write.js';

/** Mutable object-backed relation rows used by write application. */
export type MutableObjectSourceData = Record<string, unknown[]>;

/** Result from applying a batch of write patches to object-backed rows. */
export type WriteApplyResult = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

/** Result from an all-or-nothing object write batch. */
export type AtomicWriteApplyResult = WriteApplyResult & {
  readonly committed: boolean;
};

type WriteApplyContext = {
  readonly data: MutableObjectSourceData;
  readonly diagnostics: TarstateDiagnostic[];
  readonly deltas: RelationDeltaAccumulator;
  readonly relationStates: Map<string, RelationWriteState>;
  readonly relationPlans: Map<string, RelationWritePlan>;
};

type RelationWritePlan = {
  readonly relation: RelationRef;
  readonly keyFields: readonly string[];
  readonly singleKeyField: string | undefined;
  readonly fieldEntries: readonly (readonly [string, FieldSpec])[];
};

type RelationKeyValue = {
  readonly indexKey: unknown;
  readonly diagnosticKey: string | undefined;
};

type RelationWriteState = {
  readonly rows: unknown[];
  readonly indexes: Map<unknown, number>;
  readonly duplicateKeys: Set<unknown>;
  readonly rowKeys: (RelationKeyValue | undefined)[];
};

/**
 * Apply write patches to mutable object-backed relation arrays.
 *
 * @remarks Patches are applied in order. Invalid or ambiguous patches report diagnostics and do not mutate data.
 */
export function applyWrites(data: MutableObjectSourceData, patches: WriteInput): WriteApplyResult {
  const diagnostics: TarstateDiagnostic[] = [];
  const context: WriteApplyContext = {
    data,
    diagnostics,
    deltas: createRelationDeltaAccumulator(),
    relationStates: new Map(),
    relationPlans: new Map()
  };
  let patchCount = 0;
  let applied = 0;

  for (const patch of writeInputPatches(patches)) {
    patchCount += 1;

    if (applyWrite(context, patch)) {
      applied += 1;
    }
  }

  return { patches: patchCount, applied, deltas: relationDeltasFromAccumulator(context.deltas), diagnostics };
}

/**
 * Apply write patches atomically to mutable object-backed relation arrays.
 *
 * @remarks The input data is mutated only when every patch applies without diagnostics.
 */
export function applyWritesAtomic(
  data: MutableObjectSourceData,
  patches: WriteInput
): AtomicWriteApplyResult {
  const staged = cloneMutableData(data);
  const result = applyWrites(staged, patches);

  if (result.diagnostics.length > 0) {
    return {
      patches: result.patches,
      applied: 0,
      committed: false,
      deltas: [],
      diagnostics: result.diagnostics
    };
  }

  replaceMutableData(data, staged);
  return {
    ...result,
    committed: true
  };
}

function applyWrite(context: WriteApplyContext, patch: WritePatch): boolean {
  if (!hasNamedRelation(patch.relation, context.diagnostics)) {
    return false;
  }

  const plan = planFor(context, patch.relation);

  switch (patch.op) {
    case 'insert':
      return applyInsert(context, plan, patch, false);
    case 'insertIgnore':
      return applyInsert(context, plan, patch, true);
    case 'insertOrReplace':
      return applyInsertOrReplace(context, plan, patch);
    case 'updateByKey':
      return applyUpdateByKey(context, plan, patch);
    case 'update':
      return applyUnsupportedPredicatePatch(context, patch);
    case 'insertOrMerge':
      return applyInsertOrMerge(context, plan, patch);
    case 'insertOrUpdate':
      return applyInsertOrUpdate(context, plan, patch);
    case 'deleteByKey':
      return applyDeleteByKey(context, plan, patch);
    case 'delete':
      return applyUnsupportedPredicatePatch(context, patch);
    case 'deleteExact':
      return applyDeleteExact(context, plan, patch);
    case 'replaceAll':
      return applyReplaceAll(context, plan, patch);
  }
}

function applyInsert(
  context: WriteApplyContext,
  plan: RelationWritePlan,
  patch: InsertPatch | InsertIgnorePatch,
  ignoreConflict: boolean
): boolean {
  const row = validPatchRow(plan, patch.row, context.diagnostics);

  if (row === undefined) {
    return false;
  }

  const key = rowKey(plan, row);

  if (key === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  const state = stateFor(context, plan, true);

  if (hasIndexedKey(state, key)) {
    if (ignoreConflict) {
      return true;
    }

    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(key)));
    return false;
  }

  const nextRow = copyRow(row);
  addIndexedRow(state, key, nextRow);
  recordAddedDelta(context.deltas, plan.relation, nextRow);
  return true;
}

function applyInsertOrReplace(
  context: WriteApplyContext,
  plan: RelationWritePlan,
  patch: InsertOrReplacePatch
): boolean {
  const row = validPatchRow(plan, patch.row, context.diagnostics);

  if (row === undefined) {
    return false;
  }

  const key = rowKey(plan, row);

  if (key === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  const state = stateFor(context, plan, true);

  if (state.duplicateKeys.has(key.indexKey)) {
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(key)));
    return false;
  }

  const existingIndex = state.indexes.get(key.indexKey);
  const nextRow = copyRow(row);

  if (existingIndex === undefined) {
    addIndexedRow(state, key, nextRow);
    recordAddedDelta(context.deltas, plan.relation, nextRow);
    return true;
  }

  const current = state.rows[existingIndex];

  if (!isRecord(current)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${patch.relation.name} is not an object`,
      relation: patch.relation.name,
      detail: current
    });
    return false;
  }

  const previousRow = copyRow(current);
  replaceIndexedRow(state, existingIndex, key, key, nextRow);
  recordRemovedDelta(context.deltas, plan.relation, previousRow);
  recordAddedDelta(context.deltas, plan.relation, copyRow(nextRow));
  return true;
}

function applyUpdateByKey(context: WriteApplyContext, plan: RelationWritePlan, patch: UpdateByKeyPatch): boolean {
  if (!isRecord(patch.changes)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `changes for relation ${patch.relation.name} are not an object`,
      relation: patch.relation.name,
      detail: patch.changes
    });
    return false;
  }

  const key = keyFromInput(plan, patch.key, context.diagnostics);

  if (key === undefined) {
    return false;
  }

  const state = stateFor(context, plan, false);
  const index = singleIndexForKey(state, patch.relation, key, context.diagnostics);

  if (index === undefined) {
    return false;
  }

  const current = state.rows[index];

  if (!isRecord(current)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${patch.relation.name} is not an object`,
      relation: patch.relation.name,
      detail: current
    });
    return false;
  }

  const previousRow = copyRow(current);
  const nextRow = { ...current, ...patch.changes };
  const rowDiagnostics = validateRow(plan, nextRow);

  if (rowDiagnostics.length > 0) {
    context.diagnostics.push(...rowDiagnostics);
    return false;
  }

  const nextKey = rowKey(plan, nextRow);

  if (nextKey === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  if (hasConflictingIndexedKey(state, nextKey, index)) {
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(nextKey)));
    return false;
  }

  replaceIndexedRow(state, index, key, nextKey, nextRow);
  recordRemovedDelta(context.deltas, plan.relation, previousRow);
  recordAddedDelta(context.deltas, plan.relation, copyRow(nextRow));
  return true;
}

function applyInsertOrMerge(
  context: WriteApplyContext,
  plan: RelationWritePlan,
  patch: InsertOrMergePatch
): boolean {
  if (!isRecord(patch.row)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${patch.relation.name} is not an object`,
      relation: patch.relation.name,
      detail: patch.row
    });
    return false;
  }

  const key = rowKey(plan, patch.row);

  if (key === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  const state = stateFor(context, plan, true);

  if (state.duplicateKeys.has(key.indexKey)) {
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(key)));
    return false;
  }

  const existingIndex = state.indexes.get(key.indexKey);

  if (existingIndex === undefined) {
    const rowDiagnostics = validateRow(plan, patch.row);

    if (rowDiagnostics.length > 0) {
      context.diagnostics.push(...rowDiagnostics);
      return false;
    }

    const nextRow = copyRow(patch.row);
    addIndexedRow(state, key, nextRow);
    recordAddedDelta(context.deltas, plan.relation, nextRow);
    return true;
  }

  const current = state.rows[existingIndex];

  if (!isRecord(current)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${patch.relation.name} is not an object`,
      relation: patch.relation.name,
      detail: current
    });
    return false;
  }

  const previousRow = copyRow(current);
  const nextRow = { ...current, ...mergeRowChanges(patch) };
  const rowDiagnostics = validateRow(plan, nextRow);

  if (rowDiagnostics.length > 0) {
    context.diagnostics.push(...rowDiagnostics);
    return false;
  }

  const nextKey = rowKey(plan, nextRow);

  if (nextKey === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  if (hasConflictingIndexedKey(state, nextKey, existingIndex)) {
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(nextKey)));
    return false;
  }

  replaceIndexedRow(state, existingIndex, key, nextKey, nextRow);
  recordRemovedDelta(context.deltas, plan.relation, previousRow);
  recordAddedDelta(context.deltas, plan.relation, copyRow(nextRow));
  return true;
}

function mergeRowChanges(patch: InsertOrMergePatch): Record<string, unknown> {
  if (patch.merge === 'provided' || patch.merge === 'all') {
    return copyRow(patch.row);
  }

  const changes: Record<string, unknown> = {};

  for (const fieldName of patch.merge) {
    if (Object.hasOwn(patch.row, fieldName)) {
      changes[fieldName] = patch.row[fieldName];
    }
  }

  return changes;
}

function applyInsertOrUpdate(
  context: WriteApplyContext,
  plan: RelationWritePlan,
  patch: InsertOrUpdatePatch
): boolean {
  const row = validPatchRow(plan, patch.row, context.diagnostics);

  if (row === undefined) {
    return false;
  }

  if (!isRecord(patch.update)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `update for relation ${patch.relation.name} is not an object`,
      relation: patch.relation.name,
      detail: patch.update
    });
    return false;
  }

  const key = rowKey(plan, row);

  if (key === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  const state = stateFor(context, plan, true);

  if (state.duplicateKeys.has(key.indexKey)) {
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(key)));
    return false;
  }

  const existingIndex = state.indexes.get(key.indexKey);

  if (existingIndex === undefined) {
    const nextRow = copyRow(row);
    addIndexedRow(state, key, nextRow);
    recordAddedDelta(context.deltas, plan.relation, nextRow);
    return true;
  }

  const current = state.rows[existingIndex];

  if (!isRecord(current)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${patch.relation.name} is not an object`,
      relation: patch.relation.name,
      detail: current
    });
    return false;
  }

  const previousRow = copyRow(current);
  const nextRow = { ...current, ...patch.update };
  const rowDiagnostics = validateRow(plan, nextRow);

  if (rowDiagnostics.length > 0) {
    context.diagnostics.push(...rowDiagnostics);
    return false;
  }

  const nextKey = rowKey(plan, nextRow);

  if (nextKey === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  if (hasConflictingIndexedKey(state, nextKey, existingIndex)) {
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(nextKey)));
    return false;
  }

  replaceIndexedRow(state, existingIndex, key, nextKey, nextRow);
  recordRemovedDelta(context.deltas, plan.relation, previousRow);
  recordAddedDelta(context.deltas, plan.relation, copyRow(nextRow));
  return true;
}

function applyDeleteByKey(context: WriteApplyContext, plan: RelationWritePlan, patch: DeleteByKeyPatch): boolean {
  const key = keyFromInput(plan, patch.key, context.diagnostics);

  if (key === undefined) {
    return false;
  }

  const state = stateFor(context, plan, false);
  const index = singleIndexForKey(state, patch.relation, key, context.diagnostics);

  if (index === undefined) {
    return false;
  }

  const previous = state.rows[index];
  deleteIndexedRow(state, key, index);
  recordRemovedDelta(context.deltas, plan.relation, isRecord(previous) ? copyRow(previous) : previous);
  return true;
}

function applyDeleteExact(context: WriteApplyContext, plan: RelationWritePlan, patch: DeleteExactPatch): boolean {
  const row = validPatchRow(plan, patch.row, context.diagnostics);

  if (row === undefined) {
    return false;
  }

  const key = rowKey(plan, row);

  if (key === undefined) {
    context.diagnostics.push(missingKeyDiagnostic(patch.relation));
    return false;
  }

  const state = stateFor(context, plan, false);
  const index = singleIndexForKey(state, patch.relation, key, context.diagnostics);

  if (index === undefined) {
    return false;
  }

  const previous = state.rows[index];

  if (!exactRowMatches(previous, row)) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: `row ${keyDiagnostic(key)} in relation ${patch.relation.name} does not match exact delete row`,
      relation: patch.relation.name,
      key: keyDiagnostic(key),
      detail: { expected: row, actual: previous }
    });
    return false;
  }

  deleteIndexedRow(state, key, index);
  recordRemovedDelta(context.deltas, plan.relation, copyRow(row));
  return true;
}

function applyReplaceAll(
  context: WriteApplyContext,
  plan: RelationWritePlan,
  patch: ReplaceAllPatch
): boolean {
  const replacement = validateReplaceAllRows(plan, patch);

  if (replacement.diagnostics.length > 0) {
    context.diagnostics.push(...replacement.diagnostics);
    return false;
  }

  const state = stateFor(context, plan, true);
  const removedRows = state.rows.map((row) => (isRecord(row) ? copyRow(row) : row));

  replaceAllIndexedRows(context, plan, replacement.rows, replacement.keys);

  for (const row of removedRows) {
    recordRemovedDelta(context.deltas, plan.relation, row);
  }

  for (const row of replacement.rows) {
    recordAddedDelta(context.deltas, plan.relation, row);
  }

  return true;
}

function applyUnsupportedPredicatePatch(
  context: WriteApplyContext,
  patch: UpdatePatch | DeletePatch
): boolean {
  context.diagnostics.push({
    code: 'unsupported_expression',
    message: `${patch.op} for relation ${patch.relation.name} requires predicate write support`,
    relation: patch.relation.name,
    detail: patch.predicate
  });
  return false;
}

function validateReplaceAllRows(
  plan: RelationWritePlan,
  patch: ReplaceAllPatch
): {
  readonly rows: Record<string, unknown>[];
  readonly keys: RelationKeyValue[];
  readonly diagnostics: readonly TarstateDiagnostic[];
} {
  const diagnostics: TarstateDiagnostic[] = [];
  const rows: Record<string, unknown>[] = [];
  const keys: RelationKeyValue[] = [];
  const seenKeys = new Set<unknown>();

  if (!Array.isArray(patch.rows)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `rows for relation ${patch.relation.name} are not an array`,
      relation: patch.relation.name,
      detail: patch.rows
    });
    return { rows, keys, diagnostics };
  }

  for (const input of patch.rows) {
    const row = validPatchRow(plan, input, diagnostics);

    if (row === undefined) {
      continue;
    }

    const key = rowKey(plan, row);

    if (key === undefined) {
      diagnostics.push(missingKeyDiagnostic(patch.relation));
      continue;
    }

    if (seenKeys.has(key.indexKey)) {
      diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(key)));
      continue;
    }

    seenKeys.add(key.indexKey);
    keys.push(key);
    rows.push(copyRow(row));
  }

  return { rows, keys, diagnostics };
}

function validPatchRow(
  plan: RelationWritePlan,
  input: unknown,
  diagnostics: TarstateDiagnostic[]
): Record<string, unknown> | undefined {
  if (!isRecord(input)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${plan.relation.name} is not an object`,
      relation: plan.relation.name,
      detail: input
    });
    return undefined;
  }

  const rowDiagnostics = validateRow(plan, input);

  if (rowDiagnostics.length > 0) {
    diagnostics.push(...rowDiagnostics);
    return undefined;
  }

  return input;
}

function validateRow(plan: RelationWritePlan, row: Record<string, unknown>): TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];
  const relationName = plan.relation.name;

  for (const [fieldName, spec] of plan.fieldEntries) {
    const hasField = Object.hasOwn(row, fieldName);
    const value = row[fieldName];

    if (!hasField || value === undefined) {
      if (!spec.optional) {
        diagnostics.push({
          code: 'invalid_row',
          message: `missing required field ${fieldName} in relation ${relationName}`,
          relation: relationName,
          field: fieldName
        });
      }
      continue;
    }

    if (value === null) {
      if (!spec.nullable) {
        diagnostics.push({
          code: 'invalid_row',
          message: `null field ${fieldName} is not nullable in relation ${relationName}`,
          relation: relationName,
          field: fieldName
        });
      }
      continue;
    }

    if (!valueMatches(spec, value)) {
      diagnostics.push({
        code: 'invalid_row',
        message: `invalid field ${fieldName} in relation ${relationName}`,
        relation: relationName,
        field: fieldName,
        detail: value
      });
    }
  }

  return diagnostics;
}

function valueMatches(spec: FieldSpec, value: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'anchoredPath':
      return Array.isArray(value);
    case 'json':
      return isJsonValue(value);
  }
}

function hasNamedRelation(relationRef: RelationRef, diagnostics: TarstateDiagnostic[]): boolean {
  if (relationRef.name.length > 0) {
    return true;
  }

  diagnostics.push({
    code: 'invalid_row',
    message: 'relation is unnamed; call defineSchema before writing'
  });
  return false;
}

function planFor(context: WriteApplyContext, relationRef: RelationRef): RelationWritePlan {
  const existingPlan = context.relationPlans.get(relationRef.name);

  if (existingPlan !== undefined) {
    return existingPlan;
  }

  const keyFields = relationKeyFields(relationRef);
  const plan: RelationWritePlan = {
    relation: relationRef,
    keyFields,
    singleKeyField: keyFields.length === 1 ? keyFields[0] : undefined,
    fieldEntries: Object.entries(relationRef.fields)
  };

  context.relationPlans.set(relationRef.name, plan);
  return plan;
}

function keyFromInput(
  plan: RelationWritePlan,
  input: RelationKeyInput,
  diagnostics: TarstateDiagnostic[]
): RelationKeyValue | undefined {
  if (plan.singleKeyField !== undefined) {
    if (Array.isArray(input)) {
      if (input.length !== 1) {
        diagnostics.push({
          code: 'invalid_row',
          message: `key for relation ${plan.relation.name} requires 1 field value`,
          relation: plan.relation.name,
          detail: input
        });
        return undefined;
      }

      if (input[0] === undefined) {
        diagnostics.push({
          code: 'invalid_row',
          message: `missing key field ${plan.singleKeyField} in relation ${plan.relation.name}`,
          relation: plan.relation.name,
          field: plan.singleKeyField
        });
        return undefined;
      }

      return keyValueFor(input);
    }

    if (typeof input !== 'string' && typeof input !== 'number') {
      diagnostics.push({
        code: 'invalid_row',
        message: `key for relation ${plan.relation.name} requires a string, number, or one-field tuple`,
        relation: plan.relation.name,
        detail: input
      });
      return undefined;
    }

    return keyValueFor([input]);
  }

  const keyFields = plan.keyFields;

  if (!Array.isArray(input)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `composite key for relation ${plan.relation.name} requires ${keyFields.join(', ')}`,
      relation: plan.relation.name,
      detail: input
    });
    return undefined;
  }

  const values = input;

  if (values.length !== keyFields.length) {
    diagnostics.push({
      code: 'invalid_row',
      message: `key for relation ${plan.relation.name} requires ${keyFields.length} field values`,
      relation: plan.relation.name,
      detail: input
    });
    return undefined;
  }

  const missingIndex = values.findIndex((value) => value === undefined);

  if (missingIndex !== -1) {
    const missingField = keyFields[missingIndex];

    diagnostics.push({
      code: 'invalid_row',
      message: `missing key field ${missingField ?? '<unknown>'} in relation ${plan.relation.name}`,
      relation: plan.relation.name,
      ...(missingField === undefined ? {} : { field: missingField })
    });
    return undefined;
  }

  return keyValueFor(values);
}

function rowKey(plan: RelationWritePlan, row: Record<string, unknown>): RelationKeyValue | undefined {
  if (plan.singleKeyField !== undefined) {
    const value = row[plan.singleKeyField];

    if (value === undefined) {
      return undefined;
    }

    return keyValueFor([value]);
  }

  const values: unknown[] = [];

  for (const keyField of plan.keyFields) {
    const value = row[keyField];

    if (value === undefined) {
      return undefined;
    }

    values.push(value);
  }

  return keyValueFor(values);
}

function keyValueFor(values: readonly unknown[]): RelationKeyValue {
  const singleValue = values.length === 1 ? values[0] : undefined;

  if (isFastSingleKey(singleValue)) {
    return { indexKey: singleValue, diagnosticKey: undefined };
  }

  const diagnosticKey = JSON.stringify(values);
  return { indexKey: diagnosticKey, diagnosticKey };
}

function keyDiagnostic(key: RelationKeyValue): string {
  return key.diagnosticKey ?? JSON.stringify([key.indexKey]);
}

function isFastSingleKey(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  return typeof value === 'number' && Number.isFinite(value);
}

function relationKeyFields(relationRef: RelationRef): readonly string[] {
  return typeof relationRef.key === 'string' ? [relationRef.key] : relationRef.key;
}

function stateFor(context: WriteApplyContext, plan: RelationWritePlan, createRows: boolean): RelationWriteState {
  const relationRef = plan.relation;
  const existingState = context.relationStates.get(relationRef.name);

  if (existingState !== undefined) {
    if (createRows && context.data[relationRef.name] === undefined) {
      context.data[relationRef.name] = existingState.rows;
    }

    return existingState;
  }

  const existingRows = context.data[relationRef.name];
  const rows = existingRows ?? [];
  const state = indexStateFor(plan, rows);

  context.relationStates.set(relationRef.name, state);

  if (createRows && existingRows === undefined) {
    context.data[relationRef.name] = rows;
  }

  return state;
}

function indexStateFor(plan: RelationWritePlan, rows: unknown[]): RelationWriteState {
  const indexes = new Map<unknown, number>();
  const duplicateKeys = new Set<unknown>();
  const rowKeys: (RelationKeyValue | undefined)[] = Array.from({ length: rows.length });

  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      continue;
    }

    const key = rowKey(plan, row);

    if (key === undefined) {
      continue;
    }

    rowKeys[index] = key;

    if (indexes.has(key.indexKey)) {
      duplicateKeys.add(key.indexKey);
    } else {
      indexes.set(key.indexKey, index);
    }
  }

  return { rows, indexes, duplicateKeys, rowKeys };
}

function singleIndexForKey(
  state: RelationWriteState,
  relationRef: RelationRef,
  key: RelationKeyValue,
  diagnostics: TarstateDiagnostic[]
): number | undefined {
  if (state.duplicateKeys.has(key.indexKey)) {
    diagnostics.push(duplicateKeyDiagnostic(relationRef, keyDiagnostic(key)));
    return undefined;
  }

  const index = state.indexes.get(key.indexKey);

  if (index === undefined) {
    const diagnosticKey = keyDiagnostic(key);

    diagnostics.push({
      code: 'invalid_row',
      message: `missing row ${diagnosticKey} in relation ${relationRef.name}`,
      relation: relationRef.name,
      key: diagnosticKey
    });
    return undefined;
  }

  return index;
}

function hasIndexedKey(state: RelationWriteState, key: RelationKeyValue): boolean {
  return state.duplicateKeys.has(key.indexKey) || state.indexes.has(key.indexKey);
}

function hasConflictingIndexedKey(state: RelationWriteState, key: RelationKeyValue, currentIndex: number): boolean {
  if (state.duplicateKeys.has(key.indexKey)) {
    return true;
  }

  const existingIndex = state.indexes.get(key.indexKey);
  return existingIndex !== undefined && existingIndex !== currentIndex;
}

function addIndexedRow(state: RelationWriteState, key: RelationKeyValue, row: Record<string, unknown>): void {
  state.indexes.set(key.indexKey, state.rows.length);
  state.rowKeys.push(key);
  state.rows.push(row);
}

function replaceAllIndexedRows(
  context: WriteApplyContext,
  plan: RelationWritePlan,
  rows: Record<string, unknown>[],
  keys: RelationKeyValue[]
): void {
  const indexes = new Map<unknown, number>();

  for (const [index, key] of keys.entries()) {
    indexes.set(key.indexKey, index);
  }

  const state: RelationWriteState = {
    rows,
    indexes,
    duplicateKeys: new Set(),
    rowKeys: [...keys]
  };

  context.data[plan.relation.name] = rows;
  context.relationStates.set(plan.relation.name, state);
}

function replaceIndexedRow(
  state: RelationWriteState,
  index: number,
  previousKey: RelationKeyValue,
  nextKey: RelationKeyValue,
  row: Record<string, unknown>
): void {
  state.rows[index] = row;
  state.rowKeys[index] = nextKey;

  if (!sameIndexKey(previousKey, nextKey)) {
    state.indexes.delete(previousKey.indexKey);
    state.indexes.set(nextKey.indexKey, index);
  }
}

function deleteIndexedRow(state: RelationWriteState, key: RelationKeyValue, index: number): void {
  state.rows.splice(index, 1);
  state.rowKeys.splice(index, 1);
  state.indexes.delete(key.indexKey);

  for (let nextIndex = index; nextIndex < state.rowKeys.length; nextIndex += 1) {
    const nextKey = state.rowKeys[nextIndex];

    if (nextKey !== undefined && state.indexes.has(nextKey.indexKey)) {
      state.indexes.set(nextKey.indexKey, nextIndex);
    }
  }
}

function sameIndexKey(left: RelationKeyValue, right: RelationKeyValue): boolean {
  return left.indexKey === right.indexKey || (left.indexKey !== left.indexKey && right.indexKey !== right.indexKey);
}

function duplicateKeyDiagnostic(relationRef: RelationRef, key: string): TarstateDiagnostic {
  return {
    code: 'duplicate_key',
    message: `duplicate key ${key} in relation ${relationRef.name}`,
    relation: relationRef.name,
    key
  };
}

function missingKeyDiagnostic(relationRef: RelationRef): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    message: `missing key in relation ${relationRef.name}`,
    relation: relationRef.name
  };
}

function copyRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

function exactRowMatches(left: unknown, right: Record<string, unknown>): boolean {
  return isRecord(left) && stableKey(left) === stableKey(right);
}

function cloneMutableData(data: MutableObjectSourceData): MutableObjectSourceData {
  const output: MutableObjectSourceData = {};

  for (const [relationName, rows] of Object.entries(data)) {
    output[relationName] = Array.from(rows);
  }

  return output;
}

function replaceMutableData(target: MutableObjectSourceData, source: MutableObjectSourceData): void {
  for (const relationName of Object.keys(target)) {
    delete target[relationName];
  }

  for (const [relationName, rows] of Object.entries(source)) {
    target[relationName] = rows;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
