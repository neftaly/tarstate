import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { demat, explainMaterialization, mat } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  avg,
  call,
  count,
  field,
  from,
  hostFn,
  pipe,
  project,
  sort,
  sum,
  top,
  type Query
} from '@tarstate/core/query';
import { updateByKey } from '@tarstate/core/write';
import { entry, makeDb, schema } from './behavior-fixtures.js';

type UnsupportedAggregateCase = {
  readonly label: string;
  readonly query: Query<unknown>;
  readonly reason: string;
  readonly db?: ReturnType<typeof makeDb>;
  readonly patch?: ReturnType<typeof updateByKey> | readonly ReturnType<typeof updateByKey>[];
  readonly rows?: readonly unknown[];
};

describe('materialization aggregate behavior', () => {
  it('recomputes unsupported aggregate materializations with diagnostics', () => {
    const doubleAmount = hostFn<number>('doubleAmountForAvgUnsupportedTest', (input) =>
      typeof input === 'number' ? input * 2 : 0);

    for (const item of unsupportedAggregateCases(doubleAmount)) {
      expectUnsupportedAggregateRecompute(item);
    }
  });
});

function unsupportedAggregateCases(doubleAmount: ReturnType<typeof hostFn<number>>): readonly UnsupportedAggregateCase[] {
  return [
    {
      label: 'top aggregate',
      query: pipe(from(entry), aggregate({ groupBy: { accountId: entry.accountId }, aggregates: { amounts: top(entry.amount, 2) } })) as Query<unknown>,
      reason: 'aggregate function "top" is not incrementally maintained'
    },
    {
      label: 'avg expression',
      query: pipe(
        from(entry),
        aggregate({
          groupBy: { accountId: entry.accountId },
          aggregates: { average: avg(call(doubleAmount, entry.amount)) }
        }),
        sort(asc(field<string>('row', 'accountId')))
      ) as Query<unknown>,
      reason: 'avg aggregate expressions are not incrementally maintained'
    },
    {
      label: 'projection drops group identity',
      query: pipe(
        from(entry),
        aggregate({
          groupBy: { accountId: entry.accountId },
          aggregates: { total: sum(entry.amount) }
        }),
        project({ total: field<number>('row', 'total') })
      ) as Query<unknown>,
      reason: 'aggregate incremental maintenance requires final projection to preserve group identity'
    },
    {
      label: 'sort drops group identity',
      query: pipe(
        from(entry),
        aggregate({
          groupBy: { accountId: entry.accountId },
          aggregates: { total: sum(entry.amount) }
        }),
        sort(asc(field<number>('row', 'total')))
      ) as Query<unknown>,
      reason: 'aggregate final sort requires group identity in sort order'
    },
    {
      label: 'unsorted group output',
      query: pipe(
        from(entry),
        aggregate({
          groupBy: { accountId: entry.accountId },
          aggregates: {
            entryCount: count(),
            total: sum(entry.amount)
          }
        })
      ) as Query<unknown>,
      reason: 'aggregate incremental maintenance requires final sort with group identity',
      db: createDb({
        accounts: [],
        entries: [
          { id: 'a', accountId: 'A', amount: 1, posted: true },
          { id: 'b', accountId: 'B', amount: 2, posted: true }
        ]
      }),
      patch: [
        updateByKey(schema.entries, 'a', { accountId: 'B' }),
        updateByKey(schema.entries, 'b', { accountId: 'A' })
      ],
      rows: [
        { accountId: 'B', entryCount: 1, total: 1 },
        { accountId: 'A', entryCount: 1, total: 2 }
      ]
    }
  ];
}

function expectUnsupportedAggregateRecompute(item: UnsupportedAggregateCase): void {
  const db = mat(item.db ?? makeDb(), item.query);

  expect(explainMaterialization(item.query), item.label).toEqual(expect.objectContaining({
    supported: false,
    update: 'recomputed',
    recomputed: true,
    reason: item.reason,
    diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: item.reason })]
  }));

  const result = tryTransact(db, item.patch ?? updateByKey(schema.entries, 'e1', { amount: 125 }));

  expect(result.committed, item.label).toBe(true);
  expect(result.materializations?.changes[0], item.label).toEqual(expect.objectContaining({
    update: 'recomputed',
    recomputed: true,
    ...(item.rows === undefined ? {} : { rows: item.rows }),
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'materialization_unsupported', message: item.reason })
    ])
  }));
  expect(q(result.db, item.query), item.label).toEqual(q(demat(result.db, item.query), item.query));
}
