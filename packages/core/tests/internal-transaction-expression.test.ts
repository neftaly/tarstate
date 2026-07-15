import { describe, expect, it } from 'vitest';
import {
  evaluateTransactionExpression,
  evaluateTransactionFields,
  requireTransactionExpression
} from '../src/internal-transaction-expression.js';
import { logicalUnknown } from '../src/value.js';

const literal = (value: string | number | boolean | null) => ({ kind: 'literal' as const, value });

describe('transaction expression core', () => {
  it('evaluates every portable comparison without source or lifecycle state', () => {
    const comparisons = [
      ['eq', 2, 2, true],
      ['ne', 2, 3, true],
      ['lt', 2, 3, true],
      ['lte', 2, 2, true],
      ['gt', 3, 2, true],
      ['gte', 2, 2, true]
    ] as const;
    for (const [op, left, right, expected] of comparisons) {
      expect(evaluateTransactionExpression({
        kind: 'compare',
        op,
        left: literal(left),
        right: literal(right)
      }, {}, {})).toEqual({ success: true, value: expected });
    }
  });

  it('keeps indeterminate values inside the pure evaluator and rejects them when required', () => {
    const missingField = { kind: 'field' as const, alias: 'row', name: 'missing' };
    expect(evaluateTransactionExpression(missingField, { row: {} }, {})).toEqual({
      success: true,
      value: logicalUnknown
    });
    expect(requireTransactionExpression(missingField, { row: {} }, {})).toMatchObject({
      success: false,
      issue: { code: 'transaction.expression_indeterminate' }
    });
  });

  it('evaluates a field set atomically from explicit scope and parameters', () => {
    expect(evaluateTransactionFields({
      copied: { kind: 'field', alias: 'row', name: 'id' },
      supplied: { kind: 'parameter', name: 'value' }
    }, { row: { id: 7 } }, { value: 'ready' })).toEqual({
      success: true,
      value: { copied: 7, supplied: 'ready' }
    });
  });
});
