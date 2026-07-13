import { canonicalizeJson } from './artifacts.js';
import { createIssue } from './issues.js';
import {
  createQueryMaintenanceSnapshotNormalizer,
  type QueryMaintenanceSnapshotDiff,
  type QueryMaintenanceSnapshotNormalizer
} from './internal-observer-maintenance-frames.js';
import type {
  CreateDatabaseQueryMaintenance,
  DatabaseQueryMaintenanceInput,
  DatabaseQueryMaintenanceSession,
  MaintainedDatabaseQueryResult,
  QueryMaintenanceDiagnostics,
  QueryMaintenanceReuseDiagnostics
} from './internal-observer-query-maintenance-contracts.js';
import { samePortableObserverValue } from './internal-observer-values.js';
import type { PreparedPlan } from './maintenance.js';
import {
  createPooledIncrementalQueryRuntime,
  diffQueryMaintenanceSnapshots,
  isNonPoolableQueryError,
  isPooledQueryRuntimeBusyError,
  openIncrementalQueryMaintenance
} from './query.js';
import type {
  FunctionRegistry,
  IncrementalQueryResult,
  PooledIncrementalQueryDiagnostics,
  PooledIncrementalQueryRoot,
  PooledIncrementalQueryRuntime,
  QueryMaintenanceSnapshot,
  QueryNode,
  QueryRecord,
  RelationInput
} from './query-model.js';
import type { JsonValue } from './value.js';

export type {
  CreateDatabaseQueryMaintenance,
  DatabaseQueryMaintenanceInput,
  DatabaseQueryMaintenanceSession,
  MaintainedDatabaseQueryResult,
  QueryMaintenanceDiagnostics,
  QueryMaintenanceReuseDiagnostics
} from './internal-observer-query-maintenance-contracts.js';

export type TrustedIncrementalMetadata = Readonly<Pick<IncrementalQueryResult['state'], 'revision' | 'resultDelta'>> & {
  readonly resultKeyPositions: ReadonlyMap<string, number>;
};
type OwnedTrustedIncrementalMetadata = TrustedIncrementalMetadata & { readonly owner: object };

const incrementalMaintenanceFactoryBrand = Symbol('tarstate.incremental-maintenance-factory');
const maintenanceRuntimeIdentity = Symbol('tarstate.maintenance-runtime');
const trustedIncrementalResults = new WeakMap<object, OwnedTrustedIncrementalMetadata>();
const resultKeyPositionCache = new WeakMap<readonly string[], ReadonlyMap<string, number>>();
const trustedIncrementalFactories = new WeakMap<object, object>();

type IncrementalDatabaseQueryMaintenanceFactory = CreateDatabaseQueryMaintenance<QueryNode, QueryRecord, readonly RelationInput[]> & {
  readonly [incrementalMaintenanceFactoryBrand]: {
    readonly getDiagnostics: (runtimeIdentity: object) => readonly PooledIncrementalQueryDiagnostics[];
    readonly getReuseDiagnostics: (runtimeIdentity: object) => QueryMaintenanceReuseDiagnostics;
  };
};

type InternalCreateDatabaseQueryMaintenanceInput<Query, Projection> = {
  readonly plan: PreparedPlan<Query>;
  readonly initialInput: DatabaseQueryMaintenanceInput<Query, Projection>;
  readonly [maintenanceRuntimeIdentity]: object;
};

type PooledDatabaseMaintenanceCohort = {
  readonly key: string;
  readonly runtime: PooledIncrementalQueryRuntime;
  accepted: QueryMaintenanceSnapshot;
  lastRejected?: QueryMaintenanceSnapshot;
  transitionFailure?: {
    readonly snapshot: QueryMaintenanceSnapshot;
    readonly result: MaintainedDatabaseQueryResult<QueryRecord>;
    readonly attachable: boolean;
  };
  roots: number;
};

