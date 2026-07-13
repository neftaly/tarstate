import { canonicalizeJson } from './artifacts.js';
import type { FunctionRegistry, QueryExecutionBudget } from './query-model.js';
import type { JsonValue } from './value.js';

export const sameOptionalJson = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  try {
    return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
  } catch {
    return false;
  }
};

export const sameFunctionRegistry = (left: FunctionRegistry | undefined, right: FunctionRegistry | undefined): boolean => {
  if (left === right) return true;
  const leftEntries = [...(left ?? new Map()).entries()];
  const rightMap = right ?? new Map();
  return leftEntries.length === rightMap.size && leftEntries.every(([key, implementation]) => rightMap.get(key) === implementation);
};

export const sameExecutionBudget = (left: QueryExecutionBudget | undefined, right: QueryExecutionBudget | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.maxWorkUnits === right.maxWorkUnits;
