import {
  agg,
  and,
  any,
  as,
  asc,
  avg,
  btree,
  clauses,
  count,
  desc,
  eq,
  field,
  from,
  gte,
  hash,
  join,
  leftJoin,
  lookup,
  lte,
  max,
  maybe,
  min,
  pipe,
  queryKey,
  select,
  sort,
  sortLimit,
  uniqueIndex,
  value,
  where,
  type PredicateData,
  type Query
} from '@tarstate/core/query';
import {
  agent,
  listing,
  neighborhood,
  offer,
  openHouse,
  inquiry,
  schema,
  type Agent,
  type Listing,
  type ListingStatus,
  type Neighborhood,
  type PropertyType
} from './domain';

export type ListingSort = 'price_asc' | 'price_desc' | 'newest';
export type ListingFilters = {
  readonly status: ListingStatus | 'all';
  readonly neighborhoodId: string;
  readonly propertyType: PropertyType | 'all';
  readonly maxPrice: number;
  readonly minBedrooms: number;
  readonly sort: ListingSort;
};

export type ListingResult = {
  readonly id: string;
  readonly address: string;
  readonly neighborhoodId: string;
  readonly neighborhoodName: string;
  readonly borough: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly team: string;
  readonly propertyType: PropertyType;
  readonly price: number;
  readonly bedrooms: number;
  readonly bathrooms: number;
  readonly sqft: number;
  readonly status: ListingStatus;
  readonly listedAt: string;
};

export type MarketSummaryRow = {
  readonly neighborhoodId: string;
  readonly neighborhoodName: string;
  readonly borough: string;
  readonly listingCount: number | undefined;
  readonly activeCount: number | undefined;
  readonly underContract: boolean | undefined;
  readonly avgPrice: number | undefined;
  readonly minPrice: number | undefined;
  readonly maxPrice: number | undefined;
  readonly medianPrice: number;
  readonly inventory: number;
  readonly daysOnMarket: number;
  readonly walkScore: number;
};

export type OpenHouseScheduleRow = {
  readonly id: string;
  readonly listingId: string;
  readonly address: string;
  readonly neighborhoodName: string;
  readonly hostAgent: string;
  readonly date: string;
  readonly startsAt: string;
  readonly expectedVisitors: number;
  readonly brokerOnly: boolean;
};

export type TopListingRow = {
  readonly id: string;
  readonly address: string;
  readonly neighborhoodName: string;
  readonly agentName: string;
  readonly price: number;
  readonly bedrooms: number;
  readonly status: ListingStatus;
};

export type PipelineRow = {
  readonly listingId: string;
  readonly address: string;
  readonly price: number;
  readonly agentName: string;
  readonly inquiryCount: number | undefined;
  readonly submittedOffers: number | undefined;
  readonly topOffer: number | undefined;
};

export type ListingIndexRow = {
  readonly id: string;
  readonly address: string;
  readonly neighborhoodId: string;
  readonly price: number;
  readonly bedrooms: number;
  readonly status: ListingStatus;
};

type ListingJoinRow = Listing & Agent & Neighborhood;

const joinedListings = pipe(
  from(listing),
  join(from(agent), eq(listing.agentId, agent.id)),
  join(from(neighborhood), eq(listing.neighborhoodId, neighborhood.id))
) as Query<ListingJoinRow>;

export const defaultFilters: ListingFilters = {
  status: 'active',
  neighborhoodId: 'all',
  propertyType: 'all',
  maxPrice: 1300000,
  minBedrooms: 1,
  sort: 'price_asc'
};

export function listingWalkthroughQuery(filters: ListingFilters): Query<ListingResult> {
  const predicates: PredicateData[] = [
    lte(listing.price, value(filters.maxPrice)),
    gte(listing.bedrooms, value(filters.minBedrooms))
  ];

  if (filters.status !== 'all') predicates.push(eq(listing.status, value(filters.status)));
  if (filters.neighborhoodId !== 'all') predicates.push(eq(listing.neighborhoodId, value(filters.neighborhoodId)));
  if (filters.propertyType !== 'all') predicates.push(eq(listing.propertyType, value(filters.propertyType)));

  const filtered = pipe(joinedListings, where(and(...predicates)));
  const sorted = pipe(
    filtered,
    filters.sort === 'price_desc'
      ? sort(desc(listing.price), asc(listing.id))
      : filters.sort === 'newest'
        ? sort(desc(listing.listedAt), asc(listing.id))
        : sort(asc(listing.price), asc(listing.id))
  );

  return pipe(
    sorted,
    select({
      id: listing.id,
      address: listing.address,
      neighborhoodId: listing.neighborhoodId,
      neighborhoodName: neighborhood.$.name,
      borough: neighborhood.borough,
      agentId: agent.id,
      agentName: agent.$.name,
      team: agent.team,
      propertyType: listing.propertyType,
      price: listing.price,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      sqft: listing.sqft,
      status: listing.status,
      listedAt: listing.listedAt
    })
  ) as Query<ListingResult>;
}

