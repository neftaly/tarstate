import * as Automerge from '@automerge/automerge';
import { createElement, useMemo, useState, type ReactElement } from 'react';
import { automergeDb, type AutomergeDb } from '@tarstate/automerge';
import {
  aggregate,
  and,
  as,
  asc,
  btree,
  check,
  constrain,
  count,
  db,
  desc,
  env,
  eq,
  field,
  fk,
  from,
  gt,
  gte,
  hash,
  insert,
  join,
  keyBy,
  leftJoin,
  lte,
  mat,
  max,
  maybe,
  or,
  pipe,
  project,
  qRows,
  req,
  sort,
  sum,
  unique,
  value,
  where,
  createStore,
  materializeSnapshot,
  type Db,
  type Query,
  type Store,
  type StoreCommitInput,
  type StoreCommitResult,
  type TarstateDiagnostic
} from '@tarstate/core';
import {
  booleanField,
  defineSchema,
  idField,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import {
  TarstateProvider,
  useCommit,
  useQuery,
  useView,
  useWatch
} from '@tarstate/react';

export type PriceBand = 'low' | 'med' | 'high' | 'premium';
export type SaleSpeed = 'very-fast' | 'fast' | 'medium' | 'slow' | 'very-slow';
export type ListingState = 'listed' | 'sold';
export type QueryExampleId =
  | 'propertyInfo'
  | 'currentOffers'
  | 'acceptedSales'
  | 'listingRows'
  | 'openOffers'
  | 'commissionDue';

export type AgentRow = {
  readonly id: string;
  readonly name: string;
};

export type BuyerRow = {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly areaCode: string;
};

export type PropertyRow = {
  readonly id: string;
  readonly address: string;
  readonly price: number;
  readonly agentId: string;
  readonly registeredAt: string;
  readonly photo: string;
  readonly areaCode: string;
  readonly priceBand: PriceBand;
};

export type RoomRow = {
  readonly id: string;
  readonly propertyId: string;
  readonly name: string;
  readonly width: number;
  readonly length: number;
  readonly squareFeet: number;
};

export type OfferRow = {
  readonly id: string;
  readonly propertyId: string;
  readonly buyerId: string;
  readonly offeredAt: string;
  readonly amount: number;
};

export type DecisionRow = {
  readonly id: string;
  readonly offerId: string;
  readonly decidedAt: string;
  readonly accepted: boolean;
  readonly saleSpeed: SaleSpeed;
};

export type CommissionRateRow = {
  readonly id: string;
  readonly priceBand: PriceBand;
  readonly areaCode: string;
  readonly saleSpeed: SaleSpeed;
  readonly commission: number;
};

export type PropertyInfoRow = {
  readonly id: string;
  readonly address: string;
  readonly price: number;
  readonly registeredAt: string;
  readonly photo: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly areaCode: string;
  readonly priceBand: PriceBand;
  readonly roomCount: number | undefined;
  readonly squareFeet: number | undefined;
};

export type OfferSummaryRow = {
  readonly id: string;
  readonly propertyId: string;
  readonly propertyAddress: string;
  readonly price: number;
  readonly buyerId: string;
  readonly buyerName: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly areaCode: string;
  readonly priceBand: PriceBand;
  readonly offeredAt: string;
  readonly amount: number;
  readonly decisionId: string | undefined;
  readonly decisionStatus: boolean | undefined | 'open';
};

export type AcceptedSaleRow = {
  readonly id: string;
  readonly offerId: string;
  readonly propertyId: string;
  readonly propertyAddress: string;
  readonly price: number;
  readonly buyerId: string;
  readonly buyerName: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly areaCode: string;
  readonly priceBand: PriceBand;
  readonly registeredAt: string;
  readonly decidedAt: string;
  readonly saleSpeed: SaleSpeed;
  readonly amount: number;
  readonly listingState: 'sold';
};

export type ListingRow = PropertyInfoRow & {
  readonly listingState: 'listed';
};

export type CommissionDueRow = {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly sales: number;
  readonly saleVolume: number;
  readonly commissionDue: number;
};

export type PropertyRoomStatsRow = {
  readonly propertyId: string;
  readonly roomCount: number;
  readonly squareFeet: number;
};

export type LatestOfferMarkRow = {
  readonly propertyId: string;
  readonly buyerId: string;
  readonly offeredAt: string;
};

export type PlaygroundRow =
  | PropertyInfoRow
  | OfferSummaryRow
  | AcceptedSaleRow
  | ListingRow
  | CommissionDueRow;

export type PlaygroundFilters = {
  readonly agentId?: string;
  readonly areaCode?: string;
  readonly priceBand?: string;
  readonly buyerId?: string;
  readonly listingState?: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
};

export type ReadableDiagnostic = {
  readonly code: string;
  readonly label: string;
  readonly relation: string;
  readonly field: string;
};

export type StoredRow<Row extends { readonly id: string }> = Omit<Row, 'id'> & {
  readonly id?: string;
};

export type RealEstateDocument = {
  readonly market: {
    readonly agents: Record<string, StoredRow<AgentRow>>;
    readonly buyers: Record<string, StoredRow<BuyerRow>>;
    readonly properties: Record<string, StoredRow<PropertyRow>>;
    readonly rooms: Record<string, StoredRow<RoomRow>>;
    readonly offers: Record<string, StoredRow<OfferRow>>;
    readonly decisions: Record<string, StoredRow<DecisionRow>>;
    readonly commissionRates: Record<string, StoredRow<CommissionRateRow>>;
  };
};

export type AutomergeRealEstateBacking = {
  readonly relic: AutomergeDb<RealEstateDocument>;
  readonly beforeHeads: readonly string[];
};

export type RealEstateModel = {
  readonly store: Store;
  readonly automerge: AutomergeRealEstateBacking;
};

export type RealEstateData = {
  readonly agents: readonly AgentRow[];
  readonly buyers: readonly BuyerRow[];
  readonly properties: readonly PropertyRow[];
  readonly rooms: readonly RoomRow[];
  readonly offers: readonly OfferRow[];
  readonly decisions: readonly DecisionRow[];
  readonly commissionRates: readonly CommissionRateRow[];
};

export const realEstateSchema = defineSchema({
  agents: relation<AgentRow>({
    key: 'id',
    fields: {
      id: idField('agent'),
      name: stringField()
    }
  }),
  buyers: relation<BuyerRow>({
    key: 'id',
    fields: {
      id: idField('buyer'),
      name: stringField(),
      address: stringField(),
      areaCode: stringField()
    }
  }),
  properties: relation<PropertyRow>({
    key: 'id',
    fields: {
      id: idField('property'),
      address: stringField(),
      price: numberField(),
      agentId: stringField(),
      registeredAt: stringField(),
      photo: stringField(),
      areaCode: stringField(),
      priceBand: stringField()
    }
  }),
  rooms: relation<RoomRow>({
    key: 'id',
    fields: {
      id: idField('room'),
      propertyId: stringField(),
      name: stringField(),
      width: numberField(),
      length: numberField(),
      squareFeet: numberField()
    }
  }),
  offers: relation<OfferRow>({
    key: 'id',
    fields: {
      id: idField('offer'),
      propertyId: stringField(),
      buyerId: stringField(),
      offeredAt: stringField(),
      amount: numberField()
    }
  }),
  decisions: relation<DecisionRow>({
    key: 'id',
    fields: {
      id: idField('decision'),
      offerId: stringField(),
      decidedAt: stringField(),
      accepted: booleanField(),
      saleSpeed: stringField()
    }
  }),
  commissionRates: relation<CommissionRateRow>({
    key: 'id',
    fields: {
      id: idField('commission-rate'),
      priceBand: stringField(),
      areaCode: stringField(),
      saleSpeed: stringField(),
      commission: numberField()
    }
  })
});

const agentRef = as(realEstateSchema.agents, 'agent');
const buyerRef = as(realEstateSchema.buyers, 'buyer');
const propertyRef = as(realEstateSchema.properties, 'property');
const roomRef = as(realEstateSchema.rooms, 'room');
const offerRef = as(realEstateSchema.offers, 'offer');
const decisionRef = as(realEstateSchema.decisions, 'decision');
const rateRef = as(realEstateSchema.commissionRates, 'rate');

const row = {
  agentId: field<string>('row', 'agentId'),
  areaCode: field<string>('row', 'areaCode'),
  priceBand: field<string>('row', 'priceBand'),
  buyerId: field<string>('row', 'buyerId'),
  listingState: field<string>('row', 'listingState'),
  price: field<number>('row', 'price')
};

export function priceBand(price: number): PriceBand {
  if (price <= 300000) return 'low';
  if (price <= 650000) return 'med';
  if (price <= 1000000) return 'high';
  return 'premium';
}

export function areaCode(address: string): string {
  return address.trim().split(/\s+/).at(-1) ?? '';
}

export function saleSpeed(registeredAt: string, decisionAt: string): SaleSpeed {
  const days = Math.floor((Date.parse(decisionAt) - Date.parse(registeredAt)) / 86_400_000);
  if (days <= 10) return 'very-fast';
  if (days <= 20) return 'fast';
  if (days <= 30) return 'medium';
  if (days <= 60) return 'slow';
  return 'very-slow';
}

export function seedRealEstateData(): RealEstateData {
  const properties: readonly PropertyRow[] = [
    propertyRow('property-elm', '12 Elm Street 55', 344000, 'agent-rose', '2021-10-26', 'elm.jpg'),
    propertyRow('property-harbour', '7 Harbour View 42', 920000, 'agent-bob', '2021-10-11', 'harbour.jpg'),
    propertyRow('property-mill', '3 Mill Lane 17', 1690000, 'agent-bob', '2021-10-27', 'mill.jpg'),
    propertyRow('property-garden', '18 Garden Road 55', 610000, 'agent-uma', '2021-10-18', 'garden.jpg')
  ];

  return {
    agents: [
      { id: 'agent-rose', name: 'Rose Patel' },
      { id: 'agent-bob', name: 'Bob Stone' },
      { id: 'agent-uma', name: 'Uma Reid' }
    ],
    buyers: [
      buyerRow('buyer-alice', 'Alice Hart', '42 Wonderland 42'),
      buyerRow('buyer-mia', 'Mia Chen', '9 Orchard 17'),
      buyerRow('buyer-nico', 'Nico Ford', '31 Station 55')
    ],
    properties,
    rooms: [
      roomRow('room-elm-living', 'property-elm', 'Living', 10, 10),
      roomRow('room-elm-kitchen', 'property-elm', 'Kitchen', 8, 7),
      roomRow('room-harbour-living', 'property-harbour', 'Living', 16, 12),
      roomRow('room-harbour-bedroom', 'property-harbour', 'Bedroom', 12, 10),
      roomRow('room-harbour-study', 'property-harbour', 'Study', 9, 8),
      roomRow('room-mill-showroom', 'property-mill', 'Showroom', 24, 18),
      roomRow('room-mill-office', 'property-mill', 'Office', 12, 9),
      roomRow('room-mill-store', 'property-mill', 'Store', 20, 16),
      roomRow('room-garden-living', 'property-garden', 'Living', 13, 11),
      roomRow('room-garden-kitchen', 'property-garden', 'Kitchen', 10, 8),
      roomRow('room-garden-bedroom', 'property-garden', 'Bedroom', 12, 11)
    ],
    offers: [
      { id: 'offer-elm-alice-1', propertyId: 'property-elm', buyerId: 'buyer-alice', offeredAt: '2021-10-26', amount: 330000 },
      { id: 'offer-elm-alice-2', propertyId: 'property-elm', buyerId: 'buyer-alice', offeredAt: '2021-10-27', amount: 343000 },
      { id: 'offer-harbour-mia-1', propertyId: 'property-harbour', buyerId: 'buyer-mia', offeredAt: '2021-10-20', amount: 900000 },
      { id: 'offer-garden-nico-1', propertyId: 'property-garden', buyerId: 'buyer-nico', offeredAt: '2021-10-21', amount: 595000 },
      { id: 'offer-garden-nico-2', propertyId: 'property-garden', buyerId: 'buyer-nico', offeredAt: '2021-10-24', amount: 612000 }
    ],
    decisions: [
      {
        id: 'decision-elm-accepted',
        offerId: 'offer-elm-alice-2',
        decidedAt: '2021-10-28',
        accepted: true,
        saleSpeed: saleSpeed('2021-10-26', '2021-10-28')
      },
      {
        id: 'decision-garden-rejected',
        offerId: 'offer-garden-nico-1',
        decidedAt: '2021-10-22',
        accepted: false,
        saleSpeed: saleSpeed('2021-10-18', '2021-10-22')
      }
    ],
    commissionRates: [
      { id: 'rate-med-55-fast', priceBand: 'med', areaCode: '55', saleSpeed: 'very-fast', commission: 2000 },
      { id: 'rate-med-55-medium', priceBand: 'med', areaCode: '55', saleSpeed: 'medium', commission: 1500 },
      { id: 'rate-high-42-medium', priceBand: 'high', areaCode: '42', saleSpeed: 'medium', commission: 4500 },
      { id: 'rate-premium-17-slow', priceBand: 'premium', areaCode: '17', saleSpeed: 'slow', commission: 7000 }
    ]
  };
}

export const propertyRoomStatsQuery: Query<PropertyRoomStatsRow> = pipe(
  from(roomRef),
  aggregate({
    groupBy: { propertyId: roomRef.propertyId },
    aggregates: {
      roomCount: count(),
      squareFeet: sum(roomRef.squareFeet)
    }
  })
);
const roomStats = as(propertyRoomStatsQuery, 'roomStats');

export const propertyInfoQuery: Query<PropertyInfoRow> = pipe(
  from(propertyRef),
  hash(propertyRef.agentId, propertyRef.areaCode, propertyRef.priceBand),
  btree(propertyRef.price),
  join(from(agentRef), eq(propertyRef.agentId, agentRef.id)),
  leftJoin(propertyRoomStatsQuery, eq(propertyRef.id, roomStats.propertyId)),
  sort(asc(propertyRef.price)),
  project({
    id: propertyRef.id,
    address: propertyRef.address,
    price: propertyRef.price,
    registeredAt: propertyRef.registeredAt,
    photo: propertyRef.photo,
    agentId: propertyRef.agentId,
    agentName: agentRef.name,
    areaCode: propertyRef.areaCode,
    priceBand: propertyRef.priceBand,
    roomCount: maybe(roomStats.roomCount),
    squareFeet: maybe(roomStats.squareFeet)
  }),
  keyBy('id')
);
const info = as(propertyInfoQuery, 'info');

export const latestOfferMarksQuery: Query<LatestOfferMarkRow> = pipe(
  from(offerRef),
  aggregate({
    groupBy: {
      propertyId: offerRef.propertyId,
      buyerId: offerRef.buyerId
    },
    aggregates: {
      offeredAt: max(offerRef.offeredAt)
    }
  })
);
const latest = as(latestOfferMarksQuery, 'latest');

export const currentOffersQuery: Query<OfferSummaryRow> = pipe(
  from(offerRef),
  join(latestOfferMarksQuery, and(
    eq(offerRef.propertyId, latest.propertyId),
    eq(offerRef.buyerId, latest.buyerId),
    eq(offerRef.offeredAt, latest.offeredAt)
  )),
  join(from(propertyRef), eq(offerRef.propertyId, propertyRef.id)),
  join(from(agentRef), eq(propertyRef.agentId, agentRef.id)),
  join(from(buyerRef), eq(offerRef.buyerId, buyerRef.id)),
  leftJoin(from(decisionRef), eq(offerRef.id, decisionRef.offerId)),
  sort(desc(offerRef.offeredAt)),
  project({
    id: offerRef.id,
    propertyId: propertyRef.id,
    propertyAddress: propertyRef.address,
    price: propertyRef.price,
    buyerId: buyerRef.id,
    buyerName: buyerRef.name,
    agentId: agentRef.id,
    agentName: agentRef.name,
    areaCode: propertyRef.areaCode,
    priceBand: propertyRef.priceBand,
    offeredAt: offerRef.offeredAt,
    amount: offerRef.amount,
    decisionId: maybe(decisionRef.id),
    decisionStatus: maybe(decisionRef.accepted)
  }),
  keyBy('id')
);
const current = as(currentOffersQuery, 'current');

export const acceptedSalesQuery: Query<AcceptedSaleRow> = pipe(
  from(decisionRef),
  where(eq(decisionRef.accepted, true)),
  join(from(offerRef), eq(decisionRef.offerId, offerRef.id)),
  join(from(propertyRef), eq(offerRef.propertyId, propertyRef.id)),
  join(from(buyerRef), eq(offerRef.buyerId, buyerRef.id)),
  join(from(agentRef), eq(propertyRef.agentId, agentRef.id)),
  sort(asc(decisionRef.decidedAt)),
  project({
    id: decisionRef.id,
    offerId: offerRef.id,
    propertyId: propertyRef.id,
    propertyAddress: propertyRef.address,
    price: propertyRef.price,
    buyerId: buyerRef.id,
    buyerName: buyerRef.name,
    agentId: agentRef.id,
    agentName: agentRef.name,
    areaCode: propertyRef.areaCode,
    priceBand: propertyRef.priceBand,
    registeredAt: propertyRef.registeredAt,
    decidedAt: decisionRef.decidedAt,
    saleSpeed: decisionRef.saleSpeed,
    amount: offerRef.amount,
    listingState: value('sold')
  }),
  keyBy('id')
);
const sale = as(acceptedSalesQuery, 'sale');

export const listingRowsQuery: Query<ListingRow> = pipe(
  info,
  leftJoin(sale, eq(info.id, sale.propertyId)),
  where(eq(sale.propertyId, value<string | undefined>(undefined))),
  project({
    id: info.id,
    address: info.address,
    price: info.price,
    registeredAt: info.registeredAt,
    photo: info.photo,
    agentId: info.agentId,
    agentName: info.agentName,
    areaCode: info.areaCode,
    priceBand: info.priceBand,
    roomCount: info.roomCount,
    squareFeet: info.squareFeet,
    listingState: value('listed')
  }),
  keyBy('id'),
  sort(asc(field<number>('row', 'price')))
);

export const unsoldPropertiesQuery = listingRowsQuery;

export const openOffersQuery: Query<OfferSummaryRow> = pipe(
  current,
  where(eq(current.decisionId, value(undefined))),
  project({
    id: current.id,
    propertyId: current.propertyId,
    propertyAddress: current.propertyAddress,
    price: current.price,
    buyerId: current.buyerId,
    buyerName: current.buyerName,
    agentId: current.agentId,
    agentName: current.agentName,
    areaCode: current.areaCode,
    priceBand: current.priceBand,
    offeredAt: current.offeredAt,
    amount: current.amount,
    decisionId: current.decisionId,
    decisionStatus: value('open')
  }),
  keyBy('id')
);

export const commissionDueQuery: Query<CommissionDueRow> = pipe(
  sale,
  join(from(rateRef), and(
    eq(sale.priceBand, rateRef.priceBand),
    eq(sale.areaCode, rateRef.areaCode),
    eq(sale.saleSpeed, rateRef.saleSpeed)
  )),
  aggregate({
    groupBy: {
      id: sale.agentId,
      agentId: sale.agentId,
      agentName: sale.agentName
    },
    aggregates: {
      sales: count(),
      saleVolume: sum(sale.amount),
      commissionDue: sum(rateRef.commission)
    }
  }),
  keyBy('id'),
  sort(asc(field<string>('row', 'agentName')))
);

export const offerConstraintRowsQuery: Query<OfferRow> = pipe(
  from(offerRef),
  project({
    id: offerRef.id,
    propertyId: offerRef.propertyId,
    buyerId: offerRef.buyerId,
    offeredAt: offerRef.offeredAt,
    amount: offerRef.amount
  }),
  keyBy('id')
);

export const decisionConstraintRowsQuery: Query<DecisionRow> = pipe(
  from(decisionRef),
  project({
    id: decisionRef.id,
    offerId: decisionRef.offerId,
    decidedAt: decisionRef.decidedAt,
    accepted: decisionRef.accepted,
    saleSpeed: decisionRef.saleSpeed
  }),
  keyBy('id')
);

export const queryExamples: readonly {
  readonly id: QueryExampleId;
  readonly label: string;
  readonly query: Query<PlaygroundRow>;
  readonly columns: readonly string[];
  readonly snippet: string;
  readonly filters: readonly (keyof PlaygroundFilters)[];
}[] = [
  {
    id: 'propertyInfo',
    label: 'Property info',
    query: propertyInfoQuery,
    columns: ['id', 'address', 'agentName', 'price', 'priceBand', 'areaCode', 'roomCount', 'squareFeet'],
    filters: ['agentId', 'areaCode', 'priceBand', 'minPrice', 'maxPrice'],
    snippet: `pipe(
  from(property),
  join(from(agent), eq(property.agentId, agent.id)),
  leftJoin(roomStats, eq(property.id, roomStats.propertyId)),
  project({ address, agentName, roomCount, squareFeet, priceBand, areaCode })
)`
  },
  {
    id: 'currentOffers',
    label: 'Current offers',
    query: currentOffersQuery,
    columns: ['id', 'propertyAddress', 'buyerName', 'agentName', 'amount', 'offeredAt', 'decisionStatus'],
    filters: ['agentId', 'areaCode', 'priceBand', 'buyerId', 'minPrice', 'maxPrice'],
    snippet: `const latest = aggregate({
  groupBy: { propertyId, buyerId },
  aggregates: { offeredAt: max(offer.offeredAt) }
});

offer |> join(latest, same property/buyer/date)`
  },
  {
    id: 'acceptedSales',
    label: 'Accepted sales',
    query: acceptedSalesQuery,
    columns: ['id', 'propertyAddress', 'buyerName', 'agentName', 'amount', 'priceBand', 'saleSpeed', 'listingState'],
    filters: ['agentId', 'areaCode', 'priceBand', 'buyerId', 'listingState', 'minPrice', 'maxPrice'],
    snippet: `decision
  |> where(accepted = true)
  |> join(offer)
  |> join(property)
  |> join(buyer)
  |> join(agent)`
  },
  {
    id: 'listingRows',
    label: 'Unsold listings',
    query: listingRowsQuery,
    columns: ['id', 'address', 'agentName', 'price', 'priceBand', 'areaCode', 'roomCount', 'listingState'],
    filters: ['agentId', 'areaCode', 'priceBand', 'listingState', 'minPrice', 'maxPrice'],
    snippet: `propertyInfo
  |> leftJoin(acceptedSales, property.id = sale.propertyId)
  |> where(sale.propertyId = undefined)`
  },
  {
    id: 'openOffers',
    label: 'Open offers',
    query: openOffersQuery,
    columns: ['id', 'propertyAddress', 'buyerName', 'agentName', 'amount', 'offeredAt', 'decisionStatus'],
    filters: ['agentId', 'areaCode', 'priceBand', 'buyerId', 'minPrice', 'maxPrice'],
    snippet: `currentOffers
  |> where(decisionId = undefined)
  |> project({ property, buyer, amount, offeredAt })`
  },
  {
    id: 'commissionDue',
    label: 'Commission due',
    query: commissionDueQuery,
    columns: ['agentName', 'sales', 'saleVolume', 'commissionDue'],
    filters: ['agentId'],
    snippet: `acceptedSales
  |> join(commissionRates, priceBand/areaCode/saleSpeed)
  |> aggregate({ groupBy: agent, commissionDue: sum(rate.commission) })`
  }
];

export function createRealEstateDb(input: Db['data'] = seedRealEstateData()): Db {
  return mat(
    db(input),
    constrain(
      req(offerConstraintRowsQuery, 'propertyId'),
      req(offerConstraintRowsQuery, 'buyerId'),
      req(offerConstraintRowsQuery, 'offeredAt'),
      fk(offerConstraintRowsQuery, 'propertyId', realEstateSchema.properties, 'id'),
      fk(offerConstraintRowsQuery, 'buyerId', realEstateSchema.buyers, 'id'),
      check(offerConstraintRowsQuery, gt(field('offer', 'amount'), value(0))),
      unique(decisionConstraintRowsQuery, 'offerId'),
      fk(decisionConstraintRowsQuery, 'offerId', realEstateSchema.offers, 'id'),
      check(decisionConstraintRowsQuery, or(
        eq(field('decision', 'saleSpeed'), value('very-fast')),
        eq(field('decision', 'saleSpeed'), value('fast')),
        eq(field('decision', 'saleSpeed'), value('medium')),
        eq(field('decision', 'saleSpeed'), value('slow')),
        eq(field('decision', 'saleSpeed'), value('very-slow'))
      ))
    )
  );
}

export async function createRealEstateStore(input: Db = createRealEstateDb()): Promise<Store> {
  let materializedDb = await materializeSnapshot(input, listingRowsQuery, { id: 'listing-rows' });
  materializedDb = await materializeSnapshot(materializedDb, commissionDueQuery, { id: 'commission-due' });
  return createStore(materializedDb);
}

export async function createRealEstateModel(): Promise<RealEstateModel> {
  return {
    store: await createRealEstateStore(),
    automerge: createAutomergeRealEstateBacking()
  };
}

export function createAutomergeRealEstateBacking(): AutomergeRealEstateBacking {
  const seed = seedRealEstateData();
  const relic = automergeDb<RealEstateDocument>(Automerge.from<RealEstateDocument>({
    market: {
      agents: rowsById(seed.agents ?? []),
      buyers: rowsById(seed.buyers ?? []),
      properties: rowsById(seed.properties ?? []),
      rooms: rowsById(seed.rooms ?? []),
      offers: rowsById(seed.offers ?? []),
      decisions: rowsById(seed.decisions ?? []),
      commissionRates: rowsById(seed.commissionRates ?? [])
    }
  }), {
    relations: [
      { relation: realEstateSchema.agents, path: ['market', 'agents'] },
      { relation: realEstateSchema.buyers, path: ['market', 'buyers'] },
      { relation: realEstateSchema.properties, path: ['market', 'properties'] },
      { relation: realEstateSchema.rooms, path: ['market', 'rooms'] },
      { relation: realEstateSchema.offers, path: ['market', 'offers'] },
      { relation: realEstateSchema.decisions, path: ['market', 'decisions'] },
      { relation: realEstateSchema.commissionRates, path: ['market', 'commissionRates'] }
    ]
  });

  return {
    relic,
    beforeHeads: Automerge.getHeads(relic.getDoc())
  };
}

export function buildPlaygroundQuery(
  queryId: QueryExampleId,
  filters: PlaygroundFilters = {}
): Query<PlaygroundRow> {
  const example = queryExampleById(queryId);
  const active = new Set<keyof PlaygroundFilters>(example.filters);
  let query = example.query;

  if (active.has('agentId') && hasFilterValue(filters.agentId)) {
    query = pipe(query, where(eq(row.agentId, env('agentId'))));
  }
  if (active.has('areaCode') && hasFilterValue(filters.areaCode)) {
    query = pipe(query, where(eq(row.areaCode, env('areaCode'))));
  }
  if (active.has('priceBand') && hasFilterValue(filters.priceBand)) {
    query = pipe(query, where(eq(row.priceBand, env('priceBand'))));
  }
  if (active.has('buyerId') && hasFilterValue(filters.buyerId)) {
    query = pipe(query, where(eq(row.buyerId, env('buyerId'))));
  }
  if (active.has('listingState') && hasFilterValue(filters.listingState)) {
    query = pipe(query, where(eq(row.listingState, env('listingState'))));
  }
  if (active.has('minPrice') && typeof filters.minPrice === 'number') {
    query = pipe(query, where(gte(row.price, env('minPrice'))));
  }
  if (active.has('maxPrice') && typeof filters.maxPrice === 'number') {
    query = pipe(query, where(lte(row.price, env('maxPrice'))));
  }

  return query;
}

export function playgroundEnvForFilters(filters: PlaygroundFilters): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, item]) =>
    item !== undefined && item !== '' && item !== 'all'
  ));
}

