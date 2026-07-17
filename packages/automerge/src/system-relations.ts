import {
  canonicalizeJson,
  createIssue,
  type JsonValue
} from '@tarstate/core';
import type { ObserverDiagnosticReporter } from '@tarstate/core/database/observer';
import type { SchemaBody } from '@tarstate/core/schema';
import type { AutomergeConflictFact } from './document/projection.js';
import type { AutomergeBasis } from './source/runtime.js';
import { comparePortableStrings } from './shared/portable-order.js';

export const automergeSystemRelationIds = Object.freeze({
  peers: 'tarstate.automerge.peers',
  connections: 'tarstate.automerge.connections',
  sync: 'tarstate.automerge.sync',
  conflicts: 'tarstate.automerge.conflicts',
  presence: 'tarstate.automerge.presence'
} as const);

const stringField = { type: { kind: 'string' as const } };
const integerField = { type: { kind: 'integer' as const } };
const jsonField = { type: { kind: 'json' as const } };

/** Adapter-owned portable schema for the five built-in Automerge relations. */
export const automergeSystemSchema = deepFreezeClone({
  description: 'Tarstate v1 normalized Automerge Repo observations',
  metadata: { adapter: '@tarstate/automerge', formatVersion: 1 },
  relations: {
    peers: {
      relationId: automergeSystemRelationIds.peers,
      key: ['attachmentId', 'peerId'],
      fields: {
        attachmentId: stringField,
        peerId: stringField,
        state: { type: { kind: 'string', values: ['observed', 'disconnected'] } },
        observedAt: integerField,
        storageId: { ...stringField, optional: true },
        isEphemeral: { type: { kind: 'boolean' }, optional: true },
        metadata: { ...jsonField, optional: true }
      }
    },
    connections: {
      relationId: automergeSystemRelationIds.connections,
      key: ['attachmentId', 'peerId'],
      fields: {
        attachmentId: stringField,
        peerId: stringField,
        state: { type: { kind: 'string', values: ['connected', 'disconnected'] } },
        observedAt: integerField
      },
      description: 'Repo exposes peer lifecycle but no generic connection ID.'
    },
    sync: {
      relationId: automergeSystemRelationIds.sync,
      key: ['attachmentId', 'documentId', 'storageId'],
      fields: {
        attachmentId: stringField,
        documentId: stringField,
        storageId: stringField,
        state: { type: { kind: 'string', values: ['observed', 'offline', 'idle', 'syncing', 'synced', 'error'] } },
        heads: { ...jsonField, optional: true },
        observedAt: integerField,
        peerId: { ...stringField, optional: true },
        errorCode: { ...stringField, optional: true }
      }
    },
    conflicts: {
      relationId: automergeSystemRelationIds.conflicts,
      key: ['issueId'],
      fields: {
        issueId: stringField,
        attachmentId: stringField,
        sourceId: stringField,
        relationId: { ...stringField, optional: true },
        logicalKey: { ...jsonField, optional: true },
        path: jsonField,
        basis: jsonField,
        alternatives: jsonField,
        alternativeCount: integerField,
        alternativesTruncated: { type: { kind: 'boolean' } }
      }
    },
    presence: {
      relationId: automergeSystemRelationIds.presence,
      key: ['attachmentId', 'peerId', 'channel'],
      fields: {
        attachmentId: stringField,
        peerId: stringField,
        channel: stringField,
        origin: { type: { kind: 'string', values: ['local', 'observed'] } },
        state: { type: { kind: 'string', values: ['active', 'stopped', 'expired'] } },
        value: jsonField,
        lastActiveAt: integerField,
        lastSeenAt: integerField,
        expiresAt: { ...integerField, optional: true }
      }
    }
  }
} satisfies SchemaBody);

export type AutomergePeerSystemRow = {
  readonly attachmentId: string;
  readonly peerId: string;
  readonly state: 'observed' | 'disconnected';
  readonly observedAt: number;
  readonly storageId?: string;
  readonly isEphemeral?: boolean;
  readonly metadata?: JsonValue;
};

export type AutomergeConnectionSystemRow = {
  readonly attachmentId: string;
  readonly peerId: string;
  readonly state: 'connected' | 'disconnected';
  readonly observedAt: number;
};

