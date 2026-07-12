import { canonicalizeJson } from './artifacts.js';
import {
  type AttachmentProjection,
  type DatabaseAttachment,
  type DatasetMember,
  type DatasetMembership,
  type DatasetSnapshot,
  type AttachmentCatalog,
  type SourceFreshness,
  type SourceLifecycleState,
  type SourceSnapshot
} from './database.js';
import { createIssue, type Issue } from './issues.js';
import type { PreparedPlan, SourceBasis } from './maintenance.js';
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
import { defaultValueParseBudget, safeParseJsonValue, type JsonValue } from './value.js';

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

export type AvailableQueryAttachment<Projection> = {
  readonly member: DatasetMember;
  readonly attachment: DatabaseAttachment<unknown, Projection>;
  readonly snapshot: SourceSnapshot<unknown>;
  readonly projection: Projection;
};

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
    this.#getDatabaseDescriptionSnapshot = options.getDatabaseDescriptionSnapshot;
  }

  observe(request: ObserveRequest<Query>): QueryObserver<Row> {
    if (this.#closed) throw new Error('Database view is closed');
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
    try {
      for (const shared of Array.from(this.#cache.values())) {
        try { shared.close(); } catch { /* one maintenance implementation cannot prevent database cleanup */ }
      }
    } finally {
      this.#cache.clear();
      for (const runtime of Array.from(this.#datasetRuntimes.values())) {
        try { runtime.close(); } catch { /* one source runtime cannot prevent database cleanup */ }
      }
      this.#datasetRuntimes.clear();
    }
  }
}

type CapturedMember<Projection> = {
  readonly member: DatasetMember;
  readonly attachment?: DatabaseAttachment<unknown, Projection>;
  readonly snapshot?: SourceSnapshot<unknown>;
  readonly projection?: AttachmentProjection<Projection>;
  readonly authorized: boolean;
  readonly sourceMismatch?: boolean;
  readonly captureIssues?: readonly Issue[];
};

type EvaluationSnapshot<Projection> = {
  readonly identity: object;
  readonly dataset: DatasetSnapshot;
  readonly members: readonly CapturedMember<Projection>[];
  readonly available: readonly AvailableQueryAttachment<Projection>[];
};

type DatasetCaptureState<Projection> =
  | { readonly state: 'captured'; readonly captured: EvaluationSnapshot<Projection> }
  | { readonly state: 'failed'; readonly captured: EvaluationSnapshot<Projection>; readonly error: unknown };

type DatasetCaptureConsumer<Projection> = {
  readonly stage: (captured: EvaluationSnapshot<Projection>) => void;
  readonly stageFailure: (captured: EvaluationSnapshot<Projection>, error: unknown) => void;
  readonly preparePublish: () => void;
  readonly publish: () => void;
};

type DatasetCaptureRuntimeOptions = {
  readonly dataset: DatasetMembership;
  readonly attachments: AttachmentCatalog;
  readonly authorityScope: string;
  readonly canRead: (viewAuthorityScope: string, attachmentAuthorityScope: string, attachmentId: string) => boolean;
  readonly collect: () => void;
};

/** One authority-filtered capture and subscription topology shared by every active root in a dataset. */
class DatasetCaptureRuntime<Projection> {
  readonly #options: DatasetCaptureRuntimeOptions;
  readonly #consumers = new Set<DatasetCaptureConsumer<Projection>>();
  #unsubscribeDataset: () => void = () => undefined;
  #unsubscribeCatalog: () => void = () => undefined;
  readonly #sourceUnsubscribes = new Map<object, () => void>();
  #state!: DatasetCaptureState<Projection>;
  #refreshing = false;
  #pending = false;
  #topologyPending = false;
  #closed = false;
  readonly #identity = Object.freeze({});

  constructor(options: DatasetCaptureRuntimeOptions) {
    this.#options = options;
    const refreshTopology = () => this.#requestRefresh(true);
    try {
      this.#unsubscribeDataset = options.dataset.subscribe(refreshTopology);
      this.#unsubscribeCatalog = options.attachments.subscribe(refreshTopology);
      this.#refreshSourceSubscriptions();
      this.#state = Object.freeze({ state: 'captured', captured: this.#capture() });
    } catch (error) {
      this.#closed = true;
      this.#cleanupSubscriptions();
      throw error;
    }
  }

  state(): DatasetCaptureState<Projection> { return this.#state; }
  get identity(): object { return this.#identity; }

  add(consumer: DatasetCaptureConsumer<Projection>): void {
    if (this.#closed) throw new Error('Dataset capture runtime is closed');
    this.#consumers.add(consumer);
  }

  remove(consumer: DatasetCaptureConsumer<Projection>): void {
    if (!this.#consumers.delete(consumer)) return;
    if (this.#consumers.size === 0) this.close();
  }

  closeIfUnused(): void {
    if (this.#consumers.size === 0) this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanupSubscriptions();
    this.#consumers.clear();
    this.#options.collect();
  }

  #requestRefresh(topologyChanged = false): void {
    if (this.#closed) return;
    this.#pending = true;
    this.#topologyPending = this.#topologyPending || topologyChanged;
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      while (this.#pending && !this.#closed) {
        this.#pending = false;
        let captured: EvaluationSnapshot<Projection>;
        try {
          if (this.#topologyPending) {
            this.#topologyPending = false;
            this.#refreshSourceSubscriptions();
          }
          captured = this.#capture();
        } catch (error) {
          this.#state = Object.freeze({ state: 'failed', captured: this.#state.captured, error });
          const consumers = Array.from(this.#consumers);
          for (const consumer of consumers) {
            if (!this.#consumers.has(consumer)) continue;
            try { consumer.stageFailure(this.#state.captured, error); } catch { /* one failed consumer cannot starve peers */ }
          }
          if (this.#pending) continue;
          for (const consumer of consumers) if (this.#consumers.has(consumer)) consumer.preparePublish();
          for (const consumer of consumers) if (this.#consumers.has(consumer)) consumer.publish();
          continue;
        }
        this.#state = Object.freeze({ state: 'captured', captured });
        const consumers = Array.from(this.#consumers);
        for (const consumer of consumers) {
          if (!this.#consumers.has(consumer)) continue;
          try { consumer.stage(captured); } catch (error) {
            try { consumer.stageFailure(captured, error); } catch { /* one failed consumer cannot starve peers */ }
          }
        }
        // A nested input change supersedes this staged pass before consumers
        // are notified. Their maintenance sessions can safely accept both
        // snapshots, but observers see only the newest coherent basis.
        if (this.#pending) continue;
        for (const consumer of consumers) {
          if (this.#consumers.has(consumer)) consumer.preparePublish();
        }
        for (const consumer of consumers) {
          if (this.#consumers.has(consumer)) consumer.publish();
        }
      }
    } finally {
      this.#refreshing = false;
    }
  }

  #refreshSourceSubscriptions(): void {
    const desired = new Map<object, DatabaseAttachment['source']>();
    for (const member of this.#options.dataset.snapshot().members) {
      const attachment = this.#options.attachments.get(member.attachmentId);
      if (attachment === undefined || desired.has(attachment.source)) continue;
      if (attachment.sourceId !== member.sourceId) continue;
      let authorized = false;
      try {
        authorized = this.#options.canRead(this.#options.authorityScope, attachment.authorityScope, attachment.attachmentId);
      } catch { /* capture records authority failures as member evidence */ }
      if (!authorized) continue;
      desired.set(attachment.source, attachment.source);
    }
    for (const [source, unsubscribe] of this.#sourceUnsubscribes) {
      if (desired.has(source)) continue;
      try {
        unsubscribe();
        this.#sourceUnsubscribes.delete(source);
      } catch { /* retain the handle so final cleanup can retry */ }
    }
    for (const [source, observable] of desired) {
      if (this.#sourceUnsubscribes.has(source)) continue;
      this.#sourceUnsubscribes.set(source, observable.subscribe(() => this.#requestRefresh()));
    }
  }

  #capture(): EvaluationSnapshot<Projection> {
    const dataset = this.#options.dataset.snapshot();
    const snapshots = new Map<object, { readonly snapshot: SourceSnapshot<unknown> } | { readonly error: unknown }>();
    const members = dataset.members.map((member): CapturedMember<Projection> => {
      const raw = this.#options.attachments.get(member.attachmentId);
      if (raw === undefined) return { member, authorized: true };
      if (raw.sourceId !== member.sourceId) return { member, authorized: true, sourceMismatch: true };
      let authorized: boolean;
      try {
        authorized = this.#options.canRead(this.#options.authorityScope, raw.authorityScope, raw.attachmentId);
      } catch (error) {
        return { member, authorized: false, captureIssues: [captureFailureIssue('authority_check_failed', member, error)] };
      }
      if (!authorized) return { member, authorized: false };
      const attachment = raw as DatabaseAttachment<unknown, Projection>;
      let capturedSource = snapshots.get(attachment.source);
      if (capturedSource === undefined) {
        try {
          capturedSource = { snapshot: attachment.source.snapshot() as SourceSnapshot<unknown> };
        } catch (error) {
          capturedSource = { error };
        }
        snapshots.set(attachment.source, capturedSource);
      }
      if ('error' in capturedSource) return { member, attachment, authorized: true, captureIssues: [captureFailureIssue('source_snapshot_failed', member, capturedSource.error)] };
      const snapshot = capturedSource.snapshot;
      let projection: AttachmentProjection<Projection> | undefined;
      if (snapshot.state === 'ready') {
        try {
          projection = attachment.project(snapshot);
        } catch (error) {
          projection = { state: 'failed', issues: [captureFailureIssue('attachment_projection_failed', member, error)] };
        }
      }
      return {
        member,
        attachment,
        snapshot,
        ...(projection === undefined ? {} : { projection }),
        authorized: true
      };
    }).map((member) => Object.freeze(member));
    const available = members.flatMap((candidate): readonly AvailableQueryAttachment<Projection>[] => {
      if (candidate.attachment === undefined || candidate.snapshot === undefined || candidate.projection?.state !== 'ready') return [];
      return [Object.freeze({
        member: candidate.member,
        attachment: candidate.attachment,
        snapshot: candidate.snapshot,
        projection: candidate.projection.value
      })];
    });
    return Object.freeze({
      identity: Object.freeze({}),
      dataset,
      members: Object.freeze(members),
      available: Object.freeze(available)
    });
  }

  #cleanupSubscriptions(): void {
    try { this.#unsubscribeDataset(); } catch { /* lifecycle cleanup is best effort */ }
    try { this.#unsubscribeCatalog(); } catch { /* lifecycle cleanup is best effort */ }
    for (const unsubscribe of this.#sourceUnsubscribes.values()) {
      try { unsubscribe(); } catch { /* final retry is best effort */ }
    }
    this.#sourceUnsubscribes.clear();
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
      try { session.close(); } catch { /* construction failure still releases ownership */ }
      if (added) options.runtime.remove(this);
      throw error;
    }
  }

  acquire(): QueryObserver<Row> {
    if (this.#closed) throw new Error('Shared observation is closed');
    const lease = new ObserverLease(this, this.#publishedSnapshot);
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
    try { session?.close(); } catch { /* maintenance cleanup cannot retain observation lifecycle */ }
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
    if (samePortable(this.#publishedSnapshot, nextSnapshot)) {
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
    const evidence = captured.members.map(sourceEvidence);
    const evidenceIssues = evidence.flatMap(({ issues }) => issues);
    const membershipIssue = captured.dataset.state === 'open'
      ? [observationIssue('observer.membership_open', 'after_refresh', { datasetId: captured.dataset.datasetId, revision: captured.dataset.revision })]
      : [];
    const resultIdentityIssue = maintained.rows.length === maintained.resultKeys.length && new Set(maintained.resultKeys).size === maintained.resultKeys.length
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
    return freezeResult({
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
    });
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
  let nextCohortIdentity = 0;
  const factory = ((input) => {
    const { plan, initialInput } = input;
    const runtimeIdentity = (input as Partial<InternalCreateDatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>>)[maintenanceRuntimeIdentity];
    const initial = normalize(initialInput);
    if (runtimeIdentity === undefined) return openPrivateDatabaseMaintenance(plan, initial, normalize);
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
      return openPrivateDatabaseMaintenance(plan, initial, normalize);
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
          return openPrivateDatabaseMaintenance(plan, initial, normalize);
        }
        cohort.roots += 1;
        return openPooledDatabaseMaintenance({ plan, initial, root, cohort, cohorts, normalize });
      } catch (error) {
        runtime.close();
        if (cohorts.get(key) === cohort) cohorts.delete(key);
        if (!isNonPoolableQueryError(error)) throw error;
        return openPrivateDatabaseMaintenance(plan, initial, normalize);
      }
    }
    try {
      const root = cohort.runtime.attach(plan);
      cohort.roots += 1;
      return openPooledDatabaseMaintenance({ plan, initial: attachesToRejected || attachesToFailed ? cohort.accepted : initial, root, cohort, cohorts, normalize });
    } catch (error) {
      if (!isNonPoolableQueryError(error) && !isPooledQueryRuntimeBusyError(error)) throw error;
      return openPrivateDatabaseMaintenance(plan, initial, normalize);
    }
  }) as IncrementalDatabaseQueryMaintenanceFactory;
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
      ? options.cohort.transitionFailure?.result ?? databaseResultFromMaintained((root ?? options.root).getCurrentResult())
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
        return databaseResultFromMaintained((root as PooledIncrementalQueryRoot).getCurrentResult());
      }
      if (!returnsToAccepted && options.cohort.lastRejected !== undefined && sameQueryMaintenanceSnapshot(normalizedNext, options.cohort.lastRejected)) {
        return databaseResultFromMaintained((root as PooledIncrementalQueryRoot).getCurrentResult());
      }
      if (!sameQueryMaintenanceSnapshot(localAccepted, options.cohort.accepted)) {
        detach();
        privateSession = openPrivateDatabaseMaintenance(options.plan, localAccepted, options.normalize);
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
      return databaseResultFromMaintained(updatingRoot.getCurrentResult());
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
  normalize: QueryMaintenanceSnapshotNormalizer
): DatabaseQueryMaintenanceSession<QueryNode, QueryRecord, readonly RelationInput[]> => {
  let accepted = initial;
  let session = openIncrementalQueryMaintenance(plan, accepted);
  return {
    getCurrentResult: () => databaseResultFromMaintained(session.getCurrentResult()),
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
        return databaseResultFromMaintained(session.getCurrentResult());
      }
      const rejectedBefore = session.getCurrentResult().state.rejectedUpdateCount;
      const result = session.applyUpdate(update);
      if (result.state.rejectedUpdateCount === rejectedBefore) accepted = next;
      return databaseResultFromMaintained(result);
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

const sameQueryMaintenanceSnapshot = (left: QueryMaintenanceSnapshot, right: QueryMaintenanceSnapshot): boolean => left === right || samePortable(
  { relations: left.relations, parameters: left.parameters, basis: left.basis, membershipRevision: left.membershipRevision },
  { relations: right.relations, parameters: right.parameters, basis: right.basis, membershipRevision: right.membershipRevision }
);

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
    if (cached !== undefined) return cached;
    const normalized: FramedQueryMaintenanceSnapshot = {
      ...frame.normalized,
      parameters: input.parameters,
      ...(functions === undefined ? {} : { functions }),
      [queryMaintenanceFrameIdentity]: Object.freeze({
        frameIdentity: metadata.frameIdentity,
        runtimeIdentity: metadata.runtimeIdentity
      })
    };
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

const freezeQueryMaintenanceUpdate = (update: QueryMaintenanceUpdate): QueryMaintenanceUpdate => deepFreezeClone(update);

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

const databaseResultFromMaintained = ({ state: _state, ...result }: IncrementalQueryResult): MaintainedDatabaseQueryResult<QueryRecord> => result;

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
  #closed = false;

  constructor(shared: ObserverLeaseOwner<Row>, snapshot: ObserverSnapshot<Row>) {
    this.#shared = shared;
    this.#snapshot = snapshot;
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
    for (const listener of Array.from(this.#listeners)) {
      try { listener(change); } catch { /* one consumer cannot break observation */ }
    }
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

const captureFailureIssue = (reason: string, member: DatasetMember, error: unknown): Issue => observationIssue(
  'observer.evaluation_failed',
  'after_refresh',
  { reason, attachmentId: member.attachmentId, error: error instanceof Error ? error.name : typeof error }
);

const observerChange = <Row>(previous: ObserverSnapshot<Row>, next: ObserverSnapshot<Row>): ObserverChange<Row> => {
  if (previous.state !== 'open' || next.state !== 'open') return Object.freeze({ kind: 'reset', snapshot: next });
  if (next.current.completeness === 'unknown') return Object.freeze({ kind: 'invalidation', snapshot: next });
  const baseline = previous.current.completeness === 'exact' ? previous.current : previous.lastExact;
  if (next.current.completeness !== 'exact' || baseline === undefined) return Object.freeze({ kind: 'reset', snapshot: next });
  return Object.freeze({ kind: 'diff', diff: resultDiff(baseline, next.current), snapshot: next });
};

const resultDiff = <Row>(before: ObservedQueryResult<Row>, after: ObservedQueryResult<Row>): ResultDiff<Row> => {
  const beforeRows = new Map(before.resultKeys.map((key, index) => [key, before.rows[index] as Row]));
  const afterRows = new Map(after.resultKeys.map((key, index) => [key, after.rows[index] as Row]));
  const added = [...afterRows].filter(([key]) => !beforeRows.has(key)).map(([key, row]) => Object.freeze({ key, row }));
  const removed = [...beforeRows].filter(([key]) => !afterRows.has(key)).map(([key, row]) => Object.freeze({ key, row }));
  const updated = [...afterRows].flatMap(([key, row]) => {
    const prior = beforeRows.get(key);
    return prior === undefined || samePortable(prior, row) ? [] : [Object.freeze({ key, before: prior, after: row })];
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

const freezeResult = <Row>(result: ObservedQueryResult<Row>): ObservedQueryResult<Row> => deepFreezeClone(result);
const freezeEvidence = (evidence: SourceEvidence): SourceEvidence => deepFreezeClone(evidence);

const deepFreezeClone = <Value>(value: Value, seen = new WeakMap<object, object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as Value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(deepFreezeClone(item, seen));
    return Object.freeze(output) as Value;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: deepFreezeClone(item, seen),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return Object.freeze(output) as Value;
};

const parseObservationParameters = (input: unknown): Readonly<Record<string, JsonValue>> => {
  const parsed = safeParseJsonValue(input);
  if (!parsed.success) throw new TypeError('Observation parameters must be a portable record: ' + parsed.issues.map(({ code }) => code).join(', '));
  if (parsed.value === null || Array.isArray(parsed.value) || typeof parsed.value !== 'object') {
    throw new TypeError('Observation parameters must be a portable record');
  }
  return deepFreezeClone(parsed.value) as Readonly<Record<string, JsonValue>>;
};

const detachPreparedPlan = <Query>(plan: PreparedPlan<Query>): PreparedPlan<Query> => {
  const parsed = safeParseJsonValue(plan.query, { ...defaultValueParseBudget, maxDepth: 1_024 });
  if (!parsed.success) throw new TypeError('Prepared plan query must be a portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
  return Object.freeze({
    planId: plan.planId,
    rootNodeId: plan.rootNodeId,
    query: deepFreezeClone(parsed.value) as Query,
    registryFingerprint: plan.registryFingerprint,
    authorityFingerprint: plan.authorityFingerprint,
    datasetId: plan.datasetId
  });
};

const samePortable = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};

const observationIssue = (code: string, retry: 'after_refresh' | 'after_capability' | 'after_authority', details: unknown): Issue => createIssue({
  code,
  phase: code.includes('authority') ? 'governance' : 'query',
  severity: 'error',
  retry,
  details
});
