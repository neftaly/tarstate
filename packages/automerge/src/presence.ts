import {
  Presence,
  type DocHandle,
  type PeerState,
  type PresenceState
} from '@automerge/automerge-repo';
import type {
  AdapterSnapshot,
  RelationDelta,
  RelationPatchTarget,
  RelationRuntime,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import type { RelationRef } from '@tarstate/core/schema';
import type { WritePatch } from '@tarstate/core/write';

export type AutomergePresenceVersion = {
  readonly revision: number;
  readonly localPeerId?: string;
};

export type AutomergePresenceFieldNames = {
  readonly peerId: string;
  readonly channel: string;
  readonly value: string;
  readonly lastActiveAt: string;
  readonly lastSeenAt: string;
  readonly local: string;
};

export type AutomergePresenceRelationOptions<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly fields?: Partial<AutomergePresenceFieldNames>;
};

export type AutomergePresenceClearedValue = (value: unknown) => boolean;

export type AutomergePresenceRuntimeOptions<
  State extends PresenceState = PresenceState,
  DocType = unknown
> = AutomergePresenceRelationOptions & {
  readonly handle: DocHandle<DocType>;
  readonly initialState: State;
  readonly localPeerId?: string;
  readonly includeLocalRows?: boolean;
  readonly heartbeatMs?: number;
  readonly peerTtlMs?: number;
  readonly isClearedValue?: AutomergePresenceClearedValue;
};

export type AutomergePresenceWritableRuntimeOptions<
  State extends PresenceState = PresenceState,
  DocType = unknown
> = AutomergePresenceRuntimeOptions<State, DocType> & {
  readonly localPeerId: string;
};

export type AutomergePresenceRuntime<State extends PresenceState = PresenceState> =
  RelationRuntime<AutomergePresenceVersion> & {
    readonly presence: Presence<State>;
    readonly relation: RelationRef;
    readonly fields: AutomergePresenceFieldNames;
    readonly snapshot: () => AdapterSnapshot<AutomergePresenceVersion>;
    readonly target?: RelationPatchTarget<AutomergePresenceVersion>;
    readonly subscribe: (listener: () => void) => () => void;
    readonly start: () => void;
    readonly stop: () => void;
    readonly getLocalState: () => State;
    readonly getPeerStates: () => readonly PeerState<State>[];
  };

export type AutomergePresenceWritableRuntime<State extends PresenceState = PresenceState> =
  AutomergePresenceRuntime<State> & {
    readonly target: RelationPatchTarget<AutomergePresenceVersion>;
  };

type PresenceRow = Record<string, unknown>;
type PresenceEventName = 'update' | 'snapshot' | 'heartbeat' | 'goodbye' | 'pruning';

const DEFAULT_FIELDS: AutomergePresenceFieldNames = {
  peerId: 'peerId',
  channel: 'channel',
  value: 'value',
  lastActiveAt: 'lastActiveAt',
  lastSeenAt: 'lastSeenAt',
  local: 'local'
};
const PRESENCE_EVENTS: readonly PresenceEventName[] = ['update', 'snapshot', 'heartbeat', 'goodbye', 'pruning'];

export function defaultAutomergePresenceClearedValue(value: unknown): boolean {
  return value === undefined;
}

export function automergePresenceRuntime<
  State extends PresenceState = PresenceState,
  DocType = unknown
>(options: AutomergePresenceWritableRuntimeOptions<State, DocType>): AutomergePresenceWritableRuntime<State>;
export function automergePresenceRuntime<
  State extends PresenceState = PresenceState,
  DocType = unknown
>(options: AutomergePresenceRuntimeOptions<State, DocType>): AutomergePresenceRuntime<State>;
export function automergePresenceRuntime<
  State extends PresenceState = PresenceState,
  DocType = unknown
