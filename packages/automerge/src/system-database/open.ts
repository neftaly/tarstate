import type { JsonValue } from '@tarstate/core';
import type { AttachmentProjection } from '@tarstate/core/attachment';
import type { LogicalProjectionDemand } from '@tarstate/core/attachment/adapter';
import {
  createLiveAttachmentDatabase,
  type LiveAttachmentDatabase
} from '@tarstate/core/database/adapter';
import type { ObserverDiagnosticReporter } from '@tarstate/core/database/observer';
import type { RelationInput, QueryRecord } from '@tarstate/core/query/model';
import {
  relationLiteral,
  sealSchema,
  type LiteralRelation,
  type SchemaArtifact
} from '@tarstate/core/schema';
import type {
  ObservableSource,
  SourceSnapshot
} from '@tarstate/core/source';
import {
  AutomergeSystemRelationState,
  automergeSystemRelationIds,
  automergeSystemSchema,
  type AutomergeSystemEvent,
  type AutomergeSystemRelationSnapshot
} from '../system-relations.js';
import { adoptAutomergeSystemEvent } from './event.js';

const systemSchemaId = 'urn:tarstate:automerge:system-schema:v1';
const emptyIssues = Object.freeze([]);
const closedDatabaseSnapshot = Object.freeze({ state: 'closed' as const });
let systemSchemaPromise: Promise<SchemaArtifact<SystemSchema>> | undefined;

const relationSpecs = Object.freeze([
  { name: 'peers', relationId: automergeSystemRelationIds.peers, key: ['attachmentId', 'peerId'] },
  { name: 'connections', relationId: automergeSystemRelationIds.connections, key: ['attachmentId', 'peerId'] },
  { name: 'sync', relationId: automergeSystemRelationIds.sync, key: ['attachmentId', 'documentId', 'storageId'] },
  { name: 'conflicts', relationId: automergeSystemRelationIds.conflicts, key: ['issueId'] },
  { name: 'presence', relationId: automergeSystemRelationIds.presence, key: ['attachmentId', 'peerId', 'channel'] }
] as const);

type SystemRelationName = typeof relationSpecs[number]['name'];
type SystemSchema = typeof automergeSystemSchema;

export type OpenAutomergeSystemDatabaseOptions = {
  readonly attachmentId: string;
  readonly authorityScope: string;
  readonly onDiagnostic?: ObserverDiagnosticReporter;
};

export type AutomergeSystemRelations = {
  readonly [Name in SystemRelationName]: LiteralRelation<SystemSchema, Name>;
};

export type AutomergeSystemDatabaseSnapshot =
  | {
      readonly state: 'open';
      readonly current: AutomergeSystemRelationSnapshot;
    }
  | { readonly state: 'closed' };

type AutomergeSystemDatabaseService = {
  readonly schema: SchemaArtifact<SystemSchema>;
  readonly relations: AutomergeSystemRelations;
  /** Typed host-only port; observations are bounded and adopted before use. */
  readonly observe: (
    event: AutomergeSystemEvent
  ) => AutomergeSystemRelationSnapshot;
};

export type AutomergeSystemDatabase = LiveAttachmentDatabase<
  AutomergeSystemDatabaseService,
  AutomergeSystemDatabaseSnapshot
>;

