import {
  aggregate,
  as,
  asc,
  avg,
  clauses,
  count,
  desc,
  eq,
  field,
  from,
  join,
  leftJoin,
  limit,
  max,
  maybe,
  min,
  pipe,
  project,
  sort,
  sum,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  numberField,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { createSeededRandom, type SeededRandom } from './fuzz-helpers.js';

export type ProbabilityUserRow = {
  readonly id: string;
  readonly handle: string;
  readonly reputation: number;
  readonly active: boolean;
};

export type ProbabilityMarketRow = {
  readonly id: string;
  readonly topic: string;
  readonly category: string;
  readonly status: string;
  readonly closesAt: number;
  readonly liquidity: number;
};

export type ProbabilityForecastRow = {
  readonly id: string;
  readonly marketId: string;
  readonly userId: string;
  readonly probability: number;
  readonly weight: number;
  readonly active: boolean;
};

export type ProbabilityPositionRow = {
  readonly userId: string;
  readonly marketId: string;
  readonly shares: number;
  readonly exposure: number;
};

export type ProbabilityCommentRow = {
  readonly id: string;
  readonly marketId: string;
  readonly userId: string;
  readonly body: string;
  readonly hidden: boolean;
  readonly createdAt: number;
};

export type ProbabilityWatchlistRow = {
  readonly userId: string;
  readonly marketId: string;
  readonly pinned: boolean;
};

export type ProbabilityAuditEventRow = {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: number;
};

export type ProbabilityWorkloadData = {
  readonly probabilityUsers: readonly ProbabilityUserRow[];
  readonly probabilityMarkets: readonly ProbabilityMarketRow[];
  readonly probabilityForecasts: readonly ProbabilityForecastRow[];
  readonly probabilityPositions: readonly ProbabilityPositionRow[];
  readonly probabilityComments: readonly ProbabilityCommentRow[];
  readonly probabilityWatchlist: readonly ProbabilityWatchlistRow[];
  readonly probabilityAuditEvents: readonly ProbabilityAuditEventRow[];
};

export type ProbabilityWorkloadSize = {
  readonly users: number;
  readonly markets: number;
  readonly forecasts: number;
  readonly positions: number;
  readonly comments: number;
  readonly watchlist: number;
};

export type ProbabilityWorkloadQueries = ReturnType<typeof probabilityWorkloadQueries>;
export type ProbabilityWorkloadQueryBatch = ReturnType<typeof probabilityWorkloadQueryBatch>;
export type ProbabilityWorkloadPatch = {
  readonly label: string;
  readonly relation: keyof ProbabilityWorkloadData;
  readonly patch: WritePatch;
};
type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;

export const probabilityWorkloadSchema = defineSchema({
  probabilityUsers: relation<ProbabilityUserRow>({
    key: 'id',
    fields: {
      id: idField('probability.user'),
      handle: stringField(),
      reputation: numberField(),
      active: booleanField()
    }
  }),
  probabilityMarkets: relation<ProbabilityMarketRow>({
    key: 'id',
    fields: {
      id: idField('probability.market'),
      topic: stringField(),
      category: stringField(),
      status: stringField(),
      closesAt: numberField(),
      liquidity: numberField()
    }
  }),
  probabilityForecasts: relation<ProbabilityForecastRow>({
    key: 'id',
    fields: {
      id: idField('probability.forecast'),
      marketId: refField('probabilityMarkets.id'),
      userId: refField('probabilityUsers.id'),
      probability: numberField(),
      weight: numberField(),
      active: booleanField()
    }
  }),
  probabilityPositions: relation<ProbabilityPositionRow, readonly ['userId', 'marketId']>({
    key: ['userId', 'marketId'] as const,
    fields: {
      userId: refField('probabilityUsers.id'),
      marketId: refField('probabilityMarkets.id'),
      shares: numberField(),
      exposure: numberField()
    }
  }),
  probabilityComments: relation<ProbabilityCommentRow>({
    key: 'id',
    fields: {
      id: idField('probability.comment'),
      marketId: refField('probabilityMarkets.id'),
      userId: refField('probabilityUsers.id'),
      body: stringField(),
      hidden: booleanField(),
      createdAt: numberField()
    }
  }),
  probabilityWatchlist: relation<ProbabilityWatchlistRow, readonly ['userId', 'marketId']>({
    key: ['userId', 'marketId'] as const,
    fields: {
      userId: refField('probabilityUsers.id'),
      marketId: refField('probabilityMarkets.id'),
      pinned: booleanField()
    }
  }),
  probabilityAuditEvents: relation<ProbabilityAuditEventRow>({
    key: 'id',
    fields: {
      id: idField('probability.auditEvent'),
      kind: stringField(),
      createdAt: numberField()
    }
  })
});

const probabilityUser = as(probabilityWorkloadSchema.probabilityUsers, 'probabilityUser');
const probabilityMarket = as(probabilityWorkloadSchema.probabilityMarkets, 'probabilityMarket');
const probabilityForecast = as(probabilityWorkloadSchema.probabilityForecasts, 'probabilityForecast');
const probabilityPosition = as(probabilityWorkloadSchema.probabilityPositions, 'probabilityPosition');
const probabilityComment = as(probabilityWorkloadSchema.probabilityComments, 'probabilityComment');
const probabilityWatchlist = as(probabilityWorkloadSchema.probabilityWatchlist, 'probabilityWatchlist');

export const defaultProbabilityWorkloadSize = {
  users: 16,
  markets: 32,
  forecasts: 384,
  positions: 192,
  comments: 256,
  watchlist: 128
} satisfies ProbabilityWorkloadSize;

export const benchmarkProbabilityWorkloadSize = {
  users: 64,
  markets: 256,
  forecasts: 8_192,
  positions: 4_096,
  comments: 4_096,
  watchlist: 1_024
} satisfies ProbabilityWorkloadSize;

export function probabilityWorkloadQueries(userId: string) {
  const activeForecastStatsByMarket = pipe(
    from(probabilityForecast),
    where(eq(probabilityForecast.row.active, value(true))),
    aggregateForecastsByMarket()
  );
  const forecastStats = as(activeForecastStatsByMarket, 'forecastStats');
  const activeMarketSummary = pipe(
    from(probabilityMarket),
    leftJoin(forecastStats, clauses<ProbabilityMarketRow, QueryRow<typeof activeForecastStatsByMarket>>({ id: 'marketId' })),
    where(eq(probabilityMarket.row.status, value('open'))),
    sort(desc(probabilityMarket.row.liquidity), asc(probabilityMarket.row.id)),
    project({
      marketId: probabilityMarket.row.id,
      topic: probabilityMarket.row.topic,
      category: probabilityMarket.row.category,
      liquidity: probabilityMarket.row.liquidity,
      forecastCount: maybe(forecastStats.row.forecastCount),
      avgProbability: maybe(forecastStats.row.avgProbability),
      lowProbability: maybe(forecastStats.row.lowProbability),
      highProbability: maybe(forecastStats.row.highProbability),
      totalWeight: maybe(forecastStats.row.totalWeight)
    })
  );
  const userPositionTotals = pipe(
    from(probabilityPosition),
    aggregatePositionsByUser()
  );
  const userLeaderboard = pipe(
    userPositionTotals,
    sort(desc(field<number>('row', 'totalExposure')), asc(field<string>('row', 'userId')))
  );
  const visibleCommentFeed = pipe(
    from(probabilityComment),
    where(eq(probabilityComment.row.hidden, value(false))),
    join(from(probabilityUser), clauses<ProbabilityCommentRow, ProbabilityUserRow>({ userId: 'id' })),
    join(from(probabilityMarket), clauses<ProbabilityCommentRow & ProbabilityUserRow, ProbabilityMarketRow>({ marketId: 'id' })),
    sort(desc(probabilityComment.row.createdAt), asc(probabilityComment.row.id)),
    limit(40),
    project({
      commentId: probabilityComment.row.id,
      marketId: probabilityMarket.row.id,
      topic: probabilityMarket.row.topic,
      userId: probabilityUser.row.id,
      handle: probabilityUser.row.handle,
      body: probabilityComment.row.body,
      createdAt: probabilityComment.row.createdAt
    })
  );
  const userWatchlist = pipe(
    from(probabilityWatchlist),
    where(eq(probabilityWatchlist.row.userId, value(userId))),
    leftJoin(from(probabilityMarket), clauses<ProbabilityWatchlistRow, ProbabilityMarketRow>({ marketId: 'id' })),
    sort(desc(probabilityWatchlist.row.pinned), asc(probabilityMarket.row.closesAt), asc(probabilityWatchlist.row.marketId)),
    project({
      userId: probabilityWatchlist.row.userId,
      marketId: probabilityWatchlist.row.marketId,
      pinned: probabilityWatchlist.row.pinned,
      topic: probabilityMarket.row.topic,
      status: probabilityMarket.row.status
    })
  );

  return {
    activeForecastStatsByMarket,
    activeMarketSummary,
    userPositionTotals,
    userLeaderboard,
    visibleCommentFeed,
    userWatchlist
  };
}

export function probabilityWorkloadQueryBatch(queries: ProbabilityWorkloadQueries) {
  return {
    activeMarketSummary: queries.activeMarketSummary,
    userLeaderboard: queries.userLeaderboard,
    visibleCommentFeed: queries.visibleCommentFeed,
    userWatchlist: queries.userWatchlist
  };
}

export function probabilityMaterializedQueries(queries: ProbabilityWorkloadQueries): readonly Query<unknown>[] {
  return [
    queries.activeForecastStatsByMarket as Query<unknown>,
    queries.userPositionTotals as Query<unknown>
  ];
}

export function makeProbabilityWorkloadData(
  seed: number,
  size: ProbabilityWorkloadSize = defaultProbabilityWorkloadSize
): ProbabilityWorkloadData {
  const random = createSeededRandom(seed ^ 0x9e37_79b9);
  const users = Array.from({ length: size.users }, (_, index): ProbabilityUserRow => ({
    id: probabilityUserId(index),
    handle: `user-${seed.toString(36)}-${index}`,
    reputation: 100 + ((seed + index * 17) % 900),
    active: index % 11 !== 0
  }));
  const markets = Array.from({ length: size.markets }, (_, index): ProbabilityMarketRow => ({
    id: probabilityMarketId(index),
    topic: `Will event ${seed.toString(36)}-${index} resolve yes?`,
    category: probabilityCategory(index),
    status: index % 7 === 0 ? 'closed' : 'open',
    closesAt: 1_800_000_000 + index * 3_600 + (seed % 1_000),
    liquidity: 1_000 + ((index * 15_485_863 + seed) % 250_000)
  }));
  const forecasts = Array.from({ length: size.forecasts }, (_, index): ProbabilityForecastRow => ({
    id: probabilityForecastId(index),
    marketId: probabilityMarketId(index % size.markets),
    userId: probabilityUserId((index * 13 + seed) % size.users),
    probability: probabilityValue(random, index),
    weight: 1 + ((index * 37 + seed) % 250),
    active: index % 9 !== 0
  }));
  const positions = uniqueCompositeRows(size.positions, size.users, size.markets, (index, userIndex, marketIndex): ProbabilityPositionRow => ({
    userId: probabilityUserId(userIndex),
    marketId: probabilityMarketId(marketIndex),
    shares: signedAmount(seed, index, 2_000),
    exposure: Math.abs(signedAmount(seed ^ 0x51a7, index, 25_000))
  }));
  const comments = Array.from({ length: size.comments }, (_, index): ProbabilityCommentRow => ({
    id: probabilityCommentId(index),
    marketId: probabilityMarketId((index * 7 + seed) % size.markets),
    userId: probabilityUserId((index * 5 + seed) % size.users),
    body: `comment-${seed.toString(36)}-${index}`,
    hidden: index % 13 === 0,
    createdAt: 1_800_000_000 + index * 17
  }));
  const watchlist = uniqueCompositeRows(size.watchlist, size.users, size.markets, (index, userIndex, marketIndex): ProbabilityWatchlistRow => ({
    userId: probabilityUserId(userIndex),
    marketId: probabilityMarketId(marketIndex),
    pinned: index % 5 === 0
  }));

  return {
    probabilityUsers: users,
    probabilityMarkets: markets,
    probabilityForecasts: forecasts,
    probabilityPositions: positions,
    probabilityComments: comments,
    probabilityWatchlist: watchlist,
    probabilityAuditEvents: [{ id: `audit-${seed}-0`, kind: 'seed', createdAt: 1_800_000_000 }]
  };
}

export function probabilityWorkloadPatchAt(
  seed: number,
  step: number,
  data: ProbabilityWorkloadData
): ProbabilityWorkloadPatch {
  const random = createSeededRandom(seed ^ Math.imul(step + 1, 0x45d9_f3b));
  switch (step % 7) {
    case 0:
      return forecastPatch(seed, step, random, data);
    case 1:
      return positionPatch(seed, step, data);
    case 2:
      return marketPatch(seed, step, data);
    case 3:
      return commentPatch(seed, step, data);
    case 4:
      return watchlistPatch(seed, step, data);
    case 5:
      return auditEventPatch(seed, step);
    default:
      return userPatch(seed, step, data);
  }
}

function aggregateForecastsByMarket() {
  return aggregate({
    groupBy: { marketId: probabilityForecast.row.marketId },
    aggregates: {
      forecastCount: count(),
      avgProbability: avg(probabilityForecast.row.probability),
      lowProbability: min(probabilityForecast.row.probability),
      highProbability: max(probabilityForecast.row.probability),
      totalWeight: sum(probabilityForecast.row.weight)
    }
  });
}

function aggregatePositionsByUser() {
  return aggregate({
    groupBy: { userId: probabilityPosition.row.userId },
    aggregates: {
      marketCount: count(),
      totalShares: sum(probabilityPosition.row.shares),
      totalExposure: sum(probabilityPosition.row.exposure)
    }
  });
}

function forecastPatch(
  seed: number,
  step: number,
  random: SeededRandom,
  data: ProbabilityWorkloadData
): ProbabilityWorkloadPatch {
  const current = data.probabilityForecasts[indexFor(step, data.probabilityForecasts.length, 17)];
  if (current === undefined) throw new Error('probability workload forecast set is empty');
  const row = {
    ...current,
    probability: probabilityValue(random, step),
    weight: 1 + ((seed + step * 19) % 500),
    active: step % 10 !== 0
  };
  return {
    label: 'forecast-update',
    relation: 'probabilityForecasts',
    patch: insertOrReplace(probabilityWorkloadSchema.probabilityForecasts, row)
  };
}

function positionPatch(seed: number, step: number, data: ProbabilityWorkloadData): ProbabilityWorkloadPatch {
  const current = data.probabilityPositions[indexFor(step, data.probabilityPositions.length, 31)];
  if (current === undefined) throw new Error('probability workload position set is empty');
  const row = {
    ...current,
    shares: signedAmount(seed, step, 3_000),
    exposure: Math.abs(signedAmount(seed ^ 0xa5a5, step, 50_000))
  };
  return {
    label: 'position-update',
    relation: 'probabilityPositions',
    patch: insertOrReplace(probabilityWorkloadSchema.probabilityPositions, row)
  };
}

function marketPatch(seed: number, step: number, data: ProbabilityWorkloadData): ProbabilityWorkloadPatch {
  const market = data.probabilityMarkets[indexFor(step, data.probabilityMarkets.length, 11)];
  if (market === undefined) throw new Error('probability workload market set is empty');
  return {
    label: 'market-update',
    relation: 'probabilityMarkets',
    patch: updateByKey(probabilityWorkloadSchema.probabilityMarkets, market.id, {
      status: step % 12 === 0 ? 'closed' : 'open',
      liquidity: 1_000 + ((seed + step * 104_729) % 500_000)
    })
  };
}

function commentPatch(seed: number, step: number, data: ProbabilityWorkloadData): ProbabilityWorkloadPatch {
  const market = data.probabilityMarkets[indexFor(step, data.probabilityMarkets.length, 23)];
  const user = data.probabilityUsers[indexFor(step, data.probabilityUsers.length, 29)];
  if (market === undefined || user === undefined) throw new Error('probability workload comment references are empty');
  return {
    label: 'comment-insert',
    relation: 'probabilityComments',
    patch: insertOrReplace(probabilityWorkloadSchema.probabilityComments, {
      id: `comment-live-${seed}-${step}`,
      marketId: market.id,
      userId: user.id,
      body: `live-comment-${seed.toString(36)}-${step}`,
      hidden: step % 17 === 0,
      createdAt: 1_900_000_000 + step
    })
  };
}

function watchlistPatch(seed: number, step: number, data: ProbabilityWorkloadData): ProbabilityWorkloadPatch {
  const user = data.probabilityUsers[indexFor(seed + step, data.probabilityUsers.length, 5)];
  const market = data.probabilityMarkets[indexFor(seed + step, data.probabilityMarkets.length, 7)];
  if (user === undefined || market === undefined) throw new Error('probability workload watchlist references are empty');
  const key = [user.id, market.id] as const;
  return {
    label: step % 8 === 4 ? 'watchlist-delete' : 'watchlist-upsert',
    relation: 'probabilityWatchlist',
    patch: step % 8 === 4
      ? deleteByKey(probabilityWorkloadSchema.probabilityWatchlist, key)
      : insertOrReplace(probabilityWorkloadSchema.probabilityWatchlist, {
        userId: user.id,
        marketId: market.id,
        pinned: step % 3 === 0
      })
  };
}

function auditEventPatch(seed: number, step: number): ProbabilityWorkloadPatch {
  return {
    label: 'audit-only',
    relation: 'probabilityAuditEvents',
    patch: insertOrReplace(probabilityWorkloadSchema.probabilityAuditEvents, {
      id: `audit-${seed}-${step}`,
      kind: step % 2 === 0 ? 'read' : 'write',
      createdAt: 1_900_100_000 + step
    })
  };
}

function userPatch(seed: number, step: number, data: ProbabilityWorkloadData): ProbabilityWorkloadPatch {
  const user = data.probabilityUsers[indexFor(step, data.probabilityUsers.length, 13)];
  if (user === undefined) throw new Error('probability workload user set is empty');
  return {
    label: 'user-update',
    relation: 'probabilityUsers',
    patch: updateByKey(probabilityWorkloadSchema.probabilityUsers, user.id, {
      handle: `${user.handle}-v${step}`,
      reputation: 100 + ((seed + step * 41) % 1_000),
      active: step % 19 !== 0
    })
  };
}

function uniqueCompositeRows<Row>(
  targetCount: number,
  userCount: number,
  marketCount: number,
  build: (index: number, userIndex: number, marketIndex: number) => Row
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (let index = 0; rows.length < targetCount && index < targetCount * 4; index += 1) {
    const userIndex = (index * 13) % userCount;
    const marketIndex = (index * 17 + Math.floor(index / Math.max(1, userCount))) % marketCount;
    const key = `${userIndex}:${marketIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(build(index, userIndex, marketIndex));
  }
  return rows;
}

function indexFor(step: number, length: number, multiplier: number): number {
  return length === 0 ? -1 : Math.abs(step * multiplier) % length;
}

function probabilityUserId(index: number): string {
  return `user-${index}`;
}

function probabilityMarketId(index: number): string {
  return `market-${index}`;
}

function probabilityForecastId(index: number): string {
  return `forecast-${index}`;
}

function probabilityCommentId(index: number): string {
  return `comment-${index}`;
}

function probabilityCategory(index: number): string {
  const categories = ['macro', 'policy', 'sports', 'culture', 'science', 'company'] as const;
  return categories[index % categories.length] ?? 'macro';
}

function probabilityValue(random: SeededRandom, index: number): number {
  const edge = index % 19;
  if (edge === 0) return 0;
  if (edge === 1) return 1;
  return Math.round(random() * 10_000) / 10_000;
}

function signedAmount(seed: number, index: number, range: number): number {
  const value = (seed + index * 7_919) % range;
  return index % 2 === 0 ? value : -value;
}
