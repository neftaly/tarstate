import type { DatasetMember } from '../database-model.js';
import type { AttachmentCatalog, DatasetMembership } from '../database.js';
import { createIssue, type Issue } from '../issues.js';
import { runObserverCleanups, type ObserverDiagnosticReporter } from '../observer-diagnostics.js';
import type { ObserverSnapshot, QueryObserver } from '../observer.js';
import type { QueryRecord } from '../query/model.js';
import type { QueryNode } from '../query/model.js';
import type { PreparedPlan } from '../query/plan-contract.js';
import { assertPreparedPlan } from '../query/internal/prepared-plan.js';
import { parseObservationParameters } from '../internal-observer-values.js';
import type { JsonValue } from '../value.js';
import {
  buildDatabaseDiscoveryGraph,
  mergeDatabaseDiscoveryReferences,
  parseDatabaseDiscoveryReferences,
  sameDatabaseDiscoveryTarget,
  type DatabaseDiscoveryBudget,
  type DatabaseDiscoveryGraphProblem,
  type DatabaseDiscoveryTarget,
  type NormalizedDatabaseDiscoveryReference
} from './source-link-graph.js';
import type {
  DatabaseSourceMountLease,
  OwnedDatabaseSource,
  OpenLinkedDatabaseSource
} from './source-mount.js';

export type DatabaseSourceLinkFollower = {
  readonly close: () => void;
};

export type NormalizedFollowSourceLinks = {
  readonly plan: PreparedPlan<QueryNode>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly openSource: OpenLinkedDatabaseSource;
  readonly budget: DatabaseDiscoveryBudget;
};

export const normalizeFollowSourceLinks = (
  input: unknown,
  queryPlan: PreparedPlan<QueryNode>
): NormalizedFollowSourceLinks => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('followSourceLinks must be an object');
  }
  const candidate = input as {
    readonly plan?: unknown;
    readonly parameters?: unknown;
    readonly openSource?: unknown;
    readonly budget?: unknown;
  };
  if (typeof candidate.openSource !== 'function') {
    throw new TypeError('followSourceLinks.openSource must be a function');
  }
  assertPreparedPlan(candidate.plan as PreparedPlan<QueryNode>);
  const plan = candidate.plan as PreparedPlan<QueryNode>;
  if (plan.datasetId !== queryPlan.datasetId) {
    throw new TypeError('followSourceLinks.plan must use the query dataset');
  }
  if (plan.authorityFingerprint !== queryPlan.authorityFingerprint
    || plan.registryFingerprint !== queryPlan.registryFingerprint) {
    throw new TypeError('followSourceLinks.plan must use the query authority and registry');
  }
  return Object.freeze({
    plan,
    parameters: parseObservationParameters(candidate.parameters ?? {}),
    openSource: candidate.openSource as OpenLinkedDatabaseSource,
    budget: normalizeDiscoveryBudget(candidate.budget)
  });
};

type LinkedSourceRecord = {
  target: DatabaseDiscoveryTarget;
  readonly abort: AbortController;
  state: 'loading' | 'mounted' | 'missing' | 'failed';
  lease: DatabaseSourceMountLease | undefined;
  source: OwnedDatabaseSource | undefined;
  issues: readonly Issue[];
};