export const maintenanceFactoryInput = <Query, Projection>(
  plan: PreparedPlan<Query>,
  initialInput: DatabaseQueryMaintenanceInput<Query, Projection>,
  runtimeIdentity: object
): { readonly plan: PreparedPlan<Query>; readonly initialInput: DatabaseQueryMaintenanceInput<Query, Projection> } => ({
  plan,
  initialInput,
  [maintenanceRuntimeIdentity]: runtimeIdentity
} as InternalCreateDatabaseQueryMaintenanceInput<Query, Projection>);

export const getIncrementalMaintenanceDiagnostics = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>,
  runtimes: Iterable<{ readonly identity: object }>
): readonly QueryMaintenanceDiagnostics[] => {
  const branded = (factory as Partial<IncrementalDatabaseQueryMaintenanceFactory>)[incrementalMaintenanceFactoryBrand];
  return branded === undefined || typeof branded.getDiagnostics !== 'function'
    ? []
    : Object.freeze([...runtimes].flatMap(({ identity }) => branded.getDiagnostics(identity)));
};

export const getIncrementalMaintenanceReuseDiagnostics = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>,
  runtimes: Iterable<{ readonly identity: object }>
): QueryMaintenanceReuseDiagnostics => {
  const branded = (factory as Partial<IncrementalDatabaseQueryMaintenanceFactory>)[incrementalMaintenanceFactoryBrand];
  if (branded === undefined || typeof branded.getReuseDiagnostics !== 'function') {
    return Object.freeze({ computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 });
  }
  let computedFrameDeltaCount = 0;
  let reusedFrameDeltaCount = 0;
  for (const { identity } of runtimes) {
    const diagnostics = branded.getReuseDiagnostics(identity);
    computedFrameDeltaCount += diagnostics.computedFrameDeltaCount;
    reusedFrameDeltaCount += diagnostics.reusedFrameDeltaCount;
  }
  return Object.freeze({ computedFrameDeltaCount, reusedFrameDeltaCount });
};

export const getTrustedIncrementalMetadata = <Query, Row, Projection>(
  factory: CreateDatabaseQueryMaintenance<Query, Row, Projection>,
  result: MaintainedDatabaseQueryResult<Row>
): TrustedIncrementalMetadata | undefined => {
  const candidate = trustedIncrementalResults.get(result as object);
  const expectedOwner = trustedIncrementalFactories.get(factory as object);
  return candidate?.owner === expectedOwner ? candidate : undefined;
};

export const failedMaintenanceSession = <Query, Row, Projection>(error: unknown): DatabaseQueryMaintenanceSession<Query, Row, Projection> => {
  const result = failedEvaluation(error) as MaintainedDatabaseQueryResult<Row>;
  return { getCurrentResult: () => result, updateInput: () => result, close: () => undefined };
};

export const failedEvaluation = (error: unknown): MaintainedDatabaseQueryResult<never> => ({
  rows: [],
  resultKeys: [],
  completeness: 'unknown',
  issues: [createIssue({
    code: 'observer.evaluation_failed',
    phase: 'query',
    severity: 'error',
    retry: 'after_refresh',
    details: { error: error instanceof Error ? error.name : typeof error }
  })]
});

