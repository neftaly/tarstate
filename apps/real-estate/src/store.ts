import { createDb } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { createStore, type Store } from '@tarstate/core/store';
import { makeRealEstateSeed, realEstateConstraints } from './domain';
import { marketSummaryQuery, pipelineByListingQuery, viewingScheduleQuery } from './queries';

export function createRealEstateStore(): Store {
  const source = createDb(makeRealEstateSeed());
  const db = mat(source, realEstateConstraints, marketSummaryQuery, pipelineByListingQuery, viewingScheduleQuery);

  return createStore(db);
}
