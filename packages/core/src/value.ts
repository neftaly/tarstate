import { createIssue, type Issue, type ParseResult } from './issues.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const missingValue = Symbol('tarstate.value.missing');
export const logicalUnknown = Symbol('tarstate.value.logical-unknown');
export const capabilityUnavailable = Symbol('tarstate.value.capability-unavailable');

export type MissingValue = typeof missingValue;
export type LogicalUnknown = typeof logicalUnknown;
export type CapabilityUnavailable = typeof capabilityUnavailable;
export type LogicalTruth = boolean | LogicalUnknown;
export type EvaluationValue = JsonValue | MissingValue | LogicalUnknown | CapabilityUnavailable;

export type TaggedValue = {
  readonly kind: 'tarstate.value';
  readonly type: string;
  readonly value: JsonValue;
};

export type PortableValue = JsonValue | TaggedValue;

export type ValueParseBudget = {
  readonly maxDepth: number;
  readonly maxArrayMembers: number;
  readonly maxObjectMembers: number;
  readonly maxTotalMembers: number;
};

export const defaultValueParseBudget: ValueParseBudget = {
  maxDepth: 64,
  maxArrayMembers: 100_000,
  maxObjectMembers: 100_000,
  maxTotalMembers: 500_000
};

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const inspectionFailure = Symbol('inspectionFailure');
type InspectionFailure = { readonly [inspectionFailure]: Issue };
const failedInspection = (issue: Issue): InspectionFailure => ({ [inspectionFailure]: issue });
const isInspectionFailure = (value: JsonValue | InspectionFailure): value is InspectionFailure => inspectionFailure in Object(value);

export const safeParseJsonValue = (input: unknown, budget: ValueParseBudget = defaultValueParseBudget): ParseResult<JsonValue> => {
  const seen = new Set<object>();
  let totalMembers = 0;
  const inspect = (value: unknown, depth: number, path: readonly unknown[]): JsonValue | InspectionFailure => {
    if (depth > budget.maxDepth) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path, details: { budget: 'maxDepth', limit: budget.maxDepth } }));
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return failedInspection(createIssue({ code: 'artifact.unsupported_value', retry: 'after_input', path, details: { type: 'non_finite_number' } }));
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') return failedInspection(createIssue({ code: 'artifact.unsupported_value', retry: 'after_input', path, details: { type: typeof value } }));
    try {
      if (seen.has(value)) return failedInspection(createIssue({ code: 'artifact.cycle', retry: 'after_input', path }));
      if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path, details: { reason: 'prototype' } }));
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > budget.maxArrayMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path, details: { budget: 'maxArrayMembers', limit: budget.maxArrayMembers } }));
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: [...path, index], details: { reason: 'sparse_array' } }));
          if (!descriptor.enumerable || !('value' in descriptor)) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: [...path, index], details: { reason: 'array_descriptor' } }));
        }
        totalMembers += value.length;
        if (totalMembers > budget.maxTotalMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path, details: { budget: 'maxTotalMembers', limit: budget.maxTotalMembers } }));
        const output: JsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const parsed = inspect((descriptors[String(index)] as PropertyDescriptor & { readonly value: unknown }).value, depth + 1, [...path, index]);
          if (isInspectionFailure(parsed)) return parsed;
          output.push(parsed);
        }
        return output;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path, details: { reason: 'symbol_key' } }));
      if (keys.length > budget.maxObjectMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path, details: { budget: 'maxObjectMembers', limit: budget.maxObjectMembers } }));
      totalMembers += keys.length;
      if (totalMembers > budget.maxTotalMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path, details: { budget: 'maxTotalMembers', limit: budget.maxTotalMembers } }));
      const output: Record<string, JsonValue> = {};
      for (const property of keys as string[]) {
        if (forbiddenKeys.has(property)) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: [...path, property], details: { reason: 'prototype_pollution_key' } }));
        const descriptor = descriptors[property];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: [...path, property], details: { reason: 'object_descriptor' } }));
        const parsed = inspect(descriptor.value, depth + 1, [...path, property]);
        if (isInspectionFailure(parsed)) return parsed;
        output[property] = parsed;
      }
      return output;
    } catch (error) {
      return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path, details: { reason: 'inspection_threw', error: error instanceof Error ? error.name : typeof error } }));
    } finally {
      seen.delete(value);
    }
  };

  const value = inspect(input, 0, []);
  return isInspectionFailure(value) ? { success: false, issues: [value[inspectionFailure]] } : { success: true, value, issues: [] };
};

export const isTaggedValue = (value: JsonValue): value is TaggedValue => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, JsonValue>>;
  return record.kind === 'tarstate.value' && typeof record.type === 'string' && Object.hasOwn(record, 'value');
};

export const asLogicalTruth = (value: EvaluationValue): LogicalTruth => value === true ? true : value === false ? false : logicalUnknown;

export const logicalNot = (value: LogicalTruth): LogicalTruth => value === logicalUnknown ? logicalUnknown : !value;

export const logicalAnd = (values: readonly LogicalTruth[]): LogicalTruth => values.includes(false) ? false : values.includes(logicalUnknown) ? logicalUnknown : true;

export const logicalOr = (values: readonly LogicalTruth[]): LogicalTruth => values.includes(true) ? true : values.includes(logicalUnknown) ? logicalUnknown : false;
