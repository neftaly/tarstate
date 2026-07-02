import { describe, expect, it } from 'vitest';
import { createDb, q, qResult, setEnvTx, transact, tryTransact, type DbTransactionContext } from '@tarstate/core/db';
import { diffRows } from '@tarstate/core/diff';
import {
  demat,
  explainMaterialization,
  index,
  maintainMaterializationSnapshots,
  mat,
  materializedRowsForQuery,
  readMaterializedQuery
} from '@tarstate/core/materialization';
import { trackTransact } from '@tarstate/core/runtime';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { createRuntimeStore, createStore } from '@tarstate/core/store';
import {
  aggregate,
  asc,
  call,
  count,
  env,
  eq,
  expand,
  extend,
  from,
  gte,
  hostFn,
  join,
  keyBy,
  limit,
  pipe,
  project,
  qualify,
  rename,
  sel,
  sort,
  sum,
  union,
  value,
  where,
  without,
  type Query
} from '@tarstate/core/query';
import { type RelationRuntime } from '@tarstate/core/adapter';
import {
  attachWatches,
  diffQuery,
  isWatchMaterialization,
  subscribeWatch,
  transferWatches,
  unwatch,
  watch,
  watchRuntime,
  watchTargetKey
} from '@tarstate/core/watch';
import { deleteByKey, insert, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { account, entry, makeDb, schema, type Entry } from './behavior-fixtures.js';

const entryList = pipe(
  from(entry),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount
  })
);

const cashEntryList = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

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

const firstTwoEntries = pipe(
  from(entry),
  sort(asc(entry.id)),
  limit(2)
);

const entriesByAccountId = pipe(
  from(entry),
  keyBy('accountId')
);

type IncrementalQueryVariant = {
  readonly label: string;
  readonly query: Query<unknown>;
  readonly keyBy: (row: unknown) => unknown;
};

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

const supportedIncrementalVariants: readonly IncrementalQueryVariant[] = [
  {
    label: 'source relation',
    query: from(entry) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'final sort',
    query: pipe(from(entry), sort(asc(entry.amount), asc(entry.id))) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'filtered projection',
    query: pipe(
      from(entry),
      where(gte(entry.amount, value(-75))),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'renamed projection key',
    query: pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      rename({ id: 'entryId' })
    ) as Query<unknown>,
    keyBy: pathKey('entryId')
  },
  {
    label: 'filtered sort-before-project preserving sort keys',
    query: sortedCashEntryProjection as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'qualified rows',
    query: pipe(
      from(entry),
      where(eq(entry.posted, value(true))),
      qualify('entry')
    ) as Query<unknown>,
    keyBy: pathKey('entry', 'id')
  },
  {
    label: 'extended rows without non-key fields',
    query: pipe(
      from(entry),
      extend({ kind: value('ledger-entry') }),
      without('memo')
    ) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'explicit keyBy identity',
    query: pipe(from(entry), keyBy('id')) as Query<unknown>,
    keyBy: pathKey('id')
  }
];

