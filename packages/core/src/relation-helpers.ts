import { isRecord, stableKey } from './internal.js';
import { isJsonValue } from './schema.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import type { FieldSpec, RelationRef } from './schema.js';
import type { RelationRangeBound } from './source-types.js';

type RelationKeyScalar = string | number | boolean;
type RelationKeyJsonObject = { readonly [key: string]: RelationKeyJsonValue };
type RelationKeyJsonValue = RelationKeyScalar | null | readonly RelationKeyJsonValue[] | RelationKeyJsonObject;
type RelationKeyInputValue = RelationKeyScalar | readonly RelationKeyJsonValue[];
type RelationKeyFieldInputValue<Value> = Extract<Exclude<Value, null | undefined>, RelationKeyInputValue>;
type RelationKeyFieldValue<Value> = [RelationKeyFieldInputValue<Value>] extends [never]
  ? RelationKeyScalar
  : RelationKeyFieldInputValue<Value>;

export type RelationKeyInput = RelationKeyInputValue;
export type RelationKeyValue<Relation extends RelationRef> =
  Relation extends RelationRef<infer Row, infer Key>
    ? string extends Key
      ? RelationKeyInput
      : readonly string[] extends Key
        ? RelationKeyInput
        : Key extends readonly (keyof Row & string)[]
      ? { readonly [Index in keyof Key]: Key[Index] extends keyof Row ? RelationKeyFieldValue<Row[Key[Index]]> : never }
      : Key extends keyof Row
        ? RelationKeyFieldValue<Row[Key]>
        : RelationKeyInput
    : RelationKeyInput;

export function validateRelationRow(relationRef: RelationRef, rowValue: Record<string, unknown>): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  if (!isRecord(rowValue)) {
    diagnostics.push({
      code: 'row_invalid',
      severity: 'error',
      message: `row for relation "${relationRef.name}" must be an object`,
      relation: relationRef.name,
      surface: 'validateRelationRow',
      detail: rowValue
    });
    return diagnostics;
  }

  const invalidFields = new Set<string>();
  for (const [fieldName, spec] of Object.entries(relationRef.fields)) {
    const hasField = Object.prototype.hasOwnProperty.call(rowValue, fieldName);
    const fieldValue = rowValue[fieldName];

    if (!hasField || fieldValue === undefined) {
      if (!spec.optional) {
        diagnostics.push({
          code: 'field_missing',
          severity: 'error',
          message: `relation "${relationRef.name}" row is missing required field "${fieldName}"`,
          relation: relationRef.name,
          field: fieldName,
          surface: 'validateRelationRow'
        });
      }
      continue;
    }

    if (fieldValue === null) {
      if (!spec.nullable) {
        invalidFields.add(fieldName);
        diagnostics.push({
          code: 'field_invalid',
          severity: 'error',
          message: `relation "${relationRef.name}" field "${fieldName}" must not be null`,
          relation: relationRef.name,
          field: fieldName,
          surface: 'validateRelationRow'
        });
      }
      continue;
    }

    if (!fieldValueMatchesSpec(spec, fieldValue)) {
      invalidFields.add(fieldName);
      diagnostics.push({
        code: 'field_invalid',
        severity: 'error',
        message: `relation "${relationRef.name}" field "${fieldName}" must be ${fieldSpecDescription(spec)}`,
        relation: relationRef.name,
        field: fieldName,
        surface: 'validateRelationRow',
        detail: fieldValue
      });
    }
  }

  for (const keyField of relationKeyFields(relationRef)) {
    const keyValue = rowValue[keyField];
    if (keyValue === undefined || keyValue === null) {
      diagnostics.push({
        code: 'field_missing',
        severity: 'error',
        message: `relation "${relationRef.name}" key field "${keyField}" is missing`,
        relation: relationRef.name,
        field: keyField,
        surface: 'validateRelationRow'
      });
      continue;
    }

    const spec = relationRef.fields[keyField];
    if (invalidFields.has(keyField)) continue;
    if (
      spec?.valueKind === 'custom'
      && spec.custom?.stableKey === undefined
      && spec.custom?.toScalar === undefined
    ) {
      diagnostics.push({
        code: 'field_invalid',
        severity: 'error',
        message: `relation "${relationRef.name}" key field "${keyField}" must define stableKey or toScalar`,
        relation: relationRef.name,
        field: keyField,
        surface: 'validateRelationRow',
        detail: keyValue
      });
    } else if (
      spec?.valueKind === 'custom'
      && spec.custom?.stableKey === undefined
      && spec.custom?.toScalar !== undefined
      && !isRelationKeyScalar(spec.custom.toScalar(keyValue))
    ) {
      diagnostics.push({
        code: 'field_invalid',
        severity: 'error',
        message: `relation "${relationRef.name}" key field "${keyField}" must convert to a string, finite number, or boolean`,
        relation: relationRef.name,
        field: keyField,
        surface: 'validateRelationRow',
        detail: keyValue
      });
    }
  }

  return diagnostics;
}

