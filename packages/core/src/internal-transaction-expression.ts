import { canonicalizeJson } from './artifacts.js';
import { createIssue, type Issue } from './issues.js';
import { comparePortableStrings } from './portable-order.js';
import type { WriteExpression } from './transaction.js';
import {
  logicalAnd,
  logicalNot,
  logicalOr,
  logicalUnknown,
  type JsonValue,
  type LogicalTruth
} from './value.js';

export type TransactionExpressionResult =
  | { readonly success: true; readonly value: JsonValue | typeof logicalUnknown }
  | { readonly success: false; readonly issue: Issue };

type ExpressionScope = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
type ExpressionFailure = (
  code: string,
  details: JsonValue
) => { readonly success: false; readonly issue: Issue };

/** Pure evaluation of the deliberately small transaction-expression language. */
export const evaluateTransactionExpression = (
  expression: WriteExpression,
  scope: ExpressionScope,
  parameters: Readonly<Record<string, JsonValue>>,
  failure: ExpressionFailure = expressionFailure
): TransactionExpressionResult => {
  if (expression.kind === 'literal') return { success: true, value: expression.value };
  if (expression.kind === 'parameter') {
    return Object.hasOwn(parameters, expression.name)
      ? { success: true, value: parameters[expression.name] as JsonValue }
      : failure('transaction.parameter_missing', { parameter: expression.name });
  }
  if (expression.kind === 'field') {
    const row = scope[expression.alias];
    return row !== undefined && Object.hasOwn(row, expression.name)
      ? { success: true, value: row[expression.name] as JsonValue }
      : { success: true, value: logicalUnknown };
  }
  if (expression.kind === 'compare') {
    return evaluateComparison(expression, scope, parameters, failure);
  }
  if (expression.op === 'not') {
    const value = evaluateTransactionExpression(expression.arg, scope, parameters, failure);
    return value.success
      ? { success: true, value: logicalNot(asTruth(value.value)) }
      : value;
  }
  const values: LogicalTruth[] = [];
  for (const argument of expression.args) {
    const value = evaluateTransactionExpression(argument, scope, parameters, failure);
    if (!value.success) return value;
    values.push(asTruth(value.value));
  }
  return {
    success: true,
    value: expression.op === 'and' ? logicalAnd(values) : logicalOr(values)
  };
};

export const requireTransactionExpression = (
  expression: WriteExpression,
  scope: ExpressionScope,
  parameters: Readonly<Record<string, JsonValue>>,
  failure: ExpressionFailure = expressionFailure
): { readonly success: true; readonly value: JsonValue } | { readonly success: false; readonly issue: Issue } => {
  const result = evaluateTransactionExpression(expression, scope, parameters, failure);
  if (!result.success) return result;
  return result.value === logicalUnknown
    ? failure('transaction.expression_indeterminate', { expression: expression.kind })
    : { success: true, value: result.value };
};

export const evaluateTransactionFields = (
  fields: Readonly<Record<string, WriteExpression>>,
  scope: ExpressionScope,
  parameters: Readonly<Record<string, JsonValue>>,
  failure: ExpressionFailure = expressionFailure
): { readonly success: true; readonly value: Readonly<Record<string, JsonValue>> } | { readonly success: false; readonly issue: Issue } => {
  const row: Record<string, JsonValue> = {};
  for (const [field, expression] of Object.entries(fields)) {
    const value = requireTransactionExpression(expression, scope, parameters, failure);
    if (!value.success) return value;
    row[field] = value.value;
  }
  return { success: true, value: row };
};

const evaluateComparison = (
  expression: Extract<WriteExpression, { readonly kind: 'compare' }>,
  scope: ExpressionScope,
  parameters: Readonly<Record<string, JsonValue>>,
  failure: ExpressionFailure
): TransactionExpressionResult => {
  const left = evaluateTransactionExpression(expression.left, scope, parameters, failure);
  if (!left.success) return left;
  const right = evaluateTransactionExpression(expression.right, scope, parameters, failure);
  if (!right.success) return right;
  if (left.value === logicalUnknown
    || right.value === logicalUnknown
    || left.value === null
    || right.value === null) {
    return { success: true, value: logicalUnknown };
  }
  const comparison = compareValues(left.value, right.value);
  if (comparison === undefined) return { success: true, value: logicalUnknown };
  return { success: true, value: comparisonResult(expression.op, comparison) };
};

const comparisonResult = (
  operator: Extract<WriteExpression, { readonly kind: 'compare' }>['op'],
  comparison: number
): boolean => {
  switch (operator) {
    case 'eq': return comparison === 0;
    case 'ne': return comparison !== 0;
    case 'lt': return comparison < 0;
    case 'lte': return comparison <= 0;
    case 'gt': return comparison > 0;
    case 'gte': return comparison >= 0;
  }
};

const compareValues = (left: JsonValue, right: JsonValue): number | undefined => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return comparePortableStrings(left, right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return comparePortableStrings(canonicalizeJson(left), canonicalizeJson(right));
  }
  if (isJsonRecord(left) && isJsonRecord(right)) {
    return comparePortableStrings(canonicalizeJson(left), canonicalizeJson(right));
  }
  return undefined;
};

const expressionFailure = (
  code: string,
  details: JsonValue
): { readonly success: false; readonly issue: Issue } => ({
  success: false,
  issue: createIssue({ code, details })
});

const asTruth = (value: JsonValue | typeof logicalUnknown): LogicalTruth => {
  if (value === true) return true;
  if (value === false) return false;
  return logicalUnknown;
};

const isJsonRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