export const followDatabaseSourceLinks = (options: {
  readonly observer: QueryObserver<QueryRecord>;
  readonly catalog: AttachmentCatalog;
  readonly membership: DatasetMembership;
  readonly sourceLinkMembership: DatasetMembership;
  readonly rootMembers: readonly DatasetMember[];
  readonly openSource: OpenLinkedDatabaseSource;
  readonly budget: DatabaseDiscoveryBudget;
  readonly onDiagnostic?: ObserverDiagnosticReporter;
}): DatabaseSourceLinkFollower => {
  const rootSourceIds = Object.freeze(options.rootMembers.map(({ sourceId }) => sourceId));
  const rootAttachmentIds = new Set(options.rootMembers.map(({ attachmentId }) => attachmentId));
  const reservedRootIds = new Set(options.rootMembers.flatMap(({ attachmentId, sourceId }) =>
    attachmentId === sourceId ? [sourceId] : [attachmentId, sourceId]));
  let invalidEvidenceId = `tarstate:source-links:${options.membership.datasetId}`;
  while (reservedRootIds.has(invalidEvidenceId)) invalidEvidenceId += ':invalid';
  let budgetEvidenceId = invalidEvidenceId + ':budget';
  while (reservedRootIds.has(budgetEvidenceId)) budgetEvidenceId += ':budget';
  const linkedSources = new Map<string, LinkedSourceRecord>();
  let references: readonly NormalizedDatabaseDiscoveryReference[] = Object.freeze([]);
  let invalidIssue: Issue | undefined;
  let budgetIssue: Issue | undefined;
  let closed = false;
  let reconciling = false;
  let reconcileAgain = false;
  let publishingMembership = false;
  let publishMembershipAgain = false;
  let lastProcessedRows: readonly QueryRecord[] | undefined;
  let lastProcessedCompleteness: 'exact' | 'lower-bound' | undefined;
  let lastUnavailableOrigins: ReadonlySet<string> | undefined;

  const collectMembers = (includeInvalidIssue: boolean): {
    readonly members: DatasetMember[];
    readonly loading: boolean;
  } => {
    const members: DatasetMember[] = [...options.rootMembers];
    let loading = false;
    for (const record of linkedSources.values()) {
      const attachmentId = record.lease?.attachmentId
        ?? record.target.attachmentId
        ?? record.target.sourceId;
      const sourceAvailability = record.state === 'mounted'
        ? undefined
        : { state: record.state, issues: record.issues };
      loading ||= record.state === 'loading';
      members.push({
        attachmentId,
        sourceId: record.target.sourceId,
        expectation: record.target.expectation,
        discoveryEdges: record.target.discoveryEdges,
        ...(sourceAvailability === undefined ? {} : { sourceAvailability })
      });
    }
    if (includeInvalidIssue && invalidIssue !== undefined) {
      members.push({
        attachmentId: invalidEvidenceId,
        sourceId: invalidEvidenceId,
        expectation: 'required',
        discoveryEdges: [],
        sourceAvailability: { state: 'failed', issues: [invalidIssue] }
      });
    }
    if (includeInvalidIssue && budgetIssue !== undefined) {
      members.push({
        attachmentId: budgetEvidenceId,
        sourceId: budgetEvidenceId,
        expectation: 'required',
        discoveryEdges: [],
        sourceAvailability: { state: 'limited', issues: [budgetIssue] }
      });
    }
    return { members, loading };
  };

  const publishMembership = (): void => {
    if (closed) return;
    if (publishingMembership) {
      publishMembershipAgain = true;
      return;
    }
    publishingMembership = true;
    try {
      do {
        publishMembershipAgain = false;
        const sourceLinkMembers = collectMembers(false).members.map((member) => ({
          ...member,
          expectation: 'optional' as const
        }));
        options.sourceLinkMembership.replaceMembers(sourceLinkMembers, 'settled');
        if (publishMembershipAgain) continue;
        const current = collectMembers(true);
        options.membership.replaceMembers(
          current.members,
          current.loading ? 'open' : 'settled'
        );
      } while (publishMembershipAgain && !closed);
    } finally {
      publishingMembership = false;
    }
  };

  const recordIsCurrent = (record: LinkedSourceRecord): boolean =>
    !closed
    && !record.abort.signal.aborted
    && linkedSources.get(record.target.sourceId) === record;

  const failRecord = (
    record: LinkedSourceRecord,
    code: 'observer.linked_source_resolution_failed' | 'observer.linked_source_unavailable',
    details: Readonly<Record<string, string>>
  ): void => {
    if (!recordIsCurrent(record)) return;
    record.state = code === 'observer.linked_source_unavailable' ? 'missing' : 'failed';
    record.issues = Object.freeze([createIssue({
      code,
      sourceId: record.target.sourceId,
      retry: 'after_refresh',
      details
    })]);
    publishMembership();
  };

  const closeResources = (
    record: LinkedSourceRecord,
    operation: string,
    pendingLease?: DatabaseSourceMountLease
  ): void => {
    const lease = pendingLease ?? record.lease;
    const source = record.source;
    record.lease = undefined;
    record.source = undefined;
    runObserverCleanups(
      [
        ...(lease === undefined ? [] : [lease.close]),
        ...(source === undefined ? [] : [source.close])
      ],
      { component: 'database-view', operation },
      options.onDiagnostic
    );
  };

  const closeDetachedSource = (source: OwnedDatabaseSource, operation: string): void => {
    runObserverCleanups(
      [source.close],
      { component: 'database-view', operation },
      options.onDiagnostic
    );
  };

  const openRecord = (record: LinkedSourceRecord): void => {
    void Promise.resolve()
      .then(() => options.openSource(Object.freeze({
        sourceId: record.target.sourceId,
        ...(record.target.attachmentId === undefined ? {} : { attachmentId: record.target.attachmentId }),
        signal: record.abort.signal
      })))
      .then(async (source) => {
        if (source === undefined) {
          if (!recordIsCurrent(record)) return;
          failRecord(record, 'observer.linked_source_unavailable', { reason: 'source_unavailable' });
          return;
        }
        if (isFailedLinkedDatabaseSource(source)) {
          if (!recordIsCurrent(record)) return;
          record.state = 'failed';
          record.issues = Object.freeze(source.issues.map((issue) => createIssue({
            ...issue,
            sourceId: record.target.sourceId
          })));
          publishMembership();
          return;
        }
        if (!isOwnedDatabaseSource(source)) {
          if (!recordIsCurrent(record)) return;
          failRecord(record, 'observer.linked_source_resolution_failed', {
            reason: 'opened_source_must_provide_mount_and_close'
          });
          return;
        }
        if (!recordIsCurrent(record)) {
          closeDetachedSource(source, 'close-stale-opened-source');
          return;
        }
        record.source = source;
        const lease = await source.mount(options.catalog, {
          discoveryEdges: record.target.discoveryEdges
        });
        if (!recordIsCurrent(record)) {
          closeResources(record, 'close-stale-linked-source', lease);
          return;
        }
        const attachment = options.catalog.get(lease.attachmentId);
        const expectedAttachmentId = record.target.attachmentId;
        if (lease.sourceId !== record.target.sourceId
          || attachment?.sourceId !== lease.sourceId
          || (expectedAttachmentId !== undefined && lease.attachmentId !== expectedAttachmentId)) {
          closeResources(record, 'close-invalid-linked-source', lease);
          failRecord(record, 'observer.linked_source_resolution_failed', {
            reason: 'mounted_identity_mismatch'
          });
          return;
        }
        record.lease = lease;
        record.state = 'mounted';
        record.issues = Object.freeze([]);
        publishMembership();
      })
      .catch((error: unknown) => {
        if (!recordIsCurrent(record)) return;
        closeResources(record, 'close-failed-linked-source');
        failRecord(record, 'observer.linked_source_resolution_failed', {
          reason: 'open_failed',
          error: error instanceof Error ? error.name : typeof error
        });
      });
  };

  const removeRecord = (record: LinkedSourceRecord): void => {
    record.abort.abort();
    linkedSources.delete(record.target.sourceId);
  };

  const reconcileTargets = (
    targets: readonly DatabaseDiscoveryTarget[],
    forcePublish: boolean
  ): void => {
    const desired = new Map(targets.map((target) => [target.sourceId, target]));
    const removedRecords: LinkedSourceRecord[] = [];
    let changed = forcePublish;
    for (const record of linkedSources.values()) {
      const target = desired.get(record.target.sourceId);
      if (target === undefined || target.attachmentId !== record.target.attachmentId) {
        removeRecord(record);
        removedRecords.push(record);
        changed = true;
        continue;
      }
      if (!sameDatabaseDiscoveryTarget(record.target, target)) {
        record.target = target;
        changed = true;
      }
    }
    const added: LinkedSourceRecord[] = [];
    for (const target of targets) {
      if (linkedSources.has(target.sourceId)) continue;
      const record: LinkedSourceRecord = {
        target,
        abort: new AbortController(),
        state: 'loading',
        lease: undefined,
        source: undefined,
        issues: Object.freeze([])
      };
      linkedSources.set(target.sourceId, record);
      added.push(record);
      changed = true;
    }
    if (changed) publishMembership();
    for (let index = removedRecords.length - 1; index >= 0; index -= 1) {
      closeResources(removedRecords[index] as LinkedSourceRecord, 'close-unlinked-source');
    }
    for (const record of added) openRecord(record);
  };

  const rejectGraph = (problems: readonly DatabaseDiscoveryGraphProblem[]): void => {
    budgetIssue = undefined;
    invalidIssue = createIssue({
      code: 'observer.source_link_invalid',
      retry: 'after_input',
      details: { problems }
    });
    publishMembership();
  };

  const reconcileSnapshot = (snapshot: ObserverSnapshot<QueryRecord>): void => {
    if (closed || snapshot.state !== 'open') return;
    const current = snapshot.current;
    if (current.readiness === 'invalid') {
      const sourceIssueIds = new Set(current.sourceStates.flatMap(({ issues }) =>
        issues.map(({ id }) => id)));
      if (current.issues.some(({ code, id }) =>
        code === 'observer.evaluation_failed' && !sourceIssueIds.has(id))) {
        budgetIssue = undefined;
        invalidIssue = createIssue({
          code: 'observer.source_link_invalid',
          retry: 'after_refresh',
          details: { reason: 'query_invalid' }
        });
        publishMembership();
        return;
      }
    }
    if (current.completeness === 'unknown') return;
    const parsed = parseDatabaseDiscoveryReferences(current.rows);
    if (parsed.problems.length > 0) {
      rejectGraph(parsed.problems);
      return;
    }
    const unavailableOrigins = new Set<string>();
    for (const source of current.sourceStates) {
      if (source.state === 'loading' || source.state === 'failed' || source.state === 'missing') {
        unavailableOrigins.add(source.sourceId);
      }
    }
    if (current.rows === lastProcessedRows
      && current.completeness === lastProcessedCompleteness
      && lastUnavailableOrigins !== undefined
      && sameStringSet(unavailableOrigins, lastUnavailableOrigins)) {
      return;
    }
    const preservedReferences = references.filter(({ originSourceId }) =>
      unavailableOrigins.has(originSourceId));
    const merged = mergeDatabaseDiscoveryReferences(
      current.completeness === 'exact' ? preservedReferences : references,
      parsed.references
    );
    if (merged.problem !== undefined) {
      rejectGraph([merged.problem]);
      return;
    }
    const nextReferences = merged.references;
    const built = buildDatabaseDiscoveryGraph(rootSourceIds, nextReferences, options.budget);
    if (built.budgetExceeded !== undefined) {
      references = nextReferences;
      lastProcessedRows = current.rows;
      lastProcessedCompleteness = current.completeness;
      lastUnavailableOrigins = unavailableOrigins;
      invalidIssue = undefined;
      budgetIssue = createIssue({
        code: 'observer.source_link_budget_exceeded',
        retry: 'after_input',
        details: built.budgetExceeded
      });
      reconcileTargets([], true);
      return;
    }
    if (built.graph === undefined) {
      rejectGraph(built.problems);
      return;
    }
    const conflictingTarget = built.graph.targets.find((target) => {
      const attachmentId = target.attachmentId ?? target.sourceId;
      return rootAttachmentIds.has(attachmentId)
        || attachmentId === invalidEvidenceId
        || target.sourceId === invalidEvidenceId
        || attachmentId === budgetEvidenceId
        || target.sourceId === budgetEvidenceId;
    });
    if (conflictingTarget !== undefined) {
      rejectGraph([{
        kind: 'target-member-ambiguous',
        sourceId: conflictingTarget.sourceId,
        attachmentId: conflictingTarget.attachmentId ?? conflictingTarget.sourceId
      }]);
      return;
    }
    references = nextReferences;
    lastProcessedRows = current.rows;
    lastProcessedCompleteness = current.completeness;
    lastUnavailableOrigins = unavailableOrigins;
    const recovered = invalidIssue !== undefined || budgetIssue !== undefined;
    invalidIssue = undefined;
    budgetIssue = undefined;
    reconcileTargets(built.graph.targets, recovered);
  };

  const reconcile = (): void => {
    if (closed) return;
    if (reconciling) {
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    try {
      do {
        reconcileAgain = false;
        reconcileSnapshot(options.observer.getSnapshot());
      } while (reconcileAgain && !closed);
    } finally {
      reconciling = false;
    }
  };

  const unsubscribe = options.observer.subscribe(reconcile);
  reconcile();

  return Object.freeze({
    close: (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      const records = [...linkedSources.values()];
      for (const record of linkedSources.values()) {
        record.abort.abort();
      }
      linkedSources.clear();
      for (let index = records.length - 1; index >= 0; index -= 1) {
        closeResources(records[index] as LinkedSourceRecord, 'close-linked-sources');
      }
    }
  });
};

const normalizeDiscoveryBudget = (input: unknown): DatabaseDiscoveryBudget => {
  if (input === undefined) return Object.freeze({});
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('followSourceLinks.budget must be an object');
  }
  const budget = input as Readonly<Record<string, unknown>>;
  if (Object.keys(budget).some((key) => !discoveryBudgetFields.includes(key as typeof discoveryBudgetFields[number]))) {
    throw new TypeError('followSourceLinks.budget has an unknown field');
  }
  const normalized: Record<string, number> = {};
  for (const key of discoveryBudgetFields) {
    const value = budget[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new TypeError(`followSourceLinks.budget.${key} must be a non-negative safe integer`);
    }
    normalized[key] = value as number;
  }
  return Object.freeze(normalized);
};

const discoveryBudgetFields = [
  'maxLinkedSources',
  'maxDiscoveryEdges',
  'maxDepth',
  'maxTraversalSteps'
] as const;

const isOwnedDatabaseSource = (input: unknown): input is OwnedDatabaseSource =>
  input !== null
  && (typeof input === 'object' || typeof input === 'function')
  && typeof (input as { readonly mount?: unknown }).mount === 'function'
  && typeof (input as { readonly close?: unknown }).close === 'function';

const isFailedLinkedDatabaseSource = (
  input: unknown
): input is { readonly state: 'failed'; readonly issues: readonly Issue[] } =>
  input !== null
  && typeof input === 'object'
  && (input as { readonly state?: unknown }).state === 'failed'
  && Array.isArray((input as { readonly issues?: unknown }).issues)
  && (input as { readonly issues: readonly unknown[] }).issues.length > 0;

const sameStringSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
};