export function runPlaygroundQuery(
  currentDb: Db,
  queryId: QueryExampleId,
  filters: PlaygroundFilters = {}
): readonly PlaygroundRow[] {
  return qRows(currentDb, buildPlaygroundQuery(queryId, filters), {
    env: playgroundEnvForFilters(filters)
  });
}

export async function runAcceptHarbourOfferTransaction(
  store: Store
): Promise<StoreCommitResult> {
  return store.commit(acceptHarbourOfferInputs());
}

export function acceptHarbourOfferInputs(): StoreCommitInput {
  return [insert(realEstateSchema.decisions, {
    id: 'decision-harbour-accepted',
    offerId: 'offer-harbour-mia-1',
    decidedAt: '2021-11-05',
    accepted: true,
    saleSpeed: saleSpeed('2021-10-11', '2021-11-05')
  })];
}

export async function runAddMillOfferTransaction(store: Store): Promise<StoreCommitResult> {
  return store.commit(addMillOfferInputs());
}

export function addMillOfferInputs(): StoreCommitInput {
  return [insert(realEstateSchema.offers, {
    id: 'offer-mill-mia-1',
    propertyId: 'property-mill',
    buyerId: 'buyer-mia',
    offeredAt: '2021-10-29',
    amount: 1680000
  })];
}

