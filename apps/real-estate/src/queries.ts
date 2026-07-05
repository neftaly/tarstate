import {
  agg,
  and,
  as,
  asc,
  avg,
  clauses,
  count,
  desc,
  eq,
  field,
  from,
  gte,
  join,
  leftJoin,
  lte,
  max,
  maybe,
  pipe,
  queryKey,
  select,
  sort,
  value,
  where,
  type PredicateData,
  type Query
} from '@tarstate/core/query';
import {
  agent,
  inquiry,
  listing,
  neighborhood,
  offer,
  viewing,
  type Agent,
  type InquiryStatus,
  type Listing,
  type ListingStatus,
  type Neighborhood,
  type OfferStatus,
  type PropertyType
} from './domain';

export type ListingFilters = {
  readonly status: ListingStatus | 'all';
  readonly neighborhoodId: string;
  readonly minBeds: number;
  readonly maxPrice: number;
};

export type ListingRow = {
  readonly id: string;
  readonly address: string;
  readonly neighborhoodId: string;
  readonly neighborhoodName: string;
  readonly city: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly brokerage: string;
  readonly propertyType: PropertyType;
  readonly price: number;
  readonly beds: number;
  readonly baths: number;
  readonly sqft: number;
  readonly status: ListingStatus;
};

export type MarketSummaryRow = {
  readonly neighborhoodId: string;
  readonly neighborhoodName: string;
  readonly city: string;
  readonly medianPrice: number;
  readonly walkScore: number;
  readonly listingCount: number | undefined;
  readonly activeCount: number | undefined;
  readonly averagePrice: number | undefined;
  readonly highestPrice: number | undefined;
};

export type PipelineRow = {
  readonly listingId: string;
  readonly address: string;
  readonly agentName: string;
  readonly status: ListingStatus;
  readonly price: number;
  readonly inquiryCount: number | undefined;
  readonly qualifiedInquiries: number | undefined;
  readonly offerCount: number | undefined;
  readonly topOffer: number | undefined;
};

export type ViewingScheduleRow = {
  readonly id: string;
  readonly listingId: string;
  readonly date: string;
  readonly time: string;
  readonly buyerName: string;
  readonly address: string;
  readonly neighborhoodName: string;
  readonly agentName: string;
  readonly status: string;
  readonly virtual: boolean;
};

export type InquiryQueueRow = {
  readonly id: string;
  readonly listingId: string;
  readonly buyerName: string;
  readonly address: string;
  readonly agentName: string;
  readonly budget: number;
  readonly status: InquiryStatus;
  readonly createdAt: string;
};

export type OfferBookRow = {
  readonly id: string;
  readonly listingId: string;
  readonly buyerName: string;
  readonly address: string;
  readonly listPrice: number;
  readonly amount: number;
  readonly status: OfferStatus;
  readonly submittedAt: string;
};

type ListingJoinRow = Listing & Agent & Neighborhood;
type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;

export const defaultListingFilters: ListingFilters = {
  status: 'active',
  neighborhoodId: 'all',
  minBeds: 2,
  maxPrice: 900000
};

export const allListingFilters: ListingFilters = {
  status: 'all',
  neighborhoodId: 'all',
  minBeds: 0,
  maxPrice: 2000000
};

const joinedListings = pipe(
  from(listing),
  join(from(agent), eq(listing.agentId, agent.id)),
  join(from(neighborhood), eq(listing.neighborhoodId, neighborhood.id))
) as Query<ListingJoinRow>;

export function listingListQuery(filters: ListingFilters): Query<ListingRow> {
  const predicates: PredicateData[] = [
    gte(listing.beds, value(filters.minBeds)),
    lte(listing.price, value(filters.maxPrice))
  ];

  if (filters.status !== 'all') predicates.push(eq(listing.status, value(filters.status)));
  if (filters.neighborhoodId !== 'all') predicates.push(eq(listing.neighborhoodId, value(filters.neighborhoodId)));

  return pipe(
    pipe(joinedListings, where(and(...predicates))),
    sort(asc(listing.price), asc(listing.id)),
    select({
      id: listing.id,
      address: listing.address,
      neighborhoodId: listing.neighborhoodId,
      neighborhoodName: neighborhood.$.name,
      city: neighborhood.city,
      agentId: agent.id,
      agentName: agent.$.name,
      brokerage: agent.brokerage,
      propertyType: listing.propertyType,
      price: listing.price,
      beds: listing.beds,
      baths: listing.baths,
      sqft: listing.sqft,
      status: listing.status
    })
  ) as Query<ListingRow>;
}

export const allListingsQuery = listingListQuery(allListingFilters);

const listingStatsByNeighborhood = pipe(
  from(listing),
  agg({
    groupBy: { neighborhoodId: listing.neighborhoodId },
    aggregates: {
      listingCount: count(),
      activeCount: count(eq(listing.status, value('active'))),
      averagePrice: avg(listing.price),
      highestPrice: max(listing.price)
    }
  }),
  select({
    neighborhoodId: field<string>('row', 'neighborhoodId'),
    listingCount: field<number>('row', 'listingCount'),
    activeCount: field<number>('row', 'activeCount'),
    averagePrice: field<number>('row', 'averagePrice'),
    highestPrice: field<number>('row', 'highestPrice')
  })
);

