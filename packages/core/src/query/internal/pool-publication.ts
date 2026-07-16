import {
  summarizeOperatorEvents,
  type QueryMaintenanceOperatorEvent
} from './maintenance-diagnostics.js';
import type { QueryMaintenanceOperatorDiagnostics } from '../incremental-model.js';
import type { QueryNode } from '../model.js';

export type PooledRootMaintenanceSummary = {
  readonly updatedNodeCount: number;
  readonly changedNodeCount: number;
  readonly operatorDiagnostics: QueryMaintenanceOperatorDiagnostics;
};

/** Derives root-local telemetry from one shared physical transition. */
export const summarizePooledRootMaintenance = (
  reachable: ReadonlySet<QueryNode>,
  updatedNodes: ReadonlySet<QueryNode>,
  changedNodes: ReadonlySet<QueryNode>,
  operatorEvents: ReadonlyMap<QueryNode, QueryMaintenanceOperatorEvent>
): PooledRootMaintenanceSummary => {
  let updatedNodeCount = 0;
  let changedNodeCount = 0;
  const events: QueryMaintenanceOperatorEvent[] = [];
  for (const node of reachable) {
    if (updatedNodes.has(node)) updatedNodeCount += 1;
    if (changedNodes.has(node)) changedNodeCount += 1;
    const event = operatorEvents.get(node);
    if (event !== undefined) events.push(event);
  }
  return {
    updatedNodeCount,
    changedNodeCount,
    operatorDiagnostics: summarizeOperatorEvents(events)
  };
};
