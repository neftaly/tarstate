import { afterAll, bench, describe } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import {
  aggregate,
  asc,
  count,
  desc,
  eq,
  field,
  from,
  gte,
  pipe,
  project,
  sort,
  sortLimit,
  sum,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import { type RelationSource } from '@tarstate/core/source';
import { mat } from '@tarstate/core/materialization';
import { updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNTS = [1_000, 10_000, 100_000] as const;
const ACCOUNT_COUNT = 128;
const SCAN_VARIANT_COUNT = 12;
const LOOKUP_VARIANT_COUNT = 12;
const PATCH_COUNT = 128;
const TOP_N_COUNT = 25;
const BENCH_OPTIONS = {
  time: 120,
  iterations: 6,
  warmupTime: 20,
  warmupIterations: 1
};

type RowCount = typeof ROW_COUNTS[number];
type MaintenanceMode = 'materialized' | 'recompute';
type CurveNote = {
  readonly shape: string;
  readonly rows: RowCount;
  readonly lowerBoundTouchedRows: string;
  readonly expectedRowsRead: string;
};

const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const;
const accounts: readonly Account[] = Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
  id: `account-${index}`,
  name: `Account ${index}`,
  kind: accountKinds[index % accountKinds.length] ?? 'asset'
}));
const accountIds = accounts.map((row) => row.id);

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

const topEntries = pipe(
  from(entry),
  sortLimit(TOP_N_COUNT, desc(entry.amount), asc(entry.id)),
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
);

const curveNotes: CurveNote[] = [];
let rowSink = 0;

describe('core scaling curves: query evaluation', () => {
  for (const rowCount of ROW_COUNTS) {
    const rows = makeEntries(rowCount);
    const indexed = indexedSource(rows);
    const scanQueries = makeScanQueries();
    const lookupQueries = makeLookupQueries();

    curveNotes.push({
      shape: 'scan query',
      rows: rowCount,
      lowerBoundTouchedRows: `${rowCount.toLocaleString()} scanned rows`,
      expectedRowsRead: `${Math.round(rowCount / 2).toLocaleString()} selected rows`
    });
    curveNotes.push({
      shape: 'lookup pushdown',
      rows: rowCount,
      lowerBoundTouchedRows: `${Math.ceil(rowCount / ACCOUNT_COUNT).toLocaleString()} bucket rows`,
      expectedRowsRead: `${Math.ceil(rowCount / ACCOUNT_COUNT).toLocaleString()} selected rows`
    });

    describe(`${rowCount.toLocaleString()} rows`, () => {
      bench('scan query where/project', evaluateQueries(indexed, scanQueries), BENCH_OPTIONS);
      bench('lookup pushdown where/project', evaluateQueries(indexed, lookupQueries), BENCH_OPTIONS);
    });
  }
});

describe('core scaling curves: materialized maintenance', () => {
  for (const rowCount of ROW_COUNTS) {
    const patches = makePatches(rowCount);

    curveNotes.push({
      shape: 'grouped aggregate materialized maintenance',
      rows: rowCount,
      lowerBoundTouchedRows: '1 affected group plus changed row',
      expectedRowsRead: `${ACCOUNT_COUNT.toLocaleString()} cached aggregate rows`
    });
    curveNotes.push({
      shape: 'top-N materialized maintenance',
      rows: rowCount,
      lowerBoundTouchedRows: `${TOP_N_COUNT.toLocaleString()} visible rows plus changed row`,
      expectedRowsRead: `${TOP_N_COUNT.toLocaleString()} cached top rows`
    });

    describe(`${rowCount.toLocaleString()} rows`, () => {
      describe('grouped aggregate count/sum', () => {
        bench(
          'materialized maintenance + cached read',
          maintenanceCurve(rowCount, groupedEntryTotals as Query<unknown>, patches, 'materialized'),
          BENCH_OPTIONS
        );
        bench(
          'write + full aggregate recompute',
          maintenanceCurve(rowCount, groupedEntryTotals as Query<unknown>, patches, 'recompute'),
          BENCH_OPTIONS
        );
      });

      describe('top-N sortLimit', () => {
        bench(
          'materialized maintenance + cached read',
          maintenanceCurve(rowCount, topEntries as Query<unknown>, patches, 'materialized'),
          BENCH_OPTIONS
        );
        bench(
          'write + full top-N recompute',
          maintenanceCurve(rowCount, topEntries as Query<unknown>, patches, 'recompute'),
          BENCH_OPTIONS
        );
      });
    });
  }
});

