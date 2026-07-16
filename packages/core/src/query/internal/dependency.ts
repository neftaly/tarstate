import type { ScopedRow } from './evaluation-context.js';
import type { MaterializedQueryNode } from './maintenance-model.js';
import { queryValueEqual } from './values.js';
import type { Expr, QueryLogicalValue, QueryNode } from '../model.js';

const expressionInputsEqual = (expression: Expr, before: ScopedRow, after: ScopedRow): boolean => {
  if (expression.kind === 'literal' || expression.kind === 'parameter') return true;
  if (expression.kind === 'field') {
    const beforeRecord = before.scope[expression.alias];
    const afterRecord = after.scope[expression.alias];
    if (beforeRecord === undefined || afterRecord === undefined) return beforeRecord === afterRecord;
    const beforePresent = Object.hasOwn(beforeRecord, expression.name);
    if (beforePresent !== Object.hasOwn(afterRecord, expression.name)) return false;
    return !beforePresent || queryValueEqual(
      beforeRecord[expression.name] as QueryLogicalValue,
      afterRecord[expression.name] as QueryLogicalValue
    );
  }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') {
    const beforeProvenance = before.provenance[expression.alias];
    const afterProvenance = after.provenance[expression.alias];
    if (beforeProvenance === undefined || afterProvenance === undefined) return beforeProvenance === afterProvenance;
    const beforeValue = expression.kind === 'key-of' ? beforeProvenance.key : beforeProvenance.sourceId;
    const afterValue = expression.kind === 'key-of' ? afterProvenance.key : afterProvenance.sourceId;
    if (beforeValue === undefined || afterValue === undefined) return beforeValue === afterValue;
    return queryValueEqual(beforeValue, afterValue);
  }
  // Calls and subqueries may observe state beyond their explicit row fields.
  if (expression.kind === 'call' || expression.kind === 'subquery') return false;
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') {
    return expressionInputsEqual(expression.left, before, after)
      && expressionInputsEqual(expression.right, before, after);
  }
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') {
    return expressionInputsEqual(expression.value, before, after);
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') return expressionInputsEqual(expression.arg, before, after);
    for (const argument of expression.args) {
      if (!expressionInputsEqual(argument, before, after)) return false;
    }
    return true;
  }
  if (expression.kind === 'case') {
    for (const branch of expression.branches) {
      if (!expressionInputsEqual(branch.when, before, after)
        || !expressionInputsEqual(branch.then, before, after)) return false;
    }
    return expressionInputsEqual(expression.otherwise, before, after);
  }
  if (expression.kind === 'record') {
    for (const field of Object.values(expression.fields)) {
      if (!expressionInputsEqual(field, before, after)) return false;
    }
    return true;
  }
  const expressions = expression.kind === 'array' ? expression.items : expression.args;
  for (const argument of expressions) {
    if (!expressionInputsEqual(argument, before, after)) return false;
  }
  return true;
};

const selectProjectionInputsEqual = (
  node: Extract<QueryNode, { readonly kind: 'select' }>,
  before: ScopedRow,
  after: ScopedRow
): boolean => {
  if (before.identity !== after.identity) return false;
  for (const expression of Object.values(node.fields)) {
    if (!expressionInputsEqual(expression, before, after)) return false;
  }
  return true;
};

/** Proves that a select can retain its materialized output after a child transition. */
export const selectProjectionDependenciesEqual = (
  node: Extract<QueryNode, { readonly kind: 'select' }>,
  previousInputs: readonly ScopedRow[],
  nextInputs: readonly ScopedRow[],
  changedPositions: readonly number[]
): boolean => {
  for (const index of changedPositions) {
    const before = previousInputs[index];
    const after = nextInputs[index];
    if (before === undefined || after === undefined || !selectProjectionInputsEqual(node, before, after)) return false;
  }
  return true;
};

/** Proves that a select node need not be scheduled for a child transition. */
export const selectCanRetainMaterialization = (
  node: Extract<QueryNode, { readonly kind: 'select' }>,
  previous: MaterializedQueryNode | undefined,
  nextInput: MaterializedQueryNode
): boolean => {
  if (previous?.local === undefined
    || nextInput.unavailable
    || nextInput.issues.length > 0
    || nextInput.stableChangedPositions === undefined
    || previous.result.completeness !== nextInput.result.completeness) return false;
  return selectProjectionDependenciesEqual(
    node,
    previous.local.inputs,
    nextInput.result.rows,
    nextInput.stableChangedPositions
  );
};