export type AutomergeSyncState = 'observed' | 'offline' | 'idle' | 'syncing' | 'synced' | 'error';

export type AutomergeSyncSystemRow = {
  readonly attachmentId: string;
  readonly documentId: string;
  readonly storageId: string;
  readonly state: AutomergeSyncState;
  readonly heads?: readonly string[];
  readonly observedAt: number;
  readonly peerId?: string;
  readonly errorCode?: string;
};

export type AutomergeConflictSystemRow = {
  readonly issueId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly relationId?: string;
  readonly logicalKey?: JsonValue;
  readonly path: JsonValue;
  readonly basis: JsonValue;
  readonly alternatives: JsonValue;
  readonly alternativeCount: number;
  readonly alternativesTruncated: boolean;
};

export type AutomergePresenceSystemRow = {
  readonly attachmentId: string;
  readonly peerId: string;
  readonly channel: string;
  readonly origin: 'local' | 'observed';
  readonly state: 'active' | 'stopped' | 'expired';
  readonly value: JsonValue;
  readonly lastActiveAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt?: number;
};

export type AutomergeSystemRows = {
  readonly peers: readonly AutomergePeerSystemRow[];
  readonly connections: readonly AutomergeConnectionSystemRow[];
  readonly sync: readonly AutomergeSyncSystemRow[];
  readonly conflicts: readonly AutomergeConflictSystemRow[];
  readonly presence: readonly AutomergePresenceSystemRow[];
};

export type AutomergeSystemRelationSnapshot = AutomergeSystemRows & {
  readonly revision: number;
};

const materializeAutomergePeerRow = (input: AutomergePeerSystemRow): AutomergePeerSystemRow =>
  deepFreezeClone(input);

const materializeAutomergeConnectionRow = (input: AutomergeConnectionSystemRow): AutomergeConnectionSystemRow =>
  deepFreezeClone(input);

const materializeAutomergeSyncRow = (input: AutomergeSyncSystemRow): AutomergeSyncSystemRow => deepFreezeClone({
  ...input,
  ...(input.heads === undefined ? {} : { heads: [...new Set(input.heads)].sort() })
});

const materializeAutomergePresenceRow = (input: AutomergePresenceSystemRow): AutomergePresenceSystemRow =>
  deepFreezeClone(input);

export type ConflictLogicalEvidence = {
  readonly relationId: string;
  readonly logicalKey: JsonValue;
};

/**
 * Materializes already-authorized projection facts. Callers decide whether a
 * logical relation/key/path is visible before supplying `logicalEvidence`.
 */
export const materializeAutomergeConflictRows = (input: {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly basis: AutomergeBasis;
  readonly conflicts: readonly AutomergeConflictFact[];
  readonly maxAlternatives?: number;
  readonly logicalEvidence?: (conflict: AutomergeConflictFact) => ConflictLogicalEvidence | undefined;
}): readonly AutomergeConflictSystemRow[] => {
  const limit = input.maxAlternatives ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('maxAlternatives must be a non-negative safe integer');
  const basis = { kind: input.basis.kind, heads: [...new Set(input.basis.heads)].sort() } satisfies AutomergeBasis;
  return Object.freeze(input.conflicts.map((conflict) => {
    const logical = input.logicalEvidence?.(conflict);
    const alternatives = [...conflict.alternatives].sort((left, right) => comparePortableStrings(left.changeHash, right.changeHash));
    const issue = createIssue({
      code: 'automerge.conflict_observed',
      phase: 'query',
      severity: 'warning',
      retry: 'manual_repair',
      sourceId: input.sourceId,
      relationId: logical?.relationId ?? automergeSystemRelationIds.conflicts,
      path: conflict.path,
      ...(logical === undefined ? {} : { key: logical.logicalKey }),
      details: { attachmentId: input.attachmentId, basis }
    });
    return deepFreezeClone({
      issueId: issue.id,
      attachmentId: input.attachmentId,
      sourceId: input.sourceId,
      ...(logical === undefined ? {} : { relationId: logical.relationId, logicalKey: logical.logicalKey }),
      path: conflict.path as JsonValue,
      basis: basis as unknown as JsonValue,
      alternatives: alternatives.slice(0, limit).map(({ changeHash, value, childObjectId }) => ({
        changeHash,
        value,
        ...(childObjectId === undefined ? {} : { childObjectId })
      })) as JsonValue,
      alternativeCount: alternatives.length,
      alternativesTruncated: alternatives.length > limit
    });
  }).sort((left, right) => comparePortableStrings(left.issueId, right.issueId)));
};

