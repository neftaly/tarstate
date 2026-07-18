import { canonicalizeJson } from './canonical-json.js';
import {
  type DatasetMembership,
  type AttachmentCatalog,
  type SourceFreshness,
  type SourceLifecycleState
} from './database.js';
import { createIssue, type Issue } from './issues.js';
import {
  DatasetCaptureRuntime,
  type CapturedMember,
  type EvaluationSnapshot
} from './internal-observer-dataset-capture.js';
import { maintenanceInputWithFrame } from './internal-observer-maintenance-frame.js';
import {
  failedMaintenanceEvaluation,
  failedMaintenanceSession,
  queryMaintenanceExtensionsFor,
  type CreateDatabaseQueryMaintenance,
  type DatabaseQueryMaintenanceInput,
  type DatabaseQueryMaintenanceSession,
  type MaintainedDatabaseQueryResult,
  type QueryMaintenanceDiagnostics,
  type QueryMaintenanceReuseDiagnostics,
  type TrustedQueryMaintenanceMetadata
} from './observer-maintenance-contracts.js';
import {
  notifyObservers,
  runObserverCleanups,
  type ObserverDiagnosticReporter
} from './observer-diagnostics.js';
import type { PreparedPlan } from './query/plan-contract.js';
import type { PreparedPlanRow } from './query/authoring.js';
import type { SourceBasis } from './source-state.js';
import { assertPreparedPlan } from './query/internal/prepared-plan.js';
import { deepFreezeObserverValue, detachPreparedPlan, parseObservationParameters, samePortableObserverValue } from './internal-observer-values.js';
import type { JsonValue } from './value.js';
import { projectionDemandKey } from './query/projection-demand.js';
import { stringTupleKey } from './internal-string-key.js';
import { projectionDemandFor } from './internal-observer-projection-demand.js';

export type { AvailableQueryAttachment } from './observer-maintenance-contracts.js';
export type {
  CreateDatabaseQueryMaintenance,
  DatabaseQueryMaintenanceInput,
  DatabaseQueryMaintenanceSession,
  MaintainedDatabaseQueryResult,
  QueryMaintenanceDiagnostics,
  QueryMaintenanceReuseDiagnostics
} from './observer-maintenance-contracts.js';

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
  readonly state: SourceLifecycleState | 'missing' | 'limited';
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

const trustedObservedResults = new WeakMap<object, TrustedQueryMaintenanceMetadata>();

type CaptureObservationEvidence = {
  readonly basis: ObservationBasis;
  readonly sourceStates: readonly SourceEvidence[];
  readonly issues: readonly Issue[];
  readonly freshness: ObservedQueryResult<never>['freshness'];
  readonly requiredInputInvalid: boolean;
  readonly requiredUnavailable: boolean;
};

const captureObservationEvidence = new WeakMap<object, CaptureObservationEvidence>();

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
export type ObserveRequest<Query, Plan extends PreparedPlan<Query> = PreparedPlan<Query>> = {
  readonly plan: Plan;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly allowPartial?: boolean;
};

type ObservationRowForPlan<Plan, Fallback> = [PreparedPlanRow<Plan>] extends [never]
  ? Fallback
  : PreparedPlanRow<Plan>;

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
export type DatabaseView<Query, Row> = {
  readonly authorityScope: string;
  readonly authorityFingerprint: string;
  readonly registryFingerprint: string;
  readonly observe: <Plan extends PreparedPlan<Query>>(
    request: ObserveRequest<Query, Plan>
  ) => QueryObserver<ObservationRowForPlan<Plan, Row>>;
  readonly getActiveMaintenanceCount: () => number;
  readonly getQueryMaintenanceDiagnostics: () => readonly QueryMaintenanceDiagnostics[];
  readonly getQueryMaintenanceReuseDiagnostics: () => QueryMaintenanceReuseDiagnostics;
  readonly getDatabaseDescriptionSnapshot: () => JsonValue | undefined;
  readonly close: () => void;
};