/** Bridges relation projections into the production incremental query graph. */
export const createIncrementalDatabaseQueryMaintenance = (
  functions?: FunctionRegistry
): CreateDatabaseQueryMaintenance<QueryNode, QueryRecord, readonly RelationInput[]> => {
  const scopes = new WeakMap<object, Map<string, PooledDatabaseMaintenanceCohort>>();
  const normalize = createQueryMaintenanceSnapshotNormalizer(functions);
  const trustOwner = Object.freeze({});
  let nextCohortIdentity = 0;
  const factory = ((input) => {
    const { plan, initialInput } = input;
    const runtimeIdentity = (input as Partial<InternalCreateDatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>>)[maintenanceRuntimeIdentity];
    const initial = normalize(initialInput);
    if (runtimeIdentity === undefined) return openPrivateDatabaseMaintenance(plan, initial, normalize, trustOwner);
    let cohorts = scopes.get(runtimeIdentity);
    if (cohorts === undefined) {
      cohorts = new Map();
      scopes.set(runtimeIdentity, cohorts);
    }
    const key = pooledDatabaseCohortKey(plan, initialInput.parameters);
    let cohort = cohorts.get(key);
    const attachesToRejected = cohort?.lastRejected !== undefined
      && sameQueryMaintenanceSnapshot(cohort.lastRejected, initial);
    const attachesToFailed = cohort?.transitionFailure !== undefined
      && cohort.transitionFailure.attachable
      && cohort.transitionFailure.snapshot === initial;
    if (cohort !== undefined && !sameQueryMaintenanceSnapshot(cohort.accepted, initial) && !attachesToRejected && !attachesToFailed) {
      return openPrivateDatabaseMaintenance(plan, initial, normalize, trustOwner);
    }
    if (cohort === undefined) {
      const runtime = createPooledIncrementalQueryRuntime({
        environment: {
          runtimeIdentity: 'cohort:' + String(nextCohortIdentity += 1),
          registryFingerprint: plan.registryFingerprint,
          authorityFingerprint: plan.authorityFingerprint,
          datasetId: plan.datasetId,
          parameters: initialInput.parameters,
          ...(functions === undefined ? {} : { functions })
        },
        initialSnapshot: initial
      });
      cohort = { key, runtime, accepted: initial, roots: 0 };
      cohorts.set(key, cohort);
      try {
        const root = runtime.attach(plan);
        if (hasInvalidIncrementalInput(root.getCurrentResult())) {
          runtime.close();
          if (cohorts.get(key) === cohort) cohorts.delete(key);
          return openPrivateDatabaseMaintenance(plan, initial, normalize, trustOwner);
        }
        cohort.roots += 1;
        return openPooledDatabaseMaintenance({ plan, initial, root, cohort, cohorts, normalize, trustOwner });
      } catch (error) {
        runtime.close();
        if (cohorts.get(key) === cohort) cohorts.delete(key);
        if (!isNonPoolableQueryError(error)) throw error;
        return openPrivateDatabaseMaintenance(plan, initial, normalize, trustOwner);
      }
    }
    try {
      const root = cohort.runtime.attach(plan);
      cohort.roots += 1;
      return openPooledDatabaseMaintenance({ plan, initial: attachesToRejected || attachesToFailed ? cohort.accepted : initial, root, cohort, cohorts, normalize, trustOwner });
    } catch (error) {
      if (!isNonPoolableQueryError(error) && !isPooledQueryRuntimeBusyError(error)) throw error;
      return openPrivateDatabaseMaintenance(plan, initial, normalize, trustOwner);
    }
  }) as IncrementalDatabaseQueryMaintenanceFactory;
  trustedIncrementalFactories.set(factory, trustOwner);
  Object.defineProperty(factory, incrementalMaintenanceFactoryBrand, {
    value: Object.freeze({
      getDiagnostics: (runtimeIdentity: object) => Object.freeze(
        [...(scopes.get(runtimeIdentity)?.values() ?? [])].map(({ runtime }) => runtime.getDiagnostics())
      ),
      getReuseDiagnostics: (runtimeIdentity: object) => normalize.getReuseDiagnostics(runtimeIdentity)
    })
  });
  return factory;
};