describe('materialization, watch, and store behavior', () => {
  it('maintains materialized queries equivalent to dematerialized evaluation across seeded transaction sequences', () => {
    const queries: readonly Query<unknown>[] = [
      cashEntryProjection as Query<unknown>,
      entryList as Query<unknown>,
      entriesByAccountId as Query<unknown>,
      entryCount as Query<unknown>,
      firstTwoEntries as Query<unknown>
    ];
    let incrementalUpdates = 0;
    let fallbackRecomputes = 0;

    for (const seed of [3, 11, 29, 47, 83]) {
      for (const query of queries) {
        const base = makeDb();
        let db = mat(createDb({ accounts: base.data.accounts ?? [], entries: randomEntries(seed, 7) }), query);
        for (const patch of randomEntryPatches(seed * 97 + query.data.op.length, 24)) {
          const result = tryTransact(db, patch);
          expect(result.committed).toBe(true);
          db = result.db;

          const materializedRows = q(db, query);
          const dematerializedRows = q(demat(db, query), query);
          expect(materializedRows).toEqual(dematerializedRows);

          const change = result.materializations?.changes[0];
          if (change?.update === 'incremental') incrementalUpdates += 1;
          if (change?.update === 'recomputed') {
            expect(change.diagnostics).toEqual(expect.arrayContaining([
              expect.objectContaining({ code: 'materialization_unsupported' })
            ]));
            fallbackRecomputes += 1;
          }
        }
      }
    }

    expect(incrementalUpdates).toBeGreaterThan(0);
    expect(fallbackRecomputes).toBeGreaterThan(0);
    expect(explainMaterialization(cashEntryProjection)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));
    expect(explainMaterialization(entriesByAccountId)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));
    expect(explainMaterialization(entryCount)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported' })
      ])
    }));
  });

  it('fuzzes single-source materializations against dematerialized recompute and row diffs', () => {
    let incrementalChanges = 0;
    let carriedChanges = 0;
    let safetyRecomputes = 0;

    for (const seed of [5, 17, 43, 91, 137]) {
      for (const variant of supportedIncrementalVariants) {
        const base = makeDb();
        let db = mat(createDb({ accounts: base.data.accounts ?? [], entries: randomEntries(seed, 12) }), variant.query);

        for (const patch of randomEntryPatches(seed * 211 + variant.label.length, 36)) {
          const beforeRows = q(db, variant.query);
          const result = tryTransact(db, patch);
          expect(result.committed).toBe(true);
          db = result.db;

          const materializedRows = q(db, variant.query);
          const dematerializedRows = q(demat(db, variant.query), variant.query);
          const change = result.materializations?.changes[0];

          expect(change, `${variant.label} should report maintenance for ${patch.op}`).toBeDefined();
          if (change === undefined) continue;

          expect(materializedRows).toBe(change.rows);
          expect(materializedRows).toEqual(dematerializedRows);
          expect(change.rows).toEqual(dematerializedRows);
          expect(change.previousRows).toEqual(beforeRows);

          if (change.update === 'incremental') {
            const diff = diffRows(beforeRows, dematerializedRows, { keyBy: variant.keyBy });

            incrementalChanges += 1;
            expect(change.recomputed, variant.label).toBe(false);
            expect(change.reason).toBe('incremental delta maintenance');
            expect(change.diagnostics, variant.label).toEqual([]);
            expect(change.rowChanges).toEqual(diff.changes);
            expect(change.added).toEqual(diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []));
            expect(change.removed).toEqual(diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []));
            expect(diff.diagnostics).toEqual([]);
          } else if (change.update === 'carried') {
            carriedChanges += 1;
            expect(change.recomputed, variant.label).toBe(false);
            expect(change.diagnostics, variant.label).toEqual([]);
            expect(change.reason).toBe('dependencies unchanged');
            expect(change.added).toEqual([]);
            expect(change.removed).toEqual([]);
            expect(change.rowChanges).toEqual([]);
          } else {
            safetyRecomputes += 1;
            expect(change.update).toBe('recomputed');
            expect(change.recomputed, `${variant.label} ${patch.op} ${change.reason}`).toBe(true);
            expect(change.diagnostics).toEqual(expect.arrayContaining([
              expect.objectContaining({ code: 'materialization_unsupported' })
            ]));
          }
        }
      }
    }

    expect(incrementalChanges).toBeGreaterThan(0);
    expect(carriedChanges).toBeGreaterThan(0);
    expect(safetyRecomputes).toBeGreaterThan(0);
  });

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
        reason: 'aggregate queries are not incrementally maintained'
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
        label: 'sort and limit',
        query: firstTwoEntries as Query<unknown>,
        reason: 'limit queries require auxiliary pre-limit state and are not incrementally maintained'
      },
      {
        label: 'join',
        query: pipe(from(entry), join(from(account), eq(entry.accountId, account.id))) as Query<unknown>,
        reason: 'join queries are not incrementally maintained'
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

  it('serves materialized query rows from a stable cache until dependencies change', () => {
    const db = mat(makeDb(), cashEntryList);
    const first = q(db, cashEntryList);
    const second = q(db, cashEntryList);

    expect(first).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
    expect(second).toBe(first);
    expect(materializedRowsForQuery(db, cashEntryList)).toBe(first);
    expect(readMaterializedQuery(db, cashEntryList)).toEqual({
      rows: first,
      diagnostics: [],
      materialized: true
    });

    const afterUnrelatedWrite = transact(
      db,
      insert(schema.accounts, { id: 'bank', name: 'Bank', kind: 'asset' })
    );
    expect(q(afterUnrelatedWrite, cashEntryList)).toBe(first);

    const afterEntryWrite = transact(
      afterUnrelatedWrite,
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const changed = q(afterEntryWrite, cashEntryList);

    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e1', amount: 120 },
      { id: 'e4', amount: 0 },
      { id: 'e5', amount: 35 }
    ]);
  });

  it('recomputes materialized rows when maintenance is called without relation deltas', () => {
    const base = makeDb();
    const before = mat(base, cashEntryProjection);
    const after = createDb({
      ...base.data,
      entries: [
        ...(base.data.entries ?? []),
        { id: 'e5', accountId: 'cash', amount: 35, posted: true }
      ]
    });

    const result = maintainMaterializationSnapshots(before, after);

    expect(result.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      rows: [
        { id: 'e1', amount: 120 },
        { id: 'e4', amount: 0 },
        { id: 'e5', amount: 35 }
      ]
    }));
    expect(result.changes[0]?.update).not.toBe('incremental');
  });

  it('bypasses materialized cached rows when query options override env or functions', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.accountId, env<string>('accountId'))),
      sort(asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId })
    );
    const tag = hostFn<string>('test.tag', () => 'base');
    const taggedEntries = pipe(
      from(entry),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        tag: call(tag)
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries, taggedEntries);

    expect(q(db, envFilteredEntries)).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);
    expect(q(db, envFilteredEntries, { env: { accountId: 'sales' } })).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
    expect(qResult(db, taggedEntries).rows[0]).toEqual({ id: 'e1', tag: 'base' });
    expect(qResult(db, taggedEntries, { functions: { 'test.tag': () => 'override' } }).rows[0]).toEqual({ id: 'e1', tag: 'override' });
  });

  it('exposes usable materialization helpers for indexes, watch transfers, and materialization changes', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const indexed = index(rows);
    const watched = attachWatches(makeDb(), entryList);
    const transferred = transferWatches(watched, makeDb());
    const result = tryTransact(mat(makeDb(), cashEntryProjection), insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, posted: true }));

    expect(indexed.rows).toEqual(rows);
    expect(indexed.size).toBe(2);
    expect(indexed.has(rows[0] as { id: string })).toBe(true);
    expect([...indexed.values()]).toEqual(rows);
    expect([...indexed]).toEqual(rows);
    const transferredChanges = await trackTransact(
      transferred,
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, posted: true })
    );
    expect(transferredChanges.changes[0]?.targetKey).toBe(watchTargetKey(entryList));
    expect(isWatchMaterialization(result.materializations?.changes[0])).toBe(true);
    expect(isWatchMaterialization(explainMaterialization(cashEntryProjection))).toBe(false);
  });

  it('refreshes materialized query rows when dependent env values change', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.accountId, env<string>('accountId'))),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        accountId: entry.accountId
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries);
    const first = q(db, envFilteredEntries);

    expect(first).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);

    const next = transact(db, setEnvTx({ accountId: 'sales' }));
    const changed = q(next, envFilteredEntries);

    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('refreshes materialized query rows when dependent non-plain env values are replaced with same-shape values', () => {
    class EnvMarker {
      constructor(readonly label: string) {}
    }

    const envProjectedEntry = pipe(
      from(entry),
      where(eq(entry.id, value('e1'))),
      project({
        id: entry.id,
        stamp: env<Date>('stamp'),
        marker: env<EnvMarker>('marker')
      })
    );
    const firstStamp = new Date('2026-01-01T00:00:00.000Z');
    const firstMarker = new EnvMarker('same-shape');
    const db = mat(createDb(makeDb().data, { env: { stamp: firstStamp, marker: firstMarker } }), envProjectedEntry);
    const first = q(db, envProjectedEntry);

    const nextStamp = new Date('2026-01-01T00:00:00.000Z');
    const nextMarker = new EnvMarker('same-shape');
    const result = tryTransact(db, setEnvTx({ stamp: nextStamp, marker: nextMarker }));
    const changed = q(result.db, envProjectedEntry);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['stamp', 'marker']
    }));
    expect(changed).not.toBe(first);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual(expect.objectContaining({ id: 'e1' }));
    expect((changed[0] as { readonly stamp: Date }).stamp).toBe(nextStamp);
    expect((changed[0] as { readonly marker: EnvMarker }).marker).toBe(nextMarker);
    expect((changed[0] as { readonly stamp: Date }).stamp).not.toBe(firstStamp);
    expect((changed[0] as { readonly marker: EnvMarker }).marker).not.toBe(firstMarker);
  });

  it('does not throw when setEnvTx touches another key while env contains a cyclic object', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.accountId, env<string>('accountId'))),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        accountId: entry.accountId
      })
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash', cyclic } }), envFilteredEntries);

    const result = tryTransact(db, setEnvTx((envValue) => ({ ...envValue, accountId: 'sales' })));
    const changed = q(result.db, envFilteredEntries);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['accountId']
    }));
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('refreshes materialized query rows when setEnvTx mutates env in place', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.accountId, env<string>('accountId'))),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        accountId: entry.accountId
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries);
    const first = q(db, envFilteredEntries);

    const result = tryTransact(db, setEnvTx((envValue) => {
      // @ts-expect-error mutating readonly env verifies runtime change detection for updater callbacks.
      envValue.accountId = 'sales';
      return envValue;
    }));
    const changed = q(result.db, envFilteredEntries);

    expect(first).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);
    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['accountId'],
      rows: [
        { id: 'e2', accountId: 'sales' }
      ],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: 'env dependency changed: accountId'
        })
      ])
    }));
    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('watch refresh and query diffs report added, removed, and unchanged rows', async () => {
    const before = makeDb();
    const after = transact(
      before,
      [
        deleteByKey(schema.entries, 'e2'),
        insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
      ]
    );
    const events: unknown[] = [];
    const handle = watch(before, entryList, (event) => {
      events.push(event);
    }, { label: 'entries' });
    const refresh = await handle.refresh(after);
    const diff = await diffQuery(before, after, entryList);

    const expectedAdded = [{ id: 'e5', accountId: 'cash', amount: 35 }];
    const expectedRemoved = [{ id: 'e2', accountId: 'sales', amount: -120 }];
    const expectedUnchanged = [
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ];

    expect(refresh).toEqual(expect.objectContaining({
      id: 'entries',
      targetKey: watchTargetKey(entryList),
      delivered: true,
      changed: true,
      added: expectedAdded,
      removed: expectedRemoved,
      unchanged: expectedUnchanged,
      diagnostics: []
    }));
    expect(events).toEqual([
      expect.objectContaining({
        changed: true,
        added: expectedAdded,
        removed: expectedRemoved,
        unchanged: expectedUnchanged
      })
    ]);
    expect(diff).toEqual(expect.objectContaining({
      queryKey: watchTargetKey(entryList),
      changed: true,
      added: expectedAdded,
      removed: expectedRemoved,
      unchanged: expectedUnchanged,
      diagnostics: []
    }));

    const subscription = subscribeWatch(handle, (event) => {
      events.push(event);
    });
    expect(subscription.active).toBe(true);
    expect(subscription.unsubscribe()).toEqual({ id: 'entries', unsubscribed: true, diagnostics: [] });
    expect(unwatch(handle)).toEqual({ id: 'entries', closed: true, diagnostics: [] });
  });

  it('trackTransact returns watcher changes for attached targets', async () => {
    const watched = attachWatches(makeDb(), entryList);
    const result = await trackTransact(
      watched,
      deleteByKey(schema.entries, 'e2'),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const targetKey = watchTargetKey(entryList);
    const expectedAdded = [{ id: 'e5', accountId: 'cash', amount: 35 }];
    const expectedRemoved = [{ id: 'e2', accountId: 'sales', amount: -120 }];

    expect(result.supported).toBe(true);
    expect(result.result).toEqual(expect.objectContaining({ committed: true, applied: 2 }));
    expect(result.diagnostics).toEqual([]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        targetKey,
        changed: true,
        added: expectedAdded,
        removed: expectedRemoved,
        unchanged: [
          { id: 'e1', accountId: 'cash', amount: 120 },
          { id: 'e3', accountId: 'fees', amount: -5 },
          { id: 'e4', accountId: 'cash', amount: 0 }
        ]
      })
    ]);
    expect(result.changesByTargetKey.get(targetKey)).toEqual(result.changes[0]);
    expect(result.changesByQueryKey[targetKey]).toEqual(expect.objectContaining({
      targetKey,
      added: expectedAdded,
      removed: expectedRemoved
    }));
    expect(q(result.db, entryList)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 },
      { id: 'e5', accountId: 'cash', amount: 35 }
    ]);
  });

  it('runtime watches subscribe to runtime changes and duplicate labels stay isolated', async () => {
    const runtime = createMemoryRelationRuntime(makeDb().data);
    const runtimeEvents: unknown[] = [];
    const runtimeHandle = watchRuntime(runtime, entryList, (event) => {
      runtimeEvents.push(event);
    }, { label: 'entries-runtime' });

    await runtime.target?.apply([
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    ]);
    await tick();

    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        changed: true,
        added: [{ id: 'e5', accountId: 'cash', amount: 35 }]
      })
    ]);
    expect(runtimeHandle.unwatch()).toEqual({ id: 'entries-runtime', closed: true, diagnostics: [] });

    const db = makeDb();
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const first = watch(db, entryList, (event) => {
      firstEvents.push(event);
    }, { label: 'duplicate' });
    const second = watch(db, entryList, (event) => {
      secondEvents.push(event);
    }, { label: 'duplicate' });
    const after = transact(db, insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 10, memo: 'late', posted: true }));

    expect(first.id).toBe('duplicate');
    expect(second.id).not.toBe(first.id);
    expect(unwatch(first)).toEqual({ id: 'duplicate', closed: true, diagnostics: [] });
    await second.refresh(after);
    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([
      expect.objectContaining({
        added: [{ id: 'e6', accountId: 'cash', amount: 10 }]
      })
    ]);
    expect(unwatch(second).closed).toBe(true);
  });

  it('store query, view, commit, and subscriptions reflect accepted commits', async () => {
    const store = createStore(makeDb());
    const view = store.view(entryList);
    const storeRevisions: number[] = [];
    const viewRevisions: number[] = [];
    const unsubscribeStore = store.subscribe(() => {
      storeRevisions.push(store.getSnapshot().revision);
    });
    const unsubscribeView = view.subscribe(() => {
      viewRevisions.push(view.getSnapshot().revision);
    });

    expect(store.getSnapshot()).toEqual(expect.objectContaining({ revision: 0, diagnostics: [] }));
    expect(store.query(entryList)).toEqual(expect.objectContaining({
      revision: 0,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 }
      ],
      diagnostics: []
    }));
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      revision: 0,
      queryKey: view.queryKey,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 }
      ],
      diagnostics: []
    }));

    const commit = await store.commit(
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );

    expect(commit).toEqual(expect.objectContaining({
      status: 'accepted',
      reflected: true,
      effects: expect.objectContaining({
        patches: 1,
        applied: 1,
        diagnostics: []
      }),
      diagnostics: []
    }));
    expect(commit.snapshot.revision).toBe(1);
    expect(storeRevisions).toEqual([1]);
    expect(viewRevisions).toEqual([1]);
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      revision: 1,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 },
        { id: 'e5', accountId: 'cash', amount: 35 }
      ],
      diagnostics: []
    }));

    unsubscribeView();
    unsubscribeStore();
    await store.commit(
      insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 10, memo: 'late', posted: true })
    );
    expect(storeRevisions).toEqual([1]);
    expect(viewRevisions).toEqual([1]);

    store.close();
    store.close();
  });

  it('runtime store routes original patches, preserves callback semantics, and rejects after close', async () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    const target = inner.target;
    if (target === undefined) throw new Error('memory runtime target missing');
    const routedPatches: (readonly WritePatch[])[] = [];
    const runtime = {
      ...inner,
      target: {
        ...target,
        apply: (patches: readonly WritePatch[]) => {
          routedPatches.push(patches);
          return target.apply(patches);
        }
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const callbackCommit = await store.commit((tx: DbTransactionContext) => {
      expect(q(tx, cashEntryProjection)).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
      return updateByKey(schema.entries, 'e1', { amount: 125 });
    });

    expect(callbackCommit).toEqual(expect.objectContaining({
      status: 'accepted',
      reflected: true,
      effects: expect.objectContaining({
        patches: 1,
        applied: 1,
        diagnostics: []
      }),
      diagnostics: []
    }));
    expect(routedPatches).toEqual([
      [expect.objectContaining({ op: 'updateByKey', key: 'e1' })]
    ]);
    expect(routedPatches[0]?.map((patch) => patch.op)).not.toEqual(['deleteExact', 'insertOrReplace']);

    store.close();
    const closedSnapshot = store.getSnapshot();
    const closedCommit = await store.commit(insert(schema.entries, { id: 'e7', accountId: 'cash', amount: 1, posted: true }));
    expect(closedCommit).toEqual(expect.objectContaining({
      status: 'rejected',
      reflected: false,
      snapshot: closedSnapshot,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'runtime_unsupported', message: 'store is closed' })
      ])
    }));
  });

  it('runtime store keeps its current snapshot when an adapter rejects original patches', async () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    const target = inner.target;
    if (target === undefined) throw new Error('memory runtime target missing');
    const routedPatches: (readonly WritePatch[])[] = [];
    const runtime = {
      ...inner,
      target: {
        ...target,
        apply: (patches: readonly WritePatch[]) => {
          routedPatches.push(patches);
          const version = inner.snapshot?.().version;
          return {
            status: 'rejected' as const,
            patches: patches.length,
            applied: 0 as const,
            deltas: [] as const,
            diagnostics: [{ code: 'adapter_rejected', severity: 'error' as const, message: 'nope' }],
            ...(version === undefined ? {} : { version })
          };
        }
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const before = store.getSnapshot();
    const rejected = await store.commit(updateByKey(schema.entries, 'e1', { amount: 999 }));

    expect(rejected).toEqual(expect.objectContaining({
      status: 'rejected',
      reflected: false,
      snapshot: before,
      diagnostics: [expect.objectContaining({ code: 'adapter_rejected' })]
    }));
    expect(store.getSnapshot()).toEqual(before);
    expect(store.getSnapshot().source).toBe(before.source);
    expect(store.query(cashEntryProjection).rows).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
    expect(routedPatches).toEqual([
      [expect.objectContaining({ op: 'updateByKey', key: 'e1' })]
    ]);
  });
});