export const createDatabaseView = <Query, Row, Projection = unknown>(
  options: DatabaseViewOptions<Query, Row, Projection>
): DatabaseView<Query, Row> => {
  const {
    attachments,
    authorityScope,
    authorityFingerprint,
    registryFingerprint,
    canRead,
    createQueryMaintenance,
    onDiagnostic,
    getDatabaseDescriptionSnapshot: readDatabaseDescription
  } = options;
  const datasets = new Map<string, DatasetMembership>();
  for (const dataset of options.datasets) {
    const existing = datasets.get(dataset.datasetId);
    if (existing !== undefined && existing !== dataset) throw new Error('A different dataset membership is registered for ' + dataset.datasetId);
    datasets.set(dataset.datasetId, dataset);
  }
  const cache = new Map<string, SharedObservation<Query, Row, Projection>>();
  const datasetRuntimes = new Map<string, DatasetCaptureRuntime<Projection>>();
  let closed = false;

  const observe = <Plan extends PreparedPlan<Query>>(
    request: ObserveRequest<Query, Plan>
  ): QueryObserver<ObservationRowForPlan<Plan, Row>> => {
    if (closed) throw new Error('Database view is closed');
    assertPreparedPlan(request.plan);
    if (request.plan.registryFingerprint !== registryFingerprint) throw new Error('Prepared plan registry fingerprint does not match database view');
    if (request.plan.authorityFingerprint !== authorityFingerprint) throw new Error('Prepared plan authority fingerprint does not match database view');
    const dataset = datasets.get(request.plan.datasetId);
    if (dataset === undefined) throw new Error('Dataset is not part of this database view: ' + request.plan.datasetId);
    const plan = detachPreparedPlan(request.plan);
    const projectionDemand = projectionDemandFor(createQueryMaintenance)?.(plan.query);
    const parameters = parseObservationParameters(request.parameters ?? {});
    const key = queryObservationKey({ authorityScope, authorityFingerprint, registryFingerprint }, { ...request, plan, parameters });
    let shared = cache.get(key);
    if (shared === undefined) {
      const runtimeKey = stringTupleKey(dataset.datasetId, projectionDemandKey(projectionDemand));
      let runtime = datasetRuntimes.get(runtimeKey);
      if (runtime === undefined) {
        runtime = new DatasetCaptureRuntime({
          dataset,
          attachments,
          authorityScope,
          canRead,
          ...(projectionDemand === undefined ? {} : { projectionDemand }),
          ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
          collect: () => {
            if (datasetRuntimes.get(runtimeKey) === runtime) datasetRuntimes.delete(runtimeKey);
          }
        });
        datasetRuntimes.set(runtimeKey, runtime);
      }
      try {
        shared = new SharedObservation({
          plan,
          parameters,
          allowPartial: request.allowPartial === true,
          runtime,
          createQueryMaintenance,
          ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
          collect: () => {
            if (cache.get(key) === shared) cache.delete(key);
          }
        });
      } catch (error) {
        runtime.closeIfUnused();
        throw error;
      }
      cache.set(key, shared);
    }
    return shared.acquire() as QueryObserver<ObservationRowForPlan<Plan, Row>>;
  };

  const getActiveMaintenanceCount = (): number => cache.size;

  /** Optional physical IVM counters; custom maintenance factories return no entries. */
  const getQueryMaintenanceDiagnostics = (): readonly QueryMaintenanceDiagnostics[] => {
    const extensions = queryMaintenanceExtensionsFor(createQueryMaintenance);
    return extensions === undefined
      ? []
      : Object.freeze([...datasetRuntimes.values()].flatMap(({ identity }) => extensions.diagnostics(identity)));
  };

  const getQueryMaintenanceReuseDiagnostics = (): QueryMaintenanceReuseDiagnostics => {
    const extensions = queryMaintenanceExtensionsFor(createQueryMaintenance);
    if (extensions === undefined) return Object.freeze({ computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 });
    let computedFrameDeltaCount = 0;
    let reusedFrameDeltaCount = 0;
    for (const { identity } of datasetRuntimes.values()) {
      const diagnostics = extensions.reuseDiagnostics(identity);
      computedFrameDeltaCount += diagnostics.computedFrameDeltaCount;
      reusedFrameDeltaCount += diagnostics.reusedFrameDeltaCount;
    }
    return Object.freeze({ computedFrameDeltaCount, reusedFrameDeltaCount });
  };

  const getDatabaseDescriptionSnapshot = (): JsonValue | undefined =>
    readDatabaseDescription?.();

  const close = (): void => {
    if (closed) return;
    closed = true;
    runObserverCleanups(
      Array.from(cache.values(), (shared) => () => shared.close()),
      { component: 'database-view', operation: 'close-observations' },
      onDiagnostic
    );
    cache.clear();
    runObserverCleanups(
      Array.from(datasetRuntimes.values(), (runtime) => () => runtime.close()),
      { component: 'database-view', operation: 'close-dataset-runtimes' },
      onDiagnostic
    );
    datasetRuntimes.clear();
  };

  return {
    authorityScope,
    authorityFingerprint,
    registryFingerprint,
    observe,
    getActiveMaintenanceCount,
    getQueryMaintenanceDiagnostics,
    getQueryMaintenanceReuseDiagnostics,
    getDatabaseDescriptionSnapshot,
    close
  };
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
  #maintenanceOpenFailed = false;
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
    const opened = this.#openMaintenance(captured);
    const session = opened.session;
    this.#session = session;
    this.#maintenanceOpenFailed = opened.failed;
    let added = false;
    try {
      const initial = capturedState.state === 'captured'
        ? session.getCurrentResult()
        : failedMaintenanceEvaluation(capturedState.error) as MaintainedDatabaseQueryResult<Row>;
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
      this.#publishedSnapshot = closedSnapshot as ObserverSnapshot<Row>;
      this.#stagedChange = undefined;
      for (const lease of Array.from(this.#leases)) lease.closeFromShared();
      this.#leases.clear();
      this.#options.collect();
    }
  }

  stage(captured: EvaluationSnapshot<Projection>): void {
    this.#stagedChange = undefined;
    if (this.#closed) return;
    let session = this.#session;
    if (session === undefined) return;
    let maintained: MaintainedDatabaseQueryResult<Row>;
    if (this.#maintenanceOpenFailed) {
      const previous = session;
      const reopened = this.#openMaintenance(captured);
      session = reopened.session;
      this.#session = session;
      this.#maintenanceOpenFailed = reopened.failed;
      runObserverCleanups([() => previous.close()], {
        component: 'database-view', operation: 'replace-failed-maintenance'
      }, this.#options.onDiagnostic);
      maintained = session.getCurrentResult();
    } else {
      maintained = this.#updateMaintenance(session, captured);
    }
    if (this.#closed) return;
    this.#stageMaintained(captured, maintained);
  }

  stageFailure(captured: EvaluationSnapshot<Projection>, error: unknown): void {
    this.#stagedChange = undefined;
    if (this.#closed) return;
    this.#stageMaintained(captured, failedMaintenanceEvaluation(error) as MaintainedDatabaseQueryResult<Row>);
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
    return maintenanceInputWithFrame(
      this.#options.plan.query,
      this.#options.parameters,
      captured.dataset,
      captured.available,
      {
        frameIdentity: captured.identity,
        parameterKey: this.#parameterKey,
        runtimeIdentity: this.#options.runtime.identity
      }
    );
  }

  #openMaintenance(captured: EvaluationSnapshot<Projection>): {
    readonly session: DatabaseQueryMaintenanceSession<Query, Row, Projection>;
    readonly failed: boolean;
  } {
    try {
      return {
        session: this.#options.createQueryMaintenance({
          plan: this.#options.plan,
          initialInput: this.#maintenanceInput(captured),
          reuseScope: this.#options.runtime.identity
        }),
        failed: false
      };
    } catch (error) {
      return { session: failedMaintenanceSession<Query, Row, Projection>(error), failed: true };
    }
  }

  #updateMaintenance(session: DatabaseQueryMaintenanceSession<Query, Row, Projection>, captured: EvaluationSnapshot<Projection>): MaintainedDatabaseQueryResult<Row> {
    try {
      return session.updateInput(this.#maintenanceInput(captured));
    } catch (error) {
      return failedMaintenanceEvaluation(error);
    }
  }

  #result(maintained: MaintainedDatabaseQueryResult<Row>, captured: EvaluationSnapshot<Projection>): ObservedQueryResult<Row> {
    const trustedIncremental = queryMaintenanceExtensionsFor(this.#options.createQueryMaintenance)?.trustedMetadata(maintained);
    const captureEvidence = evidenceForCapture(captured);
    const resultIdentityIssue = trustedIncremental !== undefined || (maintained.rows.length === maintained.resultKeys.length && new Set(maintained.resultKeys).size === maintained.resultKeys.length)
      ? []
      : [observationIssue('observer.evaluation_failed', 'after_refresh', { reason: 'invalid_result_identity' })];
    const evaluationInvalid = resultIdentityIssue.length > 0 || maintained.issues.some(({ code }) => code === 'observer.evaluation_failed');
    const inputsIncomplete = captured.dataset.state !== 'settled' || captureEvidence.requiredUnavailable || evaluationInvalid;
    let completeness = maintained.completeness;
    if (inputsIncomplete && !(this.#options.allowPartial && completeness === 'lower-bound')) completeness = 'unknown';
    const rows = completeness === 'unknown' ? [] : maintained.rows;
    const resultKeys = completeness === 'unknown' ? [] : maintained.resultKeys;
    const readiness = captureEvidence.requiredInputInvalid || evaluationInvalid
      ? 'invalid'
      : completeness === 'exact' ? 'ready' : 'incomplete';
    const dynamicIssues = deepFreezeObserverValue([...resultIdentityIssue, ...maintained.issues]) as readonly Issue[];
    const issues = Object.freeze([...captureEvidence.issues, ...dynamicIssues]);
    const canReuseMaintained = trustedIncremental !== undefined && completeness !== 'unknown' && rows === maintained.rows && resultKeys === maintained.resultKeys;
    const result = Object.freeze({
      readiness,
      rows: canReuseMaintained ? rows : deepFreezeObserverValue(rows),
      resultKeys: canReuseMaintained ? resultKeys : deepFreezeObserverValue(resultKeys),
      completeness,
      freshness: captureEvidence.freshness,
      basis: captureEvidence.basis,
      sourceStates: captureEvidence.sourceStates,
      issues
    }) as ObservedQueryResult<Row>;
    if (canReuseMaintained) trustedObservedResults.set(result, trustedIncremental);
    return result;
  }

  #observerSnapshot(current: ObservedQueryResult<Row>, previous: ObserverSnapshot<Row> | undefined): ObserverSnapshot<Row> {
    if (current.completeness === 'exact') return Object.freeze({ state: 'open', current, lastExact: current });
    const previousExact = previous?.state === 'open' ? previous.lastExact : undefined;
    const lastExact = previousExact === undefined ? undefined : staleResult(previousExact);
    return Object.freeze({ state: 'open', current, ...(lastExact === undefined ? {} : { lastExact }) });
  }
}

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
  const memberEvidence = {
    attachmentId: member.attachmentId,
    sourceId: member.sourceId,
    expectation: member.expectation,
    discoveryEdges: member.discoveryEdges
  };
  if (candidate.captureIssues !== undefined) {
    return freezeEvidence({ ...memberEvidence, state: 'failed', freshness: 'none', authorized: candidate.authorized, issues: candidate.captureIssues });
  }
  if (!candidate.authorized) {
    const issue = observationIssue('observer.authority_denied', 'after_authority', { attachmentId: member.attachmentId });
    return freezeEvidence({ ...memberEvidence, state: 'denied', freshness: 'none', authorized: false, issues: [issue] });
  }
  if (candidate.sourceMismatch === true) {
    const issue = observationIssue('observer.membership_source_mismatch', 'after_refresh', { attachmentId: member.attachmentId, sourceId: member.sourceId });
    return freezeEvidence({ ...memberEvidence, state: 'missing', freshness: 'none', authorized: true, issues: [issue] });
  }
  if (candidate.attachment === undefined || candidate.snapshot === undefined) {
    if (member.sourceAvailability !== undefined) {
      return freezeEvidence({
        ...memberEvidence,
        state: member.sourceAvailability.state,
        freshness: 'none',
        authorized: true,
        issues: member.sourceAvailability.issues
      });
    }
    const issue = observationIssue('observer.attachment_missing', 'after_refresh', { attachmentId: member.attachmentId });
    return freezeEvidence({ ...memberEvidence, state: 'missing', freshness: 'none', authorized: true, issues: [issue] });
  }
  if (candidate.snapshot.state !== 'ready') {
    return freezeEvidence({
      ...memberEvidence,
      state: candidate.snapshot.state,
      freshness: candidate.snapshot.freshness,
      authorized: true,
      basis: candidate.snapshot.basis,
      issues: candidate.snapshot.issues
    });
  }
  if (candidate.projection?.state !== 'ready') {
    const projectionIssues = candidate.projection?.issues ?? [observationIssue('observer.projection_unavailable', 'after_capability', { attachmentId: member.attachmentId })];
    return freezeEvidence({ ...memberEvidence, state: candidate.projection?.state ?? 'failed', freshness: candidate.snapshot.freshness, authorized: true, basis: candidate.snapshot.basis, issues: [...candidate.snapshot.issues, ...projectionIssues] });
  }
  return freezeEvidence({ ...memberEvidence, state: 'ready', freshness: candidate.snapshot.freshness, authorized: true, basis: candidate.snapshot.basis, issues: [...candidate.snapshot.issues, ...candidate.projection.issues] });
};

const evidenceForCapture = <Projection>(captured: EvaluationSnapshot<Projection>): CaptureObservationEvidence => {
  const cached = captureObservationEvidence.get(captured.identity);
  if (cached !== undefined) return cached;
  const sourceStates = Object.freeze(captured.members.map(sourceEvidence));
  const evidenceIssues = Object.freeze(sourceStates.flatMap(({ issues }) => issues));
  const membershipIssues = captured.dataset.state === 'open'
    ? Object.freeze([observationIssue('observer.membership_open', 'after_refresh', { datasetId: captured.dataset.datasetId, revision: captured.dataset.revision })])
    : Object.freeze([]);
  const basis = deepFreezeObserverValue({
    dataset: { datasetId: captured.dataset.datasetId, revision: captured.dataset.revision },
    attachments: captured.members.flatMap((candidate) => candidate.snapshot === undefined ? [] : [{
      attachmentId: candidate.member.attachmentId,
      sourceId: candidate.member.sourceId,
      basis: candidate.snapshot.basis
    }])
  }) as ObservationBasis;
  const evidence = Object.freeze({
    basis,
    sourceStates,
    issues: Object.freeze([...evidenceIssues, ...membershipIssues]),
    freshness: compositeFreshness(sourceStates),
    requiredInputInvalid: captured.members.some((candidate) =>
      candidate.member.expectation === 'required'
      && (candidate.member.sourceAvailability?.state === 'failed'
        || (candidate.snapshot?.state === 'ready' && candidate.projection?.state === 'failed'))),
    requiredUnavailable: sourceStates.some((item) => item.expectation === 'required' && (item.state !== 'ready' || !item.authorized))
  });
  captureObservationEvidence.set(captured.identity, evidence);
  return evidence;
};

const observerChange = <Row>(previous: ObserverSnapshot<Row>, next: ObserverSnapshot<Row>): ObserverChange<Row> => {
  if (previous.state !== 'open' || next.state !== 'open') return Object.freeze({ kind: 'reset', snapshot: next });
  if (next.current.completeness === 'unknown') return Object.freeze({ kind: 'invalidation', snapshot: next });
  const baseline = previous.current.completeness === 'exact' ? previous.current : previous.lastExact;
  if (next.current.completeness !== 'exact' || baseline === undefined) return Object.freeze({ kind: 'reset', snapshot: next });
  const beforeMetadata = trustedObservedResults.get(baseline as object);
  const afterMetadata = trustedObservedResults.get(next.current as object);
  if (baseline === previous.current && beforeMetadata !== undefined && afterMetadata !== undefined && afterMetadata.revision === beforeMetadata.revision + 1) {
    return Object.freeze({ kind: 'diff', diff: incrementalResultDiff(baseline, next.current, beforeMetadata, afterMetadata), snapshot: next });
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

const sameStringArray = (left: readonly string[], right: readonly string[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

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
  beforeMetadata: TrustedQueryMaintenanceMetadata,
  afterMetadata: TrustedQueryMaintenanceMetadata
): ResultDiff<Row> => {
  const delta = afterMetadata.resultDelta;
  const added: { readonly key: string; readonly row: Row }[] = [];
  for (const key of orderedResultKeys(delta.addedResultKeys, afterMetadata.resultKeyPositions)) {
    const position = afterMetadata.resultKeyPositions.get(key);
    if (position !== undefined) added.push(Object.freeze({ key, row: after.rows[position] as Row }));
  }
  const removed: { readonly key: string; readonly row: Row }[] = [];
  for (const key of orderedResultKeys(delta.removedResultKeys, beforeMetadata.resultKeyPositions)) {
    const position = beforeMetadata.resultKeyPositions.get(key);
    if (position !== undefined) removed.push(Object.freeze({ key, row: before.rows[position] as Row }));
  }
  const updated: { readonly key: string; readonly before: Row; readonly after: Row }[] = [];
  for (const key of orderedResultKeys(delta.updatedResultKeys, afterMetadata.resultKeyPositions)) {
    const beforePosition = beforeMetadata.resultKeyPositions.get(key);
    const afterPosition = afterMetadata.resultKeyPositions.get(key);
    if (beforePosition !== undefined && afterPosition !== undefined) {
      updated.push(Object.freeze({
        key,
        before: before.rows[beforePosition] as Row,
        after: after.rows[afterPosition] as Row
      }));
    }
  }
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), updated: Object.freeze(updated) });
};

const orderedResultKeys = (
  keys: readonly string[],
  positions: ReadonlyMap<string, number>
): readonly string[] => keys.length < 2
  ? keys
  : [...keys].sort((left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));

const resultDiff = <Row>(before: ObservedQueryResult<Row>, after: ObservedQueryResult<Row>): ResultDiff<Row> => {
  const beforeRows = new Map<string, Row>();
  const afterRows = new Map<string, Row>();
  for (let index = 0; index < before.resultKeys.length; index += 1) {
    beforeRows.set(before.resultKeys[index] as string, before.rows[index] as Row);
  }
  for (let index = 0; index < after.resultKeys.length; index += 1) {
    afterRows.set(after.resultKeys[index] as string, after.rows[index] as Row);
  }
  const added: { readonly key: string; readonly row: Row }[] = [];
  const removed: { readonly key: string; readonly row: Row }[] = [];
  const updated: { readonly key: string; readonly before: Row; readonly after: Row }[] = [];
  for (const [key, row] of afterRows) {
    const wasPresent = beforeRows.has(key);
    if (!wasPresent) added.push(Object.freeze({ key, row }));
    const prior = beforeRows.get(key) as Row;
    if (wasPresent && !samePortableObserverValue(prior, row)) {
      updated.push(Object.freeze({ key, before: prior, after: row }));
    }
  }
  for (const [key, row] of beforeRows) {
    if (!afterRows.has(key)) removed.push(Object.freeze({ key, row }));
  }
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), updated: Object.freeze(updated) });
};

const compositeFreshness = (evidence: readonly SourceEvidence[]): 'current' | 'stale' | 'mixed' | 'none' => {
  let freshness: SourceEvidence['freshness'] | undefined;
  for (const source of evidence) {
    if (source.state !== 'ready') continue;
    if (freshness !== undefined && freshness !== source.freshness) return 'mixed';
    freshness = source.freshness;
  }
  if (freshness === undefined) return evidence.length === 0 ? 'current' : 'none';
  return freshness;
};

const staleResult = <Row>(result: ObservedQueryResult<Row>): ObservedQueryResult<Row> => result.freshness === 'stale' ? result : Object.freeze({ ...result, freshness: 'stale' });

const freezeEvidence = (evidence: SourceEvidence): SourceEvidence => deepFreezeObserverValue(evidence);

const observationIssue = (code: string, retry: 'after_refresh' | 'after_capability' | 'after_authority', details: unknown): Issue => createIssue({
  code,
  phase: code.includes('authority') ? 'governance' : 'query',
  severity: 'error',
  retry,
  details
});
