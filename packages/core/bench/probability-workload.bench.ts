import { afterAll, bench, describe } from 'vitest';
import { createDb, q, qMany, tryTransact, type Db } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { createStore, type StoreView } from '@tarstate/core/store';
import {
  benchmarkProbabilityWorkloadSize,
  makeProbabilityWorkloadData,
  probabilityMaterializedQueries,
  probabilityWorkloadPatchAt,
  probabilityWorkloadQueries,
  probabilityWorkloadQueryBatch,
  type ProbabilityMarketRow,
  type ProbabilityPositionRow,
  type ProbabilityUserRow,
  type ProbabilityWorkloadData
} from '../tests/probability-workload-fixtures.js';

const SEED = 0x9f07_beef;
const PATCH_CYCLE = 512;
const BENCH_OPTIONS = {
  time: 200,
  iterations: 8,
  warmupTime: 30,
  warmupIterations: 2
};

type ProbabilityDashboardRows = {
  readonly activeMarketSummary: readonly unknown[];
  readonly userLeaderboard: readonly unknown[];
  readonly visibleCommentFeed: readonly unknown[];
  readonly userWatchlist: readonly unknown[];
};

const workloadData = makeProbabilityWorkloadData(SEED, benchmarkProbabilityWorkloadSize);
const selectedUserId = workloadData.probabilityUsers[0]?.id ?? 'user-0';
const workloadQueries = probabilityWorkloadQueries(selectedUserId);
const workloadQueryBatch = probabilityWorkloadQueryBatch(workloadQueries);
const baselineDb = createDb(workloadData);
const cleanupTasks: (() => void)[] = [];
const benchmarkMetrics: { readonly scenario: string; readonly rows: number; readonly patches?: number }[] = [];
let benchmarkSink = 0;

describe('core probability dashboard workload', () => {
  bench('qMany dashboard queries', recordBenchmark('qMany dashboard queries', () => {
    consumeDashboardRows(qMany(baselineDb, workloadQueryBatch));
  }), BENCH_OPTIONS);

  bench('manual dashboard oracle', recordBenchmark('manual dashboard oracle', () => {
    consumeDashboardRows(manualDashboardOracle(workloadData, selectedUserId));
  }), BENCH_OPTIONS);

  bench('qMany after mixed writes', recordBenchmark('qMany after mixed writes', mixedWriteQueryProbe()), BENCH_OPTIONS);

  bench('materialized aggregate maintenance', recordBenchmark(
    'materialized aggregate maintenance',
    materializedAggregateProbe()
  ), BENCH_OPTIONS);

  bench('duplicate view fanout on unrelated writes', recordBenchmark(
    'duplicate view fanout on unrelated writes',
    duplicateViewAuditProbe()
  ), BENCH_OPTIONS);
});

afterAll(() => {
  if (benchmarkMetrics.length > 0) console.table(benchmarkMetrics);
  for (const cleanup of cleanupTasks) cleanup();
  if (benchmarkSink < 0) throw new Error('unreachable benchmark sink');
});

