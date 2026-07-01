import { Presence, type DocHandle, type PeerId, type PeerState, type PresenceState } from '@automerge/automerge-repo';
import type {
  AdapterSnapshot,
  AdapterSource,
  RelationApplyResult,
  RelationDelta,
  RelationPatchTarget,
  RelationRuntime,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import { isJsonValue, type FieldSpec, type RelationRef } from '@tarstate/core/schema';
import type { RelationRangeBound } from '@tarstate/core/source';
import type { RelationKeyInput, WritePatch } from '@tarstate/core/write';

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
  readonly start?: boolean;
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

const defaultPresenceFields: AutomergePresenceFieldNames = {
  peerId: 'peerId',
  channel: 'channel',
  value: 'value',
  lastActiveAt: 'lastActiveAt',
  lastSeenAt: 'lastSeenAt',
  local: 'local'
};

type HandleWithEvents<DocType> = DocHandle<DocType> & {
  readonly on?: (eventName: string, listener: (payload: unknown) => void) => void;
  readonly off?: (eventName: string, listener: (payload: unknown) => void) => void;
  readonly broadcast?: (message: unknown) => void;
};

type RuntimeState<State extends PresenceState> = {
  localState: State;
  localLastActiveAt: number;
  localLastSeenAt: number;
  readonly remoteStates: Map<string, PeerState<State>>;
  revision: number;
  running: boolean;
};

type MutableDelta = {
  readonly relation: RelationRef;
  readonly added: unknown[];
  readonly removed: unknown[];
};

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
  const fields = { ...defaultPresenceFields, ...options.fields };
  const isClearedValue = options.isClearedValue ?? defaultAutomergePresenceClearedValue;
  const presence = new Presence<State, DocType>({ handle: options.handle });
  const listeners = new Set<() => void>();
  const state: RuntimeState<State> = {
    localState: compactPresenceState(options.initialState, isClearedValue) as State,
    localLastActiveAt: Date.now(),
    localLastSeenAt: Date.now(),
    remoteStates: new Map(),
    revision: 0,
    running: false
  };
  const handle = options.handle as HandleWithEvents<DocType>;
  const version = (): AutomergePresenceVersion => ({
    revision: state.revision,
    ...(options.localPeerId === undefined ? {} : { localPeerId: options.localPeerId })
  });
  const notify = () => {
    state.revision += 1;
    for (const listener of listeners) listener();
  };
  const onEphemeralMessage = (payload: unknown) => {
    if (!state.running) {
      return;
    }

    if (ingestPresenceMessage(state, payload)) {
      notify();
    }
  };
  const source: AdapterSource<AutomergePresenceVersion> = {
    relationNames: [options.relation.name],
    rows: (relation) => relation.name === options.relation.name
      ? presenceRows(options.relation, fields, state, options.localPeerId, options.includeLocalRows ?? true, isClearedValue)
      : [],
    lookup: (lookup) => lookup.relation.name === options.relation.name
      ? presenceRows(options.relation, fields, state, options.localPeerId, options.includeLocalRows ?? true, isClearedValue)
        .filter((row) => Object.is((row as Record<string, unknown>)[lookup.field], lookup.value))
      : [],
    rangeLookup: (lookup) => lookup.relation.name === options.relation.name
      ? presenceRows(options.relation, fields, state, options.localPeerId, options.includeLocalRows ?? true, isClearedValue)
        .filter((row) => inRange((row as Record<string, unknown>)[lookup.field], lookup.lower, lookup.upper))
      : [],
    version,
    diagnostics: () => presenceDiagnostics(options.relation, fields, state, options.localPeerId, options.includeLocalRows ?? true, isClearedValue)
  };
  const start = () => {
    if (state.running) {
      return;
    }

    state.running = true;
    handle.on?.('ephemeral-message', onEphemeralMessage);
    presence.start({
      initialState: state.localState,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.peerTtlMs === undefined ? {} : { peerTtlMs: options.peerTtlMs })
    });
  };
  const stop = () => {
    if (!state.running) {
      return;
    }

    handle.off?.('ephemeral-message', onEphemeralMessage);
    presence.stop();
    state.running = false;
  };
  const target = options.localPeerId === undefined
    ? undefined
    : presenceTarget(options.relation, fields, state, options.localPeerId, isClearedValue, version, notify, handle);

  if (options.start ?? true) {
    start();
  }

  return {
    presence,
    relation: options.relation,
    fields,
    source,
    ...(target === undefined ? {} : { target }),
    snapshot: () => ({ source, version: version(), diagnostics: presenceDiagnostics(options.relation, fields, state, options.localPeerId, options.includeLocalRows ?? true, isClearedValue) }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    getLocalState: () => ({ ...state.localState }),
    getPeerStates: () => Array.from(state.remoteStates.values(), (peer) => ({
      ...peer,
      value: { ...peer.value },
      state: { ...peer.value }
    })) as readonly PeerState<State>[]
  };
}

