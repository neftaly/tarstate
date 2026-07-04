import { afterAll, bench, describe } from 'vitest';
import { createStore, type StoreView } from '@tarstate/core/store';
import { asc, eq, from, pipe, project, sort, value, where, type Query } from '@tarstate/core/query';
import { insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 10_000;
const ACCOUNT_COUNT = 128;
const DISTINCT_VIEW_COUNT = 100;
const CHURN_VIEW_COUNT = 100;
const PATCH_COUNT = 512;
const BENCH_OPTIONS = {
  time: 200,
  iterations: 8,
  warmupTime: 30,
  warmupIterations: 2
};

type FanoutScenario = {
  readonly label: string;
  readonly queries: readonly Query<unknown>[];
  readonly patch?: (index: number) => WritePatch;
};

type FanoutMetrics = {
  readonly label: string;
  commits: number;
  listenerCalls: number;
  snapshotReads: number;
  rowsRead: number;
  netHeapBytes: number;
  positiveHeapBytes: number;
  maxPositiveHeapBytes: number;
  cleanup: () => void;
};

const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const;
const accounts: readonly Account[] = Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
  id: `account-${index}`,
  name: `Account ${index}`,
  kind: accountKinds[index % accountKinds.length] ?? 'asset'
}));
const accountIds = accounts.map((account) => account.id);
const identicalQuery = entryQueryFor('account-0');
const distinctQueries = accountIds.slice(0, DISTINCT_VIEW_COUNT).map(entryQueryFor) satisfies readonly Query<unknown>[];
const scenarios: readonly FanoutScenario[] = [
  { label: '1 identical view/subscriber', queries: Array.from({ length: 1 }, () => identicalQuery) },
  { label: '10 identical views/subscribers', queries: Array.from({ length: 10 }, () => identicalQuery) },
  { label: '100 identical views/subscribers', queries: Array.from({ length: 100 }, () => identicalQuery) },
  { label: '100 distinct views/subscribers', queries: distinctQueries },
  { label: '100 distinct views, unrelated account commits', queries: distinctQueries, patch: accountPatchAt }
];
const fanoutMetrics: FanoutMetrics[] = [];

let rowSink = 0;

describe('core store view fanout', () => {
  for (const scenario of scenarios) {
    bench(scenario.label, commitAndReadFanout(scenario), BENCH_OPTIONS);
  }

  bench(`${CHURN_VIEW_COUNT} distinct churned views/subscribers`, commitAndReadChurnedFanout(), BENCH_OPTIONS);
});

afterAll(() => {
  if (fanoutMetrics.length === 0) return;

  console.table(fanoutMetrics.map((metrics) => ({
    scenario: metrics.label,
    commits: metrics.commits,
    listenerCalls: metrics.listenerCalls,
    snapshotReads: metrics.snapshotReads,
    snapshotReadsPerCommit: ratio(metrics.snapshotReads, metrics.commits),
    rowsReadPerCommit: ratio(metrics.rowsRead, metrics.commits),
    heapNetPerCommit: bytesPerCommit(metrics.netHeapBytes, metrics.commits),
    heapPositivePerCommit: bytesPerCommit(metrics.positiveHeapBytes, metrics.commits),
    maxHeapPositiveSample: bytes(metrics.maxPositiveHeapBytes)
  })));

  for (const metrics of fanoutMetrics) metrics.cleanup();
});

function commitAndReadFanout(scenario: FanoutScenario): () => Promise<void> {
  const metrics: FanoutMetrics = {
    label: scenario.label,
    commits: 0,
    listenerCalls: 0,
    snapshotReads: 0,
    rowsRead: 0,
    netHeapBytes: 0,
    positiveHeapBytes: 0,
    maxPositiveHeapBytes: 0,
    cleanup: () => undefined
  };
  fanoutMetrics.push(metrics);

  const store = createStore({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries()
  });
  const views = scenario.queries.map((query) => store.view(query));
  const patchFor = scenario.patch ?? entryPatchAt;
  const unsubscribers = views.map((view) => view.subscribe(() => {
    metrics.listenerCalls += 1;
    readView(view, metrics);
  }));
  let cursor = 0;

  metrics.cleanup = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    store.close();
  };

  return async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    await store.commit(patchFor(cursor));
    cursor = (cursor + 1) % PATCH_COUNT;
    metrics.commits += 1;

    for (const view of views) readView(view, metrics);
    recordHeapSample(metrics, process.memoryUsage().heapUsed - heapBefore);
  };
}

