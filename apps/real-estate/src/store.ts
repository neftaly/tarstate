import { createDb } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { createStore, type Store } from '@tarstate/core/store';
import { makeRealEstateSeed, realEstateConstraints } from './domain';
import {
  listingsByIdIndex,
  listingsByNeighborhoodIndex,
  listingsByPriceIndex,
  neighborhoodMarketSummaryQuery,
  openHouseScheduleQuery,
  pipelineByListingQuery
} from './queries';

export function createRealEstateStore(includeInvalidRows: boolean): Store {
  const db = mat(
    createDb(makeRealEstateSeed(includeInvalidRows)),
    realEstateConstraints,
    listingsByNeighborhoodIndex,
    listingsByPriceIndex,
    listingsByIdIndex,
    neighborhoodMarketSummaryQuery,
    openHouseScheduleQuery,
    pipelineByListingQuery
  );

  return createStore(db);
}