export async function runRejectGardenLatestTransaction(
  store: Store
): Promise<StoreCommitResult> {
  return store.commit(rejectGardenLatestInputs());
}

export function rejectGardenLatestInputs(): StoreCommitInput {
  return [insert(realEstateSchema.decisions, {
    id: 'decision-garden-latest-rejected',
    offerId: 'offer-garden-nico-2',
    decidedAt: '2021-10-25',
    accepted: false,
    saleSpeed: saleSpeed('2021-10-18', '2021-10-25')
  })];
}

export async function runInvalidOfferAfterAcceptedTransaction(
  store: Store
): Promise<StoreCommitResult> {
  return store.commit(invalidOfferAfterAcceptedInputs());
}

export function invalidOfferAfterAcceptedInputs(): StoreCommitInput {
  return [insert(realEstateSchema.offers, {
    id: 'offer-elm-late-invalid',
    propertyId: 'property-elm',
    buyerId: 'buyer-mia',
    offeredAt: '2021-10-30',
    amount: -1
  })];
}

export async function runAutomergeListingRows(
  backing: AutomergeRealEstateBacking
): Promise<readonly ListingRow[]> {
  const snapshot = await backing.relic.getSnapshot();
  return qRows(snapshot.db, listingRowsQuery);
}

export function readableDiagnostics(diagnostics: readonly TarstateDiagnostic[]): readonly ReadableDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const detail = isRecord(diagnostic.detail) ? diagnostic.detail : {};
    const error = typeof detail.error === 'string' ? detail.error : diagnostic.code;
    return {
      code: diagnostic.code,
      label: readableError(error, diagnostic.code),
      relation: typeof diagnostic.relation === 'string' ? diagnostic.relation.replace(/^query:/, 'query') : 'unknown',
      field: typeof diagnostic.field === 'string' && diagnostic.field !== ''
        ? diagnostic.field
        : diagnostic.code === 'constraint_check' ? 'amount' : 'unknown'
    };
  });
}

