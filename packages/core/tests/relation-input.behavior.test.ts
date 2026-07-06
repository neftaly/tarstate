import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineSchema,
  numberField,
  relation,
  stringField,
  toSchemaManifest
} from '@tarstate/core/schema';
import {
  parseSingleRelationRow,
  singleRelationInput
} from '@tarstate/core/relation';
import type { RelationInputEnvelope } from '@tarstate/core/relation';

type Item = {
  readonly id: string;
  readonly label: string;
  readonly score: number;
};

const schema = defineSchema({
  items: relation<Item>({
    key: 'id',
    fields: {
      id: stringField(),
      label: stringField(),
      score: numberField()
    }
  })
});

const manifest = toSchemaManifest(schema, {
  schemaId: 'tarstate.test.items@1'
});

describe('single-row relation inputs', () => {
  it('builds and parses one-row relation envelopes', () => {
    const row = { id: 'a', label: 'Alpha', score: 1 };
    const input = singleRelationInput(manifest, schema.items, row);

    expectTypeOf(input).toEqualTypeOf<RelationInputEnvelope<typeof row, 'items'>>();

    expect(input).toEqual({
      schemaId: manifest.schemaId,
      relations: { items: [row] }
    });

    const result = parseSingleRelationRow<Item>(input, {
      relation: schema.items,
      schema: manifest
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row).toEqual(row);
  });

  it('types single-relation envelopes from relation refs and names', () => {
    const typed = singleRelationInput(manifest, schema.items, {
      id: 'a',
      label: 'Alpha',
      score: 1,
      source: 'test'
    });
    const named = singleRelationInput(manifest, 'items', { id: 'a', label: 'Alpha' });

    expectTypeOf(typed.relations.items).toMatchTypeOf<readonly Item[]>();
    expectTypeOf(typed.relations.items).toEqualTypeOf<readonly {
      id: string;
      label: string;
      score: number;
      source: string;
    }[]>();
    expectTypeOf(named).toEqualTypeOf<RelationInputEnvelope<{
      id: string;
      label: string;
    }, 'items'>>();

    // @ts-expect-error typed relation refs require rows that satisfy the relation row shape.
    singleRelationInput(manifest, schema.items, { id: 'a', label: 'Alpha' });
  });

  it('reports validation diagnostics for invalid rows', () => {
    const result = parseSingleRelationRow<Item>(
      singleRelationInput(manifest, 'items', { id: 'a', label: 'Alpha' }),
      {
        relation: 'items',
        schema: manifest
      }
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('field_missing');
  });
});