afterAll(() => {
  console.table(curveNotes.map((note) => ({
    shape: note.shape,
    rows: note.rows,
    lowerBoundTouchedRows: note.lowerBoundTouchedRows,
    expectedRowsRead: note.expectedRowsRead
  })));
});

function makeScanQueries(): readonly Query<unknown>[] {
  return Array.from({ length: SCAN_VARIANT_COUNT }, (_, index) => {
    const threshold = -500 + index * 75;
    return pipe(
      from(entry),
      where(gte(entry.amount, value(threshold))),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>;
  });
}

function makeLookupQueries(): readonly Query<unknown>[] {
  return accountIds.slice(0, LOOKUP_VARIANT_COUNT).map((accountId) =>
    pipe(
      from(entry),
      where(eq(entry.accountId, value(accountId))),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>
  );
}

function evaluateQueries(source: RelationSource, queries: readonly Query<unknown>[]): () => void {
  let cursor = 0;

  return () => {
    const query = queries[cursor % queries.length];
    if (query === undefined) throw new Error('benchmark query set is empty');
    cursor += 1;

    const result = evaluate(source, query);
    if (result.diagnostics.length > 0) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    }
    consume(result.rows);
  };
}

function maintenanceCurve(
  rowCount: number,
  query: Query<unknown>,
  patches: readonly WritePatch[],
  mode: MaintenanceMode
): () => void {
  let db = mode === 'materialized' ? mat(makeDb(rowCount), query) : makeDb(rowCount);
  let cursor = 0;

  return () => {
    db = transact(db, patchAt(patches, cursor));
    cursor += 1;
    consume(q(db, query));
  };
}

function indexedSource(entryRows: readonly Entry[]): RelationSource {
  const accountBuckets = new Map<string, Entry[]>();
  for (const row of entryRows) {
    const bucket = accountBuckets.get(row.accountId);
    if (bucket === undefined) accountBuckets.set(row.accountId, [row]);
    else bucket.push(row);
  }

  return {
    rows: (relation) => relation.name === schema.entries.name ? entryRows : [],
    lookup: (lookupValue) => {
      if (lookupValue.relation.name !== schema.entries.name || lookupValue.field !== 'accountId') return undefined;
      return typeof lookupValue.value === 'string'
        ? accountBuckets.get(lookupValue.value) ?? []
        : [];
    }
  };
}

function makeDb(rowCount: number): Db {
  return createDb({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries(rowCount)
  });
}

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountIds[index % accountIds.length] ?? 'account-0',
    amount: amountAt(index),
    memo: index % 5 === 0 ? null : `memo-${index % 251}`,
    posted: index % 7 !== 0
  }));
}

function makePatches(rowCount: number): readonly WritePatch[] {
  return Array.from({ length: PATCH_COUNT }, (_, index) => {
    const rowIndex = (index * 1_009) % rowCount;
    return updateByKey(schema.entries, `entry-${rowIndex}`, {
      accountId: accountIds[(index + rowIndex) % accountIds.length] ?? 'account-0',
      amount: amountAt(index * 37 + rowIndex),
      memo: index % 4 === 0 ? null : `curve-${index % 251}`,
      posted: index % 11 !== 0
    });
  });
}

function patchAt(patches: readonly WritePatch[], index: number): WritePatch {
  const patch = patches[index % patches.length];
  if (patch === undefined) throw new Error('benchmark patch set is empty');
  return patch;
}

function amountAt(index: number): number {
  return ((index * 7_919) % 100_000) - 50_000;
}

function consume(rows: readonly unknown[]): void {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}
