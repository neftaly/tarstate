import { describe, expect, it } from 'vitest';
import { check, constrain, fk, req, unique, validateConstraints, type ConstraintSet } from '@tarstate/core/constraints';
import { q, tryTransact, type Db } from '@tarstate/core/db';
import { index as materializedIndex, mat, materializationsFor, type MaterializedIndex } from '@tarstate/core/materialization';
import { asc, eq, field, from, gt, hash, pipe, project, sort, value, where } from '@tarstate/core/query';
import { deleteByKey, deleteRows, insert, updateByKey, type WritePatch } from '@tarstate/core/write';
import { accountsById, entry, entriesById, makeDb, schema, type Account, type Entry } from './behavior-fixtures.js';
import { chooseSeeded, createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';

type EntryIndexRow = Pick<Entry, 'id' | 'accountId' | 'amount' | 'posted'>;
type FuzzTransaction = {
  readonly label: string;
  readonly patches: readonly WritePatch[];
};
type Random = {
  readonly int: (exclusiveMax: number) => number;
  readonly bool: (probability?: number) => boolean;
  readonly pick: <Value>(values: readonly Value[]) => Value;
};

const STEPS_PER_SEED = 30;
const seeds = resolveFuzzSeeds([0xc011, 0xc012, 0xc013, 0xc014, 0xc015] as const);
const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const satisfies readonly Account['kind'][];
const transactionActions = [
  'insert-entry-valid',
  'insert-entry-duplicate',
  'insert-entry-orphan',
  'insert-entry-too-low',
  'insert-entry-missing-required',
  'update-entry-valid',
  'update-entry-orphan',
  'update-entry-too-low',
  'delete-entry',
  'delete-used-account',
  'insert-account-valid',
  'insert-account-duplicate',
  'valid-account-entry-pair',
  'invalid-prefix-rollback',
  'delete-account-after-entries'
] as const;

const constrainedEntries = constrain(
  req(schema.entries, 'id', 'accountId', 'amount', 'posted'),
  unique(schema.accounts, 'id'),
  unique(schema.entries, 'id'),
  fk(schema.entries, 'accountId', schema.accounts, 'id'),
  check(from(entry), gt(field<number>('entry', 'amount'), value(-1_000_000)))
) satisfies ConstraintSet;

const postedEntriesById = pipe(
  from(entry),
  where(eq(entry.posted, value(true))),
  sort(asc(entry.id)),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted })
);
const entryRows = pipe(
  from(entry),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted })
);
const entriesByAccount = pipe(entryRows, hash(field<string>('row', 'accountId')));

describe('constraint seeded fuzz behavior', () => {
  it.each(seeds)('preserves constraint invariants for seed %i', async (seed) => {
    const rng = createRandom(seed);
    let db = makeConstrainedDb();
    let replay = makeConstrainedDb();
    let accepted = 0;
    let rejected = 0;

    await expectConstraintsValid(db, `seed ${seed} initial`);

    for (let step = 0; step < STEPS_PER_SEED; step += 1) {
      const transaction = fuzzTransaction(db, rng, seed, step);
      const label = `seed ${seed} step ${step} ${transaction.label}`;
      const before = snapshotDb(db);
      const replayBefore = snapshotDb(replay);
      const result = tryTransact(db, transaction.patches);

      if (result.committed) {
        accepted += 1;
        expect(result.diagnostics, `${label} diagnostics`).toEqual([]);

        const replayResult = tryTransact(replay, transaction.patches);
        expect(replayResult.committed, `${label} replay committed`).toBe(true);
        expect(replayResult.diagnostics, `${label} replay diagnostics`).toEqual([]);

        db = result.db;
        replay = replayResult.db;
        await expectConstraintsValid(db, label);
        expect(snapshotDb(db), `${label} replay snapshot`).toEqual(snapshotDb(replay));
      } else {
        rejected += 1;
        expect(result.db, `${label} rejected db identity`).toBe(db);
        expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), `${label} rejected diagnostics`).toBe(true);
        expect(snapshotDb(result.db), `${label} rejected snapshot`).toEqual(before);
        expect(snapshotDb(replay), `${label} replay unchanged`).toEqual(replayBefore);
      }
    }

    expect(accepted, `seed ${seed} accepted transactions`).toBeGreaterThan(0);
    expect(rejected, `seed ${seed} rejected transactions`).toBeGreaterThan(0);
    expect(snapshotDb(db), `seed ${seed} final replay`).toEqual(snapshotDb(replay));
  });
});

function makeConstrainedDb(): Db {
  return mat(makeDb(), constrainedEntries, accountsById, entriesById, postedEntriesById, entriesByAccount);
}

async function expectConstraintsValid(db: Db, label: string): Promise<void> {
  const validation = await validateConstraints(db, constrainedEntries);
  expect(validation.valid, `${label} constraints valid`).toBe(true);
  expect(validation.diagnostics, `${label} constraint diagnostics`).toEqual([]);
}

