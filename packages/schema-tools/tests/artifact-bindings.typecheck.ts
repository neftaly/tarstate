import type { DatabaseTransactionSnapshot } from '@tarstate/core/transactions';
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

const itemRelation: LiteralRelation<typeof itemSchemaBody, 'items'> = {
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
};

type ItemRow = SchemaRow<typeof itemSchemaBody, 'items'>;
type ItemKey = SchemaKey<typeof itemSchemaBody, 'items'>;

const row: ItemRow = { id: 'a', count: 1 };
const key: ItemKey = ['a'];
declare const snapshot: DatabaseTransactionSnapshot;
const rows = snapshot.rows(itemRelation);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
const rowInferenceIsExact: Equal<(typeof rows)[number], ItemRow> = true;

snapshot.withRows(itemRelation, [{ id: 'a', count: 1 }]);
snapshot.insertWithGeneratedKey(itemRelation, 'new-item', { count: 1 });

void [itemRelation, row, key, rows, rowInferenceIsExact];

// @ts-expect-error generated rows retain exact required fields
const missingCount: ItemRow = { id: 'a' };
void missingCount;

// @ts-expect-error generated keys retain scalar types
const numericKey: ItemKey = [1];
void numericKey;

// @ts-expect-error transaction rows retain exact required fields
snapshot.withRows(itemRelation, [{ id: 'a' }]);

// @ts-expect-error generated-key inserts exclude the generated logical key
snapshot.insertWithGeneratedKey(itemRelation, 'new-item', { id: 'a', count: 1 });