export type AutomergeSystemEvent =
  | {
      readonly kind: 'peer-observed';
      readonly peerId: string;
      readonly observedAt: number;
      readonly peerMetadata?: { readonly storageId?: string; readonly isEphemeral?: boolean; readonly metadata?: JsonValue };
    }
  | { readonly kind: 'peer-disconnected'; readonly peerId: string; readonly observedAt: number }
  | {
      readonly kind: 'sync-state';
      readonly documentId: string;
      readonly storageId: string;
      readonly state: AutomergeSyncState;
      readonly observedAt: number;
      readonly heads?: readonly string[];
      readonly peerId?: string;
      readonly errorCode?: string;
    }
  | {
      readonly kind: 'remote-heads-observed';
      readonly documentId: string;
      readonly storageId: string;
      readonly heads: readonly string[];
      readonly observedAt: number;
      readonly peerId?: string;
    }
  | {
      readonly kind: 'presence-set';
      readonly peerId: string;
      readonly channel: string;
      readonly origin: 'local' | 'observed';
      readonly value: JsonValue;
      readonly observedAt: number;
    }
  | { readonly kind: 'presence-heartbeat'; readonly peerId: string; readonly observedAt: number }
  | { readonly kind: 'presence-stop'; readonly peerId: string; readonly observedAt: number; readonly reason: 'goodbye' | 'expired' }
  | { readonly kind: 'conflicts-replaced'; readonly rows: readonly AutomergeConflictSystemRow[] };

type SystemRelationChanges = number;
const noSystemRelationChanges = 0;
const systemRelationChanges = Object.freeze({
  peers: 1,
  connections: 2,
  sync: 4,
  conflicts: 8,
  presence: 16
});

/** Pure event normalizer; attaching it to Repo event emitters remains host code. */
export class AutomergeSystemRelationState {
  readonly attachmentId: string;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #peers = new Map<string, AutomergePeerSystemRow>();
  readonly #connections = new Map<string, AutomergeConnectionSystemRow>();
  readonly #sync = new Map<string, AutomergeSyncSystemRow>();
  readonly #explicitSyncPeers = new Set<string>();
  readonly #presence = new Map<string, AutomergePresenceSystemRow>();
  #conflicts: readonly AutomergeConflictSystemRow[] = Object.freeze([]);
  #snapshot: AutomergeSystemRelationSnapshot;
  #closed = false;

  constructor(attachmentId: string, options: { readonly onDiagnostic?: ObserverDiagnosticReporter } = {}) {
    if (attachmentId.length === 0) throw new TypeError('attachmentId must not be empty');
    this.attachmentId = attachmentId;
    this.#onDiagnostic = options.onDiagnostic;
    this.#snapshot = emptySystemRelationSnapshot(0);
  }

