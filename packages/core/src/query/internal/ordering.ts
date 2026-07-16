import type { QueryExpressionResult } from './expression.js';
import type { ScopedRow } from './evaluation-context.js';
import { compareQueryJsonValuesTotal } from './values.js';
import type { OrderTerm } from '../model.js';

/** Total ordering for already-evaluated query expressions. */
export const compareOrderedExpressions = (
  left: QueryExpressionResult,
  right: QueryExpressionResult,
  term: OrderTerm
): number => {
  const leftRank = left.status === 'missing' ? 2 : left.status !== 'known' || left.value === null ? 1 : 0;
  const rightRank = right.status === 'missing' ? 2 : right.status !== 'known' || right.value === null ? 1 : 0;
  if (leftRank !== rightRank) {
    if (leftRank > 0 && rightRank > 0) return leftRank < rightRank ? -1 : 1;
    const specialIsLeft = leftRank > 0;
    return term.nulls === 'first' ? (specialIsLeft ? -1 : 1) : (specialIsLeft ? 1 : -1);
  }
  if (leftRank > 0 || left.status !== 'known' || right.status !== 'known') return 0;
  const comparison = compareQueryJsonValuesTotal(left.value, right.value);
  return term.direction === 'asc' ? comparison : -comparison;
};

/** Reindexes stable-identity replacements without rebuilding membership maps. */
export const transitionOrderedRows = (
  previousInputs: readonly ScopedRow[],
  nextInputs: readonly ScopedRow[],
  previousOrder: readonly ScopedRow[],
  changedPositions: readonly number[],
  compare: (left: ScopedRow, right: ScopedRow) => number
): readonly ScopedRow[] | undefined => {
  if (previousInputs.length !== nextInputs.length || previousOrder.length !== nextInputs.length) return undefined;
  if (changedPositions.length === 0) return previousOrder;
  const output = previousOrder.slice();
  for (const position of changedPositions) {
    const before = previousInputs[position];
    const after = nextInputs[position];
    if (before === undefined || after === undefined || before.identity !== after.identity) return undefined;
    if (before === after) continue;
    const previousPosition = output.indexOf(before);
    if (previousPosition < 0) return undefined;
    output.splice(previousPosition, 1);
    let low = 0;
    let high = output.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(output[middle] as ScopedRow, after) <= 0) low = middle + 1;
      else high = middle;
    }
    output.splice(low, 0, after);
  }
  return output;
};