>(options: AutomergePresenceRuntimeOptions<State, DocType>): AutomergePresenceRuntime<State> {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };
  const presence = new Presence<State, DocType>({ handle: options.handle });
  const listeners = new Set<() => void>();
  const isClearedValue = options.isClearedValue ?? defaultAutomergePresenceClearedValue;
  let revision = 0;
  let localLastActiveAt = 0;
  let localLastSeenAt = 0;

  const version = (): AutomergePresenceVersion => ({
    revision,
    ...(options.localPeerId === undefined ? {} : { localPeerId: options.localPeerId })
  });
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const rows = (relation: RelationRef): readonly PresenceRow[] =>
    relation.name === options.relation.name
      ? presenceRows(presence, fields, {
        includeLocalRows: options.includeLocalRows ?? false,
        localLastActiveAt,
        localLastSeenAt,
        isClearedValue,
        ...(options.localPeerId === undefined ? {} : { localPeerId: options.localPeerId })
      })
      : [];
  const source = {
    relationNames: [options.relation.name],
    rows,
    version
  };
  const snapshot = (): AdapterSnapshot<AutomergePresenceVersion> => ({
    source,
    version: version()
  });
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const eventListener = () => notify();

  for (const eventName of PRESENCE_EVENTS) {
    presence.on(eventName, eventListener);
  }

  const start = () => {
    presence.start({
      initialState: options.initialState,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.peerTtlMs === undefined ? {} : { peerTtlMs: options.peerTtlMs })
    });
    const now = Date.now();
    localLastActiveAt = now;
    localLastSeenAt = now;
    notify();
  };
  const stop = () => {
    presence.stop();
    notify();
  };
  const target = options.localPeerId === undefined
    ? undefined
    : createPresenceTarget({
      presence,
      relation: options.relation,
      fields,
      localPeerId: options.localPeerId,
      isClearedValue,
      touchLocal: () => {
        const now = Date.now();
        localLastActiveAt = now;
        localLastSeenAt = now;
        notify();
      },
      version
    });

  return {
    presence,
    relation: options.relation,
    fields,
    source,
    ...(target === undefined ? {} : { target }),
    snapshot,
    subscribe,
    start,
    stop,
    getLocalState: () => presence.getLocalState(),
    getPeerStates: () => Object.values(presence.getPeerStates().value)
  };
}

function presenceRows<State extends PresenceState>(
  presence: Presence<State>,
  fields: AutomergePresenceFieldNames,
  options: {
    readonly localPeerId?: string;
    readonly includeLocalRows: boolean;
    readonly localLastActiveAt: number;
    readonly localLastSeenAt: number;
    readonly isClearedValue: AutomergePresenceClearedValue;
  }
): readonly PresenceRow[] {
  const rows = Object.values(presence.getPeerStates().value)
    .flatMap((peer) => rowsForState(peer.peerId, peer.value, fields, {
      local: false,
      lastActiveAt: peer.lastActiveAt,
      lastSeenAt: peer.lastSeenAt,
      isClearedValue: options.isClearedValue
    }));

  if (options.includeLocalRows && options.localPeerId !== undefined) {
    rows.push(...rowsForState(options.localPeerId, presence.getLocalState(), fields, {
      local: true,
      lastActiveAt: options.localLastActiveAt,
      lastSeenAt: options.localLastSeenAt,
      isClearedValue: options.isClearedValue
    }));
  }

  return rows;
}

function rowsForState(
  peerId: string,
  state: PresenceState,
  fields: AutomergePresenceFieldNames,
  options: {
    readonly local: boolean;
    readonly lastActiveAt: number;
    readonly lastSeenAt: number;
    readonly isClearedValue: AutomergePresenceClearedValue;
  }
): readonly PresenceRow[] {
  return Object.entries(state)
    .filter(([, value]) => !options.isClearedValue(value))
    .map(([channel, value]) => ({
      [fields.peerId]: peerId,
      [fields.channel]: channel,
      [fields.value]: value,
      [fields.lastActiveAt]: options.lastActiveAt,
      [fields.lastSeenAt]: options.lastSeenAt,
      [fields.local]: options.local
    }));
}

