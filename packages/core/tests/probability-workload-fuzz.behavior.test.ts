import { describe, expect, it } from 'vitest';
import { createDb, q, qMany, tryTransact, type Db } from '@tarstate/core/db';
import { demat, mat } from '@tarstate/core/materialization';
import type { Query } from '@tarstate/core/query';
import { createStore, type Store, type StoreView, type StoreViewSnapshot } from '@tarstate/core/store';
import { resolveFuzzSeeds } from './fuzz-helpers.js';
import {
  makeProbabilityWorkloadData,
  probabilityMaterializedQueries,
  probabilityWorkloadPatchAt,
  probabilityWorkloadQueries,
  probabilityWorkloadQueryBatch,
  type ProbabilityWorkloadQueries
} from './probability-workload-fixtures.js';

const seeds = resolveFuzzSeeds([0x9f07_0001, 0x9f07_0002, 0x9f07_0003, 0x9f07_0004] as const);
const STEPS_PER_SEED = 56;
const DUPLICATE_VIEW_COUNT = 12;
const WORKLOAD_FUZZ_TIMEOUT_MS = 20_000;

type WorkloadViews = {
  readonly activeMarketSummary: StoreView;
  readonly userLeaderboard: StoreView;
  readonly visibleCommentFeed: StoreView;
  readonly userWatchlist: StoreView;
};
type WorkloadSnapshots = {
  readonly activeMarketSummary: StoreViewSnapshot;
  readonly userLeaderboard: StoreViewSnapshot;
  readonly visibleCommentFeed: StoreViewSnapshot;
  readonly userWatchlist: StoreViewSnapshot;
};
type WorkloadCalls = {
  activeMarketSummary: number;
  userLeaderboard: number;
  visibleCommentFeed: number;
  userWatchlist: number;
};

describe('probability dashboard workload seeded fuzz behavior', () => {
  it.each(seeds)('keeps query, store, and materialized aggregate views coherent for seed %#', async (seed) => {
    const data = makeProbabilityWorkloadData(seed);
    const selectedUser = data.probabilityUsers[seed % data.probabilityUsers.length]?.id ?? 'user-0';
    const queries = probabilityWorkloadQueries(selectedUser);
    const queryBatch = probabilityWorkloadQueryBatch(queries);
    const store = createStore(data);
    const views = workloadViews(store, queries);
    const duplicateSummaryViews = Array.from({ length: DUPLICATE_VIEW_COUNT }, () =>
      store.view(queries.activeMarketSummary));
    const calls: WorkloadCalls = {
      activeMarketSummary: 0,
      userLeaderboard: 0,
      visibleCommentFeed: 0,
      userWatchlist: 0
    };
    const unsubscribers = [
      views.activeMarketSummary.subscribe(() => {
        calls.activeMarketSummary += 1;
      }),
      views.userLeaderboard.subscribe(() => {
        calls.userLeaderboard += 1;
      }),
      views.visibleCommentFeed.subscribe(() => {
        calls.visibleCommentFeed += 1;
      }),
      views.userWatchlist.subscribe(() => {
        calls.userWatchlist += 1;
      }),
      ...duplicateSummaryViews.map((view) => view.subscribe(() => {
        calls.activeMarketSummary += 1;
      }))
    ];
    const materializedQueries = probabilityMaterializedQueries(queries);
    let materializedDb = mat(createDb(data), ...materializedQueries);

    try {
      assertWorkloadStoreParity(store, queries, views, duplicateSummaryViews, `seed ${seed} initial`);
      assertMaterializedAggregateParity(materializedDb, store.getSnapshot().db, materializedQueries, `seed ${seed} initial`);

      for (let step = 0; step < STEPS_PER_SEED; step += 1) {
        const workloadPatch = probabilityWorkloadPatchAt(seed, step, data);
        const label = `seed ${seed} step ${step} ${workloadPatch.label}`;
        const beforeCalls = { ...calls };
        const beforeSnapshots = viewSnapshots(views);

        const commitResult = await store.commit(workloadPatch.patch);
        expect(commitResult.status, label).toBe('accepted');
        expect(commitResult.diagnostics, label).toEqual([]);

        const materializedResult = tryTransact(materializedDb, workloadPatch.patch);
        expect(materializedResult.committed, label).toBe(true);
        expect(materializedResult.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), label).toEqual([]);
        materializedDb = materializedResult.db;

        if (workloadPatch.relation === 'probabilityAuditEvents') {
          expect(calls, `${label} unrelated calls`).toEqual(beforeCalls);
          assertSnapshotsReused(views, beforeSnapshots, `${label} unrelated snapshots`);
        }

        assertWorkloadStoreParity(store, queries, views, duplicateSummaryViews, label);
        assertMaterializedAggregateParity(materializedDb, store.getSnapshot().db, materializedQueries, label);
        expect(qMany(store.getSnapshot().db, queryBatch), `${label} batch direct parity`)
          .toEqual(rowsByQueryResult(store.queries(queryBatch)));
      }
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
      store.close();
    }
  }, WORKLOAD_FUZZ_TIMEOUT_MS);
});

