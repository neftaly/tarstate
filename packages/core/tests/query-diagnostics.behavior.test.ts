import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { fromObjectSource } from '@tarstate/core/source';
import type { Query, QueryData } from '@tarstate/core/query';

const source = fromObjectSource({});

function rawQuery<Row = unknown>(data: QueryData): Query<Row> {
  return { data, relations: {} } as Query<Row>;
}

function messages(result: { readonly diagnostics: readonly { readonly message: string }[] }): readonly string[] {
  return result.diagnostics.map((item) => item.message);
}

describe('query diagnostics behavior', () => {
  it('reports missing required nested inputs instead of treating them as empty rows', () => {
    const projectResult = evaluate(source, rawQuery<{ readonly id: string }>({
      op: 'project',
      projection: { id: { op: 'field', field: 'id' } }
    }));
    const joinResult = evaluate(source, rawQuery({
      op: 'join',
      on: { op: 'value', value: true }
    }));

    expect(projectResult.rows).toEqual([]);
    expect(projectResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'query_invalid', severity: 'error' })
    ]);
    expect(messages(projectResult)).toContain('project.input must be query data');

    expect(joinResult.rows).toEqual([]);
    expect(joinResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'query_invalid', severity: 'error' }),
      expect.objectContaining({ code: 'query_invalid', severity: 'error' })
    ]);
    expect(messages(joinResult)).toEqual([
      'join.left must be query data',
      'join.right must be query data'
    ]);
  });

  it('reports invalid set operation inputs instead of silently dropping malformed branches', () => {
    const nonArrayResult = evaluate(source, rawQuery({
      op: 'union',
      inputs: { op: 'constRows', rows: [{ id: 'a' }] }
    }));
    const malformedBranchResult = evaluate(source, rawQuery({
      op: 'intersection',
      inputs: [
        { op: 'constRows', rows: [{ id: 'a' }] },
        { rows: [{ id: 'a' }] }
      ]
    }));

    expect(nonArrayResult.rows).toEqual([]);
    expect(nonArrayResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'query_invalid', severity: 'error' })
    ]);
    expect(messages(nonArrayResult)).toContain('union.inputs must be an array of query data');

    expect(malformedBranchResult.rows).toEqual([]);
    expect(malformedBranchResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'query_invalid', severity: 'error' })
    ]);
    expect(messages(malformedBranchResult)).toContain('intersection.inputs[1] must be query data');
  });

  it('reports invalid difference operands instead of replacing them with empty constants', () => {
    const invalidLeftResult = evaluate(source, rawQuery({
      op: 'difference',
      left: { rows: [{ id: 'a' }] },
      right: { op: 'constRows', rows: [{ id: 'a' }] }
    }));
    const invalidRightResult = evaluate(source, rawQuery({
      op: 'difference',
      left: { op: 'constRows', rows: [{ id: 'a' }] },
      right: { rows: [{ id: 'a' }] }
    }));

    expect(invalidLeftResult.rows).toEqual([]);
    expect(invalidLeftResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'query_invalid', severity: 'error' })
    ]);
    expect(messages(invalidLeftResult)).toContain('difference.left must be query data');

    expect(invalidRightResult.rows).toEqual([]);
    expect(invalidRightResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'query_invalid', severity: 'error' })
    ]);
    expect(messages(invalidRightResult)).toContain('difference.right must be query data');
  });
});
