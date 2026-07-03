import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { diffRows } from '@tarstate/core/diff';
import { demat, explainMaterialization, mat } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  avg,
  count,
  eq,
  field,
  from,
  max,
  min,
  pipe,
  project,
  sort,
  sum,
  top,
  value,
  type Query
} from '@tarstate/core/query';
import { deleteByKey, insert, updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, makeDb, schema } from './behavior-fixtures.js';

const entryTotalsByAccount = pipe(
  from(entry),
  aggregate({
    groupBy: { accountId: entry.accountId },
    aggregates: {
      entryCount: count(),
      total: sum(entry.amount)
    }
  }),
  sort(asc(field<string>('row', 'accountId')))
);

function pathKey(...path: readonly string[]): (row: unknown) => unknown {
  return (row) => {
    let current = row;
    for (const segment of path) {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
    return [current];
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

describe('materialization aggregate behavior', () => {
  it('incrementally maintains grouped aggregate count/sum for amount changes, account moves, inserts, and deletes', () => {
    let db = mat(makeDb(), entryTotalsByAccount);

    expect(explainMaterialization(entryTotalsByAccount)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    const assertIncremental = (patch: WritePatch, expectedRows: readonly unknown[]): void => {
      const beforeRows = q(db, entryTotalsByAccount);
      const result = tryTransact(db, patch);
      const afterRows = q(demat(result.db, entryTotalsByAccount), entryTotalsByAccount);
      const diff = diffRows(beforeRows, afterRows, { keyBy: pathKey('accountId') });
      const change = result.materializations?.changes[0];

      expect(result.committed).toBe(true);
      expect(change).toEqual(expect.objectContaining({
        update: 'incremental',
        recomputed: false,
        reason: 'incremental delta maintenance',
        previousRows: beforeRows,
        rows: afterRows,
        rowChanges: diff.changes,
        added: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
        removed: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
        diagnostics: []
      }));
      expect(q(result.db, entryTotalsByAccount)).toBe(change?.rows);
      expect(q(result.db, entryTotalsByAccount)).toEqual(afterRows);
      expect(afterRows).toEqual(expectedRows);
      expect(diff.diagnostics).toEqual([]);
      db = result.db;
    };

    assertIncremental(updateByKey(schema.entries, 'e1', { amount: 125 }), [
      { accountId: 'cash', entryCount: 2, total: 125 },
      { accountId: 'fees', entryCount: 1, total: -5 },
      { accountId: 'sales', entryCount: 1, total: -120 }
    ]);
    assertIncremental(updateByKey(schema.entries, 'e1', { accountId: 'fees' }), [
      { accountId: 'cash', entryCount: 1, total: 0 },
      { accountId: 'fees', entryCount: 2, total: 120 },
      { accountId: 'sales', entryCount: 1, total: -120 }
    ]);
    assertIncremental(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }), [
      { accountId: 'cash', entryCount: 2, total: 35 },
      { accountId: 'fees', entryCount: 2, total: 120 },
      { accountId: 'sales', entryCount: 1, total: -120 }
    ]);
    assertIncremental(deleteByKey(schema.entries, 'e3'), [
      { accountId: 'cash', entryCount: 2, total: 35 },
      { accountId: 'fees', entryCount: 1, total: 125 },
      { accountId: 'sales', entryCount: 1, total: -120 }
    ]);
  });

  it('incrementally maintains count(predicate) when the predicate flips', () => {
    const postedCountsByAccount = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: { postedCount: count(eq(entry.posted, value(true))) }
      }),
      sort(asc(field<string>('row', 'accountId')))
    );
    const db = mat(makeDb(), postedCountsByAccount);
    const beforeRows = q(db, postedCountsByAccount);

    const result = tryTransact(db, updateByKey(schema.entries, 'e4', { posted: true }));
    const afterRows = q(demat(result.db, postedCountsByAccount), postedCountsByAccount);
    const diff = diffRows(beforeRows, afterRows, { keyBy: pathKey('accountId') });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(afterRows).toEqual([
      { accountId: 'cash', postedCount: 2 },
      { accountId: 'fees', postedCount: 1 },
      { accountId: 'sales', postedCount: 1 }
    ]);
    expect(q(result.db, postedCountsByAccount)).toBe(change?.rows);
    expect(q(result.db, postedCountsByAccount)).toEqual(afterRows);
  });

  it('coalesces multiple aggregate source changes into one final group update per affected group', () => {
    const db = mat(makeDb(), entryTotalsByAccount);
    const beforeRows = q(db, entryTotalsByAccount);

    const result = tryTransact(db, [
      updateByKey(schema.entries, 'e1', { amount: 125 }),
      updateByKey(schema.entries, 'e4', { amount: 5 }),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 10, memo: 'top-up', posted: true }),
      updateByKey(schema.entries, 'e2', { amount: -130 })
    ]);
    const afterRows = q(demat(result.db, entryTotalsByAccount), entryTotalsByAccount);
    const diff = diffRows(beforeRows, afterRows, { keyBy: pathKey('accountId') });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(change?.rowChanges).toEqual([
      {
        kind: 'updated',
        key: '["cash"]',
        before: { accountId: 'cash', entryCount: 2, total: 120 },
        after: { accountId: 'cash', entryCount: 3, total: 140 }
      },
      {
        kind: 'updated',
        key: '["sales"]',
        before: { accountId: 'sales', entryCount: 1, total: -120 },
        after: { accountId: 'sales', entryCount: 1, total: -130 }
      }
    ]);
    expect(afterRows).toEqual([
      { accountId: 'cash', entryCount: 3, total: 140 },
      { accountId: 'fees', entryCount: 1, total: -5 },
      { accountId: 'sales', entryCount: 1, total: -130 }
    ]);
    expect(q(result.db, entryTotalsByAccount)).toBe(change?.rows);
    expect(q(result.db, entryTotalsByAccount)).toEqual(afterRows);
  });

  it('recomputes unsupported aggregate functions with diagnostics', () => {
    const cases: readonly { readonly label: string; readonly query: Query<unknown>; readonly reason: string }[] = [
      {
        label: 'avg',
        query: pipe(from(entry), aggregate({ groupBy: { accountId: entry.accountId }, aggregates: { amount: avg(entry.amount) } })) as Query<unknown>,
        reason: 'aggregate function "avg" is not incrementally maintained'
      },
      {
        label: 'min',
        query: pipe(from(entry), aggregate({ groupBy: { accountId: entry.accountId }, aggregates: { amount: min(entry.amount) } })) as Query<unknown>,
        reason: 'aggregate function "min" is not incrementally maintained'
      },
      {
        label: 'max',
        query: pipe(from(entry), aggregate({ groupBy: { accountId: entry.accountId }, aggregates: { amount: max(entry.amount) } })) as Query<unknown>,
        reason: 'aggregate function "max" is not incrementally maintained'
      },
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
