import { canonicalizeJson, normalizeArtifactRef, sealArtifact, type Artifact, type ArtifactRef } from './artifacts.js';
import type { FieldDeclaration, SchemaBody } from './schema.js';
import type { CapabilityRef, Issue, IssuePhase, IssueSeverity } from './issues.js';
import type { SourceBasis } from './source-state.js';
import type { QueryRecord, RelationInput } from './query-model.js';
import { executePresence, type PresenceReceipt, type SetPresenceCommand } from './receipts.js';
import type { JsonValue } from './value.js';

export const SYSTEM_SCHEMA_ID = 'urn:tarstate:schema:system:v1';

export const SYSTEM_RELATION_IDS = Object.freeze({
  sources: 'tarstate.system.sources',
  attachments: 'tarstate.system.attachments',
  memberships: 'tarstate.system.memberships',
  resources: 'tarstate.system.resources',
  discoveryEdges: 'tarstate.system.discovery_edges',
  schemas: 'tarstate.system.schemas',
  capabilities: 'tarstate.system.capabilities',
  issues: 'tarstate.system.issues',
  constraints: 'tarstate.system.constraints',
  repairCandidates: 'tarstate.system.repair_candidates'
} as const);

export type SystemRelationId = typeof SYSTEM_RELATION_IDS[keyof typeof SYSTEM_RELATION_IDS];
type BasisBearing = { readonly basis: JsonValue };

export type SourceSystemRow = BasisBearing & {
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly lifecycle: 'loading' | 'ready' | 'failed' | 'denied' | 'deleted' | 'closed';
  readonly freshness: 'current' | 'stale' | 'none';
  readonly currentBasis: SourceBasis;
  readonly durabilityCapability?: CapabilityRef;
};

export type AttachmentSystemRow = BasisBearing & {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly lifecycle: 'loading' | 'ready' | 'failed' | 'denied' | 'deleted' | 'closed';
  readonly freshness: 'current' | 'stale' | 'none';
  readonly writable: boolean;
  readonly declarationState: 'absent' | 'ready' | 'malformed' | 'conflicted' | 'out-of-band';
};

export type MembershipSystemRow = BasisBearing & {
  readonly datasetId: string;
  readonly revision: number;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly expectation: 'required' | 'optional';
  readonly settlementState: 'open' | 'settled';
};

export type ResourceSystemRow = BasisBearing & {
  readonly resourceId: string;
  readonly kind: 'bytes' | 'document' | 'schema' | 'constraint' | 'storage-mapping' | 'executable' | 'unknown';
  readonly requestedRef: string;
  readonly resolvedRef?: string;
  readonly lifecycle: 'loading' | 'ready' | 'missing' | 'failed' | 'denied' | 'deleted';
  readonly freshness: 'current' | 'stale' | 'none';
  readonly redirects: readonly string[];
  readonly mediaType?: string;
  readonly etag?: string;
  readonly contentHash?: `sha256:${string}`;
  readonly cacheState?: 'miss' | 'memory' | 'local' | 'revalidated';
  readonly bytes?: { readonly kind: 'tarstate.value'; readonly type: 'bytes'; readonly value: string };
};

export type DiscoveryEdgeSystemRow = BasisBearing & {
  readonly edgeId: string;
  readonly datasetId: string;
  readonly revision: number;
  readonly originAttachmentId?: string;
  readonly originResourceId?: string;
  readonly path: readonly JsonValue[];
  readonly declaredRef: string;
  readonly expectation: 'required' | 'optional';
  readonly state: 'loading' | 'ready' | 'missing' | 'denied' | 'failed' | 'unsupported';
  readonly targetResourceId?: string;
  readonly aliasOfResourceId?: string;
  readonly cycle: boolean;
};

export type SchemaSystemRow = BasisBearing & {
  readonly attachmentId: string;
  readonly schemaHash: `sha256:${string}`;
  readonly schemaRef: ArtifactRef;
  readonly selectedLensRefs: readonly ArtifactRef[];
  readonly resolutionState: 'ready' | 'missing' | 'ambiguous' | 'unsupported';
};

export type CapabilitySystemRow = BasisBearing & {
  readonly attachmentId: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly contractHash: `sha256:${string}`;
  readonly available: boolean;
  readonly reasonCode?: string;
};

export type IssueSystemRow = BasisBearing & {
  readonly issueId: string;
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly phase: IssuePhase;
  readonly sourceId?: string;
  readonly relationId?: string;
  readonly operationId?: string;
  readonly subject?: JsonValue;
};