function mixedWriteQueryProbe(): () => void {
  let currentDb: Db = baselineDb;
  let cursor = 0;

  return () => {
    if (cursor % PATCH_CYCLE === 0) currentDb = baselineDb;
    const patch = probabilityWorkloadPatchAt(SEED, cursor % PATCH_CYCLE, workloadData).patch;
    const result = tryTransact(currentDb, patch);
    if (!result.committed || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new Error(`benchmark write failed: ${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
    }
    currentDb = result.db;
    cursor += 1;
    consumeDashboardRows(qMany(currentDb, workloadQueryBatch));
  };
}

function materializedAggregateProbe(): () => void {
  const queries = probabilityMaterializedQueries(workloadQueries);
  let currentDb = mat(baselineDb, ...queries);
  let cursor = 0;

  return () => {
    if (cursor % PATCH_CYCLE === 0) currentDb = mat(baselineDb, ...queries);
    const patch = probabilityWorkloadPatchAt(SEED, cursor % PATCH_CYCLE, workloadData).patch;
    const result = tryTransact(currentDb, patch);
    if (!result.committed || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new Error(`benchmark materialized write failed: ${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
    }
    currentDb = result.db;
    cursor += 1;
    for (const query of queries) consumeRows(q(currentDb, query));
  };
}

function duplicateViewAuditProbe(): () => Promise<void> {
  const store = createStore(workloadData);
  const views = Array.from({ length: 64 }, (_, index): StoreView => {
    switch (index % 4) {
      case 0:
        return store.view(workloadQueries.activeMarketSummary);
      case 1:
        return store.view(workloadQueries.userLeaderboard);
      case 2:
        return store.view(workloadQueries.visibleCommentFeed);
      default:
        return store.view(workloadQueries.userWatchlist);
    }
  });
  const unsubscribers = views.map((view) => view.subscribe(() => {
    benchmarkSink += 1;
  }));
  let cursor = 0;

  cleanupTasks.push(() => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    store.close();
  });

  return async () => {
    const auditStep = (cursor % PATCH_CYCLE) * 7 + 5;
    const patch = probabilityWorkloadPatchAt(SEED, auditStep, workloadData).patch;
    const result = await store.commit(patch);
    if (result.status !== 'accepted' || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new Error(`benchmark store commit failed: ${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
    }
    cursor += 1;
    for (const view of views) consumeRows(view.getSnapshot().rows);
  };
}

function manualDashboardOracle(data: ProbabilityWorkloadData, userId: string): ProbabilityDashboardRows {
  return {
    activeMarketSummary: manualActiveMarketSummary(data),
    userLeaderboard: manualUserLeaderboard(data.probabilityPositions),
    visibleCommentFeed: manualVisibleCommentFeed(data),
    userWatchlist: manualUserWatchlist(data, userId)
  };
}

function manualActiveMarketSummary(data: ProbabilityWorkloadData): readonly unknown[] {
  const statsByMarket = new Map<string, {
    forecastCount: number;
    probabilityTotal: number;
    lowProbability: number;
    highProbability: number;
    totalWeight: number;
  }>();
  for (const forecast of data.probabilityForecasts) {
    if (!forecast.active) continue;
    const stats = statsByMarket.get(forecast.marketId) ?? {
      forecastCount: 0,
      probabilityTotal: 0,
      lowProbability: Number.POSITIVE_INFINITY,
      highProbability: Number.NEGATIVE_INFINITY,
      totalWeight: 0
    };
    stats.forecastCount += 1;
    stats.probabilityTotal += forecast.probability;
    stats.lowProbability = Math.min(stats.lowProbability, forecast.probability);
    stats.highProbability = Math.max(stats.highProbability, forecast.probability);
    stats.totalWeight += forecast.weight;
    statsByMarket.set(forecast.marketId, stats);
  }

  return data.probabilityMarkets
    .filter((market) => market.status === 'open')
    .sort((left, right) => right.liquidity - left.liquidity || left.id.localeCompare(right.id))
    .map((market) => {
      const stats = statsByMarket.get(market.id);
      return {
        marketId: market.id,
        topic: market.topic,
        category: market.category,
        liquidity: market.liquidity,
        forecastCount: stats?.forecastCount,
        avgProbability: stats === undefined ? undefined : stats.probabilityTotal / stats.forecastCount,
        lowProbability: stats?.lowProbability,
        highProbability: stats?.highProbability,
        totalWeight: stats?.totalWeight
      };
    });
}

function manualUserLeaderboard(positions: readonly ProbabilityPositionRow[]): readonly unknown[] {
  const totals = new Map<string, { marketCount: number; totalShares: number; totalExposure: number }>();
  for (const position of positions) {
    const current = totals.get(position.userId) ?? { marketCount: 0, totalShares: 0, totalExposure: 0 };
    current.marketCount += 1;
    current.totalShares += position.shares;
    current.totalExposure += position.exposure;
    totals.set(position.userId, current);
  }

  return Array.from(totals, ([userId, total]) => ({ userId, ...total }))
    .sort((left, right) => right.totalExposure - left.totalExposure || left.userId.localeCompare(right.userId));
}

function manualVisibleCommentFeed(data: ProbabilityWorkloadData): readonly unknown[] {
  const usersById = keyedRows(data.probabilityUsers);
  const marketsById = keyedRows(data.probabilityMarkets);
  return data.probabilityComments
    .filter((comment) => !comment.hidden)
    .flatMap((comment) => {
      const user = usersById.get(comment.userId);
      const market = marketsById.get(comment.marketId);
      return user === undefined || market === undefined
        ? []
        : [{
          commentId: comment.id,
          marketId: market.id,
          topic: market.topic,
          userId: user.id,
          handle: user.handle,
          body: comment.body,
          createdAt: comment.createdAt
        }];
    })
    .sort((left, right) => right.createdAt - left.createdAt || left.commentId.localeCompare(right.commentId))
    .slice(0, 40);
}

function manualUserWatchlist(data: ProbabilityWorkloadData, userId: string): readonly unknown[] {
  const marketsById = keyedRows(data.probabilityMarkets);
  return data.probabilityWatchlist
    .filter((watchlistRow) => watchlistRow.userId === userId)
    .flatMap((watchlistRow) => {
      const market = marketsById.get(watchlistRow.marketId);
      return market === undefined
        ? []
        : [{
          userId: watchlistRow.userId,
          marketId: watchlistRow.marketId,
          pinned: watchlistRow.pinned,
          topic: market.topic,
          status: market.status,
          closesAt: market.closesAt
        }];
    })
    .sort((left, right) =>
      Number(right.pinned) - Number(left.pinned)
      || left.closesAt - right.closesAt
      || left.marketId.localeCompare(right.marketId))
    .map(({ closesAt: _closesAt, ...row }) => row);
}

function keyedRows<Row extends ProbabilityUserRow | ProbabilityMarketRow>(rows: readonly Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [row.id, row]));
}

function consumeDashboardRows(rows: ProbabilityDashboardRows): void {
  consumeRows(rows.activeMarketSummary);
  consumeRows(rows.userLeaderboard);
  consumeRows(rows.visibleCommentFeed);
  consumeRows(rows.userWatchlist);
}

function consumeRows(rows: readonly unknown[]): void {
  benchmarkSink = (benchmarkSink + rows.length) % Number.MAX_SAFE_INTEGER;
}

function recordBenchmark(label: string, fn: () => void | Promise<void>): () => void | Promise<void> {
  benchmarkMetrics.push({
    scenario: label,
    rows: benchmarkProbabilityWorkloadSize.forecasts
      + benchmarkProbabilityWorkloadSize.positions
      + benchmarkProbabilityWorkloadSize.comments,
    patches: PATCH_CYCLE
  });
  return fn;
}
