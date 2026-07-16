import * as Automerge from '@automerge/automerge';
import {
  createIssue,
  defaultValueParseBudget,
  type Issue,
  type JsonValue,
  type ParseResult,
  type ValueParseBudget
} from '@tarstate/core';
import { comparePortableStrings } from './portable-order.js';

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

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
    ancestors: new Set<object>()
  };
  const adopted = adoptValue(input, [], 0, context);
  return 'issue' in adopted
    ? { success: false, issues: Object.freeze([adopted.issue]) }
    : { success: true, value: adopted.value, issues: Object.freeze([]) };
};

type AdoptionContext = {
  readonly budget: ValueParseBudget;
  readonly inspectConflicts: boolean;
  totalMembers: number;
  readonly ancestors: Set<object>;
};

type Adopted = { readonly value: JsonValue } | { readonly issue: Issue };

const adoptValue = (
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  context: AdoptionContext
): Adopted => {
  if (depth > context.budget.maxDepth) {
    return failure('artifact.budget_exceeded', path, { budget: 'maxDepth', limit: context.budget.maxDepth });
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { value };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { value: Object.is(value, -0) ? 0 : value }
      : failure('artifact.unsupported_value', path, { type: 'non_finite_number' });
  }
  if (typeof value !== 'object') return failure('artifact.unsupported_value', path, { type: typeof value });
  if (Automerge.isCounter(value)) return failure('artifact.unsupported_value', path, { type: 'automerge_counter' });
  if (value instanceof Date) return failure('artifact.unsupported_value', path, { type: 'date' });
  if (value instanceof Uint8Array) return failure('artifact.unsupported_value', path, { type: 'bytes' });

  let objectId: string | null;
  try {
    objectId = Automerge.getObjectId(value);
  } catch {
    return failure('automerge.value_invalid', path, { reason: 'not_automerge_object' });
  }
  if (typeof objectId !== 'string') return failure('automerge.value_invalid', path, { reason: 'not_automerge_object' });

  try {
    if (context.ancestors.has(value)) return failure('artifact.cycle', path);
    context.ancestors.add(value);
    return Array.isArray(value)
      ? adoptList(value, path, depth, context)
      : adoptMap(value as Readonly<Record<string, unknown>>, path, depth, context);
  } catch (error) {
    return failure('automerge.value_invalid', path, {
      reason: 'inspection_failed',
      error: errorName(error)
    });
  } finally {
    context.ancestors.delete(value);
  }
};

const adoptList = (
  value: readonly unknown[],
  path: readonly (string | number)[],
  depth: number,
  context: AdoptionContext
): Adopted => {
  if (value.length > context.budget.maxArrayMembers) {
    return failure('artifact.budget_exceeded', path, {
      budget: 'maxArrayMembers',
      limit: context.budget.maxArrayMembers
    });
  }
  const budgetFailure = countMembers(value.length, path, context);
  if (budgetFailure !== undefined) return { issue: budgetFailure };
  const output: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const propertyPath = [...path, index];
    const conflict = context.inspectConflicts ? conflictIssue(value, index, propertyPath) : undefined;
    if (conflict !== undefined) return { issue: conflict };
    const child = adoptValue(value[index], propertyPath, depth + 1, context);
    if ('issue' in child) return child;
    output.push(child.value);
  }
  return { value: Object.freeze(output) };
};

const adoptMap = (
  value: Readonly<Record<string, unknown>>,
  path: readonly (string | number)[],
  depth: number,
  context: AdoptionContext
): Adopted => {
  const keys = Object.keys(value).sort(comparePortableStrings);
  if (keys.length > context.budget.maxObjectMembers) {
    return failure('artifact.budget_exceeded', path, {
      budget: 'maxObjectMembers',
      limit: context.budget.maxObjectMembers
    });
  }
  const budgetFailure = countMembers(keys.length, path, context);
  if (budgetFailure !== undefined) return { issue: budgetFailure };
  const output: Record<string, JsonValue> = {};
  for (const property of keys) {
    const propertyPath = [...path, property];
    if (forbiddenKeys.has(property)) {
      return failure('artifact.hostile_shape', propertyPath, { reason: 'prototype_pollution_key' });
    }
    const conflict = context.inspectConflicts ? conflictIssue(value, property, propertyPath) : undefined;
    if (conflict !== undefined) return { issue: conflict };
    const child = adoptValue(value[property], propertyPath, depth + 1, context);
    if ('issue' in child) return child;
    output[property] = child.value;
  }
  return { value: Object.freeze(output) };
};

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
  path: readonly (string | number)[],
  context: AdoptionContext
): Issue | undefined => {
  context.totalMembers += count;
  return context.totalMembers > context.budget.maxTotalMembers
    ? createIssue({
        code: 'artifact.budget_exceeded',
        retry: 'after_input',
        path,
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