export function RealEstateApp({ model }: { readonly model: RealEstateModel }): ReactElement {
  return createElement(
    TarstateProvider,
    { store: model.store },
    createElement(RealEstateWalkthrough, { automerge: model.automerge })
  );
}

export function RealEstateWalkthrough({
  automerge
}: {
  readonly automerge: AutomergeRealEstateBacking;
}): ReactElement {
  const commit = useCommit();
  const [factTab, setFactTab] = useState<keyof typeof realEstateSchema>('properties');
  const [queryId, setQueryId] = useState<QueryExampleId>('propertyInfo');
  const [filters, setFilters] = useState<PlaygroundFilters>({});
  const [transactionText, setTransactionText] = useState('No transaction run yet.');
  const [diagnostics, setDiagnostics] = useState<readonly ReadableDiagnostic[]>([]);
  const [automergeRows, setAutomergeRows] = useState<readonly ListingRow[]>([]);
  const example = queryExampleById(queryId);
  const envValues = useMemo(() => playgroundEnvForFilters(filters), [filters]);
  const playgroundQuery = useMemo(() => buildPlaygroundQuery(queryId, filters), [queryId, filters]);
  const playground = useQuery(playgroundQuery, {
    env: envValues,
    deps: [queryId, filters.agentId, filters.areaCode, filters.priceBand, filters.buyerId, filters.listingState, filters.minPrice, filters.maxPrice]
  });
  const materializedListings = useView(listingRowsQuery);
  const materializedCommission = useView(commissionDueQuery);
  const watch = useWatch(listingRowsQuery, undefined, { keyBy: ['id'] });
  const seed = seedRealEstateData();

  const runTransaction = async (
    label: string,
    input: StoreCommitInput
  ): Promise<void> => {
    const result = await commit(input);
    setTransactionText(result.reflected
      ? `${label}: ${result.status} at revision ${result.snapshot.revision} (${result.effects.applied}/${result.effects.patches} reflected)`
      : `${label}: rejected (${readableDiagnostics(result.diagnostics).map((item) => item.code).join(', ')})`);
  };

  const runInvalid = async (): Promise<void> => {
    const result = await commit(invalidOfferAfterAcceptedInputs());
    setDiagnostics(readableDiagnostics(result.diagnostics));
    setTransactionText(result.reflected
      ? `Invalid offer unexpectedly ${result.status} at revision ${result.snapshot.revision}.`
      : `Invalid offer ${result.status}: ${readableDiagnostics(result.diagnostics).map((item) => item.code).join(', ')}`);
  };

  const runAutomerge = async (): Promise<void> => {
    setAutomergeRows(await runAutomergeListingRows(automerge));
  };

  return createElement(
    'main',
    { className: 'page', 'data-demo': 'RealEstateWalkthrough' },
    createElement('header', { className: 'page-title' },
      createElement('h1', null, 'Real estate queries'),
      createElement('p', null, 'Relic-style query values over plain property sale facts.')
    ),
    section(
      'facts',
      '1. Facts',
      'Small normalized maps. The rest of the page reuses these rows.',
      codeBlock(`const db = createDb({
  properties, rooms, offers, decisions,
  agents, buyers, commissionRates
});`),
      factsPanel(seed, factTab, setFactTab)
    ),
    section(
      'playground',
      '2. Query playground',
      'Pick a query, set env filters, and read the result table.',
      codeBlock(example.snippet),
      controlsPanel(queryId, setQueryId, filters, setFilters),
      resultTable(example.columns, playground.rows, { table: 'playground' })
    ),
    section(
      'materialized',
      '3. Materialized views',
      'The same query values can be materialized and read through React.',
      codeBlock(`let db = await materializeSnapshot(sourceDb, listingRowsQuery, { id: 'listing-rows' });
db = await materializeSnapshot(db, commissionDueQuery, { id: 'commission-due' });
const store = createStore(db);

const listings = useView(listingRowsQuery);`),
      metricGrid(
        metric('Materialized listings', `${materializedListings.rows.length} rows`),
        metric('Materialized commission', `${materializedCommission.rows.length} rows`)
      ),
      resultTable(['id', 'address', 'agentName', 'price', 'listingState'], materializedListings.rows, { table: 'materialized-listings' }),
      resultTable(['agentName', 'sales', 'saleVolume', 'commissionDue'], materializedCommission.rows, { table: 'materialized-commission' })
    ),
    section(
      'transactions',
      '4. Transactions',
      'Writes use the same relations and immediately change query output.',
      codeBlock(`const commit = useCommit();
await commit(insert(schema.decisions, {
  id: 'decision-harbour-accepted',
  offerId: 'offer-harbour-mia-1',
  accepted: true
}));
// { status, reflected, effects, snapshot, diagnostics }`),
      metricGrid(metric('Last transaction', transactionText)),
      actionRow(
        actionButton('accept-harbour', 'Accept harbour offer', () => void runTransaction('Accept harbour', acceptHarbourOfferInputs())),
        actionButton('add-mill-offer', 'Add mill offer', () => void runTransaction('Add mill offer', addMillOfferInputs())),
        actionButton('reject-garden-latest', 'Reject garden latest', () => void runTransaction('Reject garden latest', rejectGardenLatestInputs()))
      )
    ),
    section(
      'diagnostics',
      '5. Constraints/diagnostics',
      'Rejected writes return readable diagnostics and leave query rows unchanged.',
      codeBlock(`constrain(
  fk(offers, 'propertyId', properties, 'id'),
  fk(offers, 'buyerId', buyers, 'id'),
  check(offerConstraintRowsQuery, gt(field('offer', 'amount'), value(0))),
  unique(decisions, 'offerId')
)`),
      actionRow(actionButton('invalid-offer', 'Try offer after accepted sale', () => void runInvalid())),
      diagnosticsList(diagnostics)
    ),
    section(
      'watch',
      '6. Watch',
      'useWatch tracks the latest changed listing rows across transactions.',
      codeBlock(`const watch = useWatch(listingRowsQuery, undefined, {
  keyBy: ['id']
});`),
      metricGrid(
        metric('Watch changed', watch.event?.changed ? 'yes' : 'no'),
        metric('Watch added', watch.event?.added.map((item) => item.id).join(', ') || 'none'),
        metric('Watch removed', watch.event?.removed.map((item) => item.id).join(', ') || 'none')
      )
    ),
    section(
      'automerge',
      '7. Automerge',
      'The listing query runs against an Automerge-backed snapshot without changing query shape.',
      codeBlock(`const snapshot = await automergeDb(doc, { relations }).getSnapshot();
const rows = qRows(snapshot.db, listingRowsQuery);`),
      metricGrid(
        metric('Automerge heads', automerge.beforeHeads.length),
        metric('Automerge rows', automergeRows.length === 0 ? 'not run' : `${automergeRows.length}: ${automergeRows.map((item) => item.id).join(', ')}`)
      ),
      actionRow(actionButton('run-automerge', 'Run listing query', () => void runAutomerge()))
    )
  );
}

