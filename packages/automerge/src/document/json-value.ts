import * as Automerge from '@automerge/automerge';
import {
  createIssue,
  defaultValueParseBudget,
  type Issue,
  type JsonValue,
  type ParseResult,
  type ValueParseBudget
} from '@tarstate/core';
import { comparePortableStrings } from '../shared/portable-order.js';

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const loneSurrogate = /[\uD800-\uDFFF]/u;
const noIssues: readonly Issue[] = Object.freeze([]);

/**
 * Detaches Automerge's deterministic visible value as inert, deeply frozen JSON.
 * Native Automerge values are rejected rather than normalized. Use
 * `adoptConflictFreeAutomergeJsonValue` when nested conflict absence is part of
 * the caller's boundary contract.
 */
export const adoptAutomergeJsonValue = (
  input: unknown,
  budget: ValueParseBudget = defaultValueParseBudget
): ParseResult<JsonValue> => adoptAutomergeValue(input, budget, false);

/** Detaches JSON while additionally auditing every property for conflicts. */
export const adoptConflictFreeAutomergeJsonValue = (
  input: unknown,
  budget: ValueParseBudget = defaultValueParseBudget
): ParseResult<JsonValue> => adoptAutomergeValue(input, budget, true);

const adoptAutomergeValue = (
  input: unknown,
  budget: ValueParseBudget,
  inspectConflicts: boolean
): ParseResult<JsonValue> => {
  const context: AdoptionContext = {
    budget,
    inspectConflicts,
    totalMembers: 0,
    totalStringCodeUnits: 0,
    ancestors: new Set<object>(),
    path: []
  };
  const primitive = adoptPrimitive(input, context);
  if (primitive !== undefined) return adoptionResult(primitive);
  if (typeof input !== 'object' || input === null) {
    return adoptionResult(failure(
      'artifact.unsupported_value',
      context.path,
      { type: typeof input }
    ));
  }
  const root = openContainer(input, false, context);
  if ('issue' in root) return adoptionResult(root);
  const stack: AdoptionFrame[] = [root];
  try {
    while (stack.length > 0) {
      const frame = stack.at(-1) as AdoptionFrame;
      if (frame.index >= frame.members.length) {
        Object.freeze(frame.output);
        context.ancestors.delete(frame.input);
        stack.pop();
        if (frame.ownsPathSegment) context.path.pop();
        continue;
      }
      const member = frame.members[frame.index] as string | number;
      frame.index += 1;
      context.path.push(member);
      if (context.inspectConflicts) {
        const conflict = conflictIssue(frame.input, member, context.path);
        if (conflict !== undefined) {
          return { success: false, issues: Object.freeze([conflict]) };
        }
      }
      const value = frame.input[member as never] as unknown;
      const childPrimitive = adoptPrimitive(value, context);
      if (childPrimitive !== undefined) {
        if ('issue' in childPrimitive) return adoptionResult(childPrimitive);
        assignAdoptedMember(frame.output, member, childPrimitive.value);
        context.path.pop();
        continue;
      }
      if (typeof value !== 'object' || value === null) {
        return adoptionResult(failure(
          'artifact.unsupported_value',
          context.path,
          { type: typeof value }
        ));
      }
      const child = openContainer(value, true, context);
      if ('issue' in child) return adoptionResult(child);
      assignAdoptedMember(frame.output, member, child.output);
      stack.push(child);
    }
  } catch (error) {
    return adoptionResult(failure('automerge.value_invalid', context.path, {
      reason: 'inspection_failed',
      error: errorName(error)
    }));
  }
  return { success: true, value: root.output, issues: noIssues };
};

type AdoptionContext = {
  readonly budget: ValueParseBudget;
  readonly inspectConflicts: boolean;
  totalMembers: number;
  totalStringCodeUnits: number;
  readonly ancestors: Set<object>;
  readonly path: (string | number)[];
};

type Adopted = { readonly value: JsonValue } | { readonly issue: Issue };

type AdoptionFrame = {
  readonly input: readonly unknown[] | Readonly<Record<string, unknown>>;
  readonly output: JsonValue[] | Record<string, JsonValue>;
  readonly members: readonly (string | number)[];
  readonly ownsPathSegment: boolean;
  index: number;
};

const adoptPrimitive = (
  value: unknown,
  context: AdoptionContext
): Adopted | undefined => {
  if (value === null || typeof value === 'boolean') return { value };
  if (typeof value === 'string') {
    const issue = countString(value, context);
    return issue === undefined ? { value } : { issue };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { value: Object.is(value, -0) ? 0 : value }
      : failure('artifact.unsupported_value', context.path, { type: 'non_finite_number' });
  }
  if (typeof value !== 'object' || value === null) return undefined;
  if (Automerge.isCounter(value)) return failure('artifact.unsupported_value', context.path, { type: 'automerge_counter' });
  if (value instanceof Date) return failure('artifact.unsupported_value', context.path, { type: 'date' });
  if (value instanceof Uint8Array) return failure('artifact.unsupported_value', context.path, { type: 'bytes' });
  return undefined;
};

