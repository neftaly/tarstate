import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact, type Db } from '@tarstate/core/db';
import { demat, index as materializedIndex, mat, type MaterializationRange } from '@tarstate/core/materialization';
import { btree, field, from, hash, pipe, project, uniqueIndex } from '@tarstate/core/query';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, openingAccounts, schema, type Entry } from './behavior-fixtures.js';
import { createSeededRandom } from './fuzz-helpers.js';

type EntryIndexRow = {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly posted: boolean;
};

const accountIds = openingAccounts.map((row) => row.id);
const amountValues = [-80, -21, -5, -1, 0, 1, 7, 7, 18, 42, 95] as const;

const entryRows = pipe(
  from(entry),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount,
    posted: entry.posted
  })
);

const entrySet = entryRows;
const entriesByAccount = pipe(entryRows, hash(field<string>('row', 'accountId')));
const entriesByAmount = pipe(entryRows, btree(field<number>('row', 'amount')));
const entriesById = pipe(entryRows, uniqueIndex(field<string>('row', 'id')));
const indexedQueries = [entrySet, entriesByAccount, entriesByAmount, entriesById] as const;

describe('materialized index API seeded fuzz', () => {
  it('keeps public set/hash/btree/unique snapshots equivalent to scan oracles after writes', () => {
    for (const seed of [13, 29, 47] as const) {
      let db = mat(seededDb(seed), ...indexedQueries);

      for (let step = 0; step < 8; step += 1) {
        const result = tryTransact(db, ...seededWriteBatch(db, seed, step));
        expect(result.committed, `seed ${seed} step ${step} committed`).toBe(true);
        db = result.db;

        assertIndexSnapshots(db, `seed ${seed} step ${step}`);
      }

      const stripped = demat(db, ...indexedQueries);
      for (const query of indexedQueries) {
        expect(materializedIndex(stripped, query), `seed ${seed} demat ${query.data.op}`).toBeUndefined();
      }

      assertIndexSnapshots(mat(stripped, ...indexedQueries), `seed ${seed} remat`);
    }
  });
});

function seededDb(seed: number): Db {
  return createDb({
    accounts: openingAccounts.map((row) => ({ ...row })),
    entries: seededEntries(seed)
  });
}

function seededEntries(seed: number): readonly Entry[] {
  const next = createSeededRandom(seed);
  return Array.from({ length: 18 }, (_, index) => {
    const row: Entry = {
      id: `seed-${seed}-${index}`,
      accountId: pick(accountIds, next),
      amount: pick(amountValues, next),
      posted: next() > 0.35
    };
    if (next() < 0.25) return { ...row, memo: null };
    if (next() < 0.55) return { ...row, memo: `memo-${seed}-${index % 5}` };
    return row;
  });
}

function seededWriteBatch(db: Db, seed: number, step: number): readonly WritePatch[] {
  const next = createSeededRandom((seed * 1_003) + step);
  const rows = q(demat(db), schema.entries);
  if (rows.length === 0 || step % 4 === 1) {
    return [insertOrReplace(schema.entries, seededEntry(seed, step, next))];
  }

  const row = rows[Math.floor(next() * rows.length)];
  if (row === undefined) return [insertOrReplace(schema.entries, seededEntry(seed, step, next))];
  if (step % 4 === 2) {
    return [deleteByKey(schema.entries, row.id)];
  }

  return [updateByKey(schema.entries, row.id, {
    accountId: pick(accountIds, next),
    amount: pick(amountValues, next),
    posted: next() > 0.5
  })];
}

function seededEntry(seed: number, step: number, next: () => number): Entry {
  const row: Entry = {
    id: step % 3 === 0 ? `seed-${seed}-${Math.floor(next() * 18)}` : `seed-${seed}-new-${step}`,
    accountId: pick(accountIds, next),
    amount: pick(amountValues, next),
    posted: next() > 0.2
  };
  return next() < 0.5 ? { ...row, memo: `write-${seed}-${step}` } : row;
}