function propertyRow(
  id: string,
  address: string,
  price: number,
  agentId: string,
  registeredAt: string,
  photo: string
): PropertyRow {
  return {
    id,
    address,
    price,
    agentId,
    registeredAt,
    photo,
    areaCode: areaCode(address),
    priceBand: priceBand(price)
  };
}

function buyerRow(id: string, name: string, address: string): BuyerRow {
  return {
    id,
    name,
    address,
    areaCode: areaCode(address)
  };
}

function roomRow(id: string, propertyId: string, name: string, width: number, length: number): RoomRow {
  return {
    id,
    propertyId,
    name,
    width,
    length,
    squareFeet: width * length
  };
}

function queryExampleById(queryId: QueryExampleId) {
  return queryExamples.find((item) => item.id === queryId) ?? queryExamples[0]!;
}

function hasFilterValue(valueAtFilter: string | undefined): boolean {
  return valueAtFilter !== undefined && valueAtFilter !== '' && valueAtFilter !== 'all';
}

function rowsById<Row extends { readonly id: string }>(rows: readonly Row[]): Record<string, StoredRow<Row>> {
  return Object.fromEntries(rows.map((rowValue) => {
    const { id, ...rest } = rowValue;
    return [id, rest as StoredRow<Row>];
  }));
}

