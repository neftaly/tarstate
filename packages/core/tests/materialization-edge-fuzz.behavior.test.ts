import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact, type Db } from '@tarstate/core/db';
import { diffRows, type RowChange, type RowKeySelector } from '@tarstate/core/diff';
import { demat, explainMaterialization, mat } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  avg,
  clauses,
  count,
  desc,
  eq,
  field,
  from,
  join,
  leftJoin,
  limit,
  max,
  min,
  pipe,
  project,
  sort,
  sum,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { account, entry, openingAccounts, schema, type Account, type Entry } from './behavior-fixtures.js';
import { createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';

const aggregateSeeds = resolveFuzzSeeds([0xa661, 0xa662, 0xa663, 0xa664] as const);
const aggregateTransitionSeeds = resolveFuzzSeeds([0xa771, 0xa772, 0xa773] as const);
const topNSeeds = resolveFuzzSeeds([0x70a1, 0x70a2, 0x70a3] as const);
const joinSeeds = resolveFuzzSeeds([0x91f1, 0x91f2, 0x91f3] as const);
const leftJoinSeeds = resolveFuzzSeeds([0x1ef1, 0x1ef2, 0x1ef3] as const);
const sortTieFallbackSeeds = resolveFuzzSeeds([0x5011, 0x5012, 0x5013] as const);

const totalsByAccount = pipe(
  from(entry),
  aggregate({
    groupBy: { accountId: entry.row.accountId },
    aggregates: {
      entryCount: count(),
      postedCount: count(eq(entry.row.posted, value(true))),
      lowest: min(entry.row.amount),
      highest: max(entry.row.amount),
      average: avg(entry.row.amount),
      total: sum(entry.row.amount)
    }
  }),
  sort(asc(field<string>('row', 'accountId')))
) as Query<unknown>;

const topThreeByAmount = pipe(
  from(entry),
  sort(desc(entry.row.amount), asc(entry.row.id)),
  limit(3),
  project({ id: entry.row.id, accountId: entry.row.accountId, amount: entry.row.amount, posted: entry.row.posted })
) as Query<unknown>;

const joinedEntryAccounts = pipe(
  from(entry),
  join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
  project({
    entryId: entry.row.id,
    accountId: account.row.id,
    entryAccountId: entry.row.accountId,
    amount: entry.row.amount,
    accountName: account.row.name
  })
) as Query<unknown>;

const leftJoinedEntryAccounts = pipe(
  from(entry),
  leftJoin(from(account), clauses<Entry, Account>({ accountId: 'id' })),
  project({
    entryId: entry.row.id,
    accountId: account.row.id,
    entryAccountId: entry.row.accountId,
    amount: entry.row.amount,
    accountName: account.row.name
  }),
  sort(asc(field<string>('row', 'entryId')), asc(field<string>('row', 'accountId')))
) as Query<unknown>;

const postedEntriesByAmountTie = pipe(
  from(entry),
  wherePosted(),
  sort(asc(entry.row.amount))
) as Query<unknown>;

const joinedPostedEntriesByAccountNameTie = pipe(
  from(entry),
  join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
  wherePosted(),
  project({
    entryId: entry.row.id,
    accountId: account.row.id,
    entryAccountId: entry.row.accountId,
    amount: entry.row.amount,
    accountName: account.row.name
  }),
  sort(asc(field<string>('row', 'accountName')))
) as Query<unknown>;

describe('materialization edge fuzz behavior', () => {
  it('maintains aggregate edge batches against dematerialized diffRows oracles', () => {
    expect(explainMaterialization(totalsByAccount)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    let changedBatches = 0;
    for (const seed of aggregateSeeds) {
      changedBatches += expectSeededBatches({
        label: `aggregate ${hex(seed)}`,
        seed,
        query: totalsByAccount,
        keyBy: pathKey('accountId'),
        batches: aggregateEdgeBatches(seed)
      });
    }

    expect(changedBatches).toBeGreaterThan(0);
  });

  it('maintains aggregate extrema and averages across seeded group transitions', () => {
    expect(explainMaterialization(totalsByAccount)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    let changedBatches = 0;
    for (const seed of aggregateTransitionSeeds) {
      changedBatches += expectSeededBatches({
        label: `aggregate transitions ${hex(seed)}`,
        seed,
        createDb: aggregateTransitionDb,
        query: totalsByAccount,
        keyBy: pathKey('accountId'),
        batches: aggregateTransitionBatches(seed)
      });
    }

    expect(changedBatches).toBeGreaterThan(0);
  });

  it('maintains top-N order/limit edge batches against dematerialized diffRows oracles', () => {
    expect(explainMaterialization(topThreeByAmount)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    let changedBatches = 0;
    for (const seed of topNSeeds) {
      changedBatches += expectSeededBatches({
        label: `top-N ${hex(seed)}`,
        seed,
        query: topThreeByAmount,
        keyBy: pathKey('id'),
        batches: topNEdgeBatches(seed)
      });
    }

    expect(changedBatches).toBeGreaterThan(0);
  });

  it('promotes hidden top-N aux rows after a later visible removal', () => {
    for (const seed of topNSeeds) {
      let db = mat(edgeDb(seed), topThreeByAmount);

      const hiddenUpdate = expectBatch({
        label: `top-N hidden update ${hex(seed)}`,
        db,
        query: topThreeByAmount,
        keyBy: pathKey('id'),
        batch: [updateByKey(schema.entries, 'e3', { amount: 24 })]
      });
      expect(hiddenUpdate.change.rowChanges, `top-N hidden update ${hex(seed)} row changes`).toEqual([]);
      db = hiddenUpdate.db;

      const promoted = expectBatch({
        label: `top-N hidden promotion ${hex(seed)}`,
        db,
        query: topThreeByAmount,
        keyBy: pathKey('id'),
        batch: [deleteByKey(schema.entries, 'e2')]
      });
      expect(promoted.change.rowChanges, `top-N hidden promotion ${hex(seed)} row changes`).toEqual([
        expect.objectContaining({ kind: 'removed', key: '["e2"]' }),
        expect.objectContaining({ kind: 'added', key: '["e3"]' })
      ]);
    }
  });

  it('maintains join edge batches against dematerialized diffRows oracles', () => {
    expect(explainMaterialization(joinedEntryAccounts)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    let changedBatches = 0;
    for (const seed of joinSeeds) {
      changedBatches += expectSeededBatches({
        label: `join ${hex(seed)}`,
        seed,
        query: joinedEntryAccounts,
        keyBy: joinedEntryAccountKey,
        batches: joinEdgeBatches(seed)
      });
    }

    expect(changedBatches).toBeGreaterThan(0);
  });

  it('maintains seeded left-join matched and unmatched transitions against dematerialized diffRows oracles', () => {
    expect(explainMaterialization(leftJoinedEntryAccounts)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    let changedBatches = 0;
    for (const seed of leftJoinSeeds) {
      changedBatches += expectSeededBatches({
        label: `left join ${hex(seed)}`,
        seed,
        createDb: leftJoinEdgeDb,
        query: leftJoinedEntryAccounts,
        keyBy: joinedEntryAccountKey,
        batches: leftJoinEdgeBatches(seed)
      });
    }

    expect(changedBatches).toBeGreaterThan(0);
  });

  it('falls back for seeded non-total sort tie entrances that change full recompute order', () => {
    for (const seed of sortTieFallbackSeeds) {
      expectFallbackRecompute({
        label: `single-source tie ${hex(seed)}`,
        db: mat(sortTieDb(seed), postedEntriesByAmountTie),
        query: postedEntriesByAmountTie,
        batch: [updateByKey(schema.entries, `tie-${hex(seed)}-a`, { posted: true })]
      });

      expectFallbackRecompute({
        label: `join tie ${hex(seed)}`,
        db: mat(joinSortTieDb(seed), joinedPostedEntriesByAccountNameTie),
        query: joinedPostedEntriesByAccountNameTie,
        batch: [updateByKey(schema.entries, `join-tie-${hex(seed)}-a`, { posted: true })]
      });
    }
  });
});

function expectSeededBatches(input: {
  readonly label: string;
  readonly seed: number;
  readonly createDb?: (seed: number) => Db;
  readonly query: Query<unknown>;
  readonly keyBy: RowKeySelector<unknown>;
  readonly batches: readonly (readonly WritePatch[])[];
}): number {
  let db = mat((input.createDb ?? edgeDb)(input.seed), input.query);
  let changedBatches = 0;

  expect(q(db, input.query), `${input.label} initial rows`).toEqual(q(demat(db, input.query), input.query));

  for (const [index, batch] of input.batches.entries()) {
    const result = expectBatch({
      label: `${input.label} batch ${index}`,
      db,
      query: input.query,
      keyBy: input.keyBy,
      batch
    });
    db = result.db;

    if (result.diff.changes.length > 0) changedBatches += 1;
  }

  return changedBatches;
}

function expectBatch(input: {
  readonly label: string;
  readonly db: Db;
  readonly query: Query<unknown>;
  readonly keyBy: RowKeySelector<unknown>;
  readonly batch: readonly WritePatch[];
}): {
  readonly db: Db;
  readonly beforeRows: readonly unknown[];
  readonly afterRows: readonly unknown[];
  readonly diff: ReturnType<typeof diffRows>;
  readonly change: NonNullable<NonNullable<ReturnType<typeof tryTransact>['materializations']>['changes'][number]>;
} {
  expect(q(input.db, input.query), `${input.label} before rows`).toEqual(q(demat(input.db, input.query), input.query));

  const beforeRows = q(input.db, input.query);
  const result = tryTransact(input.db, input.batch);
  expect(result.committed, `${input.label} committed`).toBe(true);

  const materializedRows = q(result.db, input.query);
  const dematerializedRows = q(demat(result.db, input.query), input.query);
  const expected = diffRows(beforeRows, dematerializedRows, { keyBy: input.keyBy });
  const change = result.materializations?.changes[0];

  expect(expected.diagnostics, `${input.label} oracle diagnostics`).toEqual([]);
  expect(change, `${input.label} materialization change`).toBeDefined();
  if (change === undefined) throw new Error(`${input.label} did not emit a materialization change`);

  expect(change, `${input.label} materialization payload`).toEqual(expect.objectContaining({
    update: 'incremental',
    recomputed: false,
    reason: 'incremental delta maintenance',
    previousRows: beforeRows,
    rows: dematerializedRows,
    rowChanges: expected.changes,
    added: addedRows(expected.changes),
    removed: removedRows(expected.changes),
    diagnostics: []
  }));
  expect(materializedRows, `${input.label} materialized row identity`).toBe(change.rows);
  expect(materializedRows, `${input.label} materialized rows`).toEqual(dematerializedRows);
  expectOneFinalChangePerKey(change.rowChanges, beforeRows, dematerializedRows, input.keyBy, input.label);

  return { db: result.db, beforeRows, afterRows: dematerializedRows, diff: expected, change };
}

function expectFallbackRecompute(input: {
  readonly label: string;
  readonly db: Db;
  readonly query: Query<unknown>;
  readonly batch: readonly WritePatch[];
}): Db {
  const result = tryTransact(input.db, input.batch);
  expect(result.committed, `${input.label} committed`).toBe(true);

  const dematerializedRows = q(demat(result.db, input.query), input.query);
  const change = result.materializations?.changes[0];

  expect(change, `${input.label} materialization change`).toEqual(expect.objectContaining({
    update: 'recomputed',
    recomputed: true,
    rows: dematerializedRows,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        code: 'materialization_unsupported',
        message: 'incremental materialization candidate differed from full recompute'
      })
    ])
  }));
  expect(q(result.db, input.query), `${input.label} materialized rows`).toEqual(dematerializedRows);

  return result.db;
}

function aggregateEdgeBatches(seed: number): readonly (readonly WritePatch[])[] {
  const next = createSeededRandom(seed ^ 0xa660);
  const suffix = hex(seed);
  return Array.from({ length: 5 }, (_, index) => {
    const repeatedId = `e${(index + 1) % 8}`;
    const movedId = `e${(index + 4) % 8}`;
    const insertedId = `agg-${suffix}-${index % 3}`;
    const firstAmount = edgeAmount(next, index, 70);
    const finalAmount = edgeAmount(next, index + 11, 90);
    return [
      updateByKey(schema.entries, repeatedId, { amount: firstAmount, posted: index % 2 === 0 }),
      updateByKey(schema.entries, repeatedId, { amount: finalAmount, posted: index % 2 !== 0 }),
      updateByKey(schema.entries, movedId, {
        accountId: accountIds[(index + 1) % accountIds.length] ?? 'cash',
        amount: finalAmount - 7
      }),
      insertOrReplace(schema.entries, {
        id: insertedId,
        accountId: accountIds[(index + 2) % accountIds.length] ?? 'cash',
        amount: edgeAmount(next, index + 19, 55),
        memo: index % 2 === 0 ? null : `aggregate-${suffix}-${index}`,
        posted: next() > 0.25
      }),
      ...(index % 2 === 0 ? [deleteByKey(schema.entries, `e${(index + 6) % 8}`)] : [])
    ];
  });
}

function aggregateTransitionBatches(seed: number): readonly (readonly WritePatch[])[] {
  const next = createSeededRandom(seed ^ 0xa770);
  const suffix = hex(seed);
  return [
    [
      updateByKey(schema.entries, `agg-${suffix}-cash-low`, { amount: 30 + Math.floor(next() * 5) }),
      updateByKey(schema.entries, `agg-${suffix}-cash-mid`, { amount: -15 - Math.floor(next() * 5), posted: true })
    ],
    [
      deleteByKey(schema.entries, `agg-${suffix}-sales-low`),
      insertOrReplace(schema.entries, {
        id: `agg-${suffix}-sales-new`,
        accountId: 'sales',
        amount: 9 + Math.floor(next() * 7),
        memo: `sales-new-${suffix}`,
        posted: next() > 0.25
      })
    ],
    [
      updateByKey(schema.entries, `agg-${suffix}-cash-high`, {
        accountId: 'sales',
        amount: -20 - Math.floor(next() * 6)
      })
    ],
    [
      deleteByKey(schema.entries, `agg-${suffix}-fees-only`)
    ],
    [
      insertOrReplace(schema.entries, {
        id: `agg-${suffix}-fees-return`,
        accountId: 'fees',
        amount: 4 + Math.floor(next() * 10),
        memo: null,
        posted: true
      }),
      insertOrReplace(schema.entries, {
        id: `agg-${suffix}-equity-new`,
        accountId: 'equity',
        amount: -4 - Math.floor(next() * 10),
        posted: false
      })
    ]
  ];
}

function topNEdgeBatches(seed: number): readonly (readonly WritePatch[])[] {
  const next = createSeededRandom(seed ^ 0x70a0);
  const suffix = hex(seed);
  return [
    [
      updateByKey(schema.entries, 'e4', { amount: 80 + Math.floor(next() * 5) }),
      updateByKey(schema.entries, 'e4', { amount: 18 + Math.floor(next() * 5) })
    ],
    [
      updateByKey(schema.entries, 'e5', { amount: 95 + Math.floor(next() * 5) }),
      updateByKey(schema.entries, 'e1', { amount: -5 - Math.floor(next() * 5) })
    ],
    [
      insertOrReplace(schema.entries, {
        id: `top-${suffix}-a`,
        accountId: 'cash',
        amount: 31,
        memo: `top-${suffix}`,
        posted: true
      }),
      updateByKey(schema.entries, `top-${suffix}-a`, { amount: 24 + Math.floor(next() * 3) }),
      updateByKey(schema.entries, 'e2', { amount: 24 + Math.floor(next() * 3) })
    ],
    [
      deleteByKey(schema.entries, 'e0'),
      updateByKey(schema.entries, 'e6', { amount: 90 + Math.floor(next() * 5) }),
      updateByKey(schema.entries, 'e6', { amount: 12 + Math.floor(next() * 5) })
    ],
    [
      insertOrReplace(schema.entries, {
        id: `top-${suffix}-b`,
        accountId: 'fees',
        amount: 88 + Math.floor(next() * 5),
        memo: null,
        posted: false
      }),
      updateByKey(schema.entries, 'e3', { amount: 27 + Math.floor(next() * 4) }),
      updateByKey(schema.entries, `top-${suffix}-b`, { posted: true })
    ]
  ];
}

function joinEdgeBatches(seed: number): readonly (readonly WritePatch[])[] {
  const next = createSeededRandom(seed ^ 0x91f0);
  const suffix = hex(seed);
  const bankId = `bank-${suffix}`;
  return [
    [
      updateByKey(schema.entries, 'e0', { amount: 40 + Math.floor(next() * 10) }),
      updateByKey(schema.entries, 'e0', { amount: 45 + Math.floor(next() * 10) }),
      updateByKey(schema.accounts, 'cash', { name: `Cash ${suffix}-a` })
    ],
    [
      updateByKey(schema.entries, 'e1', { accountId: 'fees' }),
      updateByKey(schema.accounts, 'fees', { name: `Fees ${suffix}-b` })
    ],
    [
      insertOrReplace(schema.accounts, { id: bankId, name: `Bank ${suffix}`, kind: 'asset' }),
      insertOrReplace(schema.entries, {
        id: `join-${suffix}-a`,
        accountId: bankId,
        amount: 60 + Math.floor(next() * 20),
        memo: `join-${suffix}`,
        posted: true
      }),
      updateByKey(schema.accounts, bankId, { name: `Bank ${suffix} settled` })
    ],
    [
      updateByKey(schema.entries, 'e4', { accountId: bankId, amount: 30 + Math.floor(next() * 10) })
    ],
    [
      deleteByKey(schema.accounts, 'fees'),
      updateByKey(schema.entries, 'e1', { accountId: 'equity' })
    ]
  ];
}

function leftJoinEdgeBatches(seed: number): readonly (readonly WritePatch[])[] {
  const next = createSeededRandom(seed ^ 0x1ef0);
  const suffix = hex(seed);
  const pendingId = `pending-${suffix}`;
  const futureId = `future-${suffix}`;
  const lateId = `late-${suffix}`;
  return [
    [
      insertOrReplace(schema.accounts, { id: pendingId, name: `Pending ${suffix}`, kind: 'asset' })
    ],
    [
      updateByKey(schema.accounts, pendingId, { name: `Pending ${suffix} renamed`, kind: 'liability' })
    ],
    [
      deleteByKey(schema.accounts, pendingId)
    ],
    [
      insertOrReplace(schema.accounts, { id: futureId, name: `Future ${suffix}`, kind: 'asset' })
    ],
    [
      updateByKey(schema.entries, `lj-${suffix}-future`, {
        accountId: 'cash',
        amount: 40 + Math.floor(next() * 10)
      })
    ],
    [
      insertOrReplace(schema.entries, {
        id: `lj-${suffix}-late`,
        accountId: lateId,
        amount: 12 + Math.floor(next() * 10),
        memo: `late-${suffix}`,
        posted: true
      })
    ],
    [
      insertOrReplace(schema.accounts, { id: lateId, name: `Late ${suffix}`, kind: 'income' })
    ]
  ];
}

function aggregateTransitionDb(seed: number): Db {
  const suffix = hex(seed);
  const next = createSeededRandom(seed ^ 0xa771);
  const shift = Math.floor(next() * 4);
  return createDb({
    accounts: openingAccounts.map((row) => ({ ...row })),
    entries: [
      { id: `agg-${suffix}-cash-low`, accountId: 'cash', amount: 3 + shift, posted: true },
      { id: `agg-${suffix}-cash-mid`, accountId: 'cash', amount: 10 + shift, posted: false },
      { id: `agg-${suffix}-cash-high`, accountId: 'cash', amount: 17 + shift, posted: true },
      { id: `agg-${suffix}-sales-low`, accountId: 'sales', amount: -2 - shift, posted: true },
      { id: `agg-${suffix}-sales-high`, accountId: 'sales', amount: 8 + shift, posted: false },
      { id: `agg-${suffix}-fees-only`, accountId: 'fees', amount: 5 + shift, memo: null, posted: true }
    ] satisfies readonly Entry[]
  });
}

function leftJoinEdgeDb(seed: number): Db {
  const suffix = hex(seed);
  return createDb({
    accounts: openingAccounts.map((row) => ({ ...row })),
    entries: [
      { id: `lj-${suffix}-cash`, accountId: 'cash', amount: 10, posted: true },
      { id: `lj-${suffix}-pending`, accountId: `pending-${suffix}`, amount: 20, posted: true },
      { id: `lj-${suffix}-future`, accountId: `future-${suffix}`, amount: -5, posted: false },
      { id: `lj-${suffix}-fees`, accountId: 'fees', amount: 5, posted: true }
    ] satisfies readonly Entry[]
  });
}

function sortTieDb(seed: number): Db {
  const suffix = hex(seed);
  const amount = 10 + seed % 5;
  return createDb({
    accounts: openingAccounts.map((row) => ({ ...row })),
    entries: [
      { id: `tie-${suffix}-a`, accountId: 'cash', amount, posted: false },
      { id: `tie-${suffix}-b`, accountId: 'cash', amount, posted: true },
      { id: `tie-${suffix}-c`, accountId: 'fees', amount: amount + 10, posted: true },
      { id: `tie-${suffix}-d`, accountId: 'sales', amount: amount - 5, posted: true }
    ] satisfies readonly Entry[]
  });
}

function joinSortTieDb(seed: number): Db {
  const suffix = hex(seed);
  return createDb({
    accounts: [
      { id: 'cash', name: `Cash ${suffix}`, kind: 'asset' },
      { id: 'fees', name: `Fees ${suffix}`, kind: 'expense' }
    ] satisfies readonly Account[],
    entries: [
      { id: `join-tie-${suffix}-a`, accountId: 'cash', amount: 10, posted: false },
      { id: `join-tie-${suffix}-b`, accountId: 'cash', amount: 20, posted: true },
      { id: `join-tie-${suffix}-c`, accountId: 'fees', amount: 30, posted: true }
    ] satisfies readonly Entry[]
  });
}

function edgeDb(seed: number): Db {
  const next = createSeededRandom(seed);
  return createDb({
    accounts: openingAccounts.map((row) => ({ ...row })),
    entries: Array.from({ length: 8 }, (_, index): Entry => ({
      id: `e${index}`,
      accountId: accountIds[index % accountIds.length] ?? 'cash',
      amount: [35, 25, 25, 15, 5, 0, -5, -15][index] ?? edgeAmount(next, index, 40),
      memo: index % 3 === 0 ? null : `edge-${hex(seed)}-${index}`,
      posted: index % 2 === 0 || next() > 0.35
    }))
  });
}

const accountIds = ['cash', 'sales', 'fees', 'equity'] as const;

function wherePosted() {
  return where(eq(entry.row.posted, value(true)));
}

function pathKey(...path: readonly string[]): RowKeySelector<unknown> {
  return (row) => {
    let current: unknown = row;
    for (const segment of path) {
      if (!isRecord(current)) return [undefined];
      current = current[segment];
    }
    return [current];
  };
}

function joinedEntryAccountKey(row: unknown): readonly unknown[] {
  return isRecord(row) ? [row.entryId, row.accountId] : [undefined, undefined];
}

function expectOneFinalChangePerKey<Row>(
  changes: readonly RowChange<Row>[],
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  keyBy: RowKeySelector<Row>,
  label: string
): void {
  const keys = changes.map((change) => change.key);
  expect(new Set(keys).size, `${label} coalesced change keys`).toBe(keys.length);

  const beforeByKey = rowsByDiffKey(beforeRows, keyBy);
  const afterByKey = rowsByDiffKey(afterRows, keyBy);

  for (const change of changes) {
    if (change.kind === 'added') {
      expect(beforeByKey.has(change.key), `${label} added ${change.key} was absent before`).toBe(false);
      expect(change.row, `${label} added ${change.key} final row`).toEqual(afterByKey.get(change.key));
    } else if (change.kind === 'removed') {
      expect(change.row, `${label} removed ${change.key} original row`).toEqual(beforeByKey.get(change.key));
      expect(afterByKey.has(change.key), `${label} removed ${change.key} is absent after`).toBe(false);
    } else {
      expect(change.before, `${label} updated ${change.key} original row`).toEqual(beforeByKey.get(change.key));
      expect(change.after, `${label} updated ${change.key} final row`).toEqual(afterByKey.get(change.key));
    }
  }
}

function rowsByDiffKey<Row>(rows: readonly Row[], keyBy: RowKeySelector<Row>): Map<string, Row> {
  return new Map(rows.map((row) => {
    const change = diffRows([], [row], { keyBy }).changes[0];
    if (change === undefined) throw new Error('expected diffRows to produce a key for row');
    return [change.key, row] as const;
  }));
}

function addedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
}

function removedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
}

function edgeAmount(next: () => number, index: number, spread: number): number {
  const sign = index % 2 === 0 ? 1 : -1;
  return sign * Math.floor(next() * spread);
}

function hex(seed: number): string {
  return `0x${seed.toString(16)}`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
