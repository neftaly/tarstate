import { canonicalizeJson } from './artifacts.js';
import {
  type DatasetMembership,
  type DatasetSnapshot,
  type AttachmentCatalog,
  type SourceFreshness,
  type SourceLifecycleState
} from './database.js';
import { createIssue, type Issue } from './issues.js';
import {
  DatasetCaptureRuntime,
  type AvailableQueryAttachment,
  type CapturedMember,
  type EvaluationSnapshot
} from './internal-observer-dataset-capture.js';
import {
  notifyObservers,
  runObserverCleanups,
  type ObserverDiagnosticReporter
} from './observer-diagnostics.js';
import type { PreparedPlan, SourceBasis } from './maintenance.js';
import { assertPreparedPlan } from './internal-prepared-plan.js';
import { adoptQueryOccurrenceIds } from './internal-query-ownership.js';
import { deepFreezeObserverValue, detachPreparedPlan, parseObservationParameters, samePortableObserverValue } from './internal-observer-values.js';
import {
  diffQueryMaintenanceSnapshots,
  createPooledIncrementalQueryRuntime,
  isNonPoolableQueryError,
  isPooledQueryRuntimeBusyError,
  openIncrementalQueryMaintenance,
  type FunctionRegistry,
  type IncrementalQueryResult,
  type PooledIncrementalQueryDiagnostics,
  type PooledIncrementalQueryRoot,
  type PooledIncrementalQueryRuntime,
  type QueryMaintenanceUpdate,
  type QueryMaintenanceSnapshot,
  type QueryNode,
  type QueryRecord,
  type RelationInput
} from './query.js';
import type { JsonValue } from './value.js';

export type { AvailableQueryAttachment } from './internal-observer-dataset-capture.js';

export type ObservationBasis = {
  readonly dataset: { readonly datasetId: string; readonly revision: number };
  readonly attachments: readonly {
    readonly attachmentId: string;
    readonly sourceId: string;
    readonly basis: SourceBasis;
  }[];
};

export type SourceEvidence = {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly expectation: 'required' | 'optional';
  readonly discoveryEdges: readonly string[];
  readonly state: SourceLifecycleState | 'missing';
  readonly freshness: SourceFreshness;
  readonly authorized: boolean;
  readonly basis?: SourceBasis;
  readonly issues: readonly Issue[];
};

/** Immutable query evidence at one database/attachment basis. Result keys are opaque UI/diff identities, not write locators. */
export type ObservedQueryResult<Row> = {
  readonly readiness: 'ready' | 'incomplete' | 'invalid';
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly freshness: 'current' | 'stale' | 'mixed' | 'none';
  readonly basis: ObservationBasis;
  readonly sourceStates: readonly SourceEvidence[];
  readonly issues: readonly Issue[];
};

/** Current observer state; `lastExact` is retained evidence and must be requested explicitly by consumers. */
export type ObserverSnapshot<Row> =
  | { readonly state: 'open'; readonly current: ObservedQueryResult<Row>; readonly lastExact?: ObservedQueryResult<Row> }
  | { readonly state: 'closed' };

export type ResultDiff<Row> = {
  readonly added: readonly { readonly key: string; readonly row: Row }[];
  readonly removed: readonly { readonly key: string; readonly row: Row }[];
  readonly updated: readonly { readonly key: string; readonly before: Row; readonly after: Row }[];
};

/** A proven row diff, an evidence withdrawal, or a full reset. */
export type ObserverChange<Row> =
  | { readonly kind: 'diff'; readonly diff: ResultDiff<Row>; readonly snapshot: ObserverSnapshot<Row> }
  | { readonly kind: 'invalidation'; readonly snapshot: ObserverSnapshot<Row> }
  | { readonly kind: 'reset'; readonly snapshot: ObserverSnapshot<Row> };

/** Closeable synchronous snapshot source. Closing an observer does not close its database or sources. */
export interface QueryObserver<Row> {
  getSnapshot(): ObserverSnapshot<Row>;
  subscribe(listener: (change: ObserverChange<Row>) => void): () => void;
  close(): void;
}

export type DatabaseQueryMaintenanceInput<Query, Projection> = {
  readonly query: Query;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly dataset: DatasetSnapshot;
  readonly attachments: readonly AvailableQueryAttachment<Projection>[];
};

export type MaintainedDatabaseQueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export interface DatabaseQueryMaintenanceSession<Query, Row, Projection> {
  getCurrentResult(): MaintainedDatabaseQueryResult<Row>;
  updateInput(input: DatabaseQueryMaintenanceInput<Query, Projection>): MaintainedDatabaseQueryResult<Row>;
  close(): void;
}

export type CreateDatabaseQueryMaintenance<Query, Row, Projection> = (input: {
  readonly plan: PreparedPlan<Query>;
  readonly initialInput: DatabaseQueryMaintenanceInput<Query, Projection>;
}) => DatabaseQueryMaintenanceSession<Query, Row, Projection>;

/** Frozen physical counters for one active shared query-maintenance cohort. */
export type QueryMaintenanceDiagnostics = PooledIncrementalQueryDiagnostics;
/** Frame-delta computations shared across parameter cohorts in this database view. */
export type QueryMaintenanceReuseDiagnostics = {
  readonly computedFrameDeltaCount: number;
  readonly reusedFrameDeltaCount: number;
};

