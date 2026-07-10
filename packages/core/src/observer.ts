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
import { FullRecomputeStrategy, type MaintenanceSession, type PreparedPlan, type SourceBasis } from './maintenance.js';
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

export type ObservedQueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly freshness: 'current' | 'stale' | 'mixed' | 'none';
  readonly basis: ObservationBasis;
  readonly sourceStates: readonly SourceEvidence[];
  readonly issues: readonly Issue[];
};

export type ObserverSnapshot<Row> =
  | { readonly state: 'open'; readonly current: ObservedQueryResult<Row>; readonly lastExact?: ObservedQueryResult<Row> }
  | { readonly state: 'closed' };

export type ResultDiff<Row> = {
  readonly added: readonly { readonly key: string; readonly row: Row }[];
  readonly removed: readonly { readonly key: string; readonly row: Row }[];
  readonly updated: readonly { readonly key: string; readonly before: Row; readonly after: Row }[];
};

export type ObserverChange<Row> =
  | { readonly kind: 'diff'; readonly diff: ResultDiff<Row>; readonly snapshot: ObserverSnapshot<Row> }
  | { readonly kind: 'invalidation'; readonly snapshot: ObserverSnapshot<Row> }
  | { readonly kind: 'reset'; readonly snapshot: ObserverSnapshot<Row> };

export interface QueryObserver<Row> {
  getSnapshot(): ObserverSnapshot<Row>;
  subscribe(listener: (change: ObserverChange<Row>) => void): () => void;
  close(): void;
}

export type AvailableAttachment<Projection> = {
  readonly member: DatasetMember;
  readonly attachment: DatabaseAttachment<unknown, Projection>;
  readonly snapshot: SourceSnapshot<unknown>;
  readonly projection: Projection;
};

export type DatabaseEvaluationInput<Query, Projection> = {
  readonly query: Query;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly dataset: DatasetSnapshot;
  readonly attachments: readonly AvailableAttachment<Projection>[];
};