export function listingLookupQuery(id: string): Query<Listing> {
  return lookup(schema.listings, 'id', id);
}

const listingStatsByNeighborhood = pipe(
  from(listing),
  agg({
    groupBy: { neighborhoodId: listing.neighborhoodId },
    aggregates: {
      listingCount: count(),
      activeCount: count(eq(listing.status, value('active'))),
      underContract: any(eq(listing.status, value('under_contract'))),
      avgPrice: avg(listing.price),
      minPrice: min(listing.price),
      maxPrice: max(listing.price)
    }
  }),
  select({
    neighborhoodId: field<string>('row', 'neighborhoodId'),
    listingCount: field<number>('row', 'listingCount'),
    activeCount: field<number>('row', 'activeCount'),
    underContract: field<boolean>('row', 'underContract'),
    avgPrice: field<number>('row', 'avgPrice'),
    minPrice: field<number>('row', 'minPrice'),
    maxPrice: field<number>('row', 'maxPrice')
  })
);

const market = as(listingStatsByNeighborhood, 'market');

export const neighborhoodMarketSummaryQuery = pipe(
  from(neighborhood),
  leftJoin(market, clauses<Neighborhood, QueryRow<typeof listingStatsByNeighborhood>>({ id: 'neighborhoodId' })),
  sort(asc(neighborhood.$.name), asc(neighborhood.id)),
  select({
    neighborhoodId: neighborhood.id,
    neighborhoodName: neighborhood.$.name,
    borough: neighborhood.borough,
    listingCount: maybe(market.listingCount),
    activeCount: maybe(market.activeCount),
    underContract: maybe(market.underContract),
    avgPrice: maybe(market.avgPrice),
    minPrice: maybe(market.minPrice),
    maxPrice: maybe(market.maxPrice),
    medianPrice: neighborhood.medianPrice,
    inventory: neighborhood.inventory,
    daysOnMarket: neighborhood.daysOnMarket,
    walkScore: neighborhood.walkScore
  })
) as Query<MarketSummaryRow>;

export const openHouseScheduleQuery = openHouseJoinQuery(false);

export function openHouseJoinQuery(brokerOnly: boolean): Query<OpenHouseScheduleRow> {
  const joined = pipe(
    from(openHouse),
    join(from(listing), eq(openHouse.listingId, listing.id)),
    join(from(agent), eq(openHouse.hostAgentId, agent.id)),
    join(from(neighborhood), eq(listing.neighborhoodId, neighborhood.id))
  );
  const filtered = brokerOnly ? pipe(joined, where(eq(openHouse.brokerOnly, value(true)))) : joined;

  return pipe(
    filtered,
    sort(asc(openHouse.date), asc(openHouse.startsAt), asc(openHouse.id)),
    select({
      id: openHouse.id,
      listingId: openHouse.listingId,
      address: listing.address,
      neighborhoodName: neighborhood.$.name,
      hostAgent: agent.$.name,
      date: openHouse.date,
      startsAt: openHouse.startsAt,
      expectedVisitors: openHouse.expectedVisitors,
      brokerOnly: openHouse.brokerOnly
    })
  ) as Query<OpenHouseScheduleRow>;
}

export function topPricedListingsQuery(countValue: number, status: ListingStatus | 'all'): Query<TopListingRow> {
  const filtered = status === 'all'
    ? joinedListings
    : pipe(joinedListings, where(eq(listing.status, value(status))));

  return pipe(
    filtered,
    sortLimit(countValue, desc(listing.price), asc(listing.id)),
    select({
      id: listing.id,
      address: listing.address,
      neighborhoodName: neighborhood.$.name,
      agentName: agent.$.name,
      price: listing.price,
      bedrooms: listing.bedrooms,
      status: listing.status
    })
  ) as Query<TopListingRow>;
}

