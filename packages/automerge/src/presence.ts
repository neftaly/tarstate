import { Presence, type DocHandle, type PeerState, type PresenceState } from '@automerge/automerge-repo';
import type {
  AdapterSnapshot,
  AdapterSource,
  RelationApplyResult,
  RelationPatchTarget,
  RelationRuntime,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import type { RelationRangeLookup } from '@tarstate/core/source';
import type { RelationRef } from '@tarstate/core/schema';
import { applyWritesAtomic, type MutableObjectSourceData } from '@tarstate/core/write-apply';
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
  readonly start?: boolean;
  readonly isClearedValue?: AutomergePresenceClearedValue;
};

export type AutomergePresenceRuntime<State extends PresenceState = PresenceState> =
  RelationRuntime<AutomergePresenceVersion> & {
    readonly presence: Presence<State>;
    readonly relation: RelationRef;
    readonly fields: AutomergePresenceFieldNames;
    readonly target: RelationPatchTarget<AutomergePresenceVersion>;
    readonly subscribe: (listener: () => void) => () => void;
    readonly start: () => void;
    readonly stop: () => void;
    readonly getLocalState: () => State;
    readonly getPeerStates: () => readonly PeerState<State>[];
  };

type PresenceRow = Record<string, unknown>;
type NormalizedPresenceOptions = {
  readonly relation: RelationRef;
  readonly fields: AutomergePresenceFieldNames;
  readonly localPeerId?: string;
  readonly includeLocalRows: boolean;
  readonly isClearedValue: AutomergePresenceClearedValue;
};
type PresenceSourceOptions = {
  readonly relation: RelationRef;
  readonly fields: AutomergePresenceFieldNames;
  readonly getRows: () => readonly PresenceRow[];
  readonly getVersion: () => AutomergePresenceVersion;
  readonly getDiagnostics: () => readonly TarstateDiagnostic[];
};

const defaultPresenceFields: AutomergePresenceFieldNames = {
  peerId: 'peerId',
  channel: 'channel',
  value: 'value',
  lastActiveAt: 'lastActiveAt',
  lastSeenAt: 'lastSeenAt',
  local: 'local'
};

export function defaultAutomergePresenceClearedValue(value: unknown): boolean {
  return value === undefined;
}

export function automergePresenceRuntime<
  State extends PresenceState = PresenceState,
  DocType = unknown
>(options: AutomergePresenceRuntimeOptions<State, DocType>): AutomergePresenceRuntime<State> {
  return new AutomergePresenceRuntimeImpl(options);
}

export const createAutomergePresenceRuntime = automergePresenceRuntime;

class AutomergePresenceRuntimeImpl<
  State extends PresenceState,
  DocType
