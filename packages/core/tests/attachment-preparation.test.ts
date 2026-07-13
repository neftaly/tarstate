import { describe, expect, it } from 'vitest';
import { sealArtifact, type Artifact, type ArtifactRef } from '../src/artifacts.js';
import { prepareDatabaseAttachment, prepareManualReadOnlyAttachment } from '../src/attachment-preparation.js';
import { AttachmentCatalog, type SourceSnapshot } from '../src/database.js';
import type { Issue } from '../src/issues.js';
import { capabilityRefFor, CapabilityRegistry, type CapabilityDeclaration } from '../src/registry.js';
import type { DocumentDeclaration } from '../src/receipts.js';
import type { JsonValue } from '../src/value.js';

const capabilityDeclaration: CapabilityDeclaration = {
  kind: 'tarstate.capability-contract',
  formatVersion: 1,
  id: 'urn:test:attachment:replace',
  version: '1',
  class: 'edit',
  contract: { operation: 'replace' },
  implies: []
};

const fixtures = async (constraintCapability?: CapabilityDeclaration) => {
  const writeCapability = await capabilityRefFor(capabilityDeclaration);
  const schema = await sealArtifact({
    kind: 'schema', id: 'urn:test:attachment:schema', body: {
      relations: {
        items: {
          relationId: 'test.item', key: ['id'],
          fields: { id: { type: { kind: 'string' } }, title: { type: { kind: 'string' }, editCapabilities: [writeCapability] } }
        }
      }
    }
  });
  const mapping = await sealArtifact({
    kind: 'storage-mapping', id: 'urn:test:attachment:mapping', body: {
      schema: ref(schema), model: 'json-tree-v1', relations: {
        'test.item': {
          collection: { kind: 'object-map', path: ['items'], absent: 'empty' },
          keys: { id: { kind: 'field', path: ['id'] } },
          fields: { title: { path: ['title'], write: { kind: 'replace', capability: writeCapability } } }
        }
      }
    }
  });
  const constraintRef = constraintCapability === undefined ? undefined : await capabilityRefFor(constraintCapability);
  const constraint = constraintRef === undefined ? undefined : await sealArtifact({
    kind: 'constraint-set', id: 'urn:test:attachment:constraints', body: {
      schemaView: ref(schema),
      constraints: [{ id: 'title', code: 'test.title', dependencyRelations: ['test.item'], violationQuery: { kind: 'values', alias: 'violation', rows: [] } }],
      requiredCapabilities: [constraintRef]
    }
  });
  const declaration = (constraintArtifact = constraint): DocumentDeclaration => ({
    formatVersion: 1,
    storageSchema: ref(schema),
    projection: { kind: 'storage-mapping', storageMapping: ref(mapping) },
    ...(constraintArtifact === undefined ? {} : { constraints: { set: ref(constraintArtifact), mode: 'required' } })
  });
  const artifacts = new Map<string, Artifact>([schema, mapping, ...(constraint === undefined ? [] : [constraint])].map((artifact) => [key(ref(artifact)), artifact]));
  return { writeCapability, schema, mapping, constraint, declaration, artifacts };
};

class TestSource {
  readonly sourceId = 'source:attachment';
  readonly #snapshot: SourceSnapshot<{ readonly items: Readonly<Record<string, { readonly id: string; readonly title: string }>> }> = {
    sourceId: this.sourceId,
    operationEpoch: 'epoch:one',
    basis: { revision: 0 },
    state: 'ready',
    freshness: 'current',
    storage: { items: { one: { id: 'one', title: 'One' } } },
    issues: []
  };
  snapshot = () => this.#snapshot;
  subscribe = () => () => undefined;
}

