import { canonicalizeJson } from './artifacts.js';
import type { ReadyAttachmentPreparation } from './attachment/preparation.js';
import type { DatabaseAttachment, DatasetMember, DatasetSnapshot } from './database-model.js';
import { comparePortableStrings } from './portable-order.js';
import { notifyObservers, type ObserverDiagnosticReporter } from './observer-diagnostics.js';
import type { ObservableSource } from './source-state.js';

export type { AttachmentProjection } from './attachment/model.js';
export type { DatabaseAttachment, DatasetMember, DatasetSnapshot } from './database-model.js';
export type {
  ObservableSource,
  SourceBasis,
  SourceFreshness,
  SourceLifecycleState,
  SourceSnapshot
} from './source-state.js';

export class DatasetMembership {
  readonly datasetId: string;
  readonly #listeners = new Set<() => void>();
  #snapshot: DatasetSnapshot;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;

  constructor(options: { readonly datasetId: string; readonly members?: readonly DatasetMember[]; readonly state?: 'open' | 'settled'; readonly onDiagnostic?: ObserverDiagnosticReporter }) {
    this.datasetId = options.datasetId;
    this.#onDiagnostic = options.onDiagnostic;
    this.#snapshot = freezeDataset({
      datasetId: options.datasetId,
      revision: 0,
      state: options.state ?? 'open',
      members: normalizeMembers(options.members ?? [])
    });
  }

  snapshot(): DatasetSnapshot { return this.#snapshot; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  replaceMembers(members: readonly DatasetMember[], state: 'open' | 'settled' = 'open'): DatasetSnapshot {
    const normalized = normalizeMembers(members);
    if (state === this.#snapshot.state && sameMembers(normalized, this.#snapshot.members)) return this.#snapshot;
    return this.#publish(state, normalized);
  }

  settle(): DatasetSnapshot {
    if (this.#snapshot.state === 'settled') return this.#snapshot;
    return this.#publish('settled', this.#snapshot.members);
  }

  reopen(): DatasetSnapshot {
    if (this.#snapshot.state === 'open') return this.#snapshot;
    return this.#publish('open', this.#snapshot.members);
  }

  #publish(state: 'open' | 'settled', members: readonly DatasetMember[]): DatasetSnapshot {
    this.#snapshot = freezeDataset({
      datasetId: this.datasetId,
      revision: this.#snapshot.revision + 1,
      state,
      members
    });
    notifyObservers(this.#listeners, (listener) => listener(), {
      component: 'dataset-membership', operation: 'publish'
    }, this.#onDiagnostic);
    return this.#snapshot;
  }
}

type AttachmentEntry = {
  readonly attachment: DatabaseAttachment;
  leases: number;
};

export type AttachmentLease<Storage = unknown, Projection = unknown> = {
  readonly attachment: DatabaseAttachment<Storage, Projection>;
  readonly close: () => void;
};

export type DatabaseAttachmentInput<Storage = unknown, Projection = unknown> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: ObservableSource<Storage>;
  readonly authorityScope: string;
  readonly discoveryEdges: readonly string[];
  readonly preparation: ReadyAttachmentPreparation<Storage, Projection>;
};

/**
 * Deduplicates live sources without merging their attachment authority views.
 * Every registration remains a separately closeable attachment lease.
 */
export class AttachmentCatalog {
  readonly #attachments = new Map<string, AttachmentEntry>();
  readonly #sources = new Map<string, ObservableSource<unknown>>();
  readonly #listeners = new Set<() => void>();
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;

  constructor(options: { readonly onDiagnostic?: ObserverDiagnosticReporter } = {}) {
    this.#onDiagnostic = options.onDiagnostic;
  }