function presenceTarget<State extends PresenceState, DocType>(
  relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  state: RuntimeState<State>,
  localPeerId: string,
  isClearedValue: AutomergePresenceClearedValue,
  version: () => AutomergePresenceVersion,
  notify: () => void,
  handle: HandleWithEvents<DocType>
): RelationPatchTarget<AutomergePresenceVersion> {
  const apply = (patches: readonly WritePatch[]): RelationApplyResult<AutomergePresenceVersion> => {
    const planned = planPresencePatches(relation, fields, state.localState, localPeerId, isClearedValue, patches);

    if ('diagnostics' in planned) {
      return {
        status: 'rejected',
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics: planned.diagnostics,
        durability: 'ephemeral',
        version: version()
      };
    }

    state.localState = planned.localState as State;
    state.localLastActiveAt = Date.now();
    state.localLastSeenAt = state.localLastActiveAt;
    handle.broadcast?.({ __presence: { type: 'snapshot', state: state.localState } });
    notify();

    return {
      status: 'accepted',
      patches: patches.length,
      applied: patches.length,
      deltas: planned.deltas,
      diagnostics: [],
      durability: 'ephemeral',
      version: version()
    };
  };

  return {
    relationNames: [relation.name],
    ownsRelation: (relationName) => relationName === relation.name,
    apply
  };
}

function planPresencePatches<State extends PresenceState>(
  relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  currentState: State,
  localPeerId: string,
  isClearedValue: AutomergePresenceClearedValue,
  patches: readonly WritePatch[]
): { readonly localState: PresenceState; readonly deltas: readonly RelationDelta[] } | { readonly diagnostics: readonly TarstateDiagnostic[] } {
  let localState: PresenceState = { ...currentState };
  const deltas = new Map<string, MutableDelta>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const patch of patches) {
    if (patch.relation.name !== relation.name) {
      diagnostics.push(remoteWriteDiagnostic(relation));
      continue;
    }

    if (patch.op === 'replaceAll') {
      diagnostics.push(remoteWriteDiagnostic(relation));
      continue;
    }

    if (patch.op === 'insert' || patch.op === 'insertIgnore' || patch.op === 'insertOrReplace' || patch.op === 'insertOrUpdate') {
      const row = patch.row;

      if (row[fields.peerId] !== localPeerId) {
        diagnostics.push(remoteWriteDiagnostic(relation));
        continue;
      }

      const channel = row[fields.channel];

      if (typeof channel !== 'string') {
        diagnostics.push(invalidPresenceDiagnostic(relation, fields.channel));
        continue;
      }

      const before = presenceRow(relation, fields, localPeerId, channel, localState[channel], true, Date.now(), Date.now());
      const value = row[fields.value];
      localState = setPresenceChannel(localState, channel, value, isClearedValue);
      const after = presenceRow(relation, fields, localPeerId, channel, localState[channel], true, Date.now(), Date.now());
      recordRemoved(deltas, relation, before);
      if (!isClearedValue(localState[channel])) {
        recordAdded(deltas, relation, after);
      }
      continue;
    }

    if (patch.op === 'updateByKey') {
      const [peerId, channel] = presenceKeyInput(patch.key);

      if (peerId !== localPeerId || typeof channel !== 'string') {
        diagnostics.push(remoteWriteDiagnostic(relation));
        continue;
      }

      const before = presenceRow(relation, fields, localPeerId, channel, localState[channel], true, Date.now(), Date.now());
      const nextValue = patch.changes[fields.value];
      localState = nextValue === undefined && !(fields.value in patch.changes)
        ? localState
        : setPresenceChannel(localState, channel, nextValue, isClearedValue);
      const after = presenceRow(relation, fields, localPeerId, channel, localState[channel], true, Date.now(), Date.now());
      recordRemoved(deltas, relation, before);
      if (!isClearedValue(localState[channel])) {
        recordAdded(deltas, relation, after);
      }
      continue;
    }

    if (patch.op === 'deleteByKey') {
      const [peerId, channel] = presenceKeyInput(patch.key);

      if (peerId !== localPeerId || typeof channel !== 'string') {
        diagnostics.push(remoteWriteDiagnostic(relation));
        continue;
      }

      const before = presenceRow(relation, fields, localPeerId, channel, localState[channel], true, Date.now(), Date.now());
      localState = deletePresenceChannel(localState, channel);
      recordRemoved(deltas, relation, before);
      continue;
    }

    diagnostics.push(remoteWriteDiagnostic(relation));
  }

  if (diagnostics.length === 0) {
    return { localState, deltas: publishDeltas(deltas) };
  }

  const [diagnostic] = diagnostics;
  return { diagnostics: diagnostic === undefined ? [] : [diagnostic] };
}

