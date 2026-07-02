import type { RelationDelta } from './adapter.js';
import type { RowChange, RowDiffDiagnostic } from './diff.js';
import { rowKey } from './evaluate.js';
import { stableKey } from './identity.js';
import { equalityJoinPlan, type FieldExpression } from './join-planner.js';
import {
  diffMaterializationRows,
  materializationRowIndex,
  materializationRowKey,
  materializationStableKey,
  type MaterializationRowDiffOptions
} from './materialization-row-changes.js';
import type {
  AggregateFunction,
  ExprData,
  PredicateData,
  ProjectionData,
  Query,
  QueryData,
  SortData
} from './query.js';
import { queryRowKeyFields } from './query.js';
import type { RelationRef } from './schema.js';

export type IncrementalSingleRootMaterializationPlan = {
  readonly kind: 'singleRoot';
  readonly rootRelation: string;
  readonly rootAlias: string;
  readonly root: IncrementalRoot;
  readonly steps: readonly IncrementalStep[];
  readonly ordered?: IncrementalOrderedStep;
  readonly rowKeyFields?: readonly string[];
};

export type IncrementalStaticRowsMaterializationPlan = {
  readonly kind: 'staticRows';
  readonly data: QueryData;
  readonly rowKeyFields?: readonly string[];
};

export type IncrementalDynamicSetMaterializationPlan = {
  readonly kind: 'dynamicSet';
  readonly op: 'union' | 'intersection' | 'difference';
  readonly branches: readonly IncrementalBranchPlan[];
  readonly rowKeyFields?: readonly string[];
};

export type IncrementalMaterializationPlan =
  | IncrementalSingleRootMaterializationPlan
  | IncrementalStaticRowsMaterializationPlan
  | IncrementalDynamicSetMaterializationPlan;

export type IncrementalMaterializationState<Row = unknown> = {
  readonly kind: 'incrementalMaterializationState';
  readonly rootRelation: string;
  readonly rootKeys: readonly string[];
  readonly rootIndexByKey: ReadonlyMap<string, number>;
  readonly rootRowsByRootKey: ReadonlyMap<string, unknown>;
  readonly outputsByRootKey: ReadonlyMap<string, readonly unknown[]>;
  readonly joinStates: readonly IncrementalJoinState[];
  readonly aggregate?: IncrementalAggregateState<Row>;
  readonly ordered?: IncrementalOrderedState<Row>;
  readonly dynamicSet?: IncrementalDynamicSetState;
};

export type IncrementalMaterialization<Row = unknown> = {
  readonly plan: IncrementalMaterializationPlan;
  readonly state: IncrementalMaterializationState<Row>;
};

export type IncrementalMaterializationBuild<Row = unknown> = IncrementalMaterialization<Row> & {
  readonly rows: readonly Row[];
};

export type IncrementalMaterializationBuildResult<Row = unknown> =
  | (IncrementalMaterializationBuild<Row> & {
      readonly supported: true;
      readonly reason: string;
    })
  | {
      readonly supported: false;
      readonly reason: string;
    };

