import type { RelationDelta } from './adapter.js';
import type { RowChange, RowDiffDiagnostic } from './diff.js';
import { rowKey, type EvaluateFunctions } from './evaluate.js';
import { stableKey } from './identity.js';
import { equalityJoinPlan, type EqualityJoinPlan, type FieldExpression } from './join-planner.js';
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
  readonly relationPostSteps?: readonly IncrementalRelationPostStep[];
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
  readonly relationPost?: IncrementalRelationPostState<Row>;
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

export type IncrementalMaterializationPlanOptions = {
  readonly functions?: EvaluateFunctions;
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

type IncrementalSubqueryStep = {
  readonly kind: 'subquery';
  readonly id: string;
  readonly exprKey: string;
  readonly mode: 'many' | 'one';
  readonly right: IncrementalBranchPlan;
  readonly left: ExprData;
  readonly rightExpr: ExprData;
  readonly predicate: PredicateData;
  readonly needsPredicateCheck: false;
  readonly hiddenField: string;
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
type IncrementalRootDependencyStep = IncrementalJoinStep | IncrementalSubqueryStep;
type IncrementalJoinLikeStep = IncrementalJoinStep | IncrementalBranchJoinStep;
type IncrementalIndexLikeStep = IncrementalJoinLikeStep | IncrementalSubqueryStep;

type IncrementalAggregateStep = {
  readonly kind: 'aggregate';
  readonly groupBy: ProjectionData;
  readonly aggregates: ProjectionData;
};

type IncrementalStep = IncrementalPipelineStep | IncrementalJoinStep | IncrementalSubqueryStep | IncrementalAggregateStep;

type IncrementalPostOrderStep = Extract<IncrementalPipelineStep, {
  readonly kind: 'select' | 'extend' | 'without' | 'rename' | 'qualify';
}>;

type IncrementalPostAggregateStep = IncrementalPipelineStep | IncrementalJoinStep;
type IncrementalBranchPostAggregateStep = Extract<IncrementalPipelineStep, {
  readonly kind: 'where' | 'select' | 'extend' | 'without' | 'rename' | 'qualify';
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

type IncrementalStaticUnionStep = {
  readonly kind: 'staticUnion';
  readonly beforeRows?: readonly Record<string, unknown>[];
  readonly rows: readonly Record<string, unknown>[];
};

type IncrementalRelationPostStep = IncrementalStaticUnionStep;

type IncrementalBranchPlan = {
  readonly relation: string;
  readonly alias: string;
  readonly root: IncrementalRoot;
  readonly steps: readonly IncrementalBranchStep[];
  readonly aggregate?: IncrementalAggregateStep;
  readonly postAggregateSteps?: readonly IncrementalBranchPostAggregateStep[];
  readonly ordered?: IncrementalOrderedStep;
  readonly staticUnion?: IncrementalStaticUnionStep;
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
  readonly branchAggregate?: IncrementalAggregateState<Record<string, unknown>>;
  readonly branchOrdered?: IncrementalOrderedState<Record<string, unknown>>;
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
  readonly rawRow: Record<string, unknown>;
  readonly rows: readonly Row[];
};

type IncrementalOrderedState<Row = unknown> = {
  readonly entriesByOwnerKey: ReadonlyMap<string, readonly IncrementalOrderedEntry<Row>[]>;
  readonly entriesByKey: ReadonlyMap<string, IncrementalOrderedEntry<Row>>;
  readonly orderedEntryKeys: readonly string[];
  readonly visibleEntryKeys: readonly string[];
  readonly rows: readonly Row[];
};

type IncrementalRelationPostState<Row = unknown> = {
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
  subqueryCount: number;
  readonly subqueryKeys: Set<string>;
  readonly relationPostSteps: IncrementalRelationPostStep[];
  ordered?: MutableIncrementalOrderedStep;
};

type IncrementalEvaluationContext = Readonly<Record<string, unknown>> & {
  readonly env: Readonly<Record<string, unknown>>;
  readonly functions?: EvaluateFunctions;
  readonly [incrementalEvaluationContext]: true;
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

type SubqueryEvaluationState = {
  readonly step: IncrementalSubqueryStep;
  readonly state: IncrementalJoinState;
};

type RightBranchPlanCollection = {
  readonly allowNestedJoin: boolean;
  readonly allowOrderedWindow: boolean;
  readonly allowAggregate: boolean;
  branchJoinCount: number;
  aggregate?: IncrementalAggregateStep;
  postAggregateSteps?: IncrementalBranchPostAggregateStep[];
  ordered?: MutableIncrementalOrderedStep;
  staticUnion?: IncrementalStaticUnionStep;
};

const incrementalEvaluationContext = Symbol('incrementalEvaluationContext');

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

function incrementalEvalContext(
  env: Readonly<Record<string, unknown>>,
  options: IncrementalMaterializationPlanOptions
): IncrementalEvaluationContext {
  return {
    [incrementalEvaluationContext]: true,
    env,
    ...(options.functions === undefined ? {} : { functions: options.functions })
  } as IncrementalEvaluationContext;
}

function isIncrementalEvalContext(input: Readonly<Record<string, unknown>>): input is IncrementalEvaluationContext {
  return (input as Partial<IncrementalEvaluationContext>)[incrementalEvaluationContext] === true;
}

function evalEnv(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return isIncrementalEvalContext(input) ? input.env : input;
}

function evalFunctions(input: Readonly<Record<string, unknown>>): EvaluateFunctions | undefined {
  return isIncrementalEvalContext(input) ? input.functions : undefined;
}

export function planIncrementalMaterialization(
  query: Query,
  options: IncrementalMaterializationPlanOptions = {}
): IncrementalPlanResult {
  const staticPlan = collectStaticRowsPlan(query.data, options);
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

  const dynamicSetPlan = collectDynamicSetPlan(query.data, options);
  const steps: IncrementalStep[] = [];
  const collection: PlanCollection = {
    joinCount: 0,
    subqueryCount: 0,
    subqueryKeys: new Set(),
    relationPostSteps: []
  };
  const root = collectSingleRootPlan(query.data, steps, collection, options);
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
      ...optionalRelationPostSteps(collection.relationPostSteps),
      ...optionalRowKeyFields(queryRowKeyFields(query))
    },
    reason: incrementalSingleRootPlanReason(collection)
  };
}

export function buildIncrementalMaterialization<Row>(
  plan: IncrementalMaterializationPlan,
  relation: RelationRef | undefined,
  rootRows: readonly unknown[] = [],
  env: Readonly<Record<string, unknown>>,
  relationSnapshots: ReadonlyMap<string, IncrementalRelationSnapshot> = relation === undefined
    ? new Map()
    : new Map([[relation.name, { relation, rows: rootRows }]]),
  options: IncrementalMaterializationPlanOptions = {}
): IncrementalMaterializationBuildResult<Row> {
  const ctx = incrementalEvalContext(env, options);
  if (plan.kind === 'staticRows') {
    return buildStaticIncrementalMaterialization(plan, ctx);
  }

  if (plan.kind === 'dynamicSet') {
    return buildDynamicSetIncrementalMaterialization(plan, relationSnapshots, ctx);
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

  const joinStatesResult = buildJoinStates(plan, relationSnapshots, ctx);
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

    const evaluated = evaluateRootRow<unknown>(plan, row, ctx, joinStateById);
    if (!evaluated.supported) {
      return {
        supported: false,
        reason: evaluated.reason
      };
    }

    outputsByRootKey.set(key, evaluated.rows);
    recordRootJoinValues(rootValuesByStep, key, evaluated.joinValuesByStep);
  }

  let joinStates: readonly IncrementalJoinState[] = joinStatesResult.states.map((state) =>
    withRootJoinValues(state, rootValuesByStep.get(state.id) ?? new Map())
  );

  const aggregate = aggregateStep(plan);
  const aggregateState = aggregate === undefined
    ? undefined
    : buildAggregateState<Row>(plan, rootKeys, outputsByRootKey, ctx, joinStateMap(joinStates));
  if (aggregateState !== undefined && !aggregateState.supported) {
    return {
      supported: false,
      reason: aggregateState.reason
    };
  }
  if (aggregateState !== undefined) {
    const postAggregateJoinStates = withPostAggregateJoinValues(
      plan,
      joinStates,
      aggregateState.state,
      ctx
    );
    if (!postAggregateJoinStates.supported) {
      return {
        supported: false,
        reason: postAggregateJoinStates.reason
      };
    }
    joinStates = postAggregateJoinStates.states;
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

  const orderedState = buildOrderedState<Row>(plan, state, ctx);
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

  const relationPostState = buildRelationPostState<Row>(plan, state);
  if (relationPostState !== undefined) {
    state = {
      ...state,
      relationPost: relationPostState
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
  env: Readonly<Record<string, unknown>>,
  options: IncrementalMaterializationPlanOptions = {}
): IncrementalMaterializationBuildResult<Row> {
  const ctx = isIncrementalEvalContext(env) ? env : incrementalEvalContext(env, options);
  const evaluated = evaluateStaticRows(plan.data, ctx);
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
  env: Readonly<Record<string, unknown>>,
  options: IncrementalMaterializationPlanOptions = {}
): IncrementalMaintenanceResult<Row> {
  const ctx = incrementalEvalContext(env, options);
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
    return maintainDynamicSetMaterialization(materialization.plan, materialization, deltas, ctx);
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

  const relationPostSteps = relationPostStepsForPlan(materialization.plan);
  const previousRelationPostState = materialization.state.relationPost;
  if (relationPostSteps.length > 0 && previousRelationPostState === undefined) {
    return {
      updated: false,
      reason: 'incremental relation post state is missing; snapshot recompute is required'
    };
  }
  if (relationPostSteps.length === 0 && previousRelationPostState !== undefined) {
    return {
      updated: false,
      reason: 'incremental relation post state is present for a non-relation-post plan; snapshot recompute is required'
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
  const preAggregateDependencySteps = aggregate === undefined
    ? rootDependencySteps(materialization.plan)
    : rootDependencyStepsBeforeAggregate(materialization.plan);
  const postAggregateDependencySteps = aggregate === undefined
    ? []
    : rootDependencyStepsAfterAggregate(materialization.plan);

  for (const joinStep of preAggregateDependencySteps) {
    const currentState = joinStates.find((state) => state.id === joinStep.id);
    if (currentState === undefined) {
      return {
        updated: false,
        reason: `incremental join state ${joinStep.id} is missing; snapshot recompute is required`
      };
    }

    let nextJoinState = currentState;
    const nestedChanged = applyNestedBranchJoinChanges(joinStep, nextJoinState, deltas, ctx);
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
        const changed = applyRightRelationChanges(joinStep, nextJoinState, deltaRelation, rightChanges.changes, ctx);
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

  for (const joinStep of postAggregateDependencySteps) {
    const currentState = joinStates.find((state) => state.id === joinStep.id);
    if (currentState === undefined) {
      return {
        updated: false,
        reason: `incremental join state ${joinStep.id} is missing; snapshot recompute is required`
      };
    }

    let nextJoinState = currentState;
    const nestedChanged = applyNestedBranchJoinChanges(joinStep, nextJoinState, deltas, ctx);
    if (!nestedChanged.supported) {
      return {
        updated: false,
        reason: nestedChanged.reason
      };
    }
    nextJoinState = nestedChanged.state;
    for (const groupKey of nestedChanged.affectedRootKeys) {
      affectedAggregateGroupKeys.add(groupKey);
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
        const changed = applyRightRelationChanges(joinStep, nextJoinState, deltaRelation, rightChanges.changes, ctx);
        if (!changed.supported) {
          return {
            updated: false,
            reason: changed.reason
          };
        }

        nextJoinState = changed.state;
        for (const groupKey of changed.affectedRootKeys) {
          affectedAggregateGroupKeys.add(groupKey);
        }
      }
    }

    if (nextJoinState !== currentState) {
      joinStates = joinStates.map((state) => state.id === nextJoinState.id ? nextJoinState : state);
    }
  }

  const preAggregateDependencyStepIds = new Set(preAggregateDependencySteps.map((step) => step.id));
  const rootJoinIndexes = mutableRootJoinIndexes(
    joinStates.filter((state) => preAggregateDependencyStepIds.has(state.id))
  );

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

    const evaluated = evaluateRootRow<unknown>(materialization.plan, row, ctx, joinStateById);
    if (!evaluated.supported) {
      return {
        updated: false,
        reason: evaluated.reason
      };
    }

    outputsByRootKey.set(rootKey, evaluated.rows);
    if (aggregate !== undefined && groupKeysByRootKey !== undefined) {
      const nextGroupKeys = aggregateGroupKeysForRows(aggregate, evaluated.rows, ctx);
      recordAggregateGroupKeys(affectedAggregateGroupKeys, nextGroupKeys);
      if (nextGroupKeys.length > 0) {
        groupKeysByRootKey.set(rootKey, nextGroupKeys);
      }
      addRootToAggregateGroups(rootKeysByGroupKey, rootKey, nextGroupKeys, compactRootIndexByKey);
    }
    addRootJoinValues(rootJoinIndexes, rootKey, evaluated.joinValuesByStep);
  }

  let nextJoinStates: readonly IncrementalJoinState[] = joinStates.map((state) =>
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
      ctx,
      joinStateMap(nextJoinStates)
    );
  if (nextAggregateState !== undefined && !nextAggregateState.supported) {
    return {
      updated: false,
      reason: nextAggregateState.reason
    };
  }
  if (nextAggregateState !== undefined) {
    const postAggregateJoinStates = withPostAggregateJoinValues(
      materialization.plan,
      nextJoinStates,
      nextAggregateState.state,
      ctx
    );
    if (!postAggregateJoinStates.supported) {
      return {
        updated: false,
        reason: postAggregateJoinStates.reason
      };
    }
    nextJoinStates = postAggregateJoinStates.states;
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
      ctx
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

  const relationPostState = buildRelationPostState<Row>(materialization.plan, state);
  if (relationPostState !== undefined) {
    state = {
      ...state,
      relationPost: relationPostState
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

function collectDynamicSetPlan(
  data: QueryData,
  options: IncrementalMaterializationPlanOptions
):
  | { readonly supported: true; readonly plan: IncrementalDynamicSetMaterializationPlan }
  | { readonly supported: false; readonly reason: string } {
  switch (data.op) {
    case 'keyBy':
      return collectDynamicSetPlan(data.input, options);
    case 'union':
    case 'intersection':
      return collectDynamicSetBranches(data.op, data.inputs, options);
    case 'difference':
      return collectDynamicSetBranches('difference', [data.left, data.right], options);
    default:
      return {
        supported: false,
        reason: 'query is not a dynamic set operation'
      };
  }
}

function collectDynamicSetBranches(
  op: 'union' | 'intersection' | 'difference',
  inputs: readonly QueryData[],
  options: IncrementalMaterializationPlanOptions
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
    const branch = collectRightBranchPlan(
      input,
      { allowNestedJoin: false, allowOrderedWindow: false, allowAggregate: false },
      options
    );
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
  collection: PlanCollection,
  options: IncrementalMaterializationPlanOptions
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
      const reason = constantExprReason(data.value, options);
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
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'where');
      if (relationPostReason !== undefined) return relationPostReason;
      if (collection.ordered !== undefined) {
        return 'where after order/window is not supported for incremental maintenance';
      }
      const reason = hasAggregateStep(steps)
        ? rowLocalPredicateReason(data.predicate, root.shape, options)
        : planPredicateReason(data.predicate, root.shape, steps, collection, options);
      if (reason !== undefined) {
        return `where predicate is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({ kind: 'where', predicate: data.predicate });
      return root;
    }
    case 'hash':
    case 'btree': {
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, data.op);
      if (relationPostReason !== undefined) return relationPostReason;
      for (const expression of data.expressions) {
        const reason = rowLocalExprReason(expression, root.shape, options);
        if (reason !== undefined) {
          return `${data.op} expression is not supported for incremental maintenance: ${reason}`;
        }
      }
      return root;
    }
    case 'keyBy':
      return collectSingleRootPlan(data.input, steps, collection, options);
    case 'select': {
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'select');
      if (relationPostReason !== undefined) return relationPostReason;
      const reason = planProjectionReason(data.projection, root.shape, steps, collection, {
        allowSubqueries: collection.ordered === undefined && !hasAggregateStep(steps)
      }, options);
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
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'extend');
      if (relationPostReason !== undefined) return relationPostReason;
      const reason = planProjectionReason(data.projection, root.shape, steps, collection, {
        allowSubqueries: collection.ordered === undefined && !hasAggregateStep(steps)
      }, options);
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
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'without');
      if (relationPostReason !== undefined) return relationPostReason;
      const step = { kind: 'without', fields: data.fields } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: withoutShape(root.shape, data.fields) };
    }
    case 'rename': {
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'rename');
      if (relationPostReason !== undefined) return relationPostReason;
      const step = { kind: 'rename', fields: data.fields } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: renameShape(root.shape, data.fields) };
    }
    case 'qualify': {
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'qualify');
      if (relationPostReason !== undefined) return relationPostReason;
      const step = { kind: 'qualify', alias: data.alias } satisfies IncrementalPostOrderStep;
      if (collection.ordered !== undefined) {
        collection.ordered.postSteps.push(step);
      } else {
        steps.push(step);
      }
      return { ...root, shape: qualifyShape(root.shape, data.alias) };
    }
    case 'expand': {
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'expand');
      if (relationPostReason !== undefined) return relationPostReason;
      if (collection.ordered !== undefined) {
        return 'expand after order/window is not supported for incremental maintenance';
      }
      const reason = rowLocalExprReason(data.collection, root.shape, options);
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
      const left = collectSingleRootPlan(data.left, steps, collection, options);
      if (typeof left === 'string') return left;
      const relationPostReason = operatorAfterRelationPostReason(collection, `${data.kind} join`);
      if (relationPostReason !== undefined) return relationPostReason;
      if (collection.ordered !== undefined) {
        return `${data.kind} join after order/window is not supported for incremental maintenance`;
      }
      const right = collectRightBranchPlan(
        data.right,
        { allowNestedJoin: true, allowOrderedWindow: true, allowAggregate: true },
        options
      );
      if (typeof right === 'string') {
        return `join right branch is not supported for incremental maintenance: ${right}`;
      }

      if (shapesHaveFieldOrAliasOverlap(left.shape, right.shape)) {
        return 'ambiguous join field or alias shapes are not supported for incremental maintenance';
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
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'sort');
      if (relationPostReason !== undefined) return relationPostReason;
      if (collection.ordered !== undefined) {
        return 'sort after order/window is not supported for incremental maintenance';
      }
      const reason = sortOrderReason(data.order, root.shape, options);
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
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'limit');
      if (relationPostReason !== undefined) return relationPostReason;
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
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'sortLimit');
      if (relationPostReason !== undefined) return relationPostReason;
      if (collection.ordered !== undefined) {
        return 'sortLimit after order/window is not supported for incremental maintenance';
      }
      const orderReason = sortOrderReason(data.order, root.shape, options);
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
      return collectStaticUnionPlan(data.inputs, steps, collection, options);
    case 'intersection':
      return collectIntersectionPlan(data.inputs, steps, collection, options);
    case 'difference':
      return collectDifferencePlan(data.left, data.right, steps, collection, options);
    case 'constRows':
      return 'constRows is not supported for incremental maintenance';
    case 'aggregate': {
      const stepCount = steps.length;
      const root = collectSingleRootPlan(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const relationPostReason = operatorAfterRelationPostReason(collection, 'aggregate');
      if (relationPostReason !== undefined) return relationPostReason;
      if (collection.ordered !== undefined) {
        return 'aggregate after order/window is not supported for incremental maintenance';
      }
      const addedSteps = steps.slice(stepCount);
      if (hasAggregateStep(addedSteps)) {
        return 'nested aggregate is not supported for incremental maintenance';
      }

      const groupReason = rowLocalProjectionReason(data.groupBy, root.shape, options);
      if (groupReason !== undefined) {
        return `aggregate groupBy projection is not supported for incremental maintenance: ${groupReason}`;
      }

      const aggregateReason = aggregateProjectionReason(data.aggregates, root.shape, options);
      if (aggregateReason !== undefined) {
        return `aggregate projection is not supported for incremental maintenance: ${aggregateReason}`;
      }

      steps.push({ kind: 'aggregate', groupBy: data.groupBy, aggregates: data.aggregates });
      return { ...root, shape: aggregateShape(root.shape, data.groupBy, data.aggregates) };
    }
  }
}

function planProjectionReason(
  projection: ProjectionData,
  shape: PlanShape,
  steps: IncrementalStep[],
  collection: PlanCollection,
  options: { readonly allowSubqueries: boolean },
  planOptions: IncrementalMaterializationPlanOptions
): string | undefined {
  for (const item of Object.values(projection)) {
    const reason = planExprReason(projectionExpr(item), shape, steps, collection, options, planOptions);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

function planPredicateReason(
  predicate: PredicateData,
  shape: PlanShape,
  steps: IncrementalStep[],
  collection: PlanCollection,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return planExprReason(predicate.left, shape, steps, collection, { allowSubqueries: true }, options) ??
        planExprReason(predicate.right, shape, steps, collection, { allowSubqueries: true }, options);
    case 'and':
    case 'or':
      for (const item of predicate.predicates) {
        const reason = planPredicateReason(item, shape, steps, collection, options);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'not':
      return planPredicateReason(predicate.predicate, shape, steps, collection, options);
  }
}

function planExprReason(
  expr: ExprData,
  shape: PlanShape,
  steps: IncrementalStep[],
  collection: PlanCollection,
  options: { readonly allowSubqueries: boolean },
  planOptions: IncrementalMaterializationPlanOptions
): string | undefined {
  switch (expr.op) {
    case 'field':
      return exprShapeReason(expr, shape);
    case 'value':
      return undefined;
    case 'tuple':
      for (const item of expr.items) {
        const reason = planExprReason(item, shape, steps, collection, options, planOptions);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'subquery':
      if (!options.allowSubqueries) {
        return 'subquery expressions after aggregate/order are not supported for incremental maintenance';
      }
      return planSubqueryExpression(expr, shape, steps, collection, planOptions);
    case 'hostCall':
      return rowLocalExprReason(expr, shape, planOptions);
    case 'call':
      return namedCallReason(expr, (arg) => planExprReason(arg, shape, steps, collection, options, planOptions), planOptions);
    case 'env':
    case 'aggregateCall':
      return simpleExprReason(expr);
  }
}

function planSubqueryExpression(
  expr: Extract<ExprData, { readonly op: 'subquery' }>,
  outerShape: PlanShape,
  steps: IncrementalStep[],
  collection: PlanCollection,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  const exprKey = subqueryExprKey(expr);
  if (collection.subqueryKeys.has(exprKey)) {
    return undefined;
  }

  const hiddenField = `__tarstate_subquery_${collection.subqueryCount}_key`;
  const lowerState: LowerCorrelatedSubqueryState = {
    hiddenField,
    allowCorrelation: true
  };
  const lowered = lowerCorrelatedSubqueryData(expr.query, outerShape, lowerState, options);
  if (typeof lowered === 'string') {
    return `subquery expression is not supported for incremental maintenance: ${lowered}`;
  }
  if (lowerState.correlation === undefined) {
    return 'subquery incremental maintenance requires an unambiguous equality correlation';
  }

  const right = collectRightBranchPlan(
    lowered.data,
    { allowNestedJoin: true, allowOrderedWindow: true, allowAggregate: true },
    options
  );
  if (typeof right === 'string') {
    return `subquery branch is not supported for incremental maintenance: ${right}`;
  }
  if (intersects(outerShape.relations, right.shape.relations)) {
    return 'self-correlated subqueries are not supported for incremental maintenance';
  }

  const id = `subquery:${collection.subqueryCount}`;
  collection.subqueryCount += 1;
  collection.subqueryKeys.add(exprKey);
  const hiddenExpr = subqueryHiddenFieldExpr(hiddenField);
  steps.push({
    kind: 'subquery',
    id,
    exprKey,
    mode: expr.mode,
    right: branchPlan(right),
    left: lowerState.correlation.left,
    rightExpr: hiddenExpr,
    predicate: { op: 'eq', left: lowerState.correlation.left, right: hiddenExpr },
    needsPredicateCheck: false,
    hiddenField
  });
  return undefined;
}

type LowerCorrelatedSubqueryState = {
  readonly hiddenField: string;
  readonly allowCorrelation: boolean;
  correlation?: {
    readonly left: ExprData;
  };
};

type LoweredCorrelatedSubqueryData = {
  readonly data: QueryData;
  readonly shape: PlanShape;
};

function lowerCorrelatedSubqueryData(
  data: QueryData,
  outerShape: PlanShape,
  state: LowerCorrelatedSubqueryState,
  options: IncrementalMaterializationPlanOptions
): LoweredCorrelatedSubqueryData | string {
  switch (data.op) {
    case 'from':
      return {
        data,
        shape: shapeForRoot(data.relation, data.alias)
      };
    case 'lookup': {
      const reason = constantExprReason(data.value, options);
      if (reason !== undefined) {
        return `lookup value is not supported: ${reason}`;
      }
      return {
        data,
        shape: shapeForRoot(data.relation, data.alias)
      };
    }
    case 'where': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      const split = splitSubqueryPredicate(data.predicate, outerShape, input.shape, options);
      if (typeof split === 'string') return split;

      let nextData = input.data;
      let nextShape = input.shape;
      if (split.correlation !== undefined) {
        if (!state.allowCorrelation) {
          return 'correlation inside nested subquery branches is not supported';
        }
        if (state.correlation !== undefined) {
          return 'multiple subquery equality correlations are not supported';
        }

        state.correlation = { left: split.correlation.left };
        nextData = {
          op: 'extend',
          input: nextData,
          projection: { [state.hiddenField]: split.correlation.right }
        };
        nextShape = extendShape(nextShape, { [state.hiddenField]: split.correlation.right });
      }

      if (split.residual !== undefined) {
        nextData = {
          op: 'where',
          input: nextData,
          predicate: split.residual
        };
      }
      return { data: nextData, shape: nextShape };
    }
    case 'hash':
    case 'btree': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      for (const expression of data.expressions) {
        const reason = rowLocalExprReason(expression, input.shape, options);
        if (reason !== undefined) {
          return `${data.op} expression is not supported: ${reason}`;
        }
      }
      return {
        data: { ...data, input: input.data },
        shape: input.shape
      };
    }
    case 'keyBy': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      return typeof input === 'string'
        ? input
        : { data: { ...data, input: input.data }, shape: input.shape };
    }
    case 'select': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      const projection = state.correlation === undefined
        ? data.projection
        : projectionWithHiddenSubqueryField(data.projection, state.hiddenField);
      const reason = rowLocalProjectionReason(projection, input.shape, options);
      if (reason !== undefined) {
        return `select projection is not supported: ${reason}`;
      }
      return {
        data: { op: 'select', input: input.data, projection },
        shape: selectShape(input.shape, projection)
      };
    }
    case 'extend': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      if (Object.hasOwn(data.projection, state.hiddenField)) {
        return 'subquery projection conflicts with an internal correlation field';
      }
      const reason = rowLocalProjectionReason(data.projection, input.shape, options);
      if (reason !== undefined) {
        return `extend projection is not supported: ${reason}`;
      }
      return {
        data: { ...data, input: input.data },
        shape: extendShape(input.shape, data.projection)
      };
    }
    case 'expand': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      const reason = rowLocalExprReason(data.collection, input.shape, options);
      if (reason !== undefined) {
        return `expand collection is not supported: ${reason}`;
      }
      return {
        data: { ...data, input: input.data },
        shape: expandShape(input.shape, data.alias, data.fields)
      };
    }
    case 'without': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      if (state.correlation !== undefined && data.fields.includes(state.hiddenField)) {
        return 'without cannot remove an internal subquery correlation field';
      }
      return {
        data: { ...data, input: input.data },
        shape: withoutShape(input.shape, data.fields)
      };
    }
    case 'rename': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      if (
        state.correlation !== undefined &&
        (Object.hasOwn(data.fields, state.hiddenField) || Object.values(data.fields).includes(state.hiddenField))
      ) {
        return 'rename cannot rewrite an internal subquery correlation field';
      }
      return {
        data: { ...data, input: input.data },
        shape: renameShape(input.shape, data.fields)
      };
    }
    case 'qualify': {
      const input = lowerCorrelatedSubqueryData(data.input, outerShape, state, options);
      if (typeof input === 'string') return input;
      if (state.correlation !== undefined) {
        return 'qualify after subquery correlation is not supported';
      }
      return {
        data: { ...data, input: input.data },
        shape: qualifyShape(input.shape, data.alias)
      };
    }
    case 'join': {
      if (data.kind !== 'inner') {
        return 'left joins inside correlated subqueries are not supported';
      }

      const left = lowerCorrelatedSubqueryData(data.left, outerShape, state, options);
      if (typeof left === 'string') {
        return `subquery join left side is not supported: ${left}`;
      }

      const rightState: LowerCorrelatedSubqueryState = {
        hiddenField: state.hiddenField,
        allowCorrelation: false
      };
      const right = lowerCorrelatedSubqueryData(data.right, outerShape, rightState, options);
      if (typeof right === 'string') {
        return `subquery join right side is not supported: ${right}`;
      }

      const shape = mergeShapes(left.shape, right.shape);
      const predicateReason = simplePredicateReason(data.on) ?? predicateShapeReason(data.on, shape);
      if (predicateReason !== undefined) {
        return `subquery join predicate is not supported: ${predicateReason}`;
      }

      return {
        data: { ...data, left: left.data, right: right.data },
        shape
      };
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
      return 'intersection is not supported';
    case 'difference':
      return 'difference is not supported';
    case 'constRows':
      return 'constRows is not supported';
    case 'aggregate':
      return 'aggregate is not supported';
  }
}

type SplitSubqueryPredicateResult = {
  readonly correlation?: EqualityJoinPlan;
  readonly residual?: PredicateData;
};

function splitSubqueryPredicate(
  predicate: PredicateData,
  outerShape: PlanShape,
  branchShape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): SplitSubqueryPredicateResult | string {
  if (predicate.op === 'and') {
    let correlation: EqualityJoinPlan | undefined;
    const residuals: PredicateData[] = [];
    for (const item of predicate.predicates) {
      const split = splitSubqueryPredicate(item, outerShape, branchShape, options);
      if (typeof split === 'string') return split;
      if (split.correlation !== undefined) {
        if (correlation !== undefined) {
          return 'multiple subquery equality correlations are not supported';
        }
        correlation = split.correlation;
      }
      if (split.residual !== undefined) {
        residuals.push(split.residual);
      }
    }
    return {
      ...(correlation === undefined ? {} : { correlation }),
      ...optionalAndPredicate(residuals)
    };
  }

  const equality = equalityJoinPlan(predicate, (expr) => expressionSideForShapes(expr, outerShape, branchShape));
  if (equality !== undefined) {
    return { correlation: equality };
  }

  const branchReason = rowLocalPredicateReason(predicate, branchShape, options);
  if (branchReason === undefined) {
    return { residual: predicate };
  }

  const mergedShape = mergeShapes(outerShape, branchShape);
  const mergedReason = rowLocalPredicateReason(predicate, mergedShape, options);
  if (mergedReason === undefined) {
    return 'non-equality correlated subquery predicates are not supported for incremental maintenance';
  }

  return branchReason;
}

function optionalAndPredicate(
  predicates: readonly PredicateData[]
): { readonly residual?: PredicateData } {
  if (predicates.length === 0) {
    return {};
  }
  if (predicates.length === 1) {
    return { residual: predicates[0] as PredicateData };
  }
  return { residual: { op: 'and', predicates } };
}

function projectionWithHiddenSubqueryField(
  projection: ProjectionData,
  hiddenField: string
): ProjectionData {
  return Object.hasOwn(projection, hiddenField)
    ? projection
    : { ...projection, [hiddenField]: subqueryHiddenFieldExpr(hiddenField) };
}

function subqueryHiddenFieldExpr(hiddenField: string): ExprData {
  return { op: 'field', alias: '__tarstateSubquery', field: hiddenField };
}

function subqueryExprKey(expr: Extract<ExprData, { readonly op: 'subquery' }>): string {
  return stableKey({ mode: expr.mode, query: expr.query });
}

function sortOrderReason(
  order: readonly SortData[],
  shape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  for (const item of order) {
    const reason = rowLocalExprReason(item.expr, shape, options);
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

function collectStaticUnionPlan(
  inputs: readonly QueryData[],
  steps: IncrementalStep[],
  collection: PlanCollection,
  options: IncrementalMaterializationPlanOptions
): RootPlan | string {
  if (inputs.length < 2) {
    return 'union incremental maintenance requires one supported root branch and static right branches';
  }

  const split = splitStaticUnionInputs(inputs, 'union', options);
  if (typeof split === 'string') {
    return split;
  }

  const root = collectSingleRootPlan(split.dynamicInput, steps, collection, options);
  if (typeof root === 'string') {
    return `union dynamic branch is not supported for incremental maintenance: ${root}`;
  }

  collection.relationPostSteps.push({
    kind: 'staticUnion',
    ...optionalBeforeStaticUnionRows(split.beforeRows),
    rows: split.afterRows
  });
  return { ...root, shape: mergeShapes(root.shape, split.staticShape) };
}

function collectIntersectionPlan(
  inputs: readonly QueryData[],
  steps: IncrementalStep[],
  collection: PlanCollection,
  options: IncrementalMaterializationPlanOptions
): RootPlan | string {
  const [leftInput, ...rightInputs] = inputs;
  if (leftInput === undefined || rightInputs.length === 0) {
    return 'intersection incremental maintenance requires one supported root branch and static right branches';
  }

  const root = collectSingleRootPlan(leftInput, steps, collection, options);
  if (typeof root === 'string') {
    return `intersection first branch is not supported for incremental maintenance: ${root}`;
  }
  const relationPostReason = operatorAfterRelationPostReason(collection, 'intersection');
  if (relationPostReason !== undefined) return relationPostReason;
  if (collection.ordered !== undefined) {
    return 'intersection after order/window is not supported for incremental maintenance';
  }

  const rightRows = collectStaticSetRows(rightInputs, 'intersection', options);
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
  collection: PlanCollection,
  options: IncrementalMaterializationPlanOptions
): RootPlan | string {
  const root = collectSingleRootPlan(leftInput, steps, collection, options);
  if (typeof root === 'string') {
    return `difference left branch is not supported for incremental maintenance: ${root}`;
  }
  const relationPostReason = operatorAfterRelationPostReason(collection, 'difference');
  if (relationPostReason !== undefined) return relationPostReason;
  if (collection.ordered !== undefined) {
    return 'difference after order/window is not supported for incremental maintenance';
  }

  const rightRows = collectStaticSetRows([rightInput], 'difference', options);
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'difference', rightRows });
  return root;
}

function collectStaticSetRows(
  inputs: readonly QueryData[],
  op: 'intersection' | 'difference',
  options: IncrementalMaterializationPlanOptions
): readonly (readonly Record<string, unknown>[])[] | string {
  const rows: Array<readonly Record<string, unknown>[]> = [];
  for (const input of inputs) {
    const planned = collectStaticRowsPlan(input, options);
    if (typeof planned === 'string') {
      return `${op} static branch is not supported for incremental maintenance: ${planned}`;
    }

    const evaluated = evaluateStaticRows(input, incrementalEvalContext({}, options));
    if (!evaluated.supported) {
      return `${op} static branch is not supported for incremental maintenance: ${evaluated.reason}`;
    }
    rows.push(evaluated.rows);
  }
  return rows;
}

type SplitStaticUnionInputsResult = {
  readonly dynamicInput: QueryData;
  readonly beforeRows: readonly Record<string, unknown>[];
  readonly afterRows: readonly Record<string, unknown>[];
  readonly staticShape: PlanShape;
};

function splitStaticUnionInputs(
  inputs: readonly QueryData[],
  op: 'union' | 'right branch union',
  options: IncrementalMaterializationPlanOptions
): SplitStaticUnionInputsResult | string {
  let dynamicInput: QueryData | undefined;
  let dynamicIndex = -1;
  const staticInputs: Array<{
    readonly index: number;
    readonly rows: readonly Record<string, unknown>[];
    readonly shape: PlanShape;
  }> = [];

  for (const [index, input] of inputs.entries()) {
    const staticConstRowsReason = staticUnionConstRowsReason(input);
    if (staticConstRowsReason === undefined) {
      const evaluated = evaluateStaticRows(input, incrementalEvalContext({}, options));
      if (!evaluated.supported) {
        return `${op} static branch is not supported for incremental maintenance: ${evaluated.reason}`;
      }
      const shape = collectStaticRowsPlan(input, options);
      if (typeof shape === 'string') {
        return `${op} static branch is not supported for incremental maintenance: ${shape}`;
      }
      staticInputs.push({ index, rows: evaluated.rows, shape });
      continue;
    }

    if (dynamicInput !== undefined) {
      return `${op} incremental maintenance requires exactly one supported dynamic branch and static constRows branches`;
    }
    dynamicInput = input;
    dynamicIndex = index;
  }

  if (dynamicInput === undefined || staticInputs.length === 0) {
    return `${op} incremental maintenance requires one supported dynamic branch and static constRows branches`;
  }

  return {
    dynamicInput,
    beforeRows: setUnionRows(staticInputs.filter((input) => input.index < dynamicIndex).map((input) => input.rows)),
    afterRows: setUnionRows(staticInputs.filter((input) => input.index > dynamicIndex).map((input) => input.rows)),
    staticShape: staticInputs.reduce<PlanShape>((shape, input) => mergeShapes(shape, input.shape), emptyShape())
  };
}

function staticUnionConstRowsReason(data: QueryData): string | undefined {
  switch (data.op) {
    case 'constRows':
      return undefined;
    case 'keyBy':
      return staticUnionConstRowsReason(data.input);
    default:
      return `${data.op} is not static constRows`;
  }
}

function collectStaticRowsPlan(
  data: QueryData,
  options: IncrementalMaterializationPlanOptions
): PlanShape | string {
  switch (data.op) {
    case 'constRows':
      return shapeForConstRows(data.rows);
    case 'where': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const reason = rowLocalPredicateReason(data.predicate, shape, options);
      return reason === undefined ? shape : `where predicate is not supported: ${reason}`;
    }
    case 'hash':
    case 'btree': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      for (const expression of data.expressions) {
        const reason = rowLocalExprReason(expression, shape, options);
        if (reason !== undefined) {
          return `${data.op} expression is not supported: ${reason}`;
        }
      }
      return shape;
    }
    case 'keyBy':
      return collectStaticRowsPlan(data.input, options);
    case 'select': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const reason = rowLocalProjectionReason(data.projection, shape, options);
      if (reason !== undefined) {
        return `select projection is not supported: ${reason}`;
      }
      return selectShape(shape, data.projection);
    }
    case 'extend': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const reason = rowLocalProjectionReason(data.projection, shape, options);
      if (reason !== undefined) {
        return `extend projection is not supported: ${reason}`;
      }
      return extendShape(shape, data.projection);
    }
    case 'expand': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const reason = rowLocalExprReason(data.collection, shape, options);
      if (reason !== undefined) {
        return `expand collection is not supported: ${reason}`;
      }
      return expandShape(shape, data.alias, data.fields);
    }
    case 'without': {
      const shape = collectStaticRowsPlan(data.input, options);
      return typeof shape === 'string' ? shape : withoutShape(shape, data.fields);
    }
    case 'rename': {
      const shape = collectStaticRowsPlan(data.input, options);
      return typeof shape === 'string' ? shape : renameShape(shape, data.fields);
    }
    case 'qualify': {
      const shape = collectStaticRowsPlan(data.input, options);
      return typeof shape === 'string' ? shape : qualifyShape(shape, data.alias);
    }
    case 'union': {
      const shapes = collectStaticInputShapes(data.inputs, options);
      if (typeof shapes === 'string') return shapes;
      return shapes.reduce<PlanShape>((shape, item) => mergeShapes(shape, item), emptyShape());
    }
    case 'intersection': {
      const shapes = collectStaticInputShapes(data.inputs, options);
      if (typeof shapes === 'string') return shapes;
      return shapes[0] ?? emptyShape();
    }
    case 'difference': {
      const left = collectStaticRowsPlan(data.left, options);
      if (typeof left === 'string') return left;
      const right = collectStaticRowsPlan(data.right, options);
      return typeof right === 'string' ? right : left;
    }
    case 'from':
    case 'lookup':
    case 'join':
      return staticRowsRelationReason;
    case 'sort': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const reason = sortOrderReason(data.order, shape, options);
      return reason === undefined ? shape : `sort order is not supported: ${reason}`;
    }
    case 'limit': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const window = normalizedWindow(data.count, data.offset ?? 0);
      return typeof window === 'string' ? `limit is not supported: ${window}` : shape;
    }
    case 'sortLimit': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const orderReason = sortOrderReason(data.order, shape, options);
      if (orderReason !== undefined) {
        return `sortLimit order is not supported: ${orderReason}`;
      }
      const window = normalizedWindow(data.count, 0);
      return typeof window === 'string' ? `sortLimit is not supported: ${window}` : shape;
    }
    case 'aggregate': {
      const shape = collectStaticRowsPlan(data.input, options);
      if (typeof shape === 'string') return shape;
      const groupReason = rowLocalProjectionReason(data.groupBy, shape, options);
      if (groupReason !== undefined) {
        return `aggregate groupBy projection is not supported: ${groupReason}`;
      }
      const aggregateReason = aggregateProjectionReason(data.aggregates, shape, options);
      if (aggregateReason !== undefined) {
        return `aggregate projection is not supported: ${aggregateReason}`;
      }
      return aggregateShape(shape, data.groupBy, data.aggregates);
    }
  }
}

function collectStaticInputShapes(
  inputs: readonly QueryData[],
  options: IncrementalMaterializationPlanOptions
): readonly PlanShape[] | string {
  const shapes: PlanShape[] = [];
  for (const input of inputs) {
    const shape = collectStaticRowsPlan(input, options);
    if (typeof shape === 'string') {
      return shape;
    }
    shapes.push(shape);
  }
  return shapes;
}

function collectRightBranchPlan(
  data: QueryData,
  branchOptions: {
    readonly allowNestedJoin: boolean;
    readonly allowOrderedWindow: boolean;
    readonly allowAggregate: boolean;
  },
  options: IncrementalMaterializationPlanOptions
): RightBranchPlan | string {
  const steps: IncrementalBranchStep[] = [];
  return collectRightBranchPlanInternal(data, steps, {
    allowNestedJoin: branchOptions.allowNestedJoin,
    allowOrderedWindow: branchOptions.allowOrderedWindow,
    allowAggregate: branchOptions.allowAggregate,
    branchJoinCount: 0
  }, options);
}

function collectRightBranchPlanInternal(
  data: QueryData,
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection,
  options: IncrementalMaterializationPlanOptions
): RightBranchPlan | string {
  switch (data.op) {
    case 'from':
      return rightBranchPlan({
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'from' },
        steps,
        shape: shapeForRoot(data.relation, data.alias)
      }, collection);
    case 'lookup': {
      const reason = constantExprReason(data.value, options);
      if (reason !== undefined) {
        return `lookup value is not supported: ${reason}`;
      }
      return rightBranchPlan({
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'lookup', field: data.field, value: data.value },
        steps,
        shape: shapeForRoot(data.relation, data.alias)
      }, collection);
    }
    case 'where': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'where');
      if (unionReason !== undefined) return unionReason;
      if (collection.ordered !== undefined) {
        return 'where after order/window is not supported';
      }
      const reason = rowLocalPredicateReason(data.predicate, root.shape, options);
      if (reason !== undefined) {
        return `where predicate is not supported: ${reason}`;
      }
      pushRightBranchPipelineStep(steps, collection, { kind: 'where', predicate: data.predicate });
      return rightBranchPlan(root, collection);
    }
    case 'hash':
    case 'btree': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, data.op);
      if (unionReason !== undefined) return unionReason;
      for (const expression of data.expressions) {
        const reason = rowLocalExprReason(expression, root.shape, options);
        if (reason !== undefined) {
          return `${data.op} expression is not supported: ${reason}`;
        }
      }
      return rightBranchPlan(root, collection);
    }
    case 'keyBy':
      return collectRightBranchPlanInternal(data.input, steps, collection, options);
    case 'select': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'select');
      if (unionReason !== undefined) return unionReason;
      const reason = rowLocalProjectionReason(data.projection, root.shape, options);
      if (reason !== undefined) {
        return `select projection is not supported: ${reason}`;
      }
      const step = { kind: 'select', projection: data.projection } satisfies IncrementalPostOrderStep;
      pushRightBranchPipelineStep(steps, collection, step);
      return rightBranchPlan({ ...root, shape: selectShape(root.shape, data.projection) }, collection);
    }
    case 'extend': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'extend');
      if (unionReason !== undefined) return unionReason;
      const reason = rowLocalProjectionReason(data.projection, root.shape, options);
      if (reason !== undefined) {
        return `extend projection is not supported: ${reason}`;
      }
      const step = { kind: 'extend', projection: data.projection } satisfies IncrementalPostOrderStep;
      pushRightBranchPipelineStep(steps, collection, step);
      return rightBranchPlan({ ...root, shape: extendShape(root.shape, data.projection) }, collection);
    }
    case 'expand': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'expand');
      if (unionReason !== undefined) return unionReason;
      if (collection.ordered !== undefined) {
        return 'expand after order/window is not supported';
      }
      if (collection.aggregate !== undefined) {
        return 'expand after aggregate is not supported';
      }
      const reason = rowLocalExprReason(data.collection, root.shape, options);
      if (reason !== undefined) {
        return `expand collection is not supported: ${reason}`;
      }
      steps.push({
        kind: 'expand',
        collection: data.collection,
        ...(data.alias === undefined ? {} : { alias: data.alias }),
        ...(data.fields === undefined ? {} : { fields: data.fields })
      });
      return rightBranchPlan({ ...root, shape: expandShape(root.shape, data.alias, data.fields) }, collection);
    }
    case 'without': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'without');
      if (unionReason !== undefined) return unionReason;
      const step = { kind: 'without', fields: data.fields } satisfies IncrementalPostOrderStep;
      pushRightBranchPipelineStep(steps, collection, step);
      return rightBranchPlan({ ...root, shape: withoutShape(root.shape, data.fields) }, collection);
    }
    case 'rename': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'rename');
      if (unionReason !== undefined) return unionReason;
      const step = { kind: 'rename', fields: data.fields } satisfies IncrementalPostOrderStep;
      pushRightBranchPipelineStep(steps, collection, step);
      return rightBranchPlan({ ...root, shape: renameShape(root.shape, data.fields) }, collection);
    }
    case 'qualify': {
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'qualify');
      if (unionReason !== undefined) return unionReason;
      const step = { kind: 'qualify', alias: data.alias } satisfies IncrementalPostOrderStep;
      pushRightBranchPipelineStep(steps, collection, step);
      return rightBranchPlan({ ...root, shape: qualifyShape(root.shape, data.alias) }, collection);
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
        allowOrderedWindow: collection.allowOrderedWindow,
        allowAggregate: false,
        branchJoinCount: 0
      }, options);
      if (typeof left === 'string') {
        return `nested right branch join left side is not supported: ${left}`;
      }
      if (left.staticUnion !== undefined) {
        return 'join after terminal union is not supported';
      }
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'join');
      if (unionReason !== undefined) return unionReason;
      if (collection.aggregate !== undefined) {
        return 'join after aggregate is not supported';
      }
      if (left.ordered !== undefined || collection.ordered !== undefined) {
        return 'join after order/window is not supported';
      }

      const right = collectRightBranchPlan(
        data.right,
        { allowNestedJoin: false, allowOrderedWindow: collection.allowOrderedWindow, allowAggregate: false },
        options
      );
      if (typeof right === 'string') {
        return `nested right branch join right side is not supported: ${right}`;
      }

      if (shapesHaveFieldOrAliasOverlap(left.shape, right.shape)) {
        return 'ambiguous nested right branch join field or alias shapes are not supported';
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
      return rightBranchPlan({ ...left, shape: mergeShapes(left.shape, right.shape) }, collection);
    }
    case 'sort': {
      if (!collection.allowOrderedWindow) {
        return 'sort is not supported';
      }
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'sort');
      if (unionReason !== undefined) return unionReason;
      if (collection.aggregate !== undefined) {
        return 'sort after aggregate is not supported';
      }
      if (collection.ordered !== undefined) {
        return 'sort after order/window is not supported';
      }
      const orderReason = sortOrderReason(data.order, root.shape, options);
      if (orderReason !== undefined) {
        return `sort order is not supported: ${orderReason}`;
      }
      collection.ordered = {
        kind: 'ordered',
        order: data.order,
        postSteps: []
      };
      return rightBranchPlan(root, collection);
    }
    case 'limit': {
      if (!collection.allowOrderedWindow) {
        return 'limit is not supported';
      }
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'limit');
      if (unionReason !== undefined) return unionReason;
      const window = normalizedWindow(data.count, data.offset ?? 0);
      if (typeof window === 'string') {
        return `limit is not supported: ${window}`;
      }
      if (collection.aggregate !== undefined) {
        return 'limit after aggregate is not supported';
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
      return rightBranchPlan(root, collection);
    }
    case 'sortLimit': {
      if (!collection.allowOrderedWindow) {
        return 'sortLimit is not supported';
      }
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'sortLimit');
      if (unionReason !== undefined) return unionReason;
      if (collection.aggregate !== undefined) {
        return 'sortLimit after aggregate is not supported';
      }
      if (collection.ordered !== undefined) {
        return 'sortLimit after order/window is not supported';
      }
      const orderReason = sortOrderReason(data.order, root.shape, options);
      if (orderReason !== undefined) {
        return `sortLimit order is not supported: ${orderReason}`;
      }
      const window = normalizedWindow(data.count, 0);
      if (typeof window === 'string') {
        return `sortLimit is not supported: ${window}`;
      }
      collection.ordered = {
        kind: 'ordered',
        order: data.order,
        window,
        postSteps: []
      };
      return rightBranchPlan(root, collection);
    }
    case 'union':
      return collectRightBranchUnionPlan(data.inputs, steps, collection, options);
    case 'intersection':
      return collectRightBranchIntersectionPlan(data.inputs, steps, collection, options);
    case 'difference':
      return collectRightBranchDifferencePlan(data.left, data.right, steps, collection, options);
    case 'constRows':
      return 'constRows is not supported';
    case 'aggregate': {
      if (!collection.allowAggregate) {
        return 'aggregate is not supported';
      }
      const root = collectRightBranchPlanInternal(data.input, steps, collection, options);
      if (typeof root === 'string') return root;
      const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'aggregate');
      if (unionReason !== undefined) return unionReason;
      if (collection.aggregate !== undefined) {
        return 'nested aggregate is not supported';
      }
      if (collection.ordered !== undefined) {
        return 'aggregate after order/window is not supported';
      }

      const groupReason = rowLocalProjectionReason(data.groupBy, root.shape, options);
      if (groupReason !== undefined) {
        return `aggregate groupBy projection is not supported: ${groupReason}`;
      }

      const aggregateReason = aggregateProjectionReason(data.aggregates, root.shape, options);
      if (aggregateReason !== undefined) {
        return `aggregate projection is not supported: ${aggregateReason}`;
      }

      collection.aggregate = { kind: 'aggregate', groupBy: data.groupBy, aggregates: data.aggregates };
      collection.postAggregateSteps = [];
      return rightBranchPlan({
        ...root,
        shape: aggregateShape(root.shape, data.groupBy, data.aggregates)
      }, collection);
    }
  }
}

function pushRightBranchPipelineStep(
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection,
  step: IncrementalPipelineStep
): void {
  if (collection.aggregate !== undefined) {
    collection.postAggregateSteps = [...(collection.postAggregateSteps ?? []), step as IncrementalBranchPostAggregateStep];
  } else if (collection.ordered !== undefined && isPostOrderStep(step)) {
    collection.ordered.postSteps.push(step);
  } else {
    steps.push(step);
  }
}

function isPostOrderStep(step: IncrementalPipelineStep): step is IncrementalPostOrderStep {
  return (
    step.kind === 'select' ||
    step.kind === 'extend' ||
    step.kind === 'without' ||
    step.kind === 'rename' ||
    step.kind === 'qualify'
  );
}

function rightBranchOperatorAfterStaticUnionReason(
  collection: RightBranchPlanCollection,
  operator: string
): string | undefined {
  return collection.staticUnion === undefined
    ? undefined
    : `${operator} after terminal union is not supported`;
}

function collectRightBranchUnionPlan(
  inputs: readonly QueryData[],
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection,
  options: IncrementalMaterializationPlanOptions
): RightBranchPlan | string {
  if (inputs.length < 2) {
    return 'union requires one supported relation branch and static constRows branches';
  }
  if (collection.staticUnion !== undefined) {
    return 'nested terminal union is not supported';
  }

  const split = splitStaticUnionInputs(inputs, 'right branch union', options);
  if (typeof split === 'string') {
    return split;
  }

  const root = collectRightBranchPlanInternal(split.dynamicInput, steps, collection, options);
  if (typeof root === 'string') {
    return `union dynamic branch is not supported: ${root}`;
  }
  if (collection.staticUnion !== undefined) {
    return 'nested terminal union is not supported';
  }

  collection.staticUnion = {
    kind: 'staticUnion',
    ...optionalBeforeStaticUnionRows(split.beforeRows),
    rows: split.afterRows
  };
  return rightBranchPlan({ ...root, shape: mergeShapes(root.shape, split.staticShape) }, collection);
}

function collectRightBranchIntersectionPlan(
  inputs: readonly QueryData[],
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection,
  options: IncrementalMaterializationPlanOptions
): RightBranchPlan | string {
  const [leftInput, ...rightInputs] = inputs;
  if (leftInput === undefined || rightInputs.length === 0) {
    return 'intersection requires one supported relation branch and static right branches';
  }

  const root = collectRightBranchPlanInternal(leftInput, steps, collection, options);
  if (typeof root === 'string') {
    return `intersection first branch is not supported: ${root}`;
  }
  const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'intersection');
  if (unionReason !== undefined) return unionReason;
  if (collection.ordered !== undefined) {
    return 'intersection after order/window is not supported';
  }
  if (collection.aggregate !== undefined) {
    return 'intersection after aggregate is not supported';
  }

  const rightRows = collectStaticSetRows(rightInputs, 'intersection', options);
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'intersection', rightRows });
  return rightBranchPlan(root, collection);
}

function collectRightBranchDifferencePlan(
  leftInput: QueryData,
  rightInput: QueryData,
  steps: IncrementalBranchStep[],
  collection: RightBranchPlanCollection,
  options: IncrementalMaterializationPlanOptions
): RightBranchPlan | string {
  const root = collectRightBranchPlanInternal(leftInput, steps, collection, options);
  if (typeof root === 'string') {
    return `difference left branch is not supported: ${root}`;
  }
  const unionReason = rightBranchOperatorAfterStaticUnionReason(collection, 'difference');
  if (unionReason !== undefined) return unionReason;
  if (collection.ordered !== undefined) {
    return 'difference after order/window is not supported';
  }
  if (collection.aggregate !== undefined) {
    return 'difference after aggregate is not supported';
  }

  const rightRows = collectStaticSetRows([rightInput], 'difference', options);
  if (typeof rightRows === 'string') {
    return rightRows;
  }

  steps.push({ kind: 'setFilter', op: 'difference', rightRows });
  return rightBranchPlan(root, collection);
}

function branchPlan(plan: RightBranchPlan): IncrementalBranchPlan {
  return {
    relation: plan.relation,
    alias: plan.alias,
    root: plan.root,
    steps: plan.steps,
    ...optionalBranchAggregateStep(plan.aggregate),
    ...optionalBranchPostAggregateSteps(plan.postAggregateSteps),
    ...optionalImmutableOrderedStep(plan.ordered),
    ...optionalBranchStaticUnionStep(plan.staticUnion)
  };
}

function rightBranchPlan(
  plan: Omit<RightBranchPlan, 'ordered'> & { readonly ordered?: IncrementalOrderedStep },
  collection: RightBranchPlanCollection
): RightBranchPlan {
  return {
    ...plan,
    ...optionalBranchAggregateStep(collection.aggregate),
    ...optionalBranchPostAggregateSteps(collection.postAggregateSteps),
    ...optionalOrderedStep(collection.ordered),
    ...optionalBranchStaticUnionStep(collection.staticUnion)
  };
}

function planRelationNames(root: RootPlan, steps: readonly IncrementalStep[]): readonly string[] {
  const names = new Set<string>([root.relation]);
  for (const step of steps) {
    if (step.kind === 'join' || step.kind === 'subquery') {
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

function rootDependencySteps(plan: IncrementalMaterializationPlan): readonly IncrementalRootDependencyStep[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }
  return plan.steps.filter((step): step is IncrementalRootDependencyStep =>
    step.kind === 'join' || step.kind === 'subquery'
  );
}

function rootDependencyStepsBeforeAggregate(
  plan: IncrementalMaterializationPlan
): readonly IncrementalRootDependencyStep[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }

  const aggregateIndex = plan.steps.findIndex((step) => step.kind === 'aggregate');
  const steps = aggregateIndex === -1 ? plan.steps : plan.steps.slice(0, aggregateIndex);
  return steps.filter((step): step is IncrementalRootDependencyStep =>
    step.kind === 'join' || step.kind === 'subquery'
  );
}

function rootDependencyStepsAfterAggregate(
  plan: IncrementalMaterializationPlan
): readonly IncrementalJoinStep[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }

  const aggregateIndex = plan.steps.findIndex((step) => step.kind === 'aggregate');
  if (aggregateIndex === -1) {
    return [];
  }

  return plan.steps.slice(aggregateIndex + 1).filter((step): step is IncrementalJoinStep =>
    step.kind === 'join'
  );
}

function subquerySteps(plan: IncrementalMaterializationPlan): readonly IncrementalSubqueryStep[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }
  return plan.steps.filter((step): step is IncrementalSubqueryStep => step.kind === 'subquery');
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

function relationPostStepsForPlan(plan: IncrementalMaterializationPlan): readonly IncrementalRelationPostStep[] {
  return plan.kind === 'singleRoot' ? plan.relationPostSteps ?? [] : [];
}

function hasAggregateStep(steps: readonly IncrementalStep[]): boolean {
  return steps.some((step) => step.kind === 'aggregate');
}

function stepsAfterAggregate(
  plan: IncrementalMaterializationPlan
): readonly IncrementalPostAggregateStep[] {
  if (plan.kind !== 'singleRoot') {
    return [];
  }

  const aggregateIndex = plan.steps.findIndex((step) => step.kind === 'aggregate');
  if (aggregateIndex === -1) {
    return [];
  }

  return plan.steps.slice(aggregateIndex + 1).filter((
    step
  ): step is IncrementalPostAggregateStep =>
    step.kind !== 'subquery' && step.kind !== 'aggregate'
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
  if (next.relationPost !== undefined || previous.relationPost !== undefined) {
    return relationPostRowReport(plan, previous, next, changedRootKeys, changedGroupKeys);
  }

  if (next.ordered !== undefined || previous.ordered !== undefined) {
    return orderedRowReport(plan, previous, next, changedRootKeys, changedGroupKeys);
  }

  if (next.aggregate !== undefined || previous.aggregate !== undefined) {
    return aggregateRowReport(plan, previous.aggregate, next.aggregate, changedGroupKeys);
  }

  return rootRowReport(plan, previous, next, changedRootKeys);
}

function relationPostRowReport<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalMaterializationState<Row>,
  next: IncrementalMaterializationState<Row>,
  changedRootKeys: ReadonlySet<string>,
  changedGroupKeys: ReadonlySet<string>
): IncrementalRowReport<Row> {
  const options = rowDiffOptionsForPlan(plan);
  const beforeRows = rowsFromIncrementalState(previous);
  const afterRows = rowsFromIncrementalState(next);
  const diff = diffMaterializationRows(beforeRows, afterRows, options);
  const rowChanges = [
    ...diff.changes,
    ...(next.ordered !== undefined || previous.ordered !== undefined
      ? orderedMoveRowChanges(beforeRows, afterRows, options, diff.changes)
      : [])
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
  const rowBatches = branchOrderedJoinStatePresent(previous) || branchOrderedJoinStatePresent(next)
    ? branchOrderedFullRowBatches(previous, next)
    : changedKeys.map((rootKey) => {
      const before = (previous.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
      const after = (next.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
      return {
        beforeRows: before,
        afterRows: after,
        ...insertAnchorsForRoot(next, rootKey, after, options)
      };
    }).filter((batch) => batch.beforeRows.length > 0 || batch.afterRows.length > 0);

  return {
    rowChanges: diff.changes,
    addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    rowBatches,
    changedRootKeys: changedKeys,
    changedGroupKeys: [],
    diagnostics: diff.diagnostics
  };
}

function branchOrderedFullRowBatches<Row>(
  previous: IncrementalMaterializationState<Row>,
  next: IncrementalMaterializationState<Row>
): readonly IncrementalRowBatch<Row>[] {
  const beforeRows = previous.rootKeys.flatMap((rootKey) => previous.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
  const afterRows = next.rootKeys.flatMap((rootKey) => next.outputsByRootKey.get(rootKey) ?? []) as readonly Row[];
  return materializationStableKey(beforeRows) === materializationStableKey(afterRows)
    ? []
    : [{ beforeRows, afterRows }];
}

function branchOrderedJoinStatePresent<Row>(state: IncrementalMaterializationState<Row>): boolean {
  return state.joinStates.some(joinStateHasBranchOrdered);
}

function joinStateHasBranchOrdered(state: IncrementalJoinState): boolean {
  return state.branchOrdered !== undefined || (state.nestedBranchJoinStates ?? []).some(joinStateHasBranchOrdered);
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
      return group === undefined ? [] : group.rows;
    });
  const afterRows = nextGroupKeys
    .filter((groupKey) => changedGroupKeys.has(groupKey))
    .flatMap((groupKey) => {
      const group = next?.groupsByKey.get(groupKey);
      return group === undefined ? [] : group.rows;
    });
  const diff = diffMaterializationRows(beforeRows, afterRows, options);

  return {
    rowChanges: diff.changes,
    addedRows: diff.changes.flatMap((item) => item.kind === 'added' ? [item.row] : []),
    removedRows: diff.changes.flatMap((item) => item.kind === 'removed' ? [item.row] : []),
    rowBatches: changedKeys.map((groupKey) => {
      const beforeGroup = previous?.groupsByKey.get(groupKey);
      const afterGroup = next?.groupsByKey.get(groupKey);
      const before = beforeGroup === undefined ? [] : beforeGroup.rows;
      const after = afterGroup === undefined ? [] : afterGroup.rows;
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
    const row = group?.rows.at(-1);
    if (row !== undefined) {
      return { insertAfterKey: materializationRowKey(row, options) };
    }
  }

  for (let index = groupIndex + 1; index < aggregate.groupKeys.length; index += 1) {
    const group = aggregate.groupsByKey.get(aggregate.groupKeys[index] ?? '');
    const row = group?.rows[0];
    if (row !== undefined) {
      return { insertBeforeKey: materializationRowKey(row, options) };
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
  const subqueryStateByKey = subqueryEvaluationMap(plan, joinStateById);
  for (const step of plan.steps) {
    if (step.kind === 'aggregate') {
      break;
    } else if (step.kind === 'subquery') {
      joinValuesByStep.set(step.id, rows.map((row) => exprValue(row, step.left, env, subqueryStateByKey)));
    } else if (step.kind === 'join') {
      const joinState = joinStateById.get(step.id);
      if (joinState === undefined) {
        return {
          supported: false,
          reason: `incremental join state ${step.id} is missing; snapshot recompute is required`
        };
      }
      joinValuesByStep.set(step.id, rows.map((row) => exprValue(row, step.left, env, subqueryStateByKey)));
      rows = evaluateJoinStep(rows, step, joinState, env);
    } else if (step.kind === 'expand') {
      const expanded = evaluateExpandStep(rows, step, env, subqueryStateByKey);
      if (!expanded.supported) {
        return {
          supported: false,
          reason: expanded.reason
        };
      }
      rows = expanded.rows;
    } else {
      rows = evaluateStep(rows, step, env, subqueryStateByKey);
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
  env: Readonly<Record<string, unknown>>,
  subqueryStateByKey: ReadonlyMap<string, SubqueryEvaluationState> = new Map()
): readonly Record<string, unknown>[] {
  switch (step.kind) {
    case 'where':
      return rows.filter((row) => matchesPredicate(row, step.predicate, env, subqueryStateByKey));
    case 'select':
      return rows.map((row) => projectRow(row, step.projection, env, subqueryStateByKey));
    case 'extend':
      return rows.map((row) => ({ ...row, ...projectRow(row, step.projection, env, subqueryStateByKey) }));
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
  env: Readonly<Record<string, unknown>>,
  subqueryStateByKey: ReadonlyMap<string, SubqueryEvaluationState> = new Map()
):
  | { readonly supported: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly supported: false; readonly reason: string } {
  const output: Record<string, unknown>[] = [];

  for (const row of rows) {
    const value = exprValue(row, step.collection, env, subqueryStateByKey);
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
    case 'sort': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: sortStaticRows(input.rows, data.order, env) }
        : input;
    }
    case 'limit': {
      const input = evaluateStaticRows(data.input, env);
      if (!input.supported) return input;
      const offset = data.offset ?? 0;
      return { supported: true, rows: input.rows.slice(offset, offset + data.count) };
    }
    case 'sortLimit': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: sortStaticRows(input.rows, data.order, env).slice(0, data.count) }
        : input;
    }
    case 'aggregate': {
      const input = evaluateStaticRows(data.input, env);
      return input.supported
        ? { supported: true, rows: aggregateStaticRows(input.rows, data.groupBy, data.aggregates, env) }
        : input;
    }
    case 'from':
    case 'lookup':
    case 'join':
      return { supported: false, reason: staticRowsRelationReason };
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
  env: Readonly<Record<string, unknown>>,
  subqueryStateByKey: ReadonlyMap<string, SubqueryEvaluationState> = new Map()
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([field, item]) => [
    field,
    exprValue(row, projectionExpr(item), env, subqueryStateByKey)
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

function sortStaticRows(
  rows: readonly Record<string, unknown>[],
  order: readonly SortData[],
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  return rows.map((row, index) => ({
    row,
    index,
    values: order.map((item) => exprValue(row, item.expr, env))
  })).sort((left, right) => {
    for (let index = 0; index < order.length; index += 1) {
      const item = order[index] as SortData;
      const comparison = compareSortValues(
        left.values[index],
        right.values[index],
        item.direction,
        item.nulls
      );
      if (comparison !== 0) {
        return comparison;
      }
    }
    return left.index - right.index;
  }).map((item) => item.row);
}

function aggregateStaticRows(
  rows: readonly Record<string, unknown>[],
  groupBy: ProjectionData,
  aggregates: ProjectionData,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  const groups = new Map<string, { readonly group: Record<string, unknown>; readonly rows: Record<string, unknown>[] }>();

  for (const row of rows) {
    const group = projectRow(row, groupBy, env);
    const key = stableKey(group);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { group, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  if (groups.size === 0 && Object.keys(groupBy).length === 0) {
    groups.set(stableKey({}), { group: {}, rows: [] });
  }

  return Array.from(groups.values()).map(({ group, rows: groupRows }) =>
    evaluateAggregateRow({ kind: 'aggregate', groupBy, aggregates }, group, groupRows, env)
  );
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
  if (state.relationPost !== undefined) {
    return state.relationPost.rows;
  }

  return baseRowsFromIncrementalState(state);
}

function baseRowsFromIncrementalState<Row>(state: IncrementalMaterializationState<Row>): readonly Row[] {
  if (state.ordered !== undefined) {
    return state.ordered.rows;
  }

  if (state.aggregate !== undefined) {
    return state.aggregate.groupKeys.flatMap((key) => {
      const group = state.aggregate?.groupsByKey.get(key);
      return group === undefined ? [] : group.rows;
    });
  }

  return state.rootKeys.flatMap((key) => state.outputsByRootKey.get(key) ?? []) as readonly Row[];
}

function buildRelationPostState<Row>(
  plan: IncrementalMaterializationPlan,
  state: IncrementalMaterializationState<Row>
): IncrementalRelationPostState<Row> | undefined {
  const steps = relationPostStepsForPlan(plan);
  if (steps.length === 0) {
    return undefined;
  }

  return {
    rows: applyRelationPostSteps(baseRowsFromIncrementalState(state), steps) as readonly Row[]
  };
}

function applyRelationPostSteps(
  rows: readonly unknown[],
  steps: readonly IncrementalRelationPostStep[]
): readonly Record<string, unknown>[] {
  let output = rows as readonly Record<string, unknown>[];
  for (const step of steps) {
    switch (step.kind) {
      case 'staticUnion':
        output = setUnionRows([step.beforeRows ?? [], output, step.rows]);
        break;
    }
  }
  return output;
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

  return finalizeOrderedState(ordered, entriesByOwnerKey, ownerKeys);
}

function maintainOrderedState<Row>(
  plan: IncrementalMaterializationPlan,
  previous: IncrementalOrderedState<Row>,
  state: IncrementalMaterializationState<Row>,
  changedOwnerKeys: ReadonlySet<string>,
  env: Readonly<Record<string, unknown>>
): OrderedStateResult<Row> {
  const ordered = orderedStep(plan);
  if (ordered === undefined) {
    return {
      supported: false,
      reason: 'ordered step is missing from ordered incremental plan'
    };
  }

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

  return finalizeOrderedState(ordered, entriesByOwnerKey, ownerKeys);
}

function finalizeOrderedState<Row>(
  ordered: IncrementalOrderedStep,
  entriesByOwnerKey: ReadonlyMap<string, readonly IncrementalOrderedEntry<Row>[]>,
  ownerKeys: readonly string[]
): OrderedStateResult<Row> {
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
    return group === undefined ? [] : group.rows;
  }

  return state.outputsByRootKey.get(ownerKey) ?? [];
}

function buildBranchOrderedState(
  branch: IncrementalBranchPlan,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  env: Readonly<Record<string, unknown>>
): OrderedStateResult<Record<string, unknown>> | undefined {
  if (branch.ordered === undefined) {
    return undefined;
  }

  const entriesByOwnerKey = new Map<string, readonly IncrementalOrderedEntry<Record<string, unknown>>[]>();
  for (const relationKey of relationKeys) {
    const entries = orderedEntriesForBranchOwner(branch.ordered, relationKey, rowsByRelationKey, env);
    if (!entries.supported) {
      return entries;
    }
    if (entries.entries.length > 0) {
      entriesByOwnerKey.set(relationKey, entries.entries);
    }
  }

  return finalizeOrderedState(branch.ordered, entriesByOwnerKey, relationKeys);
}

function maintainBranchOrderedState(
  branch: IncrementalBranchPlan,
  previous: IncrementalOrderedState<Record<string, unknown>> | undefined,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  changedRelationKeys: ReadonlySet<string>,
  env: Readonly<Record<string, unknown>>
): OrderedStateResult<Record<string, unknown>> | undefined {
  if (branch.ordered === undefined) {
    return undefined;
  }
  if (previous === undefined) {
    return {
      supported: false,
      reason: 'right branch ordered state is missing; snapshot recompute is required'
    };
  }

  const relationKeySet = new Set(relationKeys);
  const entriesByOwnerKey = new Map(previous.entriesByOwnerKey);
  for (const ownerKey of entriesByOwnerKey.keys()) {
    if (!relationKeySet.has(ownerKey)) {
      entriesByOwnerKey.delete(ownerKey);
    }
  }

  for (const relationKey of changedRelationKeys) {
    if (!relationKeySet.has(relationKey)) {
      entriesByOwnerKey.delete(relationKey);
      continue;
    }

    const entries = orderedEntriesForBranchOwner(branch.ordered, relationKey, rowsByRelationKey, env);
    if (!entries.supported) {
      return entries;
    }
    if (entries.entries.length === 0) {
      entriesByOwnerKey.delete(relationKey);
    } else {
      entriesByOwnerKey.set(relationKey, entries.entries);
    }
  }

  return finalizeOrderedState(branch.ordered, entriesByOwnerKey, relationKeys);
}

function orderedEntriesForBranchOwner(
  ordered: IncrementalOrderedStep,
  ownerKey: string,
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  env: Readonly<Record<string, unknown>>
):
  | { readonly supported: true; readonly entries: readonly IncrementalOrderedEntry<Record<string, unknown>>[] }
  | { readonly supported: false; readonly reason: string } {
  const entries: IncrementalOrderedEntry<Record<string, unknown>>[] = [];
  for (const [rowIndex, sourceRow] of (rowsByRelationKey.get(ownerKey) ?? []).entries()) {
    const postOrderRows = evaluatePostOrderRows(ordered, sourceRow, env);
    if (postOrderRows.length !== 1) {
      return {
        supported: false,
        reason: 'right branch post-order projection produced an unexpected row count; snapshot recompute is required'
      };
    }

    const key = stableKey([ownerKey, rowIndex]);
    entries.push({
      key,
      ownerKey,
      rowIndex,
      sortValues: ordered.order.map((item) => exprValue(sourceRow, item.expr, env)),
      row: postOrderRows[0] as Record<string, unknown>,
      rowKey: key
    });
  }
  return { supported: true, entries };
}

function buildBranchAggregateState(
  branch: IncrementalBranchPlan,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  env: Readonly<Record<string, unknown>>
): AggregateStateResult<Record<string, unknown>> | undefined {
  if (branch.aggregate === undefined) {
    return undefined;
  }

  const groupKeysByRootKey = new Map<string, readonly string[]>();
  for (const relationKey of relationKeys) {
    const groupKeys = aggregateGroupKeysForRows(branch.aggregate, rowsByRelationKey.get(relationKey) ?? [], env);
    if (groupKeys.length > 0) {
      groupKeysByRootKey.set(relationKey, groupKeys);
    }
  }

  const rootKeysByGroupKey = buildRootKeysByGroupKey(relationKeys, groupKeysByRootKey);
  const groupKeys = aggregateGroupOrder(branch.aggregate, indexKeys(relationKeys), rootKeysByGroupKey);
  const groupsByKey = new Map<string, IncrementalAggregateGroupState<Record<string, unknown>>>();
  for (const groupKey of groupKeys) {
    const group = recomputeBranchAggregateGroup(
      branch,
      groupKey,
      rootKeysByGroupKey.get(groupKey) ?? [],
      rowsByRelationKey,
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

function maintainBranchAggregateState(
  branch: IncrementalBranchPlan,
  previous: IncrementalAggregateState<Record<string, unknown>>,
  relationKeys: readonly string[],
  relationIndexByKey: ReadonlyMap<string, number>,
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  groupKeysByRootKey: ReadonlyMap<string, readonly string[]>,
  rootKeysByGroupKey: ReadonlyMap<string, readonly string[]>,
  affectedGroupKeys: ReadonlySet<string>,
  env: Readonly<Record<string, unknown>>
): AggregateStateResult<Record<string, unknown>> {
  if (branch.aggregate === undefined) {
    return {
      supported: false,
      reason: 'right branch aggregate step is missing from branch aggregate state'
    };
  }

  const groupKeys = aggregateGroupOrder(branch.aggregate, relationIndexByKey, rootKeysByGroupKey);
  const groupsByKey = new Map(previous.groupsByKey);
  for (const groupKey of affectedGroupKeys) {
    const group = recomputeBranchAggregateGroup(
      branch,
      groupKey,
      rootKeysByGroupKey.get(groupKey) ?? [],
      rowsByRelationKey,
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

  if (isUngroupedAggregate(branch.aggregate)) {
    const emptyKey = emptyGroupKey();
    if (!groupsByKey.has(emptyKey)) {
      const group = recomputeBranchAggregateGroup(branch, emptyKey, relationKeys, rowsByRelationKey, env);
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

function recomputeBranchAggregateGroup(
  branch: IncrementalBranchPlan,
  groupKey: string,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  env: Readonly<Record<string, unknown>>
):
  | {
      readonly supported: true;
      readonly state: IncrementalAggregateGroupState<Record<string, unknown>> | undefined;
    }
  | { readonly supported: false; readonly reason: string } {
  const aggregate = branch.aggregate;
  if (aggregate === undefined) {
    return {
      supported: false,
      reason: 'right branch aggregate step is missing from branch aggregate state'
    };
  }

  const rows: Record<string, unknown>[] = [];
  let group: Record<string, unknown> | undefined;
  for (const relationKey of relationKeys) {
    for (const row of rowsByRelationKey.get(relationKey) ?? []) {
      const rowGroup = projectRow(row, aggregate.groupBy, env);
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
  const postAggregateRows = evaluateBranchPostAggregateRows(branch, aggregateRow, env);
  if (!postAggregateRows.supported) {
    return postAggregateRows;
  }

  return {
    supported: true,
    state: {
      group: group ?? {},
      rowCount: rows.length,
      rawRow: aggregateRow,
      rows: postAggregateRows.rows
    }
  };
}

function evaluateBranchPostAggregateRows(
  branch: IncrementalBranchPlan,
  row: Record<string, unknown>,
  env: Readonly<Record<string, unknown>>
):
  | { readonly supported: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly supported: false; readonly reason: string } {
  let rows: readonly Record<string, unknown>[] = [row];
  for (const step of branch.postAggregateSteps ?? []) {
    rows = evaluateStep(rows, step, env);
    if (rows.length === 0) {
      return { supported: true, rows: [] };
    }
  }
  return { supported: true, rows };
}

function aggregateRowsForKeys<Row>(
  aggregate: IncrementalAggregateState<Row> | undefined,
  groupKeys: Iterable<string>
): readonly Row[] {
  if (aggregate === undefined) {
    return [];
  }

  const rows: Row[] = [];
  for (const groupKey of groupKeys) {
    const group = aggregate.groupsByKey.get(groupKey);
    if (group !== undefined) {
      rows.push(...group.rows);
    }
  }
  return rows;
}

function rowsFromAggregateState<Row>(aggregate: IncrementalAggregateState<Row>): readonly Row[] {
  return aggregate.groupKeys.flatMap((key) => aggregate.groupsByKey.get(key)?.rows ?? []);
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
  env: Readonly<Record<string, unknown>>,
  joinStateById: ReadonlyMap<string, IncrementalJoinState>
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
      env,
      joinStateById
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
  env: Readonly<Record<string, unknown>>,
  joinStateById: ReadonlyMap<string, IncrementalJoinState>
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
      env,
      joinStateById
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
      const group = recomputeAggregateGroup<Row>(plan, emptyKey, rootKeys, outputsByRootKey, env, joinStateById);
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
  env: Readonly<Record<string, unknown>>,
  joinStateById: ReadonlyMap<string, IncrementalJoinState>
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
  const postAggregateRows = evaluatePostAggregateRows(plan, aggregateRow, env, joinStateById);
  if (!postAggregateRows.supported) {
    return postAggregateRows;
  }

  return {
    supported: true,
    state: {
      group: group ?? {},
      rowCount: rows.length,
      rawRow: aggregateRow,
      rows: postAggregateRows.rows as readonly Row[]
    }
  };
}

function withPostAggregateJoinValues<Row>(
  plan: IncrementalMaterializationPlan,
  joinStates: readonly IncrementalJoinState[],
  aggregate: IncrementalAggregateState<Row>,
  env: Readonly<Record<string, unknown>>
): JoinStateBuildResult {
  const postAggregateJoinStepIds = new Set(rootDependencyStepsAfterAggregate(plan).map((step) => step.id));
  if (postAggregateJoinStepIds.size === 0) {
    return { supported: true, states: joinStates };
  }

  const joinStateById = joinStateMap(joinStates);
  const groupValuesByStep = new Map<string, Map<string, readonly unknown[]>>();
  for (const groupKey of aggregate.groupKeys) {
    const group = aggregate.groupsByKey.get(groupKey);
    if (group === undefined) {
      continue;
    }

    const evaluated = evaluatePostAggregateRows(plan, group.rawRow, env, joinStateById);
    if (!evaluated.supported) {
      return evaluated;
    }
    recordRootJoinValues(groupValuesByStep, groupKey, evaluated.joinValuesByStep);
  }

  return {
    supported: true,
    states: joinStates.map((state) =>
      postAggregateJoinStepIds.has(state.id)
        ? withRootJoinValues(state, groupValuesByStep.get(state.id) ?? new Map())
        : state
    )
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
  env: Readonly<Record<string, unknown>>,
  joinStateById: ReadonlyMap<string, IncrementalJoinState>
):
  | {
      readonly supported: true;
      readonly rows: readonly Record<string, unknown>[];
      readonly joinValuesByStep: ReadonlyMap<string, readonly unknown[]>;
    }
  | { readonly supported: false; readonly reason: string } {
  let rows: readonly Record<string, unknown>[] = [row];
  const joinValuesByStep = new Map<string, readonly unknown[]>();
  for (const step of stepsAfterAggregate(plan)) {
    if (step.kind === 'join') {
      const joinState = joinStateById.get(step.id);
      if (joinState === undefined) {
        return {
          supported: false,
          reason: `incremental join state ${step.id} is missing; snapshot recompute is required`
        };
      }
      joinValuesByStep.set(step.id, rows.map((item) => exprValue(item, step.left, env)));
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

  for (const step of rootDependencySteps(plan)) {
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
    const branchOrdered = buildBranchOrderedState(step.right, relationKeys, rowsByRelationKey, env);
    if (branchOrdered !== undefined && !branchOrdered.supported) {
      return {
        supported: false,
        reason: branchOrdered.reason
      };
    }
    const branchAggregate = buildBranchAggregateState(step.right, relationKeys, rowsByRelationKey, env);
    if (branchAggregate !== undefined && !branchAggregate.supported) {
      return {
        supported: false,
        reason: branchAggregate.reason
      };
    }
    states.push({
      id: step.id,
      relation: step.right.relation,
      relationKeys,
      relationIndexByKey: indexKeys(relationKeys),
      relationRowsByKey,
      rowsByRelationKey,
      indexByValue: buildRightIndex(
        step,
        relationKeys,
        rowsByRelationKey,
        env,
        branchOrdered?.state,
        branchAggregate?.state
      ),
      rootValuesByKey: new Map(),
      rootKeysByValue: new Map(),
      ...(branchAggregate === undefined ? {} : { branchAggregate: branchAggregate.state }),
      ...(branchOrdered === undefined ? {} : { branchOrdered: branchOrdered.state }),
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

    const branchOrdered = buildBranchOrderedState(step.right, relationKeys, rowsByRelationKey, env);
    if (branchOrdered !== undefined && !branchOrdered.supported) {
      return {
        supported: false,
        reason: branchOrdered.reason
      };
    }
    const branchAggregate = buildBranchAggregateState(step.right, relationKeys, rowsByRelationKey, env);
    if (branchAggregate !== undefined && !branchAggregate.supported) {
      return {
        supported: false,
        reason: branchAggregate.reason
      };
    }
    states.push({
      id: step.id,
      relation: step.right.relation,
      relationKeys,
      relationIndexByKey: indexKeys(relationKeys),
      relationRowsByKey,
      rowsByRelationKey,
      indexByValue: buildRightIndex(
        step,
        relationKeys,
        rowsByRelationKey,
        env,
        branchOrdered?.state,
        branchAggregate?.state
      ),
      rootValuesByKey: new Map(),
      rootKeysByValue: new Map(),
      ...(branchAggregate === undefined ? {} : { branchAggregate: branchAggregate.state }),
      ...(branchOrdered === undefined ? {} : { branchOrdered: branchOrdered.state })
    });
  }

  return { supported: true, states };
}

function buildRightIndex(
  step: IncrementalIndexLikeStep,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  env: Readonly<Record<string, unknown>>,
  branchOrdered?: IncrementalOrderedState<Record<string, unknown>>,
  branchAggregate?: IncrementalAggregateState<Record<string, unknown>>
): ReadonlyMap<string, readonly IndexedRightRow[]> {
  const index = new Map<string, IndexedRightRow[]>();
  const rows = rightIndexRows(step.right, relationKeys, rowsByRelationKey, branchOrdered, branchAggregate);

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

  return index;
}

function rightIndexRows(
  branch: IncrementalBranchPlan,
  relationKeys: readonly string[],
  rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  branchOrdered?: IncrementalOrderedState<Record<string, unknown>>,
  branchAggregate?: IncrementalAggregateState<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  const rows = branchAggregate === undefined
    ? branchOrdered === undefined
      ? relationKeys.flatMap((relationKey) => rowsByRelationKey.get(relationKey) ?? [])
      : branchOrdered.rows
    : rowsFromAggregateState(branchAggregate);

  return branch.staticUnion === undefined
    ? rows
    : setUnionRows([branch.staticUnion.beforeRows ?? [], rows, branch.staticUnion.rows]);
}

function joinStateMap(states: readonly IncrementalJoinState[]): ReadonlyMap<string, IncrementalJoinState> {
  return new Map(states.map((state) => [state.id, state]));
}

function subqueryEvaluationMap(
  plan: IncrementalMaterializationPlan,
  stateById: ReadonlyMap<string, IncrementalJoinState>
): ReadonlyMap<string, SubqueryEvaluationState> {
  return new Map(subquerySteps(plan).flatMap((step) => {
    const state = stateById.get(step.id);
    return state === undefined ? [] : [[step.exprKey, { step, state }] as const];
  }));
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
  step: IncrementalRootDependencyStep,
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
  step: IncrementalRootDependencyStep,
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
  const branchAggregate = step.right.aggregate;
  if (step.right.ordered === undefined && state.branchOrdered !== undefined) {
    return {
      supported: false,
      reason: 'right branch ordered state is present for a non-ordered branch; snapshot recompute is required'
    };
  }
  if (step.right.ordered !== undefined && state.branchOrdered === undefined) {
    return {
      supported: false,
      reason: 'right branch ordered state is missing; snapshot recompute is required'
    };
  }
  if (branchAggregate === undefined && state.branchAggregate !== undefined) {
    return {
      supported: false,
      reason: 'right branch aggregate state is present for a non-aggregate branch; snapshot recompute is required'
    };
  }
  if (branchAggregate !== undefined && state.branchAggregate === undefined) {
    return {
      supported: false,
      reason: 'right branch aggregate state is missing; snapshot recompute is required'
    };
  }

  const affectedValues: unknown[] = state.branchOrdered === undefined
    ? []
    : state.branchOrdered.rows.map((row) => exprValue(row, step.rightExpr, env));
  const groupKeysByRelationKey = state.branchAggregate === undefined
    ? undefined
    : new Map(state.branchAggregate.groupKeysByRootKey);
  const affectedAggregateGroupKeys = new Set<string>();
  const nestedRootJoinIndexes = state.nestedBranchJoinStates === undefined
    ? undefined
    : mutableRootJoinIndexes(state.nestedBranchJoinStates);
  const nestedJoinStateById = joinStateMap(state.nestedBranchJoinStates ?? []);

  for (const relationKey of relationKeysToEvaluate) {
    const previousRows = rowsByRelationKey.get(relationKey);
    if (previousRows !== undefined) {
      if (state.branchAggregate === undefined) {
        affectedValues.push(...previousRows.map((row) => exprValue(row, step.rightExpr, env)));
      } else {
        const previousGroupKeys = groupKeysByRelationKey?.get(relationKey);
        recordAggregateGroupKeys(affectedAggregateGroupKeys, previousGroupKeys);
        groupKeysByRelationKey?.delete(relationKey);
      }
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
    if (branchAggregate === undefined) {
      affectedValues.push(...evaluated.rows.map((row) => exprValue(row, step.rightExpr, env)));
    } else if (groupKeysByRelationKey !== undefined) {
      const nextGroupKeys = aggregateGroupKeysForRows(branchAggregate, evaluated.rows, env);
      recordAggregateGroupKeys(affectedAggregateGroupKeys, nextGroupKeys);
      if (nextGroupKeys.length > 0) {
        groupKeysByRelationKey.set(relationKey, nextGroupKeys);
      }
    }
    if (nestedRootJoinIndexes !== undefined) {
      addRootJoinValues(nestedRootJoinIndexes, relationKey, evaluated.joinValuesByStep);
    }
  }

  const nextNestedBranchJoinStates = state.nestedBranchJoinStates === undefined
    ? undefined
    : state.nestedBranchJoinStates.map((nestedState) =>
      withRootJoinIndex(nestedState, nestedRootJoinIndexes?.get(nestedState.id))
    );
  const branchOrdered = maintainBranchOrderedState(
    step.right,
    state.branchOrdered,
    state.relationKeys,
    rowsByRelationKey,
    relationKeysToEvaluate,
    env
  );
  if (branchOrdered !== undefined && !branchOrdered.supported) {
    return {
      supported: false,
      reason: branchOrdered.reason
    };
  }
  if (branchOrdered !== undefined) {
    affectedValues.push(...branchOrdered.state.rows.map((row) => exprValue(row, step.rightExpr, env)));
  }
  if (state.branchAggregate !== undefined) {
    affectedValues.push(...aggregateRowsForKeys(state.branchAggregate, affectedAggregateGroupKeys)
      .map((row) => exprValue(row, step.rightExpr, env)));
  }
  const nextBranchAggregate = branchAggregate === undefined
    ? undefined
    : maintainBranchAggregateState(
      step.right,
      state.branchAggregate as IncrementalAggregateState<Record<string, unknown>>,
      state.relationKeys,
      relationIndexByKeyForState(state),
      rowsByRelationKey,
      groupKeysByRelationKey ?? new Map(),
      buildRootKeysByGroupKey(state.relationKeys, groupKeysByRelationKey ?? new Map()),
      affectedAggregateGroupKeys,
      env
    );
  if (nextBranchAggregate !== undefined && !nextBranchAggregate.supported) {
    return {
      supported: false,
      reason: nextBranchAggregate.reason
    };
  }
  if (nextBranchAggregate !== undefined) {
    affectedValues.push(...aggregateRowsForKeys(nextBranchAggregate.state, affectedAggregateGroupKeys)
      .map((row) => exprValue(row, step.rightExpr, env)));
  }

  return {
    supported: true,
    state: {
      ...state,
      rowsByRelationKey,
      indexByValue: buildRightIndex(
        step,
        state.relationKeys,
        rowsByRelationKey,
        env,
        branchOrdered?.state,
        nextBranchAggregate?.state
      ),
      ...optionalBranchAggregateState(nextBranchAggregate?.state),
      ...optionalBranchOrderedState(branchOrdered?.state),
      ...(nextNestedBranchJoinStates === undefined ? {} : { nestedBranchJoinStates: nextNestedBranchJoinStates })
    },
    affectedRootKeys: rootKeysMatchingJoinValues(state, affectedValues)
  };
}

function applyRightRelationChanges(
  step: IncrementalIndexLikeStep,
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
  const branchAggregate = step.right.aggregate;
  if (step.right.ordered === undefined && state.branchOrdered !== undefined) {
    return {
      supported: false,
      reason: 'right branch ordered state is present for a non-ordered branch; snapshot recompute is required'
    };
  }
  if (step.right.ordered !== undefined && state.branchOrdered === undefined) {
    return {
      supported: false,
      reason: 'right branch ordered state is missing; snapshot recompute is required'
    };
  }
  if (branchAggregate === undefined && state.branchAggregate !== undefined) {
    return {
      supported: false,
      reason: 'right branch aggregate state is present for a non-aggregate branch; snapshot recompute is required'
    };
  }
  if (branchAggregate !== undefined && state.branchAggregate === undefined) {
    return {
      supported: false,
      reason: 'right branch aggregate state is missing; snapshot recompute is required'
    };
  }

  const indexByValue: Map<string, IndexedRightRow[]> = state.branchOrdered === undefined && state.branchAggregate === undefined
    ? mutableRightIndex(state.indexByValue)
    : new Map();
  const affectedValues: unknown[] = state.branchOrdered === undefined
    ? []
    : state.branchOrdered.rows.map((row) => exprValue(row, step.rightExpr, env));
  const groupKeysByRelationKey = state.branchAggregate === undefined
    ? undefined
    : new Map(state.branchAggregate.groupKeysByRootKey);
  const affectedAggregateGroupKeys = new Set<string>();
  const changedRelationKeys = new Set<string>();
  const nestedRootJoinIndexes = state.nestedBranchJoinStates === undefined
    ? undefined
    : mutableRootJoinIndexes(state.nestedBranchJoinStates);
  const nestedJoinStateById = joinStateMap(state.nestedBranchJoinStates ?? []);

  for (const change of changes) {
    const index = relationIndexByKey.get(change.key) ?? -1;
    const previousRows = rowsByRelationKey.get(change.key);
    changedRelationKeys.add(change.key);

    if (change.after === undefined) {
      if (index === -1 || previousRows === undefined) {
        return {
          supported: false,
          reason: `right relation delta removed missing key ${change.key}; snapshot recompute is required`
        };
      }

      if (state.branchAggregate === undefined) {
        affectedValues.push(...previousRows.map((row) => exprValue(row, step.rightExpr, env)));
      } else {
        const previousGroupKeys = groupKeysByRelationKey?.get(change.key);
        recordAggregateGroupKeys(affectedAggregateGroupKeys, previousGroupKeys);
        groupKeysByRelationKey?.delete(change.key);
      }
      if (state.branchOrdered === undefined && state.branchAggregate === undefined) {
        removeRightIndexRows(step, indexByValue, previousRows, env);
      }
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
      if (state.branchAggregate === undefined) {
        affectedValues.push(...previousRows.map((row) => exprValue(row, step.rightExpr, env)));
      } else {
        const previousGroupKeys = groupKeysByRelationKey?.get(change.key);
        recordAggregateGroupKeys(affectedAggregateGroupKeys, previousGroupKeys);
        groupKeysByRelationKey?.delete(change.key);
      }
      if (state.branchOrdered === undefined && state.branchAggregate === undefined) {
        removeRightIndexRows(step, indexByValue, previousRows, env);
      }
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
    if (branchAggregate === undefined) {
      affectedValues.push(...nextRows.map((row) => exprValue(row, step.rightExpr, env)));
    } else if (groupKeysByRelationKey !== undefined) {
      const nextGroupKeys = aggregateGroupKeysForRows(branchAggregate, nextRows, env);
      recordAggregateGroupKeys(affectedAggregateGroupKeys, nextGroupKeys);
      if (nextGroupKeys.length > 0) {
        groupKeysByRelationKey.set(change.key, nextGroupKeys);
      }
    }
    if (state.branchOrdered === undefined && state.branchAggregate === undefined) {
      addRightIndexRows(step, indexByValue, nextRows, env);
    }
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
  const branchOrdered = maintainBranchOrderedState(
    step.right,
    state.branchOrdered,
    compactRelationKeys,
    rowsByRelationKey,
    changedRelationKeys,
    env
  );
  if (branchOrdered !== undefined && !branchOrdered.supported) {
    return {
      supported: false,
      reason: branchOrdered.reason
    };
  }
  if (branchOrdered !== undefined) {
    affectedValues.push(...branchOrdered.state.rows.map((row) => exprValue(row, step.rightExpr, env)));
  }
  if (state.branchAggregate !== undefined) {
    affectedValues.push(...aggregateRowsForKeys(state.branchAggregate, affectedAggregateGroupKeys)
      .map((row) => exprValue(row, step.rightExpr, env)));
  }
  const compactRelationIndexByKey = indexKeys(compactRelationKeys);
  const nextBranchAggregate = branchAggregate === undefined
    ? undefined
    : maintainBranchAggregateState(
      step.right,
      state.branchAggregate as IncrementalAggregateState<Record<string, unknown>>,
      compactRelationKeys,
      compactRelationIndexByKey,
      rowsByRelationKey,
      groupKeysByRelationKey ?? new Map(),
      buildRootKeysByGroupKey(compactRelationKeys, groupKeysByRelationKey ?? new Map()),
      affectedAggregateGroupKeys,
      env
    );
  if (nextBranchAggregate !== undefined && !nextBranchAggregate.supported) {
    return {
      supported: false,
      reason: nextBranchAggregate.reason
    };
  }
  if (nextBranchAggregate !== undefined) {
    affectedValues.push(...aggregateRowsForKeys(nextBranchAggregate.state, affectedAggregateGroupKeys)
      .map((row) => exprValue(row, step.rightExpr, env)));
  }
  const nextIndexByValue = (
    branchOrdered !== undefined ||
    nextBranchAggregate !== undefined ||
    state.nestedBranchJoinStates !== undefined
  )
    ? buildRightIndex(
      step,
      compactRelationKeys,
      rowsByRelationKey,
      env,
      branchOrdered?.state,
      nextBranchAggregate?.state
    )
    : indexByValue;

  return {
    supported: true,
    state: {
      ...state,
      relationKeys: compactRelationKeys,
      relationIndexByKey: compactRelationIndexByKey,
      relationRowsByKey,
      rowsByRelationKey,
      indexByValue: nextIndexByValue,
      ...optionalBranchAggregateState(nextBranchAggregate?.state),
      ...optionalBranchOrderedState(branchOrdered?.state),
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
  step: IncrementalIndexLikeStep,
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
  step: IncrementalIndexLikeStep,
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

function optionalImmutableOrderedStep(
  ordered: IncrementalOrderedStep | undefined
): { readonly ordered?: IncrementalOrderedStep } {
  return ordered === undefined ? {} : { ordered };
}

function optionalBranchAggregateStep(
  aggregate: IncrementalAggregateStep | undefined
): { readonly aggregate?: IncrementalAggregateStep } {
  return aggregate === undefined ? {} : { aggregate };
}

function optionalBranchPostAggregateSteps(
  steps: readonly IncrementalBranchPostAggregateStep[] | undefined
): { readonly postAggregateSteps?: readonly IncrementalBranchPostAggregateStep[] } {
  return steps === undefined || steps.length === 0 ? {} : { postAggregateSteps: [...steps] };
}

function optionalBranchStaticUnionStep(
  step: IncrementalStaticUnionStep | undefined
): { readonly staticUnion?: IncrementalStaticUnionStep } {
  return step === undefined ? {} : { staticUnion: step };
}

function optionalBeforeStaticUnionRows(
  rows: readonly Record<string, unknown>[]
): { readonly beforeRows?: readonly Record<string, unknown>[] } {
  return rows.length === 0 ? {} : { beforeRows: rows };
}

function optionalBranchAggregateState(
  branchAggregate: IncrementalAggregateState<Record<string, unknown>> | undefined
): { readonly branchAggregate?: IncrementalAggregateState<Record<string, unknown>> } {
  return branchAggregate === undefined ? {} : { branchAggregate };
}

function optionalBranchOrderedState(
  branchOrdered: IncrementalOrderedState<Record<string, unknown>> | undefined
): { readonly branchOrdered?: IncrementalOrderedState<Record<string, unknown>> } {
  return branchOrdered === undefined ? {} : { branchOrdered };
}

function optionalRelationPostSteps(
  steps: readonly IncrementalRelationPostStep[]
): { readonly relationPostSteps?: readonly IncrementalRelationPostStep[] } {
  return steps.length === 0 ? {} : { relationPostSteps: [...steps] };
}

function incrementalSingleRootPlanReason(collection: PlanCollection): string {
  if (collection.relationPostSteps.length > 0) {
    return collection.ordered === undefined
      ? 'incremental maintenance for supported single-root relation pipeline with final static union'
      : 'incremental maintenance for supported single-root relation pipeline with final order/window and static union';
  }

  return collection.ordered === undefined
    ? 'incremental maintenance for supported single-root relation pipeline'
    : 'incremental maintenance for supported single-root relation pipeline with final order/window';
}

function operatorAfterRelationPostReason(collection: PlanCollection, operator: string): string | undefined {
  // TODO: represent row-local relation-post operators here so select/extend/without/rename/qualify
  // after a terminal static union can be incrementally composed instead of falling back.
  return collection.relationPostSteps.length === 0
    ? undefined
    : `${operator} after terminal union is not supported for incremental maintenance`;
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

function shapesHaveFieldOrAliasOverlap(left: PlanShape, right: PlanShape): boolean {
  return intersects(left.aliases, right.aliases) ||
    intersects(left.aliases, right.fields) ||
    intersects(left.fields, right.aliases) ||
    intersects(left.fields, right.fields);
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

function aggregateProjectionReason(
  aggregates: ProjectionData,
  shape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  for (const [name, item] of Object.entries(aggregates)) {
    const expr = projectionExpr(item);
    if (expr.op !== 'aggregateCall') {
      return `field ${name} is not an aggregate call`;
    }

    const reason = aggregateCallReason(expr, shape, options);
    if (reason !== undefined) {
      return `field ${name}: ${reason}`;
    }
  }
  return undefined;
}

function aggregateCallReason(
  expr: Extract<ExprData, { readonly op: 'aggregateCall' }>,
  shape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  if (!supportedAggregateFunctions.has(expr.name)) {
    return `${expr.name} aggregate is not supported`;
  }

  if (expr.expr === undefined) {
    return expr.name === 'count'
      ? undefined
      : `${expr.name} aggregate requires an input expression`;
  }

  return rowLocalExprReason(expr.expr, shape, options);
}

function rowLocalProjectionReason(
  projection: ProjectionData,
  shape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  for (const item of Object.values(projection)) {
    const reason = rowLocalExprReason(projectionExpr(item), shape, options);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

function rowLocalPredicateReason(
  predicate: PredicateData,
  shape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return rowLocalExprReason(predicate.left, shape, options) ?? rowLocalExprReason(predicate.right, shape, options);
    case 'and':
    case 'or':
      for (const item of predicate.predicates) {
        const reason = rowLocalPredicateReason(item, shape, options);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'not':
      return rowLocalPredicateReason(predicate.predicate, shape, options);
  }
}

function rowLocalExprReason(
  expr: ExprData,
  shape: PlanShape,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  switch (expr.op) {
    case 'field':
      return exprShapeReason(expr, shape);
    case 'value':
      return undefined;
    case 'tuple':
      for (const item of expr.items) {
        const reason = rowLocalExprReason(item, shape, options);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'hostCall':
      if (expr.fn === undefined) {
        return `host function ${expr.name} is not available; function expressions only work in memory`;
      }
      for (const arg of expr.args) {
        const reason = rowLocalExprReason(arg, shape, options);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'call':
      return namedCallReason(expr, (arg) => rowLocalExprReason(arg, shape, options), options);
    case 'env':
    case 'subquery':
    case 'aggregateCall':
      return simpleExprReason(expr);
  }
}

function namedCallReason(
  expr: Extract<ExprData, { readonly op: 'call' }>,
  argReason: (arg: ExprData) => string | undefined,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  if (options.functions?.[expr.name] === undefined) {
    return `named function ${expr.name} is not available for incremental maintenance`;
  }

  for (const arg of expr.args) {
    const reason = argReason(arg);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
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

function constantExprReason(
  expr: ExprData,
  options: IncrementalMaterializationPlanOptions
): string | undefined {
  switch (expr.op) {
    case 'value':
      return undefined;
    case 'tuple':
      for (const item of expr.items) {
        const reason = constantExprReason(item, options);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    case 'field':
      return 'field expressions are not supported in right branch lookup values';
    case 'call':
      return namedCallReason(expr, (arg) => constantExprReason(arg, options), options);
    case 'env':
    case 'hostCall':
    case 'subquery':
    case 'aggregateCall':
      return simpleExprReason(expr);
  }
}

function matchesPredicate(
  row: Record<string, unknown>,
  predicate: PredicateData,
  env: Readonly<Record<string, unknown>>,
  subqueryStateByKey: ReadonlyMap<string, SubqueryEvaluationState> = new Map()
): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(
        exprValue(row, predicate.left, env, subqueryStateByKey),
        exprValue(row, predicate.right, env, subqueryStateByKey)
      );
    case 'neq':
      return !Object.is(
        exprValue(row, predicate.left, env, subqueryStateByKey),
        exprValue(row, predicate.right, env, subqueryStateByKey)
      );
    case 'lt':
      return compareValues(
        exprValue(row, predicate.left, env, subqueryStateByKey),
        exprValue(row, predicate.right, env, subqueryStateByKey)
      ) < 0;
    case 'lte':
      return compareValues(
        exprValue(row, predicate.left, env, subqueryStateByKey),
        exprValue(row, predicate.right, env, subqueryStateByKey)
      ) <= 0;
    case 'gt':
      return compareValues(
        exprValue(row, predicate.left, env, subqueryStateByKey),
        exprValue(row, predicate.right, env, subqueryStateByKey)
      ) > 0;
    case 'gte':
      return compareValues(
        exprValue(row, predicate.left, env, subqueryStateByKey),
        exprValue(row, predicate.right, env, subqueryStateByKey)
      ) >= 0;
    case 'and':
      return predicate.predicates.every((item) => matchesPredicate(row, item, env, subqueryStateByKey));
    case 'or':
      return predicate.predicates.some((item) => matchesPredicate(row, item, env, subqueryStateByKey));
    case 'not':
      return !matchesPredicate(row, predicate.predicate, env, subqueryStateByKey);
  }
}

function exprValue(
  row: Record<string, unknown>,
  expr: ExprData,
  env: Readonly<Record<string, unknown>>,
  subqueryStateByKey: ReadonlyMap<string, SubqueryEvaluationState> = new Map()
): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'env':
      return evalEnv(env)[expr.name];
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
      return expr.items.map((item) => exprValue(row, item, env, subqueryStateByKey));
    case 'call': {
      const fn = evalFunctions(env)?.[expr.name];
      if (fn === undefined) {
        return undefined;
      }
      try {
        return fn(...expr.args.map((arg) => exprValue(row, arg, env, subqueryStateByKey)));
      } catch {
        return undefined;
      }
    }
    case 'aggregateCall':
      return undefined;
    case 'hostCall': {
      if (expr.fn === undefined) {
        return undefined;
      }
      try {
        return expr.fn(...expr.args.map((arg) => exprValue(row, arg, env, subqueryStateByKey)));
      } catch {
        return undefined;
      }
    }
    case 'subquery':
      return subqueryExprValue(row, expr, env, subqueryStateByKey);
  }
}

function subqueryExprValue(
  row: Record<string, unknown>,
  expr: Extract<ExprData, { readonly op: 'subquery' }>,
  env: Readonly<Record<string, unknown>>,
  subqueryStateByKey: ReadonlyMap<string, SubqueryEvaluationState>
): unknown {
  const planned = subqueryStateByKey.get(subqueryExprKey(expr));
  if (planned === undefined) {
    return undefined;
  }

  const leftValue = exprValue(row, planned.step.left, env, subqueryStateByKey);
  const candidates = planned.state.indexByValue.get(stableKey(leftValue)) ?? [];
  const rows: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (Object.is(leftValue, candidate.value)) {
      rows.push(stripSubqueryHiddenField(candidate.row, planned.step.hiddenField));
    }
  }

  return planned.step.mode === 'one' ? rows[0] : rows;
}

function stripSubqueryHiddenField(
  row: Record<string, unknown>,
  hiddenField: string
): Record<string, unknown> {
  if (!Object.hasOwn(row, hiddenField)) {
    return row;
  }

  const output = { ...row };
  delete output[hiddenField];
  return output;
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
    case 'env':
      return undefined;
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