describe('database attachment preparation', () => {
  it('owns and freezes ready preparation arrays and issues while retaining callbacks', () => {
    const schemaViewIds = ['schema:z', 'schema:a', 'schema:z'];
    const details = { nested: [1] };
    const issues: Issue[] = [{
      id: 'test:owned', code: 'test.owned', severity: 'warning', phase: 'resolve', retry: 'after_input', details
    }];
    const project = (_snapshot: SourceSnapshot<unknown>) => ({ state: 'ready' as const, value: null, issues: [] });
    const prepared = prepareManualReadOnlyAttachment({ schemaViewIds, issues, project });

    schemaViewIds.push('schema:late');
    issues.length = 0;
    details.nested.push(2);

    expect(prepared.schemaViewIds).toEqual(['schema:a', 'schema:z']);
    expect(prepared.issues).toMatchObject([{ details: { nested: [1] } }]);
    expect(prepared.project).toBe(project);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.schemaViewIds)).toBe(true);
    expect(Object.isFrozen(prepared.constraints)).toBe(true);
    expect(Object.isFrozen(prepared.issues)).toBe(true);
    expect(Object.isFrozen(prepared.issues[0])).toBe(true);
    expect(Object.isFrozen(prepared.issues[0]?.details)).toBe(true);
  });

  it('rejects hostile ready preparation arrays without invoking getters', () => {
    let getterCalls = 0;
    const schemaViewIds: string[] = [];
    Object.defineProperty(schemaViewIds, '0', {
      enumerable: true,
      get: () => { getterCalls += 1; return 'schema:hostile'; }
    });
    schemaViewIds.length = 1;
    expect(() => prepareManualReadOnlyAttachment({
      schemaViewIds,
      project: (_snapshot: SourceSnapshot<unknown>) => ({ state: 'ready' as const, value: null, issues: [] })
    })).toThrow(/descriptor-safe array/);
    expect(getterCalls).toBe(0);
  });

  it('resolves exact bootstrap artifacts and lets the catalog derive writable projection state', async () => {
    const fixture = await fixtures();
    const registry = new CapabilityRegistry('trust:attachment');
    await registry.registerDeclaration(capabilityDeclaration);
    registry.registerImplementation({ ref: fixture.writeCapability, integrity: 'test:replace', implementation: {} });
    const prepared = await prepareDatabaseAttachment({
      sourceId: 'source:attachment',
      bootstrap: { status: 'ready', declaration: fixture.declaration() },
      resolveArtifact: (reference) => fixture.artifacts.get(key(reference)),
      registry
    });
    expect(prepared).toMatchObject({ state: 'ready', origin: 'bootstrap', writable: true, schemaViewIds: [fixture.schema.id], issues: [] });
    if (prepared.state !== 'ready') throw new Error('attachment did not prepare');

    const source = new TestSource();
    const catalog = new AttachmentCatalog();
    const lease = catalog.attach({
      attachmentId: 'attachment:one', incarnation: 'attachment:one:1', sourceId: source.sourceId, source,
      authorityScope: 'public', discoveryEdges: [], preparation: prepared
    });
    expect(lease.attachment.writable).toBe(true);
    const projection = lease.attachment.project(source.snapshot());
    expect(projection).toMatchObject({ state: 'ready', value: { completeness: 'exact' } });
    if (projection.state !== 'ready' || !('relations' in projection.value)) throw new Error('mapping projection did not become ready');
    expect(projection.value.relations.get('test.item')?.rows).toHaveLength(1);
    lease.close();
  });

  it('keeps a valid mapping readable but makes missing exact write capabilities read-only', async () => {
    const fixture = await fixtures();
    const prepared = await prepareDatabaseAttachment({
      sourceId: 'source:attachment', bootstrap: { status: 'ready', declaration: fixture.declaration() },
      resolveArtifact: (reference) => fixture.artifacts.get(key(reference)), registry: new CapabilityRegistry('trust:old')
    });
    expect(prepared).toMatchObject({ state: 'ready', writable: false, issues: [{ code: 'capability.missing', requiredCapabilities: [fixture.writeCapability] }] });
    if (prepared.state !== 'ready') throw new Error('attachment did not prepare');
    expect(prepared.project(new TestSource().snapshot())).toMatchObject({ state: 'ready', value: { completeness: 'exact' } });
  });

  it('keeps required constraint failures readable but read-only', async () => {
    const executor: CapabilityDeclaration = {
      kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:attachment:constraint-executor', version: '1', class: 'executor', contract: { query: 1 }, implies: []
    };
    const fixture = await fixtures(executor);
    const registry = new CapabilityRegistry('trust:constraint');
    await registry.registerDeclaration(capabilityDeclaration);
    registry.registerImplementation({ ref: fixture.writeCapability, integrity: 'test:replace', implementation: {} });
    const prepared = await prepareDatabaseAttachment({
      sourceId: 'source:attachment', bootstrap: { status: 'ready', declaration: fixture.declaration() },
      resolveArtifact: (reference) => fixture.artifacts.get(key(reference)), registry,
      evaluateConstraintQuery: () => ({ rows: [], completeness: 'exact', issues: [] })
    });
    expect(prepared).toMatchObject({ state: 'ready', writable: false, issues: [{ code: 'capability.missing' }] });

    if (fixture.constraint === undefined) throw new Error('constraint fixture missing');
    const malformedArtifacts = new Map(fixture.artifacts);
    malformedArtifacts.set(key(ref(fixture.constraint)), { ...fixture.constraint, body: { malformed: true } as JsonValue });
    const malformed = await prepareDatabaseAttachment({
      sourceId: 'source:attachment', bootstrap: { status: 'ready', declaration: fixture.declaration() },
      resolveArtifact: (reference) => malformedArtifacts.get(key(reference)), registry,
      evaluateConstraintQuery: () => ({ rows: [], completeness: 'exact', issues: [] })
    });
    expect(malformed).toMatchObject({ state: 'ready', writable: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'artifact.hash_mismatch' })]) });
  });

  it('uses out-of-band recovery from malformed bootstrap only as read-only evidence', async () => {
    const fixture = await fixtures();
    const registry = new CapabilityRegistry('trust:override');
    await registry.registerDeclaration(capabilityDeclaration);
    registry.registerImplementation({ ref: fixture.writeCapability, integrity: 'test:replace', implementation: {} });
    const prepared = await prepareDatabaseAttachment({
      sourceId: 'source:attachment',
      bootstrap: { status: 'malformed' },
      outOfBandDeclaration: fixture.declaration(),
      resolveArtifact: (reference) => fixture.artifacts.get(key(reference)),
      registry
    });
    expect(prepared).toMatchObject({ state: 'ready', origin: 'out-of-band', writable: false, issues: [{ code: 'artifact.invalid_envelope' }] });
  });

  it('does not attach when the exact schema or mapping cannot be prepared', async () => {
    const fixture = await fixtures();
    const prepared = await prepareDatabaseAttachment({
      sourceId: 'source:attachment', bootstrap: { status: 'ready', declaration: fixture.declaration() },
      resolveArtifact: () => undefined, registry: new CapabilityRegistry('trust:missing')
    });
    expect(prepared).toMatchObject({ state: 'unavailable', issues: [{ code: 'artifact.dependency_mismatch' }] });
  });
});

const ref = (artifact: Artifact): ArtifactRef => ({ id: artifact.id, contentHash: artifact.contentHash });
const key = (reference: ArtifactRef): string => reference.id + '\u0000' + reference.contentHash;
