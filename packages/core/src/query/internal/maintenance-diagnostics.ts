import type {
  QueryMaintenanceFallbackReason,
  QueryMaintenanceOperator,
  QueryMaintenanceOperatorDiagnostics,
  QueryOperatorMaintenanceDiagnostics
} from '../incremental-model.js';

export type QueryMaintenanceOperatorEvent = {
  readonly operator: QueryMaintenanceOperator;
  readonly strategy: 'selective' | 'full' | 'fallback';
  readonly affectedUnitCount: number;
  readonly compactionCount?: number;
  readonly reason?: QueryMaintenanceFallbackReason;
};

const operatorKinds: readonly QueryMaintenanceOperator[] = ['local', 'join', 'distinct', 'order', 'aggregate', 'window', 'slice', 'set'];
const emptyQueryOperatorMaintenanceDiagnostics: QueryOperatorMaintenanceDiagnostics = Object.freeze({
  selectiveNodeCount: 0,
  fullNodeCount: 0,
  fallbackNodeCount: 0,
  affectedUnitCount: 0,
  compactionCount: 0,
  fallbackReasons: Object.freeze({})
});
const emptyQueryMaintenanceOperatorDiagnostics = Object.freeze(Object.fromEntries(
  operatorKinds.map((operator) => [operator, emptyQueryOperatorMaintenanceDiagnostics])
)) as QueryMaintenanceOperatorDiagnostics;

export const emptyOperatorDiagnostics = (): QueryMaintenanceOperatorDiagnostics => emptyQueryMaintenanceOperatorDiagnostics;

export const summarizeOperatorEvents = (events: Iterable<QueryMaintenanceOperatorEvent>): QueryMaintenanceOperatorDiagnostics => {
  const mutable = new Map<QueryMaintenanceOperator, {
    selectiveNodeCount: number; fullNodeCount: number; fallbackNodeCount: number; affectedUnitCount: number; compactionCount: number;
    fallbackReasons: Partial<Record<QueryMaintenanceFallbackReason, number>>;
  }>();
  for (const event of events) {
    let summary = mutable.get(event.operator);
    if (summary === undefined) {
      summary = { selectiveNodeCount: 0, fullNodeCount: 0, fallbackNodeCount: 0, affectedUnitCount: 0, compactionCount: 0, fallbackReasons: {} };
      mutable.set(event.operator, summary);
    }
    if (event.strategy === 'selective') summary.selectiveNodeCount += 1;
    else if (event.strategy === 'full') summary.fullNodeCount += 1;
    else summary.fallbackNodeCount += 1;
    summary.affectedUnitCount += event.affectedUnitCount;
    summary.compactionCount += event.compactionCount ?? 0;
    if (event.reason !== undefined) summary.fallbackReasons[event.reason] = (summary.fallbackReasons[event.reason] ?? 0) + 1;
  }
  return Object.freeze(Object.fromEntries(operatorKinds.map((operator) => {
    const summary = mutable.get(operator);
    return [operator, summary === undefined
      ? emptyQueryOperatorMaintenanceDiagnostics
      : Object.freeze({ ...summary, fallbackReasons: Object.freeze({ ...summary.fallbackReasons }) })];
  }))) as QueryMaintenanceOperatorDiagnostics;
};