function createPresenceTarget<State extends PresenceState>(options: {
  readonly presence: Presence<State>;
  readonly relation: RelationRef;
  readonly fields: AutomergePresenceFieldNames;
  readonly localPeerId: string;
  readonly isClearedValue: AutomergePresenceClearedValue;
  readonly touchLocal: () => void;
  readonly version: () => AutomergePresenceVersion;
}): RelationPatchTarget<AutomergePresenceVersion> {
  return {
    relationNames: [options.relation.name],
    ownsRelation: (relationName) => relationName === options.relation.name,
    apply: (patches) => {
      const patchList = Array.from(patches);
      const diagnostics: TarstateDiagnostic[] = [];
      const beforeRows = rowsForState(options.localPeerId, options.presence.getLocalState(), options.fields, {
        local: true,
        lastActiveAt: 0,
        lastSeenAt: 0,
        isClearedValue: options.isClearedValue
      });
      let accepted = 0;
      let applied = 0;

      for (const patch of patchList) {
        if (patch.relation.name !== options.relation.name) {
          diagnostics.push(unsupportedRelationDiagnostic(patch.relation.name));
          continue;
        }

        const outcome = applyPresencePatch(options, patch);
        diagnostics.push(...outcome.diagnostics);
        if (outcome.accepted) accepted += 1;
        if (outcome.applied) applied += 1;
      }

      if (applied > 0) options.touchLocal();

      const afterRows = rowsForState(options.localPeerId, options.presence.getLocalState(), options.fields, {
        local: true,
        lastActiveAt: 0,
        lastSeenAt: 0,
        isClearedValue: options.isClearedValue
      });
      const deltas = presenceDelta(options.relation, options.fields, beforeRows, afterRows);
      const status = applyStatus(patchList.length, accepted);
      const base = {
        patches: patchList.length,
        diagnostics,
        version: options.version(),
        durability: 'ephemeral' as const
      };

      return status === 'rejected'
        ? { status, ...base, applied: 0, deltas: [] }
        : { status, ...base, applied, deltas: deltas === undefined ? [] : [deltas] };
    }
  };
}

function applyPresencePatch<State extends PresenceState>(
  options: {
    readonly presence: Presence<State>;
    readonly fields: AutomergePresenceFieldNames;
    readonly localPeerId: string;
  },
  patch: WritePatch
): { readonly accepted: boolean; readonly applied: boolean; readonly diagnostics: readonly TarstateDiagnostic[] } {
  switch (patch.op) {
    case 'insert':
    case 'insertIgnore':
    case 'insertOrReplace':
    case 'insertOrMerge':
    case 'insertOrUpdate':
      return broadcastPresenceRow(options, patch.row);
    case 'updateByKey': {
      const channel = channelFromKey(patch.key);
      if (channel === undefined) return rejected(rowKeyDiagnostic(patch.relation.name, patch.key));

      const current = options.presence.getLocalState()[channel];
      const update = typeof patch.changes === 'function'
        ? patch.changes(presenceRow(options.localPeerId, channel, current, options.fields))
        : patch.changes;

      if (!isRecord(update) || !(options.fields.value in update)) return accepted(false);
      options.presence.broadcast(channel, update[options.fields.value] as State[keyof State]);
      return accepted(true);
    }
    case 'deleteByKey': {
      const channel = channelFromKey(patch.key);
      if (channel === undefined) return rejected(rowKeyDiagnostic(patch.relation.name, patch.key));
      options.presence.broadcast(channel, undefined as State[keyof State]);
      return accepted(true);
    }
    case 'deleteExact':
      return broadcastPresenceDeleteExact(options, patch.row);
    case 'replaceAll':
      return replacePresenceRows(options, patch.rows);
    case 'update':
    case 'delete':
      return rejected(unsupportedPredicateDiagnostic(patch.relation.name));
  }
}

function broadcastPresenceRow<State extends PresenceState>(
  options: {
    readonly presence: Presence<State>;
    readonly fields: AutomergePresenceFieldNames;
    readonly localPeerId: string;
  },
  row: unknown
): { readonly accepted: boolean; readonly applied: boolean; readonly diagnostics: readonly TarstateDiagnostic[] } {
  if (!isRecord(row)) return rejected(rowInvalidDiagnostic(row));

  const peerId = row[options.fields.peerId];
  if (peerId !== options.localPeerId && row[options.fields.local] !== true) {
    return rejected(remoteWriteDiagnostic(String(peerId)));
  }

  const channel = row[options.fields.channel];
  if (typeof channel !== 'string') return rejected(rowKeyDiagnostic('presence', row));

  options.presence.broadcast(channel, row[options.fields.value] as State[keyof State]);
  return accepted(true);
}

