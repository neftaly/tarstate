import { stableKey } from './internal.js';
import {
  booleanField,
  idField,
  jsonField,
  numberField,
  opaqueField,
  optional,
  relation,
  stringField
} from './schema.js';
import type { TarstateDiagnostic, TarstateDiagnosticSeverity } from './diagnostics.js';
import type { RelationApplyDurability } from './impl.js';
import type { FieldSpec, RelationRef } from './schema.js';
import type { RelationSource } from './source-types.js';

export type RuntimeSourceState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'syncing'
  | 'unavailable'
  | 'failed'
  | 'closed';
export type RuntimeSourceRow = {
  readonly id: string;
  readonly runtime: string;
  readonly source: string;
  readonly state: RuntimeSourceState;
  readonly priority?: number;
  readonly message?: string;
  readonly updatedAt?: number;
  readonly detail?: unknown;
};
export type RuntimeDiagnosticRow = {
  readonly id: string;
  readonly runtime: string;
  readonly code: string;
  readonly severity: TarstateDiagnosticSeverity;
  readonly message: string;
  readonly surface?: string;
  readonly relation?: string;
  readonly source?: string;
  readonly detail?: unknown;
};
export type RuntimePeerState = 'connected' | 'connecting' | 'disconnected' | 'unknown';
export type RuntimePeerRow = {
  readonly id: string;
  readonly runtime: string;
  readonly peerId: string;
  readonly state: RuntimePeerState;
  readonly userId?: string;
  readonly deviceId?: string;
  readonly sessionId?: string;
  readonly connected?: boolean;
  readonly ephemeral?: boolean;
  readonly updatedAt?: number;
  readonly detail?: unknown;
};
export type RuntimeSyncState =
  | 'idle'
  | 'loading'
  | 'syncing'
  | 'synced'
  | 'diverged'
  | 'failed'
  | 'unknown';
export type RuntimeSyncRow = {
  readonly id: string;
  readonly runtime: string;
  readonly state: RuntimeSyncState;
  readonly documentId?: string;
  readonly peerId?: string;
  readonly storageId?: string;
  readonly localHeads?: readonly string[];
  readonly remoteHeads?: readonly string[];
  readonly sharedHeads?: readonly string[];
  readonly updatedAt?: number;
  readonly detail?: unknown;
};
export type RuntimeConflictRow = {
  readonly id: string;
  readonly runtime: string;
  readonly path: string;
  readonly documentId?: string;
  readonly relation?: string;
  readonly field?: string;
  readonly conflictCount: number;
  readonly values?: unknown;
  readonly detail?: unknown;
};
export type RuntimeHistoryRow = {
  readonly id: string;
  readonly runtime: string;
  readonly documentId?: string;
  readonly hash: string;
  readonly actor?: string;
  readonly message?: string;
  readonly time?: number;
  readonly deps?: readonly string[];
  readonly heads?: readonly string[];
  readonly detail?: unknown;
};
export type RuntimeObjectLocationRow = {
  readonly id: string;
  readonly runtime: string;
  readonly objectId: string;
  readonly path: string;
  readonly pathSegments: readonly (string | number)[];
  readonly parentObjectId?: string;
  readonly prop?: string | number;
  readonly documentId?: string;
  readonly branch?: string;
  readonly heads?: readonly string[];
  readonly relation?: string;
  readonly key?: unknown;
  readonly detail?: unknown;
};
export type RuntimeStorageState =
  | 'idle'
  | 'loading'
  | 'saving'
  | 'flushing'
  | 'synced'
  | 'failed'
  | 'closed';