export type IncrementalPlanResult =
  | {
      readonly supported: true;
      readonly plan: IncrementalMaterializationPlan;
      readonly reason: string;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export type IncrementalMaintenanceResult<Row = unknown> =
  | {
      readonly updated: true;
      readonly reason: string;
      readonly state: IncrementalMaterializationState<Row>;
      readonly rowChanges: readonly RowChange<Row>[];
      readonly addedRows: readonly Row[];
      readonly removedRows: readonly Row[];
      readonly rowBatches: readonly IncrementalRowBatch<Row>[];
      readonly changedRootKeys: readonly string[];
      readonly changedGroupKeys: readonly string[];
      readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
    }
  | {
      readonly updated: false;
      readonly reason: string;
    };

type IncrementalRoot =
  | { readonly kind: 'from' }
  | { readonly kind: 'lookup'; readonly field: string; readonly value: ExprData };

type IncrementalPipelineStep =
  | { readonly kind: 'where'; readonly predicate: PredicateData }
  | { readonly kind: 'select'; readonly projection: ProjectionData }
  | { readonly kind: 'extend'; readonly projection: ProjectionData }
  | { readonly kind: 'expand'; readonly collection: ExprData; readonly alias?: string; readonly fields?: readonly string[] }
  | { readonly kind: 'without'; readonly fields: readonly string[] }
  | { readonly kind: 'rename'; readonly fields: Record<string, string> }
  | { readonly kind: 'qualify'; readonly alias: string }
  | {
      readonly kind: 'setFilter';
      readonly op: 'intersection' | 'difference';
      readonly rightRows: readonly (readonly Record<string, unknown>[])[];
    };

type IncrementalJoinStep = {
  readonly kind: 'join';
  readonly joinKind: 'inner' | 'left';
  readonly id: string;
  readonly right: IncrementalBranchPlan;
  readonly left: ExprData;
  readonly rightExpr: ExprData;
  readonly predicate: PredicateData;
  readonly needsPredicateCheck: boolean;
};

type IncrementalBranchJoinStep = {
  readonly kind: 'join';
  readonly joinKind: 'inner';
  readonly id: string;
  readonly right: IncrementalBranchPlan;
  readonly left: ExprData;
  readonly rightExpr: ExprData;
  readonly predicate: PredicateData;
  readonly needsPredicateCheck: boolean;
};

type IncrementalBranchStep = IncrementalPipelineStep | IncrementalBranchJoinStep;
type IncrementalJoinLikeStep = IncrementalJoinStep | IncrementalBranchJoinStep;

type IncrementalAggregateStep = {
  readonly kind: 'aggregate';
  readonly groupBy: ProjectionData;
  readonly aggregates: ProjectionData;
};

type IncrementalStep = IncrementalPipelineStep | IncrementalJoinStep | IncrementalAggregateStep;

type IncrementalPostOrderStep = Extract<IncrementalPipelineStep, {
  readonly kind: 'select' | 'extend' | 'without' | 'rename' | 'qualify';
}>;

type IncrementalWindow = {
  readonly offset: number;
  readonly count: number;
};

type IncrementalOrderedStep = {
  readonly kind: 'ordered';
  readonly order: readonly SortData[];
  readonly window?: IncrementalWindow;
  readonly postSteps: readonly IncrementalPostOrderStep[];
};

type IncrementalBranchPlan = {
  readonly relation: string;
  readonly alias: string;
  readonly root: IncrementalRoot;
  readonly steps: readonly IncrementalBranchStep[];
};

type IncrementalDynamicSetState = {
  readonly branches: readonly IncrementalSetBranchState[];
};

type IncrementalSetBranchState = {
  readonly relation: string;
  readonly relationKeys: readonly string[];
  readonly relationIndexByKey: ReadonlyMap<string, number>;
  readonly rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>;
};

type IncrementalJoinState = {
  readonly id: string;
  readonly relation: string;
  readonly relationKeys: readonly string[];
  readonly relationIndexByKey: ReadonlyMap<string, number>;
  readonly relationRowsByKey: ReadonlyMap<string, unknown>;
  readonly rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly indexByValue: ReadonlyMap<string, readonly IndexedRightRow[]>;
  readonly rootValuesByKey: ReadonlyMap<string, readonly unknown[]>;
  readonly rootKeysByValue: ReadonlyMap<string, readonly RootJoinValue[]>;
  readonly nestedBranchJoinStates?: readonly IncrementalJoinState[];
};

type IncrementalAggregateState<Row = unknown> = {
  readonly groupKeys: readonly string[];
  readonly groupKeysByRootKey: ReadonlyMap<string, readonly string[]>;
  readonly rootKeysByGroupKey: ReadonlyMap<string, readonly string[]>;
  readonly groupsByKey: ReadonlyMap<string, IncrementalAggregateGroupState<Row>>;
};

type IncrementalAggregateGroupState<Row = unknown> = {
  readonly group: Record<string, unknown>;
  readonly rowCount: number;
  readonly output: Row;
};

type IncrementalOrderedState<Row = unknown> = {
  readonly entriesByOwnerKey: ReadonlyMap<string, readonly IncrementalOrderedEntry<Row>[]>;
  readonly entriesByKey: ReadonlyMap<string, IncrementalOrderedEntry<Row>>;
  readonly orderedEntryKeys: readonly string[];
  readonly visibleEntryKeys: readonly string[];
  readonly rows: readonly Row[];
};

type IncrementalOrderedEntry<Row = unknown> = {
  readonly key: string;
  readonly ownerKey: string;
  readonly rowIndex: number;
  readonly sortValues: readonly unknown[];
  readonly row: Row;
  readonly rowKey: string;
};

type IncrementalRelationSnapshot = {
  readonly relation: RelationRef;
  readonly rows: readonly unknown[];
};

type RootPlan = {
  readonly relation: string;
  readonly alias: string;
  readonly root: IncrementalRoot;
  readonly shape: PlanShape;
};

type RightBranchPlan = IncrementalBranchPlan & {
  readonly shape: PlanShape;
};

type PlanShape = {
  readonly aliases: ReadonlySet<string>;
  readonly fields: ReadonlySet<string>;
  readonly relations: ReadonlySet<string>;
};

type PlanCollection = {
  joinCount: number;
  ordered?: MutableIncrementalOrderedStep;
};

type MutableIncrementalOrderedStep = {
  readonly kind: 'ordered';
  readonly order: readonly SortData[];
  window?: IncrementalWindow;
  readonly postSteps: IncrementalPostOrderStep[];
};

type DeltaRowChange = {
  readonly key: string;
  readonly before?: unknown;
  readonly after?: unknown;
};

type MutableDeltaRows = {
  readonly key: string;
  readonly removed: unknown[];
  readonly added: unknown[];
  readonly order: number;
};

type IndexedRightRow = {
  readonly row: Record<string, unknown>;
  readonly value: unknown;
};

type RootJoinValue = {
  readonly rootKey: string;
  readonly value: unknown;
};

export type IncrementalRowBatch<Row = unknown> = {
  readonly beforeRows: readonly Row[];
  readonly afterRows: readonly Row[];
  readonly insertAfterKey?: string;
  readonly insertBeforeKey?: string;
};

type RootEvaluation<Row> =
  | {
      readonly supported: true;
      readonly rows: readonly Row[];
      readonly joinValuesByStep: ReadonlyMap<string, readonly unknown[]>;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type IncrementalRowReport<Row> = {
  readonly rowChanges: readonly RowChange<Row>[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly rowBatches: readonly IncrementalRowBatch<Row>[];
  readonly changedRootKeys: readonly string[];
  readonly changedGroupKeys: readonly string[];
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};

type MutableRootJoinIndex = {
  readonly valuesByRootKey: Map<string, readonly unknown[]>;
  readonly rootKeysByValue: Map<string, RootJoinValue[]>;
};

type JoinStateBuildResult =
  | {
      readonly supported: true;
      readonly states: readonly IncrementalJoinState[];
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type RightChangeResult =
  | {
      readonly supported: true;
      readonly state: IncrementalJoinState;
      readonly affectedRootKeys: ReadonlySet<string>;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type AggregateStateResult<Row> =
  | {
      readonly supported: true;
      readonly state: IncrementalAggregateState<Row>;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type OrderedStateResult<Row> =
  | {
      readonly supported: true;
      readonly state: IncrementalOrderedState<Row>;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type StaticRowsEvaluation =
  | {
      readonly supported: true;
      readonly rows: readonly Record<string, unknown>[];
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type BranchEvaluation =
  | {
      readonly supported: true;
      readonly rows: readonly Record<string, unknown>[];
      readonly joinValuesByStep: ReadonlyMap<string, readonly unknown[]>;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

type RightBranchPlanCollection = {
  readonly allowNestedJoin: boolean;
  branchJoinCount: number;
};

const supportedAggregateFunctions: ReadonlySet<AggregateFunction> = new Set([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'any',
  'notAny',
  'setConcat',
  'top',
  'bottom',
  'topBy',
  'bottomBy',
  'maxBy',
  'minBy'
]);

const staticRowsRelationReason = 'query depends on relation rows';

export function planIncrementalMaterialization(query: Query): IncrementalPlanResult {
  const staticPlan = collectStaticRowsPlan(query.data);
  if (typeof staticPlan !== 'string') {
    return {
      supported: true,
      plan: {
        kind: 'staticRows',
        data: query.data,
        ...optionalRowKeyFields(queryRowKeyFields(query))
      },
      reason: 'incremental maintenance for static constRows query'
    };
  }

  const dynamicSetPlan = collectDynamicSetPlan(query.data);
  const steps: IncrementalStep[] = [];
  const collection: PlanCollection = { joinCount: 0 };
  const root = collectSingleRootPlan(query.data, steps, collection);
  if (typeof root === 'string') {
    if (dynamicSetPlan.supported) {
      for (const relationName of dynamicSetRelationNames(dynamicSetPlan.plan)) {
        if (query.relations[relationName] === undefined) {
          return { supported: false, reason: `relation ${relationName} is not available for incremental maintenance` };
        }
      }

      return {
        supported: true,
        plan: {
          ...dynamicSetPlan.plan,
          ...optionalRowKeyFields(queryRowKeyFields(query))
        },
        reason: `incremental maintenance for supported dynamic ${dynamicSetPlan.plan.op} branches`
      };
    }

    if (isSetQueryData(query.data)) {
      return {
        supported: false,
        reason: dynamicSetPlan.reason
      };
    }

    return {
      supported: false,
      reason: staticPlan === staticRowsRelationReason ? root : staticPlan
    };
  }

  for (const relationName of planRelationNames(root, steps)) {
    if (query.relations[relationName] === undefined) {
      return { supported: false, reason: `relation ${relationName} is not available for incremental maintenance` };
    }
  }

  return {
    supported: true,
    plan: {
      kind: 'singleRoot',
      rootRelation: root.relation,
      rootAlias: root.alias,
      root: root.root,
      steps,
      ...optionalOrderedStep(collection.ordered),
      ...optionalRowKeyFields(queryRowKeyFields(query))
    },
    reason: collection.ordered === undefined
      ? 'incremental maintenance for supported single-root relation pipeline'
      : 'incremental maintenance for supported single-root relation pipeline with final order/window'
  };
}

export function buildIncrementalMaterialization<Row>(
  plan: IncrementalMaterializationPlan,
  relation: RelationRef | undefined,
  rootRows: readonly unknown[] = [],
  env: Readonly<Record<string, unknown>>,
  relationSnapshots: ReadonlyMap<string, IncrementalRelationSnapshot> = relation === undefined
    ? new Map()
    : new Map([[relation.name, { relation, rows: rootRows }]])
): IncrementalMaterializationBuildResult<Row> {
  if (plan.kind === 'staticRows') {
    return buildStaticIncrementalMaterialization(plan, env);
  }

  if (plan.kind === 'dynamicSet') {
    return buildDynamicSetIncrementalMaterialization(plan, relationSnapshots, env);
  }

  if (relation === undefined) {
    return {
      supported: false,
      reason: `relation ${plan.rootRelation} is not available for incremental maintenance`
    };
  }

  const duplicateReason = duplicateRelationRowsReason(relation, rootRows);
  if (duplicateReason !== undefined) {
    return {
      supported: false,
      reason: duplicateReason
    };
  }

  const joinStatesResult = buildJoinStates(plan, relationSnapshots, env);
  if (!joinStatesResult.supported) {
    return {
      supported: false,
      reason: joinStatesResult.reason
    };
  }

  const rootKeys: string[] = [];
  const rootRowsByRootKey = new Map<string, unknown>();
  const outputsByRootKey = new Map<string, readonly unknown[]>();
  const rootValuesByStep = new Map<string, Map<string, readonly unknown[]>>();
  const joinStateById = joinStateMap(joinStatesResult.states);

  for (const row of rootRows) {
    const key = relationKeyForRow(relation, row);
    rootKeys.push(key);
    rootRowsByRootKey.set(key, row);

    const evaluated = evaluateRootRow<unknown>(plan, row, env, joinStateById);
    if (!evaluated.supported) {
      return {
        supported: false,
        reason: evaluated.reason
      };
    }

    outputsByRootKey.set(key, evaluated.rows);
    recordRootJoinValues(rootValuesByStep, key, evaluated.joinValuesByStep);
  }

  const joinStates = joinStatesResult.states.map((state) =>
    withRootJoinValues(state, rootValuesByStep.get(state.id) ?? new Map())
  );

  const aggregate = aggregateStep(plan);
  const aggregateState = aggregate === undefined
    ? undefined
    : buildAggregateState<Row>(plan, rootKeys, outputsByRootKey, env);
  if (aggregateState !== undefined && !aggregateState.supported) {
    return {
      supported: false,
      reason: aggregateState.reason
    };
  }

  let state: IncrementalMaterializationState<Row> = {
    kind: 'incrementalMaterializationState',
    rootRelation: plan.rootRelation,
    rootKeys,
    rootIndexByKey: indexKeys(rootKeys),
    rootRowsByRootKey,
    outputsByRootKey,
    joinStates,
    ...(aggregateState === undefined ? {} : { aggregate: aggregateState.state })
  };

  const orderedState = buildOrderedState<Row>(plan, state, env);
  if (orderedState !== undefined) {
    if (!orderedState.supported) {
      return {
        supported: false,
        reason: orderedState.reason
      };
    }
    state = {
      ...state,
      ordered: orderedState.state
    };
  }

  const rows = rowsFromIncrementalState(state);
  const ambiguousRowsReason = ambiguousFinalRowsReason(plan, rows);
  if (ambiguousRowsReason !== undefined) {
    return {
      supported: false,
      reason: ambiguousRowsReason
    };
  }

  return {
    supported: true,
    reason: 'incremental materialization state built for unique root keys',
    plan,
    state,
    rows
  };
}

export function buildStaticIncrementalMaterialization<Row>(
  plan: IncrementalStaticRowsMaterializationPlan,
  env: Readonly<Record<string, unknown>>
): IncrementalMaterializationBuildResult<Row> {
  const evaluated = evaluateStaticRows(plan.data, env);
  if (!evaluated.supported) {
    return {
      supported: false,
      reason: evaluated.reason
    };
  }

  const rootKeys = evaluated.rows.map((_, index) => `static:${index}`);
  const rootRowsByRootKey = new Map<string, unknown>();
  const outputsByRootKey = new Map<string, readonly unknown[]>();
  for (const [index, row] of evaluated.rows.entries()) {
    const key = rootKeys[index] as string;
    rootRowsByRootKey.set(key, row);
    outputsByRootKey.set(key, [row]);
  }

  const state = {
    kind: 'incrementalMaterializationState',
    rootRelation: '',
    rootKeys,
    rootIndexByKey: indexKeys(rootKeys),
    rootRowsByRootKey,
    outputsByRootKey,
    joinStates: []
  } satisfies IncrementalMaterializationState<Row>;

  const rows = evaluated.rows as readonly Row[];
  const ambiguousRowsReason = ambiguousFinalRowsReason(plan, rows);
  if (ambiguousRowsReason !== undefined) {
    return {
      supported: false,
      reason: ambiguousRowsReason
    };
  }

  return {
    supported: true,
    reason: 'incremental materialization state built for static rows',
    plan,
    state,
    rows
  };
}

function buildDynamicSetIncrementalMaterialization<Row>(
  plan: IncrementalDynamicSetMaterializationPlan,
  relationSnapshots: ReadonlyMap<string, IncrementalRelationSnapshot>,
  env: Readonly<Record<string, unknown>>
): IncrementalMaterializationBuildResult<Row> {
  const branchStates: IncrementalSetBranchState[] = [];
  const checkedRelations = new Set<string>();

  for (const branch of plan.branches) {
    const snapshot = relationSnapshots.get(branch.relation);
    if (snapshot === undefined) {
      return {
        supported: false,
        reason: `relation ${branch.relation} is not available for dynamic set maintenance`
      };
    }

    if (!checkedRelations.has(snapshot.relation.name)) {
      checkedRelations.add(snapshot.relation.name);
      const duplicateReason = duplicateRelationRowsReason(
        snapshot.relation,
        snapshot.rows,
        'set branch relation'
      );
      if (duplicateReason !== undefined) {
        return {
          supported: false,
          reason: duplicateReason
        };
      }
    }

    const relationKeys: string[] = [];
    const rowsByRelationKey = new Map<string, readonly Record<string, unknown>[]>();
    for (const row of snapshot.rows) {
      const key = relationKeyForRow(snapshot.relation, row);
      const evaluated = evaluateBranchRows(branch, row, env);
      if (!evaluated.supported) {
        return {
          supported: false,
          reason: evaluated.reason
        };
      }
      relationKeys.push(key);
      rowsByRelationKey.set(key, evaluated.rows);
    }

    branchStates.push({
      relation: branch.relation,
      relationKeys,
      relationIndexByKey: indexKeys(relationKeys),
      rowsByRelationKey
    });
  }

  const rows = dynamicSetRows(plan, branchStates) as readonly Row[];
  const ambiguousRowsReason = ambiguousFinalRowsReason(plan, rows);
  if (ambiguousRowsReason !== undefined) {
    return {
      supported: false,
      reason: ambiguousRowsReason
    };
  }

  return {
    supported: true,
    reason: 'incremental materialization state built for dynamic set branches',
    plan,
    state: dynamicSetMaterializationState(branchStates, rows),
    rows
  };
}

export function maintainIncrementalMaterialization<Row>(
  materialization: IncrementalMaterialization<Row>,
  relation: RelationRef | undefined,
  deltas: readonly RelationDelta[],
  env: Readonly<Record<string, unknown>>
): IncrementalMaintenanceResult<Row> {
  if (materialization.plan.kind === 'staticRows') {
    return {
      updated: true,
      reason: 'static constRows query has no relation delta maintenance',
      state: materialization.state,
      rowChanges: [],
      addedRows: [],
      removedRows: [],
      rowBatches: [],
      changedRootKeys: [],
      changedGroupKeys: [],
      diagnostics: []
    };
  }

  if (materialization.plan.kind === 'dynamicSet') {
    return maintainDynamicSetMaterialization(materialization.plan, materialization, deltas, env);
  }

  if (relation === undefined) {
    return {
      updated: false,
      reason: `relation ${materialization.plan.rootRelation} is not available for incremental maintenance`
    };
  }

  if (materialization.plan.rootRelation !== relation.name || materialization.state.rootRelation !== relation.name) {
    return {
      updated: false,
      reason: 'incremental materialization state does not match the root relation'
    };
  }

  const duplicateStateReason = duplicateRootKeysReason(materialization.state.rootKeys, relation.name);
  if (duplicateStateReason !== undefined) {
    return {
      updated: false,
      reason: duplicateStateReason
    };
  }

  for (const joinState of materialization.state.joinStates) {
    const duplicateRightStateReason = duplicateRelationKeysReason(
      joinState.relationKeys,
      `right relation ${joinState.relation}`
    );
    if (duplicateRightStateReason !== undefined) {
      return {
        updated: false,
        reason: duplicateRightStateReason
      };
    }
  }

  const aggregate = aggregateStep(materialization.plan);
  const previousAggregateState = materialization.state.aggregate;
  if (aggregate !== undefined && previousAggregateState === undefined) {
    return {
      updated: false,
      reason: 'incremental aggregate state is missing; snapshot recompute is required'
    };
  }
  if (aggregate === undefined && previousAggregateState !== undefined) {
    return {
      updated: false,
      reason: 'incremental aggregate state is present for a non-aggregate plan; snapshot recompute is required'
    };
  }

  const ordered = orderedStep(materialization.plan);
  const previousOrderedState = materialization.state.ordered;
  if (ordered !== undefined && previousOrderedState === undefined) {
    return {
      updated: false,
      reason: 'incremental ordered state is missing; snapshot recompute is required'
    };
  }
  if (ordered === undefined && previousOrderedState !== undefined) {
    return {
      updated: false,
      reason: 'incremental ordered state is present for a non-ordered plan; snapshot recompute is required'
    };
  }

  const normalized = normalizedRelationChanges(relation, deltas);
  if (!normalized.supported) {
    return {
      updated: false,
      reason: normalized.reason
    };
  }

  const rootChanges = normalized.changes;
  if (rootChanges.length === 0) {
    if (hasRelationDeltaRows(relation, deltas)) {
      return {
        updated: false,
        reason: 'root relation deltas had no net keyed row changes; snapshot recompute is required to preserve relation order'
      };
    }
  }

  const rootKeys: (string | undefined)[] = [...materialization.state.rootKeys];
  const rootIndexByKey = new Map(rootIndexByKeyForState(materialization.state));
  const rootInsertIndexByKey = keyChangeInsertIndexes(relation, rootChanges, rootIndexByKey);
  const rootRowsByRootKey = new Map(materialization.state.rootRowsByRootKey);
  const outputsByRootKey = new Map(materialization.state.outputsByRootKey);
  const rootKeysToEvaluate = new Set<string>();
  const changedRootKeys = new Set<string>();
  const affectedAggregateGroupKeys = new Set<string>();
  const groupKeysByRootKey = previousAggregateState === undefined
    ? undefined
    : new Map(previousAggregateState.groupKeysByRootKey);
  const rootKeysByGroupKey = previousAggregateState === undefined
    ? undefined
    : mutableRootKeysByGroupKey(previousAggregateState);
  let joinStates = materialization.state.joinStates;

  for (const joinStep of joinSteps(materialization.plan)) {
    const currentState = joinStates.find((state) => state.id === joinStep.id);
    if (currentState === undefined) {
      return {
        updated: false,
        reason: `incremental join state ${joinStep.id} is missing; snapshot recompute is required`
      };
    }

    let nextJoinState = currentState;
    const nestedChanged = applyNestedBranchJoinChanges(joinStep, nextJoinState, deltas, env);
    if (!nestedChanged.supported) {
      return {
        updated: false,
        reason: nestedChanged.reason
      };
    }
    nextJoinState = nestedChanged.state;
    for (const rootKey of nestedChanged.affectedRootKeys) {
      rootKeysToEvaluate.add(rootKey);
      changedRootKeys.add(rootKey);
    }

    const deltaRelation = relationForDeltas(joinStep.right.relation, deltas);
    if (deltaRelation !== undefined) {
      const rightChanges = normalizedRelationChanges(
        deltaRelation,
        deltas,
        `right relation ${deltaRelation.name}`
      );
      if (!rightChanges.supported) {
        return {
          updated: false,
          reason: rightChanges.reason
        };
      }

      if (rightChanges.changes.length === 0) {
        if (hasRelationDeltaRows(deltaRelation, deltas)) {
          return {
            updated: false,
            reason: `right relation ${deltaRelation.name} deltas had no net keyed row changes; snapshot recompute is required to preserve join order`
          };
        }
      } else {
        const changed = applyRightRelationChanges(joinStep, nextJoinState, deltaRelation, rightChanges.changes, env);
        if (!changed.supported) {
          return {
            updated: false,
            reason: changed.reason
          };
        }

        nextJoinState = changed.state;
        for (const rootKey of changed.affectedRootKeys) {
          rootKeysToEvaluate.add(rootKey);
          changedRootKeys.add(rootKey);
        }
      }
    }

    if (nextJoinState !== currentState) {
      joinStates = joinStates.map((state) => state.id === nextJoinState.id ? nextJoinState : state);
    }
  }

  const rootJoinIndexes = mutableRootJoinIndexes(joinStates);

  for (const change of rootChanges) {
    const index = rootIndexByKey.get(change.key) ?? -1;

    if (change.after === undefined) {
      if (index === -1) {
        return {
          updated: false,
          reason: `root relation delta removed missing key ${change.key}; snapshot recompute is required`
        };
      }
      const previousGroupKeys = groupKeysByRootKey?.get(change.key);
      recordAggregateGroupKeys(affectedAggregateGroupKeys, previousGroupKeys);
      removeRootFromAggregateGroups(rootKeysByGroupKey, change.key, previousGroupKeys);
      groupKeysByRootKey?.delete(change.key);
      removeRootJoinValues(rootJoinIndexes, change.key);
      rootKeys[index] = undefined;
      rootIndexByKey.delete(change.key);
      rootRowsByRootKey.delete(change.key);
      outputsByRootKey.delete(change.key);
      rootKeysToEvaluate.delete(change.key);
      changedRootKeys.add(change.key);
      continue;
    }

    if (index === -1) {
      if (change.before !== undefined) {
        return {
          updated: false,
          reason: `root relation delta updated missing key ${change.key}; snapshot recompute is required`
        };
      }

      const keyChangeIndex = rootInsertIndexByKey.get(change.key);
      if (keyChangeIndex !== undefined && rootKeys[keyChangeIndex] === undefined) {
        rootKeys[keyChangeIndex] = change.key;
        rootIndexByKey.set(change.key, keyChangeIndex);
      } else {
        rootIndexByKey.set(change.key, rootKeys.length);
        rootKeys.push(change.key);
      }
    } else if (change.before === undefined) {
      return {
        updated: false,
        reason: `root relation delta added duplicate key ${change.key}; snapshot recompute is required`
      };
    }
    rootRowsByRootKey.set(change.key, change.after);
    rootKeysToEvaluate.add(change.key);
    changedRootKeys.add(change.key);
  }

  const compactRootKeys = rootKeys.filter((key): key is string => key !== undefined);
  const compactRootIndexByKey = indexKeys(compactRootKeys);
  const duplicateResultReason = duplicateRootKeysReason(compactRootKeys, relation.name);
  if (duplicateResultReason !== undefined) {
    return {
      updated: false,
      reason: duplicateResultReason
    };
  }

  const joinStateById = joinStateMap(joinStates);

  for (const rootKey of rootKeysToEvaluate) {
    if (!rootRowsByRootKey.has(rootKey)) {
      continue;
    }

    const row = rootRowsByRootKey.get(rootKey);
    const previousGroupKeys = groupKeysByRootKey?.get(rootKey);
    recordAggregateGroupKeys(affectedAggregateGroupKeys, previousGroupKeys);
    removeRootFromAggregateGroups(rootKeysByGroupKey, rootKey, previousGroupKeys);
    groupKeysByRootKey?.delete(rootKey);
    removeRootJoinValues(rootJoinIndexes, rootKey);

    const evaluated = evaluateRootRow<unknown>(materialization.plan, row, env, joinStateById);
    if (!evaluated.supported) {
      return {
        updated: false,
        reason: evaluated.reason
      };
    }

    outputsByRootKey.set(rootKey, evaluated.rows);
    if (aggregate !== undefined && groupKeysByRootKey !== undefined) {
      const nextGroupKeys = aggregateGroupKeysForRows(aggregate, evaluated.rows, env);
      recordAggregateGroupKeys(affectedAggregateGroupKeys, nextGroupKeys);
      if (nextGroupKeys.length > 0) {
        groupKeysByRootKey.set(rootKey, nextGroupKeys);
      }
      addRootToAggregateGroups(rootKeysByGroupKey, rootKey, nextGroupKeys, compactRootIndexByKey);
    }
    addRootJoinValues(rootJoinIndexes, rootKey, evaluated.joinValuesByStep);
  }

  const nextJoinStates = joinStates.map((state) =>
    withRootJoinIndex(state, rootJoinIndexes.get(state.id))
  );
  const nextAggregateState = aggregate === undefined
    ? undefined
    : maintainAggregateState<Row>(
      materialization.plan,
      previousAggregateState as IncrementalAggregateState<Row>,
      compactRootKeys,
      compactRootIndexByKey,
      outputsByRootKey,
      groupKeysByRootKey ?? new Map(),
      rootKeysByGroupKey ?? new Map(),
      affectedAggregateGroupKeys,
      env
    );
  if (nextAggregateState !== undefined && !nextAggregateState.supported) {
    return {
      updated: false,
      reason: nextAggregateState.reason
    };
  }

  let state: IncrementalMaterializationState<Row> = {
    kind: 'incrementalMaterializationState',
    rootRelation: materialization.state.rootRelation,
    rootKeys: compactRootKeys,
    rootIndexByKey: compactRootIndexByKey,
    rootRowsByRootKey,
    outputsByRootKey,
    joinStates: nextJoinStates,
    ...(nextAggregateState === undefined ? {} : { aggregate: nextAggregateState.state })
  };

  if (ordered !== undefined) {
    const nextOrderedState = maintainOrderedState<Row>(
      materialization.plan,
      previousOrderedState as IncrementalOrderedState<Row>,
      state,
      nextAggregateState === undefined ? changedRootKeys : affectedAggregateGroupKeys,
      env
    );
    if (!nextOrderedState.supported) {
      return {
        updated: false,
        reason: nextOrderedState.reason
      };
    }
    state = {
      ...state,
      ordered: nextOrderedState.state
    };
  }

  const ambiguousRowsReason = ambiguousFinalRowsReason(materialization.plan, rowsFromIncrementalState(state));
  if (ambiguousRowsReason !== undefined) {
    return {
      updated: false,
      reason: ambiguousRowsReason
    };
  }

  if (rootChanges.length === 0 && rootKeysToEvaluate.size === 0 && joinStates === materialization.state.joinStates) {
    return {
      updated: true,
      reason: 'root relation deltas had no net row changes',
      state: materialization.state,
      rowChanges: [],
      addedRows: [],
      removedRows: [],
      rowBatches: [],
      changedRootKeys: [],
      changedGroupKeys: [],
      diagnostics: []
    };
  }

  const rowReport = incrementalRowReport<Row>(
    materialization.plan,
    materialization.state,
    state,
    changedRootKeys,
    affectedAggregateGroupKeys
  );

  return {
    updated: true,
    reason: 'dependencies touched; incrementally maintained rows',
    state,
    rowChanges: rowReport.rowChanges,
    addedRows: rowReport.addedRows,
    removedRows: rowReport.removedRows,
    rowBatches: rowReport.rowBatches,
    changedRootKeys: rowReport.changedRootKeys,
    changedGroupKeys: rowReport.changedGroupKeys,
    diagnostics: rowReport.diagnostics
  };
}

function maintainDynamicSetMaterialization<Row>(
  plan: IncrementalDynamicSetMaterializationPlan,
  materialization: IncrementalMaterialization<Row>,
  deltas: readonly RelationDelta[],
  env: Readonly<Record<string, unknown>>
): IncrementalMaintenanceResult<Row> {
  const previousDynamicSet = materialization.state.dynamicSet;
  if (previousDynamicSet === undefined) {
    return {
      updated: false,
      reason: 'incremental dynamic set state is missing; snapshot recompute is required'
    };
  }

  if (previousDynamicSet.branches.length !== plan.branches.length) {
    return {
      updated: false,
      reason: 'incremental dynamic set branch state does not match the plan; snapshot recompute is required'
    };
  }

  for (const branchState of previousDynamicSet.branches) {
    const duplicateReason = duplicateRelationKeysReason(
      branchState.relationKeys,
      `set branch relation ${branchState.relation}`
    );
    if (duplicateReason !== undefined) {
      return {
        updated: false,
        reason: duplicateReason
      };
    }
  }

  let branchStates = previousDynamicSet.branches;
  let touched = false;
  let changed = false;

  for (const [index, branch] of plan.branches.entries()) {
    const branchState = branchStates[index];
    if (branchState === undefined || branchState.relation !== branch.relation) {
      return {
        updated: false,
        reason: 'incremental dynamic set branch state does not match the plan; snapshot recompute is required'
      };
    }

    const deltaRelation = relationForDeltas(branch.relation, deltas);
    if (deltaRelation === undefined) {
      continue;
    }
    touched = true;

    const relationChanges = normalizedRelationChanges(
      deltaRelation,
      deltas,
      `set branch relation ${deltaRelation.name}`
    );
    if (!relationChanges.supported) {
      return {
        updated: false,
        reason: relationChanges.reason
      };
    }

    if (relationChanges.changes.length === 0) {
      if (hasRelationDeltaRows(deltaRelation, deltas)) {
        return {
          updated: false,
          reason: `set branch relation ${deltaRelation.name} deltas had no net keyed row changes; snapshot recompute is required to preserve set order`
        };
      }
      continue;
    }

    const nextBranch = applyDynamicSetBranchChanges(branch, branchState, deltaRelation, relationChanges.changes, env);
    if (!nextBranch.supported) {
      return {
        updated: false,
        reason: nextBranch.reason
      };
    }

    branchStates = branchStates.map((state, stateIndex) => stateIndex === index ? nextBranch.state : state);
    changed = true;
  }

  if (!touched || !changed) {
    return {
      updated: true,
      reason: 'dynamic set relation deltas had no net row changes',
      state: materialization.state,
      rowChanges: [],
      addedRows: [],
      removedRows: [],
      rowBatches: [],
      changedRootKeys: [],
      changedGroupKeys: [],
      diagnostics: []
    };
  }

  const rows = dynamicSetRows(plan, branchStates) as readonly Row[];
  const ambiguousRowsReason = ambiguousFinalRowsReason(plan, rows);
  if (ambiguousRowsReason !== undefined) {
    return {
      updated: false,
      reason: ambiguousRowsReason
    };
  }

  const state = dynamicSetMaterializationState(branchStates, rows);
  const rowReport = dynamicSetRowReport(plan, materialization.state, state);

  return {
    updated: true,
    reason: 'dependencies touched; incrementally maintained dynamic set rows',
    state,
    rowChanges: rowReport.rowChanges,
    addedRows: rowReport.addedRows,
    removedRows: rowReport.removedRows,
    rowBatches: rowReport.rowBatches,
    changedRootKeys: rowReport.changedRootKeys,
    changedGroupKeys: rowReport.changedGroupKeys,
    diagnostics: rowReport.diagnostics
  };
}

type DynamicSetBranchChangeResult =
  | {
      readonly supported: true;
      readonly state: IncrementalSetBranchState;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

function applyDynamicSetBranchChanges(
  branch: IncrementalBranchPlan,
  state: IncrementalSetBranchState,
  relation: RelationRef,
  changes: readonly DeltaRowChange[],
  env: Readonly<Record<string, unknown>>
): DynamicSetBranchChangeResult {
  const relationKeys: (string | undefined)[] = [...state.relationKeys];
  const relationIndexByKey = new Map(state.relationIndexByKey);
  const relationInsertIndexByKey = keyChangeInsertIndexes(relation, changes, relationIndexByKey);
  const rowsByRelationKey = new Map(state.rowsByRelationKey);

  for (const change of changes) {
    const index = relationIndexByKey.get(change.key) ?? -1;
    const previousRows = rowsByRelationKey.get(change.key);

    if (change.after === undefined) {
      if (index === -1 || previousRows === undefined) {
        return {
          supported: false,
          reason: `set branch relation ${relation.name} delta removed missing key ${change.key}; snapshot recompute is required`
        };
      }

      relationKeys[index] = undefined;
      relationIndexByKey.delete(change.key);
      rowsByRelationKey.delete(change.key);
      continue;
    }

    if (index === -1) {
      if (change.before !== undefined) {
        return {
          supported: false,
          reason: `set branch relation ${relation.name} delta updated missing key ${change.key}; snapshot recompute is required`
        };
      }

      const keyChangeIndex = relationInsertIndexByKey.get(change.key);
      if (keyChangeIndex !== undefined && relationKeys[keyChangeIndex] === undefined) {
        relationKeys[keyChangeIndex] = change.key;
        relationIndexByKey.set(change.key, keyChangeIndex);
      } else {
        relationIndexByKey.set(change.key, relationKeys.length);
        relationKeys.push(change.key);
      }
    } else if (change.before === undefined) {
      return {
        supported: false,
        reason: `set branch relation ${relation.name} delta added duplicate key ${change.key}; snapshot recompute is required`
      };
    } else if (previousRows === undefined) {
      return {
        supported: false,
        reason: `set branch relation ${relation.name} delta updated missing key ${change.key}; snapshot recompute is required`
      };
    }

    const evaluated = evaluateBranchRows(branch, change.after, env);
    if (!evaluated.supported) {
      return {
        supported: false,
        reason: evaluated.reason
      };
    }
    rowsByRelationKey.set(change.key, evaluated.rows);
  }

  const compactRelationKeys = relationKeys.filter((key): key is string => key !== undefined);
  const duplicateReason = duplicateRelationKeysReason(compactRelationKeys, `set branch relation ${relation.name}`);
  if (duplicateReason !== undefined) {
    return {
      supported: false,
      reason: duplicateReason
    };
  }

  return {
    supported: true,
    state: {
      relation: state.relation,
      relationKeys: compactRelationKeys,
      relationIndexByKey: indexKeys(compactRelationKeys),
      rowsByRelationKey
    }
  };
}

function dynamicSetRowReport<Row>(
  plan: IncrementalDynamicSetMaterializationPlan,
  previous: IncrementalMaterializationState<Row>,
  next: IncrementalMaterializationState<Row>
): IncrementalRowReport<Row> {
  const options = rowDiffOptionsForPlan(plan);
  const beforeRows = rowsFromIncrementalState(previous);
  const afterRows = rowsFromIncrementalState(next);
  const diff = diffMaterializationRows(beforeRows, afterRows, options);
  const changed = materializationStableKey(beforeRows) !== materializationStableKey(afterRows);
  const changedKeys = changed
    ? orderedChangedKeys(
      previous.rootKeys,
      next.rootKeys,
      new Set([...previous.rootKeys, ...next.rootKeys])
    )
    : [];

  return {
    rowChanges: diff.changes,
    addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    rowBatches: changed ? [{ beforeRows, afterRows }] : [],
    changedRootKeys: changedKeys,
    changedGroupKeys: [],
    diagnostics: diff.diagnostics
  };
}

function collectDynamicSetPlan(data: QueryData):
  | { readonly supported: true; readonly plan: IncrementalDynamicSetMaterializationPlan }
  | { readonly supported: false; readonly reason: string } {
  switch (data.op) {
    case 'keyBy':
      return collectDynamicSetPlan(data.input);
    case 'union':
    case 'intersection':
      return collectDynamicSetBranches(data.op, data.inputs);
    case 'difference':
      return collectDynamicSetBranches('difference', [data.left, data.right]);
    default:
      return {
        supported: false,
        reason: 'query is not a dynamic set operation'
      };
  }
}

function collectDynamicSetBranches(
  op: 'union' | 'intersection' | 'difference',
  inputs: readonly QueryData[]
):
  | { readonly supported: true; readonly plan: IncrementalDynamicSetMaterializationPlan }
  | { readonly supported: false; readonly reason: string } {
  if (inputs.length < 2) {
    return {
      supported: false,
      reason: `${op} incremental maintenance requires at least two supported dynamic branches`
    };
  }

  const branches: IncrementalBranchPlan[] = [];
  for (const [index, input] of inputs.entries()) {
    const branch = collectRightBranchPlan(input, { allowNestedJoin: false });
    if (typeof branch === 'string') {
      return {
        supported: false,
        reason: `${op} branch ${index + 1} is not supported for incremental maintenance: ${branch}`
      };
    }
    branches.push(branchPlan(branch));
  }

  return {
    supported: true,
    plan: {
      kind: 'dynamicSet',
      op,
      branches
    }
  };
}

function isSetQueryData(data: QueryData): boolean {
  return data.op === 'union' || data.op === 'intersection' || data.op === 'difference';
}

function collectSingleRootPlan(
  data: QueryData,
  steps: IncrementalStep[],
  collection: PlanCollection
): RootPlan | string {
  switch (data.op) {
    case 'from':
      return {
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'from' },
        shape: shapeForRoot(data.relation, data.alias)
      };
    case 'lookup': {
      const reason = simpleExprReason(data.value);
      if (reason !== undefined) {
        return `lookup value is not supported for incremental maintenance: ${reason}`;
      }
      return {
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'lookup', field: data.field, value: data.value },
        shape: shapeForRoot(data.relation, data.alias)
      };
    }
    case 'where': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      if (collection.ordered !== undefined) {
        return 'where after order/window is not supported for incremental maintenance';
      }
      if (hasAggregateStep(steps)) {
        return 'where after aggregate is not supported for incremental maintenance';
      }
      const reason = simplePredicateReason(data.predicate);
      if (reason !== undefined) {
        return `where predicate is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({ kind: 'where', predicate: data.predicate });
      return root;
    }
    case 'hash':
    case 'btree': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      for (const expression of data.expressions) {
        const reason = simpleExprReason(expression);
        if (reason !== undefined) {
          return `${data.op} expression is not supported for incremental maintenance: ${reason}`;
        }
      }
      return root;
    }
    case 'keyBy':
      return collectSingleRootPlan(data.input, steps, collection);
    case 'select': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection);
      if (reason !== undefined) {
        return `select projection is not supported for incremental maintenance: ${reason}`;
      }
      const step = { kind: 'select', projection: data.projection } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: selectShape(root.shape, data.projection) };
    }
    case 'extend': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection);
      if (reason !== undefined) {
        return `extend projection is not supported for incremental maintenance: ${reason}`;
      }
      const step = { kind: 'extend', projection: data.projection } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: extendShape(root.shape, data.projection) };
    }
    case 'without': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const step = { kind: 'without', fields: data.fields } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: withoutShape(root.shape, data.fields) };
    }
    case 'rename': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const step = { kind: 'rename', fields: data.fields } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: renameShape(root.shape, data.fields) };
    }
    case 'qualify': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const step = { kind: 'qualify', alias: data.alias } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: qualifyShape(root.shape, data.alias) };
    }
    case 'expand': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      if (collection.ordered !== undefined) {
        return 'expand after order/window is not supported for incremental maintenance';
      }
      if (hasAggregateStep(steps)) {
        return 'expand after aggregate is not supported for incremental maintenance';
      }
      const reason = simpleExprReason(data.collection) ?? exprShapeReason(data.collection, root.shape);
      if (reason !== undefined) {
        return `expand collection is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({
        kind: 'expand',
        collection: data.collection,
        ...(data.alias === undefined ? {} : { alias: data.alias }),
        ...(data.fields === undefined ? {} : { fields: data.fields })
      });
      return { ...root, shape: expandShape(root.shape, data.alias, data.fields) };
    }
    case 'join': {
      const stepCount = steps.length;
      const left = collectSingleRootPlan(data.left, steps, collection);
      if (typeof left === 'string') return left;
      if (collection.ordered !== undefined) {
        return `${data.kind} join after order/window is not supported for incremental maintenance`;
      }
      if (hasAggregateStep(steps.slice(stepCount))) {
        return 'join after aggregate is not supported for incremental maintenance';
      }

      const right = collectRightBranchPlan(data.right, { allowNestedJoin: true });
      if (typeof right === 'string') {
        return `join right branch is not supported for incremental maintenance: ${right}`;
      }

      if (shapesOverlap(left.shape, right.shape)) {
        return 'ambiguous or self joins are not supported for incremental maintenance';
      }

      const predicateReason = simplePredicateReason(data.on);
      if (predicateReason !== undefined) {
        return `join predicate is not supported for incremental maintenance: ${predicateReason}`;
      }

      const equality = equalityJoinPlan(data.on, (expr) => expressionSideForShapes(expr, left.shape, right.shape));
      if (equality === undefined) {
        return `${data.kind} join incremental maintenance requires an unambiguous field equality predicate`;
      }

      const id = `join:${collection.joinCount}`;
      collection.joinCount += 1;
      steps.push({
        kind: 'join',
        joinKind: data.kind,
        id,
        right: branchPlan(right),
        left: equality.left,
        rightExpr: equality.right,
        predicate: data.on,
        needsPredicateCheck: equality.needsPredicateCheck
      });

      return { ...left, shape: mergeShapes(left.shape, right.shape) };
    }
    case 'sort': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      if (collection.ordered !== undefined) {
        return 'sort after order/window is not supported for incremental maintenance';
      }
      const reason = sortOrderReason(data.order, root.shape);
      if (reason !== undefined) {
        return `sort order is not supported for incremental maintenance: ${reason}`;
      }
      collection.ordered = {
        kind: 'ordered',
        order: data.order,
        postSteps: []
      };
      return root;
    }
    case 'limit': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const window = normalizedWindow(data.count, data.offset ?? 0);
      if (typeof window === 'string') {
        return `limit is not supported for incremental maintenance: ${window}`;
      }
      if (collection.ordered === undefined) {
        collection.ordered = {
          kind: 'ordered',
          order: [],
          window,
          postSteps: []
        };
      } else {
        collection.ordered.window = combineWindows(collection.ordered.window, window);
      }
      return root;
    }
    case 'sortLimit': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      if (collection.ordered !== undefined) {
        return 'sortLimit after order/window is not supported for incremental maintenance';
      }
      const orderReason = sortOrderReason(data.order, root.shape);
      if (orderReason !== undefined) {
        return `sortLimit order is not supported for incremental maintenance: ${orderReason}`;
      }
      const window = normalizedWindow(data.count, 0);
      if (typeof window === 'string') {
        return `sortLimit is not supported for incremental maintenance: ${window}`;
      }
      collection.ordered = {
        kind: 'ordered',
        order: data.order,
        window,
        postSteps: []
      };
      return root;
    }
    case 'union':
      return 'union is not supported for incremental maintenance';
    case 'intersection':
      return collectIntersectionPlan(data.inputs, steps, collection);
    case 'difference':
      return collectDifferencePlan(data.left, data.right, steps, collection);
    case 'constRows':
      return 'constRows is not supported for incremental maintenance';
    case 'aggregate': {
      const stepCount = steps.length;
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      if (collection.ordered !== undefined) {
        return 'aggregate after order/window is not supported for incremental maintenance';
      }
      const addedSteps = steps.slice(stepCount);
      if (hasAggregateStep(addedSteps)) {
        return 'nested aggregate is not supported for incremental maintenance';
      }

      const groupReason = simpleProjectionReason(data.groupBy) ?? projectionShapeReason(data.groupBy, root.shape);
      if (groupReason !== undefined) {
        return `aggregate groupBy projection is not supported for incremental maintenance: ${groupReason}`;
      }

      const aggregateReason = aggregateProjectionReason(data.aggregates, root.shape);
      if (aggregateReason !== undefined) {
        return `aggregate projection is not supported for incremental maintenance: ${aggregateReason}`;
      }

      steps.push({ kind: 'aggregate', groupBy: data.groupBy, aggregates: data.aggregates });
      return { ...root, shape: aggregateShape(root.shape, data.groupBy, data.aggregates) };
    }
  }
}

function sortOrderReason(order: readonly SortData[], shape: PlanShape): string | undefined {
  for (const item of order) {
    const reason = simpleExprReason(item.expr) ?? exprShapeReason(item.expr, shape);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

function normalizedWindow(count: number, offset: number): IncrementalWindow | string {
  if (!Number.isSafeInteger(count) || count < 0) {
    return 'count must be a non-negative safe integer';
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return 'offset must be a non-negative safe integer';
  }
  return { count, offset };
}

function combineWindows(
  current: IncrementalWindow | undefined,
  next: IncrementalWindow
): IncrementalWindow {
  if (current === undefined) {
    return next;
  }

  const skipped = Math.min(current.count, next.offset);
  const remaining = Math.max(0, current.count - next.offset);
  return {
    offset: current.offset + skipped,
    count: Math.min(remaining, next.count)
  };
}

function collectIntersectionPlan(
  inputs: readonly QueryData[],
  steps: IncrementalStep[],
  collection: PlanCollection
): RootPlan | string {
  const [leftInput, ...rightInputs] = inputs;
  if (leftInput === undefined || rightInputs.length === 0) {
    return 'intersection incremental maintenance requires one supported root branch and static right branches';
  }

  const stepCount = steps.length;
  const root = collectSingleRootPlan(leftInput, steps, collection);
  if (typeof root === 'string') {
    return `intersection first branch is not supported for incremental maintenance: ${root}`;
  }
  if (collection.ordered !== undefined) {
    return 'intersection after order/window is not supported for incremental maintenance';
  }
  if (hasAggregateStep(steps.slice(stepCount))) {
    return 'intersection after aggregate is not supported for incremental maintenance';
  }

  const rightRows = collectStaticSetRows(rightInputs, 'intersection');
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'intersection', rightRows });
  return root;
}

function collectDifferencePlan(
  leftInput: QueryData,
  rightInput: QueryData,
  steps: IncrementalStep[],
  collection: PlanCollection
): RootPlan | string {
  const stepCount = steps.length;
  const root = collectSingleRootPlan(leftInput, steps, collection);
  if (typeof root === 'string') {
    return `difference left branch is not supported for incremental maintenance: ${root}`;
  }
  if (collection.ordered !== undefined) {
    return 'difference after order/window is not supported for incremental maintenance';
  }
  if (hasAggregateStep(steps.slice(stepCount))) {
    return 'difference after aggregate is not supported for incremental maintenance';
  }

  const rightRows = collectStaticSetRows([rightInput], 'difference');
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'difference', rightRows });
  return root;
}

function collectStaticSetRows(
  inputs: readonly QueryData[],
  op: 'intersection' | 'difference'
): readonly (readonly Record<string, unknown>[])[] | string {
  const rows: Array<readonly Record<string, unknown>[]> = [];
  for (const input of inputs) {
    const planned = collectStaticRowsPlan(input);
    if (typeof planned === 'string') {
      return `${op} static branch is not supported for incremental maintenance: ${planned}`;
    }

    const evaluated = evaluateStaticRows(input, {});
    if (!evaluated.supported) {
      return `${op} static branch is not supported for incremental maintenance: ${evaluated.reason}`;
    }
    rows.push(evaluated.rows);
  }
  return rows;
}

function collectStaticRowsPlan(data: QueryData): PlanShape | string {
  switch (data.op) {
    case 'constRows':
      return shapeForConstRows(data.rows);
    case 'where': {
      const shape = collectStaticRowsPlan(data.input);
      if (typeof shape === 'string') return shape;
      const reason = simplePredicateReason(data.predicate) ?? predicateShapeReason(data.predicate, shape);
      return reason === undefined ? shape : `where predicate is not supported: ${reason}`;
    }
    case 'hash':
    case 'btree': {
      const shape = collectStaticRowsPlan(data.input);
      if (typeof shape === 'string') return shape;
      for (const expression of data.expressions) {
        const reason = simpleExprReason(expression) ?? exprShapeReason(expression, shape);
        if (reason !== undefined) {
          return `${data.op} expression is not supported: ${reason}`;
        }
      }
      return shape;
    }
    case 'keyBy':
      return collectStaticRowsPlan(data.input);
    case 'select': {
      const shape = collectStaticRowsPlan(data.input);
      if (typeof shape === 'string') return shape;
      const reason = simpleProjectionReason(data.projection) ?? projectionShapeReason(data.projection, shape);
      if (reason !== undefined) {
        return `select projection is not supported: ${reason}`;
      }
      return selectShape(shape, data.projection);
    }
    case 'extend': {
      const shape = collectStaticRowsPlan(data.input);
      if (typeof shape === 'string') return shape;
      const reason = simpleProjectionReason(data.projection) ?? projectionShapeReason(data.projection, shape);
      if (reason !== undefined) {
        return `extend projection is not supported: ${reason}`;
      }
      return extendShape(shape, data.projection);
    }
    case 'expand': {
      const shape = collectStaticRowsPlan(data.input);
      if (typeof shape === 'string') return shape;
      const reason = simpleExprReason(data.collection) ?? exprShapeReason(data.collection, shape);
      if (reason !== undefined) {
        return `expand collection is not supported: ${reason}`;
      }
      return expandShape(shape, data.alias, data.fields);
    }
    case 'without': {
      const shape = collectStaticRowsPlan(data.input);
      return typeof shape === 'string' ? shape : withoutShape(shape, data.fields);
    }
    case 'rename': {
      const shape = collectStaticRowsPlan(data.input);
      return typeof shape === 'string' ? shape : renameShape(shape, data.fields);
    }
    case 'qualify': {
      const shape = collectStaticRowsPlan(data.input);
      return typeof shape === 'string' ? shape : qualifyShape(shape, data.alias);
    }
    case 'union': {
      const shapes = collectStaticInputShapes(data.inputs);
      if (typeof shapes === 'string') return shapes;
      return shapes.reduce<PlanShape>((shape, item) => mergeShapes(shape, item), emptyShape());
    }
    case 'intersection': {
      const shapes = collectStaticInputShapes(data.inputs);
      if (typeof shapes === 'string') return shapes;
      return shapes[0] ?? emptyShape();
    }
    case 'difference': {
      const left = collectStaticRowsPlan(data.left);
      if (typeof left === 'string') return left;
      const right = collectStaticRowsPlan(data.right);
      return typeof right === 'string' ? right : left;
    }
    case 'from':
    case 'lookup':
    case 'join':
      return staticRowsRelationReason;
    case 'sort': {
      const shape = collectStaticRowsPlan(data.input);
      return shape === staticRowsRelationReason
        ? shape
        : 'sort is not supported for static incremental maintenance';
    }
    case 'limit': {
      const shape = collectStaticRowsPlan(data.input);
      return shape === staticRowsRelationReason
        ? shape
        : 'limit is not supported for static incremental maintenance';
    }
    case 'sortLimit': {
      const shape = collectStaticRowsPlan(data.input);
      return shape === staticRowsRelationReason
        ? shape
        : 'sortLimit is not supported for static incremental maintenance';
    }
    case 'aggregate': {
      const shape = collectStaticRowsPlan(data.input);
      return shape === staticRowsRelationReason
        ? shape
        : 'aggregate is not supported for static incremental maintenance';
    }
  }
}

function collectStaticInputShapes(inputs: readonly QueryData[]): readonly PlanShape[] | string {
  const shapes: PlanShape[] = [];
  for (const input of inputs) {
    const shape = collectStaticRowsPlan(input);
    if (typeof shape === 'string') {
      return shape;
    }
    shapes.push(shape);
  }
  return shapes;
}

function collectRightBranchPlan(
  data: QueryData,
  options: { readonly allowNestedJoin: boolean }
): RightBranchPlan | string {
  const steps: IncrementalBranchStep[] = [];
  return collectRightBranchPlanInternal(data, steps, {
    allowNestedJoin: options.allowNestedJoin,
    branchJoinCount: 0
  });
}

function collectRightBranchPlanInternal(
  data: QueryData,
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection
): RightBranchPlan | string {
  switch (data.op) {
    case 'from':
      return {
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'from' },
        steps,
        shape: shapeForRoot(data.relation, data.alias)
      };
    case 'lookup': {
      const reason = constantExprReason(data.value);
      if (reason !== undefined) {
        return `lookup value is not supported: ${reason}`;
      }
      return {
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'lookup', field: data.field, value: data.value },
        steps,
        shape: shapeForRoot(data.relation, data.alias)
      };
    }
    case 'where': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simplePredicateReason(data.predicate) ?? predicateShapeReason(data.predicate, root.shape);
      if (reason !== undefined) {
        return `where predicate is not supported: ${reason}`;
      }
      steps.push({ kind: 'where', predicate: data.predicate });
      return root;
    }
    case 'hash':
    case 'btree': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      for (const expression of data.expressions) {
        const reason = simpleExprReason(expression) ?? exprShapeReason(expression, root.shape);
        if (reason !== undefined) {
          return `${data.op} expression is not supported: ${reason}`;
        }
      }
      return root;
    }
    case 'keyBy':
      return collectRightBranchPlanInternal(data.input, steps, collection);
    case 'select': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection) ?? projectionShapeReason(data.projection, root.shape);
      if (reason !== undefined) {
        return `select projection is not supported: ${reason}`;
      }
      steps.push({ kind: 'select', projection: data.projection });
      return { ...root, shape: selectShape(root.shape, data.projection) };
    }
    case 'extend': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection) ?? projectionShapeReason(data.projection, root.shape);
      if (reason !== undefined) {
        return `extend projection is not supported: ${reason}`;
      }
      steps.push({ kind: 'extend', projection: data.projection });
      return { ...root, shape: extendShape(root.shape, data.projection) };
    }
    case 'expand': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simpleExprReason(data.collection) ?? exprShapeReason(data.collection, root.shape);
      if (reason !== undefined) {
        return `expand collection is not supported: ${reason}`;
      }
      steps.push({
        kind: 'expand',
        collection: data.collection,
        ...(data.alias === undefined ? {} : { alias: data.alias }),
        ...(data.fields === undefined ? {} : { fields: data.fields })
      });
      return { ...root, shape: expandShape(root.shape, data.alias, data.fields) };
    }
    case 'without': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'without', fields: data.fields });
      return { ...root, shape: withoutShape(root.shape, data.fields) };
    }
    case 'rename': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'rename', fields: data.fields });
      return { ...root, shape: renameShape(root.shape, data.fields) };
    }
    case 'qualify': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'qualify', alias: data.alias });
      return { ...root, shape: qualifyShape(root.shape, data.alias) };
    }
    case 'join': {
      if (data.kind !== 'inner') {
        return 'right branch left joins are not supported';
      }
      if (!collection.allowNestedJoin) {
        return 'right branch joins are not supported';
      }
      if (collection.branchJoinCount > 0) {
        return 'nested right branch joins deeper than one level are not supported';
      }

      const left = collectRightBranchPlanInternal(data.left, steps, {
        allowNestedJoin: false,
        branchJoinCount: 0
      });
      if (typeof left === 'string') {
        return `nested right branch join left side is not supported: ${left}`;
      }

      const right = collectRightBranchPlan(data.right, { allowNestedJoin: false });
      if (typeof right === 'string') {
        return `nested right branch join right side is not supported: ${right}`;
      }

      if (shapesOverlap(left.shape, right.shape)) {
        return 'ambiguous or self nested right branch joins are not supported';
      }

      const predicateReason = simplePredicateReason(data.on);
      if (predicateReason !== undefined) {
        return `nested right branch join predicate is not supported: ${predicateReason}`;
      }

      const equality = equalityJoinPlan(data.on, (expr) => expressionSideForShapes(expr, left.shape, right.shape));
      if (equality === undefined) {
        return 'nested right branch join incremental maintenance requires an unambiguous field equality predicate';
      }

      const id = `branchJoin:${collection.branchJoinCount}`;
      collection.branchJoinCount += 1;
      steps.push({
        kind: 'join',
        joinKind: 'inner',
        id,
        right: branchPlan(right),
        left: equality.left,
        rightExpr: equality.right,
        predicate: data.on,
        needsPredicateCheck: equality.needsPredicateCheck
      });
      return { ...left, shape: mergeShapes(left.shape, right.shape) };
    }
    case 'sort':
      return 'sort is not supported';
    case 'limit':
      return 'limit is not supported';
    case 'sortLimit':
      return 'sortLimit is not supported';
    case 'union':
      return 'union is not supported';
    case 'intersection':
      return collectRightBranchIntersectionPlan(data.inputs, steps, collection);
    case 'difference':
      return collectRightBranchDifferencePlan(data.left, data.right, steps, collection);
    case 'constRows':
      return 'constRows is not supported';
    case 'aggregate':
      return 'aggregate is not supported';
  }
}

