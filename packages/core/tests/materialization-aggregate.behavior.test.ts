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

describe('materialization aggregate behavior', () => {
  it('recomputes unsupported aggregate functions with diagnostics', () => {
    const cases: readonly { readonly label: string; readonly query: Query<unknown>; readonly reason: string }[] = [
      {
        label: 'top',
        query: pipe(from(entry), aggregate({ groupBy: { accountId: entry.accountId }, aggregates: { amounts: top(entry.amount, 2) } })) as Query<unknown>,
        reason: 'aggregate function "top" is not incrementally maintained'
      }
    ];

    for (const item of cases) {
      const db = mat(makeDb(), item.query);

      expect(explainMaterialization(item.query), item.label).toEqual(expect.objectContaining({
        supported: false,
        update: 'recomputed',
        recomputed: true,
        reason: item.reason,
        diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: item.reason })]
      }));

      const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: 125 }));

      expect(result.committed).toBe(true);
      expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
        update: 'recomputed',
        recomputed: true,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'materialization_unsupported', message: item.reason })
        ])
      }));
      expect(q(result.db, item.query)).toEqual(q(demat(result.db, item.query), item.query));
    }
  });

  it('recomputes unsupported avg expressions with diagnostics', () => {
    const doubleAmount = hostFn<number>('doubleAmountForAvgUnsupportedTest', (input) =>
      typeof input === 'number' ? input * 2 : 0);
    const query = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: { average: avg(call(doubleAmount, entry.amount)) }
      }),
      sort(asc(field<string>('row', 'accountId')))
    ) as Query<unknown>;
    const reason = 'avg aggregate expressions are not incrementally maintained';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: reason })]
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: 125 }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported', message: reason })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('recomputes aggregate projections that drop group identity', () => {
    const query = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: { total: sum(entry.amount) }
      }),
      project({ total: field<number>('row', 'total') })
    );
    const reason = 'aggregate incremental maintenance requires final projection to preserve group identity';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: reason })]
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: 125 }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported', message: reason })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('requires sorted aggregate output to include group identity in the final sort', () => {
    const query = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: { total: sum(entry.amount) }
      }),
      sort(asc(field<number>('row', 'total')))
    );
    const reason = 'aggregate final sort requires group identity in sort order';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: reason })]
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: 125 }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported', message: reason })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('recomputes unsorted aggregate output because group order can change without group identity changes', () => {
    const query = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          entryCount: count(),
          total: sum(entry.amount)
        }
      })
    );
    const reason = 'aggregate incremental maintenance requires final sort with group identity';
    const db = mat(createDb({
      accounts: [],
      entries: [
        { id: 'a', accountId: 'A', amount: 1, posted: true },
        { id: 'b', accountId: 'B', amount: 2, posted: true }
      ]
    }), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: reason })]
    }));

    const result = tryTransact(db, [
      updateByKey(schema.entries, 'a', { accountId: 'B' }),
      updateByKey(schema.entries, 'b', { accountId: 'A' })
    ]);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      rows: [
        { accountId: 'B', entryCount: 1, total: 1 },
        { accountId: 'A', entryCount: 1, total: 2 }
      ],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported', message: reason })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });
});
