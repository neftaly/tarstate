import { check, constrain, fk, req, unique } from '@tarstate/core/constraints';
import { gt, value } from '@tarstate/core/query';
import {
  as,
  booleanField,
  defineSchema,
  idField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core';
import { from } from '@tarstate/core/query';

export type ListingStatus = 'active' | 'under_contract' | 'sold' | 'paused';
export type PropertyType = 'condo' | 'townhouse' | 'single_family' | 'duplex';
export type InquiryStatus = 'new' | 'qualified' | 'tour_scheduled' | 'closed';
export type OfferStatus = 'draft' | 'submitted' | 'countered' | 'accepted' | 'rejected';
export type FinancingType = 'cash' | 'conventional' | 'fha' | 'jumbo';

export type Neighborhood = {
  readonly id: string;
  readonly name: string;
  readonly borough: string;
  readonly medianPrice: number;
  readonly medianRent: number;
  readonly walkScore: number;
  readonly schoolScore: number;
  readonly inventory: number;
  readonly daysOnMarket: number;
};

export type Agent = {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly licenseTier: string;
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
  readonly bedrooms: number;
  readonly bathrooms: number;
  readonly sqft: number;
  readonly status: ListingStatus;
  readonly listedAt: string;
};

export type OpenHouse = {
  readonly id: string;
  readonly listingId: string;
  readonly hostAgentId: string;
  readonly date: string;
  readonly startsAt: string;
  readonly expectedVisitors: number;
  readonly brokerOnly: boolean;
};

export type Inquiry = {
  readonly id: string;
  readonly listingId: string;
  readonly agentId: string;
  readonly buyerName: string;
  readonly budget: number;
  readonly financing: FinancingType;
  readonly status: InquiryStatus;
  readonly createdAt: string;
  readonly notes?: string | null;
};

export type Offer = {
  readonly id: string;
  readonly listingId: string;
  readonly buyerName: string;
  readonly amount: number;
  readonly financing: FinancingType;
  readonly contingencies?: string | null;
  readonly status: OfferStatus;
  readonly submittedAt: string;
};

export const schema = defineSchema({
  neighborhoods: relation<Neighborhood>({
    key: 'id',
    fields: {
      id: idField('neighborhood'),
      name: stringField(),
      borough: stringField(),
      medianPrice: numberField(),
      medianRent: numberField(),
      walkScore: numberField(),
      schoolScore: numberField(),
      inventory: numberField(),
      daysOnMarket: numberField()
    }
  }),
  agents: relation<Agent>({
    key: 'id',
    fields: {
      id: idField('agent'),
      name: stringField(),
      team: stringField(),
      licenseTier: stringField(),
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
      bedrooms: numberField(),
      bathrooms: numberField(),
      sqft: numberField(),
      status: stringField(),
      listedAt: stringField()
    }
  }),
  openHouses: relation<OpenHouse>({
    key: 'id',
    fields: {
      id: idField('open-house'),
      listingId: refField('listings.id'),
      hostAgentId: refField('agents.id'),
      date: stringField(),
      startsAt: stringField(),
      expectedVisitors: numberField(),
      brokerOnly: booleanField()
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
      financing: stringField(),
      status: stringField(),
      createdAt: stringField(),
      notes: optional(nullable(stringField()))
    }
  }),
  offers: relation<Offer>({
    key: 'id',
    fields: {
      id: idField('offer'),
      listingId: refField('listings.id'),
      buyerName: stringField(),
      amount: numberField(),
      financing: stringField(),
      contingencies: optional(nullable(stringField())),
      status: stringField(),
      submittedAt: stringField()
    }
  })
});

export const neighborhood = as(schema.neighborhoods, 'neighborhood');
export const agent = as(schema.agents, 'agent');
export const listing = as(schema.listings, 'listing');
export const openHouse = as(schema.openHouses, 'openHouse');
export const inquiry = as(schema.inquiries, 'inquiry');
export const offer = as(schema.offers, 'offer');

export const neighborhoods = [
  {
    id: 'nh-capitol-hill',
    name: 'Capitol Hill',
    borough: 'Central',
    medianPrice: 865000,
    medianRent: 3150,
    walkScore: 96,
    schoolScore: 82,
    inventory: 27,
    daysOnMarket: 18
  },
  {
    id: 'nh-ballard',
    name: 'Ballard',
    borough: 'Northwest',
    medianPrice: 925000,
    medianRent: 2950,
    walkScore: 88,
    schoolScore: 86,
    inventory: 19,
    daysOnMarket: 22
  },
  {
    id: 'nh-columbia-city',
    name: 'Columbia City',
    borough: 'Southeast',
    medianPrice: 735000,
    medianRent: 2600,
    walkScore: 84,
    schoolScore: 79,
    inventory: 31,
    daysOnMarket: 26
  },
  {
    id: 'nh-queen-anne',
    name: 'Queen Anne',
    borough: 'Uptown',
    medianPrice: 1120000,
    medianRent: 3400,
    walkScore: 91,
    schoolScore: 90,
    inventory: 14,
    daysOnMarket: 20
  },
  {
    id: 'nh-west-seattle',
    name: 'West Seattle',
    borough: 'West',
    medianPrice: 805000,
    medianRent: 2750,
    walkScore: 76,
    schoolScore: 84,
    inventory: 24,
    daysOnMarket: 29
  }
] as const satisfies readonly Neighborhood[];

export const agents = [
  {
    id: 'agent-mara',
    name: 'Mara Chen',
    team: 'Urban Core',
    licenseTier: 'principal broker',
    neighborhoodId: 'nh-capitol-hill',
    phone: '(206) 555-0141'
  },
  {
    id: 'agent-omar',
    name: 'Omar Reyes',
    team: 'Sound Homes',
    licenseTier: 'managing broker',
    neighborhoodId: 'nh-ballard',
    phone: '(206) 555-0184'
  },
  {
    id: 'agent-ivy',
    name: 'Ivy Patel',
    team: 'South Link',
    licenseTier: 'broker',
    neighborhoodId: 'nh-columbia-city',
    phone: '(206) 555-0169'
  },
  {
    id: 'agent-nell',
    name: 'Nell Brooks',
    team: 'Hilltop Advisory',
    licenseTier: 'principal broker',
    neighborhoodId: 'nh-queen-anne',
    phone: '(206) 555-0118'
  },
  {
    id: 'agent-eli',
    name: 'Eli Morgan',
    team: 'Harbor West',
    licenseTier: 'broker',
    neighborhoodId: 'nh-west-seattle',
    phone: '(206) 555-0197'
  },
  {
    id: 'agent-jules',
    name: 'Jules Avery',
    team: 'Urban Core',
    licenseTier: 'broker',
    neighborhoodId: 'nh-capitol-hill',
    phone: '(206) 555-0132'
  }
] as const satisfies readonly Agent[];

export const listings = [
  {
    id: 'listing-pine-402',
    address: '402 E Pine St #603',
    neighborhoodId: 'nh-capitol-hill',
    agentId: 'agent-mara',
    propertyType: 'condo',
    price: 684000,
    bedrooms: 2,
    bathrooms: 2,
    sqft: 1040,
    status: 'active',
    listedAt: '2026-06-12'
  },
  {
    id: 'listing-15th-782',
    address: '782 NW 15th Ave',
    neighborhoodId: 'nh-ballard',
    agentId: 'agent-omar',
    propertyType: 'townhouse',
    price: 925000,
    bedrooms: 3,
    bathrooms: 2.5,
    sqft: 1610,
    status: 'active',
    listedAt: '2026-06-24'
  },
  {
    id: 'listing-ferdinand-1918',
    address: '1918 S Ferdinand St',
    neighborhoodId: 'nh-columbia-city',
    agentId: 'agent-ivy',
    propertyType: 'single_family',
    price: 812000,
    bedrooms: 4,
    bathrooms: 2,
    sqft: 1880,
    status: 'under_contract',
    listedAt: '2026-05-29'
  },
  {
    id: 'listing-roy-717',
    address: '717 W Roy St',
    neighborhoodId: 'nh-queen-anne',
    agentId: 'agent-nell',
    propertyType: 'duplex',
    price: 1285000,
    bedrooms: 5,
    bathrooms: 3,
    sqft: 2830,
    status: 'active',
    listedAt: '2026-06-18'
  },
  {
    id: 'listing-california-4512',
    address: '4512 California Ave SW',
    neighborhoodId: 'nh-west-seattle',
    agentId: 'agent-eli',
    propertyType: 'townhouse',
    price: 745000,
    bedrooms: 3,
    bathrooms: 2.5,
    sqft: 1515,
    status: 'paused',
    listedAt: '2026-06-04'
  },
  {
    id: 'listing-10th-1220',
    address: '1220 10th Ave E',
    neighborhoodId: 'nh-capitol-hill',
    agentId: 'agent-jules',
    propertyType: 'single_family',
    price: 1095000,
    bedrooms: 4,
    bathrooms: 2.5,
    sqft: 2140,
    status: 'active',
    listedAt: '2026-06-27'
  },
  {
    id: 'listing-market-2041',
    address: '2041 NW Market St #7',
    neighborhoodId: 'nh-ballard',
    agentId: 'agent-omar',
    propertyType: 'condo',
    price: 589000,
    bedrooms: 1,
    bathrooms: 1,
    sqft: 825,
    status: 'sold',
    listedAt: '2026-05-16'
  },
  {
    id: 'listing-hudson-3310',
    address: '3310 S Hudson St',
    neighborhoodId: 'nh-columbia-city',
    agentId: 'agent-ivy',
    propertyType: 'townhouse',
    price: 698000,
    bedrooms: 3,
    bathrooms: 2.5,
    sqft: 1425,
    status: 'active',
    listedAt: '2026-07-01'
  }
] as const satisfies readonly Listing[];

export const openHouses = [
  {
    id: 'oh-pine-1',
    listingId: 'listing-pine-402',
    hostAgentId: 'agent-mara',
    date: '2026-07-05',
    startsAt: '13:00',
    expectedVisitors: 18,
    brokerOnly: false
  },
  {
    id: 'oh-15th-1',
    listingId: 'listing-15th-782',
    hostAgentId: 'agent-omar',
    date: '2026-07-06',
    startsAt: '11:30',
    expectedVisitors: 24,
    brokerOnly: false
  },
  {
    id: 'oh-roy-1',
    listingId: 'listing-roy-717',
    hostAgentId: 'agent-nell',
    date: '2026-07-07',
    startsAt: '10:00',
    expectedVisitors: 12,
    brokerOnly: true
  },
  {
    id: 'oh-hudson-1',
    listingId: 'listing-hudson-3310',
    hostAgentId: 'agent-ivy',
    date: '2026-07-08',
    startsAt: '16:00',
    expectedVisitors: 21,
    brokerOnly: false
  }
] as const satisfies readonly OpenHouse[];

export const inquiries = [
  {
    id: 'inq-aubrey',
    listingId: 'listing-pine-402',
    agentId: 'agent-mara',
    buyerName: 'Aubrey Stone',
    budget: 725000,
    financing: 'conventional',
    status: 'tour_scheduled',
    createdAt: '2026-06-28',
    notes: 'Needs secure parking.'
  },
  {
    id: 'inq-lina',
    listingId: 'listing-15th-782',
    agentId: 'agent-omar',
    buyerName: 'Lina Park',
    budget: 940000,
    financing: 'jumbo',
    status: 'qualified',
    createdAt: '2026-06-30',
    notes: 'Prefers south-facing office.'
  },
  {
    id: 'inq-noah',
    listingId: 'listing-hudson-3310',
    agentId: 'agent-ivy',
    buyerName: 'Noah Diaz',
    budget: 715000,
    financing: 'fha',
    status: 'new',
    createdAt: '2026-07-02',
    notes: null
  }
] as const satisfies readonly Inquiry[];

export const offers = [
  {
    id: 'offer-ferdinand-1',
    listingId: 'listing-ferdinand-1918',
    buyerName: 'Priya Iyer',
    amount: 806000,
    financing: 'conventional',
    contingencies: 'Inspection and financing',
    status: 'accepted',
    submittedAt: '2026-06-22'
  },
  {
    id: 'offer-pine-1',
    listingId: 'listing-pine-402',
    buyerName: 'Aubrey Stone',
    amount: 672000,
    financing: 'conventional',
    contingencies: 'Inspection',
    status: 'submitted',
    submittedAt: '2026-07-01'
  },
  {
    id: 'offer-roy-1',
    listingId: 'listing-roy-717',
    buyerName: 'Marcus Bell',
    amount: 1240000,
    financing: 'cash',
    contingencies: null,
    status: 'countered',
    submittedAt: '2026-07-02'
  }
] as const satisfies readonly Offer[];

export type RealEstateSeed = {
  readonly neighborhoods: readonly Neighborhood[];
  readonly agents: readonly Agent[];
  readonly listings: readonly Listing[];
  readonly openHouses: readonly OpenHouse[];
  readonly inquiries: readonly Inquiry[];
  readonly offers: readonly Offer[];
};

export function makeRealEstateSeed(includeInvalidRows: boolean): RealEstateSeed {
  if (!includeInvalidRows) {
    return {
      neighborhoods,
      agents,
      listings,
      openHouses,
      inquiries,
      offers
    };
  }

  return {
    neighborhoods,
    agents,
    listings: [
      ...listings,
      {
        id: 'listing-import-bad',
        address: 'Imported row without price',
        neighborhoodId: 'nh-missing',
        agentId: 'agent-missing',
        propertyType: 'condo',
        bedrooms: 2,
        bathrooms: 1,
        sqft: 790,
        status: 'active',
        listedAt: '2026-07-03'
      } as never
    ],
    openHouses,
    inquiries: [
      ...inquiries,
      {
        id: 'inq-import-bad',
        listingId: 'listing-pine-402',
        agentId: 'agent-mara',
        buyerName: 'Malformed Import',
        budget: 'unknown',
        financing: 'cash',
        status: 'new',
        createdAt: '2026-07-03'
      } as never
    ],
    offers
  };
}

export const realEstateConstraints = constrain(
  req(schema.neighborhoods, 'id', 'name', 'medianPrice', 'inventory', 'daysOnMarket'),
  req(schema.agents, 'id', 'name', 'team', 'neighborhoodId'),
  req(schema.listings, 'id', 'address', 'neighborhoodId', 'agentId', 'price', 'bedrooms', 'status'),
  req(schema.openHouses, 'id', 'listingId', 'hostAgentId', 'date', 'startsAt'),
  req(schema.inquiries, 'id', 'listingId', 'agentId', 'buyerName', 'budget', 'status'),
  req(schema.offers, 'id', 'listingId', 'buyerName', 'amount', 'status'),
  unique(schema.neighborhoods, 'id'),
  unique(schema.agents, 'id'),
  unique(schema.listings, 'id'),
  unique(schema.openHouses, 'id'),
  unique(schema.inquiries, 'id'),
  unique(schema.offers, 'id'),
  fk(schema.agents, 'neighborhoodId', schema.neighborhoods, 'id'),
  fk(schema.listings, 'neighborhoodId', schema.neighborhoods, 'id'),
  fk(schema.listings, 'agentId', schema.agents, 'id'),
  fk(schema.openHouses, 'listingId', schema.listings, 'id'),
  fk(schema.openHouses, 'hostAgentId', schema.agents, 'id'),
  fk(schema.inquiries, 'listingId', schema.listings, 'id'),
  fk(schema.inquiries, 'agentId', schema.agents, 'id'),
  fk(schema.offers, 'listingId', schema.listings, 'id'),
  check(from(listing), gt(listing.price, value(0))),
  check(from(listing), gt(listing.sqft, value(0))),
  check(from(inquiry), gt(inquiry.budget, value(0))),
  check(from(offer), gt(offer.amount, value(0)))
);

export const listingStatuses = ['active', 'under_contract', 'sold', 'paused'] as const satisfies readonly ListingStatus[];
export const propertyTypes = ['condo', 'townhouse', 'single_family', 'duplex'] as const satisfies readonly PropertyType[];
export const inquiryStatuses = ['new', 'qualified', 'tour_scheduled', 'closed'] as const satisfies readonly InquiryStatus[];
export const offerStatuses = ['draft', 'submitted', 'countered', 'accepted', 'rejected'] as const satisfies readonly OfferStatus[];
export const financingTypes = ['cash', 'conventional', 'fha', 'jumbo'] as const satisfies readonly FinancingType[];
