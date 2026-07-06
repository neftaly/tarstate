import { describe, expect, it } from 'vitest';
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
