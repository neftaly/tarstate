import { describe, expect, it, vi } from 'vitest';
import { createIssue } from '../src/issues.js';
import { prepareSchema, parseRelationCandidate } from '../src/schema.js';
import {
  createSystemSchemaArtifact,
  materializeIssueSystemRow,
  materializeSystemRelationInputs,
  materializeSystemRelationRows,
  PresenceCommandRuntime,
  SYSTEM_RELATION_IDS,
  SYSTEM_SCHEMA_ID,
  systemSchemaBody,
  type SystemCatalogSnapshot
} from '../src/system-relations.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;

const catalog = (): SystemCatalogSnapshot => ({
  viewId: 'authority:test',
  basis: { membershipRevision: 4, sourceRevisions: { alpha: 2 } },
  sources: [{ sourceId: 'source:alpha', sourceKind: 'memory', lifecycle: 'ready', freshness: 'current', currentBasis: { revision: 2 }, durabilityCapability: { id: 'urn:test:durability', version: '1', contractHash: hash('a') } }],
  attachments: [{ attachmentId: 'attachment:alpha', sourceId: 'source:alpha', lifecycle: 'ready', freshness: 'current', writable: true, declarationState: 'ready' }],
  memberships: [{ datasetId: 'dataset:test', revision: 4, attachmentId: 'attachment:alpha', sourceId: 'source:alpha', expectation: 'required', settlementState: 'settled' }],
  resources: [{ resourceId: 'resource:tiger', kind: 'bytes', requestedRef: 'https://example.test/tiger.svg', resolvedRef: 'https://cdn.example.test/tiger.svg', lifecycle: 'ready', freshness: 'current', redirects: ['https://example.test/tiger.svg'], mediaType: 'image/svg+xml', etag: 'tiger-v1', contentHash: hash('b'), cacheState: 'revalidated', bytes: { kind: 'tarstate.value', type: 'bytes', value: 'PHN2Zz4' } }],
  discoveryEdges: [{ edgeId: 'edge:a-b', datasetId: 'dataset:test', revision: 4, originAttachmentId: 'attachment:alpha', path: ['children', 0], declaredRef: 'automerge:B', expectation: 'required', state: 'ready', targetResourceId: 'resource:B', cycle: false }],
  schemas: [{ attachmentId: 'attachment:alpha', schemaHash: hash('c'), schemaRef: { id: 'urn:test:schema', contentHash: hash('c') }, selectedLensRefs: [{ id: 'urn:test:lens', contentHash: hash('d') }], resolutionState: 'ready' }],
  capabilities: [{ attachmentId: 'attachment:alpha', capabilityId: 'urn:test:move', version: '1', contractHash: hash('e'), available: false, reasonCode: 'adapter_missing' }],
  issues: [{ issueId: 'issue:one', code: 'source.not_ready', severity: 'error', phase: 'load', sourceId: 'source:alpha', subject: { attachmentId: 'attachment:alpha' } }],
  constraints: [{ violationId: 'violation:one', setId: 'set:one', constraintId: 'constraint:unique', status: 'violated', subject: { relationId: 'example.item', key: ['duplicate'] }, code: 'constraint.unique' }],
  repairCandidates: [{ attachmentId: 'attachment:alpha', candidateId: 'candidate:one', sourceId: 'source:alpha', relationId: 'example.item', logicalKey: ['duplicate'], candidateKind: 'duplicate-key', liveState: 'live', issueIds: ['issue:one'] }]
});

describe('built-in system relations', () => {
  it('seals one immutable v1 schema with all generic minimum relation IDs', async () => {
    const first = await createSystemSchemaArtifact();
    const second = await createSystemSchemaArtifact();
    expect(first).toMatchObject({ kind: 'schema', id: SYSTEM_SCHEMA_ID, formatVersion: 1 });
    expect(second.contentHash).toBe(first.contentHash);
    expect(Object.isFrozen(systemSchemaBody)).toBe(true);
    expect(Object.isFrozen(systemSchemaBody.relations)).toBe(true);
    expect(Object.values(systemSchemaBody.relations).map(({ relationId }) => relationId).sort())
      .toEqual(Object.values(SYSTEM_RELATION_IDS).sort());
    expect(prepareSchema(first.body)).toMatchObject({ success: true });
  });

  it('materializes every row as exact, basis-bearing, schema-conforming query input', async () => {
    const artifact = await createSystemSchemaArtifact();
    const prepared = prepareSchema(artifact.body);
    if (!prepared.success) throw new Error('system schema did not prepare');
    const snapshot = catalog();
    const rows = materializeSystemRelationRows(snapshot);
    const inputs = materializeSystemRelationInputs(snapshot, artifact);

    expect(inputs).toHaveLength(10);
    expect(inputs.every(({ completeness, basis }) => completeness === 'exact' && basis === snapshot.basis)).toBe(true);
    expect(inputs.every(({ rows: relationRows }) => relationRows.every((row) => row.basis === snapshot.basis))).toBe(true);
    expect(new Set(inputs.flatMap(({ occurrenceIds }) => occurrenceIds ?? [])).size).toBe(10);

    for (const [relationId, relationRows] of Object.entries(rows)) {
      for (const row of relationRows) expect(parseRelationCandidate(prepared.value, relationId, row), relationId).toMatchObject({ success: true });
    }
  });

  it('rejects duplicate system keys instead of producing ambiguous occurrence identity', async () => {
    const artifact = await createSystemSchemaArtifact();
    const snapshot = catalog();
    expect(() => materializeSystemRelationInputs({ ...snapshot, sources: [...(snapshot.sources ?? []), ...(snapshot.sources ?? [])] }, artifact))
      .toThrow('Duplicate system relation key');
  });

  it('materializes only explicitly authorized issue subjects and omits diagnostic details', () => {
    const issue = createIssue({ code: 'source.not_ready', sourceId: 'source:alpha', retry: 'after_refresh', details: { secret: 'not-a-system-field' } });
    const hidden = materializeIssueSystemRow(issue);
    const authorized = materializeIssueSystemRow(issue, { attachmentId: 'attachment:alpha' });
    expect(hidden).not.toHaveProperty('subject');
    expect(hidden).not.toHaveProperty('details');
    expect(authorized).toMatchObject({ issueId: issue.id, sourceId: 'source:alpha', subject: { attachmentId: 'attachment:alpha' } });
  });

  it('exposes an explicit ephemeral presence command surface with receipt semantics', async () => {
    const sink = vi.fn(() => []);
    const runtime = new PresenceCommandRuntime(sink);
    const accepted = await runtime.setPresence({ operationId: 'presence:1', attachmentId: 'attachment:alpha', sessionId: 'session:one', action: 'set', value: { cursor: 'a1' } });
    expect(accepted).toMatchObject({ kind: 'presence', outcome: 'accepted', issues: [] });
    expect(sink).toHaveBeenCalledOnce();
    expect(await runtime.setPresence({ operationId: 'presence:2', attachmentId: 'attachment:alpha', sessionId: 'session:one', action: 'clear', value: null }))
      .toMatchObject({ outcome: 'rejected', issues: [{ code: 'presence.command_invalid' }] });
    expect(sink).toHaveBeenCalledOnce();
  });
});