function collectRightBranchIntersectionPlan(
  inputs: readonly QueryData[],
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection
): RightBranchPlan | string {
  const [leftInput, ...rightInputs] = inputs;
  if (leftInput === undefined || rightInputs.length === 0) {
    return 'intersection requires one supported relation branch and static right branches';
  }

  const root = collectRightBranchPlanInternal(leftInput, steps, collection);
  if (typeof root === 'string') {
    return `intersection first branch is not supported: ${root}`;
  }

  const rightRows = collectStaticSetRows(rightInputs, 'intersection');
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'intersection', rightRows });
  return root;
}

function collectRightBranchDifferencePlan(
  leftInput: QueryData,
  rightInput: QueryData,
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection
): RightBranchPlan | string {
  const root = collectRightBranchPlanInternal(leftInput, steps, collection);
  if (typeof root === 'string') {
    return `difference left branch is not supported: ${root}`;
  }

  const rightRows = collectStaticSetRows([rightInput], 'difference');
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'difference', rightRows });
  return root;
}

function branchPlan(plan: RightBranchPlan): IncrementalBranchPlan {
  return {
    relation: plan.relation,
    alias: plan.alias,
    root: plan.root,
    steps: plan.steps
  };
}

function planRelationNames(root: RootPlan, steps: readonly IncrementalStep[]): readonly string[] {
  const names = new Set<string>([root.relation]);
  for (const step of steps) {
    if (step.kind === 'join') {
      for (const relation of branchRelationNames(step.right)) {
        names.add(relation);
      }
    }
  }
  return Array.from(names);
}

