import { describe, expect, it } from 'vitest';
import {
  createSchemaManifestResolver,
  defineSchema,
  numberField,
  relation,
  stringField,
  toSchemaManifest
} from '@tarstate/core/schema';

const schema = defineSchema({
  items: relation({
    key: 'id',
    fields: {
      id: stringField(),
      label: stringField(),
      score: numberField()
    }
  })
});

const manifest = toSchemaManifest(schema, {
  schemaId: 'tarstate.test.resolver@1'
});

describe('schema manifest resolver', () => {
  it('resolves relation refs from manifests and catalogs', () => {
    const resolver = createSchemaManifestResolver({
      catalog: { [manifest.schemaId]: manifest }
    });

    expect(resolver.relation(manifest, 'items').name).toBe('items');
    expect(resolver.relation(manifest.schemaId, 'items').fields.score?.valueKind).toBe('number');
  });

  it('throws when a catalog schema or relation is missing', () => {
    const resolver = createSchemaManifestResolver();

    expect(() => resolver.relation('missing', 'items')).toThrow(/not found/);
    expect(() => resolver.relation(manifest, 'missing')).toThrow(/Relation "missing"/);
  });
});