export type RuntimeStorageRow = {
  readonly id: string;
  readonly runtime: string;
  readonly storage: string;
  readonly state: RuntimeStorageState;
  readonly durability?: RelationApplyDurability;
  readonly pendingWrites?: number;
  readonly lastFlushAt?: number;
  readonly lastError?: string;
  readonly detail?: unknown;
};
export type RuntimeInterestState = 'active' | 'released';
export type RuntimeInterestRow = {
  readonly id: string;
  readonly runtime: string;
  readonly queryKey: string;
  readonly state: RuntimeInterestState;
  readonly relationNames: readonly string[];
  readonly subscriberCount?: number;
  readonly retainedAt?: number;
  readonly releasedAt?: number;
  readonly detail?: unknown;
};
export type RuntimeSystemState = {
  readonly sources?: readonly RuntimeSourceRow[];
  readonly diagnostics?: readonly (RuntimeDiagnosticRow | TarstateDiagnostic)[];
  readonly peers?: readonly RuntimePeerRow[];
  readonly sync?: readonly RuntimeSyncRow[];
  readonly conflicts?: readonly RuntimeConflictRow[];
  readonly history?: readonly RuntimeHistoryRow[];
  readonly objectLocations?: readonly RuntimeObjectLocationRow[];
  readonly storage?: readonly RuntimeStorageRow[];
  readonly interests?: readonly RuntimeInterestRow[];
};
export type RuntimeSystemStateInput = RuntimeSystemState | (() => RuntimeSystemState);