  getSnapshot(): AutomergeSystemRelationSnapshot { return this.#snapshot; }

  subscribe(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  apply(event: AutomergeSystemEvent): AutomergeSystemRelationSnapshot {
    if (this.#closed) throw new Error('Automerge system relation state is closed');
    validateEventTime(event);
    let changed: SystemRelationChanges = noSystemRelationChanges;
    switch (event.kind) {
      case 'peer-observed': changed = this.#observePeer(event); break;
      case 'peer-disconnected': changed = this.#disconnectPeer(event); break;
      case 'sync-state': changed = this.#setSync(event); break;
      case 'remote-heads-observed': changed = this.#observeRemoteHeads(event); break;
      case 'presence-set': changed = this.#setPresence(event); break;
      case 'presence-heartbeat': changed = this.#heartbeat(event); break;
      case 'presence-stop': changed = this.#stopPresence(event); break;
      case 'conflicts-replaced': changed = this.#replaceConflicts(event.rows); break;
      default: assertNever(event);
    }
    return this.#publish(changed);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#peers.clear();
    this.#connections.clear();
    this.#sync.clear();
    this.#explicitSyncPeers.clear();
    this.#presence.clear();
    this.#conflicts = Object.freeze([]);
    this.#snapshot = emptySystemRelationSnapshot(this.#snapshot.revision + 1);
  }

  #observePeer(event: Extract<AutomergeSystemEvent, { readonly kind: 'peer-observed' }>): SystemRelationChanges {
    const metadata = event.peerMetadata;
    const prior = this.#peers.get(event.peerId);
    const next = materializeAutomergePeerRow({
      attachmentId: this.attachmentId,
      peerId: event.peerId,
      state: 'observed',
      observedAt: event.observedAt,
      ...(metadata?.storageId === undefined ? {} : { storageId: metadata.storageId }),
      ...(metadata?.isEphemeral === undefined ? {} : { isEphemeral: metadata.isEphemeral }),
      ...(metadata?.metadata === undefined ? {} : { metadata: metadata.metadata })
    });
    if (observationDecision(prior, next, (row) => row.observedAt) === 'ignore') return noSystemRelationChanges;
    this.#peers.set(event.peerId, next);
    this.#connections.set(event.peerId, materializeAutomergeConnectionRow({
      attachmentId: this.attachmentId,
      peerId: event.peerId,
      state: 'connected',
      observedAt: event.observedAt
    }));
    let syncChanged = false;
    if (prior?.storageId !== undefined && prior.storageId !== metadata?.storageId) syncChanged = this.#correlateStorage(prior.storageId) || syncChanged;
    if (metadata?.storageId !== undefined) syncChanged = this.#correlateStorage(metadata.storageId) || syncChanged;
    return systemRelationChanges.peers | systemRelationChanges.connections | (syncChanged ? systemRelationChanges.sync : 0);
  }

  #disconnectPeer(event: Extract<AutomergeSystemEvent, { readonly kind: 'peer-disconnected' }>): SystemRelationChanges {
    const previous = this.#peers.get(event.peerId);
    const next = materializeAutomergePeerRow({
      attachmentId: this.attachmentId,
      peerId: event.peerId,
      state: 'disconnected',
      observedAt: event.observedAt,
      ...(previous?.storageId === undefined ? {} : { storageId: previous.storageId }),
      ...(previous?.isEphemeral === undefined ? {} : { isEphemeral: previous.isEphemeral }),
      ...(previous?.metadata === undefined ? {} : { metadata: previous.metadata })
    });
    if (observationDecision(previous, next, (row) => row.observedAt) === 'ignore') return noSystemRelationChanges;
    this.#peers.set(event.peerId, next);
    this.#connections.set(event.peerId, materializeAutomergeConnectionRow({
      attachmentId: this.attachmentId,
      peerId: event.peerId,
      state: 'disconnected',
      observedAt: event.observedAt
    }));
    const syncChanged = previous?.storageId !== undefined && this.#correlateStorage(previous.storageId);
    return systemRelationChanges.peers | systemRelationChanges.connections | (syncChanged ? systemRelationChanges.sync : 0);
  }

  #setSync(event: Extract<AutomergeSystemEvent, { readonly kind: 'sync-state' }>): SystemRelationChanges {
    const key = syncKey(event.documentId, event.storageId);
    const previous = this.#sync.get(key);
    const previousWasExplicit = this.#explicitSyncPeers.has(key);
    const comparablePrevious = previous === undefined || previousWasExplicit || previous.peerId === undefined
      ? previous
      : omitPeerId(previous);
    const next = materializeAutomergeSyncRow({
      attachmentId: this.attachmentId,
      documentId: event.documentId,
      storageId: event.storageId,
      state: event.state,
      observedAt: event.observedAt,
      ...(event.heads === undefined ? {} : { heads: event.heads }),
      ...(event.peerId === undefined ? {} : { peerId: event.peerId }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode })
    });
    if (observationDecision(comparablePrevious, next, (row) => row.observedAt) === 'ignore') return noSystemRelationChanges;
    if (event.peerId === undefined) this.#explicitSyncPeers.delete(key);
    else this.#explicitSyncPeers.add(key);
    this.#sync.set(key, next);
    this.#correlateStorage(event.storageId);
    return systemRelationChanges.sync;
  }

  #observeRemoteHeads(event: Extract<AutomergeSystemEvent, { readonly kind: 'remote-heads-observed' }>): SystemRelationChanges {
    return this.#setSync({
      kind: 'sync-state',
      documentId: event.documentId,
      storageId: event.storageId,
      state: 'observed',
      observedAt: event.observedAt,
      heads: event.heads,
      ...(event.peerId === undefined ? {} : { peerId: event.peerId })
    });
  }

  #setPresence(event: Extract<AutomergeSystemEvent, { readonly kind: 'presence-set' }>): SystemRelationChanges {
    const key = presenceKey(event.peerId, event.channel);
    const previous = this.#presence.get(key);
    const next = materializeAutomergePresenceRow({
      attachmentId: this.attachmentId,
      peerId: event.peerId,
      channel: event.channel,
      origin: event.origin,
      state: 'active',
      value: event.value,
      lastActiveAt: event.observedAt,
      lastSeenAt: event.observedAt
    });
    if (observationDecision(previous, next, (row) => row.lastSeenAt) === 'ignore') return noSystemRelationChanges;
    this.#presence.set(key, next);
    return systemRelationChanges.presence;
  }

  #heartbeat(event: Extract<AutomergeSystemEvent, { readonly kind: 'presence-heartbeat' }>): SystemRelationChanges {
    let changed = false;
    for (const [key, row] of this.#presence) {
      if (row.peerId !== event.peerId || row.state !== 'active') continue;
      if (row.lastSeenAt >= event.observedAt) continue;
      this.#presence.set(key, materializeAutomergePresenceRow({ ...row, lastSeenAt: event.observedAt }));
      changed = true;
    }
    return changed ? systemRelationChanges.presence : noSystemRelationChanges;
  }

  #stopPresence(event: Extract<AutomergeSystemEvent, { readonly kind: 'presence-stop' }>): SystemRelationChanges {
    const updates: [string, AutomergePresenceSystemRow][] = [];
    for (const [key, row] of this.#presence) {
      if (row.peerId !== event.peerId || row.state !== 'active') continue;
      const next = materializeAutomergePresenceRow({
        ...row,
        state: event.reason === 'expired' ? 'expired' : 'stopped',
        lastSeenAt: event.observedAt,
        expiresAt: event.observedAt
      });
      if (observationDecision(row, next, (candidate) => candidate.lastSeenAt) === 'replace') updates.push([key, next]);
    }
    for (const [key, row] of updates) this.#presence.set(key, row);
    return updates.length === 0 ? noSystemRelationChanges : systemRelationChanges.presence;
  }

  #replaceConflicts(rows: readonly AutomergeConflictSystemRow[]): SystemRelationChanges {
    const byIssue = new Map<string, AutomergeConflictSystemRow>();
    for (const input of rows) {
      if (input.attachmentId !== this.attachmentId) throw new TypeError('Conflict row belongs to a different attachment');
      const row = materializeConflictRow(input);
      const previous = byIssue.get(row.issueId);
      const previousValue = previous === undefined ? undefined : canonicalizeJson(previous as unknown as JsonValue);
      const nextValue = canonicalizeJson(row as unknown as JsonValue);
      if (previousValue === undefined || comparePortableStrings(previousValue, nextValue) < 0) byIssue.set(row.issueId, row);
    }
    const conflicts = Object.freeze([...byIssue.values()].sort((left, right) => comparePortableStrings(left.issueId, right.issueId)));
    if (sameConflictRows(this.#conflicts, conflicts)) return noSystemRelationChanges;
    this.#conflicts = conflicts;
    return systemRelationChanges.conflicts;
  }

  #correlateStorage(storageId: string): boolean {
    let candidatePeerId: string | undefined;
    let ambiguous = false;
    for (const peer of this.#peers.values()) {
      if (peer.state !== 'observed' || peer.storageId !== storageId) continue;
      if (candidatePeerId !== undefined) {
        ambiguous = true;
        break;
      }
      candidatePeerId = peer.peerId;
    }
    let changed = false;
    for (const [key, row] of this.#sync) {
      if (row.storageId !== storageId || this.#explicitSyncPeers.has(key)) continue;
      if (!ambiguous && candidatePeerId !== undefined) {
        if (row.peerId !== candidatePeerId) {
          this.#sync.set(key, materializeAutomergeSyncRow({ ...row, peerId: candidatePeerId }));
          changed = true;
        }
      } else if (row.peerId !== undefined) {
        const { peerId: _peerId, ...uncorrelated } = row;
        this.#sync.set(key, materializeAutomergeSyncRow(uncorrelated));
        changed = true;
      }
    }
    return changed;
  }

  #publish(changed: SystemRelationChanges): AutomergeSystemRelationSnapshot {
    if (changed === noSystemRelationChanges) return this.#snapshot;
    const candidate = Object.freeze({
      revision: this.#snapshot.revision + 1,
      peers: changed & systemRelationChanges.peers ? sortedValues(this.#peers, (row) => row.peerId) : this.#snapshot.peers,
      connections: changed & systemRelationChanges.connections ? sortedValues(this.#connections, (row) => row.peerId) : this.#snapshot.connections,
      sync: changed & systemRelationChanges.sync ? sortedValues(this.#sync, (row) => syncKey(row.documentId, row.storageId)) : this.#snapshot.sync,
      conflicts: changed & systemRelationChanges.conflicts ? this.#conflicts : this.#snapshot.conflicts,
      presence: changed & systemRelationChanges.presence ? sortedValues(this.#presence, (row) => presenceKey(row.peerId, row.channel)) : this.#snapshot.presence
    });
    this.#snapshot = candidate;
    for (const listener of Array.from(this.#listeners)) {
      try { listener(); } catch (error) {
        try {
          this.#onDiagnostic?.(Object.freeze({
            kind: 'listener_error',
            component: 'automerge-system-relations',
            operation: 'publish',
            error
          }));
        } catch { /* diagnostics are observers and cannot break normalized state */ }
      }
    }
    return candidate;
  }
}

const assertNever = (value: never): never => { throw new TypeError('Unsupported Automerge system event: ' + String(value)); };

const materializeConflictRow = (row: AutomergeConflictSystemRow): AutomergeConflictSystemRow => deepFreezeClone(row);
const omitPeerId = (row: AutomergeSyncSystemRow): AutomergeSyncSystemRow => {
  const { peerId: _peerId, ...withoutPeer } = row;
  return withoutPeer;
};

const observationDecision = <Row>(
  previous: Row | undefined,
  next: Row,
  observedAt: (row: Row) => number
): 'ignore' | 'replace' => {
  if (previous === undefined) return 'replace';
  const previousTime = observedAt(previous);
  const nextTime = observedAt(next);
  if (previousTime > nextTime) return 'ignore';
  if (previousTime < nextTime) return 'replace';
  return comparePortableStrings(canonicalizeJson(previous as unknown as JsonValue), canonicalizeJson(next as unknown as JsonValue)) < 0 ? 'replace' : 'ignore';
};
const stringTupleKey = (...parts: readonly string[]): string => {
  let key = '';
  for (const part of parts) key += part.length + ':' + part;
  return key;
};
const syncKey = (documentId: string, storageId: string): string => stringTupleKey(documentId, storageId);
const presenceKey = (peerId: string, channel: string): string => stringTupleKey(peerId, channel);

const sortedValues = <Row>(rows: ReadonlyMap<string, Row>, key: (row: Row) => string): readonly Row[] =>
  Object.freeze([...rows.values()].sort((left, right) => comparePortableStrings(key(left), key(right))));

const sameConflictRows = (left: readonly AutomergeConflictSystemRow[], right: readonly AutomergeConflictSystemRow[]): boolean =>
  left.length === right.length && left.every((row, index) => row === right[index]
    || canonicalizeJson(row as unknown as JsonValue) === canonicalizeJson(right[index] as unknown as JsonValue));

const emptySystemRelationSnapshot = (revision: number): AutomergeSystemRelationSnapshot => Object.freeze({
  revision,
  peers: Object.freeze([]),
  connections: Object.freeze([]),
  sync: Object.freeze([]),
  conflicts: Object.freeze([]),
  presence: Object.freeze([])
});

const validateEventTime = (event: AutomergeSystemEvent): void => {
  if (event.kind === 'conflicts-replaced') return;
  const value = event.observedAt;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Automerge observation time must be a non-negative safe integer');
};

function deepFreezeClone<Value>(value: Value, seen = new WeakMap<object, object>()): Value {
  if (value === null || typeof value !== 'object') return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous as Value;
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
}
