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

declare const compositeSchemaBody: {
  readonly relations: {
    readonly files: {
      readonly relationId: 'files';
      readonly key: readonly ['contentKind', 'id'];
      readonly fields: {
        readonly contentKind: { readonly type: { readonly kind: 'string'; readonly values: readonly ['text'] } };
        readonly id: { readonly type: { readonly kind: 'string'; readonly values: readonly ['file'] } };
        readonly textContent: { readonly type: { readonly kind: 'string' } };
      };
    };
  };
};

export const compositeRelation: LiteralRelation<typeof compositeSchemaBody, 'files'> = {
  schemaView: itemSchemaArtifactRef,
  relationId: 'files',
  name: 'files',
  declaration: {
    relationId: 'files',
    key: ['contentKind', 'id'],
    fields: {
      contentKind: { type: { kind: 'string', values: ['text'] } },
      id: { type: { kind: 'string', values: ['file'] } },
      textContent: { type: { kind: 'string' } }
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
snapshot.spliceText(
  compositeRelation,
  ['text', 'file'],
  'textContent',
  { index: 0, deleteCount: 0, insert: 'New ' }
);

snapshot.spliceText(
  compositeRelation,
  // @ts-expect-error generated composite keys retain exact tuple order
  ['file', 'text'],
  'textContent',
  { index: 0, deleteCount: 0, insert: 'New ' }
);

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
