import { bench, describe } from 'vitest';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import { explainMaterialization, mat, materializationForQuery, materializedSourceFor } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  btree,
  clauses,
  count,
  desc,
  eq,
  field,
  from,
  hash,
  join,
  limit,
  pipe,
  project,
  sort,
  sortLimit,
  sum,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import { type RelationRef } from '@tarstate/core/schema';
import { type RelationSource } from '@tarstate/core/source';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { account, entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 5_000;
const LARGE_ROW_COUNT = 50_000;
const PATCH_COUNT = 512;
const TOP_N_COUNT = 25;
const BENCH_OPTIONS = {
  time: 300,
  iterations: 20,
  warmupTime: 50,
  warmupIterations: 5
};
type BenchmarkMutation = WritePatch | readonly WritePatch[];
type BenchmarkScenario = {
  readonly label: string;
  readonly queries: readonly Query<unknown>[];
  readonly rowCount?: number;
  readonly mutations?: readonly BenchmarkMutation[];
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

const joinedEntryAccounts = pipe(
  from(entry),
  join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
  project({
    entryId: entry.id,
    accountId: account.id,
    entryAccountId: entry.accountId,
    accountName: account.$.name,
    amount: entry.amount
  }),
  sort(asc(field<string>('row', 'entryId')), asc(field<string>('row', 'accountId')))
);

const groupedEntryTotals = pipe(
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

const topEntriesBySortAndLimit = pipe(
  from(entry),
  sort(desc(entry.amount), asc(entry.id)),
  limit(TOP_N_COUNT),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
);

const topEntriesBySortLimit = pipe(
  from(entry),
  sortLimit(TOP_N_COUNT, desc(entry.amount), asc(entry.id)),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
);

const hashIndexedEntries = pipe(
  from(entry),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
  hash(field<string>('row', 'accountId'))
);

const btreeIndexedEntries = pipe(
  from(entry),
  sort(asc(entry.id)),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
  btree(field<number>('row', 'amount'))
);

const patches = makePatches(ROW_COUNT);
const largePatches = makePatches(LARGE_ROW_COUNT);
const mixedBatches = makeMixedBatches(ROW_COUNT);

const scenarios: readonly BenchmarkScenario[] = [
  { label: 'filter/project', queries: [filterProject as Query<unknown>] },
  { label: 'filter/project/sort', queries: [sortedFilterProject as Query<unknown>] },
  { label: 'sort', queries: [sortedRows as Query<unknown>] },
  { label: 'equi-join identity projection', queries: [joinedEntryAccounts as Query<unknown>] },
  { label: 'grouped aggregate count/sum', queries: [groupedEntryTotals as Query<unknown>] },
  { label: 'top-N sort + limit', queries: [topEntriesBySortAndLimit as Query<unknown>] },
  { label: 'top-N sortLimit', queries: [topEntriesBySortLimit as Query<unknown>] },
  {
    label: 'multi-query shared entries relation',
    queries: [
      filterProject as Query<unknown>,
      sortedFilterProject as Query<unknown>,
      sortedRows as Query<unknown>
    ]
  },
  {
    label: 'filter/project mixed transaction batch',
    queries: [filterProject as Query<unknown>],
    mutations: mixedBatches
  },
  {
    label: 'large grouped aggregate count/sum',
    queries: [groupedEntryTotals as Query<unknown>],
    rowCount: LARGE_ROW_COUNT,
    mutations: largePatches
  },
  {
    label: 'large top-N sortLimit',
    queries: [topEntriesBySortLimit as Query<unknown>],
    rowCount: LARGE_ROW_COUNT,
    mutations: largePatches
  }
];

let rowSink = 0;

describe('core materialization maintenance', () => {
  for (const scenario of scenarios) {
    const label = `${scenario.label} [${explainScenario(scenario.queries)}]`;

    describe(label, () => {
      bench('materialized maintenance + cached read', materializedMaintenance(scenario), BENCH_OPTIONS);
      bench('write + full query recompute', fullRecompute(scenario), BENCH_OPTIONS);
    });
  }
});

describe('core materialized source indexes', () => {
  bench('hash lookup by accountId', indexedHashLookup(), BENCH_OPTIONS);
  bench('scan materialized rows by accountId', scannedHashLookup(), BENCH_OPTIONS);
  bench('btree range lookup by amount', indexedRangeLookup(), BENCH_OPTIONS);
  bench('scan materialized rows by amount range', scannedRangeLookup(), BENCH_OPTIONS);
});

function materializedMaintenance(scenario: BenchmarkScenario): () => void {
  let db = mat(makeDb(scenario.rowCount), ...scenario.queries);
  let cursor = 0;
  const mutations = scenario.mutations ?? patches;

  return () => {
    db = transact(db, mutationAt(mutations, cursor));
    cursor = (cursor + 1) % mutations.length;
    consumeQueries(db, scenario.queries);
  };
}

function fullRecompute(scenario: BenchmarkScenario): () => void {
  let db = makeDb(scenario.rowCount);
  let cursor = 0;
  const mutations = scenario.mutations ?? patches;

  return () => {
    db = transact(db, mutationAt(mutations, cursor));
    cursor = (cursor + 1) % mutations.length;
    consumeQueries(db, scenario.queries);
  };
}

function indexedHashLookup(): () => void {
  const { source, relation } = indexedSource(hashIndexedEntries as Query<unknown>);
  const values = accounts.map((row) => row.id);
  let cursor = 0;

  return () => {
    const valueValue = values[cursor % values.length] ?? 'cash';
    cursor += 1;
    consume(source.lookup?.({ relation, field: 'accountId', value: valueValue }) ?? []);
  };
}

function scannedHashLookup(): () => void {
  const { source, relation } = indexedSource(hashIndexedEntries as Query<unknown>);
  const values = accounts.map((row) => row.id);
  let cursor = 0;

  return () => {
    const valueValue = values[cursor % values.length] ?? 'cash';
    cursor += 1;
    consume(source.rows(relation).filter((row) => isRecord(row) && Object.is(row.accountId, valueValue)));
  };
}

function indexedRangeLookup(): () => void {
  const { source, relation } = indexedSource(btreeIndexedEntries as Query<unknown>);
  let cursor = 0;

  return () => {
    const lower = -10_000 + (cursor % 20) * 500;
    const upper = lower + 100;
    cursor += 1;
    consume(source.rangeLookup?.({
      relation,
      field: 'amount',
      lower: { value: lower, inclusive: true },
      upper: { value: upper, inclusive: true }
    }) ?? []);
  };
}

function scannedRangeLookup(): () => void {
  const { source, relation } = indexedSource(btreeIndexedEntries as Query<unknown>);
  let cursor = 0;

  return () => {
    const lower = -10_000 + (cursor % 20) * 500;
    const upper = lower + 100;
    cursor += 1;
    consume(source.rows(relation).filter((row) =>
      isRecord(row)
      && typeof row.amount === 'number'
      && row.amount >= lower
      && row.amount <= upper));
  };
}

function indexedSource(query: Query<unknown>): {
  readonly source: RelationSource;
  readonly relation: RelationRef<Record<string, unknown>>;
} {
  const db = mat(makeDb(), query);
  const source = materializedSourceFor(db);
  const metadata = materializationForQuery(db, query);
  if (source === undefined || metadata === undefined) throw new Error('expected indexed materialized source');
  return {
    source,
    relation: {
      kind: 'relation',
      name: metadata.id,
      key: 'id',
      fields: {},
      ephemeral: true
    }
  };
}

function mutationAt(mutations: readonly BenchmarkMutation[], index: number): BenchmarkMutation {
  const patch = mutations[index % mutations.length];
  if (patch === undefined) throw new Error('benchmark patch set is empty');
  return patch;
}

function explainScenario(queries: readonly Query<unknown>[]): string {
  return queries.map((query) => explainMaterialization(query).update).join(' + ');
}

function makeDb(rowCount = ROW_COUNT): Db {
  return createDb({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries(rowCount)
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

function makePatches(rowCount: number): readonly WritePatch[] {
  const accountIds = accounts.map((account) => account.id);

  return Array.from({ length: PATCH_COUNT }, (_, index) => {
    const rowIndex = (index * 97) % rowCount;
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

function makeMixedBatches(rowCount: number): readonly (readonly WritePatch[])[] {
  const accountIds = accounts.map((account) => account.id);

  return Array.from({ length: PATCH_COUNT }, (_, index) => {
    const rowIndex = (index * 89) % rowCount;
    const accountRow = accountAt(index);
    const accountId = accountIds[(index + rowIndex) % accountIds.length] ?? 'cash';
    const scratchId = `batch-entry-${index % 32}`;
    const deleteScratchId = `batch-entry-${(index + 16) % 32}`;
    const amount = ((index * 71) % 20_000) - 10_000;

    return [
      updateByKey(schema.entries, `entry-${rowIndex}`, {
        amount,
        posted: index % 5 !== 0
      }),
      insertOrReplace(schema.entries, {
        id: scratchId,
        accountId,
        amount: ((index * 113) % 20_000) - 10_000,
        memo: index % 4 === 0 ? null : `batch-${index % 97}`,
        posted: index % 3 !== 0
      }),
      deleteByKey(schema.entries, deleteScratchId),
      updateByKey(schema.accounts, accountRow.id, {
        name: `${accountRow.name} ${index % 13}`
      })
    ];
  });
}

function accountAt(index: number): Account {
  const accountRow = accounts[index % accounts.length];
  if (accountRow === undefined) throw new Error('benchmark account set is empty');
  return accountRow;
}

function consumeQueries(db: Db, queries: readonly Query<unknown>[]): void {
  for (const query of queries) consume(q(db, query));
}

function consume(rows: readonly unknown[]): void {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
