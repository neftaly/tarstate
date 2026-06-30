import type { TarstateDiagnostic } from './diagnostics.js';
import type { FieldSpec, RelationRef } from './schema.js';

/** Row type carried by a relation reference. */
export type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;

/** Partial row changes for a relation update patch. */
export type RelationRowUpdate<Relation extends RelationRef> = Partial<RelationRow<Relation>>;

/** Key input accepted by update and delete patches. */
export type RelationKeyInput<Row extends Record<string, unknown>> =
  | Row[keyof Row & string]
  | readonly unknown[]
  | Partial<Row>;

/** Mutable object-backed relation rows used by write application. */
export type MutableObjectSourceData = Record<string, unknown[]>;

export type InsertPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insert';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
};

export type UpdatePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'update';
  readonly relation: Relation;
  readonly key: RelationKeyInput<RelationRow<Relation>>;
  readonly changes: RelationRowUpdate<Relation>;
};

export type UpsertPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'upsert';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
};

export type DeletePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'delete';
  readonly relation: Relation;
  readonly key: RelationKeyInput<RelationRow<Relation>>;
};

/** Canonical mutation patch understood by `applyWrites`. */
export type WritePatch<Relation extends RelationRef = RelationRef> =
  | InsertPatch<Relation>
  | UpdatePatch<Relation>
  | UpsertPatch<Relation>
  | DeletePatch<Relation>;

/** Relation-scoped patch constructors. */
export type RelationWriter<Relation extends RelationRef> = {
  readonly insert: (row: RelationRow<Relation>) => InsertPatch<Relation>;
  readonly update: (
    key: RelationKeyInput<RelationRow<Relation>>,
    changes: RelationRowUpdate<Relation>
  ) => UpdatePatch<Relation>;
  readonly upsert: (row: RelationRow<Relation>) => UpsertPatch<Relation>;
  readonly delete: (key: RelationKeyInput<RelationRow<Relation>>) => DeletePatch<Relation>;
};

/** Result from applying a batch of write patches. */
export type WriteApplyResult = {
  readonly patches: number;
  readonly applied: number;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

type WriteApplyContext = {
  readonly data: MutableObjectSourceData;
  readonly diagnostics: TarstateDiagnostic[];
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

/** Build a typed writer for one relation. */
export function write<Relation extends RelationRef>(relation: Relation): RelationWriter<Relation> {
  return {
    insert: (row) => insert(relation, row),
    update: (key, changes) => update(relation, key, changes),
    upsert: (row) => upsert(relation, row),
    delete: (key) => deleteRow(relation, key)
  };
}

/** Create an insert patch. */
export function insert<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertPatch<Relation> {
  return { op: 'insert', relation, row };
}

/** Create an update patch. */
export function update<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyInput<RelationRow<Relation>>,
  changes: RelationRowUpdate<Relation>
): UpdatePatch<Relation> {
  return { op: 'update', relation, key, changes };
}

/** Create an upsert patch. */
export function upsert<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): UpsertPatch<Relation> {
  return { op: 'upsert', relation, row };
}

/** Create a delete patch. */
export function deleteRow<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyInput<RelationRow<Relation>>
): DeletePatch<Relation> {
  return { op: 'delete', relation, key };
}

/**
 * Apply write patches to mutable object-backed relation arrays.
 *
 * @remarks Patches are applied in order. Invalid or ambiguous patches report diagnostics and do not mutate data.
 */
export function applyWrites(data: MutableObjectSourceData, patches: Iterable<WritePatch>): WriteApplyResult {
  const diagnostics: TarstateDiagnostic[] = [];
  const context: WriteApplyContext = {
    data,
    diagnostics,
    relationStates: new Map(),
    relationPlans: new Map()
  };
  let patchCount = 0;
  let applied = 0;

  for (const patch of patches) {
    patchCount += 1;

    if (applyWrite(context, patch)) {
      applied += 1;
    }
  }

  return { patches: patchCount, applied, diagnostics };
}

function applyWrite(context: WriteApplyContext, patch: WritePatch): boolean {
  if (!hasNamedRelation(patch.relation, context.diagnostics)) {
    return false;
  }

  const plan = planFor(context, patch.relation);

  switch (patch.op) {
    case 'insert':
      return applyInsert(context, plan, patch);
    case 'update':
      return applyUpdate(context, plan, patch);
    case 'upsert':
      return applyUpsert(context, plan, patch);
    case 'delete':
      return applyDelete(context, plan, patch);
  }
}

function applyInsert(context: WriteApplyContext, plan: RelationWritePlan, patch: InsertPatch): boolean {
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
    context.diagnostics.push(duplicateKeyDiagnostic(patch.relation, keyDiagnostic(key)));
    return false;
  }

  addIndexedRow(state, key, copyRow(row));
  return true;
}

function applyUpdate(context: WriteApplyContext, plan: RelationWritePlan, patch: UpdatePatch): boolean {
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
  return true;
}

function applyUpsert(context: WriteApplyContext, plan: RelationWritePlan, patch: UpsertPatch): boolean {
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

  if (existingIndex === undefined) {
    addIndexedRow(state, key, copyRow(row));
  } else {
    state.rows[existingIndex] = copyRow(row);
    state.rowKeys[existingIndex] = key;
  }

  return true;
}

function applyDelete(context: WriteApplyContext, plan: RelationWritePlan, patch: DeletePatch): boolean {
  const key = keyFromInput(plan, patch.key, context.diagnostics);

  if (key === undefined) {
    return false;
  }

  const state = stateFor(context, plan, false);
  const index = singleIndexForKey(state, patch.relation, key, context.diagnostics);

  if (index === undefined) {
    return false;
  }

  deleteIndexedRow(state, key, index);
  return true;
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
  input: RelationKeyInput<Record<string, unknown>>,
  diagnostics: TarstateDiagnostic[]
): RelationKeyValue | undefined {
  if (plan.singleKeyField !== undefined) {
    const value = isRecord(input) ? input[plan.singleKeyField] : input;

    if (value === undefined) {
      diagnostics.push({
        code: 'invalid_row',
        message: `missing key field ${plan.singleKeyField} in relation ${plan.relation.name}`,
        relation: plan.relation.name,
        field: plan.singleKeyField
      });
      return undefined;
    }

    return keyValueFor([value]);
  }

  const keyFields = plan.keyFields;

  if (!isRecord(input) && !Array.isArray(input)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `composite key for relation ${plan.relation.name} requires ${keyFields.join(', ')}`,
      relation: plan.relation.name,
      detail: input
    });
    return undefined;
  }

  const values = isRecord(input) ? keyFields.map((fieldName) => input[fieldName]) : input;

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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