function branchRelationNames(branch: IncrementalBranchPlan): readonly string[] {
  const names = new Set<string>([branch.relation]);
  for (const step of branchJoinSteps(branch)) {
    for (const relation of branchRelationNames(step.right)) {
      names.add(relation);
    }
  }
  return Array.from(names);
}

function dynamicSetRelationNames(plan: IncrementalDynamicSetMaterializationPlan): readonly string[] {
  return Array.from(new Set(plan.branches.map((branch) => branch.relation)));
}

function joinSteps(plan: IncrementalMaterializationPlan): readonly IncrementalJoinStep[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }
  return plan.steps.filter((step): step is IncrementalJoinStep => step.kind === 'join');
}

function branchJoinSteps(branch: IncrementalBranchPlan): readonly IncrementalBranchJoinStep[] {
  return branch.steps.filter((step): step is IncrementalBranchJoinStep => step.kind === 'join');
}

function aggregateStep(plan: IncrementalMaterializationPlan): IncrementalAggregateStep | undefined {
  if (plan.kind !== 'singleRoot') {
    return undefined;
  }
  return plan.steps.find((step): step is IncrementalAggregateStep => step.kind === 'aggregate');
}

function orderedStep(plan: IncrementalMaterializationPlan): IncrementalOrderedStep | undefined {
  return plan.kind === 'singleRoot' ? plan.ordered : undefined;
}

function hasAggregateStep(steps: readonly IncrementalStep[]): boolean {
  return steps.some((step) => step.kind === 'aggregate');
}

function stepsAfterAggregate(
  plan: IncrementalMaterializationPlan
): readonly Exclude<IncrementalPipelineStep, { readonly kind: 'expand' }>[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }

  const aggregateIndex = plan.steps.findIndex((step) => step.kind === 'aggregate');
  if (aggregateIndex === -1) {
    return [];
  }

  return plan.steps.slice(aggregateIndex + 1).filter((
    step
  ): step is Exclude<IncrementalPipelineStep, { readonly kind: 'expand' }> =>
    step.kind !== 'join' && step.kind !== 'aggregate' && step.kind !== 'expand'
  );
}

function recordAggregateGroupKeys(target: Set<string>, keys: readonly string[] | undefined): void {
  for (const key of keys ?? []) {
    target.add(key);
  }
}

function incrementalRowReport<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalMaterializationState<Row>,
  next: IncrementalMaterializationState<Row>,
  changedRootKeys: ReadonlySet<string>,
  changedGroupKeys: ReadonlySet<string>
): IncrementalRowReport<Row> {
  if (next.ordered !== undefined || previous.ordered !== undefined) {
    return orderedRowReport(plan, previous, next, changedRootKeys, changedGroupKeys);
  }

  if (next.aggregate !== undefined || previous.aggregate !== undefined) {
    return aggregateRowReport(plan, previous.aggregate, next.aggregate, changedGroupKeys);
  }

  return rootRowReport(plan, previous, next, changedRootKeys);
}

function rootRowReport<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalMaterializationState<Row>,
  next: IncrementalMaterializationState<Row>,
  changedRootKeys: ReadonlySet<string>
): IncrementalRowReport<Row> {
  const options = rowDiffOptionsForPlan(plan);
  const changedKeys = orderedChangedKeys(previous.rootKeys, next.rootKeys, changedRootKeys);
  const beforeRows = previous.rootKeys
    .filter((rootKey) => changedRootKeys.has(rootKey))
    .flatMap((rootKey) => previous.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
  const afterRows = next.rootKeys
    .filter((rootKey) => changedRootKeys.has(rootKey))
    .flatMap((rootKey) => next.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
  const diff = diffMaterializationRows(beforeRows, afterRows, options);

  return {
    rowChanges: diff.changes,
    addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    rowBatches: changedKeys.map((rootKey) => {
      const before = (previous.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
      const after = (next.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
      return {
        beforeRows: before,
        afterRows: after,
        ...insertAnchorsForRoot(next, rootKey, after, options)
      };
    }).filter((batch) => batch.beforeRows.length > 0 || batch.afterRows.length > 0),
    changedRootKeys: changedKeys,
    changedGroupKeys: [],
    diagnostics: diff.diagnostics
  };
}

function aggregateRowReport<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalAggregateState<Row> | undefined,
  next: IncrementalAggregateState<Row> | undefined,
  changedGroupKeys: ReadonlySet<string>
): IncrementalRowReport<Row> {
  const options = rowDiffOptionsForPlan(plan);
  const previousGroupKeys = previous?.groupKeys ?? [];
  const nextGroupKeys = next?.groupKeys ?? [];
  const changedKeys = orderedChangedKeys(previousGroupKeys, nextGroupKeys, changedGroupKeys);
  const beforeRows = previousGroupKeys
    .filter((groupKey) => changedGroupKeys.has(groupKey))
    .flatMap((groupKey) => {
      const group = previous?.groupsByKey.get(groupKey);
      return group === undefined ? [] : [group.output];
    });
  const afterRows = nextGroupKeys
    .filter((groupKey) => changedGroupKeys.has(groupKey))
    .flatMap((groupKey) => {
      const group = next?.groupsByKey.get(groupKey);
      return group === undefined ? [] : [group.output];
    });
  const diff = diffMaterializationRows(beforeRows, afterRows, options);

  return {
    rowChanges: diff.changes,
    addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    rowBatches: changedKeys.map((groupKey) => {
      const beforeGroup = previous?.groupsByKey.get(groupKey);
      const afterGroup = next?.groupsByKey.get(groupKey);
      const before = beforeGroup === undefined ? [] : [beforeGroup.output];
      const after = afterGroup === undefined ? [] : [afterGroup.output];
      return {
        beforeRows: before,
        afterRows: after,
        ...insertAnchorsForAggregate(next, groupKey, after, options)
      };
    }).filter((batch) => batch.beforeRows.length > 0 || batch.afterRows.length > 0),
    changedRootKeys: [],
    changedGroupKeys: changedKeys,
    diagnostics: diff.diagnostics
  };
}

function orderedRowReport<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalMaterializationState<Row>,
  next: IncrementalMaterializationState<Row>,
  changedRootKeys: ReadonlySet<string>,
  changedGroupKeys: ReadonlySet<string>
): IncrementalRowReport<Row> {
  const options = rowDiffOptionsForPlan(plan);
  const beforeRows = previous.ordered?.rows ?? [];
  const afterRows = next.ordered?.rows ?? [];
  const diff = diffMaterializationRows(beforeRows, afterRows, options);
  const rowChanges = [
    ...diff.changes,
    ...orderedMoveRowChanges(beforeRows, afterRows, options, diff.changes)
  ];
  const rowBatches = materializationStableKey(beforeRows) === materializationStableKey(afterRows)
    ? []
    : [{ beforeRows, afterRows }];

  return {
    rowChanges,
    addedRows: rowChanges.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removedRows: rowChanges.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    rowBatches,
    changedRootKeys: orderedChangedKeys(previous.rootKeys, next.rootKeys, changedRootKeys),
    changedGroupKeys: orderedChangedKeys(previous.aggregate?.groupKeys ?? [], next.aggregate?.groupKeys ?? [], changedGroupKeys),
    diagnostics: diff.diagnostics
  };
}

function orderedMoveRowChanges<Row>(
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  options: MaterializationRowDiffOptions,
  existingChanges: readonly RowChange<Row>[]
): readonly RowChange<Row>[] {
  const beforeIndex = materializationRowIndex(beforeRows, options);
  const afterIndex = materializationRowIndex(afterRows, options);
  if (
    beforeIndex.duplicates.size > 0 ||
    afterIndex.duplicates.size > 0 ||
    beforeIndex.diagnostics.length > 0 ||
    afterIndex.diagnostics.length > 0
  ) {
    return [];
  }

  const changedKeys = new Set(existingChanges.map((change) => change.key));
  const changes: RowChange<Row>[] = [];
  for (const [key, beforePosition] of beforeIndex.indexByKey) {
    if (changedKeys.has(key)) {
      continue;
    }

    const afterPosition = afterIndex.indexByKey.get(key);
    if (afterPosition !== undefined && afterPosition !== beforePosition) {
      changes.push({
        kind: 'updated',
        key,
        before: beforeRows[beforePosition] as Row,
        after: afterRows[afterPosition] as Row
      });
    }
  }
  return changes;
}

function orderedChangedKeys(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  changedKeys: ReadonlySet<string>
): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of previousKeys) {
    if (changedKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  for (const key of nextKeys) {
    if (changedKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

function insertAnchorsForRoot<Row>(
  state: IncrementalMaterializationState<Row>,
  rootKey: string,
  rows: readonly Row[],
  options: MaterializationRowDiffOptions
): Pick<IncrementalRowBatch<Row>, 'insertAfterKey' | 'insertBeforeKey'> {
  if (rows.length === 0) {
    return {};
  }

  const rootIndex = rootIndexByKeyForState(state).get(rootKey);
  if (rootIndex === undefined) {
    return {};
  }

  for (let index = rootIndex - 1; index >= 0; index -= 1) {
    const previousRootKey = state.rootKeys[index];
    const previousRows = previousRootKey === undefined
      ? []
      : state.outputsByRootKey.get(previousRootKey) ?? [];
    const row = previousRows.at(-1) as Row | undefined;
    if (row !== undefined) {
      return { insertAfterKey: materializationRowKey(row, options) };
    }
  }

  for (let index = rootIndex + 1; index < state.rootKeys.length; index += 1) {
    const nextRootKey = state.rootKeys[index];
    const nextRows = nextRootKey === undefined
      ? []
      : state.outputsByRootKey.get(nextRootKey) ?? [];
    const row = nextRows[0] as Row | undefined;
    if (row !== undefined) {
      return { insertBeforeKey: materializationRowKey(row, options) };
    }
  }

  return {};
}

function insertAnchorsForAggregate<Row>(
  aggregate: IncrementalAggregateState<Row> | undefined,
  groupKey: string,
  rows: readonly Row[],
  options: MaterializationRowDiffOptions
): Pick<IncrementalRowBatch<Row>, 'insertAfterKey' | 'insertBeforeKey'> {
  if (aggregate === undefined || rows.length === 0) {
    return {};
  }

  const groupIndex = aggregate.groupKeys.indexOf(groupKey);
  if (groupIndex === -1) {
    return {};
  }

  for (let index = groupIndex - 1; index >= 0; index -= 1) {
    const group = aggregate.groupsByKey.get(aggregate.groupKeys[index] ?? '');
    if (group !== undefined) {
      return { insertAfterKey: materializationRowKey(group.output, options) };
    }
  }

  for (let index = groupIndex + 1; index < aggregate.groupKeys.length; index += 1) {
    const group = aggregate.groupsByKey.get(aggregate.groupKeys[index] ?? '');
    if (group !== undefined) {
      return { insertBeforeKey: materializationRowKey(group.output, options) };
    }
  }

  return {};
}

function evaluateRootRow<Row>(
  plan: IncrementalSingleRootMaterializationPlan,
  relationRow: unknown,
  env: Readonly<Record<string, unknown>>,
  joinStateById: ReadonlyMap<string, IncrementalJoinState>
): RootEvaluation<Row> {
  const rootRow = rootContext(plan, relationRow, env);
  if (rootRow === undefined) {
    return { supported: true, rows: [], joinValuesByStep: new Map() };
  }

  let rows: readonly Record<string, unknown>[] = [rootRow];
  const joinValuesByStep = new Map<string, readonly unknown[]>();
  for (const step of plan.steps) {
    if (step.kind === 'aggregate') {
      break;
    } else if (step.kind === 'join') {
      const joinState = joinStateById.get(step.id);
      if (joinState === undefined) {
        return {
          supported: false,
          reason: `incremental join state ${step.id} is missing; snapshot recompute is required`
        };
      }
      joinValuesByStep.set(step.id, rows.map((row) => exprValue(row, step.left, env)));
      rows = evaluateJoinStep(rows, step, joinState, env);
    } else if (step.kind === 'expand') {
      const expanded = evaluateExpandStep(rows, step, env);
      if (!expanded.supported) {
        return {
          supported: false,
          reason: expanded.reason
        };
      }
      rows = expanded.rows;
    } else {
      rows = evaluateStep(rows, step, env);
    }
    if (rows.length === 0) {
      return { supported: true, rows: [], joinValuesByStep };
    }
  }

  return { supported: true, rows: rows as readonly Row[], joinValuesByStep };
}

function rootContext(
  plan: IncrementalSingleRootMaterializationPlan,
  relationRow: unknown,
  env: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (plan.root.kind === 'lookup') {
    if (!isRecord(relationRow) || !Object.is(relationRow[plan.root.field], exprValue({}, plan.root.value, env))) {
      return undefined;
    }
  }

  return { [plan.rootAlias]: relationRow };
}

function evaluateStep(
  rows: readonly Record<string, unknown>[],
  step: Exclude<IncrementalPipelineStep, { readonly kind: 'expand' }>,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  switch (step.kind) {
    case 'where':
      return rows.filter((row) => matchesPredicate(row, step.predicate, env));
    case 'select':
      return rows.map((row) => projectRow(row, step.projection, env));
    case 'extend':
      return rows.map((row) => ({ ...row, ...projectRow(row, step.projection, env) }));
    case 'without':
      return rows.map((row) => {
        const output = { ...row };
        for (const field of step.fields) {
          delete output[field];
        }
        return output;
      });
    case 'rename':
      return rows.map((row) => renameRow(row, step.fields));
    case 'qualify':
      return rows.map((row) => ({ [step.alias]: row }));
    case 'setFilter':
      return rows.filter((row) => matchesStaticSetFilter(row, step));
  }
}

function evaluateExpandStep(
  rows: readonly Record<string, unknown>[],
  step: Extract<IncrementalPipelineStep, { readonly kind: 'expand' }>,
  env: Readonly<Record<string, unknown>>
):
  | { readonly supported: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly supported: false; readonly reason: string } {
  const output: Record<string, unknown>[] = [];

  for (const row of rows) {
    const value = exprValue(row, step.collection, env);
    if (value === null || value === undefined || !isIterable(value)) {
      continue;
    }
    if (!Array.isArray(value) && !(value instanceof Set)) {
      return {
        supported: false,
        reason: 'expand collection produced a non-array/non-set iterable; snapshot recompute is required'
      };
    }

    for (const item of value) {
      if (step.alias !== undefined) {
        output.push({ ...row, [step.alias]: item });
      } else if (isRecord(item)) {
        output.push({ ...row, ...pickFields(item, step.fields) });
      }
    }
  }

  return { supported: true, rows: output };
}

function evaluateJoinStep(
  rows: readonly Record<string, unknown>[],
  step: IncrementalJoinLikeStep,
  state: IncrementalJoinState,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];

  for (const leftRow of rows) {
    const leftValue = exprValue(leftRow, step.left, env);
    const candidates = state.indexByValue.get(stableKey(leftValue)) ?? [];
    let matched = false;
    for (const candidate of candidates) {
      if (!Object.is(leftValue, candidate.value)) {
        continue;
      }

      const merged = { ...leftRow, ...candidate.row };
      if (!step.needsPredicateCheck || matchesPredicate(merged, step.predicate, env)) {
        matched = true;
        output.push(merged);
      }
    }

    if (!matched && step.joinKind === 'left') {
      output.push(leftRow);
    }
  }

  return output;
}

function evaluateBranchRows(
  branch: IncrementalBranchPlan,
  relationRow: unknown,
  env: Readonly<Record<string, unknown>>,
  joinStateById: ReadonlyMap<string, IncrementalJoinState> = new Map()
): BranchEvaluation {
  const rootRow = branchRootContext(branch, relationRow, env);
  if (rootRow === undefined) {
    return { supported: true, rows: [], joinValuesByStep: new Map() };
  }

  let rows: readonly Record<string, unknown>[] = [rootRow];
  const joinValuesByStep = new Map<string, readonly unknown[]>();
  for (const step of branch.steps) {
    if (step.kind === 'join') {
      const joinState = joinStateById.get(step.id);
      if (joinState === undefined) {
        return {
          supported: false,
          reason: `incremental branch join state ${step.id} is missing; snapshot recompute is required`
        };
      }
      joinValuesByStep.set(step.id, rows.map((row) => exprValue(row, step.left, env)));
      rows = evaluateJoinStep(rows, step, joinState, env);
    } else if (step.kind === 'expand') {
      const expanded = evaluateExpandStep(rows, step, env);
      if (!expanded.supported) {
        return expanded;
      }
      rows = expanded.rows;
    } else {
      rows = evaluateStep(rows, step, env);
    }
    if (rows.length === 0) {
      return { supported: true, rows: [], joinValuesByStep };
    }
  }

  return { supported: true, rows, joinValuesByStep };
}

function evaluateStaticRows(
  data: QueryData,
  env: Readonly<Record<string, unknown>>
): StaticRowsEvaluation {
  switch (data.op) {
    case 'constRows':
      return { supported: true, rows: data.rows.map((row) => ({ ...row })) };
    case 'where': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: input.rows.filter((row) => matchesPredicate(row, data.predicate, env)) }
        : input;
    }
    case 'hash':
    case 'btree':
    case 'keyBy':
      return evaluateStaticRows(data.input, env);
    case 'select': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: input.rows.map((row) => projectRow(row, data.projection, env)) }
        : input;
    }
    case 'extend': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? {
            supported: true,
            rows: input.rows.map((row) => ({ ...row, ...projectRow(row, data.projection, env) }))
          }
        : input;
    }
    case 'expand': {
      const input = evaluateStaticRows(data.input, env);
      if (!input.supported) return input;
      return evaluateExpandStep(input.rows, {
        kind: 'expand',
        collection: data.collection,
        ...(data.alias === undefined ? {} : { alias: data.alias }),
        ...(data.fields === undefined ? {} : { fields: data.fields })
      }, env);
    }
    case 'without': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? {
            supported: true,
            rows: input.rows.map((row) => {
              const output = { ...row };
              for (const field of data.fields) {
                delete output[field];
              }
              return output;
            })
          }
        : input;
    }
    case 'rename': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: input.rows.map((row) => renameRow(row, data.fields)) }
        : input;
    }
    case 'qualify': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: input.rows.map((row) => ({ [data.alias]: row })) }
        : input;
    }
    case 'union': {
      const inputs = evaluateStaticInputs(data.inputs, env);
      return inputs.supported
        ? { supported: true, rows: setUnionRows(inputs.rows) }
        : inputs;
    }
    case 'intersection': {
      const inputs = evaluateStaticInputs(data.inputs, env);
      return inputs.supported
        ? { supported: true, rows: setIntersectionRows(inputs.rows) }
        : inputs;
    }
    case 'difference': {
      const left = evaluateStaticRows(data.left, env);
      if (!left.supported) return left;
      const right = evaluateStaticRows(data.right, env);
      if (!right.supported) return right;
      return { supported: true, rows: setDifferenceRows(left.rows, right.rows) };
    }
    case 'from':
    case 'lookup':
    case 'join':
      return { supported: false, reason: staticRowsRelationReason };
    case 'sort':
    case 'limit':
    case 'sortLimit':
    case 'aggregate':
      return { supported: false, reason: `${data.op} is not supported for static incremental maintenance` };
  }
}