export type DatabaseEvaluation<Row> = {
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export type DatabaseViewOptions<Query, Row, Projection> = {
  readonly authorityScope: string;
  readonly authorityFingerprint: string;
  readonly registryFingerprint: string;
  readonly attachments: AttachmentCatalog;
  readonly datasets: readonly DatasetMembership[];
  readonly canRead: (viewAuthorityScope: string, attachmentAuthorityScope: string, attachmentId: string) => boolean;
  readonly evaluate: (input: DatabaseEvaluationInput<Query, Projection>) => DatabaseEvaluation<Row>;
};

export type ObserveRequest<Query> = {
  readonly plan: PreparedPlan<Query>;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly allowPartial?: boolean;
};

/** Authority-filtered database shell with shared, full-recompute maintenance. */
export class DatabaseView<Query, Row, Projection = unknown> {
  readonly authorityScope: string;
  readonly authorityFingerprint: string;
  readonly registryFingerprint: string;
  readonly #attachments: AttachmentCatalog;
  readonly #datasets: ReadonlyMap<string, DatasetMembership>;
  readonly #canRead: DatabaseViewOptions<Query, Row, Projection>['canRead'];
  readonly #evaluate: DatabaseViewOptions<Query, Row, Projection>['evaluate'];
  readonly #cache = new Map<string, SharedObservation<Query, Row, Projection>>();
  #closed = false;

  constructor(options: DatabaseViewOptions<Query, Row, Projection>) {
    this.authorityScope = options.authorityScope;
    this.authorityFingerprint = options.authorityFingerprint;
    this.registryFingerprint = options.registryFingerprint;
    this.#attachments = options.attachments;
    this.#datasets = new Map(options.datasets.map((dataset) => [dataset.datasetId, dataset]));
    this.#canRead = options.canRead;
    this.#evaluate = options.evaluate;
  }

  observe(request: ObserveRequest<Query>): QueryObserver<Row> {
    if (this.#closed) throw new Error('Database view is closed');
    if (request.plan.registryFingerprint !== this.registryFingerprint) throw new Error('Prepared plan registry fingerprint does not match database view');
    if (request.plan.authorityFingerprint !== this.authorityFingerprint) throw new Error('Prepared plan authority fingerprint does not match database view');
    const dataset = this.#datasets.get(request.plan.datasetId);
    if (dataset === undefined) throw new Error('Dataset is not part of this database view: ' + request.plan.datasetId);
    const parameters = deepFreezeClone(request.parameters ?? {}) as Readonly<Record<string, JsonValue>>;
    const key = [
      request.plan.planId,
      canonicalizeJson(parameters as JsonValue),
      this.authorityScope,
      this.authorityFingerprint,
      this.registryFingerprint,
      request.plan.datasetId,
      request.allowPartial === true ? 'partial' : 'exact'
    ].join('\u0000');
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
        evaluate: this.#evaluate,
        collect: () => {
          if (this.#cache.get(key) === shared) this.#cache.delete(key);
        }
      });
      this.#cache.set(key, shared);
    }
    return shared.acquire();
  }

  activeMaintenanceCount(): number { return this.#cache.size; }

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
  readonly evaluate: DatabaseViewOptions<Query, Row, Projection>['evaluate'];
  readonly collect: () => void;
};

class SharedObservation<Query, Row, Projection> {
  readonly #options: SharedOptions<Query, Row, Projection>;
  readonly #leases = new Set<ObserverLease<Row>>();
  readonly #unsubscribeDataset: () => void;
  readonly #unsubscribeCatalog: () => void;
  #sourceUnsubscribes: readonly (() => void)[] = [];
  #session: MaintenanceSession<Row, EvaluationSnapshot<Projection>, unknown> | undefined;
  #snapshot: ObserverSnapshot<Row>;
  #leaseCount = 0;
  #refreshing = false;
  #pending = false;
  #closed = false;

  constructor(options: SharedOptions<Query, Row, Projection>) {
    this.#options = options;
    const captured = this.#capture();
    const strategy = new FullRecomputeStrategy<Query, Row, EvaluationSnapshot<Projection>, unknown>((plan, snapshot) => this.#evaluate(plan, snapshot));
    this.#session = strategy.open(options.plan, { snapshot: captured });
    this.#snapshot = this.#observerSnapshot(this.#result(this.#session.current(), captured), undefined);
    this.#refreshSourceSubscriptions();
    this.#unsubscribeDataset = options.dataset.subscribe(() => this.#requestRefresh());
    this.#unsubscribeCatalog = options.attachments.subscribe(() => this.#requestRefresh());
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
        this.#refreshSourceSubscriptions();
        const captured = this.#capture();
        const session = this.#session;
        if (session === undefined) continue;
        const maintained = session.update({ snapshot: captured });
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

  #evaluate(plan: PreparedPlan<Query>, captured: EvaluationSnapshot<Projection>): DatabaseEvaluation<Row> {
    const available: AvailableAttachment<Projection>[] = [];
    for (const candidate of captured.members) {
      if (candidate.attachment === undefined || candidate.snapshot === undefined || candidate.projection?.state !== 'ready') continue;
      available.push({ member: candidate.member, attachment: candidate.attachment, snapshot: candidate.snapshot, projection: candidate.projection.value });
    }
    try {
      return this.#options.evaluate({ query: plan.query, parameters: this.#options.parameters, dataset: captured.dataset, attachments: available });
    } catch (error) {
      return {
        rows: [],
        resultKeys: [],
        completeness: 'unknown',
        issues: [observationIssue('observer.evaluation_failed', 'after_refresh', { error: error instanceof Error ? error.name : typeof error })]
      };
    }
  }

  #result(maintained: DatabaseEvaluation<Row>, captured: EvaluationSnapshot<Projection>): ObservedQueryResult<Row> {
    const evidence = captured.members.map(sourceEvidence);
    const evidenceIssues = evidence.flatMap(({ issues }) => issues);
    const membershipIssue = captured.dataset.state === 'open'
      ? [observationIssue('observer.membership_open', 'after_refresh', { datasetId: captured.dataset.datasetId, revision: captured.dataset.revision })]
      : [];
    const requiredUnavailable = evidence.some((item) => item.expectation === 'required' && (item.state !== 'ready' || !item.authorized));
    const inputsIncomplete = captured.dataset.state !== 'settled' || requiredUnavailable;
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
      issues: [...evidenceIssues, ...membershipIssue, ...maintained.issues]
    });
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