function workloadViews(store: Store, queries: ProbabilityWorkloadQueries): WorkloadViews {
  return {
    activeMarketSummary: store.view(queries.activeMarketSummary),
    userLeaderboard: store.view(queries.userLeaderboard),
    visibleCommentFeed: store.view(queries.visibleCommentFeed),
    userWatchlist: store.view(queries.userWatchlist)
  };
}

function assertWorkloadStoreParity(
  store: Store,
  queries: ProbabilityWorkloadQueries,
  views: WorkloadViews,
  duplicateSummaryViews: readonly StoreView[],
  label: string
): void {
  const batch = probabilityWorkloadQueryBatch(queries);
  const snapshot = store.getSnapshot();
  const expected = qMany(snapshot.db, batch);
  const actual = store.queries(batch);
  expect(rowsByQueryResult(actual), `${label} store batch rows`).toEqual(expected);
  expect(actual.activeMarketSummary.diagnostics, `${label} summary diagnostics`).toEqual([]);
  expect(actual.userLeaderboard.diagnostics, `${label} leaderboard diagnostics`).toEqual([]);
  expect(actual.visibleCommentFeed.diagnostics, `${label} feed diagnostics`).toEqual([]);
  expect(actual.userWatchlist.diagnostics, `${label} watchlist diagnostics`).toEqual([]);

  const activeMarketSummary = views.activeMarketSummary.getSnapshot();
  expect(activeMarketSummary.rows, `${label} summary view`).toEqual(expected.activeMarketSummary);
  expect(views.userLeaderboard.getSnapshot().rows, `${label} leaderboard view`).toEqual(expected.userLeaderboard);
  expect(views.visibleCommentFeed.getSnapshot().rows, `${label} feed view`).toEqual(expected.visibleCommentFeed);
  expect(views.userWatchlist.getSnapshot().rows, `${label} watchlist view`).toEqual(expected.userWatchlist);

  for (const [index, duplicateView] of duplicateSummaryViews.entries()) {
    expect(duplicateView.getSnapshot(), `${label} duplicate summary view ${index}`).toBe(activeMarketSummary);
  }
}

function assertMaterializedAggregateParity(
  materializedDb: Db,
  directDb: Db,
  queries: readonly Query<unknown>[],
  label: string
): void {
  for (const [index, query] of queries.entries()) {
    expect(q(materializedDb, query), `${label} materialized ${index}`).toEqual(q(demat(materializedDb, query), query));
    expect(q(materializedDb, query), `${label} direct ${index}`).toEqual(q(directDb, query));
  }
}

function viewSnapshots(views: WorkloadViews): WorkloadSnapshots {
  return {
    activeMarketSummary: views.activeMarketSummary.getSnapshot(),
    userLeaderboard: views.userLeaderboard.getSnapshot(),
    visibleCommentFeed: views.visibleCommentFeed.getSnapshot(),
    userWatchlist: views.userWatchlist.getSnapshot()
  };
}

function assertSnapshotsReused(views: WorkloadViews, snapshots: WorkloadSnapshots, label: string): void {
  expect(views.activeMarketSummary.getSnapshot(), `${label} summary`).toBe(snapshots.activeMarketSummary);
  expect(views.userLeaderboard.getSnapshot(), `${label} leaderboard`).toBe(snapshots.userLeaderboard);
  expect(views.visibleCommentFeed.getSnapshot(), `${label} feed`).toBe(snapshots.visibleCommentFeed);
  expect(views.userWatchlist.getSnapshot(), `${label} watchlist`).toBe(snapshots.userWatchlist);
}

function rowsByQueryResult(input: {
  readonly activeMarketSummary: { readonly rows: readonly unknown[] };
  readonly userLeaderboard: { readonly rows: readonly unknown[] };
  readonly visibleCommentFeed: { readonly rows: readonly unknown[] };
  readonly userWatchlist: { readonly rows: readonly unknown[] };
}): {
  readonly activeMarketSummary: readonly unknown[];
  readonly userLeaderboard: readonly unknown[];
  readonly visibleCommentFeed: readonly unknown[];
  readonly userWatchlist: readonly unknown[];
} {
  return {
    activeMarketSummary: input.activeMarketSummary.rows,
    userLeaderboard: input.userLeaderboard.rows,
    visibleCommentFeed: input.visibleCommentFeed.rows,
    userWatchlist: input.userWatchlist.rows
  };
}