function snapshotDb(db: Db): unknown {
  const accountIndex = materializedIndex<EntryIndexRow>(db, entriesByAccount);
  return {
    data: {
      accounts: cloneRows(q(db, accountsById)),
      entries: cloneRows(q(db, entriesById))
    },
    views: {
      accountsById: cloneRows(q(db, accountsById)),
      entriesById: cloneRows(q(db, entriesById)),
      postedEntriesById: cloneRows(q(db, postedEntriesById)),
      entriesByAccount: cloneRows(q(db, entriesByAccount))
    },
    indexes: {
      entriesByAccount: hashIndexSnapshot(accountIndex)
    },
    materialized: materializationsFor(db).map((metadata) => ({
      id: metadata.id,
      mode: metadata.mode,
      queryKey: metadata.queryKey
    }))
  };
}

function hashIndexSnapshot(indexValue: MaterializedIndex<EntryIndexRow> | undefined): unknown {
  if (indexValue === undefined) return undefined;
  if (indexValue.op !== 'hash') return { op: indexValue.op, rows: cloneRows(indexValue.rows) };
  return {
    op: indexValue.op,
    field: indexValue.field,
    rows: cloneRows(indexValue.rows),
    buckets: indexValue.buckets.map((bucket) => ({
      value: bucket.value,
      rows: cloneRows(bucket.rows)
    })),
    cash: cloneRows(indexValue.lookup('cash')),
    missing: cloneRows(indexValue.lookup('missing'))
  };
}

function fuzzTransaction(db: Db, rng: Random, seed: number, step: number): FuzzTransaction {
  const action = transactionActions[step % transactionActions.length] ?? transactionActions[0];
  switch (action) {
    case 'insert-entry-valid':
      return { label: action, patches: validEntryInsertPatches(db, rng, seed, step, 'entry') };
    case 'insert-entry-duplicate':
      return { label: action, patches: [insert(schema.entries, duplicateEntry(db, rng, seed, step))] };
    case 'insert-entry-orphan':
      return { label: action, patches: [insert(schema.entries, entryRow(seed, step, 'orphan', missingAccountId(seed, step), validAmount(rng)))] };
    case 'insert-entry-too-low':
      return { label: action, patches: [insert(schema.entries, entryRow(seed, step, 'too-low', existingAccountId(db, rng) ?? 'cash', tooLowAmount(rng)))] };
    case 'insert-entry-missing-required':
      return { label: action, patches: [insert(schema.entries, missingRequiredEntry(db, rng, seed, step) as never)] };
    case 'update-entry-valid': {
      const rowValue = existingEntry(db, rng);
      if (rowValue === undefined) return { label: `${action}:fallback`, patches: validEntryInsertPatches(db, rng, seed, step, 'update-fallback') };
      return {
        label: action,
        patches: [updateByKey(schema.entries, rowValue.id, {
          accountId: existingAccountId(db, rng) ?? rowValue.accountId,
          amount: validAmount(rng),
          posted: rng.bool()
        })]
      };
    }
    case 'update-entry-orphan': {
      const rowValue = existingEntry(db, rng);
      if (rowValue === undefined) return { label: `${action}:fallback`, patches: [insert(schema.entries, entryRow(seed, step, 'update-orphan', missingAccountId(seed, step), validAmount(rng)))] };
      return { label: action, patches: [updateByKey(schema.entries, rowValue.id, { accountId: missingAccountId(seed, step) })] };
    }
    case 'update-entry-too-low': {
      const rowValue = existingEntry(db, rng);
      if (rowValue === undefined) return { label: `${action}:fallback`, patches: [insert(schema.entries, entryRow(seed, step, 'update-low', existingAccountId(db, rng) ?? 'cash', tooLowAmount(rng)))] };
      return { label: action, patches: [updateByKey(schema.entries, rowValue.id, { amount: tooLowAmount(rng) })] };
    }
    case 'delete-entry': {
      const rowValue = existingEntry(db, rng);
      return { label: action, patches: [deleteByKey(schema.entries, rowValue?.id ?? freshEntryId(seed, step, 'missing-delete'))] };
    }
    case 'delete-used-account':
      return { label: action, patches: [deleteByKey(schema.accounts, usedAccountId(db, rng) ?? 'cash')] };
    case 'insert-account-valid':
      return { label: action, patches: [insert(schema.accounts, accountRow(seed, step, 'fresh', rng))] };
    case 'insert-account-duplicate':
      return { label: action, patches: [insert(schema.accounts, duplicateAccount(db, rng, seed, step))] };
    case 'valid-account-entry-pair': {
      const accountValue = accountRow(seed, step, 'pair', rng);
      return { label: action, patches: [insert(schema.accounts, accountValue), insert(schema.entries, entryRow(seed, step, 'pair', accountValue.id, validAmount(rng)))] };
    }
    case 'invalid-prefix-rollback': {
      const accountValue = accountRow(seed, step, 'rollback', rng);
      return { label: action, patches: [insert(schema.accounts, accountValue), insert(schema.entries, entryRow(seed, step, 'rollback-orphan', missingAccountId(seed, step), validAmount(rng)))] };
    }
    case 'delete-account-after-entries': {
      const accountId = usedAccountId(db, rng) ?? existingAccountId(db, rng) ?? 'cash';
      return { label: action, patches: [deleteRows(schema.entries, eq(entry.accountId, value(accountId))), deleteByKey(schema.accounts, accountId)] };
    }
    default:
      return action satisfies never;
  }
}

