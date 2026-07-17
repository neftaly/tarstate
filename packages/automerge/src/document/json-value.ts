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
    ancestors: new Set<object>(),
    path: []
  };
  const adopted = adoptValue(input, 0, context);
  return 'issue' in adopted
    ? { success: false, issues: Object.freeze([adopted.issue]) }
    : { success: true, value: adopted.value, issues: noIssues };
};

type AdoptionContext = {
  readonly budget: ValueParseBudget;
  readonly inspectConflicts: boolean;
  totalMembers: number;
  readonly ancestors: Set<object>;
  readonly path: (string | number)[];
};

type Adopted = { readonly value: JsonValue } | { readonly issue: Issue };

const adoptValue = (
  value: unknown,
  depth: number,
  context: AdoptionContext
): Adopted => {
  if (depth > context.budget.maxDepth) {
    return failure('artifact.budget_exceeded', context.path, { budget: 'maxDepth', limit: context.budget.maxDepth });
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { value };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { value: Object.is(value, -0) ? 0 : value }
      : failure('artifact.unsupported_value', context.path, { type: 'non_finite_number' });
  }
  if (typeof value !== 'object') return failure('artifact.unsupported_value', context.path, { type: typeof value });
  if (Automerge.isCounter(value)) return failure('artifact.unsupported_value', context.path, { type: 'automerge_counter' });
  if (value instanceof Date) return failure('artifact.unsupported_value', context.path, { type: 'date' });
  if (value instanceof Uint8Array) return failure('artifact.unsupported_value', context.path, { type: 'bytes' });

  let objectId: string | null;
  try {
    objectId = Automerge.getObjectId(value);
  } catch {
    return failure('automerge.value_invalid', context.path, { reason: 'not_automerge_object' });
  }
  if (typeof objectId !== 'string') return failure('automerge.value_invalid', context.path, { reason: 'not_automerge_object' });

  if (context.ancestors.has(value)) return failure('artifact.cycle', context.path);
  context.ancestors.add(value);
  try {
    return Array.isArray(value)
      ? adoptList(value, depth, context)
      : adoptMap(value as Readonly<Record<string, unknown>>, depth, context);
  } catch (error) {
    return failure('automerge.value_invalid', context.path, {
      reason: 'inspection_failed',
      error: errorName(error)
    });
  } finally {
    context.ancestors.delete(value);
  }
};

const adoptList = (
  value: readonly unknown[],
  depth: number,
  context: AdoptionContext
): Adopted => {
  if (value.length > context.budget.maxArrayMembers) {
    return failure('artifact.budget_exceeded', context.path, {
      budget: 'maxArrayMembers',
      limit: context.budget.maxArrayMembers
    });
  }
  const budgetFailure = countMembers(value.length, context);
  if (budgetFailure !== undefined) return { issue: budgetFailure };
  const output: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    context.path.push(index);
    const conflict = context.inspectConflicts ? conflictIssue(value, index, context.path) : undefined;
    const child = conflict === undefined
      ? adoptValue(value[index], depth + 1, context)
      : { issue: conflict };
    context.path.pop();
    if ('issue' in child) return child;
    output.push(child.value);
  }
  return { value: Object.freeze(output) };
};

const adoptMap = (
  value: Readonly<Record<string, unknown>>,
  depth: number,
  context: AdoptionContext
): Adopted => {
  const keys = Object.keys(value).sort(comparePortableStrings);
  if (keys.length > context.budget.maxObjectMembers) {
    return failure('artifact.budget_exceeded', context.path, {
      budget: 'maxObjectMembers',
      limit: context.budget.maxObjectMembers
    });
  }
  const budgetFailure = countMembers(keys.length, context);
  if (budgetFailure !== undefined) return { issue: budgetFailure };
  const output: Record<string, JsonValue> = {};
  for (const property of keys) {
    context.path.push(property);
    if (forbiddenKeys.has(property)) {
      const issue = failure('artifact.hostile_shape', context.path, { reason: 'prototype_pollution_key' });
      context.path.pop();
      return issue;
    }
    const conflict = context.inspectConflicts ? conflictIssue(value, property, context.path) : undefined;
    const child = conflict === undefined
      ? adoptValue(value[property], depth + 1, context)
      : { issue: conflict };
    context.path.pop();
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