export type ConstraintSystemRow = BasisBearing & {
  readonly violationId: string;
  readonly setId: string;
  readonly constraintId: string;
  readonly status: 'violated' | 'indeterminate' | 'resolved' | 'audit';
  readonly subject: JsonValue;
  readonly code: string;
};

export type RepairCandidateSystemRow = BasisBearing & {
  readonly attachmentId: string;
  readonly candidateId: string;
  readonly sourceId: string;
  readonly relationId: string;
  readonly logicalKey?: JsonValue;
  readonly candidateKind: 'duplicate-key' | 'relocation' | 'conflict' | 'unparseable';
  readonly liveState: 'live' | 'stale' | 'removed';
  readonly issueIds: readonly string[];
};

export type SystemRelationRows = {
  readonly [SYSTEM_RELATION_IDS.sources]: readonly SourceSystemRow[];
  readonly [SYSTEM_RELATION_IDS.attachments]: readonly AttachmentSystemRow[];
  readonly [SYSTEM_RELATION_IDS.memberships]: readonly MembershipSystemRow[];
  readonly [SYSTEM_RELATION_IDS.resources]: readonly ResourceSystemRow[];
  readonly [SYSTEM_RELATION_IDS.discoveryEdges]: readonly DiscoveryEdgeSystemRow[];
  readonly [SYSTEM_RELATION_IDS.schemas]: readonly SchemaSystemRow[];
  readonly [SYSTEM_RELATION_IDS.capabilities]: readonly CapabilitySystemRow[];
  readonly [SYSTEM_RELATION_IDS.issues]: readonly IssueSystemRow[];
  readonly [SYSTEM_RELATION_IDS.constraints]: readonly ConstraintSystemRow[];
  readonly [SYSTEM_RELATION_IDS.repairCandidates]: readonly RepairCandidateSystemRow[];
};

export type SystemCatalogSnapshot = {
  readonly viewId: string;
  readonly basis: JsonValue;
  readonly sources?: readonly Omit<SourceSystemRow, 'basis'>[];
  readonly attachments?: readonly Omit<AttachmentSystemRow, 'basis'>[];
  readonly memberships?: readonly Omit<MembershipSystemRow, 'basis'>[];
  readonly resources?: readonly Omit<ResourceSystemRow, 'basis'>[];
  readonly discoveryEdges?: readonly Omit<DiscoveryEdgeSystemRow, 'basis'>[];
  readonly schemas?: readonly Omit<SchemaSystemRow, 'basis'>[];
  readonly capabilities?: readonly Omit<CapabilitySystemRow, 'basis'>[];
  readonly issues?: readonly Omit<IssueSystemRow, 'basis'>[];
  readonly constraints?: readonly Omit<ConstraintSystemRow, 'basis'>[];
  readonly repairCandidates?: readonly Omit<RepairCandidateSystemRow, 'basis'>[];
};

const stringField = (values?: readonly string[], optional = false): FieldDeclaration => ({
  type: values === undefined ? { kind: 'string' } : { kind: 'string', values },
  ...(optional ? { optional: true } : {})
});
const booleanField = (): FieldDeclaration => ({ type: { kind: 'boolean' } });
const integerField = (): FieldDeclaration => ({ type: { kind: 'integer' } });
const jsonField = (optional = false): FieldDeclaration => ({ type: { kind: 'json' }, ...(optional ? { optional: true } : {}) });
const bytesField = (): FieldDeclaration => ({ type: { kind: 'bytes' }, optional: true });
const basisField = jsonField();

