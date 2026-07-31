import { createIssue, type Issue, type ParseResult } from './issues.js';
import { assertUnicodeScalarString } from './internal-canonical-json.js';
import type { JsonValue } from './value-model.js';

export type { JsonPrimitive, JsonValue } from './value-model.js';

/** Realm-stable semantic sentinels; compatible package copies must compare them by identity. */
export const missingValue = Symbol.for('@tarstate/core/value/missing/v1');
export const logicalUnknown = Symbol.for('@tarstate/core/value/logical-unknown/v1');
export const capabilityUnavailable = Symbol.for('@tarstate/core/value/capability-unavailable/v1');

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
  readonly maxArrayMembers: number;
  readonly maxObjectMembers: number;
  readonly maxTotalMembers: number;
  readonly maxTotalStringCodeUnits: number;
};

export const defaultValueParseBudget: ValueParseBudget = Object.freeze({
  maxArrayMembers: 100_000,
  maxObjectMembers: 100_000,
  maxTotalMembers: 500_000,
  maxTotalStringCodeUnits: 8 * 1024 * 1024
});

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const inspectionFailure = Symbol('inspectionFailure');
type InspectionFailure = { readonly [inspectionFailure]: Issue };
const failedInspection = (issue: Issue): InspectionFailure => ({ [inspectionFailure]: issue });
const isInspectionFailure = (value: unknown): value is InspectionFailure =>
  inspectionFailure in Object(value);

