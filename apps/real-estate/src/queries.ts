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
  type ListingStatusValue,
  type Neighborhood,
  type NeighborhoodId,
  type OfferStatus,
  type PropertyType,
  type ViewingStatus
} from './domain';

export type ListingFilters = {
  readonly status: ListingStatusValue | 'all';
  readonly neighborhoodId: NeighborhoodId | 'all';
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
  readonly status: ViewingStatus;
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
  join(from(agent), eq(listing.row.agentId, agent.row.id)),
  join(from(neighborhood), eq(listing.row.neighborhoodId, neighborhood.row.id))
) satisfies Query<ListingJoinRow>;

function listingFilterPredicates(filters: ListingFilters): readonly PredicateData[] {
  return [
    gte(listing.row.beds, value(filters.minBeds)),
    lte(listing.row.price, value(filters.maxPrice)),
    ...(filters.status === 'all' ? [] : [eq(listing.row.status, value(filters.status))]),
    ...(filters.neighborhoodId === 'all' ? [] : [eq(listing.row.neighborhoodId, value(filters.neighborhoodId))])
  ];
}

export function listingListQuery(filters: ListingFilters): Query<ListingRow> {
  const predicates = listingFilterPredicates(filters);

  const query = pipe(
    pipe(joinedListings, where(and(...predicates))),
    sort(asc(listing.row.price), asc(listing.row.id)),
    select({
      id: listing.row.id,
      address: listing.row.address,
      neighborhoodId: listing.row.neighborhoodId,
      neighborhoodName: neighborhood.row.name,
      city: neighborhood.row.city,
      agentId: agent.row.id,
      agentName: agent.row.name,
      brokerage: agent.row.brokerage,
      propertyType: listing.row.propertyType,
      price: listing.row.price,
      beds: listing.row.beds,
      baths: listing.row.baths,
      sqft: listing.row.sqft,
      status: listing.row.status
    })
  ) satisfies Query<ListingRow>;

  return query;
}

export const allListingsQuery = listingListQuery(allListingFilters);

const listingStatsByNeighborhood = pipe(
  from(listing),
  agg({
    groupBy: { neighborhoodId: listing.row.neighborhoodId },
    aggregates: {
      listingCount: count(),
      activeCount: count(eq(listing.row.status, value('active'))),
      averagePrice: avg(listing.row.price),
      highestPrice: max(listing.row.price)
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
  sort(asc(neighborhood.row.name), asc(neighborhood.row.id)),
  select({
    neighborhoodId: neighborhood.row.id,
    neighborhoodName: neighborhood.row.name,
    city: neighborhood.row.city,
    medianPrice: neighborhood.row.medianPrice,
    walkScore: neighborhood.row.walkScore,
    listingCount: maybe(marketStats.row.listingCount),
    activeCount: maybe(marketStats.row.activeCount),
    averagePrice: maybe(marketStats.row.averagePrice),
    highestPrice: maybe(marketStats.row.highestPrice)
  })
) satisfies Query<MarketSummaryRow>;

const inquiryStats = pipe(
  from(inquiry),
  agg({
    groupBy: { listingId: inquiry.row.listingId },
    aggregates: {
      inquiryCount: count(),
      qualifiedInquiries: count(eq(inquiry.row.status, value('qualified')))
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
    groupBy: { listingId: offer.row.listingId },
    aggregates: {
      offerCount: count(),
      topOffer: max(offer.row.amount)
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
  join(from(agent), eq(listing.row.agentId, agent.row.id)),
  leftJoin(inquiriesByListing, clauses<Listing, QueryRow<typeof inquiryStats>>({ id: 'listingId' })),
  leftJoin(offersByListing, clauses<Listing, QueryRow<typeof offerStats>>({ id: 'listingId' })),
  sort(desc(listing.row.price), asc(listing.row.id)),
  select({
    listingId: listing.row.id,
    address: listing.row.address,
    agentName: agent.row.name,
    status: listing.row.status,
    price: listing.row.price,
    inquiryCount: maybe(inquiriesByListing.row.inquiryCount),
    qualifiedInquiries: maybe(inquiriesByListing.row.qualifiedInquiries),
    offerCount: maybe(offersByListing.row.offerCount),
    topOffer: maybe(offersByListing.row.topOffer)
  })
) satisfies Query<PipelineRow>;

export const viewingScheduleQuery = pipe(
  from(viewing),
  join(from(listing), eq(viewing.row.listingId, listing.row.id)),
  join(from(agent), eq(viewing.row.agentId, agent.row.id)),
  join(from(neighborhood), eq(listing.row.neighborhoodId, neighborhood.row.id)),
  sort(asc(viewing.row.date), asc(viewing.row.time), asc(viewing.row.id)),
  select({
    id: viewing.row.id,
    listingId: viewing.row.listingId,
    date: viewing.row.date,
    time: viewing.row.time,
    buyerName: viewing.row.buyerName,
    address: listing.row.address,
    neighborhoodName: neighborhood.row.name,
    agentName: agent.row.name,
    status: viewing.row.status,
    virtual: viewing.row.virtual
  })
) satisfies Query<ViewingScheduleRow>;

export const inquiryQueueQuery = pipe(
  from(inquiry),
  join(from(listing), eq(inquiry.row.listingId, listing.row.id)),
  join(from(agent), eq(inquiry.row.agentId, agent.row.id)),
  sort(desc(inquiry.row.createdAt), asc(inquiry.row.id)),
  select({
    id: inquiry.row.id,
    listingId: inquiry.row.listingId,
    buyerName: inquiry.row.buyerName,
    address: listing.row.address,
    agentName: agent.row.name,
    budget: inquiry.row.budget,
    status: inquiry.row.status,
    createdAt: inquiry.row.createdAt
  })
) satisfies Query<InquiryQueueRow>;

export const offerBookQuery = pipe(
  from(offer),
  join(from(listing), eq(offer.row.listingId, listing.row.id)),
  sort(desc(offer.row.submittedAt), asc(offer.row.id)),
  select({
    id: offer.row.id,
    listingId: offer.row.listingId,
    buyerName: offer.row.buyerName,
    address: listing.row.address,
    listPrice: listing.row.price,
    amount: offer.row.amount,
    status: offer.row.status,
    submittedAt: offer.row.submittedAt
  })
) satisfies Query<OfferBookRow>;
