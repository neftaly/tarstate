import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  compare,
  evaluateQuery,
  field,
  from,
  literal,
  pipe,
  sealQuery,
  safeParseQueryParameters,
  select,
  where,
  type ArtifactRef,
  type RelationInput
} from '../src/index.js';

const schemaView: ArtifactRef = { id: 'urn:test:schema', contentHash: `sha256:${'a'.repeat(64)}` };

describe('functional query authoring', () => {
  it('preserves types through an unbounded sequence of typed operators', () => {
    const stringify = (value: number): string => String(value);
    const length = (value: string): number => value.length;
    const positive = (value: number): boolean => value > 0;
    const choose = (value: boolean): string => value ? 'yes' : 'no';
    const result = pipe(
      1,
      stringify, length, positive, choose,
      length, positive, choose,
      length, positive, choose,
      length, positive, choose
    );
    expectTypeOf(result).toEqualTypeOf<string>();
    expect(result).toBe('yes');
  });

  it('rejects adjacent operators whose input and output types do not meet', () => {
    const stringify = (value: number): string => String(value);
    const negate = (value: boolean): boolean => !value;
    // @ts-expect-error negate cannot consume stringify's string output
    pipe(1, stringify, negate);
  });

  it('builds the canonical immutable algebra and seals the same portable tree', async () => {
    const root = pipe(
      from({ schemaView, relationId: 'items' }, 'item'),
      where(compare('gt', field('item', 'score'), literal(1))),
      select('result', { id: field('item', 'id') })
    );
    const input: RelationInput = { relation: { schemaView, relationId: 'items' }, rows: [{ id: 1, score: 2 }, { id: 2, score: 0 }], completeness: 'exact' };
    expect(evaluateQuery({ root, relations: [input] }).rows).toEqual([{ id: 1 }]);

    const query = await sealQuery({ body: { schemaViews: [schemaView], parameters: {}, root, requiredCapabilities: [] } });
    expect(query).toMatchObject({ kind: 'query', formatVersion: 1, body: { root } });
    expect(query.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('parses declared parameters without accepting missing, extra, or malformed values', () => {
    const declarations = {
      minimum: { kind: 'number' as const },
      options: {
        kind: 'record' as const,
        fields: { label: { kind: 'string' as const }, note: { kind: 'string' as const } },
        optional: ['note']
      }
    };
    expect(safeParseQueryParameters(declarations, { minimum: 2, options: { label: 'ok' } })).toMatchObject({ success: true, value: { minimum: 2, options: { label: 'ok' } } });
    const rejected = safeParseQueryParameters(declarations, { minimum: '2', extra: true, options: {} });
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error('expected invalid parameters');
    expect(rejected.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['query.parameter_invalid', 'schema.scalar_type']));
  });
});
