import { bench, describe } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import {
  aggregate,
  and,
  as,
  btree,
  constRows,
  count,
  expand,
  field,
  from,
  gt,
  gte,
  lookup,
  lt,
  pipe,
  project,
  sum,
  where
} from '@tarstate/core/query';
import { defineSchema, idField, numberField, relation, stringField } from '@tarstate/core/schema';
import { fromIndexedObjectSource } from '@tarstate/core/experimental/indexed-source';
import { fromObjectSource } from '@tarstate/core/source';

type ObjectRow = {
  readonly id: string;
  readonly kind: string;
  readonly rank: number;
};

const schema = defineSchema({
  objects: relation<ObjectRow>({
    key: 'id',
    fields: {
      id: idField('object'),
      kind: stringField(),
      rank: numberField()
    }
  })
});

const object = as(schema.objects, 'object');
const rows = Array.from({ length: 1_000 }, (_, index): ObjectRow => ({
  id: `object-${index}`,
  kind: index % 5 === 0 ? 'folder' : 'file',
  rank: index
}));
const source = fromObjectSource({ objects: rows });
const indexedSource = fromIndexedObjectSource({ objects: rows });
const orderRows = Array.from({ length: 500 }, (_, orderIndex) => ({
  id: `order-${orderIndex}`,
  items: [
    { product: `product-${orderIndex * 2}`, quantity: 1 },
    { product: `product-${orderIndex * 2 + 1}`, quantity: 2 }
  ]
}));

const filteredProjection = pipe(
  from(object),
  where(gt(object.rank, 500)),
  project({
    id: object.id,
    kind: object.kind,
    rank: object.rank
  })
);

const scannedRangeProjection = pipe(
  from(object),
  where(and(gte(object.rank, 400), lt(object.rank, 600))),
  project({
    id: object.id,
    kind: object.kind,
    rank: object.rank
  })
);

const indexedRangeProjection = pipe(
  from(object),
  btree(object.rank),
  where(and(gte(object.rank, 400), lt(object.rank, 600))),
  project({
    id: object.id,
    kind: object.kind,
    rank: object.rank
  })
);

const indexedLookup = pipe(
  lookup(object, 'id', 'object-900'),
  project({
    id: object.id,
    kind: object.kind,
    rank: object.rank
  })
);

const groupedTotals = pipe(
  from(object),
  aggregate({
    groupBy: { kind: object.kind },
    aggregates: {
      total: count(),
      rank: sum(object.rank)
    }
  })
);

const orderItems = pipe(
  constRows(orderRows),
  expand(field<readonly { readonly product: string; readonly quantity: number }[]>('', 'items'), {
    fields: ['product', 'quantity'] as const
  }),
  project({
    orderId: field<string>('', 'id'),
    product: field<string>('', 'product'),
    quantity: field<number>('', 'quantity')
  })
);

describe('evaluate', () => {
  bench('where + project over 1k object rows', async () => {
    await evaluate(source, filteredProjection);
  });

  bench('normal scan range filter over 1k object rows', async () => {
    await evaluate(source, scannedRangeProjection);
  });

  bench('btree range lookup over 1k object rows', async () => {
    await evaluate(indexedSource, indexedRangeProjection);
  });

  bench('explicit indexed lookup over 1k object rows', async () => {
    await evaluate(indexedSource, indexedLookup);
  });

  bench('aggregate over 1k object rows', async () => {
    await evaluate(source, groupedTotals);
  });

  bench('expand 500 nested orders into 1k item rows', async () => {
    await evaluate(fromObjectSource({}), orderItems);
  });
});