const incrementalMaintenanceFactoryBrand = Symbol('tarstate.incremental-maintenance-factory');
const maintenanceRuntimeIdentity = Symbol('tarstate.maintenance-runtime');
type TrustedIncrementalMetadata = Readonly<Pick<IncrementalQueryResult['state'], 'revision' | 'resultDelta'> & { readonly owner: object }>;
const trustedIncrementalResults = new WeakMap<object, TrustedIncrementalMetadata>();
const trustedObservedResults = new WeakMap<object, TrustedIncrementalMetadata>();
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

export type DatabaseViewOptions<Query, Row, Projection> = {
  readonly authorityScope: string;
  readonly authorityFingerprint: string;
  readonly registryFingerprint: string;
  readonly attachments: AttachmentCatalog;
  readonly datasets: readonly DatasetMembership[];
  readonly canRead: (viewAuthorityScope: string, attachmentAuthorityScope: string, attachmentId: string) => boolean;
  readonly createQueryMaintenance: CreateDatabaseQueryMaintenance<Query, Row, Projection>;
  /** Receives contained listener and lifecycle-cleanup failures. */
  readonly onDiagnostic?: ObserverDiagnosticReporter;
  /** Already authority-filtered portable input consumed by optional tooling. */
  readonly getDatabaseDescriptionSnapshot?: () => JsonValue;
};

/** Prepared query identity plus bound parameters and an explicit partial-evidence opt-in. */
export type ObserveRequest<Query> = {
  readonly plan: PreparedPlan<Query>;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly allowPartial?: boolean;
};

/** Canonical cache key for every field that changes observation semantics. */
export const queryObservationKey = <Query>(
  database: { readonly authorityScope: string; readonly authorityFingerprint: string; readonly registryFingerprint: string },
  request: ObserveRequest<Query>
): string => canonicalizeJson([
  request.plan.planId,
  request.plan.rootNodeId,
  request.plan.query,
  request.parameters ?? {},
  database.authorityScope,
  database.authorityFingerprint,
  database.registryFingerprint,
  request.plan.datasetId,
  request.allowPartial === true
] as JsonValue);

/** Authority-filtered database shell with one shared maintenance session per observation identity. */
export class DatabaseView<Query, Row, Projection = unknown> {
  readonly authorityScope: string;
  readonly authorityFingerprint: string;
  readonly registryFingerprint: string;
  readonly #attachments: AttachmentCatalog;
  readonly #datasets: ReadonlyMap<string, DatasetMembership>;
  readonly #canRead: DatabaseViewOptions<Query, Row, Projection>['canRead'];
  readonly #createQueryMaintenance: DatabaseViewOptions<Query, Row, Projection>['createQueryMaintenance'];
  readonly #getDatabaseDescriptionSnapshot: (() => JsonValue) | undefined;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  readonly #cache = new Map<string, SharedObservation<Query, Row, Projection>>();
  readonly #datasetRuntimes = new Map<string, DatasetCaptureRuntime<Projection>>();
  #closed = false;

  constructor(options: DatabaseViewOptions<Query, Row, Projection>) {
    this.authorityScope = options.authorityScope;
    this.authorityFingerprint = options.authorityFingerprint;
    this.registryFingerprint = options.registryFingerprint;
    this.#attachments = options.attachments;
    this.#datasets = new Map(options.datasets.map((dataset) => [dataset.datasetId, dataset]));
    this.#canRead = options.canRead;
    this.#createQueryMaintenance = options.createQueryMaintenance;
    this.#onDiagnostic = options.onDiagnostic;
    this.#getDatabaseDescriptionSnapshot = options.getDatabaseDescriptionSnapshot;
  }