export const runtimeSystemRelations = {
  sources: {
    ...relation<RuntimeSourceRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.source'),
        runtime: stringField(),
        source: stringField(),
        state: stringField(),
        priority: optional(numberField()),
        message: optional(stringField()),
        updatedAt: optional(numberField()),
        detail: optional(opaqueField<unknown>('runtime.source.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.sources'
  },
  diagnostics: {
    ...relation<RuntimeDiagnosticRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.diagnostic'),
        runtime: stringField(),
        code: stringField(),
        severity: stringField(),
        message: stringField(),
        surface: optional(stringField()),
        relation: optional(stringField()),
        source: optional(stringField()),
        detail: optional(opaqueField<unknown>('runtime.diagnostic.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.diagnostics'
  },
  peers: {
    ...relation<RuntimePeerRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.peer'),
        runtime: stringField(),
        peerId: stringField(),
        state: stringField(),
        userId: optional(stringField()),
        deviceId: optional(stringField()),
        sessionId: optional(stringField()),
        connected: optional(booleanField()),
        ephemeral: optional(booleanField()),
        updatedAt: optional(numberField()),
        detail: optional(opaqueField<unknown>('runtime.peer.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.peers'
  },
  sync: {
    ...relation<RuntimeSyncRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.sync'),
        runtime: stringField(),
        state: stringField(),
        documentId: optional(stringField()),
        peerId: optional(stringField()),
        storageId: optional(stringField()),
        localHeads: optional(jsonField() as FieldSpec<readonly string[]>),
        remoteHeads: optional(jsonField() as FieldSpec<readonly string[]>),
        sharedHeads: optional(jsonField() as FieldSpec<readonly string[]>),
        updatedAt: optional(numberField()),
        detail: optional(opaqueField<unknown>('runtime.sync.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.sync'
  },
  conflicts: {
    ...relation<RuntimeConflictRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.conflict'),
        runtime: stringField(),
        path: stringField(),
        documentId: optional(stringField()),
        relation: optional(stringField()),
        field: optional(stringField()),
        conflictCount: numberField(),
        values: optional(opaqueField<unknown>('runtime.conflict.values')),
        detail: optional(opaqueField<unknown>('runtime.conflict.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.conflicts'
  },
  history: {
    ...relation<RuntimeHistoryRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.history'),
        runtime: stringField(),
        documentId: optional(stringField()),
        hash: stringField(),
        actor: optional(stringField()),
        message: optional(stringField()),
        time: optional(numberField()),
        deps: optional(jsonField() as FieldSpec<readonly string[]>),
        heads: optional(jsonField() as FieldSpec<readonly string[]>),
        detail: optional(opaqueField<unknown>('runtime.history.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.history'
  },
  objectLocations: {
    ...relation<RuntimeObjectLocationRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.objectLocation'),
        runtime: stringField(),
        objectId: idField('tarstate.runtime.object'),
        path: stringField(),
        pathSegments: jsonField() as FieldSpec<readonly (string | number)[]>,
        parentObjectId: optional(idField('tarstate.runtime.object')),
        prop: optional(jsonField() as FieldSpec<string | number>),
        documentId: optional(stringField()),
        branch: optional(stringField()),
        heads: optional(jsonField() as FieldSpec<readonly string[]>),
        relation: optional(stringField()),
        key: optional(opaqueField<unknown>('runtime.objectLocation.key')),
        detail: optional(opaqueField<unknown>('runtime.objectLocation.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.objectLocations'
  },
  storage: {
    ...relation<RuntimeStorageRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.storage'),
        runtime: stringField(),
        storage: stringField(),
        state: stringField(),
        durability: optional(stringField()),
        pendingWrites: optional(numberField()),
        lastFlushAt: optional(numberField()),
        lastError: optional(stringField()),
        detail: optional(opaqueField<unknown>('runtime.storage.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.storage'
  },
  interests: {
    ...relation<RuntimeInterestRow, 'id'>({
      key: 'id',
      fields: {
        id: idField('tarstate.runtime.interest'),
        runtime: stringField(),
        queryKey: stringField(),
        state: stringField(),
        relationNames: jsonField() as FieldSpec<readonly string[]>,
        subscriberCount: optional(numberField()),
        retainedAt: optional(numberField()),
        releasedAt: optional(numberField()),
        detail: optional(opaqueField<unknown>('runtime.interest.detail'))
      },
      ephemeral: true
    }),
    name: 'tarstate.runtime.interests'
  }
} as const;
export const runtimeSystemRelationList: readonly RelationRef[] = Object.values(runtimeSystemRelations);

export function runtimeSystemSource(input: RuntimeSystemStateInput): RelationSource {
  const readState = (): RuntimeSystemState => typeof input === 'function' ? input() : input;
  return {
    relationNames: runtimeSystemRelationList.map((relationRef) => relationRef.name),
    rows: (relationRef) => runtimeSystemRows(readState(), relationRef),
    diagnostics: () => runtimeSystemDiagnosticRows(readState()).map(runtimeDiagnosticRowToDiagnostic)
  };
}

function runtimeSystemRows(state: RuntimeSystemState, relationRef: RelationRef): readonly unknown[] {
  switch (relationRef.name) {
    case runtimeSystemRelations.sources.name:
      return state.sources ?? [];
    case runtimeSystemRelations.diagnostics.name:
      return runtimeSystemDiagnosticRows(state);
    case runtimeSystemRelations.peers.name:
      return state.peers ?? [];
    case runtimeSystemRelations.sync.name:
      return state.sync ?? [];
    case runtimeSystemRelations.conflicts.name:
      return state.conflicts ?? [];
    case runtimeSystemRelations.history.name:
      return state.history ?? [];
    case runtimeSystemRelations.objectLocations.name:
      return state.objectLocations ?? [];
    case runtimeSystemRelations.storage.name:
      return state.storage ?? [];
    case runtimeSystemRelations.interests.name:
      return state.interests ?? [];
    default:
      return [];
  }
}

function runtimeSystemDiagnosticRows(state: RuntimeSystemState): readonly RuntimeDiagnosticRow[] {
  return (state.diagnostics ?? []).map((diagnosticValue, index) =>
    isRuntimeDiagnosticRow(diagnosticValue)
      ? diagnosticValue
      : runtimeDiagnosticRowFromDiagnostic(diagnosticValue, index));
}

function isRuntimeDiagnosticRow(input: RuntimeDiagnosticRow | TarstateDiagnostic): input is RuntimeDiagnosticRow {
  return 'id' in input && 'runtime' in input;
}

function runtimeDiagnosticRowFromDiagnostic(input: TarstateDiagnostic, index: number): RuntimeDiagnosticRow {
  return {
    id: `diagnostic:${index}:${stableKey(input)}`,
    runtime: typeof input.surface === 'string' ? input.surface : 'runtime',
    code: input.code,
    severity: input.severity ?? 'info',
    message: input.message,
    ...(typeof input.surface === 'string' ? { surface: input.surface } : {}),
    ...(typeof input.relation === 'string' ? { relation: input.relation } : {}),
    ...(input.detail === undefined ? {} : { detail: input.detail })
  };
}

function runtimeDiagnosticRowToDiagnostic(row: RuntimeDiagnosticRow): TarstateDiagnostic {
  return {
    code: row.code,
    severity: row.severity,
    message: row.message,
    ...(row.surface === undefined ? {} : { surface: row.surface }),
    ...(row.relation === undefined ? {} : { relation: row.relation }),
    ...(row.detail === undefined ? {} : { detail: row.detail })
  };
}