function assertIndexSnapshots(db: Db, label: string): void {
  const scanDb = demat(db);
  const scanRows = q(scanDb, entryRows);

  const setSnapshot = materializedIndex<EntryIndexRow>(db, entrySet);
  expect(setSnapshot?.op, `${label} set op`).toBe('set');
  if (setSnapshot?.op !== 'set') throw new Error(`${label} missing set snapshot`);
  expect(setSnapshot.rows, `${label} set rows`).toEqual(scanRows);

  const hashSnapshot = materializedIndex<EntryIndexRow>(db, entriesByAccount);
  expect(hashSnapshot?.op, `${label} hash op`).toBe('hash');
  if (hashSnapshot?.op !== 'hash') throw new Error(`${label} missing hash snapshot`);
  expect(hashSnapshot.rows, `${label} hash rows`).toEqual(q(scanDb, entriesByAccount));
  expect(hashSnapshot.field, `${label} hash field`).toBe('accountId');
  expect(hashSnapshot.buckets, `${label} hash buckets`).toEqual(bucketOracle(scanRows, 'accountId'));
  for (const accountId of [...accountIds, 'missing-account']) {
    expect(hashSnapshot.lookup(accountId), `${label} hash lookup ${accountId}`).toEqual(
      scanRows.filter((row) => Object.is(row.accountId, accountId))
    );
  }

  const btreeSnapshot = materializedIndex<EntryIndexRow>(db, entriesByAmount);
  expect(btreeSnapshot?.op, `${label} btree op`).toBe('btree');
  if (btreeSnapshot?.op !== 'btree') throw new Error(`${label} missing btree snapshot`);
  const btreeBuckets = bucketOracle(scanRows, 'amount').sort((left, right) => left.value - right.value);
  expect(btreeSnapshot.rows, `${label} btree rows`).toEqual(q(scanDb, entriesByAmount));
  expect(btreeSnapshot.field, `${label} btree field`).toBe('amount');
  expect(btreeSnapshot.buckets, `${label} btree buckets`).toEqual(btreeBuckets);
  expect(btreeSnapshot.range(), `${label} btree full range`).toEqual(btreeBuckets.flatMap((bucket) => bucket.rows));
  for (const range of rangeCases(scanRows)) {
    expect(btreeSnapshot.range(range), `${label} btree range ${JSON.stringify(range)}`).toEqual(
      btreeBuckets.filter((bucket) => rangeContains(bucket.value, range)).flatMap((bucket) => bucket.rows)
    );
  }

  const uniqueSnapshot = materializedIndex<EntryIndexRow>(db, entriesById);
  expect(uniqueSnapshot?.op, `${label} unique op`).toBe('uniqueIndex');
  if (uniqueSnapshot?.op !== 'uniqueIndex') throw new Error(`${label} missing unique snapshot`);
  expect(uniqueSnapshot.rows, `${label} unique rows`).toEqual(q(scanDb, entriesById));
  expect(uniqueSnapshot.field, `${label} unique field`).toBe('id');
  expect(uniqueSnapshot.buckets, `${label} unique buckets`).toEqual(bucketOracle(scanRows, 'id'));
  for (const row of scanRows.slice(0, 5)) {
    expect(uniqueSnapshot.get(row.id), `${label} unique get ${row.id}`).toEqual(row);
    expect(uniqueSnapshot.lookup(row.id), `${label} unique lookup ${row.id}`).toEqual([row]);
  }
  expect(uniqueSnapshot.get('missing-id'), `${label} unique missing get`).toBeUndefined();
  expect(uniqueSnapshot.lookup('missing-id'), `${label} unique missing lookup`).toEqual([]);
}

function bucketOracle<Row extends Record<Field, string | number>, Field extends keyof Row & string>(
  rows: readonly Row[],
  fieldName: Field
): { readonly value: Row[Field]; readonly rows: readonly Row[] }[] {
  const buckets: { value: Row[Field]; rows: Row[] }[] = [];
  for (const row of rows) {
    const bucket = buckets.find((item) => Object.is(item.value, row[fieldName]));
    if (bucket === undefined) buckets.push({ value: row[fieldName], rows: [row] });
    else bucket.rows.push(row);
  }
  return buckets;
}

function rangeCases(rows: readonly EntryIndexRow[]): readonly MaterializationRange<number>[] {
  const amounts = rows.map((row) => row.amount).sort((left, right) => left - right);
  const low = amounts[Math.floor(amounts.length / 3)] ?? 0;
  const high = amounts[Math.floor((amounts.length * 2) / 3)] ?? low;
  const lower = Math.min(low, high);
  const upper = Math.max(low, high);
  return [
    { lower: { value: lower, inclusive: true } },
    { upper: { value: upper, inclusive: false } },
    {
      lower: { value: lower, inclusive: false },
      upper: { value: upper, inclusive: true }
    },
    {
      lower: { value: upper, inclusive: true },
      upper: { value: lower, inclusive: true }
    }
  ];
}

function rangeContains(value: number, range: MaterializationRange<number>): boolean {
  if (range.lower !== undefined) {
    if (value < range.lower.value || (value === range.lower.value && !range.lower.inclusive)) return false;
  }
  if (range.upper !== undefined) {
    if (value > range.upper.value || (value === range.upper.value && !range.upper.inclusive)) return false;
  }
  return true;
}

function pick<const Value>(values: readonly Value[], next: () => number): Value {
  const value = values[Math.floor(next() * values.length)];
  if (value === undefined) throw new Error('empty seeded value set');
  return value;
}
