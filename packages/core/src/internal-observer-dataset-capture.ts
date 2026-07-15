import {
  type AttachmentCatalog,
  type DatasetMembership
} from './database.js';
import type { DatabaseAttachment, DatasetMember } from './database-model.js';
import type { AttachmentProjection } from './attachment-model.js';
import { createIssue, type Issue } from './issues.js';
import {
  reportObserverFailure,
  runObserverCleanups,
  type ObserverDiagnosticReporter
} from './observer-diagnostics.js';
import type { SourceSnapshot } from './source-state.js';
import {
  assembleEvaluationSnapshot,
  type CapturedMember,
  type EvaluationSnapshot
} from './internal-observer-capture-core.js';

export type { AvailableQueryAttachment } from './observer-maintenance-contracts.js';
export type { CapturedMember, EvaluationSnapshot } from './internal-observer-capture-core.js';

export type DatasetCaptureState<Projection> =
  | { readonly state: 'captured'; readonly captured: EvaluationSnapshot<Projection> }
  | { readonly state: 'failed'; readonly captured: EvaluationSnapshot<Projection>; readonly error: unknown };

export type DatasetCaptureConsumer<Projection> = {
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
  readonly onDiagnostic?: ObserverDiagnosticReporter;
};

/** One authority-filtered capture and subscription topology shared by every active root in a dataset. */
export class DatasetCaptureRuntime<Projection> {
  readonly #options: DatasetCaptureRuntimeOptions;
  readonly #consumers = new Set<DatasetCaptureConsumer<Projection>>();
  #unsubscribeDataset: () => void = () => undefined;
  #unsubscribeCatalog: () => void = () => undefined;
  readonly #sourceUnsubscribes = new Map<object, () => void>();
  readonly #dirtySources = new Set<object>();
  readonly #sourceSnapshots = new WeakMap<object, { readonly snapshot: SourceSnapshot<unknown> } | { readonly error: unknown }>();
  readonly #projections = new WeakMap<object, {
    readonly snapshot: SourceSnapshot<unknown>;
    readonly projection: AttachmentProjection<Projection>;
  }>();
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
            try { consumer.stageFailure(this.#state.captured, error); } catch (consumerError) {
              reportObserverFailure('listener_error', {
                component: 'dataset-capture', operation: 'stage-capture-failure'
              }, consumerError, this.#options.onDiagnostic);
            }
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
            try { consumer.stageFailure(captured, error); } catch (consumerError) {
              reportObserverFailure('listener_error', {
                component: 'dataset-capture', operation: 'stage-fallback-failure'
              }, consumerError, this.#options.onDiagnostic);
            }
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
      } catch (error) {
        reportObserverFailure('cleanup_error', {
          component: 'dataset-capture', operation: 'unsubscribe-removed-source'
        }, error, this.#options.onDiagnostic);
        // Retain the handle so final cleanup can retry.
      }
    }
    for (const [source, observable] of desired) {
      if (this.#sourceUnsubscribes.has(source)) continue;
      this.#dirtySources.add(source);
      this.#sourceUnsubscribes.set(source, observable.subscribe(() => {
        this.#dirtySources.add(source);
        this.#requestRefresh();
      }));
    }
  }

  #capture(): EvaluationSnapshot<Projection> {
    const dataset = this.#options.dataset.snapshot();
    const snapshots = new Map<object, { readonly snapshot: SourceSnapshot<unknown> } | { readonly error: unknown }>();
    const candidates = dataset.members.map((member): CapturedMember<Projection> => {
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
        capturedSource = this.#dirtySources.has(attachment.source)
          ? undefined
          : this.#sourceSnapshots.get(attachment.source);
        if (capturedSource === undefined) {
          try {
            capturedSource = { snapshot: attachment.source.snapshot() as SourceSnapshot<unknown> };
          } catch (error) {
            capturedSource = { error };
          }
          this.#sourceSnapshots.set(attachment.source, capturedSource);
          this.#dirtySources.delete(attachment.source);
        }
        snapshots.set(attachment.source, capturedSource);
      }
      if ('error' in capturedSource) return { member, attachment, authorized: true, captureIssues: [captureFailureIssue('source_snapshot_failed', member, capturedSource.error)] };
      const snapshot = capturedSource.snapshot;
      if (snapshot.sourceId !== attachment.sourceId) return { member, attachment, authorized: true, sourceMismatch: true };
      let projection: AttachmentProjection<Projection> | undefined;
      if (snapshot.state === 'ready') {
        const cached = this.#projections.get(attachment);
        if (cached?.snapshot === snapshot) {
          projection = cached.projection;
        } else {
          try {
            projection = attachment.project(snapshot);
          } catch (error) {
            projection = { state: 'failed', issues: [captureFailureIssue('attachment_projection_failed', member, error)] };
          }
          this.#projections.set(attachment, { snapshot, projection });
        }
      }
      return {
        member,
        attachment,
        snapshot,
        ...(projection === undefined ? {} : { projection }),
        authorized: true
      };
    });
    return assembleEvaluationSnapshot({
      dataset,
      candidates,
      ...(this.#state === undefined ? {} : { previous: this.#state.captured })
    });
  }

  #cleanupSubscriptions(): void {
    runObserverCleanups([
      this.#unsubscribeDataset,
      this.#unsubscribeCatalog,
      ...this.#sourceUnsubscribes.values()
    ], { component: 'dataset-capture', operation: 'close-subscriptions' }, this.#options.onDiagnostic);
    this.#sourceUnsubscribes.clear();
    this.#dirtySources.clear();
  }
}

const captureFailureIssue = (reason: string, member: DatasetMember, error: unknown): Issue => createIssue({
  code: 'observer.evaluation_failed',
  phase: 'query',
  severity: 'error',
  retry: 'after_refresh',
  details: { reason, attachmentId: member.attachmentId, error: error instanceof Error ? error.name : typeof error }
});