const inquiryCounts = pipe(
  from(inquiry),
  agg({
    groupBy: { listingId: inquiry.listingId },
    aggregates: { inquiryCount: count() }
  }),
  select({
    listingId: field<string>('row', 'listingId'),
    inquiryCount: field<number>('row', 'inquiryCount')
  })
);

const offerStats = pipe(
  from(offer),
  agg({
    groupBy: { listingId: offer.listingId },
    aggregates: {
      submittedOffers: count(),
      topOffer: max(offer.amount)
    }
  }),
  select({
    listingId: field<string>('row', 'listingId'),
    submittedOffers: field<number>('row', 'submittedOffers'),
    topOffer: field<number>('row', 'topOffer')
  })
);

const inquirySummary = as(inquiryCounts, 'inquirySummary');
const offerSummary = as(offerStats, 'offerSummary');

export const pipelineByListingQuery = pipe(
  from(listing),
  join(from(agent), eq(listing.agentId, agent.id)),
  leftJoin(inquirySummary, clauses<Listing, QueryRow<typeof inquiryCounts>>({ id: 'listingId' })),
  leftJoin(offerSummary, clauses<Listing, QueryRow<typeof offerStats>>({ id: 'listingId' })),
  sort(desc(listing.price), asc(listing.id)),
  select({
    listingId: listing.id,
    address: listing.address,
    price: listing.price,
    agentName: agent.$.name,
    inquiryCount: maybe(inquirySummary.inquiryCount),
    submittedOffers: maybe(offerSummary.submittedOffers),
    topOffer: maybe(offerSummary.topOffer)
  })
) as Query<PipelineRow>;

export const offerBookQuery = pipe(
  from(offer),
  join(from(listing), eq(offer.listingId, listing.id)),
  sort(desc(offer.submittedAt), asc(offer.id)),
  select({
    id: offer.id,
    listingId: offer.listingId,
    address: listing.address,
    buyerName: offer.buyerName,
    amount: offer.amount,
    financing: offer.financing,
    contingencies: maybe(offer.contingencies),
    status: offer.status,
    submittedAt: offer.submittedAt,
    listPrice: listing.price
  })
);

export const inquiryQueueQuery = pipe(
  from(inquiry),
  join(from(listing), eq(inquiry.listingId, listing.id)),
  join(from(agent), eq(inquiry.agentId, agent.id)),
  sort(desc(inquiry.createdAt), asc(inquiry.id)),
  select({
    id: inquiry.id,
    listingId: inquiry.listingId,
    address: listing.address,
    agentName: agent.$.name,
    buyerName: inquiry.buyerName,
    budget: inquiry.budget,
    financing: inquiry.financing,
    status: inquiry.status,
    createdAt: inquiry.createdAt,
    notes: maybe(inquiry.notes)
  })
);

export const listingIndexRows = pipe(
  from(listing),
  select({
    id: listing.id,
    address: listing.address,
    neighborhoodId: listing.neighborhoodId,
    price: listing.price,
    bedrooms: listing.bedrooms,
    status: listing.status
  })
) as Query<ListingIndexRow>;

export const listingsByNeighborhoodIndex = pipe(
  listingIndexRows,
  hash(field<string>('row', 'neighborhoodId'))
) as Query<ListingIndexRow>;

export const listingsByPriceIndex = pipe(
  listingIndexRows,
  btree(field<number>('row', 'price'))
) as Query<ListingIndexRow>;

export const listingsByIdIndex = pipe(
  listingIndexRows,
  uniqueIndex(field<string>('row', 'id'))
) as Query<ListingIndexRow>;

export const queryLabels = {
  listings: queryKey(listingWalkthroughQuery(defaultFilters)),
  market: queryKey(neighborhoodMarketSummaryQuery),
  openHouses: queryKey(openHouseScheduleQuery),
  pipeline: queryKey(pipelineByListingQuery),
  byNeighborhoodIndex: queryKey(listingsByNeighborhoodIndex),
  byPriceIndex: queryKey(listingsByPriceIndex)
} as const;

type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;