export function rowKey(relationRef: RelationRef, row: Record<string, unknown>): string | undefined {
  const fields = relationKeyFields(relationRef);
  const values: unknown[] = [];

  for (const fieldName of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, fieldName) || row[fieldName] === undefined || row[fieldName] === null) return undefined;
    const fieldValue = row[fieldName];
    const spec = relationRef.fields[fieldName];
    const keyValue = spec === undefined ? fieldValue : fieldKeyValue(spec, fieldValue);
    if (keyValue === undefined) return undefined;
    values.push(keyValue);
  }

  return stableKey(values);
}

export function relationKeyFields(relationRef: RelationRef): readonly string[] {
  return Array.isArray(relationRef.key) ? [...relationRef.key] : [relationRef.key as string];
}

export function relationKeyInputKey(relationRef: RelationRef, input: unknown): string | undefined {
  const values = relationKeyInputValues(relationRef, input);
  return values === undefined ? undefined : stableKey(values);
}

export function relationKeyInputValues(relationRef: RelationRef, input: unknown): readonly unknown[] | undefined {
  if (!isRelationKeyInput(input)) return undefined;
  const fields = relationKeyFields(relationRef);
  const inputValues = fields.length === 1
    ? [input]
    : Array.isArray(input) && input.length === fields.length ? input : undefined;
  if (inputValues === undefined) return undefined;

  const values = inputValues.map((valueValue, indexValue) => {
    const fieldName = fields[indexValue];
    const spec = fieldName === undefined ? undefined : relationRef.fields[fieldName];
    return spec === undefined ? valueValue : fieldKeyInputValue(spec, valueValue);
  });

  return values.length === fields.length && values.every((valueValue) => valueValue !== undefined)
    ? values
    : undefined;
}

export function isRelationKeyInput(input: unknown): input is RelationKeyInput {
  return isRelationKeyInputValue(input);
}

export function relationKeyInputToKey(relationRef: RelationRef, input: RelationKeyInput): string {
  return stableKey(relationKeyInputValues(relationRef, input) ?? []);
}

export function relationKeyInputMatchesRow(
  relationRef: RelationRef,
  input: RelationKeyInput,
  rowValue: Record<string, unknown>
): boolean {
  const fields = relationKeyFields(relationRef);
  return relationKeyFieldsMatchInput(relationRef, rowValue, fields, input);
}

export function relationRowKeyMatchesRow(
  relationRef: RelationRef,
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  const fields = relationKeyFields(relationRef);
  const fieldName = fields.length === 1 ? fields[0] : undefined;
  if (fieldName !== undefined) {
    const valueValue = right[fieldName];
    if (valueValue === undefined) return false;
    if (canCompareRelationKeyAtom(valueValue)) {
      return relationKeyFieldRowValueMatches(relationRef, left, fieldName, valueValue);
    }
  }
  const key = rowKey(relationRef, right);
  return key !== undefined && rowKey(relationRef, left) === key;
}

export function relationFieldValueMatchesSpec(spec: FieldSpec | undefined, valueValue: unknown): boolean {
  return spec === undefined || fieldValueMatchesSpec(spec, valueValue);
}

export function relationFieldReadValue(spec: FieldSpec | undefined, valueValue: unknown): unknown {
  return fieldReadValue(spec, valueValue);
}

export function relationFieldKeyValue(spec: FieldSpec | undefined, valueValue: unknown): unknown {
  return spec === undefined ? valueValue : fieldKeyValue(spec, valueValue);
}

export function relationFieldKeyInputValue(spec: FieldSpec | undefined, valueValue: unknown): unknown {
  return spec === undefined ? valueValue : fieldKeyInputValue(spec, valueValue);
}

export function relationFieldLookupMatches(spec: FieldSpec | undefined, fieldValue: unknown, lookupValue: unknown): boolean {
  return fieldLookupMatches(spec, fieldValue, lookupValue);
}

export function relationFieldValueInRange(
  spec: FieldSpec | undefined,
  valueValue: unknown,
  lower: RelationRangeBound | undefined,
  upper: RelationRangeBound | undefined
): boolean {
  return fieldValueInRange(spec, valueValue, lower, upper);
}