function presenceRows<State extends PresenceState>(
  relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  state: RuntimeState<State>,
  localPeerId: string | undefined,
  includeLocalRows: boolean,
  isClearedValue: AutomergePresenceClearedValue
): readonly unknown[] {
  return presenceRowsWithDiagnostics(relation, fields, state, localPeerId, includeLocalRows, isClearedValue).rows;
}

function presenceDiagnostics<State extends PresenceState>(
  relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  state: RuntimeState<State>,
  localPeerId: string | undefined,
  includeLocalRows: boolean,
  isClearedValue: AutomergePresenceClearedValue
): readonly TarstateDiagnostic[] {
  return presenceRowsWithDiagnostics(relation, fields, state, localPeerId, includeLocalRows, isClearedValue).diagnostics;
}

function presenceRowsWithDiagnostics<State extends PresenceState>(
  relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  state: RuntimeState<State>,
  localPeerId: string | undefined,
  includeLocalRows: boolean,
  isClearedValue: AutomergePresenceClearedValue
): { readonly rows: readonly unknown[]; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const rows: Record<string, unknown>[] = [];
  const diagnostics: TarstateDiagnostic[] = [];
  if (includeLocalRows && localPeerId !== undefined) {
    for (const [channel, value] of Object.entries(state.localState)) {
      if (isClearedValue(value)) {
        continue;
      }

      const row = presenceRow(
        relation,
        fields,
        localPeerId,
        channel,
        value,
        true,
        state.localLastActiveAt,
        state.localLastSeenAt
      );
      const rowDiagnostics = validateRow(relation, row);

      if (rowDiagnostics.length === 0) {
        rows.push(row);
      } else {
        diagnostics.push(...rowDiagnostics);
      }
    }
  }

  for (const peer of state.remoteStates.values()) {
    for (const [channel, value] of Object.entries(peer.value)) {
      if (isClearedValue(value)) {
        continue;
      }

      const row = presenceRow(relation, fields, peer.peerId, channel, value, false, peer.lastActiveAt, peer.lastSeenAt);
      const rowDiagnostics = validateRow(relation, row);

      if (rowDiagnostics.length === 0) {
        rows.push(row);
      } else {
        diagnostics.push(...rowDiagnostics);
      }
    }
  }

  return { rows, diagnostics };
}

function presenceRow(
  _relation: RelationRef,
  fields: AutomergePresenceFieldNames,
  peerId: string,
  channel: string,
  value: unknown,
  local: boolean,
  lastActiveAt: number,
  lastSeenAt: number
): Record<string, unknown> {
  return {
    [fields.peerId]: peerId,
    [fields.channel]: channel,
    [fields.value]: value,
    [fields.lastActiveAt]: lastActiveAt,
    [fields.lastSeenAt]: lastSeenAt,
    [fields.local]: local
  };
}