const openContainer = (
  value: object,
  ownsPathSegment: boolean,
  context: AdoptionContext
): AdoptionFrame | { readonly issue: Issue } => {
  let objectId: string | null;
  try {
    objectId = Automerge.getObjectId(value);
  } catch {
    return failure('automerge.value_invalid', context.path, { reason: 'not_automerge_object' });
  }
  if (typeof objectId !== 'string') return failure('automerge.value_invalid', context.path, { reason: 'not_automerge_object' });

  if (context.ancestors.has(value)) return failure('artifact.cycle', context.path);
  const array = Array.isArray(value);
  const input = value as readonly unknown[] | Readonly<Record<string, unknown>>;
  const objectKeys = array
    ? undefined
    : Object.keys(value).sort(comparePortableStrings);
  const memberCount = array ? value.length : (objectKeys as string[]).length;
  const limit = array
    ? context.budget.maxArrayMembers
    : context.budget.maxObjectMembers;
  const budgetName = array ? 'maxArrayMembers' : 'maxObjectMembers';
  if (memberCount > limit) {
    return failure('artifact.budget_exceeded', context.path, {
      budget: budgetName,
      limit
    });
  }
  const budgetFailure = countMembers(memberCount, context);
  if (budgetFailure !== undefined) return { issue: budgetFailure };
  const members = array
    ? Array.from({ length: memberCount }, (_, index) => index)
    : objectKeys as string[];
  if (!array) {
    for (const property of members as string[]) {
      context.path.push(property);
      if (forbiddenKeys.has(property)) {
        return failure('artifact.hostile_shape', context.path, {
          reason: 'prototype_pollution_key'
        });
      }
      const stringFailure = countString(property, context);
      context.path.pop();
      if (stringFailure !== undefined) return { issue: stringFailure };
    }
  }
  context.ancestors.add(value);
  return {
    input,
    output: array ? [] : {},
    members,
    ownsPathSegment,
    index: 0
  };
};

const countString = (
  value: string,
  context: AdoptionContext
): Issue | undefined => {
  if (!hasValidUnicodeScalars(value)) {
    return createIssue({
      code: 'artifact.unsupported_value',
      retry: 'after_input',
      path: context.path,
      details: { type: 'invalid_unicode_string' }
    });
  }
  context.totalStringCodeUnits += value.length;
  return context.totalStringCodeUnits > context.budget.maxTotalStringCodeUnits
    ? createIssue({
        code: 'artifact.budget_exceeded',
        retry: 'after_input',
        path: context.path,
        details: {
          budget: 'maxTotalStringCodeUnits',
          limit: context.budget.maxTotalStringCodeUnits
        }
      })
    : undefined;
};

const hasValidUnicodeScalars = (value: string): boolean => !loneSurrogate.test(value);

const assignAdoptedMember = (
  output: JsonValue[] | Record<string, JsonValue>,
  member: string | number,
  value: JsonValue
): void => {
  if (Array.isArray(output) && typeof member === 'number') output.push(value);
  else (output as Record<string, JsonValue>)[member] = value;
};

const adoptionResult = (
  adopted: Adopted
): ParseResult<JsonValue> => 'issue' in adopted
  ? { success: false, issues: Object.freeze([adopted.issue]) }
  : { success: true, value: adopted.value, issues: noIssues };

const conflictIssue = (
  owner: object,
  property: string | number,
  path: readonly (string | number)[]
): Issue | undefined => {
  const conflicts = Automerge.getConflicts(owner as never, property as never);
  const alternatives = Object.keys(conflicts ?? {});
  return alternatives.length > 1
    ? createIssue({
        code: 'automerge.value_conflicted',
        phase: 'parse',
        severity: 'error',
        retry: 'manual_repair',
        path,
        details: { alternatives: alternatives.length }
      })
    : undefined;
};

const countMembers = (
  count: number,
  context: AdoptionContext
): Issue | undefined => {
  context.totalMembers += count;
  return context.totalMembers > context.budget.maxTotalMembers
    ? createIssue({
        code: 'artifact.budget_exceeded',
        retry: 'after_input',
        path: context.path,
        details: { budget: 'maxTotalMembers', limit: context.budget.maxTotalMembers }
      })
    : undefined;
};

const failure = (
  code: string,
  path: readonly (string | number)[],
  details?: JsonValue
): { readonly issue: Issue } => ({
  issue: createIssue({
    code,
    ...(code.startsWith('automerge.') ? { phase: 'parse' as const, severity: 'error' as const } : {}),
    retry: 'after_input',
    path,
    ...(details === undefined ? {} : { details })
  })
});

const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