function evaluateStaticInputs(
  inputs: readonly QueryData[],
  env: Readonly<Record<string, unknown>>
):
  | { readonly supported: true; readonly rows: readonly (readonly Record<string, unknown>[])[] }
  | { readonly supported: false; readonly reason: string } {
  const rows: Array<readonly Record<string, unknown>[]> = [];
  for (const input of inputs) {
    const evaluated = evaluateStaticRows(input, env);
    if (!evaluated.supported) {
      return evaluated;
    }
    rows.push(evaluated.rows);
  }
  return { supported: true, rows };
}

function branchRootContext(
  branch: IncrementalBranchPlan,
  relationRow: unknown,
  env: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (branch.root.kind === 'lookup') {
    if (!isRecord(relationRow) || !Object.is(relationRow[branch.root.field], exprValue({}, branch.root.value, env))) {
      return undefined;
    }
  }

  return { [branch.alias]: relationRow };
}

function projectRow(
  row: Record<string, unknown>,
  projection: ProjectionData,
  env: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([field, item]) => [
    field,
    exprValue(row, projectionExpr(item), env)
  ]));
}

function renameRow(row: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
  const output = { ...row };
  for (const [from, to] of Object.entries(fields)) {
    output[to] = output[from];
    delete output[from];
  }
  return output;
}

function matchesStaticSetFilter(
  row: Record<string, unknown>,
  step: Extract<IncrementalPipelineStep, { readonly kind: 'setFilter' }>
): boolean {
  const key = stableKey(row);
  if (step.op === 'intersection') {
    return step.rightRows.every((rows) => rows.some((candidate) => stableKey(candidate) === key));
  }

  return !step.rightRows.some((rows) => rows.some((candidate) => stableKey(candidate) === key));
}

function setUnionRows(
  inputs: readonly (readonly Record<string, unknown>[])[]
): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  const output: Record<string, unknown>[] = [];

  for (const rows of inputs) {
    for (const row of rows) {
      const key = stableKey(row);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(row);
    }
  }

  return output;
}

function setIntersectionRows(
  inputs: readonly (readonly Record<string, unknown>[])[]
): readonly Record<string, unknown>[] {
  const [first = [], ...rest] = inputs;
  return first.filter((row) => rest.every((rows) => rows.some((candidate) => stableKey(candidate) === stableKey(row))));
}

function setDifferenceRows(
  left: readonly Record<string, unknown>[],
  right: readonly Record<string, unknown>[]
): readonly Record<string, unknown>[] {
  const rightKeys = new Set(right.map((row) => stableKey(row)));
  return left.filter((row) => !rightKeys.has(stableKey(row)));
}

type DynamicSetBranchSummary = {
  readonly countsByRowKey: ReadonlyMap<string, number>;
  readonly firstRowsByRowKey: ReadonlyMap<string, Record<string, unknown>>;
  readonly firstOrderByRowKey: ReadonlyMap<string, number>;
};

function dynamicSetRows(
  plan: IncrementalDynamicSetMaterializationPlan,
  branchStates: readonly IncrementalSetBranchState[]
): readonly Record<string, unknown>[] {
  const summaries = branchStates.map(dynamicSetBranchSummary);
  switch (plan.op) {
    case 'union':
      return dynamicSetUnionRows(summaries);
    case 'intersection':
      return dynamicSetIntersectionRows(summaries);
    case 'difference':
      return dynamicSetDifferenceRows(summaries);
  }
}

function dynamicSetBranchSummary(state: IncrementalSetBranchState): DynamicSetBranchSummary {
  const countsByRowKey = new Map<string, number>();
  const firstRowsByRowKey = new Map<string, Record<string, unknown>>();
  const firstOrderByRowKey = new Map<string, number>();
  let order = 0;

  for (const relationKey of state.relationKeys) {
    for (const row of state.rowsByRelationKey.get(relationKey) ?? []) {
      const key = stableKey(row);
      countsByRowKey.set(key, (countsByRowKey.get(key) ?? 0) + 1);
      if (!firstRowsByRowKey.has(key)) {
        firstRowsByRowKey.set(key, row);
        firstOrderByRowKey.set(key, order);
      }
      order += 1;
    }
  }

  return { countsByRowKey, firstRowsByRowKey, firstOrderByRowKey };
}

function dynamicSetUnionRows(
  summaries: readonly DynamicSetBranchSummary[]
): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  const entries: Array<{
    readonly branchIndex: number;
    readonly order: number;
    readonly row: Record<string, unknown>;
  }> = [];

  summaries.forEach((summary, branchIndex) => {
    for (const [rowKey, row] of summary.firstRowsByRowKey) {
      if (seen.has(rowKey) || (summary.countsByRowKey.get(rowKey) ?? 0) === 0) {
        continue;
      }
      seen.add(rowKey);
      entries.push({
        branchIndex,
        order: summary.firstOrderByRowKey.get(rowKey) ?? Number.MAX_SAFE_INTEGER,
        row
      });
    }
  });

  return entries
    .sort((left, right) => left.branchIndex - right.branchIndex || left.order - right.order)
    .map((entry) => entry.row);
}

function dynamicSetIntersectionRows(
  summaries: readonly DynamicSetBranchSummary[]
): readonly Record<string, unknown>[] {
  const [left, ...rest] = summaries;
  if (left === undefined) {
    return [];
  }

  const entries: Array<{
    readonly order: number;
    readonly row: Record<string, unknown>;
  }> = [];
  for (const [rowKey, row] of left.firstRowsByRowKey) {
    if ((left.countsByRowKey.get(rowKey) ?? 0) === 0) {
      continue;
    }
    if (!rest.every((summary) => (summary.countsByRowKey.get(rowKey) ?? 0) > 0)) {
      continue;
    }
    entries.push({
      order: left.firstOrderByRowKey.get(rowKey) ?? Number.MAX_SAFE_INTEGER,
      row
    });
  }

  return entries.sort((leftEntry, rightEntry) => leftEntry.order - rightEntry.order).map((entry) => entry.row);
}

function dynamicSetDifferenceRows(
  summaries: readonly DynamicSetBranchSummary[]
): readonly Record<string, unknown>[] {
  const [left, ...right] = summaries;
  if (left === undefined) {
    return [];
  }

  const entries: Array<{
    readonly order: number;
    readonly row: Record<string, unknown>;
  }> = [];
  for (const [rowKey, row] of left.firstRowsByRowKey) {
    if ((left.countsByRowKey.get(rowKey) ?? 0) === 0) {
      continue;
    }
    if (right.some((summary) => (summary.countsByRowKey.get(rowKey) ?? 0) > 0)) {
      continue;
    }
    entries.push({
      order: left.firstOrderByRowKey.get(rowKey) ?? Number.MAX_SAFE_INTEGER,
      row
    });
  }

  return entries.sort((leftEntry, rightEntry) => leftEntry.order - rightEntry.order).map((entry) => entry.row);
}

function dynamicSetMaterializationState<Row>(
  branchStates: readonly IncrementalSetBranchState[],
  rows: readonly Row[]
): IncrementalMaterializationState<Row> {
  const rootKeys = rows.map((row) => stableKey(row));
  const rootRowsByRootKey = new Map<string, unknown>();
  const outputsByRootKey = new Map<string, readonly unknown[]>();

  for (const [index, row] of rows.entries()) {
    const key = rootKeys[index] as string;
    rootRowsByRootKey.set(key, row);
    outputsByRootKey.set(key, [row]);
  }

  return {
    kind: 'incrementalMaterializationState',
    rootRelation: '',
    rootKeys,
    rootIndexByKey: indexKeys(rootKeys),
    rootRowsByRootKey,
    outputsByRootKey,
    joinStates: [],
    dynamicSet: {
      branches: branchStates
    }
  };
}

export function rowsFromIncrementalState<Row>(state: IncrementalMaterializationState<Row>): readonly Row[] {
  if (state.ordered !== undefined) {
    return state.ordered.rows;
  }

  if (state.aggregate !== undefined) {
    return state.aggregate.groupKeys.flatMap((key) => {
      const group = state.aggregate?.groupsByKey.get(key);
      return group === undefined ? [] : [group.output];
    });
  }

  return state.rootKeys.flatMap((key) => state.outputsByRootKey.get(key) ?? []) as readonly Row[];
}

function buildOrderedState<Row>(
  plan: IncrementalMaterializationPlan,
  state: IncrementalMaterializationState<Row>,
  env: Readonly<Record<string, unknown>>
): OrderedStateResult<Row> | undefined {
  const ordered = orderedStep(plan);
  if (ordered === undefined) {
    return undefined;
  }

  const ownerKeys = orderedOwnerKeys(state);
  const entriesByOwnerKey = new Map<string, readonly IncrementalOrderedEntry<Row>[]>();
  for (const ownerKey of ownerKeys) {
    const entries = orderedEntriesForOwner<Row>(plan, ownerKey, state, env);
    if (!entries.supported) {
      return entries;
    }
    if (entries.entries.length > 0) {
      entriesByOwnerKey.set(ownerKey, entries.entries);
    }
  }

  return finalizeOrderedState(plan, entriesByOwnerKey, ownerKeys);
}

function maintainOrderedState<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalOrderedState<Row>,
  state: IncrementalMaterializationState<Row>,
  changedOwnerKeys: ReadonlySet<string>,
  env: Readonly<Record<string, unknown>>
): OrderedStateResult<Row> {
  const ownerKeys = orderedOwnerKeys(state);
  const ownerKeySet = new Set(ownerKeys);
  const entriesByOwnerKey = new Map(previous.entriesByOwnerKey);

  for (const ownerKey of entriesByOwnerKey.keys()) {
    if (!ownerKeySet.has(ownerKey)) {
      entriesByOwnerKey.delete(ownerKey);
    }
  }

  for (const ownerKey of changedOwnerKeys) {
    if (!ownerKeySet.has(ownerKey)) {
      entriesByOwnerKey.delete(ownerKey);
      continue;
    }

    const entries = orderedEntriesForOwner<Row>(plan, ownerKey, state, env);
    if (!entries.supported) {
      return entries;
    }
    if (entries.entries.length === 0) {
      entriesByOwnerKey.delete(ownerKey);
    } else {
      entriesByOwnerKey.set(ownerKey, entries.entries);
    }
  }

  return finalizeOrderedState(plan, entriesByOwnerKey, ownerKeys);
}

