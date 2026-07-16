import { canonicalizeJsonValue as canonicalizeJson } from './internal-canonical-json.js';
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
  if (left === undefined || right === undefined || left.size !== right.size) return false;
  for (const [key, implementation] of left) if (right.get(key) !== implementation) return false;
  return true;
};

export const sameExecutionBudget = (left: QueryExecutionBudget | undefined, right: QueryExecutionBudget | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.maxWorkUnits === right.maxWorkUnits;
