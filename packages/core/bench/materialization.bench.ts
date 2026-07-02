import { bench, describe } from 'vitest';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import { explainMaterialization, mat } from '@tarstate/core/materialization';
import { asc, eq, from, pipe, project, sort, value, where, type Query } from '@tarstate/core/query';
import { insertOrReplace, type WritePatch } from '@tarstate/core/write';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 5_000;
const PATCH_COUNT = 512;
const BENCH_OPTIONS = {
  time: 300,
  iterations: 20,
  warmupTime: 50,
  warmupIterations: 5
};

const accounts: readonly Account[] = [
  { id: 'cash', name: 'Cash', kind: 'asset' },
  { id: 'sales', name: 'Sales', kind: 'income' },
  { id: 'fees', name: 'Bank fees', kind: 'expense' },
  { id: 'equity', name: 'Owner equity', kind: 'equity' }
];

const filterProject = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
);

const sortedFilterProject = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  sort(asc(entry.amount), asc(entry.id)),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
);

const sortedRows = pipe(
  from(entry),
  sort(asc(entry.amount), asc(entry.id))
);

const shapes: readonly { readonly label: string; readonly query: Query<unknown> }[] = [
  { label: 'filter/project', query: filterProject as Query<unknown> },
  { label: 'filter/project/sort', query: sortedFilterProject as Query<unknown> },
  { label: 'sort', query: sortedRows as Query<unknown> }
];

const patches = makePatches();
let rowSink = 0;

describe('core materialization maintenance', () => {
  for (const shape of shapes) {
    const explanation = explainMaterialization(shape.query);
    const label = `${shape.label} [${explanation.update}]`;

    describe(label, () => {
      bench('materialized maintenance + cached read', materializedMaintenance(shape.query), BENCH_OPTIONS);
      bench('write + full query recompute', fullRecompute(shape.query), BENCH_OPTIONS);
    });
  }
});

function materializedMaintenance(query: Query<unknown>): () => void {
  let db = mat(makeDb(), query);
  let cursor = 0;

  return () => {
    db = transact(db, patchAt(cursor));
    cursor = (cursor + 1) % patches.length;
    consume(q(db, query));
  };
}

function fullRecompute(query: Query<unknown>): () => void {
  let db = makeDb();
  let cursor = 0;

  return () => {
    db = transact(db, patchAt(cursor));
    cursor = (cursor + 1) % patches.length;
    consume(q(db, query));
  };
}

function patchAt(index: number): WritePatch {
  const patch = patches[index % patches.length];
  if (patch === undefined) throw new Error('benchmark patch set is empty');
  return patch;
}

function makeDb(): Db {
  return createDb({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries(ROW_COUNT)
  });
}

function makeEntries(count: number): Entry[] {
  const accountIds = accounts.map((account) => account.id);

  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountIds[index % accountIds.length] ?? 'cash',
    amount: ((index * 37) % 20_000) - 10_000,
    memo: index % 5 === 0 ? null : `memo-${index % 97}`,
    posted: index % 7 !== 0
  }));
}

function makePatches(): readonly WritePatch[] {
  const accountIds = accounts.map((account) => account.id);

  return Array.from({ length: PATCH_COUNT }, (_, index) => {
    const rowIndex = (index * 97) % ROW_COUNT;
    const amount = ((index * 53) % 20_000) - 10_000;
    return insertOrReplace(schema.entries, {
      id: `entry-${rowIndex}`,
      accountId: accountIds[(index + rowIndex) % accountIds.length] ?? 'cash',
      amount,
      memo: index % 3 === 0 ? null : `patch-${index % 101}`,
      posted: index % 11 !== 0
    });
  });
}

function consume(rows: readonly unknown[]): void {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}
