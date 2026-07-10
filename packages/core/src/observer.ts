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
  deriveQueryMaintenanceUpdate,
  openIncrementalQueryMaintenance,
  type FunctionRegistry,
  type IncrementalQueryResult,
  type QueryMaintenanceSnapshot,
  type QueryNode,
  type QueryRecord,
  type RelationInput
} from './query.js';
import type { JsonValue } from './value.js';

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
    const parameters = deepFreezeClone(request.parameters ?? {}) as Readonly<Record<string, JsonValue>>;
    const key = queryObservationKey(this, { ...request, parameters });
    let shared = this.#cache.get(key);
    if (shared === undefined) {
      shared = new SharedObservation({
        plan: request.plan,
        parameters,
        allowPartial: request.allowPartial === true,
        dataset,
        attachments: this.#attachments,
        authorityScope: this.authorityScope,
        canRead: this.#canRead,
        createQueryMaintenance: this.#createQueryMaintenance,
        collect: () => {
          if (this.#cache.get(key) === shared) this.#cache.delete(key);
        }
      });
      this.#cache.set(key, shared);
    }
    return shared.acquire();
  }

  getActiveMaintenanceCount(): number { return this.#cache.size; }

  getDatabaseDescriptionSnapshot(): JsonValue | undefined {
    return this.#getDatabaseDescriptionSnapshot?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const shared of Array.from(this.#cache.values())) shared.close();
    this.#cache.clear();
  }
}

type CapturedMember<Projection> = {
  readonly member: DatasetMember;
  readonly attachment?: DatabaseAttachment<unknown, Projection>;
  readonly snapshot?: SourceSnapshot<unknown>;
  readonly projection?: AttachmentProjection<Projection>;
  readonly authorized: boolean;
  readonly sourceMismatch?: boolean;
};

type EvaluationSnapshot<Projection> = {
  readonly dataset: DatasetSnapshot;
  readonly members: readonly CapturedMember<Projection>[];
};

type SharedOptions<Query, Row, Projection> = {
  readonly plan: PreparedPlan<Query>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly allowPartial: boolean;
  readonly dataset: DatasetMembership;
  readonly attachments: AttachmentCatalog;
  readonly authorityScope: string;
  readonly canRead: DatabaseViewOptions<Query, Row, Projection>['canRead'];
  readonly createQueryMaintenance: DatabaseViewOptions<Query, Row, Projection>['createQueryMaintenance'];
  readonly collect: () => void;
};

class SharedObservation<Query, Row, Projection> {
  readonly #options: SharedOptions<Query, Row, Projection>;
  readonly #leases = new Set<ObserverLease<Row>>();
  readonly #unsubscribeDataset: () => void;
  readonly #unsubscribeCatalog: () => void;
  #sourceUnsubscribes: readonly (() => void)[] = [];
  #session: DatabaseQueryMaintenanceSession<Query, Row, Projection> | undefined;
  #snapshot: ObserverSnapshot<Row>;
  #leaseCount = 0;
  #refreshing = false;
  #pending = false;
  #closed = false;

  constructor(options: SharedOptions<Query, Row, Projection>) {
    this.#options = options;
    const captured = this.#capture();
    this.#session = this.#openMaintenance(captured);
    this.#snapshot = this.#observerSnapshot(this.#result(this.#session.getCurrentResult(), captured), undefined);
    this.#refreshSourceSubscriptions();
    const refreshTopology = () => {
      this.#refreshSourceSubscriptions();
      this.#requestRefresh();
    };
    this.#unsubscribeDataset = options.dataset.subscribe(refreshTopology);
    this.#unsubscribeCatalog = options.attachments.subscribe(refreshTopology);
  }