export const systemSchemaBody: SchemaBody = deepFreeze({
  description: 'Tarstate v1 built-in authority-filtered system relations',
  metadata: { builtIn: true, systemSchemaVersion: 1 },
  relations: {
    sources: relation(SYSTEM_RELATION_IDS.sources, ['sourceId'], {
      sourceId: stringField(), sourceKind: stringField(), lifecycle: stringField(['loading', 'ready', 'failed', 'denied', 'deleted', 'closed']),
      freshness: stringField(['current', 'stale', 'none']), currentBasis: jsonField(), durabilityCapability: jsonField(true), basis: basisField
    }),
    attachments: relation(SYSTEM_RELATION_IDS.attachments, ['attachmentId'], {
      attachmentId: stringField(), sourceId: stringField(), lifecycle: stringField(['loading', 'ready', 'failed', 'denied', 'deleted', 'closed']),
      freshness: stringField(['current', 'stale', 'none']), writable: booleanField(), declarationState: stringField(['absent', 'ready', 'malformed', 'conflicted', 'out-of-band']), basis: basisField
    }),
    memberships: relation(SYSTEM_RELATION_IDS.memberships, ['datasetId', 'revision', 'attachmentId'], {
      datasetId: stringField(), revision: integerField(), attachmentId: stringField(), sourceId: stringField(), expectation: stringField(['required', 'optional']), settlementState: stringField(['open', 'settled']), basis: basisField
    }),
    resources: relation(SYSTEM_RELATION_IDS.resources, ['resourceId'], {
      resourceId: stringField(), kind: stringField(['bytes', 'document', 'schema', 'constraint', 'storage-mapping', 'executable', 'unknown']), requestedRef: stringField(), resolvedRef: stringField(undefined, true),
      lifecycle: stringField(['loading', 'ready', 'missing', 'failed', 'denied', 'deleted']), freshness: stringField(['current', 'stale', 'none']), redirects: jsonField(), mediaType: stringField(undefined, true), etag: stringField(undefined, true), contentHash: stringField(undefined, true), cacheState: stringField(['miss', 'memory', 'local', 'revalidated'], true), bytes: bytesField(), basis: basisField
    }),
    discoveryEdges: relation(SYSTEM_RELATION_IDS.discoveryEdges, ['edgeId'], {
      edgeId: stringField(), datasetId: stringField(), revision: integerField(), originAttachmentId: stringField(undefined, true), originResourceId: stringField(undefined, true), path: jsonField(), declaredRef: stringField(), expectation: stringField(['required', 'optional']),
      state: stringField(['loading', 'ready', 'missing', 'denied', 'failed', 'unsupported']), targetResourceId: stringField(undefined, true), aliasOfResourceId: stringField(undefined, true), cycle: booleanField(), basis: basisField
    }),
    schemas: relation(SYSTEM_RELATION_IDS.schemas, ['attachmentId', 'schemaHash'], {
      attachmentId: stringField(), schemaHash: stringField(), schemaRef: jsonField(), selectedLensRefs: jsonField(), resolutionState: stringField(['ready', 'missing', 'ambiguous', 'unsupported']), basis: basisField
    }),
    capabilities: relation(SYSTEM_RELATION_IDS.capabilities, ['attachmentId', 'capabilityId', 'version', 'contractHash'], {
      attachmentId: stringField(), capabilityId: stringField(), version: stringField(), contractHash: stringField(), available: booleanField(), reasonCode: stringField(undefined, true), basis: basisField
    }),
    issues: relation(SYSTEM_RELATION_IDS.issues, ['issueId'], {
      issueId: stringField(), code: stringField(), severity: stringField(['info', 'warning', 'error']), phase: stringField(['resolve', 'load', 'parse', 'query', 'plan', 'constraint', 'commit', 'governance', 'lifecycle', 'presence', 'sync']),
      sourceId: stringField(undefined, true), relationId: stringField(undefined, true), operationId: stringField(undefined, true), subject: jsonField(true), basis: basisField
    }),
    constraints: relation(SYSTEM_RELATION_IDS.constraints, ['violationId'], {
      violationId: stringField(), setId: stringField(), constraintId: stringField(), status: stringField(['violated', 'indeterminate', 'resolved', 'audit']), subject: jsonField(), code: stringField(), basis: basisField
    }),
    repairCandidates: relation(SYSTEM_RELATION_IDS.repairCandidates, ['attachmentId', 'candidateId'], {
      attachmentId: stringField(), candidateId: stringField(), sourceId: stringField(), relationId: stringField(), logicalKey: jsonField(true), candidateKind: stringField(['duplicate-key', 'relocation', 'conflict', 'unparseable']), liveState: stringField(['live', 'stale', 'removed']), issueIds: jsonField(), basis: basisField
    })
  }
});

export const createSystemSchemaArtifact = (): Promise<Artifact> => sealArtifact({
  kind: 'schema',
  id: SYSTEM_SCHEMA_ID,
  body: systemSchemaBody as unknown as JsonValue
});

export const materializeIssueSystemRow = (issue: Issue, subject?: JsonValue): Omit<IssueSystemRow, 'basis'> => ({
  issueId: issue.id,
  code: issue.code,
  severity: issue.severity,
  phase: issue.phase,
  ...(issue.sourceId === undefined ? {} : { sourceId: issue.sourceId }),
  ...(issue.relationId === undefined ? {} : { relationId: issue.relationId }),
  ...(issue.operationId === undefined ? {} : { operationId: issue.operationId }),
  ...(subject === undefined ? {} : { subject })
});