/** Opens an opt-in read-only database over normalized Automerge host facts. */
export const openAutomergeSystemDatabase = async (
  input: OpenAutomergeSystemDatabaseOptions
): Promise<AutomergeSystemDatabase> => {
  assertIdentifier(input.attachmentId, 'attachmentId');
  assertIdentifier(input.authorityScope, 'authorityScope');

  const schema = await systemSchemaArtifact();
  const schemaView = Object.freeze({
    id: schema.id,
    contentHash: schema.contentHash
  });
  const relations = systemRelations(schema);
  const state = input.onDiagnostic === undefined
    ? new AutomergeSystemRelationState(input.attachmentId)
    : new AutomergeSystemRelationState(input.attachmentId, {
        onDiagnostic: input.onDiagnostic
      });
  const source = createSystemSource(input.attachmentId, state);
  const project = createSystemProjection({
    attachmentId: input.attachmentId,
    sourceId: source.sourceId,
    schemaView
  });
  const database = createLiveAttachmentDatabase({
    attachmentId: input.attachmentId,
    incarnation: globalThis.crypto.randomUUID(),
    authorityScope: input.authorityScope,
    service: Object.freeze({
      schema,
      relations,
      observe: (event: AutomergeSystemEvent) =>
        state.apply(adoptAutomergeSystemEvent(event))
    }),
    preparation: {
      writable: false,
      schemaViewIds: [schema.id],
      project
    },
    source,
    deriveSnapshot: (snapshot): AutomergeSystemDatabaseSnapshot => {
      if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
        return closedDatabaseSnapshot;
      }
      return Object.freeze({ state: 'open', current: snapshot.storage });
    },
    sameSnapshot: (left, right) => left.state === right.state
      && (left.state === 'closed'
        || (right.state === 'open' && left.current === right.current)),
    closedSnapshot: closedDatabaseSnapshot
  });

  return database;
};

const systemSchemaArtifact = (): Promise<SchemaArtifact<SystemSchema>> => {
  systemSchemaPromise ??= sealSchema({
    id: systemSchemaId,
    body: automergeSystemSchema
  });
  return systemSchemaPromise;
};

const systemRelations = (
  schema: SchemaArtifact<SystemSchema>
): AutomergeSystemRelations => {
  const peers = ownRelation(relationLiteral(schema, 'peers'));
  const connections = ownRelation(relationLiteral(schema, 'connections'));
  const sync = ownRelation(relationLiteral(schema, 'sync'));
  const conflicts = ownRelation(relationLiteral(schema, 'conflicts'));
  const presence = ownRelation(relationLiteral(schema, 'presence'));
  return Object.freeze({ peers, connections, sync, conflicts, presence });
};

const ownRelation = <Relation extends {
  readonly schemaView: { readonly id: string; readonly contentHash: `sha256:${string}` };
}>(relation: Relation): Relation => {
  Object.freeze(relation.schemaView);
  return Object.freeze(relation);
};

const createSystemSource = (
  attachmentId: string,
  state: AutomergeSystemRelationState
): ObservableSource<AutomergeSystemRelationSnapshot> & {
  readonly close: () => void;
} => {
  const sourceId = 'tarstate:automerge-system:' + attachmentId;
  const operationEpoch = globalThis.crypto.randomUUID();
  let closed = false;
  let currentState: AutomergeSystemRelationSnapshot | undefined;
  let currentSnapshot: SourceSnapshot<AutomergeSystemRelationSnapshot> | undefined;

  const snapshot = (): SourceSnapshot<AutomergeSystemRelationSnapshot> => {
    if (closed) {
      currentSnapshot ??= Object.freeze({
        sourceId,
        operationEpoch,
        basis: Object.freeze({ kind: 'automerge-system', revision: state.getSnapshot().revision }),
        state: 'closed',
        freshness: 'none',
        issues: emptyIssues
      });
      return currentSnapshot;
    }
    const storage = state.getSnapshot();
    if (storage === currentState && currentSnapshot !== undefined) return currentSnapshot;
    currentState = storage;
    currentSnapshot = Object.freeze({
      sourceId,
      operationEpoch,
      basis: Object.freeze({ kind: 'automerge-system', revision: storage.revision }),
      state: 'ready',
      freshness: 'current',
      storage,
      issues: emptyIssues
    });
    return currentSnapshot;
  };

  return Object.freeze({
    sourceId,
    snapshot,
    subscribe: (listener) => state.subscribe(listener),
    close: () => {
      if (closed) return;
      closed = true;
      state.close();
      currentState = undefined;
      currentSnapshot = undefined;
    }
  });
};