function commitAndReadChurnedFanout(): () => Promise<void> {
  const metrics: FanoutMetrics = {
    label: `${CHURN_VIEW_COUNT} distinct churned views/subscribers`,
    commits: 0,
    listenerCalls: 0,
    snapshotReads: 0,
    rowsRead: 0,
    netHeapBytes: 0,
    positiveHeapBytes: 0,
    maxPositiveHeapBytes: 0,
    cleanup: () => undefined
  };
  fanoutMetrics.push(metrics);

  const store = createStore({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries()
  });
  let cursor = 0;
  let queryCursor = 0;

  metrics.cleanup = () => {
    store.close();
  };

  return async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const views = Array.from({ length: CHURN_VIEW_COUNT }, (_, index) => {
      const query = distinctQueries[(queryCursor + index) % distinctQueries.length];
      if (query === undefined) throw new Error('benchmark query set is empty');
      return store.view(query);
    });
    queryCursor = (queryCursor + CHURN_VIEW_COUNT) % distinctQueries.length;
    const unsubscribers = views.map((view) => view.subscribe(() => {
      metrics.listenerCalls += 1;
      readView(view, metrics);
    }));

    for (const view of views) readView(view, metrics);
    await store.commit(entryPatchAt(cursor));
    cursor = (cursor + 1) % PATCH_COUNT;
    metrics.commits += 1;
    for (const view of views) readView(view, metrics);
    for (const unsubscribe of unsubscribers) unsubscribe();

    recordHeapSample(metrics, process.memoryUsage().heapUsed - heapBefore);
  };
}

function entryQueryFor(accountId: string): Query<unknown> {
  return pipe(
    from(entry),
    where(eq(entry.accountId, value(accountId))),
    sort(asc(entry.id)),
    project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted })
  ) as Query<unknown>;
}

function makeEntries(): Entry[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountIds[index % accountIds.length] ?? 'account-0',
    amount: ((index * 7_919) % 100_000) - 50_000,
    memo: index % 5 === 0 ? null : `memo-${index % 97}`,
    posted: index % 7 !== 0
  }));
}

function entryPatchAt(index: number): WritePatch {
  const rowIndex = (index * 1_009) % ROW_COUNT;
  return insertOrReplace(schema.entries, {
    id: `entry-${rowIndex}`,
    accountId: accountIds[(index + rowIndex) % accountIds.length] ?? 'account-0',
    amount: ((index * 37 + rowIndex) % 100_000) - 50_000,
    memo: index % 4 === 0 ? null : `fanout-${index % 257}`,
    posted: index % 11 !== 0
  });
}

function accountPatchAt(index: number): WritePatch {
  const accountId = accountIds[index % accountIds.length] ?? 'account-0';
  return updateByKey(schema.accounts, accountId, {
    name: `Account ${index % ACCOUNT_COUNT} updated ${index % PATCH_COUNT}`
  });
}

function readView(view: StoreView<unknown>, metrics: FanoutMetrics): void {
  const snapshot = view.getSnapshot();
  metrics.snapshotReads += 1;
  metrics.rowsRead += snapshot.rows.length;
  consume(snapshot.rows);
}

function consume(rows: readonly unknown[]): void {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}

function recordHeapSample(metrics: FanoutMetrics, heapDelta: number): void {
  const positiveHeapDelta = Math.max(0, heapDelta);
  metrics.netHeapBytes += heapDelta;
  metrics.positiveHeapBytes += positiveHeapDelta;
  metrics.maxPositiveHeapBytes = Math.max(metrics.maxPositiveHeapBytes, positiveHeapDelta);
}

function ratio(valueValue: number, count: number): string {
  return (valueValue / Math.max(1, count)).toFixed(1);
}

function bytesPerCommit(byteCount: number, commits: number): string {
  return bytes(byteCount / Math.max(1, commits));
}

function bytes(byteCount: number): string {
  const abs = Math.abs(byteCount);
  if (abs < 1_024) return `${byteCount.toFixed(0)} B`;
  if (abs < 1_048_576) return `${(byteCount / 1_024).toFixed(1)} KiB`;
  return `${(byteCount / 1_048_576).toFixed(2)} MiB`;
}
