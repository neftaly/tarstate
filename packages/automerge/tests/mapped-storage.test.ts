import * as Automerge from '@automerge/automerge';
import {
  CapabilityRegistry,
  builtInCapabilityRefs,
  registerBuiltInCapabilities
} from '@tarstate/core/capabilities';
import {
  compileStorageMapping,
  prepareSchema,
  relationLiteral,
  sealSchema,
  sealStorageMapping,
  type StorageMappingBody
} from '@tarstate/core/schema';
import {
  coordinateSourceCommit,
  type WritableLogicalState
} from '@tarstate/core/transactions';
import {
  createAttachmentTransactionService,
  prepareDatabaseAttachment
} from '@tarstate/core/attachment/adapter';
import type { DatabaseTransactionSnapshot } from '@tarstate/core/transactions';
import type { JsonValue } from '@tarstate/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeAtomicSource
} from '../src/adapter/atomic-source.js';
import { AutomergeMappedStorageBinding } from '../src/adapter/mapped-storage.js';
import { AutomergeSourceRuntime } from '../src/source/runtime.js';

type TaskDoc = {
  tasks?: Record<string, {
    id: string;
    title?: string;
    nested?: { priority: number };
    inactiveContent?: string;
    unknown?: { keep: boolean };
  }>;
};

type FileDoc = {
  '@patchpit': { type: string; revision: number };
  content: Uint8Array;
  mimeType?: string;
};

type ForeignTextFileDoc = {
  '@patchwork': { type: string };
  content: Automerge.ImmutableString;
};

const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;

const fixture = async (doc: TaskDoc = {
  tasks: { first: { id: 'first', title: 'First', nested: { priority: 1 }, unknown: { keep: true } } }
}, absent: 'invalid' | 'creatable' = 'invalid') => {
  const registry = new CapabilityRegistry('registry:mapped');
  await registerBuiltInCapabilities(registry);
  registry.registerImplementation({
    ref: builtInCapabilityRefs.fieldReplace,
    integrity: 'builtin:test',
    implementation: Object.freeze({ kind: 'field-replace' })
  });
  const schemaArtifact = await sealSchema({ id: 'urn:test:mapped-schema', body: {
    relations: {
      tasks: {
        relationId: 'relation:tasks', key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' } },
          priority: { type: { kind: 'number' } },
          inactiveContent: { type: { kind: 'string' }, optional: true }
        }
      }
    }
  } });
  const schemaRef = { id: schemaArtifact.id, contentHash: schemaArtifact.contentHash };
  const schema = prepareSchema(schemaArtifact.body, registry);
  if (!schema.success) throw new Error('schema fixture failed');
  const body: StorageMappingBody = {
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: {
      'relation:tasks': {
        collection: { kind: 'object-map', path: ['tasks'], absent },
        keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
        fields: {
          title: { path: ['title'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } },
          priority: { path: ['nested', 'priority'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } },
          inactiveContent: { kind: 'absent' }
        }
      }
    }
  };
  const mappingArtifact = await sealStorageMapping({ id: 'urn:test:mapped-mapping', body });
  const compiled = compileStorageMapping(body, schemaRef, schema.value, registry);
  if (!compiled.success) {
    throw new Error('mapping fixture failed: ' + compiled.issues.map(({ code, path }) => `${code}:${JSON.stringify(path)}`).join(','));
  }
  const runtime = new AutomergeSourceRuntime({ sourceId: 'source:mapped', doc: Automerge.from<TaskDoc>(doc) });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:mapped' });
  const binding = new AutomergeMappedStorageBinding<TaskDoc>({ id: 'binding:mapped', mapping: compiled.value, registry });
  return { runtime, source, binding, registry, schemaArtifact, mappingArtifact };
};