const createSystemProjection = (input: {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly schemaView: {
    readonly id: string;
    readonly contentHash: `sha256:${string}`;
  };
}): ((
  snapshot: SourceSnapshot<AutomergeSystemRelationSnapshot>,
  demand?: LogicalProjectionDemand
) => AttachmentProjection<readonly RelationInput[]>) => {
  const cache = new WeakMap<object, {
    full?: readonly RelationInput[];
    readonly demanded: WeakMap<LogicalProjectionDemand, readonly RelationInput[]>;
  }>();
  return (snapshot, demand) => {
    if (snapshot.state !== 'ready') {
      return { state: snapshot.state, issues: snapshot.issues };
    }
    if (snapshot.storage === undefined) {
      return { state: 'failed', issues: snapshot.issues };
    }
    let cached = cache.get(snapshot.storage);
    if (cached === undefined) {
      cached = { demanded: new WeakMap() };
      cache.set(snapshot.storage, cached);
    }
    let relations = demand === undefined
      ? cached.full
      : cached.demanded.get(demand);
    if (relations === undefined) {
      const selection = selectRelations(demand, input.schemaView);
      relations = materializeRelationInputs(
        snapshot.storage,
        snapshot.basis,
        input,
        selection
      );
      if (demand === undefined) cached.full = relations;
      else cached.demanded.set(demand, relations);
    }
    return { state: 'ready', value: relations, issues: snapshot.issues };
  };
};

const selectRelations = (
  demand: LogicalProjectionDemand | undefined,
  schemaView: { readonly id: string; readonly contentHash: string }
): ReadonlyMap<string, ReadonlySet<string>> | undefined => {
  if (demand === undefined) return undefined;
  const selected = new Map<string, Set<string>>();
  for (const requested of demand.relations) {
    if (requested.relation.schemaView.id !== schemaView.id
      || requested.relation.schemaView.contentHash !== schemaView.contentHash) {
      continue;
    }
    let fields = selected.get(requested.relation.relationId);
    if (fields === undefined) {
      fields = new Set();
      selected.set(requested.relation.relationId, fields);
    }
    for (const field of requested.fields) fields.add(field);
  }
  return selected;
};

const materializeRelationInputs = (
  snapshot: AutomergeSystemRelationSnapshot,
  basis: JsonValue,
  input: {
    readonly attachmentId: string;
    readonly sourceId: string;
    readonly schemaView: {
      readonly id: string;
      readonly contentHash: `sha256:${string}`;
    };
  },
  selection: ReadonlyMap<string, ReadonlySet<string>> | undefined
): readonly RelationInput[] => {
  const relations: RelationInput[] = [];
  for (const spec of relationSpecs) {
    const fields = selection?.get(spec.relationId);
    if (selection !== undefined && fields === undefined) continue;
    const sourceRows = snapshot[spec.name] as readonly QueryRecord[];
    const rows = fields === undefined
      ? sourceRows
      : Object.freeze(sourceRows.map((row) => selectFields(row, fields)));
    const occurrenceIds = Object.freeze(sourceRows.map((row) =>
      systemOccurrenceId(spec.relationId, spec.key, row)));
    relations.push(Object.freeze({
      relation: Object.freeze({
        schemaView: input.schemaView,
        relationId: spec.relationId
      }),
      rows,
      occurrenceIds,
      completeness: 'exact',
      sourceId: input.sourceId,
      attachmentId: input.attachmentId,
      basis
    }));
  }
  return Object.freeze(relations);
};

const systemOccurrenceId = (
  relationId: string,
  fields: readonly string[],
  row: QueryRecord
): string => {
  let identity = relationId.length + ':' + relationId;
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== 'string') {
      throw new Error('Missing Automerge system relation key field in ' + relationId);
    }
    identity += value.length + ':' + value;
  }
  return identity;
};

const selectFields = (
  row: QueryRecord,
  fields: ReadonlySet<string>
): QueryRecord => {
  const selected: Record<string, QueryRecord[string]> = {};
  for (const field of fields) {
    const value = row[field];
    if (value !== undefined) selected[field] = value;
  }
  return Object.freeze(selected);
};

const assertIdentifier = (value: string, name: string): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(name + ' must be a non-empty string');
  }
};