export const safeParseJsonValue = (input: unknown, budget: ValueParseBudget = defaultValueParseBudget): ParseResult<JsonValue> => {
  const ancestors = new Set<object>();
  const path: unknown[] = [];
  let totalMembers = 0;
  let totalStringCodeUnits = 0;
  const issuePath = (segment?: unknown): readonly unknown[] => segment === undefined ? [...path] : [...path, segment];
  const countString = (value: string): InspectionFailure | undefined => {
    try {
      assertUnicodeScalarString(value);
    } catch {
      return failedInspection(createIssue({
        code: 'artifact.unsupported_value',
        retry: 'after_input',
        path: issuePath(),
        details: { type: 'invalid_unicode_string' }
      }));
    }
    totalStringCodeUnits += value.length;
    return totalStringCodeUnits > budget.maxTotalStringCodeUnits
      ? failedInspection(createIssue({
          code: 'artifact.budget_exceeded',
          retry: 'after_input',
          path: issuePath(),
          details: {
            budget: 'maxTotalStringCodeUnits',
            limit: budget.maxTotalStringCodeUnits
          }
        }))
      : undefined;
  };
  const inspectPrimitive = (value: unknown): JsonValue | InspectionFailure | undefined => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return countString(value) ?? value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return failedInspection(createIssue({ code: 'artifact.unsupported_value', retry: 'after_input', path: issuePath(), details: { type: 'non_finite_number' } }));
      return Object.is(value, -0) ? 0 : value;
    }
    return undefined;
  };

  type Member = {
    readonly key: string | number;
    readonly value: unknown;
  };
  type Frame = {
    readonly input: object;
    readonly output: JsonValue[] | Record<string, JsonValue>;
    readonly members: readonly Member[];
    readonly ownsPathSegment: boolean;
    index: number;
  };

  const inspectContainer = (
    value: object,
    ownsPathSegment: boolean
  ): Frame | InspectionFailure => {
    try {
      if (ancestors.has(value)) return failedInspection(createIssue({ code: 'artifact.cycle', retry: 'after_input', path: issuePath() }));
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
        if (!Number.isSafeInteger(length) || length < 0) {
          return failedInspection(createIssue({
            code: 'artifact.hostile_shape',
            retry: 'after_input',
            path: issuePath(),
            details: { reason: 'array_length' }
          }));
        }
        if (length > budget.maxArrayMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path: issuePath(), details: { budget: 'maxArrayMembers', limit: budget.maxArrayMembers } }));
        const keys = Reflect.ownKeys(value);
        if (keys.length !== length + 1
          || keys.some((key) => key !== 'length'
            && (typeof key !== 'string'
              || !isArrayIndex(key, length)))) {
          return failedInspection(createIssue({
            code: 'artifact.hostile_shape',
            retry: 'after_input',
            path: issuePath(),
            details: { reason: 'array_property' }
          }));
        }
        totalMembers += length;
        if (totalMembers > budget.maxTotalMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path: issuePath(), details: { budget: 'maxTotalMembers', limit: budget.maxTotalMembers } }));
        const members: Member[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, index);
          if (descriptor === undefined
            || !descriptor.enumerable
            || !('value' in descriptor)) {
            return failedInspection(createIssue({
              code: 'artifact.hostile_shape',
              retry: 'after_input',
              path: issuePath(index),
              details: {
                reason: descriptor === undefined
                  ? 'sparse_array'
                  : 'array_descriptor'
              }
            }));
          }
          members.push({ key: index, value: descriptor.value });
        }
        ancestors.add(value);
        return {
          input: value,
          output: [],
          members,
          ownsPathSegment,
          index: 0
        };
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: issuePath(), details: { reason: 'prototype' } }));
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: issuePath(), details: { reason: 'symbol_key' } }));
      if (keys.length > budget.maxObjectMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path: issuePath(), details: { budget: 'maxObjectMembers', limit: budget.maxObjectMembers } }));
      totalMembers += keys.length;
      if (totalMembers > budget.maxTotalMembers) return failedInspection(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path: issuePath(), details: { budget: 'maxTotalMembers', limit: budget.maxTotalMembers } }));
      const members: Member[] = [];
      for (const property of keys as string[]) {
        if (forbiddenKeys.has(property)) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: issuePath(property), details: { reason: 'prototype_pollution_key' } }));
        path.push(property);
        const stringFailure = countString(property);
        path.pop();
        if (stringFailure !== undefined) return stringFailure;
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: issuePath(property), details: { reason: 'object_descriptor' } }));
        members.push({ key: property, value: descriptor.value });
      }
      ancestors.add(value);
      return {
        input: value,
        output: {},
        members,
        ownsPathSegment,
        index: 0
      };
    } catch (error) {
      return failedInspection(createIssue({ code: 'artifact.hostile_shape', retry: 'after_input', path: issuePath(), details: { reason: 'inspection_threw', error: error instanceof Error ? error.name : typeof error } }));
    }
  };

  const rootPrimitive = inspectPrimitive(input);
  if (rootPrimitive !== undefined) {
    return isInspectionFailure(rootPrimitive)
      ? { success: false, issues: [rootPrimitive[inspectionFailure]] }
      : { success: true, value: rootPrimitive, issues: [] };
  }
  if (typeof input !== 'object' || input === null) {
    return {
      success: false,
      issues: [createIssue({
        code: 'artifact.unsupported_value',
        retry: 'after_input',
        details: { type: typeof input }
      })]
    };
  }
  const root = inspectContainer(input, false);
  if (isInspectionFailure(root)) {
    return { success: false, issues: [root[inspectionFailure]] };
  }
  const stack: Frame[] = [root];
  while (stack.length > 0) {
    const frame = stack.at(-1) as Frame;
    if (frame.index >= frame.members.length) {
      ancestors.delete(frame.input);
      stack.pop();
      if (frame.ownsPathSegment) path.pop();
      continue;
    }
    const member = frame.members[frame.index] as Member;
    frame.index += 1;
    path.push(member.key);
    const primitive = inspectPrimitive(member.value);
    if (primitive !== undefined) {
      if (isInspectionFailure(primitive)) {
        return { success: false, issues: [primitive[inspectionFailure]] };
      }
      assignMember(frame.output, member.key, primitive);
      path.pop();
      continue;
    }
    if (typeof member.value !== 'object' || member.value === null) {
      return {
        success: false,
        issues: [createIssue({
          code: 'artifact.unsupported_value',
          retry: 'after_input',
          path: issuePath(),
          details: { type: typeof member.value }
        })]
      };
    }
    const child = inspectContainer(member.value, true);
    if (isInspectionFailure(child)) {
      return { success: false, issues: [child[inspectionFailure]] };
    }
    assignMember(frame.output, member.key, child.output);
    stack.push(child);
  }
  return { success: true, value: root.output, issues: [] };
};

const assignMember = (
  output: JsonValue[] | Record<string, JsonValue>,
  key: string | number,
  value: JsonValue
): void => {
  if (Array.isArray(output) && typeof key === 'number') output.push(value);
  else (output as Record<string, JsonValue>)[key] = value;
};

const isArrayIndex = (key: string, length: number): boolean => {
  const index = Number(key);
  return Number.isSafeInteger(index)
    && index >= 0
    && index < length
    && String(index) === key;
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