  acquire(): QueryObserver<Row> {
    if (this.#closed) throw new Error('Shared observation is closed');
    this.#leaseCount += 1;
    const lease = new ObserverLease(this, this.#snapshot);
    this.#leases.add(lease);
    return lease;
  }

  release(lease: ObserverLease<Row>): void {
    if (!this.#leases.delete(lease)) return;
    this.#leaseCount -= 1;
    if (this.#leaseCount === 0) this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeDataset();
    this.#unsubscribeCatalog();
    for (const unsubscribe of this.#sourceUnsubscribes) unsubscribe();
    this.#sourceUnsubscribes = [];
    this.#session?.close();
    this.#session = undefined;
    this.#snapshot = closedSnapshot as ObserverSnapshot<Row>;
    for (const lease of Array.from(this.#leases)) lease.closeFromShared();
    this.#leases.clear();
    this.#leaseCount = 0;
    this.#options.collect();
  }

  #requestRefresh(): void {
    if (this.#closed) return;
    this.#pending = true;
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      while (this.#pending && !this.#closed) {
        this.#pending = false;
        const captured = this.#capture();
        const session = this.#session;
        if (session === undefined) continue;
        const maintained = this.#updateMaintenance(session, captured);
        const current = this.#result(maintained, captured);
        const previousSnapshot = this.#snapshot;
        if (previousSnapshot.state !== 'open') continue;
        const nextSnapshot = this.#observerSnapshot(current, previousSnapshot);
        if (samePortable(previousSnapshot, nextSnapshot)) continue;
        const change = observerChange(previousSnapshot, nextSnapshot);
        this.#snapshot = nextSnapshot;
        for (const lease of Array.from(this.#leases)) lease.publish(nextSnapshot, change);
      }
    } finally {
      this.#refreshing = false;
    }
  }

  #refreshSourceSubscriptions(): void {
    for (const unsubscribe of this.#sourceUnsubscribes) unsubscribe();
    const subscribed = new Set<object>();
    const unsubscribes: (() => void)[] = [];
    for (const member of this.#options.dataset.snapshot().members) {
      const attachment = this.#options.attachments.get(member.attachmentId);
      if (attachment === undefined || subscribed.has(attachment.source)) continue;
      if (attachment.sourceId !== member.sourceId) continue;
      if (!this.#options.canRead(this.#options.authorityScope, attachment.authorityScope, attachment.attachmentId)) continue;
      subscribed.add(attachment.source);
      unsubscribes.push(attachment.source.subscribe(() => this.#requestRefresh()));
    }
    this.#sourceUnsubscribes = unsubscribes;
  }

  #capture(): EvaluationSnapshot<Projection> {
    const dataset = this.#options.dataset.snapshot();
    const members = dataset.members.map((member): CapturedMember<Projection> => {
      const raw = this.#options.attachments.get(member.attachmentId);
      if (raw === undefined) return { member, authorized: true };
      if (raw.sourceId !== member.sourceId) return { member, authorized: true, sourceMismatch: true };
      const authorized = this.#options.canRead(this.#options.authorityScope, raw.authorityScope, raw.attachmentId);
      if (!authorized) return { member, authorized: false };
      const attachment = raw as DatabaseAttachment<unknown, Projection>;
      const snapshot = attachment.source.snapshot() as SourceSnapshot<unknown>;
      const projection = snapshot.state === 'ready' ? attachment.project(snapshot) : undefined;
      return {
        member,
        attachment,
        snapshot,
        ...(projection === undefined ? {} : { projection }),
        authorized: true
      };
    });
    return { dataset, members };
  }

  #maintenanceInput(captured: EvaluationSnapshot<Projection>): DatabaseQueryMaintenanceInput<Query, Projection> {
    const available: AvailableQueryAttachment<Projection>[] = [];
    for (const candidate of captured.members) {
      if (candidate.attachment === undefined || candidate.snapshot === undefined || candidate.projection?.state !== 'ready') continue;
      available.push({ member: candidate.member, attachment: candidate.attachment, snapshot: candidate.snapshot, projection: candidate.projection.value });
    }
    return { query: this.#options.plan.query, parameters: this.#options.parameters, dataset: captured.dataset, attachments: available };
  }

  #openMaintenance(captured: EvaluationSnapshot<Projection>): DatabaseQueryMaintenanceSession<Query, Row, Projection> {
    try {
      return this.#options.createQueryMaintenance({ plan: this.#options.plan, initialInput: this.#maintenanceInput(captured) });
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
    const requiredUnavailable = evidence.some((item) => item.expectation === 'required' && (item.state !== 'ready' || !item.authorized));
    const inputsIncomplete = captured.dataset.state !== 'settled' || requiredUnavailable || resultIdentityIssue.length > 0;
    let completeness = maintained.completeness;
    if (inputsIncomplete && !(this.#options.allowPartial && completeness === 'lower-bound')) completeness = 'unknown';
    const rows = completeness === 'unknown' ? [] : maintained.rows;
    const resultKeys = completeness === 'unknown' ? [] : maintained.resultKeys;
    const basisAttachments = captured.members.flatMap((candidate) => candidate.snapshot === undefined ? [] : [{
      attachmentId: candidate.member.attachmentId,
      sourceId: candidate.member.sourceId,
      basis: candidate.snapshot.basis
    }]);
    return freezeResult({
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
): CreateDatabaseQueryMaintenance<QueryNode, QueryRecord, readonly RelationInput[]> => ({ plan, initialInput }) => {
  let accepted = queryMaintenanceSnapshot(initialInput, functions);
  const session = openIncrementalQueryMaintenance(plan, accepted);
  return {
    getCurrentResult: () => databaseResultFromMaintained(session.getCurrentResult()),
    updateInput: (input) => {
      const next = queryMaintenanceSnapshot(input as DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>, functions);
      const rejectedBefore = session.getCurrentResult().state.rejectedUpdateCount;
      const result = session.applyUpdate(deriveQueryMaintenanceUpdate(accepted, next));
      if (result.state.rejectedUpdateCount === rejectedBefore) accepted = next;
      return databaseResultFromMaintained(result);
    },
    close: () => session.close()
  };
};

const queryMaintenanceSnapshot = (
  input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>,
  functions: FunctionRegistry | undefined
): QueryMaintenanceSnapshot => ({
  relations: input.attachments.flatMap(({ member, snapshot, projection }) => projection.map((relation) => ({
    ...relation,
    sourceId: member.sourceId,
    attachmentId: member.attachmentId,
    basis: snapshot.basis
  }))),
  parameters: input.parameters,
  ...(functions === undefined ? {} : { functions }),
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

  publish(snapshot: ObserverSnapshot<Row>, change: ObserverChange<Row>): void {
    if (this.#closed) return;
    this.#snapshot = snapshot;
    for (const listener of Array.from(this.#listeners)) {
      try { listener(change); } catch { /* one consumer cannot break observation */ }
    }
  }
}

const sourceEvidence = <Projection>(candidate: CapturedMember<Projection>): SourceEvidence => {
  const { member } = candidate;
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
  for (const [key, item] of Object.entries(value)) output[key] = deepFreezeClone(item, seen);
  return Object.freeze(output) as Value;
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