function section(
  id: string,
  title: string,
  explanation: string,
  ...children: readonly ReactElement[]
): ReactElement {
  return createElement(
    'section',
    { className: 'panel', 'data-section': id },
    createElement('div', { className: 'section-head' },
      createElement('h2', null, title),
      createElement('p', null, explanation)
    ),
    createElement('div', { className: 'section-grid' }, ...children)
  );
}

function codeBlock(source: string): ReactElement {
  return createElement('pre', { className: 'snippet' }, createElement('code', null, source));
}

function factsPanel(
  seed: Db['data'],
  active: keyof typeof realEstateSchema,
  setActive: (value: keyof typeof realEstateSchema) => void
): ReactElement {
  const relationNames = Object.keys(realEstateSchema) as (keyof typeof realEstateSchema)[];
  const rows = (seed[active] ?? []) as readonly Record<string, unknown>[];
  const columns = columnsForRows(rows).slice(0, 7);

  return createElement(
    'div',
    { className: 'facts' },
    createElement('div', { className: 'tabs', role: 'tablist' },
      ...relationNames.map((name) => createElement('button', {
        key: name,
        type: 'button',
        role: 'tab',
        className: name === active ? 'tab active' : 'tab',
        'data-fact-tab': name,
        onClick: () => setActive(name)
      }, `${name} (${(seed[name] ?? []).length})`))
    ),
    resultTable(columns, rows, { table: `facts-${active}` })
  );
}

