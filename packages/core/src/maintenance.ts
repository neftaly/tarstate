import type { Issue } from './issues.js';
import type { JsonValue } from './value.js';

export type SourceBasis = JsonValue;
export type RowOccurrenceId = string;
export type PlanNodeId = string;

export type LogicalRow<Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = {
  readonly occurrenceId: RowOccurrenceId;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly relationId: string;
  readonly key: JsonValue;
  readonly locator: JsonValue;
  readonly fields: Row;
};

export type RelationDelta<Row = unknown> = {
  readonly relationId: string;
  readonly beforeBasis: SourceBasis;
  readonly afterBasis: SourceBasis;
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly updated: readonly { readonly before: Row; readonly after: Row }[];
  readonly invalidated: boolean;
};

export type PreparedPlan<Query = unknown> = {
  readonly planId: string;
  readonly rootNodeId: PlanNodeId;
  readonly query: Query;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
};

export type MaintainedResult<Row, State = unknown> = {
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
  readonly state: State;
};

export type MaintenanceInput<Snapshot, Change> = {
  readonly snapshot: Snapshot;
  readonly change?: Change;
};

export interface MaintenanceSession<Row, Snapshot, Change> {
  current(): MaintainedResult<Row>;
  update(input: MaintenanceInput<Snapshot, Change>): MaintainedResult<Row>;
  close(): void;
}

export interface MaintenanceStrategy<Query, Row, Snapshot, Change> {
  open(plan: PreparedPlan<Query>, input: MaintenanceInput<Snapshot, Change>): MaintenanceSession<Row, Snapshot, Change>;
}

export class FullRecomputeStrategy<Query, Row, Snapshot, Change> implements MaintenanceStrategy<Query, Row, Snapshot, Change> {
  readonly #evaluate: (plan: PreparedPlan<Query>, snapshot: Snapshot) => Omit<MaintainedResult<Row>, 'state'>;

  constructor(evaluate: (plan: PreparedPlan<Query>, snapshot: Snapshot) => Omit<MaintainedResult<Row>, 'state'>) { this.#evaluate = evaluate; }

  open(plan: PreparedPlan<Query>, input: MaintenanceInput<Snapshot, Change>): MaintenanceSession<Row, Snapshot, Change> {
    let closed = false;
    let current = { ...this.#evaluate(plan, input.snapshot), state: { strategy: 'full-recompute' } };
    return {
      current: () => current,
      update: (next) => {
        if (closed) throw new Error('Maintenance session is closed');
        current = { ...this.#evaluate(plan, next.snapshot), state: { strategy: 'full-recompute' } };
        return current;
      },
      close: () => { closed = true; }
    };
  }
}
