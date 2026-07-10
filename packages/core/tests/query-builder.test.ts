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
  it('preserves types through ordinary pipelines longer than three operators', () => {
    const result = pipe(1, (value) => String(value), (value) => value.length, (value) => value > 0, (value) => value ? ['yes'] : [], (value) => value[0]);
    expectTypeOf(result).toEqualTypeOf<string | undefined>();
    expect(result).toBe('yes');
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
