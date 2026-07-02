import type { RelationDelta } from './adapter.js';
import type { RowChange, RowDiffDiagnostic } from './diff.js';
import type { EvaluateFunctions } from './evaluate.js';
import {
  buildIncrementalMaterialization,
  buildStaticIncrementalMaterialization,
  maintainIncrementalMaterialization,
  planIncrementalMaterialization,
  rowsFromIncrementalState,
  type IncrementalMaterialization,
  type IncrementalMaterializationPlan
} from './materialization-plan.js';
import type { Query } from './query.js';
import type { RelationRef } from './schema.js';
import type { RelationSource } from './source.js';

export type LegacyIncrementalMaterializationOptions = {
  readonly functions?: EvaluateFunctions;
};

export type LegacyIncrementalMaterialization<Row = unknown> = IncrementalMaterialization<Row>;
export type LegacyIncrementalMaterializationPlan = IncrementalMaterializationPlan;

export type LegacyIncrementalPlanResult =
  | {
      readonly supported: true;
      readonly plan: LegacyIncrementalMaterializationPlan;
      readonly reason: string;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export type LegacyIncrementalBuildResult<Row = unknown> =
  | {
      readonly supported: true;
      readonly reason: string;
      readonly rows: readonly Row[];
      readonly incremental: LegacyIncrementalMaterialization<Row>;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export type LegacyIncrementalMaintenanceResult<Row = unknown> =
  | {
      readonly updated: true;
      readonly reason: string;
      readonly rows: readonly Row[];
      readonly incremental: LegacyIncrementalMaterialization<Row>;
      readonly addedRows: readonly Row[];
      readonly removedRows: readonly Row[];
      readonly rowChanges: readonly RowChange<Row>[];
      readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
    }
  | {
      readonly updated: false;
      readonly reason: string;
    };

export function legacyPlanIncrementalMaterialization(
  query: Query,
  options: LegacyIncrementalMaterializationOptions = {}
): LegacyIncrementalPlanResult {
  return planIncrementalMaterialization(query, options);
}

export function legacyBuildIncrementalMaterialization<Row>(
  plan: LegacyIncrementalMaterializationPlan,
  source: RelationSource,
  relations: Readonly<Record<string, RelationRef>>,
  env: Readonly<Record<string, unknown>>,
  options: LegacyIncrementalMaterializationOptions = {}
): LegacyIncrementalBuildResult<Row> {
  if (plan.kind === 'staticRows') {
    return legacyBuildResult(buildStaticIncrementalMaterialization<Row>(plan, env, options));
  }

  const relationSnapshots = legacyRelationSnapshots(source, relations);
  if (plan.kind === 'dynamicSet') {
    return legacyBuildResult(buildIncrementalMaterialization<Row>(
      plan,
      undefined,
      [],
      env,
      relationSnapshots,
      options
    ));
  }

  const relation = relations[plan.rootRelation];
  if (relation === undefined) {
    return {
      supported: false,
      reason: `relation ${plan.rootRelation} is not available for incremental maintenance`
    };
  }

  return legacyBuildResult(buildIncrementalMaterialization<Row>(
    plan,
    relation,
    relationSnapshots.get(relation.name)?.rows ?? legacyReadRows(source, relation),
    env,
    relationSnapshots,
    options
  ));
}

export function legacyMaintainIncrementalMaterialization<Row>(
  incremental: LegacyIncrementalMaterialization<Row> | undefined,
  relations: Readonly<Record<string, RelationRef>>,
  deltas: readonly RelationDelta[] | undefined,
  previousRows: readonly Row[],
  env: Readonly<Record<string, unknown>>,
  options: LegacyIncrementalMaterializationOptions = {}
): LegacyIncrementalMaintenanceResult<Row> {
  if (incremental === undefined) {
    return {
      updated: false,
      reason: 'incremental materialization state is missing'
    };
  }

  if (incremental.plan.kind !== 'staticRows' && deltas === undefined) {
    return {
      updated: false,
      reason: 'transaction deltas are required for incremental maintenance'
    };
  }

  const relation = incremental.plan.kind === 'singleRoot'
    ? relations[incremental.plan.rootRelation]
    : undefined;
  if (incremental.plan.kind === 'singleRoot' && relation === undefined) {
    return {
      updated: false,
      reason: `relation ${incremental.plan.rootRelation} is not available for incremental maintenance`
    };
  }

  const maintained = maintainIncrementalMaterialization(
    incremental,
    relation,
    deltas ?? [],
    env,
    options
  );
  if (!maintained.updated) {
    return maintained;
  }

  const nextIncremental = {
    plan: incremental.plan,
    state: maintained.state
  };
  return {
    updated: true,
    reason: maintained.reason,
    rows: legacyRowsForMaintainedIncremental(previousRows, maintained.rowBatches, nextIncremental),
    incremental: nextIncremental,
    addedRows: maintained.addedRows,
    removedRows: maintained.removedRows,
    rowChanges: maintained.rowChanges,
    diagnostics: maintained.diagnostics
  };
}

function legacyBuildResult<Row>(
  built: ReturnType<typeof buildIncrementalMaterialization<Row>>
): LegacyIncrementalBuildResult<Row> {
  if (!built.supported) {
    return built;
  }

  return {
    supported: true,
    reason: built.reason,
    rows: built.rows,
    incremental: {
      plan: built.plan,
      state: built.state
    }
  };
}

function legacyRowsForMaintainedIncremental<Row>(
  previousRows: readonly Row[],
  rowBatches: readonly unknown[],
  incremental: LegacyIncrementalMaterialization<Row>
): readonly Row[] {
  if (incremental.state.aggregate !== undefined) {
    return rowsFromIncrementalState(incremental.state);
  }

  if (rowBatches.length === 0) {
    return previousRows;
  }

  return rowsFromIncrementalState(incremental.state);
}

function legacyRelationSnapshots(
  source: RelationSource,
  relations: Readonly<Record<string, RelationRef>>
): ReadonlyMap<string, { readonly relation: RelationRef; readonly rows: readonly unknown[] }> {
  return new Map(Object.values(relations).map((relation) => [
    relation.name,
    { relation, rows: legacyReadRows(source, relation) }
  ]));
}

function legacyReadRows(source: RelationSource, relation: RelationRef): readonly unknown[] {
  const rows = source.rows(relation);
  return Array.isArray(rows) ? rows : [];
}
