import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { demat, explainMaterialization, mat } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  count,
  desc,
  eq,
  expand,
  field,
  from,
  join,
  keyBy,
  limit,
  pipe,
  project,
  sel,
  sort,
  sortLimit,
  sum,
  union,
  value,
  where,
  without,
  type Query
} from '@tarstate/core/query';
import { deleteByKey, insert, updateByKey } from '@tarstate/core/write';
import { account, entry, makeDb, schema } from './behavior-fixtures.js';

const sortedCashEntryProjection = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  sort(asc(entry.amount), asc(entry.id)),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount
  })
);

const cashEntryProjection = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

const entryCount = pipe(
  from(entry),
  aggregate({ aggregates: { count: count() } })
);

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

const firstTwoEntries = pipe(
  from(entry),
  sort(asc(entry.id)),
  limit(2)
);

describe('materialization, watch, and store behavior', () => {
  it('reports an incremental change with no recompute fallback for a focused delta', () => {
    const query = pipe(
      from(entry),
      where(eq(entry.accountId, value('cash'))),
      project({ id: entry.id, amount: entry.amount })
    );
    const db = mat(makeDb(), query);
    const beforeRows = q(db, query);

    const result = tryTransact(
      db,
      updateByKey(schema.entries, 'e1', { amount: 125 }),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );

    expect(result.committed).toBe(true);
    expect(result.materializations).toEqual(expect.objectContaining({
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: []
    }));
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      reason: 'incremental delta maintenance',
      previousRows: beforeRows,
      rows: [
        { id: 'e1', amount: 125 },
        { id: 'e4', amount: 0 },
        { id: 'e5', amount: 35 }
      ],
      added: [{ id: 'e5', amount: 35 }],
      removed: [],
      rowChanges: [
        { kind: 'updated', key: '["e1"]', before: { id: 'e1', amount: 120 }, after: { id: 'e1', amount: 125 } },
        { kind: 'added', key: '["e5"]', row: { id: 'e5', amount: 35 } }
      ],
      diagnostics: []
    }));
    expect(q(result.db, query)).toBe(result.materializations?.changes[0]?.rows);
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('maintains multiple materializations over one relation while unsupported peers recompute', () => {
    const queries: readonly Query<unknown>[] = [
      cashEntryProjection as Query<unknown>,
      sortedCashEntryProjection as Query<unknown>,
      entryTotalsByAccount as Query<unknown>
    ];
    const db = mat(makeDb(), ...queries);

    const result = tryTransact(
      db,
      updateByKey(schema.entries, 'e1', { amount: 125 }),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }),
      deleteByKey(schema.entries, 'e4')
    );
    const changes = result.materializations?.changes ?? [];

    expect(result.committed).toBe(true);
    expect(result.materializations).toEqual(expect.objectContaining({
      maintained: 3,
      recomputed: 0,
      carried: 0,
      diagnostics: []
    }));
    expect(changes.map((change) => change.update)).toEqual(['incremental', 'incremental', 'incremental']);
    expect(changes[0]).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { id: 'e1', amount: 125 },
        { id: 'e5', amount: 35 }
      ],
      added: [{ id: 'e5', amount: 35 }],
      removed: [{ id: 'e4', amount: 0 }],
      diagnostics: []
    }));
    expect(changes[1]).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { id: 'e5', accountId: 'cash', amount: 35 },
        { id: 'e1', accountId: 'cash', amount: 125 }
      ],
      diagnostics: []
    }));
    expect(changes[2]).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { accountId: 'cash', entryCount: 2, total: 160 },
        { accountId: 'fees', entryCount: 1, total: -5 },
        { accountId: 'sales', entryCount: 1, total: -120 }
      ],
      rowChanges: [
        {
          kind: 'updated',
          key: '["cash"]',
          before: { accountId: 'cash', entryCount: 2, total: 120 },
          after: { accountId: 'cash', entryCount: 2, total: 160 }
        }
      ],
      diagnostics: []
    }));

    for (const query of queries) {
      expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
    }
  });

  it('incrementally maintains filtered projections across mixed transaction batches', () => {
    const db = mat(makeDb(), cashEntryProjection);

    const result = tryTransact(db, [
      updateByKey(schema.entries, 'e1', { amount: 130 }),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }),
      deleteByKey(schema.entries, 'e4'),
      updateByKey(schema.accounts, 'cash', { name: 'Operating cash' })
    ]);
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(result.patches).toBe(4);
    expect(result.applied).toBe(4);
    expect(result.materializations).toEqual(expect.objectContaining({
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: []
    }));
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { id: 'e1', amount: 130 },
        { id: 'e5', amount: 35 }
      ],
      added: [{ id: 'e5', amount: 35 }],
      removed: [{ id: 'e4', amount: 0 }],
      diagnostics: []
    }));
    expect(change?.rowChanges).toEqual(expect.arrayContaining([
      { kind: 'updated', key: '["e1"]', before: { id: 'e1', amount: 120 }, after: { id: 'e1', amount: 130 } },
      { kind: 'removed', key: '["e4"]', row: { id: 'e4', amount: 0 } },
      { kind: 'added', key: '["e5"]', row: { id: 'e5', amount: 35 } }
    ]));
    expect(q(result.db, cashEntryProjection)).toBe(change?.rows);
    expect(q(result.db, cashEntryProjection)).toEqual(q(demat(result.db, cashEntryProjection), cashEntryProjection));
  });

  it('incrementally maintains sort-before-project when the projection preserves sort keys and identity', () => {
    const db = mat(makeDb(), sortedCashEntryProjection);
    const beforeRows = q(db, sortedCashEntryProjection);

    expect(explainMaterialization(sortedCashEntryProjection)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    const result = tryTransact(
      db,
      updateByKey(schema.entries, 'e1', { amount: -10 }),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );

    expect(result.committed).toBe(true);
    expect(result.materializations).toEqual(expect.objectContaining({
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: []
    }));
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      reason: 'incremental delta maintenance',
      previousRows: beforeRows,
      rows: [
        { id: 'e1', accountId: 'cash', amount: -10 },
        { id: 'e4', accountId: 'cash', amount: 0 },
        { id: 'e5', accountId: 'cash', amount: 35 }
      ],
      added: [{ id: 'e5', accountId: 'cash', amount: 35 }],
      removed: [],
      diagnostics: []
    }));
    expect(q(result.db, sortedCashEntryProjection)).toBe(result.materializations?.changes[0]?.rows);
    expect(q(result.db, sortedCashEntryProjection)).toEqual(q(demat(result.db, sortedCashEntryProjection), sortedCashEntryProjection));
  });

  it('incrementally maintains sort and limit by admitting the next hidden row after a visible delete', () => {
    const db = mat(makeDb(), firstTwoEntries);
    const beforeRows = q(db, firstTwoEntries);

    expect(explainMaterialization(firstTwoEntries)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    const result = tryTransact(db, deleteByKey(schema.entries, 'e1'));
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      previousRows: beforeRows,
      rows: [
        { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid', posted: true },
        { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true }
      ],
      added: [{ id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true }],
      removed: [{ id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true }],
      diagnostics: []
    }));
    expect(change?.rowChanges).toEqual([
      { kind: 'removed', key: '["e1"]', row: { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true } },
      { kind: 'added', key: '["e3"]', row: { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true } }
    ]);
    expect(Object.keys(result.materializations ?? {})).toEqual(['maintained', 'recomputed', 'carried', 'skipped', 'changes', 'diagnostics']);
    expect(q(result.db, firstTwoEntries)).toBe(change?.rows);
    expect(q(result.db, firstTwoEntries)).toEqual(q(demat(result.db, firstTwoEntries), firstTwoEntries));
  });

  it('incrementally maintains sortLimit when a hidden row sort-key update enters the top N', () => {
    const query = pipe(
      from(entry),
      sortLimit(2, desc(entry.amount), asc(entry.id))
    );
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e3', { amount: 150 }));
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { id: 'e3', accountId: 'fees', amount: 150, memo: null, posted: true },
        { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true }
      ],
      added: [{ id: 'e3', accountId: 'fees', amount: 150, memo: null, posted: true }],
      removed: [{ id: 'e4', accountId: 'cash', amount: 0, posted: false }],
      diagnostics: []
    }));
    expect(q(result.db, query)).toBe(change?.rows);
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('updates hidden top-N aux rows without visible row changes and later promotes the updated row', () => {
    const query = pipe(
      from(entry),
      sort(desc(entry.amount), asc(entry.id)),
      limit(2)
    );
    const db = mat(makeDb(), query);

    const hiddenUpdate = tryTransact(db, updateByKey(schema.entries, 'e2', { amount: -1 }));
    const hiddenChange = hiddenUpdate.materializations?.changes[0];

    expect(hiddenUpdate.committed).toBe(true);
    expect(hiddenChange).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
        { id: 'e4', accountId: 'cash', amount: 0, posted: false }
      ],
      added: [],
      removed: [],
      rowChanges: [],
      diagnostics: []
    }));

    const promoted = tryTransact(hiddenUpdate.db, deleteByKey(schema.entries, 'e4'));
    const promotedChange = promoted.materializations?.changes[0];

    expect(promoted.committed).toBe(true);
    expect(promotedChange).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
        { id: 'e2', accountId: 'sales', amount: -1, memo: 'invoice paid', posted: true }
      ],
      added: [{ id: 'e2', accountId: 'sales', amount: -1, memo: 'invoice paid', posted: true }],
      removed: [{ id: 'e4', accountId: 'cash', amount: 0, posted: false }],
      diagnostics: []
    }));
    expect(q(promoted.db, query)).toBe(promotedChange?.rows);
    expect(q(promoted.db, query)).toEqual(q(demat(promoted.db, query), query));
  });

  it('recomputes top-N when the final sort does not include materialized identity', () => {
    const query = pipe(
      from(entry),
      sort(desc(entry.amount)),
      limit(2)
    );
    const reason = 'top-N incremental maintenance requires final sort to include materialized identity';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: reason,
          surface: 'materialization'
        })
      ]
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e3', { amount: 150 }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: reason,
          surface: 'materialization'
        })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('recomputes top-N limits with offsets', () => {
    const query = pipe(
      from(entry),
      sort(asc(entry.id)),
      limit(2, 1)
    );
    const reason = 'top-N incremental maintenance does not support offset';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: reason,
          surface: 'materialization'
        })
      ]
    }));

    const result = tryTransact(db, deleteByKey(schema.entries, 'e1'));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: reason,
          surface: 'materialization'
        })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('recomputes sort-before-project when the projection drops a sort key', () => {
    const query = pipe(
      from(entry),
      where(eq(entry.accountId, value('cash'))),
      sort(asc(entry.amount), asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId })
    );
    const reason = 'sort-before-project requires final projection to preserve sort keys';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: reason,
          surface: 'materialization'
        })
      ]
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: -10 }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: reason,
          surface: 'materialization'
        })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('falls back for non-total final sort ties when an earlier filtered source row enters', () => {
    const query = pipe(
      from(entry),
      where(eq(entry.posted, value(true))),
      sort(asc(entry.amount))
    );
    const db = mat(createDb({
      accounts: makeDb().data.accounts ?? [],
      entries: [
        { id: 'a', accountId: 'cash', amount: 10, posted: false },
        { id: 'b', accountId: 'cash', amount: 10, posted: true },
        { id: 'c', accountId: 'cash', amount: 20, posted: true }
      ]
    }), query);

    const result = tryTransact(db, updateByKey(schema.entries, 'a', { posted: true }));
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      rows: [
        { id: 'a', accountId: 'cash', amount: 10, posted: true },
        { id: 'b', accountId: 'cash', amount: 10, posted: true },
        { id: 'c', accountId: 'cash', amount: 20, posted: true }
      ],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: 'incremental materialization candidate differed from full recompute'
        })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('keeps materialized identity keys distinct for undefined and null values', () => {
    const query = pipe(from(entry), keyBy('memo'));
    const db = mat(createDb({
      accounts: makeDb().data.accounts ?? [],
      entries: [
        { id: 'missing', accountId: 'cash', amount: 1, posted: true },
        { id: 'nullish', accountId: 'cash', amount: 2, memo: null, posted: true }
      ]
    }), query);

    const result = tryTransact(db, updateByKey(schema.entries, 'missing', { amount: 3 }));
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      diagnostics: [],
      rowChanges: [
        {
          kind: 'updated',
          key: '[~undefined]',
          before: { id: 'missing', accountId: 'cash', amount: 1, posted: true },
          after: { id: 'missing', accountId: 'cash', amount: 3, posted: true }
        }
      ]
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('falls back with explicit diagnostics for unsupported incremental shapes', () => {
    const projectedEntries = pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    );
    const cases: readonly { readonly label: string; readonly query: Query<unknown>; readonly reason: string }[] = [
      {
        label: 'aggregate',
        query: entryCount as Query<unknown>,
        reason: 'aggregate incremental maintenance requires non-empty groupBy identity'
      },
      {
        label: 'aggregate projection',
        query: pipe(
          from(entry),
          project({ id: entry.id, total: sum(entry.amount) })
        ) as Query<unknown>,
        reason: 'aggregate projection is not incrementally maintained'
      },
      {
        label: 'non-final sort',
        query: pipe(
          from(entry),
          sort(asc(entry.id)),
          where(eq(entry.accountId, value('cash')))
        ) as Query<unknown>,
        reason: 'non-final sort queries are not incrementally maintained'
      },
      {
        label: 'unsorted limit',
        query: pipe(from(entry), limit(2)) as Query<unknown>,
        reason: 'top-N incremental maintenance requires sorted limit input'
      },
      {
        label: 'join',
        query: pipe(from(entry), join(from(account), eq(entry.accountId, account.id))) as Query<unknown>,
        reason: 'predicate join queries are not incrementally maintained'
      },
      {
        label: 'set operation',
        query: union(
          pipe(projectedEntries, where(eq(entry.accountId, value('cash')))),
          pipe(projectedEntries, where(eq(entry.accountId, value('sales'))))
        ) as Query<unknown>,
        reason: 'set operation queries are not incrementally maintained'
      },
      {
        label: 'expand',
        query: pipe(from(entry), expand(entry.memo, { as: 'tag' })) as Query<unknown>,
        reason: 'expand queries are not incrementally maintained'
      },
      {
        label: 'selected subquery',
        query: pipe(
          from(entry),
          project({ id: entry.id, accounts: sel(from(account)) })
        ) as Query<unknown>,
        reason: 'correlated or selected subqueries are not incrementally maintained'
      },
      {
        label: 'missing row identity',
        query: pipe(from(entry), without('id')) as Query<unknown>,
        reason: 'incremental maintenance requires a stable materialized row identity'
      }
    ];

    for (const item of cases) {
      const explanation = explainMaterialization(item.query);
      expect(explanation, item.label).toEqual(expect.objectContaining({
        supported: false,
        update: 'recomputed',
        recomputed: true,
        reason: item.reason,
        diagnostics: [
          expect.objectContaining({
            code: 'materialization_unsupported',
            message: item.reason,
            surface: 'materialization'
          })
        ]
      }));

      const db = mat(makeDb(), item.query);
      const result = tryTransact(
        db,
        insert(schema.entries, { id: `unsupported-${item.label}`, accountId: 'cash', amount: 9, posted: true })
      );
      const change = result.materializations?.changes[0];

      expect(result.committed).toBe(true);
      expect(change, item.label).toEqual(expect.objectContaining({
        update: 'recomputed',
        recomputed: true,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: 'materialization_unsupported',
            message: item.reason,
            surface: 'materialization'
          })
        ])
      }));
      expect(q(result.db, item.query)).toEqual(q(demat(result.db, item.query), item.query));
    }
  });

  it('falls back to recompute when a keyBy mutation collides with a retained materialized row', () => {
    const query = pipe(from(entry), keyBy('accountId'));
    const db = mat(createDb({
      accounts: [
        { id: 'cash', name: 'Cash', kind: 'asset' },
        { id: 'sales', name: 'Sales', kind: 'income' }
      ],
      entries: [
        { id: 'a', accountId: 'cash', amount: 10, posted: true },
        { id: 'b', accountId: 'sales', amount: 20, posted: true }
      ]
    }), query);

    const result = tryTransact(db, updateByKey(schema.entries, 'b', { accountId: 'cash' }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: 'incremental maintenance cannot add materialized row keys that collide with retained rows: ["cash"]'
        })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
    expect(q(result.db, query)).toEqual([
      { id: 'a', accountId: 'cash', amount: 10, posted: true },
      { id: 'b', accountId: 'cash', amount: 20, posted: true }
    ]);
  });

});
