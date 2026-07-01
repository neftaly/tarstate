import type { RelationDelta } from './adapter.js';
import { rowKey } from './evaluate.js';
import { stableKey } from './identity.js';
import type {
  ExprData,
  PredicateData,
  ProjectionData,
  Query,
  QueryData
} from './query.js';
import type { RelationRef } from './schema.js';

export type IncrementalMaterializationPlan = {
  readonly kind: 'singleRoot';
  readonly rootRelation: string;
  readonly rootAlias: string;
  readonly root: IncrementalRoot;
  readonly steps: readonly IncrementalStep[];
};

export type IncrementalMaterializationState<Row = unknown> = {
  readonly kind: 'incrementalMaterializationState';
  readonly rootRelation: string;
  readonly rootKeys: readonly string[];
  readonly outputsByRootKey: ReadonlyMap<string, readonly Row[]>;
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
      readonly rows: readonly Row[];
      readonly state: IncrementalMaterializationState<Row>;
    }
  | {
      readonly updated: false;
      readonly reason: string;
    };

type IncrementalRoot =
  | { readonly kind: 'from' }
  | { readonly kind: 'lookup'; readonly field: string; readonly value: ExprData };

type IncrementalStep =
  | { readonly kind: 'where'; readonly predicate: PredicateData }
  | { readonly kind: 'select'; readonly projection: ProjectionData }
  | { readonly kind: 'extend'; readonly projection: ProjectionData }
  | { readonly kind: 'without'; readonly fields: readonly string[] }
  | { readonly kind: 'rename'; readonly fields: Record<string, string> };