const singletonFixture = async (mimeTypeAbsent = false) => {
  const registry = new CapabilityRegistry('registry:singleton');
  await registerBuiltInCapabilities(registry);
  registry.registerImplementation({
    ref: builtInCapabilityRefs.fieldReplace,
    integrity: 'builtin:test',
    implementation: Object.freeze({ kind: 'field-replace' })
  });
  const schemaArtifact = await sealSchema({ id: 'urn:test:file-schema', body: {
    relations: {
      file: {
        relationId: 'relation:file',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string', values: ['content'] } },
          content: { type: { kind: 'bytes' } },
          mimeType: { type: { kind: 'string' }, optional: true }
        }
      }
    }
  } });
  const schemaRef = { id: schemaArtifact.id, contentHash: schemaArtifact.contentHash };
  const schema = prepareSchema(schemaArtifact.body, registry);
  if (!schema.success) throw new Error('singleton schema fixture failed');
  const body: StorageMappingBody = {
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: {
      'relation:file': {
        collection: { kind: 'singleton', path: [], absent: 'invalid' },
        keys: { id: { kind: 'literal', value: 'content' } },
        fields: {
          content: { path: ['content'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } },
          mimeType: mimeTypeAbsent
            ? { kind: 'absent' }
            : { path: ['mimeType'], write: { kind: 'read-only' } }
        }
      }
    }
  };
  const compiled = compileStorageMapping(body, schemaRef, schema.value, registry);
  if (!compiled.success) throw new Error('singleton mapping fixture failed');
  const runtime = new AutomergeSourceRuntime<FileDoc>({
    sourceId: 'source:file',
    doc: Automerge.from<FileDoc>({
      '@patchpit': { type: 'file-content', revision: 1 },
      content: new Uint8Array([1, 2, 255]),
      mimeType: 'application/octet-stream'
    })
  });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:mapped' });
  const binding = new AutomergeMappedStorageBinding<FileDoc>({ id: 'binding:file', mapping: compiled.value, registry });
  return { runtime, source, binding };
};

const immutableTextSingletonFixture = async () => {
  const registry = new CapabilityRegistry('registry:immutable-text-singleton');
  await registerBuiltInCapabilities(registry);
  const schemaArtifact = await sealSchema({ id: 'urn:test:immutable-text-file-schema', body: {
    relations: {
      file: {
        relationId: 'relation:immutable-text-file',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string', values: ['content'] } },
          content: { type: { kind: 'string' } }
        }
      }
    }
  } });
  const schemaRef = { id: schemaArtifact.id, contentHash: schemaArtifact.contentHash };
  const schema = prepareSchema(schemaArtifact.body, registry);
  if (!schema.success) throw new Error('immutable text singleton schema fixture failed');
  const body: StorageMappingBody = {
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: {
      'relation:immutable-text-file': {
        collection: { kind: 'singleton', path: [], absent: 'invalid' },
        keys: { id: { kind: 'literal', value: 'content' } },
        fields: {
          content: { path: ['content'], write: { kind: 'read-only' } }
        }
      }
    }
  };
  const compiled = compileStorageMapping(body, schemaRef, schema.value, registry);
  if (!compiled.success) throw new Error('immutable text singleton mapping fixture failed');
  const runtime = new AutomergeSourceRuntime<ForeignTextFileDoc>({
    sourceId: 'source:immutable-text-file',
    doc: Automerge.from<ForeignTextFileDoc>({
      '@patchwork': { type: 'file' },
      content: new Automerge.ImmutableString('Collaborative text')
    })
  });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:mapped' });
  const binding = new AutomergeMappedStorageBinding<ForeignTextFileDoc>({
    id: 'binding:immutable-text-file',
    mapping: compiled.value,
    registry
  });
  return { runtime, source, binding };
};

const commit = (basis: JsonValue, operationId: string, digit: string) => ({
  operationEpoch: 'epoch:mapped', operationId, expectedBasis: basis, intentHash: hash(digit)
});

