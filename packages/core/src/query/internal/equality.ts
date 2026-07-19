import { sameStructuralJson } from '../../internal-structural-json-equality.js';
import type { FunctionRegistry, QueryExecutionBudget } from '../model.js';

export const sameOptionalJson = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return sameStructuralJson(left, right);
};

export const sameFunctionRegistry = (left: FunctionRegistry | undefined, right: FunctionRegistry | undefined): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.size !== right.size) return false;
  for (const [key, implementation] of left) if (right.get(key) !== implementation) return false;
  return true;
};

export const sameExecutionBudget = (left: QueryExecutionBudget | undefined, right: QueryExecutionBudget | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.maxWorkUnits === right.maxWorkUnits;