type RootPlan = {
  readonly relation: string;
  readonly alias: string;
  readonly root: IncrementalRoot;
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

export function planIncrementalMaterialization(query: Query): IncrementalPlanResult {
  const steps: IncrementalStep[] = [];
  const root = collectSingleRootPlan(query.data, steps);
  if (typeof root === 'string') {
    return { supported: false, reason: root };
  }

  if (query.relations[root.relation] === undefined) {
    return { supported: false, reason: `relation ${root.relation} is not available for incremental maintenance` };
  }

  return {
    supported: true,
    plan: {
      kind: 'singleRoot',
      rootRelation: root.relation,
      rootAlias: root.alias,
      root: root.root,
      steps
    },
    reason: 'incremental maintenance for supported single-root relation pipeline'
  };
}

export function buildIncrementalMaterialization<Row>(
  plan: IncrementalMaterializationPlan,
  relation: RelationRef,
  rootRows: readonly unknown[],
  env: Readonly<Record<string, unknown>>
): IncrementalMaterializationBuildResult<Row> {
  const duplicateReason = duplicateRelationRowsReason(relation, rootRows);
  if (duplicateReason !== undefined) {
    return {
      supported: false,
      reason: duplicateReason
    };
  }

  const rootKeys: string[] = [];
  const outputsByRootKey = new Map<string, readonly Row[]>();

  for (const row of rootRows) {
    const key = relationKeyForRow(relation, row);
    rootKeys.push(key);
    outputsByRootKey.set(key, evaluateRootRow<Row>(plan, row, env));
  }

  const state = {
    kind: 'incrementalMaterializationState',
    rootRelation: plan.rootRelation,
    rootKeys,
    outputsByRootKey
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

  const normalized = normalizedRelationChanges(relation, deltas);
  if (!normalized.supported) {
    return {
      updated: false,
      reason: normalized.reason
    };
  }

  const changes = normalized.changes;
  if (changes.length === 0) {
    if (hasRelationDeltaRows(relation, deltas)) {
      return {
        updated: false,
        reason: 'root relation deltas had no net keyed row changes; snapshot recompute is required to preserve relation order'
      };
    }

    return {
      updated: true,
      reason: 'root relation deltas had no net row changes',
      rows: rowsFromIncrementalState(materialization.state),
      state: materialization.state
    };
  }

  const rootKeys: (string | undefined)[] = [...materialization.state.rootKeys];
  const outputsByRootKey = new Map(materialization.state.outputsByRootKey);

  for (const change of changes) {
    const index = rootKeys.indexOf(change.key);

    if (change.after === undefined) {
      if (index === -1) {
        return {
          updated: false,
          reason: `root relation delta removed missing key ${change.key}; snapshot recompute is required`
        };
      }
      rootKeys[index] = undefined;
      outputsByRootKey.delete(change.key);
      continue;
    }

    if (index === -1) {
      if (change.before !== undefined) {
        return {
          updated: false,
          reason: `root relation delta updated missing key ${change.key}; snapshot recompute is required`
        };
      }

      const vacantIndex = rootKeys.indexOf(undefined);
      if (vacantIndex === -1) {
        rootKeys.push(change.key);
      } else {
        rootKeys[vacantIndex] = change.key;
      }
    } else if (change.before === undefined) {
      return {
        updated: false,
        reason: `root relation delta added duplicate key ${change.key}; snapshot recompute is required`
      };
    }
    outputsByRootKey.set(change.key, evaluateRootRow<Row>(materialization.plan, change.after, env));
  }

  const compactRootKeys = rootKeys.filter((key): key is string => key !== undefined);
  const duplicateResultReason = duplicateRootKeysReason(compactRootKeys, relation.name);
  if (duplicateResultReason !== undefined) {
    return {
      updated: false,
      reason: duplicateResultReason
    };
  }

  const state = {
    kind: 'incrementalMaterializationState',
    rootRelation: materialization.state.rootRelation,
    rootKeys: compactRootKeys,
    outputsByRootKey
  } satisfies IncrementalMaterializationState<Row>;

  return {
    updated: true,
    reason: 'dependencies touched; incrementally maintained rows',
    rows: rowsFromIncrementalState(state),
    state
  };
}

function collectSingleRootPlan(data: QueryData, steps: IncrementalStep[]): RootPlan | string {
  switch (data.op) {
    case 'from':
      return {
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'from' }
      };
    case 'lookup': {
      const reason = simpleExprReason(data.value);
      if (reason !== undefined) {
        return `lookup value is not supported for incremental maintenance: ${reason}`;
      }
      return {
        relation: data.relation,
        alias: data.alias,
        root: { kind: 'lookup', field: data.field, value: data.value }
      };
    }
    case 'where': {
      const root = collectSingleRootPlan(data.input, steps);
      if (typeof root === 'string') return root;
      const reason = simplePredicateReason(data.predicate);
      if (reason !== undefined) {
        return `where predicate is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({ kind: 'where', predicate: data.predicate });
      return root;
    }
    case 'hash':
    case 'btree': {
      const root = collectSingleRootPlan(data.input, steps);
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
      return collectSingleRootPlan(data.input, steps);
    case 'select': {
      const root = collectSingleRootPlan(data.input, steps);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection);
      if (reason !== undefined) {
        return `select projection is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({ kind: 'select', projection: data.projection });
      return root;
    }
    case 'extend': {
      const root = collectSingleRootPlan(data.input, steps);
      if (typeof root === 'string') return root;
      const reason = simpleProjectionReason(data.projection);
      if (reason !== undefined) {
        return `extend projection is not supported for incremental maintenance: ${reason}`;
      }
      steps.push({ kind: 'extend', projection: data.projection });
      return root;
    }
    case 'without': {
      const root = collectSingleRootPlan(data.input, steps);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'without', fields: data.fields });
      return root;
    }
    case 'rename': {
      const root = collectSingleRootPlan(data.input, steps);
      if (typeof root === 'string') return root;
      steps.push({ kind: 'rename', fields: data.fields });
      return root;
    }
    case 'join':
      return data.kind === 'inner'
        ? 'inner join incremental maintenance is not supported yet'
        : 'left join incremental maintenance is not supported';
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
    case 'aggregate':
      return 'aggregate is not supported for incremental maintenance';
  }
}

function evaluateRootRow<Row>(
  plan: IncrementalMaterializationPlan,
  relationRow: unknown,
  env: Readonly<Record<string, unknown>>
): readonly Row[] {
  const rootRow = rootContext(plan, relationRow, env);
  if (rootRow === undefined) {
    return [];
  }

  let rows: readonly Record<string, unknown>[] = [rootRow];
  for (const step of plan.steps) {
    rows = evaluateStep(rows, step, env);
    if (rows.length === 0) {
      return [];
    }
  }

  return rows as readonly Row[];
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
  step: IncrementalStep,
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

function rowsFromIncrementalState<Row>(state: IncrementalMaterializationState<Row>): readonly Row[] {
  return state.rootKeys.flatMap((key) => state.outputsByRootKey.get(key) ?? []);
}

function duplicateRelationRowsReason(relation: RelationRef, rows: readonly unknown[]): string | undefined {
  const keys = rows.map((row) => relationKeyForRow(relation, row));
  return duplicateRootKeysReason(keys, relation.name);
}

function duplicateRootKeysReason(keys: readonly string[], relationName: string): string | undefined {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      return `root relation ${relationName} has duplicate key ${key}; snapshot recompute is required`;
    }
    seen.add(key);
  }
  return undefined;
}

function normalizedRelationChanges(
  relation: RelationRef,
  deltas: readonly RelationDelta[]
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
        reason: `root relation deltas contain duplicate key ${entry.key}; snapshot recompute is required`
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