  observe(request: ObserveRequest<Query>): QueryObserver<Row> {
    if (this.#closed) throw new Error('Database view is closed');
    assertPreparedPlan(request.plan);
    if (request.plan.registryFingerprint !== this.registryFingerprint) throw new Error('Prepared plan registry fingerprint does not match database view');
    if (request.plan.authorityFingerprint !== this.authorityFingerprint) throw new Error('Prepared plan authority fingerprint does not match database view');
    const dataset = this.#datasets.get(request.plan.datasetId);
    if (dataset === undefined) throw new Error('Dataset is not part of this database view: ' + request.plan.datasetId);
    const plan = detachPreparedPlan(request.plan);
    const parameters = parseObservationParameters(request.parameters ?? {});
    const key = queryObservationKey(this, { ...request, plan, parameters });
    let shared = this.#cache.get(key);
    if (shared === undefined) {
      let runtime = this.#datasetRuntimes.get(dataset.datasetId);
      if (runtime === undefined) {
        runtime = new DatasetCaptureRuntime({
          dataset,
          attachments: this.#attachments,
          authorityScope: this.authorityScope,
          canRead: this.#canRead,
          ...(this.#onDiagnostic === undefined ? {} : { onDiagnostic: this.#onDiagnostic }),
          collect: () => {
            if (this.#datasetRuntimes.get(dataset.datasetId) === runtime) this.#datasetRuntimes.delete(dataset.datasetId);
          }
        });
        this.#datasetRuntimes.set(dataset.datasetId, runtime);
      }
      try {
        shared = new SharedObservation({
          plan,
          parameters,
          allowPartial: request.allowPartial === true,
          runtime,
          createQueryMaintenance: this.#createQueryMaintenance,
          ...(this.#onDiagnostic === undefined ? {} : { onDiagnostic: this.#onDiagnostic }),
          collect: () => {
            if (this.#cache.get(key) === shared) this.#cache.delete(key);
          }
        });
      } catch (error) {
        runtime.closeIfUnused();
        throw error;
      }
      this.#cache.set(key, shared);
    }
    return shared.acquire();
  }

  getActiveMaintenanceCount(): number { return this.#cache.size; }

  /** Optional physical IVM counters; custom maintenance factories return no entries. */
  getQueryMaintenanceDiagnostics(): readonly QueryMaintenanceDiagnostics[] {
    const branded = (this.#createQueryMaintenance as Partial<IncrementalDatabaseQueryMaintenanceFactory>)[incrementalMaintenanceFactoryBrand];
    if (branded === undefined || typeof branded.getDiagnostics !== 'function') return [];
    return Object.freeze([...this.#datasetRuntimes.values()].flatMap((runtime) => branded.getDiagnostics(runtime.identity)));
  }

  getQueryMaintenanceReuseDiagnostics(): QueryMaintenanceReuseDiagnostics {
    const branded = (this.#createQueryMaintenance as Partial<IncrementalDatabaseQueryMaintenanceFactory>)[incrementalMaintenanceFactoryBrand];
    if (branded === undefined || typeof branded.getReuseDiagnostics !== 'function') {
      return Object.freeze({ computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 });
    }
    let computedFrameDeltaCount = 0;
    let reusedFrameDeltaCount = 0;
    for (const runtime of this.#datasetRuntimes.values()) {
      const diagnostics = branded.getReuseDiagnostics(runtime.identity);
      computedFrameDeltaCount += diagnostics.computedFrameDeltaCount;
      reusedFrameDeltaCount += diagnostics.reusedFrameDeltaCount;
    }
    return Object.freeze({ computedFrameDeltaCount, reusedFrameDeltaCount });
  }

  getDatabaseDescriptionSnapshot(): JsonValue | undefined {
    return this.#getDatabaseDescriptionSnapshot?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    runObserverCleanups(
      Array.from(this.#cache.values(), (shared) => () => shared.close()),
      { component: 'database-view', operation: 'close-observations' },
      this.#onDiagnostic
    );
    this.#cache.clear();
    runObserverCleanups(
      Array.from(this.#datasetRuntimes.values(), (runtime) => () => runtime.close()),
      { component: 'database-view', operation: 'close-dataset-runtimes' },
      this.#onDiagnostic
    );
    this.#datasetRuntimes.clear();
  }
}

const captureFrameMetadata = Symbol('tarstate.capture-frame');
type CaptureFrameMetadata = { readonly frameIdentity: object; readonly parameterKey: string; readonly runtimeIdentity: object };
type InternalDatabaseQueryMaintenanceInput<Query, Projection> = DatabaseQueryMaintenanceInput<Query, Projection> & {
  readonly [captureFrameMetadata]: CaptureFrameMetadata;
};

type SharedOptions<Query, Row, Projection> = {
  readonly plan: PreparedPlan<Query>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly allowPartial: boolean;
  readonly runtime: DatasetCaptureRuntime<Projection>;
  readonly createQueryMaintenance: DatabaseViewOptions<Query, Row, Projection>['createQueryMaintenance'];
  readonly collect: () => void;
  readonly onDiagnostic?: ObserverDiagnosticReporter;
};

class SharedObservation<Query, Row, Projection> {
  readonly #options: SharedOptions<Query, Row, Projection>;
  readonly #leases = new Set<ObserverLease<Row>>();
  #session: DatabaseQueryMaintenanceSession<Query, Row, Projection> | undefined;
  #snapshot!: ObserverSnapshot<Row>;
  #publishedSnapshot!: ObserverSnapshot<Row>;
  #stagedChange: ObserverChange<Row> | undefined;
  readonly #parameterKey: string;
  #closed = false;

  constructor(options: SharedOptions<Query, Row, Projection>) {
    this.#options = options;
    this.#parameterKey = canonicalizeJson(options.parameters as JsonValue);
    const capturedState = options.runtime.state();
    const captured = capturedState.captured;
    const session = this.#openMaintenance(captured);
    this.#session = session;
    let added = false;
    try {
      const initial = capturedState.state === 'captured'
        ? session.getCurrentResult()
        : failedEvaluation(capturedState.error) as MaintainedDatabaseQueryResult<Row>;
      this.#snapshot = this.#observerSnapshot(this.#result(initial, captured), undefined);
      this.#publishedSnapshot = this.#snapshot;
      options.runtime.add(this);
      added = true;
      const latest = options.runtime.state();
      if (latest !== capturedState) {
        if (latest.state === 'captured') this.stage(latest.captured);
        else this.stageFailure(latest.captured, latest.error);
        this.#publishedSnapshot = this.#snapshot;
        this.#stagedChange = undefined;
      }
    } catch (error) {
      this.#closed = true;
      this.#session = undefined;
      runObserverCleanups([() => session.close()], {
        component: 'database-view', operation: 'rollback-maintenance-construction'
      }, options.onDiagnostic);
      if (added) options.runtime.remove(this);
      throw error;
    }
  }

  acquire(): QueryObserver<Row> {
    if (this.#closed) throw new Error('Shared observation is closed');
    const lease = new ObserverLease(this, this.#publishedSnapshot, this.#options.onDiagnostic);
    this.#leases.add(lease);
    return lease;
  }

  release(lease: ObserverLease<Row>): void {
    if (!this.#leases.delete(lease)) return;
    if (this.#leases.size === 0) this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const session = this.#session;
    this.#session = undefined;
    if (session !== undefined) runObserverCleanups([() => session.close()], {
      component: 'database-view', operation: 'close-maintenance'
    }, this.#options.onDiagnostic);
    try {
      this.#options.runtime.remove(this);
    } finally {
      this.#snapshot = closedSnapshot as ObserverSnapshot<Row>;
      for (const lease of Array.from(this.#leases)) lease.closeFromShared();
      this.#leases.clear();
      this.#options.collect();
    }
  }

  stage(captured: EvaluationSnapshot<Projection>): void {
    this.#stagedChange = undefined;
    if (this.#closed) return;
    const session = this.#session;
    if (session === undefined) return;
    const maintained = this.#updateMaintenance(session, captured);
    if (this.#closed) return;
    this.#stageMaintained(captured, maintained);
  }

  stageFailure(captured: EvaluationSnapshot<Projection>, error: unknown): void {
    this.#stagedChange = undefined;
    if (this.#closed) return;
    this.#stageMaintained(captured, failedEvaluation(error) as MaintainedDatabaseQueryResult<Row>);
  }

  #stageMaintained(captured: EvaluationSnapshot<Projection>, maintained: MaintainedDatabaseQueryResult<Row>): void {
    const current = this.#result(maintained, captured);
    const previousSnapshot = this.#snapshot;
    if (previousSnapshot.state !== 'open') return;
    const nextSnapshot = this.#observerSnapshot(current, previousSnapshot);
    if (sameObserverSnapshot(this.#publishedSnapshot, nextSnapshot)) {
      this.#snapshot = this.#publishedSnapshot;
      return;
    }
    this.#snapshot = nextSnapshot;
    this.#stagedChange = observerChange(this.#publishedSnapshot, nextSnapshot);
  }

  preparePublish(): void {
    if (this.#closed || this.#stagedChange === undefined) return;
    for (const lease of Array.from(this.#leases)) lease.stage(this.#snapshot);
  }

  publish(): void {
    const change = this.#stagedChange;
    this.#stagedChange = undefined;
    if (this.#closed || change === undefined) return;
    this.#publishedSnapshot = this.#snapshot;
    // Leases can be acquired after the dataset-wide prepare phase by an
    // earlier root's listener. Bring every current lease to this publication
    // before notifying any of them.
    for (const lease of Array.from(this.#leases)) lease.stage(this.#snapshot);
    for (const lease of Array.from(this.#leases)) lease.publish(change);
  }

  #maintenanceInput(captured: EvaluationSnapshot<Projection>): DatabaseQueryMaintenanceInput<Query, Projection> {
    return {
      query: this.#options.plan.query,
      parameters: this.#options.parameters,
      dataset: captured.dataset,
      attachments: captured.available,
      [captureFrameMetadata]: Object.freeze({
        frameIdentity: captured.identity,
        parameterKey: this.#parameterKey,
        runtimeIdentity: this.#options.runtime.identity
      })
    } as InternalDatabaseQueryMaintenanceInput<Query, Projection>;
  }

  #openMaintenance(captured: EvaluationSnapshot<Projection>): DatabaseQueryMaintenanceSession<Query, Row, Projection> {
    try {
      return this.#options.createQueryMaintenance({
        plan: this.#options.plan,
        initialInput: this.#maintenanceInput(captured),
        [maintenanceRuntimeIdentity]: this.#options.runtime.identity
      } as InternalCreateDatabaseQueryMaintenanceInput<Query, Projection>);
    } catch (error) {
      return failedMaintenanceSession<Query, Row, Projection>(error);
    }
  }

  #updateMaintenance(session: DatabaseQueryMaintenanceSession<Query, Row, Projection>, captured: EvaluationSnapshot<Projection>): MaintainedDatabaseQueryResult<Row> {
    try {
      return session.updateInput(this.#maintenanceInput(captured));
    } catch (error) {
      return failedEvaluation(error);
    }
  }

  #result(maintained: MaintainedDatabaseQueryResult<Row>, captured: EvaluationSnapshot<Projection>): ObservedQueryResult<Row> {
    const candidateIncremental = trustedIncrementalResults.get(maintained as object);
    const expectedOwner = trustedIncrementalFactories.get(this.#options.createQueryMaintenance as object);
    const trustedIncremental = candidateIncremental?.owner === expectedOwner ? candidateIncremental : undefined;
    const evidence = captured.members.map(sourceEvidence);
    const evidenceIssues = evidence.flatMap(({ issues }) => issues);
    const membershipIssue = captured.dataset.state === 'open'
      ? [observationIssue('observer.membership_open', 'after_refresh', { datasetId: captured.dataset.datasetId, revision: captured.dataset.revision })]
      : [];
    const resultIdentityIssue = trustedIncremental !== undefined || (maintained.rows.length === maintained.resultKeys.length && new Set(maintained.resultKeys).size === maintained.resultKeys.length)
      ? []
      : [observationIssue('observer.evaluation_failed', 'after_refresh', { reason: 'invalid_result_identity' })];
    const requiredProjectionInvalid = captured.members.some((candidate) =>
      candidate.member.expectation === 'required' &&
      candidate.snapshot?.state === 'ready' &&
      candidate.projection?.state === 'failed'
    );
    const evaluationInvalid = resultIdentityIssue.length > 0 || maintained.issues.some(({ code }) => code === 'observer.evaluation_failed');
    const requiredUnavailable = evidence.some((item) => item.expectation === 'required' && (item.state !== 'ready' || !item.authorized));
    const inputsIncomplete = captured.dataset.state !== 'settled' || requiredUnavailable || evaluationInvalid;
    let completeness = maintained.completeness;
    if (inputsIncomplete && !(this.#options.allowPartial && completeness === 'lower-bound')) completeness = 'unknown';
    const rows = completeness === 'unknown' ? [] : maintained.rows;
    const resultKeys = completeness === 'unknown' ? [] : maintained.resultKeys;
    const readiness = requiredProjectionInvalid || evaluationInvalid
      ? 'invalid'
      : completeness === 'exact' ? 'ready' : 'incomplete';
    const basisAttachments = captured.members.flatMap((candidate) => candidate.snapshot === undefined ? [] : [{
      attachmentId: candidate.member.attachmentId,
      sourceId: candidate.member.sourceId,
      basis: candidate.snapshot.basis
    }]);
    const result = {
      readiness,
      rows,
      resultKeys,
      completeness,
      freshness: compositeFreshness(evidence),
      basis: {
        dataset: { datasetId: captured.dataset.datasetId, revision: captured.dataset.revision },
        attachments: basisAttachments
      },
      sourceStates: evidence,
      issues: [...evidenceIssues, ...membershipIssue, ...resultIdentityIssue, ...maintained.issues]
    } satisfies ObservedQueryResult<Row>;
    if (trustedIncremental === undefined || completeness === 'unknown' || rows !== maintained.rows || resultKeys !== maintained.resultKeys) {
      return freezeResult(result);
    }
    const metadata = deepFreezeObserverValue({
      readiness: result.readiness,
      completeness: result.completeness,
      freshness: result.freshness,
      basis: result.basis,
      sourceStates: result.sourceStates,
      issues: result.issues
    });
    const trusted = Object.freeze({ ...metadata, rows, resultKeys }) as ObservedQueryResult<Row>;
    trustedObservedResults.set(trusted, trustedIncremental);
    return trusted;
  }

  #observerSnapshot(current: ObservedQueryResult<Row>, previous: ObserverSnapshot<Row> | undefined): ObserverSnapshot<Row> {
    if (current.completeness === 'exact') return Object.freeze({ state: 'open', current, lastExact: current });
    const previousExact = previous?.state === 'open' ? previous.lastExact : undefined;
    const lastExact = previousExact === undefined ? undefined : staleResult(previousExact);
    return Object.freeze({ state: 'open', current, ...(lastExact === undefined ? {} : { lastExact }) });
  }
}

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

const queryMaintenanceFrameIdentity = Symbol('tarstate.query-maintenance-frame');
type FramedQueryMaintenanceSnapshot = QueryMaintenanceSnapshot & {
  readonly [queryMaintenanceFrameIdentity]: {
    readonly frameIdentity: object;
    readonly runtimeIdentity: object;
  };
};
type QueryMaintenanceSnapshotDiff = {
  readonly update: QueryMaintenanceUpdate;
  /** Publishes a reusable delta only after its physical application was accepted. */
  readonly accept: () => void;
};
type QueryMaintenanceSnapshotNormalizer = {
  (input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>): QueryMaintenanceSnapshot;
  readonly diff: (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot) => QueryMaintenanceSnapshotDiff;
  readonly getReuseDiagnostics: (runtimeIdentity: object) => QueryMaintenanceReuseDiagnostics;
};

const createQueryMaintenanceSnapshotNormalizer = (functions: FunctionRegistry | undefined): QueryMaintenanceSnapshotNormalizer => {
  const maxParameterSnapshotsPerFrame = 256;
  const frames = new WeakMap<object, {
    readonly normalized: Pick<QueryMaintenanceSnapshot, 'relations' | 'basis' | 'membershipRevision'>;
    readonly parameters: Map<string, QueryMaintenanceSnapshot>;
  }>();
  const deltas = new WeakMap<object, WeakMap<object, QueryMaintenanceUpdate>>();
  const reuseDiagnostics = new WeakMap<object, { computedFrameDeltaCount: number; reusedFrameDeltaCount: number }>();
  const normalize = (input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>): QueryMaintenanceSnapshot => {
    const metadata = (input as Partial<InternalDatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>>)[captureFrameMetadata];
    if (metadata === undefined) return normalizeQueryMaintenanceSnapshot(input, functions);
    let frame = frames.get(metadata.frameIdentity);
    if (frame === undefined) {
      frame = { normalized: normalizeQueryMaintenanceFrame(input), parameters: new Map() };
      frames.set(metadata.frameIdentity, frame);
    }
    const cached = frame.parameters.get(metadata.parameterKey);
    if (cached !== undefined) {
      // Map insertion order is the deterministic recency list.
      frame.parameters.delete(metadata.parameterKey);
      frame.parameters.set(metadata.parameterKey, cached);
      return cached;
    }
    const normalized: FramedQueryMaintenanceSnapshot = {
      ...frame.normalized,
      parameters: input.parameters,
      ...(functions === undefined ? {} : { functions }),
      [queryMaintenanceFrameIdentity]: Object.freeze({
        frameIdentity: metadata.frameIdentity,
        runtimeIdentity: metadata.runtimeIdentity
      })
    };
    if (frame.parameters.size >= maxParameterSnapshotsPerFrame) {
      const leastRecentlyUsed = frame.parameters.keys().next().value;
      if (leastRecentlyUsed !== undefined) frame.parameters.delete(leastRecentlyUsed);
    }
    frame.parameters.set(metadata.parameterKey, normalized);
    return normalized;
  };
  normalize.diff = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): QueryMaintenanceSnapshotDiff => {
    const previousMetadata = (previous as Partial<FramedQueryMaintenanceSnapshot>)[queryMaintenanceFrameIdentity];
    const nextMetadata = (next as Partial<FramedQueryMaintenanceSnapshot>)[queryMaintenanceFrameIdentity];
    if (previousMetadata === undefined || nextMetadata === undefined || previousMetadata.runtimeIdentity !== nextMetadata.runtimeIdentity) {
      return { update: diffQueryMaintenanceSnapshots(previous, next), accept: () => undefined };
    }
    const { frameIdentity: previousFrame, runtimeIdentity } = previousMetadata;
    const { frameIdentity: nextFrame } = nextMetadata;

    // Parameters and capabilities remain cohort-local even though the captured
    // relation frame is shared. Validate them before consulting the frame cache.
    diffQueryMaintenanceSnapshots({ ...previous, relations: [] }, { ...next, relations: [] });
    const prior = deltas.get(previousFrame)?.get(nextFrame);
    if (prior !== undefined) {
      const diagnostics = reuseDiagnostics.get(runtimeIdentity) ?? { computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 };
      diagnostics.reusedFrameDeltaCount += 1;
      reuseDiagnostics.set(runtimeIdentity, diagnostics);
      return { update: prior, accept: () => undefined };
    }

    const update = freezeQueryMaintenanceUpdate(diffQueryMaintenanceSnapshots(previous, next));
    const diagnostics = reuseDiagnostics.get(runtimeIdentity) ?? { computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 };
    diagnostics.computedFrameDeltaCount += 1;
    reuseDiagnostics.set(runtimeIdentity, diagnostics);
    return {
      update,
      accept: () => {
        let from = deltas.get(previousFrame);
        if (from === undefined) {
          from = new WeakMap();
          deltas.set(previousFrame, from);
        }
        if (!from.has(nextFrame)) from.set(nextFrame, update);
      }
    };
  };
  normalize.getReuseDiagnostics = (runtimeIdentity: object) => Object.freeze({
    computedFrameDeltaCount: reuseDiagnostics.get(runtimeIdentity)?.computedFrameDeltaCount ?? 0,
    reusedFrameDeltaCount: reuseDiagnostics.get(runtimeIdentity)?.reusedFrameDeltaCount ?? 0
  });
  return normalize;
};

const freezeQueryMaintenanceUpdate = (update: QueryMaintenanceUpdate): QueryMaintenanceUpdate => deepFreezeObserverValue(update);

const normalizeQueryMaintenanceSnapshot = (
  input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>,
  functions: FunctionRegistry | undefined
): QueryMaintenanceSnapshot => ({
  ...normalizeQueryMaintenanceFrame(input),
  parameters: input.parameters,
  ...(functions === undefined ? {} : { functions })
});

const normalizeQueryMaintenanceFrame = (
  input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>
): Pick<QueryMaintenanceSnapshot, 'relations' | 'basis' | 'membershipRevision'> => ({
  relations: input.attachments.flatMap(({ member, snapshot, projection }) => projection.map((relation) => ({
    ...relation,
    ...(relation.occurrenceIds === undefined ? {} : { occurrenceIds: adoptQueryOccurrenceIds(relation.occurrenceIds) }),
    sourceId: member.sourceId,
    attachmentId: member.attachmentId,
    basis: snapshot.basis
  }))),
  basis: {
    dataset: { datasetId: input.dataset.datasetId, revision: input.dataset.revision },
    attachments: input.attachments.map(({ member, snapshot }) => ({ attachmentId: member.attachmentId, sourceId: member.sourceId, basis: snapshot.basis }))
  },
  membershipRevision: input.dataset.revision
});

const databaseResultFromMaintained = ({ state, rows, resultKeys, completeness, issues }: IncrementalQueryResult, owner: object): MaintainedDatabaseQueryResult<QueryRecord> => {
  const result = Object.freeze({ rows, resultKeys, completeness, issues });
  trustedIncrementalResults.set(result, Object.freeze({ revision: state.revision, resultDelta: state.resultDelta, owner }));
  return result;
};

const failedMaintenanceSession = <Query, Row, Projection>(error: unknown): DatabaseQueryMaintenanceSession<Query, Row, Projection> => {
  const result = failedEvaluation(error) as MaintainedDatabaseQueryResult<Row>;
  return { getCurrentResult: () => result, updateInput: () => result, close: () => undefined };
};

const failedEvaluation = (error: unknown): MaintainedDatabaseQueryResult<never> => ({
  rows: [],
  resultKeys: [],
  completeness: 'unknown',
  issues: [observationIssue('observer.evaluation_failed', 'after_refresh', { error: error instanceof Error ? error.name : typeof error })]
});

const closedSnapshot: ObserverSnapshot<never> = Object.freeze({ state: 'closed' });

type ObserverLeaseOwner<Row> = { readonly release: (lease: ObserverLease<Row>) => void };

class ObserverLease<Row> implements QueryObserver<Row> {
  #shared: ObserverLeaseOwner<Row> | undefined;
  readonly #listeners = new Set<(change: ObserverChange<Row>) => void>();
  #snapshot: ObserverSnapshot<Row>;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  #closed = false;

  constructor(shared: ObserverLeaseOwner<Row>, snapshot: ObserverSnapshot<Row>, onDiagnostic?: ObserverDiagnosticReporter) {
    this.#shared = shared;
    this.#snapshot = snapshot;
    this.#onDiagnostic = onDiagnostic;
  }

  getSnapshot(): ObserverSnapshot<Row> { return this.#snapshot; }

  subscribe(listener: (change: ObserverChange<Row>) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#snapshot = closedSnapshot as ObserverSnapshot<Row>;
    const shared = this.#shared;
    this.#shared = undefined;
    shared?.release(this);
  }

  closeFromShared(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#snapshot = closedSnapshot as ObserverSnapshot<Row>;
    this.#shared = undefined;
  }

  stage(snapshot: ObserverSnapshot<Row>): void {
    if (this.#closed) return;
    this.#snapshot = snapshot;
  }

  publish(change: ObserverChange<Row>): void {
    if (this.#closed) return;
    notifyObservers(this.#listeners, (listener) => listener(change), {
      component: 'query-observer', operation: 'publish'
    }, this.#onDiagnostic);
  }
}

const sourceEvidence = <Projection>(candidate: CapturedMember<Projection>): SourceEvidence => {
  const { member } = candidate;
  if (candidate.captureIssues !== undefined) {
    return freezeEvidence({ ...member, state: 'failed', freshness: 'none', authorized: candidate.authorized, issues: candidate.captureIssues });
  }
  if (!candidate.authorized) {
    const issue = observationIssue('observer.authority_denied', 'after_authority', { attachmentId: member.attachmentId });
    return freezeEvidence({ ...member, state: 'denied', freshness: 'none', authorized: false, issues: [issue] });
  }
  if (candidate.sourceMismatch === true) {
    const issue = observationIssue('observer.membership_source_mismatch', 'after_refresh', { attachmentId: member.attachmentId, sourceId: member.sourceId });
    return freezeEvidence({ ...member, state: 'missing', freshness: 'none', authorized: true, issues: [issue] });
  }
  if (candidate.attachment === undefined || candidate.snapshot === undefined) {
    const issue = observationIssue('observer.attachment_missing', 'after_refresh', { attachmentId: member.attachmentId });
    return freezeEvidence({ ...member, state: 'missing', freshness: 'none', authorized: true, issues: [issue] });
  }
  if (candidate.snapshot.state !== 'ready') {
    return freezeEvidence({
      ...member,
      state: candidate.snapshot.state,
      freshness: candidate.snapshot.freshness,
      authorized: true,
      basis: candidate.snapshot.basis,
      issues: candidate.snapshot.issues
    });
  }
  if (candidate.projection?.state !== 'ready') {
    const projectionIssues = candidate.projection?.issues ?? [observationIssue('observer.projection_unavailable', 'after_capability', { attachmentId: member.attachmentId })];
    return freezeEvidence({ ...member, state: candidate.projection?.state ?? 'failed', freshness: candidate.snapshot.freshness, authorized: true, basis: candidate.snapshot.basis, issues: [...candidate.snapshot.issues, ...projectionIssues] });
  }
  return freezeEvidence({ ...member, state: 'ready', freshness: candidate.snapshot.freshness, authorized: true, basis: candidate.snapshot.basis, issues: [...candidate.snapshot.issues, ...candidate.projection.issues] });
};

const observerChange = <Row>(previous: ObserverSnapshot<Row>, next: ObserverSnapshot<Row>): ObserverChange<Row> => {
  if (previous.state !== 'open' || next.state !== 'open') return Object.freeze({ kind: 'reset', snapshot: next });
  if (next.current.completeness === 'unknown') return Object.freeze({ kind: 'invalidation', snapshot: next });
  const baseline = previous.current.completeness === 'exact' ? previous.current : previous.lastExact;
  if (next.current.completeness !== 'exact' || baseline === undefined) return Object.freeze({ kind: 'reset', snapshot: next });
  const beforeMetadata = trustedObservedResults.get(baseline as object);
  const afterMetadata = trustedObservedResults.get(next.current as object);
  if (baseline === previous.current && beforeMetadata !== undefined && afterMetadata !== undefined && afterMetadata.revision === beforeMetadata.revision + 1) {
    return Object.freeze({ kind: 'diff', diff: incrementalResultDiff(baseline, next.current, afterMetadata.resultDelta), snapshot: next });
  }
  return Object.freeze({ kind: 'diff', diff: resultDiff(baseline, next.current), snapshot: next });
};

const sameObserverSnapshot = <Row>(left: ObserverSnapshot<Row>, right: ObserverSnapshot<Row>): boolean => {
  if (left === right) return true;
  if (left.state !== 'open' || right.state !== 'open') return false;
  const before = trustedObservedResults.get(left.current as object);
  const after = trustedObservedResults.get(right.current as object);
  if (before === undefined || after === undefined) return samePortableObserverValue(left, right);
  const consecutiveUnchanged = after.revision === before.revision + 1
    && after.resultDelta.addedResultKeys.length === 0
    && after.resultDelta.removedResultKeys.length === 0
    && after.resultDelta.updatedResultKeys.length === 0
    && sameStringArray(left.current.resultKeys, right.current.resultKeys);
  const sharedResultViews = left.current.rows === right.current.rows && left.current.resultKeys === right.current.resultKeys;
  return (consecutiveUnchanged || sharedResultViews) && sameObservedResultMetadata(left.current, right.current);
};

const sameStringArray = (left: readonly string[], right: readonly string[]): boolean =>
  left === right || left.length === right.length && left.every((value, index) => value === right[index]);

const sameObservedResultMetadata = <Row>(left: ObservedQueryResult<Row>, right: ObservedQueryResult<Row>): boolean =>
  left.readiness === right.readiness
  && left.completeness === right.completeness
  && left.freshness === right.freshness
  && samePortableObserverValue(left.basis, right.basis)
  && samePortableObserverValue(left.sourceStates, right.sourceStates)
  && samePortableObserverValue(left.issues, right.issues);

const incrementalResultDiff = <Row>(
  before: ObservedQueryResult<Row>,
  after: ObservedQueryResult<Row>,
  delta: IncrementalQueryResult['state']['resultDelta']
): ResultDiff<Row> => {
  const addedKeys = new Set(delta.addedResultKeys);
  const removedKeys = new Set(delta.removedResultKeys);
  const updatedKeys = new Set(delta.updatedResultKeys);
  const added: { readonly key: string; readonly row: Row }[] = [];
  const removed: { readonly key: string; readonly row: Row }[] = [];
  for (let index = 0; index < after.resultKeys.length; index += 1) {
    const key = after.resultKeys[index] as string;
    if (addedKeys.has(key)) added.push(Object.freeze({ key, row: after.rows[index] as Row }));
  }
  for (let index = 0; index < before.resultKeys.length; index += 1) {
    const key = before.resultKeys[index] as string;
    if (removedKeys.has(key)) removed.push(Object.freeze({ key, row: before.rows[index] as Row }));
  }
  const beforeUpdated = new Map<string, Row>();
  before.resultKeys.forEach((key, index) => { if (updatedKeys.has(key)) beforeUpdated.set(key, before.rows[index] as Row); });
  const updated: { readonly key: string; readonly before: Row; readonly after: Row }[] = [];
  after.resultKeys.forEach((key, index) => {
    const prior = beforeUpdated.get(key);
    if (prior !== undefined && updatedKeys.has(key)) updated.push(Object.freeze({ key, before: prior, after: after.rows[index] as Row }));
  });
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), updated: Object.freeze(updated) });
};

const resultDiff = <Row>(before: ObservedQueryResult<Row>, after: ObservedQueryResult<Row>): ResultDiff<Row> => {
  const beforeRows = new Map(before.resultKeys.map((key, index) => [key, before.rows[index] as Row]));
  const afterRows = new Map(after.resultKeys.map((key, index) => [key, after.rows[index] as Row]));
  const added = [...afterRows].filter(([key]) => !beforeRows.has(key)).map(([key, row]) => Object.freeze({ key, row }));
  const removed = [...beforeRows].filter(([key]) => !afterRows.has(key)).map(([key, row]) => Object.freeze({ key, row }));
  const updated = [...afterRows].flatMap(([key, row]) => {
    const prior = beforeRows.get(key);
    return prior === undefined || samePortableObserverValue(prior, row) ? [] : [Object.freeze({ key, before: prior, after: row })];
  });
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), updated: Object.freeze(updated) });
};

const compositeFreshness = (evidence: readonly SourceEvidence[]): 'current' | 'stale' | 'mixed' | 'none' => {
  const usable = evidence.filter(({ state }) => state === 'ready').map(({ freshness }) => freshness);
  if (usable.length === 0) return evidence.length === 0 ? 'current' : 'none';
  const unique = new Set(usable);
  if (unique.size === 1) return usable[0] === 'none' ? 'none' : usable[0] as 'current' | 'stale';
  return 'mixed';
};

const staleResult = <Row>(result: ObservedQueryResult<Row>): ObservedQueryResult<Row> => result.freshness === 'stale' ? result : freezeResult({ ...result, freshness: 'stale' });

const freezeResult = <Row>(result: ObservedQueryResult<Row>): ObservedQueryResult<Row> => deepFreezeObserverValue(result);
const freezeEvidence = (evidence: SourceEvidence): SourceEvidence => deepFreezeObserverValue(evidence);

const observationIssue = (code: string, retry: 'after_refresh' | 'after_capability' | 'after_authority', details: unknown): Issue => createIssue({
  code,
  phase: code.includes('authority') ? 'governance' : 'query',
  severity: 'error',
  retry,
  details
});
