import {
  booleanField,
  defineSchema,
  idField,
  numberField,
  refField,
  relation,
  stringField,
  as
} from '@tarstate/core';
import { check, constrain, fk, req, unique } from '@tarstate/core/constraints';
import { from, gt, value } from '@tarstate/core/query';

export type ListingStatus = 'active' | 'under_contract' | 'sold';
export type PropertyType = 'condo' | 'townhouse' | 'single_family';
export type ViewingStatus = 'scheduled' | 'completed' | 'cancelled';
export type InquiryStatus = 'new' | 'qualified' | 'closed';
export type OfferStatus = 'draft' | 'submitted' | 'accepted' | 'rejected';

export type Neighborhood = {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly medianPrice: number;
  readonly walkScore: number;
};

export type Agent = {
  readonly id: string;
  readonly name: string;
  readonly brokerage: string;
  readonly neighborhoodId: string;
  readonly phone: string;
};

export type Listing = {
  readonly id: string;
  readonly address: string;
  readonly neighborhoodId: string;
  readonly agentId: string;
  readonly propertyType: PropertyType;
  readonly price: number;
  readonly beds: number;
  readonly baths: number;
  readonly sqft: number;
  readonly status: ListingStatus;
};

export type Viewing = {
  readonly id: string;
  readonly listingId: string;
  readonly agentId: string;
  readonly buyerName: string;
  readonly date: string;
  readonly time: string;
  readonly status: ViewingStatus;
  readonly virtual: boolean;
};

export type Inquiry = {
  readonly id: string;
  readonly listingId: string;
  readonly agentId: string;
  readonly buyerName: string;
  readonly budget: number;
  readonly status: InquiryStatus;
  readonly createdAt: string;
};

export type Offer = {
  readonly id: string;
  readonly listingId: string;
  readonly buyerName: string;
  readonly amount: number;
  readonly status: OfferStatus;
  readonly submittedAt: string;
};

export const schema = defineSchema({
  neighborhoods: relation<Neighborhood>({
    key: 'id',
    fields: {
      id: idField('neighborhood'),
      name: stringField(),
      city: stringField(),
      medianPrice: numberField(),
      walkScore: numberField()
    }
  }),
  agents: relation<Agent>({
    key: 'id',
    fields: {
      id: idField('agent'),
      name: stringField(),
      brokerage: stringField(),
      neighborhoodId: refField('neighborhoods.id'),
      phone: stringField()
    }
  }),
  listings: relation<Listing>({
    key: 'id',
    fields: {
      id: idField('listing'),
      address: stringField(),
      neighborhoodId: refField('neighborhoods.id'),
      agentId: refField('agents.id'),
      propertyType: stringField(),
      price: numberField(),
      beds: numberField(),
      baths: numberField(),
      sqft: numberField(),
      status: stringField()
    }
  }),
  viewings: relation<Viewing>({
    key: 'id',
    fields: {
      id: idField('viewing'),
      listingId: refField('listings.id'),
      agentId: refField('agents.id'),
      buyerName: stringField(),
      date: stringField(),
      time: stringField(),
      status: stringField(),
      virtual: booleanField()
    }
  }),
  inquiries: relation<Inquiry>({
    key: 'id',
    fields: {
      id: idField('inquiry'),
      listingId: refField('listings.id'),
      agentId: refField('agents.id'),
      buyerName: stringField(),
      budget: numberField(),
      status: stringField(),
      createdAt: stringField()
    }
  }),
  offers: relation<Offer>({
    key: 'id',
    fields: {
      id: idField('offer'),
      listingId: refField('listings.id'),
      buyerName: stringField(),
      amount: numberField(),
      status: stringField(),
      submittedAt: stringField()
    }
  })
});

export const neighborhood = as(schema.neighborhoods, 'neighborhood');
export const agent = as(schema.agents, 'agent');
export const listing = as(schema.listings, 'listing');
export const viewing = as(schema.viewings, 'viewing');
export const inquiry = as(schema.inquiries, 'inquiry');
export const offer = as(schema.offers, 'offer');

export const neighborhoods = [
  { id: 'nh-downtown', name: 'Downtown', city: 'Portland', medianPrice: 640000, walkScore: 96 },
  { id: 'nh-laurelhurst', name: 'Laurelhurst', city: 'Portland', medianPrice: 875000, walkScore: 82 },
  { id: 'nh-sellwood', name: 'Sellwood', city: 'Portland', medianPrice: 720000, walkScore: 88 }
] as const satisfies readonly Neighborhood[];

export const agents = [
  { id: 'agent-lee', name: 'Nora Lee', brokerage: 'Bridge Realty', neighborhoodId: 'nh-downtown', phone: '503-555-0101' },
  { id: 'agent-singh', name: 'Arun Singh', brokerage: 'Northstar Homes', neighborhoodId: 'nh-laurelhurst', phone: '503-555-0114' },
  { id: 'agent-rivera', name: 'Maya Rivera', brokerage: 'River City Realty', neighborhoodId: 'nh-sellwood', phone: '503-555-0147' }
] as const satisfies readonly Agent[];

