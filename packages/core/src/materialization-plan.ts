import type { RelationDelta } from './adapter.js';
import type { RowChange, RowDiffDiagnostic } from './diff.js';
import { rowKey } from './evaluate.js';
import { stableKey } from './identity.js';
import { equalityJoinPlan, type FieldExpression } from './join-planner.js';
import {
  diffMaterializationRows,
  materializationRowKey,
  type MaterializationRowDiffOptions
} from './materialization-row-changes.js';
import type {
  AggregateFunction,
  ExprData,
  PredicateData,
  ProjectionData,
  Query,
  QueryData
} from './query.js';
import { queryRowKeyFields } from './query.js';
import type { RelationRef } from './schema.js';

export type IncrementalMaterializationPlan = {
  readonly kind: 'singleRoot';
  readonly rootRelation: string;
  readonly rootAlias: string;
  readonly root: IncrementalRoot;
  readonly steps: readonly IncrementalStep[];
  readonly rowKeyFields?: readonly string[];
};

export type IncrementalMaterializationState<Row = unknown> = {
  readonly kind: 'incrementalMaterializationState';
  readonly rootRelation: string;
  readonly rootKeys: readonly string[];
  readonly rootIndexByKey: ReadonlyMap<string, number>;
  readonly rootRowsByRootKey: ReadonlyMap<string, unknown>;
  readonly outputsByRootKey: ReadonlyMap<string, readonly unknown[]>;
  readonly joinStates: readonly IncrementalJoinState[];
  readonly aggregate?: IncrementalAggregateState<Row>;
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
  | { readonly kind: 'without'; readonly fields: readonly string[] }
  | { readonly kind: 'rename'; readonly fields: Record<string, string> };

type IncrementalJoinStep = {
  readonly kind: 'join';
  readonly id: string;
  readonly right: IncrementalBranchPlan;
  readonly left: ExprData;
  readonly rightExpr: ExprData;
  readonly predicate: PredicateData;
  readonly needsPredicateCheck: boolean;
};

type IncrementalAggregateStep = {
  readonly kind: 'aggregate';
  readonly groupBy: ProjectionData;
  readonly aggregates: ProjectionData;
};

type IncrementalStep = IncrementalPipelineStep | IncrementalJoinStep | IncrementalAggregateStep;

type IncrementalBranchPlan = {
  readonly relation: string;
  readonly alias: string;
  readonly root: IncrementalRoot;
  readonly steps: readonly IncrementalPipelineStep[];
};

type IncrementalJoinState = {
  readonly id: string;
  readonly relation: string;
  readonly relationKeys: readonly string[];
  readonly relationIndexByKey: ReadonlyMap<string, number>;
  readonly rowsByRelationKey: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly indexByValue: ReadonlyMap<string, readonly IndexedRightRow[]>;
  readonly rootValuesByKey: ReadonlyMap<string, readonly unknown[]>;
  readonly rootKeysByValue: ReadonlyMap<string, readonly RootJoinValue[]>;
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
  'bottom'
]);

export function planIncrementalMaterialization(query: Query): IncrementalPlanResult {
  const steps: IncrementalStep[] = [];
  const root = collectSingleRootPlan(query.data, steps, { joinCount: 0 });
  if (typeof root === 'string') {
    return { supported: false, reason: root };
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
      ...optionalRowKeyFields(queryRowKeyFields(query))
    },
    reason: 'incremental maintenance for supported single-root relation pipeline'
  };
}

export function buildIncrementalMaterialization<Row>(
  plan: IncrementalMaterializationPlan,
  relation: RelationRef,
  rootRows: readonly unknown[],
  env: Readonly<Record<string, unknown>>,
  relationSnapshots: ReadonlyMap<string, IncrementalRelationSnapshot> = new Map([
    [relation.name, { relation, rows: rootRows }]
  ])
): IncrementalMaterializationBuildResult<Row> {
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

  const state = {
    kind: 'incrementalMaterializationState',
    rootRelation: plan.rootRelation,
    rootKeys,
    rootIndexByKey: indexKeys(rootKeys),
    rootRowsByRootKey,
    outputsByRootKey,
    joinStates,
    ...(aggregateState === undefined ? {} : { aggregate: aggregateState.state })
  } satisfies IncrementalMaterializationState<Row>;

  return {
    supported: true,
    reason: 'incremental materialization state built for unique root keys',
    plan,
    state,
    rows: rowsFromIncrementalState(state)
  };
}