> implements AutomergePresenceRuntime<State> {
  readonly presence: Presence<State>;
  readonly relation: RelationRef;
  readonly fields: AutomergePresenceFieldNames;
  readonly source: AdapterSource<AutomergePresenceVersion>;
  readonly target = {
    apply: (patches: readonly WritePatch[]): RelationApplyResult<AutomergePresenceVersion> =>
      this.apply(patches)
  };

  private localState: State;
  private readonly options: NormalizedPresenceOptions;
  private readonly startOptions: {
    readonly heartbeatMs?: number;
    readonly peerTtlMs?: number;
  };
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private localLastActiveAt = Date.now();
  private localLastSeenAt = this.localLastActiveAt;

  constructor(options: AutomergePresenceRuntimeOptions<State, DocType>) {
    this.presence = new Presence<State, DocType>({ handle: options.handle });
    this.localState = options.initialState;
    this.relation = options.relation;
    this.fields = { ...defaultPresenceFields, ...options.fields };
    this.options = {
      relation: this.relation,
      fields: this.fields,
      includeLocalRows: options.includeLocalRows ?? true,
      isClearedValue: options.isClearedValue ?? defaultAutomergePresenceClearedValue,
      ...(options.localPeerId === undefined ? {} : { localPeerId: options.localPeerId })
    };
    this.startOptions = {
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.peerTtlMs === undefined ? {} : { peerTtlMs: options.peerTtlMs })
    };
    this.source = presenceSource({
      relation: this.relation,
      fields: this.fields,
      getRows: () => this.currentRows(),
      getVersion: () => this.version(),
      getDiagnostics: () => []
    });

    this.presence.on('update', this.handlePresenceEvent);
    this.presence.on('snapshot', this.handlePresenceEvent);
    this.presence.on('heartbeat', this.handlePresenceEvent);
    this.presence.on('goodbye', this.handlePresenceEvent);
    this.presence.on('pruning', this.handlePresenceEvent);

    if (options.start !== false) {
      this.start();
    }
  }

  start = (): void => {
    this.presence.start({
      initialState: this.localState,
      ...this.startOptions
    });
  };

  stop = (): void => {
    this.presence.stop();
  };

  snapshot = (): AdapterSnapshot<AutomergePresenceVersion> => {
    const rows = this.currentRows();
    const version = this.version();

    return {
      source: presenceSource({
        relation: this.relation,
        fields: this.fields,
        getRows: () => rows,
        getVersion: () => version,
        getDiagnostics: () => []
      }),
      version
    };
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getLocalState = (): State => this.currentLocalState();

  getPeerStates = (): readonly PeerState<State>[] => Object.values(this.presence.getPeerStates().value);

  private handlePresenceEvent = (): void => {
    this.bump();
  };

  private bump(): void {
    this.revision += 1;

    for (const listener of this.listeners) {
      listener();
    }
  }

  private version(): AutomergePresenceVersion {
    return {
      revision: this.revision,
      ...(this.options.localPeerId === undefined ? {} : { localPeerId: this.options.localPeerId })
    };
  }

  private currentLocalState(): State {
    return this.presence.running ? this.presence.getLocalState() : this.localState;
  }

  private currentRows(): readonly PresenceRow[] {
    const rows = this.getPeerStates().flatMap((peer) => rowsForPeerState(peer, this.options, false));

    if (this.options.includeLocalRows && this.options.localPeerId !== undefined) {
      rows.unshift(...rowsForLocalState({
        peerId: this.options.localPeerId,
        state: this.currentLocalState(),
        lastActiveAt: this.localLastActiveAt,
        lastSeenAt: this.localLastSeenAt,
        options: this.options
      }));
    }

    return rows;
  }

  private apply(patches: readonly WritePatch[]): RelationApplyResult<AutomergePresenceVersion> {
    const foreignPatch = patches.find((patch) => patch.relation.name !== this.relation.name);

    if (foreignPatch !== undefined) {
      return rejectedApplyResult(patches.length, [
        {
          code: 'source_error',
          message: `presence runtime does not own relation ${foreignPatch.relation.name}`,
          relation: foreignPatch.relation.name
        }
      ], this.version());
    }

    if (this.options.localPeerId === undefined) {
      return rejectedApplyResult(patches.length, [
        {
          code: 'source_error',
          message: 'presence runtime requires localPeerId before applying patches',
          relation: this.relation.name
        }
      ], this.version());
    }

    const previousState = this.currentLocalState();
    const data: MutableObjectSourceData = {
      [this.relation.name]: rowsForLocalState({
        peerId: this.options.localPeerId,
        state: previousState,
        lastActiveAt: this.localLastActiveAt,
        lastSeenAt: this.localLastSeenAt,
        options: this.options
      })
    };
    const applied = applyWritesAtomic(data, patches);

    if (!applied.committed) {
      return rejectedApplyResult(patches.length, applied.diagnostics, this.version());
    }

    const nextRows = data[this.relation.name] ?? [];
    const nextState = stateFromRows(nextRows, this.options);

    if (nextState.diagnostics.length > 0) {
      return rejectedApplyResult(patches.length, nextState.diagnostics, this.version());
    }

    const changed = this.broadcastChangedChannels(previousState, nextState.state as State);
    this.localState = this.presence.getLocalState() as State;

    if (changed) {
      const now = Date.now();
      this.localLastActiveAt = now;
      this.localLastSeenAt = now;
      this.bump();
    }

    return {
      status: 'accepted',
      accepted: true,
      patches: patches.length,
      applied: applied.applied,
      deltas: applied.deltas,
      diagnostics: [],
      durability: 'ephemeral',
      version: this.version()
    };
  }

  private broadcastChangedChannels(previousState: State, nextState: State): boolean {
    let changed = false;
    const channels = new Set([...Object.keys(previousState), ...Object.keys(nextState)]);

    for (const channel of channels) {
      if (!Object.is(previousState[channel], nextState[channel])) {
        // Automerge Repo Presence has no delete-channel API. Broadcasting a
        // cleared value is the public API shape for making a channel absent.
        this.presence.broadcast(channel, nextState[channel]);
        changed = true;
      }
    }

    return changed;
  }
}

function presenceSource(options: PresenceSourceOptions): AdapterSource<AutomergePresenceVersion> {
  return {
    relationNames: [options.relation.name],
    rows: (relationRef) => relationRef.name === options.relation.name ? options.getRows() : [],
    lookup: (lookup) => {
      if (lookup.relation.name !== options.relation.name) {
        return undefined;
      }

      return options.getRows().filter((row) => sameLookupValue(row[lookup.field], lookup.value));
    },
    rangeLookup: (lookup) => {
      if (lookup.relation.name !== options.relation.name) {
        return undefined;
      }

      return rangeLookupRows(options.getRows(), lookup);
    },
    version: options.getVersion,
    diagnostics: options.getDiagnostics
  };
}

function rowsForPeerState<State extends PresenceState>(
  peer: PeerState<State>,
  options: NormalizedPresenceOptions,
  local: boolean
): PresenceRow[] {
  return rowsForState({
    peerId: peer.peerId,
    state: peer.value,
    lastActiveAt: peer.lastActiveAt,
    lastSeenAt: peer.lastSeenAt,
    local,
    options
  });
}