export function relationFieldCompareToBound(
  spec: FieldSpec | undefined,
  valueValue: unknown,
  boundValue: unknown
): number | undefined {
  return compareFieldValueToBound(spec, valueValue, boundValue);
}

export function relationFieldSpecDescription(spec: FieldSpec): string {
  return fieldSpecDescription(spec);
}

export function relationSourceLookupValueForKey(spec: FieldSpec | undefined, keyInput: unknown): unknown {
  if (spec?.valueKind !== 'custom' || spec.custom?.toScalar === undefined) return keyInput;
  return fieldKeyInputValue(spec, keyInput);
}

export function canUseScalarSourceLookup(input: unknown): boolean {
  return isRelationKeyScalar(input);
}

export function fieldValueMatchesSpec(spec: FieldSpec, valueValue: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
      return typeof valueValue === 'string' && (spec.values === undefined || spec.values.includes(valueValue));
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof valueValue === 'string';
    case 'number':
      return typeof valueValue === 'number' && Number.isFinite(valueValue);
    case 'boolean':
      return typeof valueValue === 'boolean';
    case 'json':
      return isJsonValue(valueValue);
    case 'custom':
      return spec.custom?.validate === undefined || spec.custom.validate(valueValue);
    default:
      return true;
  }
}

export function fieldReadValue(spec: FieldSpec | undefined, valueValue: unknown): unknown {
  if (spec?.valueKind !== 'custom' || spec.custom?.toScalar === undefined || valueValue === null || valueValue === undefined) {
    return valueValue;
  }
  return spec.custom.toScalar(valueValue);
}

export function fieldKeyValue(spec: FieldSpec, valueValue: unknown): unknown {
  if (spec.valueKind !== 'custom') return valueValue;
  if (valueValue === null || valueValue === undefined) return valueValue;
  if (!fieldValueMatchesSpec(spec, valueValue)) return undefined;
  if (spec.custom?.stableKey !== undefined) return spec.custom.stableKey(valueValue);
  if (spec.custom?.toScalar !== undefined) {
    const scalar = spec.custom.toScalar(valueValue);
    return isRelationKeyScalar(scalar) ? scalar : undefined;
  }
  return undefined;
}

export function fieldKeyInputValue(spec: FieldSpec, valueValue: unknown): unknown {
  if (spec.valueKind === 'json') return isRelationKeyInputValue(valueValue) ? valueValue : undefined;
  if (spec.valueKind !== 'custom' && !fieldValueMatchesSpec(spec, valueValue)) return undefined;
  if (spec.valueKind !== 'custom') return valueValue;
  if (!isRelationKeyScalar(valueValue)) return undefined;
  if (spec.custom?.stableKey !== undefined) return valueValue;
  if (spec.custom?.toScalar !== undefined && fieldValueMatchesSpec(spec, valueValue)) {
    const scalar = spec.custom.toScalar(valueValue);
    return isRelationKeyScalar(scalar) ? scalar : undefined;
  }
  return valueValue;
}

export function fieldLookupMatches(spec: FieldSpec | undefined, fieldValue: unknown, lookupValue: unknown): boolean {
  if (spec?.valueKind === 'json') {
    return relationKeyValuesEqual(fieldValue, lookupValue);
  }
  if (spec?.valueKind === 'custom' && spec.custom?.stableKey !== undefined) {
    return spec.custom.stableKey(fieldValue) === spec.custom.stableKey(lookupValue);
  }
  if (
    spec?.valueKind === 'custom'
    && spec.custom?.compare !== undefined
    && fieldValueMatchesSpec(spec, fieldValue)
    && fieldValueMatchesSpec(spec, lookupValue)
  ) {
    return spec.custom.compare(fieldValue, lookupValue) === 0;
  }
  if (spec?.valueKind === 'custom' && spec.custom?.toScalar !== undefined) {
    if (!fieldValueMatchesSpec(spec, fieldValue)) return false;
    const scalarLookupValue = fieldValueMatchesSpec(spec, lookupValue)
      ? fieldReadValue(spec, lookupValue)
      : lookupValue;
    return Object.is(fieldReadValue(spec, fieldValue), scalarLookupValue);
  }
  return Object.is(fieldValue, lookupValue);
}

