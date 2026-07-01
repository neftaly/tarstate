import { Presence, type DocHandle, type PeerState, type PresenceState } from '@automerge/automerge-repo';
import type {
  AdapterSnapshot,
  AdapterSource,
  RelationApplyResult,
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
  const version = (): AutomergePresenceVersion => ({
    revision: 0,
    ...(options.localPeerId === undefined ? {} : { localPeerId: options.localPeerId })
  });
  const source: AdapterSource<AutomergePresenceVersion> = {
    relationNames: [options.relation.name],
    rows: () => [],
    lookup: () => undefined,
    rangeLookup: () => undefined,
    version,
    diagnostics: () => [stubDiagnostic()]
  };
  const target = options.localPeerId === undefined ? undefined : presenceTarget(options.relation, version);
  const presence = new Presence<State, DocType>({ handle: options.handle });

  return {
    presence,
    relation: options.relation,
    fields,
    source,
    ...(target === undefined ? {} : { target }),
    snapshot: () => ({ source, version: version() }),
    subscribe: () => () => {},
    start: () => {},
    stop: () => {},
    getLocalState: () => options.initialState,
    getPeerStates: () => []
  };
}

function presenceTarget(
  relation: RelationRef,
  version: () => AutomergePresenceVersion
): RelationPatchTarget<AutomergePresenceVersion> {
  const apply = (patches: readonly WritePatch[]): RelationApplyResult<AutomergePresenceVersion> => ({
    status: 'rejected',
    patches: patches.length,
    applied: 0,
    deltas: [],
    diagnostics: [stubDiagnostic()],
    durability: 'ephemeral',
    version: version()
  });

  return {
    relationNames: [relation.name],
    ownsRelation: (relationName) => relationName === relation.name,
    apply
  };
}

function stubDiagnostic(): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: 'automerge presence implementation has been removed; regenerate this API implementation'
  };
}
