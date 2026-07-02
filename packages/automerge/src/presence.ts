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

export type AutomergePresenceHandle<_DocType = unknown> = {
  readonly on?: (eventName: string, listener: (payload: unknown) => void) => void;
  readonly off?: (eventName: string, listener: (payload: unknown) => void) => void;
  readonly broadcast?: (message: unknown) => void;
};

export type AutomergePresenceRuntimeOptions<
  State extends PresenceState = PresenceState,
  DocType = unknown
> = AutomergePresenceRelationOptions & {
  readonly handle: AutomergePresenceHandle<DocType>;
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
  const listeners = new Set<() => void>();
  const presence = new Presence<State, DocType>({ handle: options.handle as DocHandle<DocType> });
  const localState = compactState(options.initialState, options.isClearedValue ?? defaultAutomergePresenceClearedValue) as State;
  let revision = 0;
  let running = false;
  const version = (): AutomergePresenceVersion => ({
    revision,
    ...(options.localPeerId === undefined ? {} : { localPeerId: options.localPeerId })
  });
  const source: AdapterSource<AutomergePresenceVersion> = {
    relationNames: [options.relation.name],
    rows: () => [],
    lookup: () => [],
    rangeLookup: () => [],
    version,
    diagnostics: () => [stubDiagnostic('automerge presence source is not implemented')]
  };
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const target = options.localPeerId === undefined
    ? undefined
    : {
        relationNames: [options.relation.name],
        ownsRelation: (relationName: string) => relationName === options.relation.name,
        apply: (patches): RelationApplyResult<AutomergePresenceVersion> => ({
          status: 'rejected',
          patches: patches.length,
          applied: 0,
          deltas: [],
          diagnostics: [stubDiagnostic('automerge presence writes are not implemented')],
          durability: 'ephemeral',
          version: version()
        })
      } satisfies RelationPatchTarget<AutomergePresenceVersion>;
  const runtime: AutomergePresenceRuntime<State> = {
    presence,
    relation: options.relation,
    fields,
    source,
    ...(target === undefined ? {} : { target }),
    snapshot: () => ({
      source,
      version: version(),
      diagnostics: [stubDiagnostic('automerge presence snapshot is not implemented')]
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (running) {
        return;
      }

      running = true;
      presence.start({
        initialState: localState,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        ...(options.peerTtlMs === undefined ? {} : { peerTtlMs: options.peerTtlMs })
      });
      notify();
    },
    stop: () => {
      if (!running) {
        return;
      }

      presence.stop();
      running = false;
      notify();
    },
    getLocalState: () => ({ ...localState }),
    getPeerStates: () => []
  };

  if (options.start === true) {
    runtime.start();
  }

  return runtime;
}

function compactState(
  state: PresenceState,
  isClearedValue: AutomergePresenceClearedValue
): PresenceState {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => !isClearedValue(value)));
}

function stubDiagnostic(message: string): TarstateDiagnostic {
  return {
    code: 'not_implemented',
    message
  };
}