function controlsPanel(
  queryId: QueryExampleId,
  setQueryId: (value: QueryExampleId) => void,
  filters: PlaygroundFilters,
  setFilters: (value: PlaygroundFilters) => void
): ReactElement {
  const setFilter = (key: keyof PlaygroundFilters, valueAtFilter: string): void => {
    const parsed = key === 'minPrice' || key === 'maxPrice'
      ? numericFilter(valueAtFilter)
      : valueAtFilter;
    setFilters({ ...filters, [key]: parsed });
  };

  return createElement(
    'form',
    { className: 'controls', 'data-controls': 'playground' },
    label('Query',
      selectControl('query', queryId, (valueAtControl) => setQueryId(valueAtControl as QueryExampleId),
        queryExamples.map((item) => [item.id, item.label]))
    ),
    label('Agent',
      selectControl('agent', filters.agentId ?? 'all', (valueAtControl) => setFilter('agentId', valueAtControl), [
        ['all', 'All agents'],
        ['agent-rose', 'Rose Patel'],
        ['agent-bob', 'Bob Stone'],
        ['agent-uma', 'Uma Reid']
      ])
    ),
    label('Area',
      selectControl('area', filters.areaCode ?? 'all', (valueAtControl) => setFilter('areaCode', valueAtControl), [
        ['all', 'All areas'],
        ['55', '55'],
        ['42', '42'],
        ['17', '17']
      ])
    ),
    label('Band',
      selectControl('price-band', filters.priceBand ?? 'all', (valueAtControl) => setFilter('priceBand', valueAtControl), [
        ['all', 'All bands'],
        ['low', 'low'],
        ['med', 'med'],
        ['high', 'high'],
        ['premium', 'premium']
      ])
    ),
    label('Buyer',
      selectControl('buyer', filters.buyerId ?? 'all', (valueAtControl) => setFilter('buyerId', valueAtControl), [
        ['all', 'All buyers'],
        ['buyer-alice', 'Alice Hart'],
        ['buyer-mia', 'Mia Chen'],
        ['buyer-nico', 'Nico Ford']
      ])
    ),
    label('State',
      selectControl('listing-state', filters.listingState ?? 'all', (valueAtControl) => setFilter('listingState', valueAtControl), [
        ['all', 'All states'],
        ['listed', 'listed'],
        ['sold', 'sold']
      ])
    ),
    label('Min price',
      inputControl('min-price', filters.minPrice, (valueAtControl) => setFilter('minPrice', valueAtControl))
    ),
    label('Max price',
      inputControl('max-price', filters.maxPrice, (valueAtControl) => setFilter('maxPrice', valueAtControl))
    )
  );
}