function finalizeOrderedState<Row>(
  plan: IncrementalMaterializationPlan,
  entriesByOwnerKey: ReadonlyMap<string, readonly IncrementalOrderedEntry<Row>[]>,
  ownerKeys: readonly string[]
): OrderedStateResult<Row> {
  const ordered = orderedStep(plan);
  if (ordered === undefined) {
    return {
      supported: false,
      reason: 'ordered step is missing from ordered incremental plan'
    };
  }

  const ownerIndexByKey = indexKeys(ownerKeys);
  const entriesByKey = new Map<string, IncrementalOrderedEntry<Row>>();
  for (const entries of entriesByOwnerKey.values()) {
    for (const entry of entries) {
      entriesByKey.set(entry.key, entry);
    }
  }

  const duplicateReason = duplicateOrderedRowKeyReason(entriesByKey.values());
  if (duplicateReason !== undefined) {
    return {
      supported: false,
      reason: duplicateReason
    };
  }

  const orderedEntryKeys = Array.from(entriesByKey.keys()).sort((leftKey, rightKey) => {
    const left = entriesByKey.get(leftKey);
    const right = entriesByKey.get(rightKey);
    if (left === undefined || right === undefined) {
      return 0;
    }
    return compareOrderedEntries(ordered, ownerIndexByKey, left, right);
  });
  const visibleEntryKeys = visibleOrderedEntryKeys(ordered, orderedEntryKeys);

  return {
    supported: true,
    state: {
      entriesByOwnerKey,
      entriesByKey,
      orderedEntryKeys,
      visibleEntryKeys,
      rows: visibleEntryKeys.flatMap((key) => {
        const entry = entriesByKey.get(key);
        return entry === undefined ? [] : [entry.row];
      })
    }
  };
}

function orderedEntriesForOwner<Row>(
  plan: IncrementalMaterializationPlan,
  ownerKey: string,
  state: IncrementalMaterializationState<Row>,
  env: Readonly<Record<string, unknown>>
):
  | { readonly supported: true; readonly entries: readonly IncrementalOrderedEntry<Row>[] }
  | { readonly supported: false; readonly reason: string } {
  const ordered = orderedStep(plan);
  if (ordered === undefined) {
    return {
      supported: false,
      reason: 'ordered step is missing from ordered incremental plan'
    };
  }

  const options = rowDiffOptionsForPlan(plan);
  const entries: IncrementalOrderedEntry<Row>[] = [];
  for (const [rowIndex, row] of orderedOwnerRows(state, ownerKey).entries()) {
    const sourceRow = asRecord(row);
    const postOrderRows = evaluatePostOrderRows(ordered, sourceRow, env);
    if (postOrderRows.length !== 1) {
      return {
        supported: false,
        reason: 'post-order incremental projection produced an unexpected row count; snapshot recompute is required'
      };
    }

    const output = postOrderRows[0] as Row;
    let rowKeyValue: string;
    try {
      rowKeyValue = materializationRowKey(output, options);
    } catch (error) {
      return {
        supported: false,
        reason: `ordered materialization row key selection failed: ${materializationErrorMessage(error)}`
      };
    }

    entries.push({
      key: stableKey([ownerKey, rowIndex]),
      ownerKey,
      rowIndex,
      sortValues: ordered.order.map((item) => exprValue(sourceRow, item.expr, env)),
      row: output,
      rowKey: rowKeyValue
    });
  }
  return { supported: true, entries };
}

function evaluatePostOrderRows(
  ordered: IncrementalOrderedStep,
  row: Record<string, unknown>,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  let rows: readonly Record<string, unknown>[] = [row];
  for (const step of ordered.postSteps) {
    rows = evaluateStep(rows, step, env);
  }
  return rows;
}

function orderedOwnerKeys<Row>(state: IncrementalMaterializationState<Row>): readonly string[] {
  return state.aggregate === undefined ? state.rootKeys : state.aggregate.groupKeys;
}

function orderedOwnerRows<Row>(
  state: IncrementalMaterializationState<Row>,
  ownerKey: string
): readonly unknown[] {
  if (state.aggregate !== undefined) {
    const group = state.aggregate.groupsByKey.get(ownerKey);
    return group === undefined ? [] : [group.output];
  }

  return state.outputsByRootKey.get(ownerKey) ?? [];
}

function duplicateOrderedRowKeyReason<Row>(
  entries: Iterable<IncrementalOrderedEntry<Row>>
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.rowKey)) {
      return `ordered materialization has duplicate final row key ${entry.rowKey}; snapshot recompute is required`;
    }
    seen.add(entry.rowKey);
  }
  return undefined;
}

function compareOrderedEntries<Row>(
  ordered: IncrementalOrderedStep,
  ownerIndexByKey: ReadonlyMap<string, number>,
  left: IncrementalOrderedEntry<Row>,
  right: IncrementalOrderedEntry<Row>
): number {
  for (let index = 0; index < ordered.order.length; index += 1) {
    const item = ordered.order[index] as SortData;
    const comparison = compareSortValues(
      left.sortValues[index],
      right.sortValues[index],
      item.direction,
      item.nulls
    );
    if (comparison !== 0) {
      return comparison;
    }
  }

  return (
    (ownerIndexByKey.get(left.ownerKey) ?? Number.MAX_SAFE_INTEGER) -
    (ownerIndexByKey.get(right.ownerKey) ?? Number.MAX_SAFE_INTEGER)
  ) || left.rowIndex - right.rowIndex || left.key.localeCompare(right.key);
}

function visibleOrderedEntryKeys(
  ordered: IncrementalOrderedStep,
  orderedEntryKeys: readonly string[]
): readonly string[] {
  if (ordered.window === undefined) {
    return orderedEntryKeys;
  }

  return orderedEntryKeys.slice(ordered.window.offset, ordered.window.offset + ordered.window.count);
}

function buildAggregateState<Row>(
  plan: IncrementalMaterializationPlan,
  rootKeys: readonly string[],
  outputsByRootKey: ReadonlyMap<string, readonly unknown[]>,
  env: Readonly<Record<string, unknown>>
): AggregateStateResult<Row> {
  const aggregate = aggregateStep(plan);
  if (aggregate === undefined) {
    return {
      supported: false,
      reason: 'aggregate step is missing from aggregate incremental plan'
    };
  }

  const groupKeysByRootKey = new Map<string, readonly string[]>();
  for (const rootKey of rootKeys) {
    const groupKeys = aggregateGroupKeysForRows(aggregate, outputsByRootKey.get(rootKey) ?? [], env);
    if (groupKeys.length > 0) {
      groupKeysByRootKey.set(rootKey, groupKeys);
    }
  }

  const rootKeysByGroupKey = buildRootKeysByGroupKey(rootKeys, groupKeysByRootKey);
  const groupKeys = aggregateGroupOrder(aggregate, indexKeys(rootKeys), rootKeysByGroupKey);
  const groupsByKey = new Map<string, IncrementalAggregateGroupState<Row>>();
  for (const groupKey of groupKeys) {
    const group = recomputeAggregateGroup<Row>(
      plan,
      groupKey,
      rootKeysByGroupKey.get(groupKey) ?? [],
      outputsByRootKey,
      env
    );
    if (!group.supported) {
      return group;
    }
    if (group.state !== undefined) {
      groupsByKey.set(groupKey, group.state);
    }
  }

  return {
    supported: true,
    state: {
      groupKeys,
      groupKeysByRootKey,
      rootKeysByGroupKey,
      groupsByKey
    }
  };
}

function maintainAggregateState<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalAggregateState<Row>,
  rootKeys: readonly string[],
  rootIndexByKey: ReadonlyMap<string, number>,
  outputsByRootKey: ReadonlyMap<string, readonly unknown[]>,
  groupKeysByRootKey: ReadonlyMap<string, readonly string[]>,
  rootKeysByGroupKey: ReadonlyMap<string, readonly string[]>,
  affectedGroupKeys: ReadonlySet<string>,
  env: Readonly<Record<string, unknown>>
): AggregateStateResult<Row> {
  const aggregate = aggregateStep(plan);
  if (aggregate === undefined) {
    return {
      supported: false,
      reason: 'aggregate step is missing from aggregate incremental plan'
    };
  }

  const groupKeys = aggregateGroupOrder(aggregate, rootIndexByKey, rootKeysByGroupKey);
  const groupsByKey = new Map(previous.groupsByKey);
  for (const groupKey of affectedGroupKeys) {
    const group = recomputeAggregateGroup<Row>(
      plan,
      groupKey,
      rootKeysByGroupKey.get(groupKey) ?? [],
      outputsByRootKey,
      env
    );
    if (!group.supported) {
      return group;
    }
    if (group.state === undefined) {
      groupsByKey.delete(groupKey);
    } else {
      groupsByKey.set(groupKey, group.state);
    }
  }

  if (isUngroupedAggregate(aggregate)) {
    const emptyKey = emptyGroupKey();
    if (!groupsByKey.has(emptyKey)) {
      const group = recomputeAggregateGroup<Row>(plan, emptyKey, rootKeys, outputsByRootKey, env);
      if (!group.supported) {
        return group;
      }
      if (group.state !== undefined) {
        groupsByKey.set(emptyKey, group.state);
      }
    }
  }

  for (const groupKey of previous.groupKeys) {
    if (!groupKeys.includes(groupKey)) {
      groupsByKey.delete(groupKey);
    }
  }

  return {
    supported: true,
    state: {
      groupKeys,
      groupKeysByRootKey,
      rootKeysByGroupKey,
      groupsByKey
    }
  };
}

function recomputeAggregateGroup<Row>(
  plan: IncrementalMaterializationPlan,
  groupKey: string,
  rootKeys: readonly string[],
  outputsByRootKey: ReadonlyMap<string, readonly unknown[]>,
  env: Readonly<Record<string, unknown>>
):
  | { readonly supported: true; readonly state: IncrementalAggregateGroupState<Row> | undefined }
  | { readonly supported: false; readonly reason: string } {
  const aggregate = aggregateStep(plan);
  if (aggregate === undefined) {
    return {
      supported: false,
      reason: 'aggregate step is missing from aggregate incremental plan'
    };
  }

  const rows: unknown[] = [];
  let group: Record<string, unknown> | undefined;
  for (const rootKey of rootKeys) {
    for (const row of outputsByRootKey.get(rootKey) ?? []) {
      const rowGroup = projectRow(asRecord(row), aggregate.groupBy, env);
      if (stableKey(rowGroup) !== groupKey) {
        continue;
      }
      group ??= rowGroup;
      rows.push(row);
    }
  }

  if (rows.length === 0) {
    if (!isUngroupedAggregate(aggregate) || groupKey !== emptyGroupKey()) {
      return { supported: true, state: undefined };
    }
    group = {};
  }

  const aggregateRow = evaluateAggregateRow(aggregate, group ?? {}, rows, env);
  const postAggregateRows = evaluatePostAggregateRows(plan, aggregateRow, env);
  if (postAggregateRows.length !== 1) {
    return {
      supported: false,
      reason: 'post-aggregate incremental projection produced an unexpected row count; snapshot recompute is required'
    };
  }

  return {
    supported: true,
    state: {
      group: group ?? {},
      rowCount: rows.length,
      output: postAggregateRows[0] as Row
    }
  };
}