describe('compiled-mapping-backed Automerge storage binding', () => {
  it('reads a foreign immutable string as logical text without making it writable', async () => {
    const { source, binding } = await immutableTextSingletonFixture();
    const projection = binding.project(source.snapshot());
    expect(projection).toMatchObject({
      completeness: 'exact',
      rows: [{
        relationId: 'relation:immutable-text-file',
        key: ['content'],
        fields: { id: 'content', content: 'Collaborative text' },
        storagePath: []
      }]
    });
    expect(binding.declaredWriteFootprint.entries).toEqual([]);

    const row = projection.rows[0]!;
    const replaced = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'replace-fields',
        relationId: row.relationId,
        key: row.key as JsonValue,
        locator: row.locator as unknown as JsonValue,
        fields: { content: 'Changed' }
      }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:replace-immutable-text', 'd')
    });
    expect(replaced).toMatchObject({ outcome: 'rejected', issues: [{ code: 'mapping.field_read_only' }] });
    source.close();
  });

  it('projects and replaces native bytes through a durable root singleton without touching metadata', async () => {
    const { runtime, source, binding } = await singletonFixture();
    const projection = binding.project(source.snapshot());
    expect(projection).toMatchObject({
      completeness: 'exact',
      rows: [{
        relationId: 'relation:file',
        key: ['content'],
        fields: {
          id: 'content',
          content: { kind: 'tarstate.value', type: 'bytes', value: 'AQL_' },
          mimeType: 'application/octet-stream'
        },
        storagePath: []
      }]
    });
    expect(binding.declaredReadFootprint.entries).toEqual(expect.arrayContaining([
      { scope: 'subtree', path: ['content'] },
      { scope: 'subtree', path: ['mimeType'] }
    ]));

    runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => {
      draft['@patchpit'].revision = 2;
    }));
    expect(binding.project(source.snapshot())).toBe(projection);

    const row = projection.rows[0]!;
    const replaced = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'replace-fields',
        relationId: row.relationId,
        key: row.key as JsonValue,
        locator: row.locator as unknown as JsonValue,
        fields: { content: { kind: 'tarstate.value', type: 'bytes', value: '_wA' } }
      }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:replace-bytes', 'e')
    });
    expect(replaced.outcome).toBe('committed');
    expect([...runtime.snapshot().storage.content]).toEqual([255, 0]);
    expect(runtime.snapshot().storage['@patchpit']).toEqual({ type: 'file-content', revision: 2 });

    const current = binding.project(source.snapshot()).rows[0]!;
    const deleted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'delete', relationId: current.relationId, key: current.key as JsonValue, locator: current.locator as unknown as JsonValue }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:delete-singleton', 'f')
    });
    expect(deleted).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.capability_unavailable' }] });
    source.close();
  });

  it('omits intentionally absent optional fields from projection and footprints', async () => {
    const { source, binding } = await singletonFixture(true);
    const projection = binding.project(source.snapshot());
    const row = projection.rows[0]!;

    expect(row.fields).toEqual({
      id: 'content',
      content: { kind: 'tarstate.value', type: 'bytes', value: 'AQL_' }
    });
    expect(binding.declaredReadFootprint.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['mimeType'] })
    ]));
    expect(binding.declaredWriteFootprint.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['mimeType'] })
    ]));

    await expect(coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'replace-fields',
        relationId: row.relationId,
        key: row.key as JsonValue,
        locator: row.locator as unknown as JsonValue,
        fields: { mimeType: 'text/plain' }
      }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:replace-absent', 'd')
    })).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'mapping.field_read_only' }]
    });
    await expect(coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'replace-row',
        relationId: row.relationId,
        key: row.key as JsonValue,
        locator: row.locator as unknown as JsonValue,
        fields: { ...row.fields, mimeType: 'text/plain' }
      }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:replace-row-absent', 'c')
    })).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'mapping.field_read_only' }]
    });
    source.close();
  });

  it('withholds a singleton row when its mapped root field has concurrent values', async () => {
    const { runtime, source, binding } = await singletonFixture();
    const base = runtime.snapshot().storage;
    const left = Automerge.change(Automerge.clone(base), (draft) => {
      draft.content = new Uint8Array([2]);
    });
    const right = Automerge.change(Automerge.clone(base), (draft) => {
      draft.content = new Uint8Array([3]);
    });
    runtime.replace(Automerge.merge(left, right));
    expect(binding.project(source.snapshot())).toMatchObject({
      completeness: 'unknown',
      rows: [],
      issues: [{ code: 'automerge.conflict_observed', path: ['content'] }]
    });
    source.close();
  });

  it('projects mapped nested fields and preserves unknown storage through replacements', async () => {
    const { runtime, source, binding } = await fixture();
    const projection = binding.project(source.snapshot());
    expect(projection).toMatchObject({
      completeness: 'exact',
      rows: [{ relationId: 'relation:tasks', key: ['first'], fields: { id: 'first', title: 'First', priority: 1 } }]
    });
    const row = projection.rows[0]!;
    const result = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'replace-fields', relationId: row.relationId, key: row.key as JsonValue, locator: row.locator as unknown as JsonValue, fields: { title: 'Changed', priority: 2 } }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:replace', 'b')
    });
    expect(result.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks!.first).toMatchObject({
      id: 'first', title: 'Changed', nested: { priority: 2 }, unknown: { keep: true }
    });
    source.close();
  });

  it('round-trips mapped inserts and deletes', async () => {
    const { runtime, source, binding } = await fixture();
    const inserted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'insert', relationId: 'relation:tasks', key: ['second'], fields: { title: 'Second', priority: 3 } }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:insert', 'c')
    });
    expect(inserted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks!.second).toEqual({ id: 'second', title: 'Second', nested: { priority: 3 } });
    const projection = binding.project(source.snapshot());
    const second = projection.rows.find(({ key }) => key[0] === 'second')!;
    const deleted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'delete', relationId: second.relationId, key: second.key as JsonValue, locator: second.locator as unknown as JsonValue }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:delete', 'd')
    });
    expect(deleted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks).not.toHaveProperty('second');
    source.close();
  });

  it('rejects inserts that target a field absent from the physical layout', async () => {
    const { runtime, source, binding } = await fixture();
    await expect(coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'insert',
        relationId: 'relation:tasks',
        key: ['variant'],
        fields: { title: 'Variant', priority: 3, inactiveContent: 'not in this layout' }
      }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:insert-absent', '9')
    })).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'mapping.field_read_only' }]
    });
    expect(runtime.snapshot().storage.tasks).not.toHaveProperty('variant');
    source.close();
  });

  it('retains all schema issues and reports malformed candidates as incomplete', async () => {
    const { source, binding } = await fixture({ tasks: { broken: { id: 'broken' } } });
    const projection = binding.project(source.snapshot());
    expect(projection.completeness).toBe('unknown');
    expect(projection.rows).toEqual([]);
    expect(projection.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(['schema.field_missing', 'schema.field_missing']));
    expect(projection.issues.map(({ path }) => path)).toEqual(expect.arrayContaining([
      ['tasks', 'broken', 'title'],
      ['tasks', 'broken', 'priority']
    ]));
    source.close();
  });

  it('creates only a permitted final missing object-map collection', async () => {
    const { runtime, source, binding } = await fixture({}, 'creatable');
    const inserted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'insert', relationId: 'relation:tasks', key: ['created'], fields: { title: 'Created', priority: 4 } }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:create-collection', '1')
    });
    expect(inserted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks).toEqual({ created: { id: 'created', title: 'Created', nested: { priority: 4 } } });
    source.close();
  });

  it('retains every insert parse issue and performs no source handoff', async () => {
    const { source, binding } = await fixture();
    const sourceCommit = vi.spyOn(source, 'commit');
    const inserted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'insert', relationId: 'relation:tasks', key: ['incomplete'], fields: {} }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:incomplete-insert', '2')
    });
    expect(inserted).toMatchObject({ outcome: 'rejected' });
    expect(inserted.issues.filter(({ code }) => code === 'schema.field_missing')).toHaveLength(2);
    expect(sourceCommit).not.toHaveBeenCalled();
    source.close();
  });

  it('marks mapped nested property conflicts incomplete instead of selecting the visible winner', async () => {
    const { runtime, source, binding } = await fixture();
    const base = runtime.snapshot().storage;
    const left = Automerge.change(Automerge.clone(base), (draft) => { draft.tasks!.first!.nested!.priority = 2; });
    const right = Automerge.change(Automerge.clone(base), (draft) => { draft.tasks!.first!.nested!.priority = 3; });
    runtime.replace(Automerge.merge(left, right));
    const projection = binding.project(source.snapshot());
    expect(projection).toMatchObject({
      completeness: 'unknown',
      rows: [],
      issues: [{ code: 'automerge.conflict_observed', path: ['tasks', 'first', 'nested', 'priority'] }]
    });
    source.close();
  });

  it('replays a logical-row transaction after an external Automerge change', async () => {
    const { runtime, source, binding, registry, schemaArtifact, mappingArtifact } = await fixture();
    const preparation = await prepareDatabaseAttachment<WritableLogicalState>({
      sourceId: source.sourceId,
      bootstrap: { status: 'ready', declaration: {
        formatVersion: 1,
        storageSchema: { id: schemaArtifact.id, contentHash: schemaArtifact.contentHash },
        projection: {
          kind: 'storage-mapping',
          storageMapping: { id: mappingArtifact.id, contentHash: mappingArtifact.contentHash }
        }
      } },
      resolveArtifact: (reference) => reference.id === schemaArtifact.id ? schemaArtifact : mappingArtifact,
      registry
    });
    if (preparation.state !== 'ready') throw new Error('Expected a ready mapped attachment');
    const tasks = relationLiteral(schemaArtifact, 'tasks');
    const transactions = await createAttachmentTransactionService({
      attachmentId: 'attachment:mapped',
      attachmentIncarnation: 'attachment-incarnation:mapped',
      authorityScope: 'scope:mapped',
      preparation,
      source,
      bindings: [binding],
      registry,
      durability: 'memory'
    });
    const commitDirect = source.commit;
    const commit = vi.spyOn(source, 'commit');
    commit.mockImplementationOnce(async (input) => {
      runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => {
        draft.tasks!.first!.nested!.priority = 2;
      }));
      return commitDirect(input);
    });
    const transform = vi.fn((snapshot: DatabaseTransactionSnapshot) => snapshot.withRows(
      tasks,
      snapshot.rows(tasks).map((row) => ({ ...row, title: 'Final' }))
    ));
    const receipt = await transactions.transact(
      { kind: 'set-final-title' },
      transform
    );
    expect(receipt).toMatchObject({
      outcome: 'committed',
      statementResults: [{ logicallyChanged: 1 }]
    });
    expect(runtime.snapshot().storage.tasks!.first).toMatchObject({ title: 'Final', nested: { priority: 2 }, unknown: { keep: true } });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(transform).toHaveBeenCalledTimes(2);
    source.close();
  });
});