const marketStats = as(listingStatsByNeighborhood, 'marketStats');

export const marketSummaryQuery = pipe(
  from(neighborhood),
  leftJoin(marketStats, clauses<Neighborhood, QueryRow<typeof listingStatsByNeighborhood>>({ id: 'neighborhoodId' })),
  sort(asc(neighborhood.$.name), asc(neighborhood.id)),
  select({
    neighborhoodId: neighborhood.id,
    neighborhoodName: neighborhood.$.name,
    city: neighborhood.city,
    medianPrice: neighborhood.medianPrice,
    walkScore: neighborhood.walkScore,
    listingCount: maybe(marketStats.listingCount),
    activeCount: maybe(marketStats.activeCount),
    averagePrice: maybe(marketStats.averagePrice),
    highestPrice: maybe(marketStats.highestPrice)
  })
) as Query<MarketSummaryRow>;

const inquiryStats = pipe(
  from(inquiry),
  agg({
    groupBy: { listingId: inquiry.listingId },
    aggregates: {
      inquiryCount: count(),
      qualifiedInquiries: count(eq(inquiry.status, value('qualified')))
    }
  }),
  select({
    listingId: field<string>('row', 'listingId'),
    inquiryCount: field<number>('row', 'inquiryCount'),
    qualifiedInquiries: field<number>('row', 'qualifiedInquiries')
  })
);

const offerStats = pipe(
  from(offer),
  agg({
    groupBy: { listingId: offer.listingId },
    aggregates: {
      offerCount: count(),
      topOffer: max(offer.amount)
    }
  }),
  select({
    listingId: field<string>('row', 'listingId'),
    offerCount: field<number>('row', 'offerCount'),
    topOffer: field<number>('row', 'topOffer')
  })
);

const inquiriesByListing = as(inquiryStats, 'inquiriesByListing');
const offersByListing = as(offerStats, 'offersByListing');

export const pipelineByListingQuery = pipe(
  from(listing),
  join(from(agent), eq(listing.agentId, agent.id)),
  leftJoin(inquiriesByListing, clauses<Listing, QueryRow<typeof inquiryStats>>({ id: 'listingId' })),
  leftJoin(offersByListing, clauses<Listing, QueryRow<typeof offerStats>>({ id: 'listingId' })),
  sort(desc(listing.price), asc(listing.id)),
  select({
    listingId: listing.id,
    address: listing.address,
    agentName: agent.$.name,
    status: listing.status,
    price: listing.price,
    inquiryCount: maybe(inquiriesByListing.inquiryCount),
    qualifiedInquiries: maybe(inquiriesByListing.qualifiedInquiries),
    offerCount: maybe(offersByListing.offerCount),
    topOffer: maybe(offersByListing.topOffer)
  })
) as Query<PipelineRow>;

export const viewingScheduleQuery = pipe(
  from(viewing),
  join(from(listing), eq(viewing.listingId, listing.id)),
  join(from(agent), eq(viewing.agentId, agent.id)),
  join(from(neighborhood), eq(listing.neighborhoodId, neighborhood.id)),
  sort(asc(viewing.date), asc(viewing.time), asc(viewing.id)),
  select({
    id: viewing.id,
    listingId: viewing.listingId,
    date: viewing.date,
    time: viewing.time,
    buyerName: viewing.buyerName,
    address: listing.address,
    neighborhoodName: neighborhood.$.name,
    agentName: agent.$.name,
    status: viewing.status,
    virtual: viewing.virtual
  })
) as Query<ViewingScheduleRow>;

export const inquiryQueueQuery = pipe(
  from(inquiry),
  join(from(listing), eq(inquiry.listingId, listing.id)),
  join(from(agent), eq(inquiry.agentId, agent.id)),
  sort(desc(inquiry.createdAt), asc(inquiry.id)),
  select({
    id: inquiry.id,
    listingId: inquiry.listingId,
    buyerName: inquiry.buyerName,
    address: listing.address,
    agentName: agent.$.name,
    budget: inquiry.budget,
    status: inquiry.status,
    createdAt: inquiry.createdAt
  })
) as Query<InquiryQueueRow>;

export const offerBookQuery = pipe(
  from(offer),
  join(from(listing), eq(offer.listingId, listing.id)),
  sort(desc(offer.submittedAt), asc(offer.id)),
  select({
    id: offer.id,
    listingId: offer.listingId,
    buyerName: offer.buyerName,
    address: listing.address,
    listPrice: listing.price,
    amount: offer.amount,
    status: offer.status,
    submittedAt: offer.submittedAt
  })
) as Query<OfferBookRow>;

export const queryLabels = {
  listings: queryKey(listingListQuery(defaultListingFilters)),
  market: queryKey(marketSummaryQuery),
  pipeline: queryKey(pipelineByListingQuery),
  viewings: queryKey(viewingScheduleQuery)
} as const;