function aggregateGroupKeysForRows(
  aggregate: IncrementalAggregateStep,
  rows: readonly unknown[],
  env: Readonly<Record<string, unknown>>
): readonly string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const row of rows) {
    const key = stableKey(projectRow(asRecord(row), aggregate.groupBy, env));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

function aggregateGroupOrder(
  aggregate: IncrementalAggregateStep,
  rootIndexByKey: ReadonlyMap<string, number>,
  rootKeysByGroupKey: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const groupKeys = Array.from(rootKeysByGroupKey.entries())
    .filter(([, rootKeys]) => rootKeys.length > 0)
    .sort((left, right) => (
      (rootIndexByKey.get(left[1][0] ?? '') ?? Number.MAX_SAFE_INTEGER) -
      (rootIndexByKey.get(right[1][0] ?? '') ?? Number.MAX_SAFE_INTEGER)
    ))
    .map(([groupKey]) => groupKey);

  if (groupKeys.length === 0 && isUngroupedAggregate(aggregate)) {
    groupKeys.push(emptyGroupKey());
  }

  return groupKeys;
}

function buildRootKeysByGroupKey(
  rootKeys: readonly string[],
  groupKeysByRootKey: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly string[]> {
  const rootKeysByGroupKey = new Map<string, string[]>();
  for (const rootKey of rootKeys) {
    for (const groupKey of groupKeysByRootKey.get(rootKey) ?? []) {
      const rootKeysForGroup = rootKeysByGroupKey.get(groupKey);
      if (rootKeysForGroup === undefined) {
        rootKeysByGroupKey.set(groupKey, [rootKey]);
      } else {
        rootKeysForGroup.push(rootKey);
      }
    }
  }
  return rootKeysByGroupKey;
}

function mutableRootKeysByGroupKey<Row>(
  state: IncrementalAggregateState<Row>
): Map<string, readonly string[]> {
  const source = state.rootKeysByGroupKey ?? buildRootKeysByGroupKey(
    Array.from(state.groupKeysByRootKey.keys()),
    state.groupKeysByRootKey
  );
  return new Map(Array.from(source, ([groupKey, rootKeys]) => [groupKey, [...rootKeys]]));
}

function removeRootFromAggregateGroups(
  rootKeysByGroupKey: Map<string, readonly string[]> | undefined,
  rootKey: string,
  groupKeys: readonly string[] | undefined
): void {
  if (rootKeysByGroupKey === undefined) {
    return;
  }

  for (const groupKey of groupKeys ?? []) {
    const rootKeys = rootKeysByGroupKey.get(groupKey);
    if (rootKeys === undefined) {
      continue;
    }

    const nextRootKeys = rootKeys.filter((candidate) => candidate !== rootKey);
    if (nextRootKeys.length === 0) {
      rootKeysByGroupKey.delete(groupKey);
    } else {
      rootKeysByGroupKey.set(groupKey, nextRootKeys);
    }
  }
}

function addRootToAggregateGroups(
  rootKeysByGroupKey: Map<string, readonly string[]> | undefined,
  rootKey: string,
  groupKeys: readonly string[],
  rootIndexByKey: ReadonlyMap<string, number>
): void {
  if (rootKeysByGroupKey === undefined) {
    return;
  }

  const rootIndex = rootIndexByKey.get(rootKey) ?? Number.MAX_SAFE_INTEGER;
  for (const groupKey of groupKeys) {
    const rootKeys = [...(rootKeysByGroupKey.get(groupKey) ?? [])];
    if (rootKeys.includes(rootKey)) {
      continue;
    }

    const insertIndex = rootKeys.findIndex((candidate) => (
      (rootIndexByKey.get(candidate) ?? Number.MAX_SAFE_INTEGER) > rootIndex
    ));
    if (insertIndex === -1) {
      rootKeys.push(rootKey);
    } else {
      rootKeys.splice(insertIndex, 0, rootKey);
    }
    rootKeysByGroupKey.set(groupKey, rootKeys);
  }
}

function isUngroupedAggregate(aggregate: IncrementalAggregateStep): boolean {
  return Object.keys(aggregate.groupBy).length === 0;
}

function emptyGroupKey(): string {
  return stableKey({});
}

function evaluateAggregateRow(
  aggregate: IncrementalAggregateStep,
  group: Record<string, unknown>,
  rows: readonly unknown[],
  env: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...group };
  for (const [name, item] of Object.entries(aggregate.aggregates)) {
    output[name] = evaluateAggregate(projectionExpr(item), rows, env);
  }
  return output;
}

function evaluatePostAggregateRows(
  plan: IncrementalMaterializationPlan,
  row: Record<string, unknown>,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  let rows: readonly Record<string, unknown>[] = [row];
  for (const step of stepsAfterAggregate(plan)) {
    rows = evaluateStep(rows, step, env);
  }
  return rows;
}

function evaluateAggregate(
  expr: ExprData,
  rows: readonly unknown[],
  env: Readonly<Record<string, unknown>>
): unknown {
  if (expr.op !== 'aggregateCall') {
    return exprValue(asRecord(rows[0] ?? {}), expr, env);
  }

  const values = expr.expr === undefined
    ? rows
    : rows.map((row) => exprValue(asRecord(row), expr.expr as ExprData, env));
  const aggregateValues = expr.distinct ? distinctValues(values) : values;

  switch (expr.name) {
    case 'count':
      return expr.expr === undefined
        ? rows.length
        : aggregateValues.filter((value) => value !== null && value !== undefined).length;
    case 'sum':
      return aggregateValues.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
    case 'avg': {
      const numbers = aggregateValues.filter((value): value is number => typeof value === 'number');
      return numbers.length === 0 ? undefined : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    case 'min':
      return orderedValues(aggregateValues).at(0);
    case 'max':
      return orderedValues(aggregateValues).at(-1);
    case 'any':
      return aggregateValues.some(Boolean);
    case 'notAny':
      return !aggregateValues.some(Boolean);
    case 'setConcat':
      return new Set(aggregateValues.flatMap((value) => {
        if (value instanceof Set) return Array.from(value);
        if (Array.isArray(value)) return value;
        return [value];
      }));
    case 'top':
      return [...orderedValues(aggregateValues)].reverse().slice(0, expr.count ?? 0);
    case 'bottom':
      return orderedValues(aggregateValues).slice(0, expr.count ?? 0);
    case 'topBy':
      return rowsByAggregate(rows, expr.expr, env, 'desc').slice(0, expr.count ?? 0);
    case 'bottomBy':
      return rowsByAggregate(rows, expr.expr, env, 'asc').slice(0, expr.count ?? 0);
    case 'maxBy':
      return rowsByAggregate(rows, expr.expr, env, 'desc').at(0);
    case 'minBy':
      return rowsByAggregate(rows, expr.expr, env, 'asc').at(0);
  }
}

function rowsByAggregate(
  rows: readonly unknown[],
  expr: ExprData | undefined,
  env: Readonly<Record<string, unknown>>,
  direction: 'asc' | 'desc'
): readonly unknown[] {
  if (expr === undefined) {
    return rows;
  }

  return rows.map((row) => ({ row, value: exprValue(asRecord(row), expr, env) }))
    .sort((left, right) => compareSortValues(left.value, right.value, direction, 'last'))
    .map((item) => item.row);
}

function distinctValues(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];

  for (const value of values) {
    const key = stableKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }

  return output;
}

function orderedValues(values: readonly unknown[]): readonly unknown[] {
  return [...values]
    .filter((value) => value !== null && value !== undefined)
    .sort(compareValues);
}

function buildJoinStates(
  plan: IncrementalMaterializationPlan,
  relationSnapshots: ReadonlyMap<string, IncrementalRelationSnapshot>,
  env: Readonly<Record<string, unknown>>
): JoinStateBuildResult {
  const states: IncrementalJoinState[] = [];

  for (const step of joinSteps(plan)) {
    const nestedJoinStatesResult = buildBranchJoinStates(step.right, relationSnapshots, env);
    if (!nestedJoinStatesResult.supported) {
      return nestedJoinStatesResult;
    }
    const nestedJoinStateById = joinStateMap(nestedJoinStatesResult.states);
    const nestedRootValuesByStep = new Map<string, Map<string, readonly unknown[]>>();
    const snapshot = relationSnapshots.get(step.right.relation);
    if (snapshot === undefined) {
      return {
        supported: false,
        reason: `relation ${step.right.relation} is not available for incremental join maintenance`
      };
    }

    const duplicateReason = duplicateRelationRowsReason(
      snapshot.relation,
      snapshot.rows,
      'right relation'
    );
    if (duplicateReason !== undefined) {
      return {
        supported: false,
        reason: duplicateReason
      };
    }

    const relationKeys: string[] = [];
    const relationRowsByKey = new Map<string, unknown>();
    const rowsByRelationKey = new Map<string, readonly Record<string, unknown>[]>();
    for (const row of snapshot.rows) {
      const key = relationKeyForRow(snapshot.relation, row);
      const evaluated = evaluateBranchRows(step.right, row, env, nestedJoinStateById);
      if (!evaluated.supported) {
        return {
          supported: false,
          reason: evaluated.reason
        };
      }
      relationKeys.push(key);
      relationRowsByKey.set(key, row);
      rowsByRelationKey.set(key, evaluated.rows);
      recordRootJoinValues(nestedRootValuesByStep, key, evaluated.joinValuesByStep);
    }

    const nestedBranchJoinStates = nestedJoinStatesResult.states.map((state) =>
      withRootJoinValues(state, nestedRootValuesByStep.get(state.id) ?? new Map())
    );
    states.push({
      id: step.id,
      relation: step.right.relation,
      relationKeys,
      relationIndexByKey: indexKeys(relationKeys),
      relationRowsByKey,
      rowsByRelationKey,
      indexByValue: buildRightIndex(step, relationKeys, rowsByRelationKey, env),
      rootValuesByKey: new Map(),
      rootKeysByValue: new Map(),
      ...(nestedBranchJoinStates.length === 0 ? {} : { nestedBranchJoinStates })
    });
  }

  return { supported: true, states };
}

function buildBranchJoinStates(
  branch: IncrementalBranchPlan,
  relationSnapshots: ReadonlyMap<string, IncrementalRelationSnapshot>,
  env: Readonly<Record<string, unknown>>
): JoinStateBuildResult {
  const states: IncrementalJoinState[] = [];

  for (const step of branchJoinSteps(branch)) {
    const snapshot = relationSnapshots.get(step.right.relation);
    if (snapshot === undefined) {
      return {
        supported: false,
        reason: `relation ${step.right.relation} is not available for nested right branch join maintenance`
      };
    }

    const duplicateReason = duplicateRelationRowsReason(
      snapshot.relation,
      snapshot.rows,
      'nested right branch relation'
    );
    if (duplicateReason !== undefined) {
      return {
        supported: false,
        reason: duplicateReason
      };
    }

    const relationKeys: string[] = [];
    const relationRowsByKey = new Map<string, unknown>();
    const rowsByRelationKey = new Map<string, readonly Record<string, unknown>[]>();
    for (const row of snapshot.rows) {
      const key = relationKeyForRow(snapshot.relation, row);
      const evaluated = evaluateBranchRows(step.right, row, env);
      if (!evaluated.supported) {
        return {
          supported: false,
          reason: evaluated.reason
        };
      }
      relationKeys.push(key);
      relationRowsByKey.set(key, row);
      rowsByRelationKey.set(key, evaluated.rows);
    }

    states.push({
      id: step.id,
      relation: step.right.relation,
      relationKeys,
      relationIndexByKey: indexKeys(relationKeys),
      relationRowsByKey,
      rowsByRelationKey,
      indexByValue: buildRightIndex(step, relationKeys, rowsByRelationKey, env),
      rootValuesByKey: new Map(),
      rootKeysByValue: new Map()
    });
  }

  return { supported: true, states };
}

function buildRightIndex(
  step: IncrementalJoinLikeStep,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  env: Readonly<Record<string, unknown>>
): ReadonlyMap<string, readonly IndexedRightRow[]> {
  const index = new Map<string, IndexedRightRow[]>();

  for (const relationKey of relationKeys) {
    const rows = rowsByRelationKey.get(relationKey) ?? [];
    for (const row of rows) {
      const value = exprValue(row, step.rightExpr, env);
      const key = stableKey(value);
      const candidates = index.get(key);
      if (candidates === undefined) {
        index.set(key, [{ row, value }]);
      } else {
        candidates.push({ row, value });
      }
    }
  }

  return index;
}

function joinStateMap(states: readonly IncrementalJoinState[]): ReadonlyMap<string, IncrementalJoinState> {
  return new Map(states.map((state) => [state.id, state]));
}

function recordRootJoinValues(
  rootValuesByStep: Map<string, Map<string, readonly unknown[]>>,
  rootKey: string,
  valuesByStep: ReadonlyMap<string, readonly unknown[]>
): void {
  for (const [stepId, values] of valuesByStep) {
    const valuesByRootKey = rootValuesByStep.get(stepId) ?? new Map<string, readonly unknown[]>();
    valuesByRootKey.set(rootKey, values);
    rootValuesByStep.set(stepId, valuesByRootKey);
  }
}

function withRootJoinValues(
  state: IncrementalJoinState,
  rootValuesByKey: ReadonlyMap<string, readonly unknown[]>
): IncrementalJoinState {
  return {
    ...state,
    rootValuesByKey,
    rootKeysByValue: buildRootKeysByValue(rootValuesByKey)
  };
}

function buildRootKeysByValue(
  rootValuesByKey: ReadonlyMap<string, readonly unknown[]>
): ReadonlyMap<string, readonly RootJoinValue[]> {
  const index = new Map<string, RootJoinValue[]>();
  for (const [rootKey, values] of rootValuesByKey) {
    for (const value of values) {
      const key = stableKey(value);
      const entries = index.get(key);
      if (entries === undefined) {
        index.set(key, [{ rootKey, value }]);
      } else {
        entries.push({ rootKey, value });
      }
    }
  }
  return index;
}

function mutableRootJoinIndexes(
  states: readonly IncrementalJoinState[]
): ReadonlyMap<string, MutableRootJoinIndex> {
  return new Map(states.map((state) => [
    state.id,
    {
      valuesByRootKey: new Map(state.rootValuesByKey),
      rootKeysByValue: mutableRootKeysByValue(state.rootKeysByValue)
    }
  ]));
}

function mutableRootKeysByValue(
  index: ReadonlyMap<string, readonly RootJoinValue[]>
): Map<string, RootJoinValue[]> {
  return new Map(Array.from(index, ([key, values]) => [key, [...values]]));
}

function removeRootJoinValues(
  indexes: ReadonlyMap<string, MutableRootJoinIndex>,
  rootKey: string
): void {
  for (const index of indexes.values()) {
    const values = index.valuesByRootKey.get(rootKey);
    if (values === undefined) {
      continue;
    }

    for (const value of values) {
      const key = stableKey(value);
      const entries = index.rootKeysByValue.get(key);
      if (entries === undefined) {
        continue;
      }
      const nextEntries = entries.filter((entry) => (
        entry.rootKey !== rootKey || !Object.is(entry.value, value)
      ));
      if (nextEntries.length === 0) {
        index.rootKeysByValue.delete(key);
      } else {
        index.rootKeysByValue.set(key, nextEntries);
      }
    }
    index.valuesByRootKey.delete(rootKey);
  }
}

function addRootJoinValues(
  indexes: ReadonlyMap<string, MutableRootJoinIndex>,
  rootKey: string,
  valuesByStep: ReadonlyMap<string, readonly unknown[]>
): void {
  for (const [stepId, values] of valuesByStep) {
    const index = indexes.get(stepId);
    if (index === undefined) {
      continue;
    }
    index.valuesByRootKey.set(rootKey, values);
    for (const value of values) {
      const key = stableKey(value);
      const entries = index.rootKeysByValue.get(key);
      if (entries === undefined) {
        index.rootKeysByValue.set(key, [{ rootKey, value }]);
      } else {
        entries.push({ rootKey, value });
      }
    }
  }
}

function withRootJoinIndex(
  state: IncrementalJoinState,
  index: MutableRootJoinIndex | undefined
): IncrementalJoinState {
  if (index === undefined) {
    return state;
  }

  return {
    ...state,
    rootValuesByKey: index.valuesByRootKey,
    rootKeysByValue: index.rootKeysByValue
  };
}

function applyNestedBranchJoinChanges(
  step: IncrementalJoinStep,
  state: IncrementalJoinState,
  deltas: readonly RelationDelta[],
  env: Readonly<Record<string, unknown>>
): RightChangeResult {
  const nestedStates = state.nestedBranchJoinStates;
  const nestedSteps = branchJoinSteps(step.right);
  if (nestedSteps.length === 0) {
    return {
      supported: true,
      state,
      affectedRootKeys: new Set()
    };
  }
  if (nestedStates === undefined) {
    return {
      supported: false,
      reason: `nested right branch join state for ${step.id} is missing; snapshot recompute is required`
    };
  }

  let nextState = state;
  const affectedRootKeys = new Set<string>();

  for (const nestedStep of nestedSteps) {
    const currentNestedState = nextState.nestedBranchJoinStates?.find((item) => item.id === nestedStep.id);
    if (currentNestedState === undefined) {
      return {
        supported: false,
        reason: `nested right branch join state ${nestedStep.id} is missing; snapshot recompute is required`
      };
    }

    const deltaRelation = relationForDeltas(nestedStep.right.relation, deltas);
    if (deltaRelation === undefined) {
      continue;
    }

    const rightChanges = normalizedRelationChanges(
      deltaRelation,
      deltas,
      `nested right branch relation ${deltaRelation.name}`
    );
    if (!rightChanges.supported) {
      return {
        supported: false,
        reason: rightChanges.reason
      };
    }

    if (rightChanges.changes.length === 0) {
      if (hasRelationDeltaRows(deltaRelation, deltas)) {
        return {
          supported: false,
          reason: `nested right branch relation ${deltaRelation.name} deltas had no net keyed row changes; snapshot recompute is required to preserve join order`
        };
      }
      continue;
    }

    const changedNested = applyRightRelationChanges(
      nestedStep,
      currentNestedState,
      deltaRelation,
      rightChanges.changes,
      env
    );
    if (!changedNested.supported) {
      return changedNested;
    }

    const nestedBranchJoinStates = (nextState.nestedBranchJoinStates ?? []).map((item) =>
      item.id === changedNested.state.id ? changedNested.state : item
    );
    nextState = {
      ...nextState,
      nestedBranchJoinStates
    };

    const reindexed = reindexBranchRelationKeys(step, nextState, changedNested.affectedRootKeys, env);
    if (!reindexed.supported) {
      return reindexed;
    }
    nextState = reindexed.state;
    for (const rootKey of reindexed.affectedRootKeys) {
      affectedRootKeys.add(rootKey);
    }
  }

  return {
    supported: true,
    state: nextState,
    affectedRootKeys
  };
}

function reindexBranchRelationKeys(
  step: IncrementalJoinStep,
  state: IncrementalJoinState,
  relationKeysToEvaluate: ReadonlySet<string>,
  env: Readonly<Record<string, unknown>>
): RightChangeResult {
  if (relationKeysToEvaluate.size === 0) {
    return {
      supported: true,
      state,
      affectedRootKeys: new Set()
    };
  }

  const rowsByRelationKey = new Map(state.rowsByRelationKey);
  const affectedValues: unknown[] = [];
  const nestedRootJoinIndexes = state.nestedBranchJoinStates === undefined
    ? undefined
    : mutableRootJoinIndexes(state.nestedBranchJoinStates);
  const nestedJoinStateById = joinStateMap(state.nestedBranchJoinStates ?? []);

  for (const relationKey of relationKeysToEvaluate) {
    const previousRows = rowsByRelationKey.get(relationKey);
    if (previousRows !== undefined) {
      affectedValues.push(...previousRows.map((row) => exprValue(row, step.rightExpr, env)));
      rowsByRelationKey.delete(relationKey);
    }
    if (nestedRootJoinIndexes !== undefined) {
      removeRootJoinValues(nestedRootJoinIndexes, relationKey);
    }

    const relationRow = state.relationRowsByKey.get(relationKey);
    if (relationRow === undefined) {
      continue;
    }

    const evaluated = evaluateBranchRows(step.right, relationRow, env, nestedJoinStateById);
    if (!evaluated.supported) {
      return {
        supported: false,
        reason: evaluated.reason
      };
    }

    rowsByRelationKey.set(relationKey, evaluated.rows);
    affectedValues.push(...evaluated.rows.map((row) => exprValue(row, step.rightExpr, env)));
    if (nestedRootJoinIndexes !== undefined) {
      addRootJoinValues(nestedRootJoinIndexes, relationKey, evaluated.joinValuesByStep);
    }
  }

  const nextNestedBranchJoinStates = state.nestedBranchJoinStates === undefined
    ? undefined
    : state.nestedBranchJoinStates.map((nestedState) =>
      withRootJoinIndex(nestedState, nestedRootJoinIndexes?.get(nestedState.id))
    );

  return {
    supported: true,
    state: {
      ...state,
      rowsByRelationKey,
      indexByValue: buildRightIndex(step, state.relationKeys, rowsByRelationKey, env),
      ...(nextNestedBranchJoinStates === undefined ? {} : { nestedBranchJoinStates: nextNestedBranchJoinStates })
    },
    affectedRootKeys: rootKeysMatchingJoinValues(state, affectedValues)
  };
}

function applyRightRelationChanges(
  step: IncrementalJoinLikeStep,
  state: IncrementalJoinState,
  relation: RelationRef,
  changes: readonly DeltaRowChange[],
  env: Readonly<Record<string, unknown>>
): RightChangeResult {
  const relationKeys: (string | undefined)[] = [...state.relationKeys];
  const relationIndexByKey = new Map(relationIndexByKeyForState(state));
  const relationInsertIndexByKey = keyChangeInsertIndexes(relation, changes, relationIndexByKey);
  const relationRowsByKey = new Map(state.relationRowsByKey);
  const rowsByRelationKey = new Map(state.rowsByRelationKey);
  const indexByValue = mutableRightIndex(state.indexByValue);
  const affectedValues: unknown[] = [];
  const nestedRootJoinIndexes = state.nestedBranchJoinStates === undefined
    ? undefined
    : mutableRootJoinIndexes(state.nestedBranchJoinStates);
  const nestedJoinStateById = joinStateMap(state.nestedBranchJoinStates ?? []);

  for (const change of changes) {
    const index = relationIndexByKey.get(change.key) ?? -1;
    const previousRows = rowsByRelationKey.get(change.key);

    if (change.after === undefined) {
      if (index === -1 || previousRows === undefined) {
        return {
          supported: false,
          reason: `right relation delta removed missing key ${change.key}; snapshot recompute is required`
        };
      }

      affectedValues.push(...previousRows.map((row) => exprValue(row, step.rightExpr, env)));
      removeRightIndexRows(step, indexByValue, previousRows, env);
      relationKeys[index] = undefined;
      relationIndexByKey.delete(change.key);
      relationRowsByKey.delete(change.key);
      rowsByRelationKey.delete(change.key);
      if (nestedRootJoinIndexes !== undefined) {
        removeRootJoinValues(nestedRootJoinIndexes, change.key);
      }
      continue;
    }

    if (index === -1) {
      if (change.before !== undefined) {
        return {
          supported: false,
          reason: `right relation delta updated missing key ${change.key}; snapshot recompute is required`
        };
      }

      const keyChangeIndex = relationInsertIndexByKey.get(change.key);
      if (keyChangeIndex !== undefined && relationKeys[keyChangeIndex] === undefined) {
        relationKeys[keyChangeIndex] = change.key;
        relationIndexByKey.set(change.key, keyChangeIndex);
      } else {
        relationIndexByKey.set(change.key, relationKeys.length);
        relationKeys.push(change.key);
      }
    } else if (change.before === undefined) {
      return {
        supported: false,
        reason: `right relation delta added duplicate key ${change.key}; snapshot recompute is required`
      };
    } else if (previousRows === undefined) {
      return {
        supported: false,
        reason: `right relation delta updated missing key ${change.key}; snapshot recompute is required`
      };
    }

    if (previousRows !== undefined) {
      affectedValues.push(...previousRows.map((row) => exprValue(row, step.rightExpr, env)));
      removeRightIndexRows(step, indexByValue, previousRows, env);
      if (nestedRootJoinIndexes !== undefined) {
        removeRootJoinValues(nestedRootJoinIndexes, change.key);
      }
    }

    relationRowsByKey.set(change.key, change.after);
    const evaluated = evaluateBranchRows(step.right, change.after, env, nestedJoinStateById);
    if (!evaluated.supported) {
      return {
        supported: false,
        reason: evaluated.reason
      };
    }
    const nextRows = evaluated.rows;
    affectedValues.push(...nextRows.map((row) => exprValue(row, step.rightExpr, env)));
    addRightIndexRows(step, indexByValue, nextRows, env);
    rowsByRelationKey.set(change.key, nextRows);
    if (nestedRootJoinIndexes !== undefined) {
      addRootJoinValues(nestedRootJoinIndexes, change.key, evaluated.joinValuesByStep);
    }
  }

  const compactRelationKeys = relationKeys.filter((key): key is string => key !== undefined);
  const duplicateReason = duplicateRelationKeysReason(compactRelationKeys, `right relation ${relation.name}`);
  if (duplicateReason !== undefined) {
    return {
      supported: false,
      reason: duplicateReason
    };
  }

  const nextNestedBranchJoinStates = state.nestedBranchJoinStates === undefined
    ? undefined
    : state.nestedBranchJoinStates.map((nestedState) =>
      withRootJoinIndex(nestedState, nestedRootJoinIndexes?.get(nestedState.id))
    );

  return {
    supported: true,
    state: {
      ...state,
      relationKeys: compactRelationKeys,
      relationIndexByKey: indexKeys(compactRelationKeys),
      relationRowsByKey,
      rowsByRelationKey,
      indexByValue: state.nestedBranchJoinStates === undefined
        ? indexByValue
        : buildRightIndex(step, compactRelationKeys, rowsByRelationKey, env),
      ...(nextNestedBranchJoinStates === undefined ? {} : { nestedBranchJoinStates: nextNestedBranchJoinStates })
    },
    affectedRootKeys: rootKeysMatchingJoinValues(state, affectedValues)
  };
}

function mutableRightIndex(
  index: ReadonlyMap<string, readonly IndexedRightRow[]>
): Map<string, IndexedRightRow[]> {
  return new Map(Array.from(index, ([key, rows]) => [key, [...rows]]));
}

function removeRightIndexRows(
  step: IncrementalJoinLikeStep,
  index: Map<string, IndexedRightRow[]>,
  rows: readonly Record<string, unknown>[],
  env: Readonly<Record<string, unknown>>
): void {
  const rowsToRemove = new Set(rows);
  for (const row of rows) {
    const value = exprValue(row, step.rightExpr, env);
    const key = stableKey(value);
    const entries = index.get(key);
    if (entries === undefined) {
      continue;
    }
    const nextEntries = entries.filter((entry) => !rowsToRemove.has(entry.row));
    if (nextEntries.length === 0) {
      index.delete(key);
    } else {
      index.set(key, nextEntries);
    }
  }
}

function addRightIndexRows(
  step: IncrementalJoinLikeStep,
  index: Map<string, IndexedRightRow[]>,
  rows: readonly Record<string, unknown>[],
  env: Readonly<Record<string, unknown>>
): void {
  for (const row of rows) {
    const value = exprValue(row, step.rightExpr, env);
    const key = stableKey(value);
    const entries = index.get(key);
    if (entries === undefined) {
      index.set(key, [{ row, value }]);
    } else {
      entries.push({ row, value });
    }
  }
}

function rootKeysMatchingJoinValues(
  state: IncrementalJoinState,
  values: readonly unknown[]
): ReadonlySet<string> {
  const rootKeys = new Set<string>();
  for (const value of values) {
    const candidates = state.rootKeysByValue.get(stableKey(value)) ?? [];
    for (const candidate of candidates) {
      if (Object.is(value, candidate.value)) {
        rootKeys.add(candidate.rootKey);
      }
    }
  }
  return rootKeys;
}

function indexKeys(keys: readonly string[]): ReadonlyMap<string, number> {
  return new Map(keys.map((key, index) => [key, index]));
}

function rootIndexByKeyForState<Row>(
  state: IncrementalMaterializationState<Row>
): ReadonlyMap<string, number> {
  return state.rootIndexByKey ?? indexKeys(state.rootKeys);
}

function relationIndexByKeyForState(
  state: IncrementalJoinState
): ReadonlyMap<string, number> {
  return state.relationIndexByKey ?? indexKeys(state.relationKeys);
}

function optionalRowKeyFields(
  fields: readonly string[] | undefined
): { readonly rowKeyFields?: readonly string[] } {
  return fields === undefined ? {} : { rowKeyFields: fields };
}

function optionalOrderedStep(
  ordered: MutableIncrementalOrderedStep | undefined
): { readonly ordered?: IncrementalOrderedStep } {
  return ordered === undefined
    ? {}
    : {
        ordered: {
          kind: 'ordered',
          order: ordered.order,
          ...(ordered.window === undefined ? {} : { window: ordered.window }),
          postSteps: [...ordered.postSteps]
        }
      };
}

function rowDiffOptionsForPlan(plan: IncrementalMaterializationPlan): MaterializationRowDiffOptions {
  return plan.rowKeyFields === undefined ? {} : { keyBy: plan.rowKeyFields };
}

function ambiguousFinalRowsReason<Row>(
  plan: IncrementalMaterializationPlan,
  rows: readonly Row[]
): string | undefined {
  const index = materializationRowIndex(rows, rowDiffOptionsForPlan(plan));
  const duplicate = index.duplicates.values().next();
  if (!duplicate.done) {
    return `final materialized row key ${duplicate.value} is duplicated; snapshot recompute is required`;
  }

  const invalid = index.diagnostics.find((diagnostic) => diagnostic.code === 'invalid_row');
  if (invalid !== undefined) {
    return 'final materialized row key selection failed; snapshot recompute is required';
  }

  return undefined;
}

function relationForDeltas(relationName: string, deltas: readonly RelationDelta[]): RelationRef | undefined {
  return deltas.find((delta) => delta.relation.name === relationName)?.relation;
}

function duplicateRelationRowsReason(
  relation: RelationRef,
  rows: readonly unknown[],
  label = 'root relation'
): string | undefined {
  const keys = rows.map((row) => relationKeyForRow(relation, row));
  return duplicateRelationKeysReason(keys, `${label} ${relation.name}`);
}

function duplicateRootKeysReason(keys: readonly string[], relationName: string): string | undefined {
  return duplicateRelationKeysReason(keys, `root relation ${relationName}`);
}

function duplicateRelationKeysReason(keys: readonly string[], label: string): string | undefined {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      return `${label} has duplicate key ${key}; snapshot recompute is required`;
    }
    seen.add(key);
  }
  return undefined;
}

