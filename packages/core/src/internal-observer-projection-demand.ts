import type { CreateDatabaseQueryMaintenance } from './observer-maintenance-contracts.js';
import type { LogicalProjectionDemand } from './query/projection-demand.js';

const projectionDemands = new WeakMap<object, (query: unknown) => LogicalProjectionDemand | undefined>();

export const registerProjectionDemand = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>,
  derive: (query: Query) => LogicalProjectionDemand | undefined
): void => {
  projectionDemands.set(factory, derive as (query: unknown) => LogicalProjectionDemand | undefined);
};

export const projectionDemandFor = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>
): ((query: Query) => LogicalProjectionDemand | undefined) | undefined =>
  projectionDemands.get(factory) as ((query: Query) => LogicalProjectionDemand | undefined) | undefined;