function validEntryInsertPatches(db: Db, rng: Random, seed: number, step: number, suffix: string): readonly WritePatch[] {
  const accountId = existingAccountId(db, rng);
  if (accountId !== undefined) return [insert(schema.entries, entryRow(seed, step, suffix, accountId, validAmount(rng)))];

  const accountValue = accountRow(seed, step, `${suffix}-account`, rng);
  return [
    insert(schema.accounts, accountValue),
    insert(schema.entries, entryRow(seed, step, suffix, accountValue.id, validAmount(rng)))
  ];
}

function duplicateEntry(db: Db, rng: Random, seed: number, step: number): Entry {
  const rowValue = existingEntry(db, rng);
  if (rowValue === undefined) return entryRow(seed, step, 'duplicate-fallback', missingAccountId(seed, step), validAmount(rng));
  return {
    ...entryRow(seed, step, 'duplicate', existingAccountId(db, rng) ?? rowValue.accountId, validAmount(rng)),
    id: rowValue.id
  };
}

function duplicateAccount(db: Db, rng: Random, seed: number, step: number): Account {
  const rowValue = existingAccount(db, rng);
  if (rowValue === undefined) return accountRow(seed, step, 'duplicate-fallback', rng);
  return {
    ...accountRow(seed, step, 'duplicate', rng),
    id: rowValue.id
  };
}

function missingRequiredEntry(db: Db, rng: Random, seed: number, step: number): Omit<Entry, 'amount'> {
  return {
    id: freshEntryId(seed, step, 'missing-required'),
    accountId: existingAccountId(db, rng) ?? 'cash',
    posted: rng.bool()
  };
}

function entryRow(seed: number, step: number, suffix: string, accountId: string, amount: number): Entry {
  return {
    id: freshEntryId(seed, step, suffix),
    accountId,
    amount,
    memo: step % 3 === 0 ? null : `fuzz-${seedLabel(seed)}-${step}-${suffix}`,
    posted: step % 2 === 0
  };
}

function accountRow(seed: number, step: number, suffix: string, rng: Random): Account {
  const id = freshAccountId(seed, step, suffix);
  return {
    id,
    name: `Account ${seedLabel(seed)} ${step} ${suffix}`,
    kind: rng.pick(accountKinds)
  };
}

function existingEntry(db: Db, rng: Random): Entry | undefined {
  return pickOptional(q(db, entriesById), rng);
}

function existingAccount(db: Db, rng: Random): Account | undefined {
  return pickOptional(q(db, accountsById), rng);
}

function existingAccountId(db: Db, rng: Random): string | undefined {
  return existingAccount(db, rng)?.id;
}

function usedAccountId(db: Db, rng: Random): string | undefined {
  return pickOptional(q(db, entriesById), rng)?.accountId;
}

function pickOptional<Value>(values: readonly Value[], rng: Random): Value | undefined {
  return values.length === 0 ? undefined : rng.pick(values);
}

function validAmount(rng: Random): number {
  return rng.int(4_000) - 2_000;
}

function tooLowAmount(rng: Random): number {
  return -1_000_001 - rng.int(1_000);
}

function missingAccountId(seed: number, step: number): string {
  return `missing-account-${seedLabel(seed)}-${step}`;
}

function freshEntryId(seed: number, step: number, suffix: string): string {
  return `fuzz-entry-${seedLabel(seed)}-${step}-${suffix}`;
}

function freshAccountId(seed: number, step: number, suffix: string): string {
  return `fuzz-account-${seedLabel(seed)}-${step}-${suffix}`;
}

function seedLabel(seed: number): string {
  return seed.toString(16);
}

function createRandom(seed: number): Random {
  const next = createSeededRandom(seed);
  const int = (exclusiveMax: number): number => {
    if (exclusiveMax <= 0) throw new Error('cannot choose from an empty range');
    return Math.floor(next() * exclusiveMax);
  };
  return {
    int,
    bool: (probability = 0.5) => next() < probability,
    pick: <Value>(values: readonly Value[]): Value => chooseSeeded(next, values)
  };
}

function cloneRows<Row extends object>(rows: readonly Row[]): readonly Row[] {
  return rows.map((rowValue) => ({ ...rowValue }));
}
