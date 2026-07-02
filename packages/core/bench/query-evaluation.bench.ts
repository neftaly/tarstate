import { bench, describe } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { eq, from, gte, pipe, project, value, where, type Query } from '@tarstate/core/query';
import { type RelationSource } from '@tarstate/core/source';
import { entry, schema, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 8_000;
const ACCOUNT_GROUP_COUNT = 128;
const QUERY_VARIANT_COUNT = 16;
const BENCH_OPTIONS = {
  time: 200,
  iterations: 10,
  warmupTime: 30,
  warmupIterations: 3
};

const accountIds = Array.from({ length: ACCOUNT_GROUP_COUNT }, (_, index) => `account-${index}`);
const rows = makeEntries(ROW_COUNT);
const indexed = indexedSource(rows);
const scanFallback = scanFallbackSource(rows);
const equalityQueries = accountIds.slice(0, QUERY_VARIANT_COUNT).map((accountId) =>
  pipe(
    from(entry),
    where(eq(entry.accountId, value(accountId))),
    project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
  )
) satisfies readonly Query<unknown>[];
const rangeQueries = Array.from({ length: QUERY_VARIANT_COUNT }, (_, index) => 46_000 + index * 250).map((lower) =>
  pipe(
    from(entry),
    where(gte(entry.amount, value(lower))),
    project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
  )
) satisfies readonly Query<unknown>[];

let rowSink = 0;

describe('core query evaluation where pushdown', () => {
  describe('equality filter', () => {
    bench('RelationSource.lookup pushdown', evaluateQueries(indexed, equalityQueries), BENCH_OPTIONS);
    bench('rows scan fallback', evaluateQueries(scanFallback, equalityQueries), BENCH_OPTIONS);
  });

  describe('range filter', () => {
    bench('RelationSource.rangeLookup pushdown', evaluateQueries(indexed, rangeQueries), BENCH_OPTIONS);
    bench('rows scan fallback', evaluateQueries(scanFallback, rangeQueries), BENCH_OPTIONS);
  });
});

function scanFallbackSource(entryRows: readonly Entry[]): RelationSource {
  return {
    rows: (relation) => relation.name === schema.entries.name ? entryRows : []
  };
}

function indexedSource(entryRows: readonly Entry[]): RelationSource {
  const accountBuckets = new Map<string, Entry[]>();
  for (const row of entryRows) {
    const bucket = accountBuckets.get(row.accountId);
    if (bucket === undefined) {
      accountBuckets.set(row.accountId, [row]);
    } else {
      bucket.push(row);
    }
  }
  const amountRows = [...entryRows].sort((left, right) => left.amount - right.amount || left.id.localeCompare(right.id));

  return {
    rows: (relation) => relation.name === schema.entries.name ? entryRows : [],
    lookup: (lookupValue) => {
      if (lookupValue.relation.name !== schema.entries.name || lookupValue.field !== 'accountId') return undefined;
      return typeof lookupValue.value === 'string'
        ? accountBuckets.get(lookupValue.value) ?? []
        : [];
    },
    rangeLookup: (lookupValue) => {
      if (lookupValue.relation.name !== schema.entries.name || lookupValue.field !== 'amount') return undefined;

      const lower = lookupValue.lower;
      const upper = lookupValue.upper;
      let start = 0;
      let end = amountRows.length;
      if (lower !== undefined) {
        const lowerValue = lower.value;
        if (typeof lowerValue !== 'number') return undefined;
        start = lowerBoundByAmount(amountRows, lowerValue, lower.inclusive);
      }
      if (upper !== undefined) {
        const upperValue = upper.value;
        if (typeof upperValue !== 'number') return undefined;
        end = upperBoundByAmount(amountRows, upperValue, upper.inclusive);
      }

      return amountRows.slice(start, end);
    }
  };
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

function lowerBoundByAmount(sortedRows: readonly Entry[], valueValue: number, inclusive: boolean): number {
  let low = 0;
  let high = sortedRows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = sortedRows[middle];
    if (row === undefined) throw new Error('unreachable sorted row index');
    if (row.amount < valueValue || (!inclusive && row.amount === valueValue)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function upperBoundByAmount(sortedRows: readonly Entry[], valueValue: number, inclusive: boolean): number {
  let low = 0;
  let high = sortedRows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = sortedRows[middle];
    if (row === undefined) throw new Error('unreachable sorted row index');
    if (row.amount < valueValue || (inclusive && row.amount === valueValue)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountIds[index % accountIds.length] ?? 'account-0',
    amount: ((index * 7_919) % 100_000) - 50_000,
    memo: index % 5 === 0 ? null : `memo-${index % 97}`,
    posted: index % 7 !== 0
  }));
}

function consume(resultRows: readonly unknown[]): void {
  rowSink = (rowSink + resultRows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}
