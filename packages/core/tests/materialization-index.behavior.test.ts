import { describe, expect, it } from 'vitest';
import { q } from '@tarstate/core/db';
import { demat, index as materializedIndex, mat } from '@tarstate/core/materialization';
import {
  btree,
  field,
  from,
  hash,
  pipe,
  project,
  uniqueIndex
} from '@tarstate/core/query';
import { entry, makeDb } from './behavior-fixtures.js';

type EntryIndexRow = {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly posted: boolean;
};

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
const unavailableAccountIndex = pipe(
  from(entry),
  project({ id: entry.id }),
  hash(field<string>('row', 'accountId'))
);

const ids = (rows: readonly { readonly id: string }[]): readonly string[] => rows.map((row) => row.id);

describe('materialized index API', () => {
  it('returns a set snapshot for materialized non-index queries and undefined for non-materialized queries', () => {
    const plain = makeDb();
    const db = mat(plain, entrySet);

    expect(materializedIndex(plain, entrySet)).toBeUndefined();

    const raw = materializedIndex(db, entrySet);
    expect(raw?.op).toBe('set');
    if (raw?.op !== 'set') throw new Error('expected set index');

    expect(raw.rows).toEqual(q(db, entrySet));
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.rows)).toBe(true);
  });

  it('exposes hash buckets and exact lookup over a materialized hash query', () => {
    const db = mat(makeDb(), entriesByAccount);
    const raw = materializedIndex<EntryIndexRow>(db, entriesByAccount);

    expect(raw?.op).toBe('hash');
    if (raw?.op !== 'hash') throw new Error('expected hash index');

    expect(raw.field).toBe('accountId');
    expect(ids(raw.lookup('cash'))).toEqual(['e1', 'e4']);
    expect(raw.lookup('missing')).toEqual([]);
    expect(raw.buckets.map((bucket) => [bucket.value, ids(bucket.rows)])).toEqual([
      ['cash', ['e1', 'e4']],
      ['sales', ['e2']],
      ['fees', ['e3']]
    ]);
    expect(Object.isFrozen(raw.buckets)).toBe(true);
    expect(Object.isFrozen(raw.buckets[0]?.rows)).toBe(true);
    expect(Object.isFrozen(raw.lookup('cash'))).toBe(true);
  });

  it('exposes btree buckets and range rows in index order', () => {
    const db = mat(makeDb(), entriesByAmount);
    const raw = materializedIndex<EntryIndexRow>(db, entriesByAmount);

    expect(raw?.op).toBe('btree');
    if (raw?.op !== 'btree') throw new Error('expected btree index');

    expect(raw.field).toBe('amount');
    expect(raw.buckets.map((bucket) => bucket.value)).toEqual([-120, -5, 0, 120]);
    expect(ids(raw.range({
      lower: { value: -10, inclusive: true },
      upper: { value: 120, inclusive: false }
    }))).toEqual(['e3', 'e4']);
    expect(ids(raw.range({
      lower: { value: -120, inclusive: false },
      upper: { value: 120, inclusive: true }
    }))).toEqual(['e3', 'e4', 'e1']);
  });

  it('exposes uniqueIndex get and lookup behavior', () => {
    const db = mat(makeDb(), entriesById);
    const raw = materializedIndex<EntryIndexRow>(db, entriesById);

    expect(raw?.op).toBe('uniqueIndex');
    if (raw?.op !== 'uniqueIndex') throw new Error('expected uniqueIndex');

    expect(raw.field).toBe('id');
    expect(raw.get('e2')).toEqual({ id: 'e2', accountId: 'sales', amount: -120, posted: true });
    expect(ids(raw.lookup('e2'))).toEqual(['e2']);
    expect(raw.get('missing')).toBeUndefined();
    expect(raw.lookup('missing')).toEqual([]);
  });

  it('returns undefined after demat and for unavailable declared indexes', () => {
    const db = mat(makeDb(), entriesByAccount, unavailableAccountIndex);

    expect(materializedIndex(demat(db, entriesByAccount), entriesByAccount)).toBeUndefined();
    expect(q(db, unavailableAccountIndex)).toEqual([
      { id: 'e1' },
      { id: 'e2' },
      { id: 'e3' },
      { id: 'e4' }
    ]);
    expect(materializedIndex(db, unavailableAccountIndex)).toBeUndefined();
  });
});
