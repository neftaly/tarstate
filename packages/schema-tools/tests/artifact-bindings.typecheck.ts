import type { LiteralRelation, SchemaKey, SchemaRow } from '@tarstate/core/schema';

declare const itemSchemaBody: {
  readonly relations: {
    readonly items: {
      readonly relationId: 'items';
      readonly key: readonly ['id'];
      readonly fields: {
        readonly id: { readonly type: { readonly kind: 'string' } };
        readonly count: { readonly type: { readonly kind: 'integer' } };
      };
    };
  };
};

const itemSchemaArtifactRef = {
  id: 'urn:test:item-schema',
  contentHash: `sha256:${'a'.repeat(64)}` as const
};

const itemRelation = {
  schemaView: itemSchemaArtifactRef,
  relationId: 'items',
  name: 'items',
  declaration: {
    relationId: 'items',
    key: ['id'],
    fields: {
      id: { type: { kind: 'string' } },
      count: { type: { kind: 'integer' } }
    }
  }
} as const satisfies LiteralRelation<typeof itemSchemaBody, 'items'>;

type ItemRow = SchemaRow<typeof itemSchemaBody, 'items'>;
type ItemKey = SchemaKey<typeof itemSchemaBody, 'items'>;

const row: ItemRow = { id: 'a', count: 1 };
const key: ItemKey = ['a'];
void [itemRelation, row, key];

// @ts-expect-error generated rows retain exact required fields
const missingCount: ItemRow = { id: 'a' };
void missingCount;

// @ts-expect-error generated keys retain scalar types
const numericKey: ItemKey = [1];
void numericKey;