  attach<Storage, Projection>(input: DatabaseAttachmentInput<Storage, Projection>, releaseSource?: () => void): AttachmentLease<Storage, Projection> {
    const attachment: DatabaseAttachment<Storage, Projection> = Object.freeze({
      attachmentId: input.attachmentId,
      incarnation: input.incarnation,
      sourceId: input.sourceId,
      source: input.source,
      authorityScope: input.authorityScope,
      writable: input.preparation.writable,
      schemaViewIds: Object.freeze([...input.preparation.schemaViewIds]),
      discoveryEdges: Object.freeze([...input.discoveryEdges]),
      project: input.preparation.project
    });
    if (attachment.sourceId !== attachment.source.sourceId) throw new Error('Attachment source ID does not match its source');
    const liveSource = this.#sources.get(attachment.sourceId);
    if (liveSource !== undefined && liveSource !== attachment.source) throw new Error('A different live source is registered for ' + attachment.sourceId);
    const existing = this.#attachments.get(attachment.attachmentId);
    if (existing !== undefined && !sameAttachment(existing.attachment, attachment)) throw new Error('A different live attachment is registered for ' + attachment.attachmentId);
    const entry = existing ?? { attachment: attachment as DatabaseAttachment, leases: 0 };
    if (existing === undefined) {
      this.#attachments.set(attachment.attachmentId, entry);
      this.#sources.set(attachment.sourceId, attachment.source as ObservableSource<unknown>);
      this.#notify();
    }
    entry.leases += 1;
    let closed = false;
    return {
      attachment: entry.attachment as DatabaseAttachment<Storage, Projection>,
      close: () => {
        if (closed) return;
        closed = true;
        let releaseFailed = false;
        let releaseError: unknown;
        try { releaseSource?.(); } catch (error) {
          releaseFailed = true;
          releaseError = error;
        }
        entry.leases -= 1;
        if (entry.leases === 0) {
          if (this.#attachments.get(attachment.attachmentId) === entry) this.#attachments.delete(attachment.attachmentId);
          if (!Array.from(this.#attachments.values()).some((candidate) => candidate.attachment.sourceId === attachment.sourceId)) this.#sources.delete(attachment.sourceId);
          this.#notify();
        }
        if (releaseFailed) throw releaseError;
      }
    };
  }

  get(attachmentId: string): DatabaseAttachment | undefined { return this.#attachments.get(attachmentId)?.attachment; }

  list(): readonly DatabaseAttachment[] {
    return [...this.#attachments.values()].map(({ attachment }) => attachment).sort((left, right) => comparePortableStrings(left.attachmentId, right.attachmentId));
  }

  sourceCount(): number { return this.#sources.size; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #notify(): void {
    notifyObservers(this.#listeners, (listener) => listener(), {
      component: 'attachment-catalog', operation: 'publish'
    }, this.#onDiagnostic);
  }
}

const normalizeMembers = (members: readonly DatasetMember[]): readonly DatasetMember[] => {
  const byAttachment = new Map<string, DatasetMember>();
  for (const member of members) {
    const normalized = Object.freeze({ ...member, discoveryEdges: Object.freeze([...new Set(member.discoveryEdges)].sort()) });
    const existing = byAttachment.get(member.attachmentId);
    if (existing !== undefined && canonicalizeJson(existing as never) !== canonicalizeJson(normalized as never)) throw new Error('Ambiguous dataset member ' + member.attachmentId);
    byAttachment.set(member.attachmentId, normalized);
  }
  return Object.freeze([...byAttachment.values()].sort((left, right) => comparePortableStrings(left.attachmentId, right.attachmentId)));
};

const sameMembers = (left: readonly DatasetMember[], right: readonly DatasetMember[]): boolean => canonicalizeJson(left as never) === canonicalizeJson(right as never);

const freezeDataset = (snapshot: DatasetSnapshot): DatasetSnapshot => Object.freeze({
  ...snapshot,
  members: Object.freeze([...snapshot.members])
});

type ComparableAttachment = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: object;
  readonly authorityScope: string;
  readonly writable: boolean;
  readonly schemaViewIds: readonly string[];
  readonly discoveryEdges: readonly string[];
  readonly project: unknown;
};

const sameAttachment = (left: ComparableAttachment, right: ComparableAttachment): boolean =>
  left === right || (
    left.attachmentId === right.attachmentId &&
    left.incarnation === right.incarnation &&
    left.sourceId === right.sourceId &&
    left.source === right.source &&
    left.authorityScope === right.authorityScope &&
    left.writable === right.writable &&
    sameStrings(left.schemaViewIds, right.schemaViewIds) &&
    sameStrings(left.discoveryEdges, right.discoveryEdges) &&
    left.project === right.project
  );

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