function randomEntries(seed: number, countValue: number): Entry[] {
  const next = random(seed);
  const accountIds = ['cash', 'sales', 'fees', 'equity'];
  return Array.from({ length: countValue }, (_, indexValue) => ({
    id: `r${seed}-${indexValue}`,
    accountId: accountIds[Math.floor(next() * accountIds.length)] ?? 'cash',
    amount: Math.floor(next() * 401) - 200,
    memo: next() > 0.66 ? null : `memo-${Math.floor(next() * 20)}`,
    posted: next() > 0.35
  }));
}

function randomEntryPatches(seed: number, countValue: number): WritePatch[] {
  const next = random(seed);
  const accountIds = ['cash', 'sales', 'fees', 'equity'];
  const patches: WritePatch[] = [];
  for (let indexValue = 0; indexValue < countValue; indexValue += 1) {
    const rowValue: Entry = {
      id: `r${seed}-${Math.floor(next() * 10)}`,
      accountId: accountIds[Math.floor(next() * accountIds.length)] ?? 'cash',
      amount: Math.floor(next() * 501) - 250,
      memo: next() > 0.5 ? null : `patch-${indexValue}`,
      posted: next() > 0.25
    };
    const op = Math.floor(next() * 3);
    if (op === 0) patches.push(insertOrReplace(schema.entries, rowValue));
    else if (op === 1) patches.push(updateByKey(schema.entries, rowValue.id, { amount: rowValue.amount, accountId: rowValue.accountId, posted: rowValue.posted }));
    else patches.push(deleteByKey(schema.entries, rowValue.id));
  }
  return patches;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