export const materializeSystemRelationRows = (snapshot: SystemCatalogSnapshot): SystemRelationRows => ({
  [SYSTEM_RELATION_IDS.sources]: withBasis(snapshot.sources, snapshot.basis),
  [SYSTEM_RELATION_IDS.attachments]: withBasis(snapshot.attachments, snapshot.basis),
  [SYSTEM_RELATION_IDS.memberships]: withBasis(snapshot.memberships, snapshot.basis),
  [SYSTEM_RELATION_IDS.resources]: withBasis(snapshot.resources, snapshot.basis),
  [SYSTEM_RELATION_IDS.discoveryEdges]: withBasis(snapshot.discoveryEdges, snapshot.basis),
  [SYSTEM_RELATION_IDS.schemas]: withBasis(snapshot.schemas, snapshot.basis),
  [SYSTEM_RELATION_IDS.capabilities]: withBasis(snapshot.capabilities, snapshot.basis),
  [SYSTEM_RELATION_IDS.issues]: withBasis(snapshot.issues, snapshot.basis),
  [SYSTEM_RELATION_IDS.constraints]: withBasis(snapshot.constraints, snapshot.basis),
  [SYSTEM_RELATION_IDS.repairCandidates]: withBasis(snapshot.repairCandidates, snapshot.basis)
});

export const materializeSystemRelationInputs = (snapshot: SystemCatalogSnapshot, schemaView: ArtifactRef): readonly RelationInput[] => {
  const rows = materializeSystemRelationRows(snapshot);
  const normalizedSchemaView = normalizeArtifactRef(schemaView);
  return Object.entries(systemRelationKeys).map(([relationId, keyFields]) => {
    const relationRows = rows[relationId as SystemRelationId] as readonly QueryRecord[];
    const occurrenceIds = relationRows.map((row) => occurrenceId(relationId, keyFields, row));
    if (new Set(occurrenceIds).size !== occurrenceIds.length) throw new Error('Duplicate system relation key in ' + relationId);
    return Object.freeze({
      relation: { schemaView: normalizedSchemaView, relationId },
      rows: Object.freeze([...relationRows]),
      occurrenceIds: Object.freeze(occurrenceIds),
      completeness: 'exact' as const,
      sourceId: 'tarstate:system',
      attachmentId: 'tarstate:system:' + snapshot.viewId,
      basis: snapshot.basis
    });
  });
};

export type PresenceCommandSink = (command: SetPresenceCommand) => Promise<readonly Issue[]> | readonly Issue[];

/** Explicit host-owned command surface; it stores no durable or ambient presence state. */
export class PresenceCommandRuntime {
  readonly #sink: PresenceCommandSink;
  constructor(sink: PresenceCommandSink) { this.#sink = sink; }
  setPresence(command: SetPresenceCommand): Promise<PresenceReceipt> { return executePresence(command, this.#sink); }
}

function relation(relationId: string, key: readonly string[], fields: Readonly<Record<string, FieldDeclaration>>) {
  return { relationId, key, fields };
}

const systemRelationKeys: Readonly<Record<SystemRelationId, readonly string[]>> = Object.freeze({
  [SYSTEM_RELATION_IDS.sources]: ['sourceId'],
  [SYSTEM_RELATION_IDS.attachments]: ['attachmentId'],
  [SYSTEM_RELATION_IDS.memberships]: ['datasetId', 'revision', 'attachmentId'],
  [SYSTEM_RELATION_IDS.resources]: ['resourceId'],
  [SYSTEM_RELATION_IDS.discoveryEdges]: ['edgeId'],
  [SYSTEM_RELATION_IDS.schemas]: ['attachmentId', 'schemaHash'],
  [SYSTEM_RELATION_IDS.capabilities]: ['attachmentId', 'capabilityId', 'version', 'contractHash'],
  [SYSTEM_RELATION_IDS.issues]: ['issueId'],
  [SYSTEM_RELATION_IDS.constraints]: ['violationId'],
  [SYSTEM_RELATION_IDS.repairCandidates]: ['attachmentId', 'candidateId']
});

const occurrenceId = (relationId: string, fields: readonly string[], row: QueryRecord): string => {
  const key = fields.map((field) => row[field]);
  if (key.some((value) => value === undefined)) throw new Error('Missing system relation key field in ' + relationId);
  return relationId + ':' + canonicalizeJson(key as JsonValue);
};

const withBasis = <Row extends object>(rows: readonly Row[] | undefined, basis: JsonValue): readonly (Row & BasisBearing)[] =>
  Object.freeze((rows ?? []).map((row) => Object.freeze({ ...row, basis })));

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