export function fieldValueInRange(
  spec: FieldSpec | undefined,
  valueValue: unknown,
  lower: RelationRangeBound | undefined,
  upper: RelationRangeBound | undefined
): boolean {
  if (lower !== undefined) {
    const comparisonValue = compareFieldValueToBound(spec, valueValue, lower.value);
    if (comparisonValue === undefined || comparisonValue < 0 || (comparisonValue === 0 && !lower.inclusive)) return false;
  }
  if (upper !== undefined) {
    const comparisonValue = compareFieldValueToBound(spec, valueValue, upper.value);
    if (comparisonValue === undefined || comparisonValue > 0 || (comparisonValue === 0 && !upper.inclusive)) return false;
  }
  return true;
}

export function compareFieldValueToBound(spec: FieldSpec | undefined, valueValue: unknown, boundValue: unknown): number | undefined {
  if (spec?.valueKind !== 'custom') return compareValues(valueValue, boundValue);
  if (
    spec.custom?.compare !== undefined
    && fieldValueMatchesSpec(spec, valueValue)
    && fieldValueMatchesSpec(spec, boundValue)
  ) {
    return spec.custom.compare(valueValue, boundValue);
  }
  if (spec.custom?.toScalar !== undefined && fieldValueMatchesSpec(spec, valueValue)) {
    const scalarBoundValue = fieldValueMatchesSpec(spec, boundValue)
      ? fieldReadValue(spec, boundValue)
      : boundValue;
    return compareValues(fieldReadValue(spec, valueValue), scalarBoundValue);
  }
  return undefined;
}

export function fieldSpecDescription(spec: FieldSpec): string {
  switch (spec.valueKind) {
    case 'string':
      return spec.values === undefined
        ? 'a string'
        : `one of ${spec.values.map((valueValue) => JSON.stringify(valueValue)).join(', ')}`;
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return 'a string';
    case 'json':
      return 'a JSON value';
    case 'custom':
      return spec.custom?.description ?? `a ${spec.custom?.codec ?? 'custom'} value`;
    default:
      return `a ${spec.valueKind}`;
  }
}

export function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() < right.getTime() ? -1 : 1;
  if (left instanceof Uint8Array && right instanceof Uint8Array) return compareBytes(left, right);
  return stableKey(left).localeCompare(stableKey(right));
}

function relationKeyFieldRowValueMatches(
  relationRef: RelationRef,
  rowValue: Record<string, unknown>,
  fieldName: string,
  valueValue: unknown
): boolean {
  const fieldValue = rowValue[fieldName];
  if (fieldValue === undefined) return false;
  const spec = relationRef.fields[fieldName];
  const left = spec === undefined ? fieldValue : fieldKeyValue(spec, fieldValue);
  const right = spec === undefined ? valueValue : fieldKeyValue(spec, valueValue);
  return left !== undefined && right !== undefined && relationKeyValuesEqual(left, right);
}

function relationKeyFieldValueMatches(
  relationRef: RelationRef,
  rowValue: Record<string, unknown>,
  fieldName: string,
  valueValue: unknown
): boolean {
  const fieldValue = rowValue[fieldName];
  if (fieldValue === undefined) return false;
  const spec = relationRef.fields[fieldName];
  const left = spec === undefined ? fieldValue : fieldKeyValue(spec, fieldValue);
  const right = spec === undefined ? valueValue : fieldKeyInputValue(spec, valueValue);
  return left !== undefined && right !== undefined && relationKeyValuesEqual(left, right);
}

export function relationKeyValuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || (
    isRelationKeyInputValue(left)
    && isRelationKeyInputValue(right)
    && stableKey(left) === stableKey(right)
  );
}

function relationKeyFieldsMatchInput(
  relationRef: RelationRef,
  rowValue: Record<string, unknown>,
  fields: readonly string[],
  input: RelationKeyInput
): boolean {
  const values = relationKeyInputValues(relationRef, input);
  if (values === undefined || values.length !== fields.length) return false;
  for (let index = 0; index < fields.length; index += 1) {
    const fieldName = fields[index];
    const valueValue = values[index];
    if (
      fieldName === undefined
      || valueValue === undefined
      || !relationKeyFieldValueMatches(relationRef, rowValue, fieldName, valueValue)
    ) {
      return false;
    }
  }
  return true;
}

function canCompareRelationKeyAtom(input: unknown): boolean {
  return isRelationKeyInputValue(input);
}

function isRelationKeyScalar(input: unknown): input is RelationKeyScalar {
  return typeof input === 'string' || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input));
}

function isRelationKeyInputValue(input: unknown): input is RelationKeyInputValue {
  return isRelationKeyScalar(input) || (Array.isArray(input) && isJsonValue(input));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}