function normalizedRelationChanges(
  relation: RelationRef,
  deltas: readonly RelationDelta[],
  label = 'root relation'
):
  | { readonly supported: true; readonly changes: readonly DeltaRowChange[] }
  | { readonly supported: false; readonly reason: string } {
  const relationDeltas = deltas.filter((delta) => delta.relation.name === relation.name);
  const removed = relationDeltas.flatMap((delta) => delta.removed);
  const added = relationDeltas.flatMap((delta) => delta.added);
  const net = cancelIntermediateRows(removed, added);
  const byKey = new Map<string, MutableDeltaRows>();
  let order = 0;

  for (const row of net.removed) {
    const key = relationKeyForRow(relation, row);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { key, removed: [], added: [], order };
      order += 1;
      byKey.set(key, entry);
    }
    entry.removed.push(row);
  }

  for (const row of net.added) {
    const key = relationKeyForRow(relation, row);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { key, removed: [], added: [], order };
      order += 1;
      byKey.set(key, entry);
    }
    entry.added.push(row);
  }

  for (const entry of byKey.values()) {
    if (entry.removed.length > 1 || entry.added.length > 1) {
      return {
        supported: false,
        reason: `${label} deltas contain duplicate key ${entry.key}; snapshot recompute is required`
      };
    }
  }

  return {
    supported: true,
    changes: Array.from(byKey.values())
      .sort((left, right) => left.order - right.order)
      .flatMap(deltaRowChange)
  };
}

function hasRelationDeltaRows(relation: RelationRef, deltas: readonly RelationDelta[]): boolean {
  return deltas.some((delta) =>
    delta.relation.name === relation.name && (delta.added.length > 0 || delta.removed.length > 0)
  );
}

function deltaRowChange(entry: MutableDeltaRows): readonly DeltaRowChange[] {
  const before = entry.removed[0];
  const after = entry.added.at(-1);

  if (before === undefined && after === undefined) {
    return [];
  }

  if (before === undefined) {
    return [{ key: entry.key, after }];
  }

  if (after === undefined) {
    return [{ key: entry.key, before }];
  }

  return [{ key: entry.key, before, after }];
}

function keyChangeInsertIndexes(
  relation: RelationRef,
  changes: readonly DeltaRowChange[],
  indexByKey: ReadonlyMap<string, number>
): ReadonlyMap<string, number> {
  const removed = changes.filter((change) => change.before !== undefined && change.after === undefined);
  const usedRemoved = new Set<string>();
  const insertIndexes = new Map<string, number>();

  for (const added of changes) {
    if (added.before !== undefined || added.after === undefined) {
      continue;
    }

    const removedChange = removed.find((candidate) => (
      !usedRemoved.has(candidate.key) &&
      candidate.before !== undefined &&
      rowsMatchExceptRelationKey(relation, candidate.before, added.after)
    ));
    if (removedChange === undefined) {
      continue;
    }

    const index = indexByKey.get(removedChange.key);
    if (index === undefined) {
      continue;
    }

    usedRemoved.add(removedChange.key);
    insertIndexes.set(added.key, index);
  }

  return insertIndexes;
}

function rowsMatchExceptRelationKey(relation: RelationRef, left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  return stableKey(rowWithoutRelationKey(relation, left)) === stableKey(rowWithoutRelationKey(relation, right));
}

function rowWithoutRelationKey(relation: RelationRef, row: Record<string, unknown>): Record<string, unknown> {
  const output = { ...row };
  for (const field of relationKeyFields(relation)) {
    delete output[field];
  }
  return output;
}

function relationKeyFields(relation: RelationRef): readonly string[] {
  return Array.isArray(relation.key)
    ? relation.key
    : [relation.key as string];
}

function cancelIntermediateRows(
  removed: readonly unknown[],
  added: readonly unknown[]
): { readonly removed: readonly unknown[]; readonly added: readonly unknown[] } {
  const removedCounts = new Map<string, number>();
  for (const row of removed) {
    const key = stableKey(row);
    removedCounts.set(key, (removedCounts.get(key) ?? 0) + 1);
  }

  const canceledAddedCounts = new Map<string, number>();
  const remainingAdded: unknown[] = [];
  for (const row of added) {
    const key = stableKey(row);
    const count = removedCounts.get(key) ?? 0;
    if (count > 0) {
      removedCounts.set(key, count - 1);
      canceledAddedCounts.set(key, (canceledAddedCounts.get(key) ?? 0) + 1);
    } else {
      remainingAdded.push(row);
    }
  }

  const remainingRemoved: unknown[] = [];
  for (const row of removed) {
    const key = stableKey(row);
    const count = canceledAddedCounts.get(key) ?? 0;
    if (count > 0) {
      canceledAddedCounts.set(key, count - 1);
    } else {
      remainingRemoved.push(row);
    }
  }

  return { removed: remainingRemoved, added: remainingAdded };
}

function shapeForRoot(relation: string, alias: string): PlanShape {
  return {
    aliases: new Set([alias]),
    fields: new Set(),
    relations: new Set([relation])
  };
}

function shapeForConstRows(rows: readonly Record<string, unknown>[]): PlanShape {
  return {
    aliases: new Set(),
    fields: new Set(rows.flatMap((row) => Object.keys(row))),
    relations: new Set()
  };
}

function emptyShape(): PlanShape {
  return {
    aliases: new Set(),
    fields: new Set(),
    relations: new Set()
  };
}

function selectShape(shape: PlanShape, projection: ProjectionData): PlanShape {
  return {
    aliases: new Set(),
    fields: new Set(Object.keys(projection)),
    relations: new Set(shape.relations)
  };
}

function extendShape(shape: PlanShape, projection: ProjectionData): PlanShape {
  return {
    aliases: new Set(shape.aliases),
    fields: new Set([...shape.fields, ...Object.keys(projection)]),
    relations: new Set(shape.relations)
  };
}

function withoutShape(shape: PlanShape, fields: readonly string[]): PlanShape {
  const aliases = new Set(shape.aliases);
  const outputFields = new Set(shape.fields);
  for (const field of fields) {
    aliases.delete(field);
    outputFields.delete(field);
  }
  return {
    aliases,
    fields: outputFields,
    relations: new Set(shape.relations)
  };
}

function renameShape(shape: PlanShape, fields: Record<string, string>): PlanShape {
  const aliases = new Set(shape.aliases);
  const outputFields = new Set(shape.fields);

  for (const [from, to] of Object.entries(fields)) {
    if (aliases.delete(from)) {
      aliases.add(to);
    }
    if (outputFields.delete(from)) {
      outputFields.add(to);
    }
  }

  return {
    aliases,
    fields: outputFields,
    relations: new Set(shape.relations)
  };
}

function qualifyShape(shape: PlanShape, alias: string): PlanShape {
  return {
    aliases: new Set([alias]),
    fields: new Set(),
    relations: new Set(shape.relations)
  };
}

function expandShape(
  shape: PlanShape,
  alias: string | undefined,
  fields: readonly string[] | undefined
): PlanShape {
  return {
    aliases: new Set(alias === undefined ? shape.aliases : [...shape.aliases, alias]),
    fields: new Set(fields === undefined ? shape.fields : [...shape.fields, ...fields]),
    relations: new Set(shape.relations)
  };
}

function aggregateShape(shape: PlanShape, groupBy: ProjectionData, aggregates: ProjectionData): PlanShape {
  return {
    aliases: new Set(),
    fields: new Set([...Object.keys(groupBy), ...Object.keys(aggregates)]),
    relations: new Set(shape.relations)
  };
}

function mergeShapes(left: PlanShape, right: PlanShape): PlanShape {
  return {
    aliases: new Set([...left.aliases, ...right.aliases]),
    fields: new Set([...left.fields, ...right.fields]),
    relations: new Set([...left.relations, ...right.relations])
  };
}

function shapesOverlap(left: PlanShape, right: PlanShape): boolean {
  return intersects(left.relations, right.relations) ||
    intersects(left.aliases, right.aliases) ||
    intersects(left.aliases, right.fields) ||
    intersects(left.fields, right.aliases);
}

function expressionSideForShapes(
  expr: FieldExpression,
  left: PlanShape,
  right: PlanShape
): 'left' | 'right' | undefined {
  const inLeftAlias = left.aliases.has(expr.alias);
  const inRightAlias = right.aliases.has(expr.alias);

  if (inLeftAlias || inRightAlias) {
    if (inLeftAlias === inRightAlias) {
      return undefined;
    }

    return inLeftAlias ? 'left' : 'right';
  }

  const inLeft = left.fields.has(expr.field);
  const inRight = right.fields.has(expr.field);

  if (inLeft === inRight) {
    return undefined;
  }

  return inLeft ? 'left' : 'right';
}

function shapeHasField(shape: PlanShape, expr: FieldExpression): boolean {
  return shape.aliases.has(expr.alias) || shape.fields.has(expr.field);
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function projectionShapeReason(projection: ProjectionData, shape: PlanShape): string | undefined {
  for (const item of Object.values(projection)) {
    const reason = exprShapeReason(projectionExpr(item), shape);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

function predicateShapeReason(predicate: PredicateData, shape: PlanShape): string | undefined {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return exprShapeReason(predicate.left, shape) ?? exprShapeReason(predicate.right, shape);
    case 'and':
    case 'or':
      for (const item of predicate.predicates) {
        const reason = predicateShapeReason(item, shape);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'not':
      return predicateShapeReason(predicate.predicate, shape);
  }
}

function aggregateProjectionReason(aggregates: ProjectionData, shape: PlanShape): string | undefined {
  for (const [name, item] of Object.entries(aggregates)) {
    const expr = projectionExpr(item);
    if (expr.op !== 'aggregateCall') {
      return `field ${name} is not an aggregate call`;
    }

    const reason = aggregateCallReason(expr, shape);
    if (reason !== undefined) {
      return `field ${name}: ${reason}`;
    }
  }
  return undefined;
}

function aggregateCallReason(
  expr: Extract<ExprData, { readonly op: 'aggregateCall' }>,
  shape: PlanShape
): string | undefined {
  if (!supportedAggregateFunctions.has(expr.name)) {
    return `${expr.name} aggregate is not supported`;
  }

  if (expr.expr === undefined) {
    return expr.name === 'count'
      ? undefined
      : `${expr.name} aggregate requires an input expression`;
  }

  return simpleExprReason(expr.expr) ?? exprShapeReason(expr.expr, shape);
}

function exprShapeReason(expr: ExprData, shape: PlanShape): string | undefined {
  switch (expr.op) {
    case 'field':
      return shapeHasField(shape, expr)
        ? undefined
        : `field ${expr.alias}.${expr.field} is outside the relation branch`;
    case 'value':
      return undefined;
    case 'tuple':
      for (const item of expr.items) {
        const reason = exprShapeReason(item, shape);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'env':
    case 'call':
    case 'hostCall':
    case 'subquery':
    case 'aggregateCall':
      return simpleExprReason(expr);
  }
}

function constantExprReason(expr: ExprData): string | undefined {
  switch (expr.op) {
    case 'value':
      return undefined;
    case 'tuple':
      for (const item of expr.items) {
        const reason = constantExprReason(item);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'field':
      return 'field expressions are not supported in right branch lookup values';
    case 'env':
    case 'call':
    case 'hostCall':
    case 'subquery':
    case 'aggregateCall':
      return simpleExprReason(expr);
  }
}

function matchesPredicate(
  row: Record<string, unknown>,
  predicate: PredicateData,
  env: Readonly<Record<string, unknown>>
): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(exprValue(row, predicate.left, env), exprValue(row, predicate.right, env));
    case 'neq':
      return !Object.is(exprValue(row, predicate.left, env), exprValue(row, predicate.right, env));
    case 'lt':
      return compareValues(exprValue(row, predicate.left, env), exprValue(row, predicate.right, env)) < 0;
    case 'lte':
      return compareValues(exprValue(row, predicate.left, env), exprValue(row, predicate.right, env)) <= 0;
    case 'gt':
      return compareValues(exprValue(row, predicate.left, env), exprValue(row, predicate.right, env)) > 0;
    case 'gte':
      return compareValues(exprValue(row, predicate.left, env), exprValue(row, predicate.right, env)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => matchesPredicate(row, item, env));
    case 'or':
      return predicate.predicates.some((item) => matchesPredicate(row, item, env));
    case 'not':
      return !matchesPredicate(row, predicate.predicate, env);
  }
}

function exprValue(
  row: Record<string, unknown>,
  expr: ExprData,
  env: Readonly<Record<string, unknown>>
): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'env':
      return env[expr.name];
    case 'field': {
      const aliased = row[expr.alias];
      if (isRecord(aliased)) {
        return aliased[expr.field];
      }
      if (aliased !== undefined && expr.field === 'value') {
        return aliased;
      }
      return row[expr.field];
    }
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item, env));
    case 'call':
    case 'hostCall':
    case 'subquery':
    case 'aggregateCall':
      return undefined;
  }
}

function simpleProjectionReason(projection: ProjectionData): string | undefined {
  for (const item of Object.values(projection)) {
    const reason = simpleExprReason(projectionExpr(item));
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

function simplePredicateReason(predicate: PredicateData): string | undefined {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return simpleExprReason(predicate.left) ?? simpleExprReason(predicate.right);
    case 'and':
    case 'or':
      for (const item of predicate.predicates) {
        const reason = simplePredicateReason(item);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'not':
      return simplePredicateReason(predicate.predicate);
  }
}

function simpleExprReason(expr: ExprData): string | undefined {
  switch (expr.op) {
    case 'field':
    case 'value':
      return undefined;
    case 'env':
      return 'env expressions are not supported because environment changes are not tracked';
    case 'tuple':
      for (const item of expr.items) {
        const reason = simpleExprReason(item);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'call':
      return 'call expressions are not supported';
    case 'hostCall':
      return 'hostCall expressions are not supported';
    case 'subquery':
      return 'subquery expressions are not supported';
    case 'aggregateCall':
      return 'aggregate expressions are not supported';
  }
}

function projectionExpr(item: ProjectionData[string]): ExprData {
  return isOptionalProjection(item) ? item.expr : item;
}

function isOptionalProjection(
  item: ProjectionData[string]
): item is Extract<ProjectionData[string], { readonly kind: 'optionalProjection' }> {
  return 'kind' in item && item.kind === 'optionalProjection';
}

function relationKeyForRow(relation: RelationRef, row: unknown): string {
  return isRecord(row) ? rowKey(relation, row) ?? stableKey(row) : stableKey(row);
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}

function compareSortValues(
  left: unknown,
  right: unknown,
  direction: 'asc' | 'desc',
  nulls: 'first' | 'last' | undefined
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    const nullOrder = nulls ?? 'last';
    return leftNull === (nullOrder === 'first') ? -1 : 1;
  }

  const comparison = compareValues(left, right);
  return direction === 'asc' ? comparison : -comparison;
}

function asRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function pickFields(input: Record<string, unknown>, fields: readonly string[] | undefined): Record<string, unknown> {
  if (fields === undefined) {
    return input;
  }

  return Object.fromEntries(fields.map((field) => [field, input[field]]));
}

function isIterable(input: unknown): input is Iterable<unknown> {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function materializationErrorMessage(input: unknown): string {
  if (input instanceof Error) return input.message;
  try {
    return JSON.stringify(input) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}
