import { afterAll, bench, describe } from 'vitest';
import { createStore, type StoreView } from '@tarstate/core/store';
import { asc, eq, from, pipe, project, sort, value, where, type Query } from '@tarstate/core/query';
import { insertOrReplace, type WritePatch } from '@tarstate/core/write';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 10_000;
const ACCOUNT_COUNT = 128;
const DISTINCT_VIEW_COUNT = 100;
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
};

type FanoutMetrics = {
  readonly label: string;
  commits: number;
  listenerCalls: number;
  snapshotReads: number;
  rowsRead: number;
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
  { label: '100 distinct views/subscribers', queries: distinctQueries }
];
const fanoutMetrics: FanoutMetrics[] = [];

let rowSink = 0;

describe('core store view fanout', () => {
  for (const scenario of scenarios) {
    bench(scenario.label, commitAndReadFanout(scenario), BENCH_OPTIONS);
  }
});

afterAll(() => {
  if (fanoutMetrics.length === 0) return;

  console.table(fanoutMetrics.map((metrics) => ({
    scenario: metrics.label,
    commits: metrics.commits,
    listenerCalls: metrics.listenerCalls,
    snapshotReads: metrics.snapshotReads,
    snapshotReadsPerCommit: ratio(metrics.snapshotReads, metrics.commits),
    rowsReadPerCommit: ratio(metrics.rowsRead, metrics.commits)
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
    cleanup: () => undefined
  };
  fanoutMetrics.push(metrics);

  const store = createStore({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries()
  });
  const views = scenario.queries.map((query) => store.view(query));
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
    await store.commit(patchAt(cursor));
    cursor = (cursor + 1) % PATCH_COUNT;
    metrics.commits += 1;

    for (const view of views) readView(view, metrics);
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

function patchAt(index: number): WritePatch {
  const rowIndex = (index * 1_009) % ROW_COUNT;
  return insertOrReplace(schema.entries, {
    id: `entry-${rowIndex}`,
    accountId: accountIds[(index + rowIndex) % accountIds.length] ?? 'account-0',
    amount: ((index * 37 + rowIndex) % 100_000) - 50_000,
    memo: index % 4 === 0 ? null : `fanout-${index % 257}`,
    posted: index % 11 !== 0
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

function ratio(valueValue: number, count: number): string {
  return (valueValue / Math.max(1, count)).toFixed(1);
}