export const listings = [
  { id: 'listing-oak-101', address: '101 NW Oak St #804', neighborhoodId: 'nh-downtown', agentId: 'agent-lee', propertyType: 'condo', price: 595000, beds: 2, baths: 2, sqft: 1050, status: 'active' },
  { id: 'listing-ankeny-42', address: '42 SE Ankeny St', neighborhoodId: 'nh-downtown', agentId: 'agent-lee', propertyType: 'townhouse', price: 735000, beds: 3, baths: 2.5, sqft: 1640, status: 'under_contract' },
  { id: 'listing-floral-2807', address: '2807 NE Floral Pl', neighborhoodId: 'nh-laurelhurst', agentId: 'agent-singh', propertyType: 'single_family', price: 940000, beds: 4, baths: 3, sqft: 2480, status: 'active' },
  { id: 'listing-milwaukie-6718', address: '6718 SE Milwaukie Ave', neighborhoodId: 'nh-sellwood', agentId: 'agent-rivera', propertyType: 'townhouse', price: 689000, beds: 3, baths: 2.5, sqft: 1515, status: 'active' },
  { id: 'listing-claybourne-722', address: '722 SE Claybourne St', neighborhoodId: 'nh-sellwood', agentId: 'agent-rivera', propertyType: 'single_family', price: 815000, beds: 4, baths: 2, sqft: 1965, status: 'sold' }
] as const satisfies readonly Listing[];

export const viewings = [
  { id: 'viewing-oak-hart', listingId: 'listing-oak-101', agentId: 'agent-lee', buyerName: 'Iris Hart', date: '2026-07-08', time: '10:30', status: 'scheduled', virtual: false },
  { id: 'viewing-floral-kim', listingId: 'listing-floral-2807', agentId: 'agent-singh', buyerName: 'Jae Kim', date: '2026-07-08', time: '13:00', status: 'scheduled', virtual: true },
  { id: 'viewing-milwaukie-wells', listingId: 'listing-milwaukie-6718', agentId: 'agent-rivera', buyerName: 'Sam Wells', date: '2026-07-09', time: '15:30', status: 'completed', virtual: false },
  { id: 'viewing-ankeny-cho', listingId: 'listing-ankeny-42', agentId: 'agent-lee', buyerName: 'Min Cho', date: '2026-07-10', time: '12:00', status: 'cancelled', virtual: false }
] as const satisfies readonly Viewing[];

export const inquiries = [
  { id: 'inquiry-hart', listingId: 'listing-oak-101', agentId: 'agent-lee', buyerName: 'Iris Hart', budget: 625000, status: 'qualified', createdAt: '2026-07-01' },
  { id: 'inquiry-kim', listingId: 'listing-floral-2807', agentId: 'agent-singh', buyerName: 'Jae Kim', budget: 980000, status: 'new', createdAt: '2026-07-02' },
  { id: 'inquiry-wells', listingId: 'listing-milwaukie-6718', agentId: 'agent-rivera', buyerName: 'Sam Wells', budget: 710000, status: 'qualified', createdAt: '2026-07-03' }
] as const satisfies readonly Inquiry[];

export const offers = [
  { id: 'offer-ankeny-1', listingId: 'listing-ankeny-42', buyerName: 'Min Cho', amount: 728000, status: 'submitted', submittedAt: '2026-07-03' },
  { id: 'offer-oak-1', listingId: 'listing-oak-101', buyerName: 'Iris Hart', amount: 586000, status: 'draft', submittedAt: '2026-07-04' },
  { id: 'offer-claybourne-1', listingId: 'listing-claybourne-722', buyerName: 'Alex Morgan', amount: 820000, status: 'accepted', submittedAt: '2026-06-28' }
] as const satisfies readonly Offer[];

export type RealEstateSeed = {
  readonly neighborhoods: readonly Neighborhood[];
  readonly agents: readonly Agent[];
  readonly listings: readonly Listing[];
  readonly viewings: readonly Viewing[];
  readonly inquiries: readonly Inquiry[];
  readonly offers: readonly Offer[];
};

export function makeRealEstateSeed(): RealEstateSeed {
  return {
    neighborhoods,
    agents,
    listings,
    viewings,
    inquiries,
    offers
  };
}

export const realEstateConstraints = constrain(
  req(schema.neighborhoods, 'id', 'name', 'city', 'medianPrice'),
  req(schema.agents, 'id', 'name', 'brokerage', 'neighborhoodId'),
  req(schema.listings, 'id', 'address', 'neighborhoodId', 'agentId', 'price', 'beds', 'status'),
  req(schema.viewings, 'id', 'listingId', 'agentId', 'buyerName', 'date', 'time', 'status'),
  req(schema.inquiries, 'id', 'listingId', 'agentId', 'buyerName', 'budget', 'status'),
  req(schema.offers, 'id', 'listingId', 'buyerName', 'amount', 'status'),
  unique(schema.neighborhoods, 'id'),
  unique(schema.agents, 'id'),
  unique(schema.listings, 'id'),
  unique(schema.viewings, 'id'),
  unique(schema.inquiries, 'id'),
  unique(schema.offers, 'id'),
  fk(schema.agents, 'neighborhoodId', schema.neighborhoods, 'id'),
  fk(schema.listings, 'neighborhoodId', schema.neighborhoods, 'id'),
  fk(schema.listings, 'agentId', schema.agents, 'id'),
  fk(schema.viewings, 'listingId', schema.listings, 'id'),
  fk(schema.viewings, 'agentId', schema.agents, 'id'),
  fk(schema.inquiries, 'listingId', schema.listings, 'id'),
  fk(schema.inquiries, 'agentId', schema.agents, 'id'),
  fk(schema.offers, 'listingId', schema.listings, 'id'),
  check(from(listing), gt(listing.price, value(0))),
  check(from(listing), gt(listing.sqft, value(0))),
  check(from(inquiry), gt(inquiry.budget, value(0))),
  check(from(offer), gt(offer.amount, value(0)))
);

export const listingStatuses = ['active', 'under_contract', 'sold'] as const satisfies readonly ListingStatus[];
