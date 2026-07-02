import { performance } from 'node:perf_hooks';
import { afterAll, bench, describe } from 'vitest';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  count,
  desc,
  field,
  from,
  pipe,
  project,
  sort,
  sortLimit,
  sum,
  type Query
} from '@tarstate/core/query';
import { updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 20_000;
const ACCOUNT_COUNT = 128;
const TOP_N_COUNT = 50;
const WRITES_PER_SAMPLE = 8;
const BENCH_OPTIONS = {
  time: 120,
  iterations: 4,
  warmupTime: 20,
  warmupIterations: 1
};

type ProbeMode = 'materialized' | 'recompute';
type ProbeMetrics = {
  readonly label: string;
  samples: number;
  writes: number;
  rowsRead: number;
  netHeapBytes: number;
  positiveHeapBytes: number;
  maxPositiveHeapBytes: number;
  elapsedMs: number;
  maxElapsedMs: number;
  maxEventLoopDelayMs: number;
};

const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const;
const accounts: readonly Account[] = Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
  id: `account-${index}`,
  name: `Account ${index}`,
  kind: accountKinds[index % accountKinds.length] ?? 'asset'
}));

const accountTotals = pipe(
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
  project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted })
);

const pressureQueries: readonly Query<unknown>[] = [
  accountTotals as Query<unknown>,
  topEntries as Query<unknown>
];
const pressureMetrics: ProbeMetrics[] = [];

let rowSink = 0;

describe('core materialization GC pressure probe', () => {
  bench(
    'materialized maintenance + cached reads',
    pressureProbe('materialized', 'materialized maintenance + cached reads'),
    BENCH_OPTIONS
  );
  bench('write + full query recompute', pressureProbe('recompute', 'write + full query recompute'), BENCH_OPTIONS);
});

afterAll(() => {
  if (pressureMetrics.length === 0) return;

  console.table(pressureMetrics.map((metrics) => ({
    probe: metrics.label,
    samples: metrics.samples,
    writes: metrics.writes,
    rowsRead: metrics.rowsRead,
    heapNetPerWrite: bytesPerWrite(metrics.netHeapBytes, metrics.writes),
    heapPositivePerWrite: bytesPerWrite(metrics.positiveHeapBytes, metrics.writes),
    maxHeapPositiveSample: bytes(metrics.maxPositiveHeapBytes),
    meanSampleMs: ms(metrics.elapsedMs / Math.max(1, metrics.samples)),
    maxSampleMs: ms(metrics.maxElapsedMs),
    maxEventLoopDelayMs: ms(metrics.maxEventLoopDelayMs)
  })));
});

function pressureProbe(mode: ProbeMode, label: string): () => Promise<void> {
  const metrics = makeMetrics(label);
  pressureMetrics.push(metrics);
  let db = makeProbeDb(mode);
  let cursor = 0;

  return async () => {
    const eventLoopDelay = eventLoopDelaySample();
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    let rowsRead = 0;

    for (let writeIndex = 0; writeIndex < WRITES_PER_SAMPLE; writeIndex += 1) {
      db = transact(db, patchAt(cursor));
      cursor += 1;
      rowsRead += consumeQueries(db, pressureQueries);
    }

    const elapsedMs = performance.now() - startedAt;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    const eventLoopDelayMs = await eventLoopDelay;

    recordSample(metrics, heapDelta, elapsedMs, eventLoopDelayMs, rowsRead);
  };
}

function makeMetrics(label: string): ProbeMetrics {
  return {
    label,
    samples: 0,
    writes: 0,
    rowsRead: 0,
    netHeapBytes: 0,
    positiveHeapBytes: 0,
    maxPositiveHeapBytes: 0,
    elapsedMs: 0,
    maxElapsedMs: 0,
    maxEventLoopDelayMs: 0
  };
}

function recordSample(
  metrics: ProbeMetrics,
  heapDelta: number,
  elapsedMs: number,
  eventLoopDelayMs: number,
  rowsRead: number
): void {
  const positiveHeapDelta = Math.max(0, heapDelta);
  metrics.samples += 1;
  metrics.writes += WRITES_PER_SAMPLE;
  metrics.rowsRead += rowsRead;
  metrics.netHeapBytes += heapDelta;
  metrics.positiveHeapBytes += positiveHeapDelta;
  metrics.maxPositiveHeapBytes = Math.max(metrics.maxPositiveHeapBytes, positiveHeapDelta);
  metrics.elapsedMs += elapsedMs;
  metrics.maxElapsedMs = Math.max(metrics.maxElapsedMs, elapsedMs);
  metrics.maxEventLoopDelayMs = Math.max(metrics.maxEventLoopDelayMs, eventLoopDelayMs);
}

function makeProbeDb(mode: ProbeMode): Db {
  const db = createDb({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries()
  });

  return mode === 'materialized' ? mat(db, ...pressureQueries) : db;
}

function makeEntries(): Entry[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountAt(index).id,
    amount: amountAt(index),
    memo: index % 5 === 0 ? null : `memo-${index % 251}`,
    posted: index % 7 !== 0
  }));
}

function patchAt(index: number): WritePatch {
  const rowIndex = (index * 1_009) % ROW_COUNT;

  return updateByKey(schema.entries, `entry-${rowIndex}`, {
    accountId: accountAt(index + rowIndex).id,
    amount: amountAt(index * 37 + rowIndex),
    memo: index % 4 === 0 ? null : `pressure-${index % 257}`,
    posted: index % 11 !== 0
  });
}

function amountAt(index: number): number {
  return ((index * 7_919) % 100_000) - 50_000;
}

function accountAt(index: number): Account {
  const row = accounts[index % accounts.length];
  if (row === undefined) throw new Error('benchmark account set is empty');
  return row;
}

function consumeQueries(db: Db, queries: readonly Query<unknown>[]): number {
  let rowsRead = 0;
  for (const query of queries) rowsRead += consume(q(db, query));
  return rowsRead;
}

function consume(rows: readonly unknown[]): number {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
  return rows.length;
}

function eventLoopDelaySample(): Promise<number> {
  const scheduledAt = performance.now();
  return new Promise((resolve) => {
    setTimeout(() => resolve(Math.max(0, performance.now() - scheduledAt)), 0);
  });
}

function bytesPerWrite(byteCount: number, writes: number): string {
  return bytes(byteCount / Math.max(1, writes));
}

function bytes(byteCount: number): string {
  const abs = Math.abs(byteCount);
  if (abs < 1_024) return `${byteCount.toFixed(0)} B`;
  if (abs < 1_048_576) return `${(byteCount / 1_024).toFixed(1)} KiB`;
  return `${(byteCount / 1_048_576).toFixed(2)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}