const openPooledDatabaseMaintenance = (options: {
  readonly plan: PreparedPlan<QueryNode>;
  readonly initial: QueryMaintenanceSnapshot;
  readonly root: PooledIncrementalQueryRoot;
  readonly cohort: PooledDatabaseMaintenanceCohort;
  readonly cohorts: Map<string, PooledDatabaseMaintenanceCohort>;
  readonly normalize: QueryMaintenanceSnapshotNormalizer;
  readonly trustOwner: object;
}): DatabaseQueryMaintenanceSession<QueryNode, QueryRecord, readonly RelationInput[]> => {
  let localAccepted = options.initial;
  let root: PooledIncrementalQueryRoot | undefined = options.root;
  let privateSession: DatabaseQueryMaintenanceSession<QueryNode, QueryRecord, readonly RelationInput[]> | undefined;
  let closed = false;

  const detach = (): void => {
    if (root === undefined) return;
    root.close();
    root = undefined;
    options.cohort.roots -= 1;
    if (options.cohort.roots !== 0) return;
    options.cohort.runtime.close();
    if (options.cohorts.get(options.cohort.key) === options.cohort) options.cohorts.delete(options.cohort.key);
  };

  return {
    getCurrentResult: () => privateSession === undefined
      ? options.cohort.transitionFailure?.result ?? databaseResultFromMaintained((root ?? options.root).getCurrentResult(), options.trustOwner)
      : privateSession.getCurrentResult(),
    updateInput: (input) => {
      const normalizedNext = options.normalize(input);
      if (privateSession !== undefined) return privateSession.updateInput(input);
      if (options.cohort.transitionFailure !== undefined && normalizedNext === options.cohort.transitionFailure.snapshot) {
        return options.cohort.transitionFailure.result;
      }
      // A new capture frame is a fresh transition attempt. In particular, a
      // source may return directly to the already accepted frame without
      // invoking the physical runtime again.
      delete options.cohort.transitionFailure;
      const returnsToAccepted = sameQueryMaintenanceSnapshot(normalizedNext, options.cohort.accepted);
      if (returnsToAccepted && options.cohort.lastRejected === undefined) {
        localAccepted = normalizedNext;
        return databaseResultFromMaintained((root as PooledIncrementalQueryRoot).getCurrentResult(), options.trustOwner);
      }
      if (!returnsToAccepted && options.cohort.lastRejected !== undefined && sameQueryMaintenanceSnapshot(normalizedNext, options.cohort.lastRejected)) {
        return databaseResultFromMaintained((root as PooledIncrementalQueryRoot).getCurrentResult(), options.trustOwner);
      }
      if (!sameQueryMaintenanceSnapshot(localAccepted, options.cohort.accepted)) {
        detach();
        privateSession = openPrivateDatabaseMaintenance(options.plan, localAccepted, options.normalize, options.trustOwner);
        return privateSession.updateInput(input);
      }
      const updatingRoot = root ?? options.root;
      const rejectedBefore = options.cohort.runtime.getDiagnostics().rejectedUpdateCount;
      let delta: QueryMaintenanceSnapshotDiff;
      try {
        delta = options.normalize.diff(options.cohort.accepted, normalizedNext);
      } catch (error) {
        const result = failedEvaluation(error) as MaintainedDatabaseQueryResult<QueryRecord>;
        options.cohort.transitionFailure = { snapshot: normalizedNext, result, attachable: false };
        return result;
      }
      try {
        options.cohort.runtime.applyUpdate(delta.update);
      } catch (error) {
        const result = failedEvaluation(error) as MaintainedDatabaseQueryResult<QueryRecord>;
        options.cohort.transitionFailure = { snapshot: normalizedNext, result, attachable: true };
        return result;
      }
      delete options.cohort.transitionFailure;
      if (options.cohort.runtime.getDiagnostics().rejectedUpdateCount === rejectedBefore) {
        delta.accept();
        options.cohort.accepted = normalizedNext;
        delete options.cohort.lastRejected;
        localAccepted = normalizedNext;
      } else {
        options.cohort.lastRejected = normalizedNext;
      }
      return databaseResultFromMaintained(updatingRoot.getCurrentResult(), options.trustOwner);
    },
    close: () => {
      if (closed) return;
      closed = true;
      privateSession?.close();
      detach();
    }
  };
};