function broadcastPresenceDeleteExact<State extends PresenceState>(
  options: {
    readonly presence: Presence<State>;
    readonly fields: AutomergePresenceFieldNames;
    readonly localPeerId: string;
  },
  partial: unknown
): { readonly accepted: boolean; readonly applied: boolean; readonly diagnostics: readonly TarstateDiagnostic[] } {
  if (!isRecord(partial)) return rejected(rowInvalidDiagnostic(partial));
  if (partial[options.fields.peerId] !== undefined && partial[options.fields.peerId] !== options.localPeerId) return accepted(false);

  const channel = partial[options.fields.channel];
  if (typeof channel !== 'string') return accepted(false);

  options.presence.broadcast(channel, undefined as State[keyof State]);
  return accepted(true);
}

function replacePresenceRows<State extends PresenceState>(
  options: {
    readonly presence: Presence<State>;
    readonly fields: AutomergePresenceFieldNames;
    readonly localPeerId: string;
  },
  rows: readonly unknown[]
): { readonly accepted: boolean; readonly applied: boolean; readonly diagnostics: readonly TarstateDiagnostic[] } {
  for (const row of rows) {
    const outcome = broadcastPresenceRow(options, row);
    if (!outcome.accepted) return outcome;
  }

  return accepted(rows.length > 0);
}

function channelFromKey(key: unknown): string | undefined {
  if (Array.isArray(key) && typeof key[1] === 'string') return key[1];
  return typeof key === 'string' ? key : undefined;
}

function presenceRow(
  peerId: string,
  channel: string,
  value: unknown,
  fields: AutomergePresenceFieldNames
): PresenceRow {
  return {
    [fields.peerId]: peerId,
    [fields.channel]: channel,
    [fields.value]: value,
    [fields.local]: true
  };
}

function presenceDelta(
  relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  before: readonly PresenceRow[],
  after: readonly PresenceRow[]
): RelationDelta | undefined {
  const beforeMap = new Map(before.map((row) => [presenceRowKey(row, fields), row]));
  const afterMap = new Map(after.map((row) => [presenceRowKey(row, fields), row]));
  const removed = before.filter((row) => {
    const next = afterMap.get(presenceRowKey(row, fields));
    return next === undefined || !valuesEqual(row, next);
  });
  const added = after.filter((row) => {
    const previous = beforeMap.get(presenceRowKey(row, fields));
    return previous === undefined || !valuesEqual(previous, row);
  });

  return added.length === 0 && removed.length === 0
    ? undefined
    : { relation, added, removed };
}

function presenceRowKey(row: PresenceRow, fields: AutomergePresenceFieldNames): string {
  return JSON.stringify([row[fields.peerId], row[fields.channel]]);
}

function accepted(applied: boolean): { readonly accepted: true; readonly applied: boolean; readonly diagnostics: readonly [] } {
  return { accepted: true, applied, diagnostics: [] };
}

function rejected(
  ...diagnostics: readonly TarstateDiagnostic[]
): { readonly accepted: false; readonly applied: false; readonly diagnostics: readonly TarstateDiagnostic[] } {
  return { accepted: false, applied: false, diagnostics };
}

function applyStatus(patches: number, acceptedPatches: number): 'accepted' | 'partial' | 'rejected' {
  if (patches === 0) return 'accepted';
  if (acceptedPatches === patches) return 'accepted';
  if (acceptedPatches > 0) return 'partial';
  return 'rejected';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unsupportedRelationDiagnostic(relation: string): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    relation,
    surface: 'automergePresenceRuntime',
    message: `Presence runtime does not own relation "${relation}"`
  };
}

function unsupportedPredicateDiagnostic(relation: string): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    relation,
    surface: 'automergePresenceRuntime',
    message: `Presence runtime only supports key and row based writes for relation "${relation}"`
  };
}

function rowInvalidDiagnostic(row: unknown): TarstateDiagnostic {
  return {
    code: 'row_invalid',
    severity: 'warning',
    surface: 'automergePresenceRuntime',
    message: 'Presence runtime expected an object row',
    detail: row
  };
}

function rowKeyDiagnostic(relation: string, detail: unknown): TarstateDiagnostic {
  return {
    code: 'row_invalid',
    severity: 'warning',
    relation,
    surface: 'automergePresenceRuntime',
    message: `Presence runtime could not resolve a channel key for relation "${relation}"`,
    detail
  };
}

function remoteWriteDiagnostic(peerId: string): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    surface: 'automergePresenceRuntime',
    message: `Presence runtime cannot write remote peer "${peerId}"`
  };
}