function rowsForLocalState<State extends PresenceState>(
  {
    peerId,
    state,
    lastActiveAt,
    lastSeenAt,
    options
  }: {
    readonly peerId: string;
    readonly state: State;
    readonly lastActiveAt: number;
    readonly lastSeenAt: number;
    readonly options: NormalizedPresenceOptions;
  }
): PresenceRow[] {
  return rowsForState({
    peerId,
    state,
    lastActiveAt,
    lastSeenAt,
    local: true,
    options
  });
}

function rowsForState<State extends PresenceState>({
  peerId,
  state,
  lastActiveAt,
  lastSeenAt,
  local,
  options
}: {
  readonly peerId: string;
  readonly state: State;
  readonly lastActiveAt: number;
  readonly lastSeenAt: number;
  readonly local: boolean;
  readonly options: NormalizedPresenceOptions;
}): PresenceRow[] {
  const rows: PresenceRow[] = [];

  for (const [channel, value] of Object.entries(state)) {
    if (options.isClearedValue(value)) {
      continue;
    }

    rows.push({
      [options.fields.peerId]: peerId,
      [options.fields.channel]: channel,
      [options.fields.value]: clonePresenceValue(value),
      [options.fields.lastActiveAt]: lastActiveAt,
      [options.fields.lastSeenAt]: lastSeenAt,
      [options.fields.local]: local
    });
  }

  return rows;
}

function stateFromRows(
  rows: readonly unknown[],
  options: NormalizedPresenceOptions
): {
  readonly state: Record<string, unknown>;
  readonly diagnostics: readonly TarstateDiagnostic[];
} {
  const diagnostics: TarstateDiagnostic[] = [];
  const state: Record<string, unknown> = {};

  for (const row of rows) {
    if (!isRecord(row)) {
      diagnostics.push({
        code: 'invalid_row',
        message: `presence row for relation ${options.relation.name} is not an object`,
        relation: options.relation.name,
        detail: row
      });
      continue;
    }

    const peerId = row[options.fields.peerId];
    const channel = row[options.fields.channel];

    if (peerId !== options.localPeerId) {
      diagnostics.push({
        code: 'invalid_row',
        message: `presence writes can only target local peer ${options.localPeerId}`,
        relation: options.relation.name,
        field: options.fields.peerId,
        detail: peerId
      });
      continue;
    }

    if (typeof channel !== 'string') {
      diagnostics.push({
        code: 'invalid_row',
        message: 'presence channel must be a string',
        relation: options.relation.name,
        field: options.fields.channel,
        detail: channel
      });
      continue;
    }

    if (Object.hasOwn(state, channel)) {
      diagnostics.push({
        code: 'duplicate_key',
        message: `duplicate presence channel ${channel}`,
        relation: options.relation.name,
        key: channel
      });
      continue;
    }

    const value = clonePresenceValue(row[options.fields.value]);
    state[channel] = options.isClearedValue(value) ? undefined : value;
  }

  return { state, diagnostics };
}

function rangeLookupRows(
  rows: readonly PresenceRow[],
  lookup: RelationRangeLookup
): readonly PresenceRow[] | undefined {
  if (lookup.lower === undefined && lookup.upper === undefined) {
    return undefined;
  }

  const output: PresenceRow[] = [];

  for (const row of rows) {
    const value = row[lookup.field];

    if (!orderedValue(value) ||
      (lookup.lower !== undefined && !orderedValue(lookup.lower.value)) ||
      (lookup.upper !== undefined && !orderedValue(lookup.upper.value))) {
      return undefined;
    }

    if (valueWithinRange(value, lookup.lower, lookup.upper)) {
      output.push(row);
    }
  }

  return output;
}

function valueWithinRange(
  value: string | number,
  lower: RelationRangeLookup['lower'],
  upper: RelationRangeLookup['upper']
): boolean {
  if (lower !== undefined) {
    const comparison = compareOrderedValues(value, lower.value as string | number);

    if (comparison < 0 || (!lower.inclusive && comparison === 0)) {
      return false;
    }
  }

  if (upper !== undefined) {
    const comparison = compareOrderedValues(value, upper.value as string | number);

    if (comparison > 0 || (!upper.inclusive && comparison === 0)) {
      return false;
    }
  }

  return true;
}

function orderedValue(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function compareOrderedValues(left: string | number, right: string | number): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function rejectedApplyResult(
  patches: number,
  diagnostics: readonly TarstateDiagnostic[],
  version: AutomergePresenceVersion
): RelationApplyResult<AutomergePresenceVersion> {
  return {
    status: 'rejected',
    accepted: false,
    patches,
    applied: 0,
    deltas: [],
    diagnostics,
    durability: 'ephemeral',
    version
  };
}

function sameLookupValue(left: unknown, right: unknown): boolean {
  return left === right || (left !== left && right !== right);
}

function clonePresenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clonePresenceValue);
  }

  if (!isRecord(value) || Object.prototype.toString.call(value) !== '[object Object]') {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = clonePresenceValue(nestedValue);
  }

  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
