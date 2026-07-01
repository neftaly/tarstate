import type { ExprData, PredicateData } from './query.js';

export type FieldExpression = Extract<ExprData, { readonly op: 'field' }>;
export type ExpressionSide = 'left' | 'right';
export type EqualityJoinPlan = {
  readonly left: ExprData;
  readonly right: ExprData;
  readonly needsPredicateCheck: boolean;
};

export function equalityJoinPlan(
  predicate: PredicateData,
  sideForField: (expr: FieldExpression) => ExpressionSide | undefined
): EqualityJoinPlan | undefined {
  if (predicate.op === 'and') {
    for (const item of predicate.predicates) {
      const plan = equalityJoinPlan(item, sideForField);
      if (plan !== undefined) {
        return { ...plan, needsPredicateCheck: true };
      }
    }
    return undefined;
  }

  if (predicate.op !== 'eq' || predicate.left.op !== 'field' || predicate.right.op !== 'field') {
    return undefined;
  }

  const leftSide = sideForField(predicate.left);
  const rightSide = sideForField(predicate.right);

  if (leftSide === 'left' && rightSide === 'right') {
    return { left: predicate.left, right: predicate.right, needsPredicateCheck: false };
  }

  if (leftSide === 'right' && rightSide === 'left') {
    return { left: predicate.right, right: predicate.left, needsPredicateCheck: false };
  }

  return undefined;
}