const openPrivateDatabaseMaintenance = (
  plan: PreparedPlan<QueryNode>,
  initial: QueryMaintenanceSnapshot,
  normalize: QueryMaintenanceSnapshotNormalizer,
  trustOwner: object
): DatabaseQueryMaintenanceSession<QueryNode, QueryRecord, readonly RelationInput[]> => {
  let accepted = initial;
  let session = openIncrementalQueryMaintenance(plan, accepted);
  return {
    getCurrentResult: () => databaseResultFromMaintained(session.getCurrentResult(), trustOwner),
    updateInput: (input) => {
      const next = normalize(input);
      let update: ReturnType<typeof diffQueryMaintenanceSnapshots>;
      try {
        update = diffQueryMaintenanceSnapshots(accepted, next);
      } catch (error) {
        // Verify the fixed session environment without traversing relation
        // rows; malformed accepted occurrence identity is classified from the
        // incremental session's validation evidence below.
        try {
          diffQueryMaintenanceSnapshots(
            { ...accepted, relations: [] },
            { ...next, relations: [] }
          );
        } catch {
          throw error;
        }
        const acceptedIsInvalid = hasInvalidIncrementalInput(session.getCurrentResult());
        if (!acceptedIsInvalid) throw error;
        // An invalid initial snapshot can make an exact delta impossible to
        // construct. Rebase the private fallback so a later valid source
        // snapshot can recover instead of remaining pinned to malformed input.
        try { session.close(); } catch { /* replacement must not depend on cleanup */ }
        accepted = next;
        session = openIncrementalQueryMaintenance(plan, accepted);
        return databaseResultFromMaintained(session.getCurrentResult(), trustOwner);
      }
      const rejectedBefore = session.getCurrentResult().state.rejectedUpdateCount;
      const result = session.applyUpdate(update);
      if (result.state.rejectedUpdateCount === rejectedBefore) accepted = next;
      return databaseResultFromMaintained(result, trustOwner);
    },
    close: () => session.close()
  };
};

const databaseResultFromMaintained = ({ state, rows, resultKeys, completeness, issues }: IncrementalQueryResult, owner: object): MaintainedDatabaseQueryResult<QueryRecord> => {
  const result = Object.freeze({ rows, resultKeys, completeness, issues });
  let resultKeyPositions = resultKeyPositionCache.get(resultKeys);
  if (resultKeyPositions === undefined) {
    resultKeyPositions = new Map(resultKeys.map((key, position) => [key, position]));
    resultKeyPositionCache.set(resultKeys, resultKeyPositions);
  }
  trustedIncrementalResults.set(result, Object.freeze({ revision: state.revision, resultDelta: state.resultDelta, resultKeyPositions, owner }));
  return result;
};

const hasInvalidIncrementalInput = (result: IncrementalQueryResult): boolean => result.issues.some(({ code }) =>
  code === 'query.incremental_relation_ambiguous' || code === 'query.incremental_identity_invalid'
);

const pooledDatabaseCohortKey = (
  plan: PreparedPlan<QueryNode>,
  parameters: Readonly<Record<string, JsonValue>>
): string => canonicalizeJson([
  plan.datasetId,
  plan.authorityFingerprint,
  plan.registryFingerprint,
  parameters
] as JsonValue);

const sameQueryMaintenanceSnapshot = (left: QueryMaintenanceSnapshot, right: QueryMaintenanceSnapshot): boolean => {
  if (left === right) return true;
  // Basis and membership evidence are cheap, high-selectivity guards. Avoid
  // canonicalizing every relation row for the normal new-basis transition.
  // Occurrence identity was descriptor-safely adopted once when the capture
  // frame was built, so new-basis transitions need no source-owned traversal.
  if (left.membershipRevision !== right.membershipRevision || !samePortableObserverValue(left.basis, right.basis)) return false;
  if (!samePortableObserverValue(left.parameters, right.parameters)) return false;
  return samePortableObserverValue(left.relations, right.relations);
};