function ingestPresenceMessage<State extends PresenceState>(
  state: RuntimeState<State>,
  payload: unknown
): boolean {
  if (!isRecord(payload) || typeof payload.senderId !== 'string' || !isRecord(payload.message)) {
    return false;
  }

  const envelope = payload.message.__presence;

  if (!isRecord(envelope) || typeof envelope.type !== 'string') {
    return false;
  }

  const peerId = payload.senderId as string;
  const now = Date.now();
  const existing = state.remoteStates.get(peerId);

  if (envelope.type === 'snapshot' && isRecord(envelope.state)) {
    state.remoteStates.set(peerId, {
      peerId: peerId as PeerId,
      value: { ...envelope.state } as State,
      lastActiveAt: now,
      lastSeenAt: now
    });
    return true;
  }

  if (envelope.type === 'update' && typeof envelope.channel === 'string') {
    state.remoteStates.set(peerId, {
      peerId: peerId as PeerId,
      value: {
        ...existing?.value,
        [envelope.channel]: envelope.value
      } as State,
      lastActiveAt: now,
      lastSeenAt: now
    });
    return true;
  }

  if (envelope.type === 'heartbeat' && existing !== undefined) {
    state.remoteStates.set(peerId, { ...existing, lastSeenAt: now });
    return true;
  }

  if (envelope.type === 'goodbye') {
    return state.remoteStates.delete(peerId);
  }

  return false;
}

function compactPresenceState(
  state: PresenceState,
  isClearedValue: AutomergePresenceClearedValue
): PresenceState {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => !isClearedValue(value)));
}

function setPresenceChannel(
  state: PresenceState,
  channel: string,
  value: unknown,
  isClearedValue: AutomergePresenceClearedValue
): PresenceState {
  if (isClearedValue(value)) {
    return deletePresenceChannel(state, channel);
  }

  return { ...state, [channel]: value };
}

function deletePresenceChannel(state: PresenceState, channel: string): PresenceState {
  const next = { ...state };
  delete next[channel];
  return next;
}

function presenceKeyInput(key: RelationKeyInput): readonly unknown[] {
  return Array.isArray(key) ? key : [key];
}

function validateRow(relation: RelationRef, row: Record<string, unknown>): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [field, spec] of Object.entries(relation.fields)) {
    if (!isFieldValueValid(spec, row[field])) {
      diagnostics.push(invalidPresenceDiagnostic(relation, field));
    }
  }

  return diagnostics;
}

function isFieldValueValid(spec: FieldSpec | undefined, value: unknown): boolean {
  if (spec === undefined) {
    return true;
  }

  if (value === undefined) {
    return spec.optional;
  }

  if (value === null) {
    return spec.nullable;
  }

  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return isJsonValue(value);
  }
}

function inRange(value: unknown, lower?: RelationRangeBound, upper?: RelationRangeBound): boolean {
  if (lower !== undefined && !boundMatches(value, lower, 'lower')) {
    return false;
  }

  if (upper !== undefined && !boundMatches(value, upper, 'upper')) {
    return false;
  }

  return true;
}

function boundMatches(value: unknown, bound: RelationRangeBound, side: 'lower' | 'upper'): boolean {
  if (!comparable(value, bound.value)) {
    return false;
  }

  const comparableValue = value as string | number;
  const comparableBound = bound.value as string | number;

  if (side === 'lower') {
    return bound.inclusive ? comparableValue >= comparableBound : comparableValue > comparableBound;
  }

  return bound.inclusive ? comparableValue <= comparableBound : comparableValue < comparableBound;
}

function comparable(left: unknown, right: unknown): left is string | number {
  return (typeof left === 'string' && typeof right === 'string') ||
    (typeof left === 'number' && typeof right === 'number');
}

function recordAdded(deltas: Map<string, MutableDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).added.push(row);
}

function recordRemoved(deltas: Map<string, MutableDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).removed.push(row);
}

function deltaFor(deltas: Map<string, MutableDelta>, relation: RelationRef): MutableDelta {
  const existing = deltas.get(relation.name);

  if (existing !== undefined) {
    return existing;
  }

  const delta = { relation, added: [], removed: [] };
  deltas.set(relation.name, delta);
  return delta;
}

function publishDeltas(deltas: Map<string, MutableDelta>): readonly RelationDelta[] {
  return Array.from(deltas.values(), (delta) => ({
    relation: delta.relation,
    added: [...delta.added],
    removed: [...delta.removed]
  }));
}

function remoteWriteDiagnostic(relation: RelationRef): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    relation: relation.name,
    field: 'peer',
    message: 'presence writes may only target the local peer'
  };
}

function invalidPresenceDiagnostic(relation: RelationRef, field: string): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    relation: relation.name,
    field,
    message: `invalid presence field "${field}"`
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
