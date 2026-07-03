import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { diffRows } from '@tarstate/core/diff';
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
  max,
  min,
  pipe,
  project,
  sort,
  sum,
  top,
  type Query
} from '@tarstate/core/query';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, makeDb, schema, type Entry } from './behavior-fixtures.js';

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

  it('maintains min and max aggregates incrementally for affected groups', () => {
    const query = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          lowest: min(entry.amount),
          highest: max(entry.amount)
        }
      }),
      sort(asc(field<string>('row', 'accountId')))
    ) as Query<unknown>;
    let db = mat(createDb({
      accounts: [],
      entries: [
        { id: 'cash-low', accountId: 'cash', amount: 3, posted: true },
        { id: 'cash-mid', accountId: 'cash', amount: 10, posted: true },
        { id: 'cash-high', accountId: 'cash', amount: 17, posted: true },
        { id: 'sales-low', accountId: 'sales', amount: -2, posted: true },
        { id: 'sales-high', accountId: 'sales', amount: 8, posted: true }
      ] satisfies readonly Entry[]
    }), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));
    expect(q(db, query)).toEqual([
      { accountId: 'cash', lowest: 3, highest: 17 },
      { accountId: 'sales', lowest: -2, highest: 8 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      updateByKey(schema.entries, 'cash-low', { amount: 22 })
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', lowest: 10, highest: 22 },
      { accountId: 'sales', lowest: -2, highest: 8 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      deleteByKey(schema.entries, 'sales-low')
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', lowest: 10, highest: 22 },
      { accountId: 'sales', lowest: 8, highest: 8 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      updateByKey(schema.entries, 'cash-high', { accountId: 'sales', amount: -4 })
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', lowest: 10, highest: 22 },
      { accountId: 'sales', lowest: -4, highest: 8 }
    ]);
    expect(q(db, query)).toEqual(q(demat(db, query), query));
  });

  it('maintains avg aggregates incrementally for affected groups', () => {
    const query = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          average: avg(entry.amount)
        }
      }),
      sort(asc(field<string>('row', 'accountId')))
    ) as Query<unknown>;
    let db = mat(createDb({
      accounts: [],
      entries: [
        { id: 'cash-a', accountId: 'cash', amount: 10, posted: true },
        { id: 'cash-b', accountId: 'cash', amount: 20, posted: true },
        { id: 'sales-a', accountId: 'sales', amount: 2, posted: true },
        { id: 'sales-b', accountId: 'sales', amount: 8, posted: true }
      ] satisfies readonly Entry[]
    }), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));
    expect(q(db, query)).toEqual([
      { accountId: 'cash', average: 15 },
      { accountId: 'sales', average: 5 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      updateByKey(schema.entries, 'cash-a', { amount: 16 })
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', average: 18 },
      { accountId: 'sales', average: 5 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      insertOrReplace(schema.entries, { id: 'sales-c', accountId: 'sales', amount: 20, posted: true })
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', average: 18 },
      { accountId: 'sales', average: 10 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      deleteByKey(schema.entries, 'sales-a')
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', average: 18 },
      { accountId: 'sales', average: 14 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      updateByKey(schema.entries, 'cash-b', { accountId: 'sales', amount: 30 })
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'cash', average: 16 },
      { accountId: 'sales', average: 58 / 3 }
    ]);

    db = expectIncrementalAggregate(db, query, [
      deleteByKey(schema.entries, 'cash-a')
    ]);
    expect(q(db, query)).toEqual([
      { accountId: 'sales', average: 58 / 3 }
    ]);
    expect(q(db, query)).toEqual(q(demat(db, query), query));
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

function expectIncrementalAggregate<DbValue extends ReturnType<typeof makeDb>>(
  db: DbValue,
  query: Query<unknown>,
  batch: readonly WritePatch[]
): DbValue {
  const beforeRows = q(db, query);
  const result = tryTransact(db, batch);
  expect(result.committed).toBe(true);

  const dematerializedRows = q(demat(result.db, query), query);
  const expected = diffRows(beforeRows, dematerializedRows, { keyBy: ['accountId'] });
  const change = result.materializations?.changes[0];

  expect(expected.diagnostics).toEqual([]);
  expect(change).toEqual(expect.objectContaining({
    update: 'incremental',
    recomputed: false,
    reason: 'incremental delta maintenance',
    previousRows: beforeRows,
    rows: dematerializedRows,
    rowChanges: expected.changes,
    added: expected.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removed: expected.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    diagnostics: []
  }));
  expect(q(result.db, query)).toBe(change?.rows);
  expect(q(result.db, query)).toEqual(dematerializedRows);

  return result.db;
}
