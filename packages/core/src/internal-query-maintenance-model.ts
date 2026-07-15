import type { Issue } from './issues.js';
import type { EvaluationCache, NodeResult, ScopedRow } from './internal-query-evaluation-context.js';
import type { WindowMaintenanceLayouts } from './internal-query-evaluator.js';
import type { QueryMaintenanceOperatorEvent } from './internal-query-maintenance-diagnostics.js';
import type { QueryNode, QueryRecord } from './query-model.js';
import type { JsonValue } from './value.js';

export type AggregateGroupKey = { readonly canonical: string; readonly key: QueryRecord };
export type DistinctPositionKeyIndex = { readonly base: readonly string[]; readonly overlays: readonly ReadonlyMap<number, string>[] };
export type DistinctPositionsIndex = { readonly base: ReadonlyMap<string, readonly number[]>; readonly overlays: readonly ReadonlyMap<string, readonly number[] | undefined>[] };
export type DistinctMaterializedState = {
  readonly inputs: readonly ScopedRow[];
  readonly keys: DistinctPositionKeyIndex;
  readonly positions: DistinctPositionsIndex;
  readonly outputKeys: readonly string[];
  readonly outputPositionByKey: ReadonlyMap<string, number>;
};
export type AggregateGroupMember = { readonly position: number; readonly row: ScopedRow };
export type AggregateGroupState = { readonly key: QueryRecord; readonly members: readonly AggregateGroupMember[]; readonly reducers: AggregateReducerStates; readonly output: ScopedRow };
export type DistinctCountIndex = { readonly base: ReadonlyMap<string, number>; readonly overlays: readonly ReadonlyMap<string, number>[], readonly distinctCount: number };
export type ExtremeValueEntry = { readonly count: number; readonly value: JsonValue };
export type ExtremeValueIndex = {
  readonly base: ReadonlyMap<string, ExtremeValueEntry>;
  readonly overlays: readonly ReadonlyMap<string, ExtremeValueEntry | undefined>[];
  readonly orderedKeys: readonly string[];
  readonly extremeKey?: string;
};
export type AggregateReducerState =
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'distinct'; readonly index: DistinctCountIndex }
  | { readonly kind: 'extreme'; readonly index: ExtremeValueIndex }
  | { readonly kind: 'truth'; readonly trueCount: number; readonly falseCount: number; readonly unknownCount: number };
export type AggregateReducerStates = ReadonlyMap<string, AggregateReducerState>;
export type AggregateRowGroupIndex = {
  readonly parent?: AggregateRowGroupIndex;
  readonly entries: ReadonlyMap<ScopedRow, AggregateGroupKey>;
  readonly depth: number;
};
export type LocalSegment = ScopedRow | readonly ScopedRow[] | undefined;

/** Physical state is intentionally opaque to the semantic evaluator. */
export type MaterializedQueryNode = {
  readonly result: NodeResult;
  readonly issues: readonly Issue[];
  readonly unavailable: boolean;
  readonly maintenanceEvent?: QueryMaintenanceOperatorEvent;
  readonly stableChangedPositions?: readonly number[];
  readonly from?: { readonly inputOffsets: ReadonlyMap<string, number> };
  readonly local?: {
    readonly inputs: readonly ScopedRow[];
    readonly segments: readonly LocalSegment[];
    readonly outputOffsets?: readonly number[];
    readonly widths?: readonly number[];
  };
  readonly join?: {
    readonly leftInputs: readonly ScopedRow[];
    readonly rightInputs: readonly ScopedRow[];
    readonly segments: readonly (readonly ScopedRow[])[];
    readonly rightIndex?: ReadonlyMap<string, readonly ScopedRow[]>;
    readonly leftPositionsByKey?: ReadonlyMap<string, number | readonly number[]>;
    readonly outputOffsets: readonly number[];
    readonly widths: readonly number[];
  };
  readonly order?: { readonly inputs: readonly ScopedRow[] };
  readonly distinct?: DistinctMaterializedState;
  readonly slice?: { readonly inputs: readonly ScopedRow[] };
  readonly unionAll?: { readonly leftInputs: readonly ScopedRow[]; readonly rightInputs: readonly ScopedRow[] };
  readonly window?: {
    readonly inputs: readonly ScopedRow[];
    readonly partitionKeyByResultKey: ReadonlyMap<string, string>;
    readonly partitions: ReadonlyMap<string, { readonly members: readonly ScopedRow[]; readonly outputs: readonly ScopedRow[] }>;
    readonly layouts?: WindowMaintenanceLayouts;
  };
  readonly aggregate?: {
    readonly inputs: readonly ScopedRow[];
    readonly groupKeys: AggregateRowGroupIndex;
    readonly groups: ReadonlyMap<string, AggregateGroupState>;
  };
};

export class MaterializedEvaluationCache implements EvaluationCache {
  constructor(
    private readonly nodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
    private readonly activeNode: QueryNode
  ) {}

  resultFor(node: QueryNode): MaterializedQueryNode | undefined {
    return node === this.activeNode ? undefined : this.nodes.get(node);
  }
}

export const withMaintenanceEvent = (node: MaterializedQueryNode, event: QueryMaintenanceOperatorEvent): MaterializedQueryNode => ({ ...node, maintenanceEvent: event });