function selectControl(
  name: string,
  selected: string,
  onChange: (valueAtControl: string) => void,
  options: readonly (readonly [string, string])[]
): ReactElement {
  const htmlName = htmlControlName(name);
  return createElement(
    'select',
    {
      id: `playground-${htmlName}`,
      name: htmlName,
      value: selected,
      'data-control': name,
      onChange: (event: { readonly target: { readonly value: string } }) => onChange(event.target.value)
    },
    ...options.map(([valueAtOption, labelText]) =>
      createElement('option', { key: valueAtOption, value: valueAtOption }, labelText)
    )
  );
}

function inputControl(
  name: string,
  valueAtInput: number | undefined,
  onChange: (valueAtControl: string) => void
): ReactElement {
  const htmlName = htmlControlName(name);
  return createElement('input', {
    id: `playground-${htmlName}`,
    name: htmlName,
    type: 'number',
    inputMode: 'numeric',
    value: valueAtInput ?? '',
    'data-control': name,
    onChange: (event: { readonly target: { readonly value: string } }) => onChange(event.target.value)
  });
}

function htmlControlName(dataControl: string): string {
  switch (dataControl) {
    case 'price-band':
      return 'band';
    case 'listing-state':
      return 'state';
    case 'min-price':
      return 'minPrice';
    case 'max-price':
      return 'maxPrice';
    default:
      return dataControl;
  }
}

function label(text: string, control: ReactElement): ReactElement {
  return createElement('label', null, createElement('span', null, text), control);
}

function numericFilter(input: string): number | undefined {
  if (input.trim() === '') return undefined;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metricGrid(...children: readonly ReactElement[]): ReactElement {
  return createElement('div', { className: 'metrics' }, ...children);
}

function metric(labelText: string, valueText: string | number): ReactElement {
  return createElement(
    'div',
    { className: 'metric', 'data-metric': labelText },
    createElement('span', null, labelText),
    createElement('strong', null, String(valueText))
  );
}

function actionRow(...children: readonly ReactElement[]): ReactElement {
  return createElement('div', { className: 'actions' }, ...children);
}

function actionButton(action: string, labelText: string, onClick: () => void): ReactElement {
  return createElement('button', { type: 'button', 'data-action': action, onClick }, labelText);
}

function resultTable(
  columns: readonly string[],
  rows: readonly unknown[],
  options: { readonly table: string }
): ReactElement {
  return createElement(
    'div',
    { className: 'table-wrap', 'data-table': options.table, 'data-row-count': rows.length },
    createElement('table', null,
      createElement('thead', null,
        createElement('tr', null,
          ...columns.map((column) => createElement('th', { key: column }, column))
        )
      ),
      createElement('tbody', null,
        ...(rows.length === 0
          ? [createElement('tr', { key: 'empty' },
              createElement('td', { colSpan: columns.length || 1 }, 'No rows')
            )]
	          : rows.map((inputRow, indexValue) => {
	              const rowValue = isRecord(inputRow) ? inputRow : {};
	              const key = rowKey(rowValue, indexValue);
	              const rowId = typeof rowValue.id === 'string' || typeof rowValue.id === 'number'
	                ? String(rowValue.id)
	                : key;
	              return (
	              createElement('tr', {
	                key,
	                'data-row-id': rowId
	              },
              ...columns.map((column) =>
                createElement('td', { key: column }, displayCell(rowValue[column]))
              ))
              );
            }))
      )
    )
  );
}

function diagnosticsList(diagnostics: readonly ReadableDiagnostic[]): ReactElement {
  return createElement(
    'ul',
    { className: 'diagnostics', 'data-diagnostics': diagnostics.length },
    ...(diagnostics.length === 0
      ? [createElement('li', { key: 'empty' }, 'No rejected write yet.')]
      : diagnostics.map((diagnostic, indexValue) =>
          createElement('li', {
            key: `${diagnostic.code}-${indexValue}`,
            'data-diagnostic-code': diagnostic.code
          },
          createElement('strong', null, diagnostic.label),
          createElement('span', null, `${diagnostic.code} / ${diagnostic.relation} / ${diagnostic.field}`))
        ))
  );
}

function columnsForRows(rows: readonly Record<string, unknown>[]): readonly string[] {
  const first = rows[0];
  return first === undefined ? ['id'] : Object.keys(first);
}

function rowKey(rowValue: Record<string, unknown>, indexValue: number): string {
  return typeof rowValue.id === 'string' ? rowValue.id : `row-${indexValue}`;
}

function displayCell(input: unknown): string {
  if (input === undefined) return '';
  if (typeof input === 'number') return input.toLocaleString('en-US');
  if (typeof input === 'string' || typeof input === 'boolean') return String(input);
  return JSON.stringify(input);
}

function readableError(error: string, code: string): string {
  switch (error) {
    case 'required-field-violation':
      return 'Missing required field';
    case 'foreign-key-violation':
      return 'Missing referenced row';
    case 'unique-key-violation':
      return 'Duplicate value';
    case 'check-violation':
      return 'Check failed';
    default:
      switch (code) {
        case 'duplicate_key':
          return 'Duplicate relation key';
        case 'constraint_fk':
          return 'Missing referenced row';
        case 'constraint_unique':
          return 'Duplicate value';
        case 'constraint_check':
          return 'Check failed';
        case 'constraint_req':
          return 'Missing required field';
        default:
          return error;
      }
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
