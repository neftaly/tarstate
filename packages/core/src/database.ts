import { canonicalizeJson } from './artifacts.js';
import type { ReadyAttachmentPreparation } from './attachment-preparation.js';
import type { Issue } from './issues.js';
import type { SourceBasis } from './maintenance.js';

export type SourceLifecycleState = 'loading' | 'ready' | 'failed' | 'denied' | 'deleted' | 'closed';
export type SourceFreshness = 'current' | 'stale' | 'none';

export type SourceSnapshot<Storage> = {
  readonly sourceId: string;
  readonly operationEpoch: string;
  readonly basis: SourceBasis;
  readonly state: SourceLifecycleState;
  readonly freshness: SourceFreshness;
  readonly storage?: Storage;
  readonly issues: readonly Issue[];
};

export type ObservableSource<Storage> = {
  readonly sourceId: string;
  readonly snapshot: () => SourceSnapshot<Storage>;
  readonly subscribe: (listener: () => void) => () => void;
};

export type AttachmentProjection<Projection> =
  | { readonly state: 'ready'; readonly value: Projection; readonly issues: readonly Issue[] }
  | { readonly state: Exclude<SourceLifecycleState, 'ready'>; readonly issues: readonly Issue[] };

export type DatabaseAttachment<Storage = unknown, Projection = unknown> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: ObservableSource<Storage>;
  readonly authorityScope: string;
  readonly writable: boolean;
  readonly schemaViewIds: readonly string[];
  readonly discoveryEdges: readonly string[];
  readonly project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>;
};

export type DatasetMember = {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly expectation: 'required' | 'optional';
  readonly discoveryEdges: readonly string[];
};

export type DatasetSnapshot = {
  readonly datasetId: string;
  readonly revision: number;
  readonly state: 'open' | 'settled';
  readonly members: readonly DatasetMember[];
};

export class DatasetMembership {
  readonly datasetId: string;
  readonly #listeners = new Set<() => void>();
  #snapshot: DatasetSnapshot;

  constructor(options: { readonly datasetId: string; readonly members?: readonly DatasetMember[]; readonly state?: 'open' | 'settled' }) {
    this.datasetId = options.datasetId;
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
    for (const listener of Array.from(this.#listeners)) {
      try { listener(); } catch { /* membership state must not depend on observers */ }
    }
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

  attach<Storage, Projection>(input: DatabaseAttachmentInput<Storage, Projection>, releaseSource?: () => void): AttachmentLease<Storage, Projection> {
    const attachment: DatabaseAttachment<Storage, Projection> = Object.freeze({
      attachmentId: input.attachmentId,
      incarnation: input.incarnation,
      sourceId: input.sourceId,
      source: input.source,
      authorityScope: input.authorityScope,
      writable: input.preparation.writable,
      schemaViewIds: input.preparation.schemaViewIds,
      discoveryEdges: input.discoveryEdges,
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
        releaseSource?.();
        entry.leases -= 1;
        if (entry.leases > 0) return;
        if (this.#attachments.get(attachment.attachmentId) === entry) this.#attachments.delete(attachment.attachmentId);
        if (!Array.from(this.#attachments.values()).some((candidate) => candidate.attachment.sourceId === attachment.sourceId)) this.#sources.delete(attachment.sourceId);
        this.#notify();
      }
    };
  }

  get(attachmentId: string): DatabaseAttachment | undefined { return this.#attachments.get(attachmentId)?.attachment; }

  list(): readonly DatabaseAttachment[] {
    return [...this.#attachments.values()].map(({ attachment }) => attachment).sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  }

  sourceCount(): number { return this.#sources.size; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #notify(): void {
    for (const listener of Array.from(this.#listeners)) {
      try { listener(); } catch { /* catalog state must not depend on observers */ }
    }
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
  return Object.freeze([...byAttachment.values()].sort((left, right) => left.attachmentId.localeCompare(right.attachmentId)));
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