export function maintainIncrementalMaterialization<Row>(
  materialization: IncrementalMaterialization<Row>,
  relation: RelationRef,
  deltas: readonly RelationDelta[],
  env: Readonly<Record<string, unknown>>
): IncrementalMaintenanceResult<Row> {
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
  const vacantRootIndices: number[] = [];
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

    const deltaRelation = relationForDeltas(joinStep.right.relation, deltas);
    if (deltaRelation === undefined) {
      continue;
    }

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
      continue;
    }

    const changed = applyRightRelationChanges(joinStep, currentState, deltaRelation, rightChanges.changes, env);
    if (!changed.supported) {
      return {
        updated: false,
        reason: changed.reason
      };
    }

    for (const rootKey of changed.affectedRootKeys) {
      rootKeysToEvaluate.add(rootKey);
      changedRootKeys.add(rootKey);
    }
    joinStates = joinStates.map((state) => state.id === changed.state.id ? changed.state : state);
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
      vacantRootIndices.push(index);
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

      const vacantIndex = vacantRootIndices.shift();
      if (vacantIndex === undefined) {
        rootIndexByKey.set(change.key, rootKeys.length);
        rootKeys.push(change.key);
      } else {
        rootKeys[vacantIndex] = change.key;
        rootIndexByKey.set(change.key, vacantIndex);
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

  const state = {
    kind: 'incrementalMaterializationState',
    rootRelation: materialization.state.rootRelation,
    rootKeys: compactRootKeys,
    rootIndexByKey: compactRootIndexByKey,
    rootRowsByRootKey,
    outputsByRootKey,
    joinStates: nextJoinStates,
    ...(nextAggregateState === undefined ? {} : { aggregate: nextAggregateState.state })
  } satisfies IncrementalMaterializationState<Row>;

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
      steps.push({ kind: 'select', projection: data.projection });
      return { ...root, shape: selectShape(root.shape, data.projection) };
    }
    case 'extend': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection);
      if (reason !== undefined) {
        return `extend projection is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({ kind: 'extend', projection: data.projection });
      return { ...root, shape: extendShape(root.shape, data.projection) };
    }
    case 'without': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'without', fields: data.fields });
      return { ...root, shape: withoutShape(root.shape, data.fields) };
    }
    case 'rename': {
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'rename', fields: data.fields });
      return { ...root, shape: renameShape(root.shape, data.fields) };
    }
    case 'join': {
      const stepCount = steps.length;
      if (data.kind !== 'inner') {
        return 'left join incremental maintenance is not supported';
      }

      const left = collectSingleRootPlan(data.left, steps, collection);
      if (typeof left === 'string') return left;
      if (hasAggregateStep(steps.slice(stepCount))) {
        return 'join after aggregate is not supported for incremental maintenance';
      }

      const right = collectRightBranchPlan(data.right);
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
        return 'inner join incremental maintenance requires an unambiguous field equality predicate';
      }

      const id = `join:${collection.joinCount}`;
      collection.joinCount += 1;
      steps.push({
        kind: 'join',
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
      return 'sort is not supported for incremental maintenance';
    case 'limit':
      return 'limit is not supported for incremental maintenance';
    case 'sortLimit':
      return 'sortLimit is not supported for incremental maintenance';
    case 'expand':
      return 'expand is not supported for incremental maintenance';
    case 'union':
      return 'union is not supported for incremental maintenance';
    case 'intersection':
      return 'intersection is not supported for incremental maintenance';
    case 'difference':
      return 'difference is not supported for incremental maintenance';
    case 'constRows':
      return 'constRows is not supported for incremental maintenance';
    case 'qualify':
      return 'qualify is not supported for incremental maintenance';
    case 'aggregate': {
      const stepCount = steps.length;
      const root = collectSingleRootPlan(data.input, steps, collection);
      if (typeof root === 'string') return root;
      const addedSteps = steps.slice(stepCount);
      if (hasAggregateStep(addedSteps)) {
        return 'nested aggregate is not supported for incremental maintenance';
      }
      if (addedSteps.some((step) => step.kind === 'join')) {
        return 'joins under aggregate are not supported for incremental maintenance';
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

function collectRightBranchPlan(data: QueryData): RightBranchPlan | string {
  const steps: IncrementalPipelineStep[] = [];
  return collectRightBranchPlanInternal(data, steps);
}

function collectRightBranchPlanInternal(
  data: QueryData,
  steps: IncrementalPipelineStep[]
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
      const root = collectRightBranchPlanInternal(data.input, steps);
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
      const root = collectRightBranchPlanInternal(data.input, steps);
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
      return collectRightBranchPlanInternal(data.input, steps);
    case 'select': {
      const root = collectRightBranchPlanInternal(data.input, steps);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection) ?? projectionShapeReason(data.projection, root.shape);
      if (reason !== undefined) {
        return `select projection is not supported: ${reason}`;
      }
      steps.push({ kind: 'select', projection: data.projection });
      return { ...root, shape: selectShape(root.shape, data.projection) };
    }
    case 'extend': {
      const root = collectRightBranchPlanInternal(data.input, steps);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection) ?? projectionShapeReason(data.projection, root.shape);
      if (reason !== undefined) {
        return `extend projection is not supported: ${reason}`;
      }
      steps.push({ kind: 'extend', projection: data.projection });
      return { ...root, shape: extendShape(root.shape, data.projection) };
    }
    case 'without': {
      const root = collectRightBranchPlanInternal(data.input, steps);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'without', fields: data.fields });
      return { ...root, shape: withoutShape(root.shape, data.fields) };
    }
    case 'rename': {
      const root = collectRightBranchPlanInternal(data.input, steps);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'rename', fields: data.fields });
      return { ...root, shape: renameShape(root.shape, data.fields) };
    }
    case 'join':
      return data.kind === 'inner'
        ? 'right branch joins are not supported'
        : 'right branch left joins are not supported';
    case 'sort':
      return 'sort is not supported';
    case 'limit':
      return 'limit is not supported';
    case 'sortLimit':
      return 'sortLimit is not supported';
    case 'expand':
      return 'expand is not supported';
    case 'union':
      return 'union is not supported';
    case 'intersection':
      return 'intersection is not supported';
    case 'difference':
      return 'difference is not supported';
    case 'constRows':
      return 'constRows is not supported';
    case 'qualify':
      return 'qualify is not supported';
    case 'aggregate':
      return 'aggregate is not supported';
  }
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
      names.add(step.right.relation);
    }
  }
  return Array.from(names);
}

function joinSteps(plan: IncrementalMaterializationPlan): readonly IncrementalJoinStep[] {
  return plan.steps.filter((step): step is IncrementalJoinStep => step.kind === 'join');
}

function aggregateStep(plan: IncrementalMaterializationPlan): IncrementalAggregateStep | undefined {
  return plan.steps.find((step): step is IncrementalAggregateStep => step.kind === 'aggregate');
}

function hasAggregateStep(steps: readonly IncrementalStep[]): boolean {
  return steps.some((step) => step.kind === 'aggregate');
}

function stepsAfterAggregate(plan: IncrementalMaterializationPlan): readonly IncrementalPipelineStep[] {
  const aggregateIndex = plan.steps.findIndex((step) => step.kind === 'aggregate');
  if (aggregateIndex === -1) {
    return [];
  }

  return plan.steps.slice(aggregateIndex + 1).filter((step): step is IncrementalPipelineStep =>
    step.kind !== 'join' && step.kind !== 'aggregate'
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
  plan: IncrementalMaterializationPlan,
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
  plan: IncrementalMaterializationPlan,
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
  step: IncrementalPipelineStep,
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
  }
}

function evaluateJoinStep(
  rows: readonly Record<string, unknown>[],
  step: IncrementalJoinStep,
  state: IncrementalJoinState,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];

  for (const leftRow of rows) {
    const leftValue = exprValue(leftRow, step.left, env);
    const candidates = state.indexByValue.get(stableKey(leftValue)) ?? [];
    for (const candidate of candidates) {
      if (!Object.is(leftValue, candidate.value)) {
        continue;
      }

      const merged = { ...leftRow, ...candidate.row };
      if (!step.needsPredicateCheck || matchesPredicate(merged, step.predicate, env)) {
        output.push(merged);
      }
    }
  }

  return output;
}

function evaluateBranchRows(
  branch: IncrementalBranchPlan,
  relationRow: unknown,
  env: Readonly<Record<string, unknown>>
): readonly Record<string, unknown>[] {
  const rootRow = branchRootContext(branch, relationRow, env);
  if (rootRow === undefined) {
    return [];
  }

  let rows: readonly Record<string, unknown>[] = [rootRow];
  for (const step of branch.steps) {
    rows = evaluateStep(rows, step, env);
    if (rows.length === 0) {
      return [];
    }
  }

  return rows;
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

export function rowsFromIncrementalState<Row>(state: IncrementalMaterializationState<Row>): readonly Row[] {
  if (state.aggregate !== undefined) {
    return state.aggregate.groupKeys.flatMap((key) => {
      const group = state.aggregate?.groupsByKey.get(key);
      return group === undefined ? [] : [group.output];
    });
  }

  return state.rootKeys.flatMap((key) => state.outputsByRootKey.get(key) ?? []) as readonly Row[];
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
    const rowsByRelationKey = new Map<string, readonly Record<string, unknown>[]>();
    for (const row of snapshot.rows) {
      const key = relationKeyForRow(snapshot.relation, row);
      relationKeys.push(key);
      rowsByRelationKey.set(key, evaluateBranchRows(step.right, row, env));
    }

    states.push({
      id: step.id,
      relation: step.right.relation,
      relationKeys,
      relationIndexByKey: indexKeys(relationKeys),
      rowsByRelationKey,
      indexByValue: buildRightIndex(step, relationKeys, rowsByRelationKey, env),
      rootValuesByKey: new Map(),
      rootKeysByValue: new Map()
    });
  }

  return { supported: true, states };
}

function buildRightIndex(
  step: IncrementalJoinStep,
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

function applyRightRelationChanges(
  step: IncrementalJoinStep,
  state: IncrementalJoinState,
  relation: RelationRef,
  changes: readonly DeltaRowChange[],
  env: Readonly<Record<string, unknown>>
): RightChangeResult {
  const relationKeys: (string | undefined)[] = [...state.relationKeys];
  const relationIndexByKey = new Map(relationIndexByKeyForState(state));
  const vacantRelationIndices: number[] = [];
  const rowsByRelationKey = new Map(state.rowsByRelationKey);
  const indexByValue = mutableRightIndex(state.indexByValue);
  const affectedValues: unknown[] = [];

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
      vacantRelationIndices.push(index);
      rowsByRelationKey.delete(change.key);
      continue;
    }

    if (index === -1) {
      if (change.before !== undefined) {
        return {
          supported: false,
          reason: `right relation delta updated missing key ${change.key}; snapshot recompute is required`
        };
      }

      const vacantIndex = vacantRelationIndices.shift();
      if (vacantIndex === undefined) {
        relationIndexByKey.set(change.key, relationKeys.length);
        relationKeys.push(change.key);
      } else {
        relationKeys[vacantIndex] = change.key;
        relationIndexByKey.set(change.key, vacantIndex);
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
    }

    const nextRows = evaluateBranchRows(step.right, change.after, env);
    affectedValues.push(...nextRows.map((row) => exprValue(row, step.rightExpr, env)));
    addRightIndexRows(step, indexByValue, nextRows, env);
    rowsByRelationKey.set(change.key, nextRows);
  }

  const compactRelationKeys = relationKeys.filter((key): key is string => key !== undefined);
  const duplicateReason = duplicateRelationKeysReason(compactRelationKeys, `right relation ${relation.name}`);
  if (duplicateReason !== undefined) {
    return {
      supported: false,
      reason: duplicateReason
    };
  }

  return {
    supported: true,
    state: {
      ...state,
      relationKeys: compactRelationKeys,
      relationIndexByKey: indexKeys(compactRelationKeys),
      rowsByRelationKey,
      indexByValue
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
  step: IncrementalJoinStep,
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
  step: IncrementalJoinStep,
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

function rowDiffOptionsForPlan(plan: IncrementalMaterializationPlan): MaterializationRowDiffOptions {
  return plan.rowKeyFields === undefined ? {} : { keyBy: plan.rowKeyFields };
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
  const inLeft = shapeHasField(left, expr);
  const inRight = shapeHasField(right, expr);

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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
