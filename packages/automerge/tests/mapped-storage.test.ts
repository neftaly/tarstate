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

type LinkDoc = {
  links: { id?: string; name: string }[];
};

type TreePiece = {
  name: string;
  children: TreePiece[];
};

type TreeDoc = {
  children: TreePiece[];
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
          title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } },
          priority: { path: ['nested', 'priority'], write: { replace: builtInCapabilityRefs.fieldReplace } },
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
          content: { path: ['content'], write: { replace: builtInCapabilityRefs.fieldReplace } },
          mimeType: mimeTypeAbsent
            ? { kind: 'absent' }
            : { path: ['mimeType'], write: {} }
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
          content: { path: ['content'], write: {} }
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

const arrayFixture = async (identity: 'source' | 'field') => {
  const registry = new CapabilityRegistry(`registry:array:${identity}`);
  await registerBuiltInCapabilities(registry);
  registry.registerImplementation({
    ref: builtInCapabilityRefs.fieldReplace,
    integrity: 'builtin:test',
    implementation: Object.freeze({ kind: 'field-replace' })
  });
  const schemaArtifact = await sealSchema({ id: `urn:test:array-schema:${identity}`, body: {
    relations: { links: {
      relationId: 'relation:links',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        name: { type: { kind: 'string' } },
        order: { type: { kind: 'integer' }, optional: true }
      }
    } }
  } });
  const schemaRef = { id: schemaArtifact.id, contentHash: schemaArtifact.contentHash };
  const schema = prepareSchema(schemaArtifact.body, registry);
  if (!schema.success) throw new Error('array schema fixture failed');
  const body: StorageMappingBody = {
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: { 'relation:links': {
      collection: { kind: 'array', path: ['links'], absent: 'creatable' },
      keys: {
        id: identity === 'source'
          ? { kind: 'source-metadata', value: 'collection-element-identity' }
          : { kind: 'field', path: ['id'] }
      },
      fields: {
        name: { path: ['name'], write: { replace: builtInCapabilityRefs.fieldReplace } },
        order: identity === 'source'
          ? { kind: 'source-metadata', value: 'collection-position' }
          : { kind: 'absent' }
      }
    } }
  };
  const compiled = compileStorageMapping(body, schemaRef, schema.value, registry);
  if (!compiled.success) throw new Error('array mapping fixture failed');
  const doc = identity === 'source'
    ? { links: [{ name: 'First' }, { name: 'Second' }] }
    : { links: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }] };
  const runtime = new AutomergeSourceRuntime<LinkDoc>({
    sourceId: `source:array:${identity}`,
    doc: Automerge.from<LinkDoc>(doc)
  });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:mapped' });
  const binding = new AutomergeMappedStorageBinding<LinkDoc>({
    id: `binding:array:${identity}`,
    mapping: compiled.value,
    registry
  });
  return { runtime, source, binding };
};

const recursiveArrayFixture = async () => {
  const registry = new CapabilityRegistry('registry:recursive-array');
  await registerBuiltInCapabilities(registry);
  registry.registerImplementation({
    ref: builtInCapabilityRefs.fieldReplace,
    integrity: 'builtin:test',
    implementation: Object.freeze({ kind: 'field-replace' })
  });
  const schemaArtifact = await sealSchema({
    id: 'urn:test:recursive-array-schema',
    body: {
      relations: {
        pieces: {
          relationId: 'relation:pieces',
          key: ['occurrenceId'],
          fields: {
            occurrenceId: { type: { kind: 'string' } },
            parentOccurrenceId: {
              type: { kind: 'string' },
              nullable: true
            },
            order: { type: { kind: 'integer' } },
            name: { type: { kind: 'string' } }
          }
        }
      }
    }
  });
  const schemaRef = {
    id: schemaArtifact.id,
    contentHash: schemaArtifact.contentHash
  };
  const schema = prepareSchema(schemaArtifact.body, registry);
  if (!schema.success) throw new Error('recursive array schema fixture failed');
  const body: StorageMappingBody = {
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: {
      'relation:pieces': {
        collection: {
          kind: 'recursive-array',
          path: ['children'],
          descendants: ['children'],
          absent: 'invalid',
          maxDepth: 8,
          maxRows: 64,
          maxTraversalSteps: 256
        },
        keys: {
          occurrenceId: {
            kind: 'source-metadata',
            value: 'collection-element-identity'
          }
        },
        fields: {
          parentOccurrenceId: {
            kind: 'source-metadata',
            value: 'recursive-parent-element-identity'
          },
          order: { kind: 'source-metadata', value: 'collection-position' },
          name: {
            path: ['name'],
            write: { replace: builtInCapabilityRefs.fieldReplace }
          }
        }
      }
    }
  };
  const compiled = compileStorageMapping(
    body,
    schemaRef,
    schema.value,
    registry
  );
  if (!compiled.success) throw new Error('recursive array mapping failed');
  const runtime = new AutomergeSourceRuntime<TreeDoc>({
    sourceId: 'source:recursive-array',
    doc: Automerge.from<TreeDoc>({
      children: [{
        name: 'Root',
        children: [{
          name: 'Child',
          children: [{ name: 'Grandchild', children: [] }]
        }]
      }, {
        name: 'Sibling',
        children: []
      }]
    })
  });
  const source = new AutomergeAtomicSource({
    runtime,
    operationEpoch: 'epoch:mapped'
  });
  const binding = new AutomergeMappedStorageBinding<TreeDoc>({
    id: 'binding:recursive-array',
    mapping: compiled.value,
    registry
  });
  return { runtime, source, binding };
};

const commit = (basis: JsonValue, operationId: string, digit: string) => ({
  operationEpoch: 'epoch:mapped', operationId, expectedBasis: basis, intentHash: hash(digit)
});

describe('compiled-mapping-backed Automerge storage binding', () => {
  it('projects and edits recursive rows through stable Automerge identities', async () => {
    const { runtime, source, binding } = await recursiveArrayFixture();
    const initial = binding.project(source.snapshot());
    expect(initial).toMatchObject({
      completeness: 'exact',
      issues: [],
      rows: [
        {
          fields: {
            parentOccurrenceId: null,
            order: 0,
            name: 'Root'
          },
          storagePath: ['children', 0]
        },
        {
          fields: {
            order: 0,
            name: 'Child'
          },
          storagePath: ['children', 0, 'children', 0]
        },
        {
          fields: {
            order: 0,
            name: 'Grandchild'
          },
          storagePath: [
            'children',
            0,
            'children',
            0,
            'children',
            0
          ]
        },
        {
          fields: {
            parentOccurrenceId: null,
            order: 1,
            name: 'Sibling'
          },
          storagePath: ['children', 1]
        }
      ]
    });
    const root = initial.rows[0]!;
    const child = initial.rows[1]!;
    const grandchild = initial.rows[2]!;
    expect(child.fields.parentOccurrenceId).toBe(root.fields.occurrenceId);
    expect(grandchild.fields.parentOccurrenceId)
      .toBe(child.fields.occurrenceId);

    runtime.replace(Automerge.change(
      runtime.snapshot().storage,
      { time: 0 },
      (draft) => {
        draft.children.unshift({ name: 'Before', children: [] });
      }
    ));
    const beforeEdit = binding.project(source.snapshot());
    const stableRoot = beforeEdit.rows.find(({ fields }) =>
      fields.name === 'Root');
    const previousGrandchild = beforeEdit.rows.find(({ fields }) =>
      fields.name === 'Grandchild');
    if (stableRoot === undefined || previousGrandchild === undefined) {
      throw new Error('recursive rows missing before edit');
    }
    const replaced = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'replace-fields',
        relationId: grandchild.relationId,
        key: grandchild.key as JsonValue,
        locator: grandchild.locator as unknown as JsonValue,
        fields: { name: 'Changed' }
      }],
      commit: commit(
        source.snapshot().basis as JsonValue,
        'operation:recursive-array-edit',
        'a'
      )
    });
    expect(replaced.outcome).toBe('committed');
    expect(runtime.snapshot().storage.children[1]?.children[0]?.children[0]?.name)
      .toBe('Changed');

    const shifted = binding.project(source.snapshot());
    expect(shifted.rows.find(({ key }) => key[0] === stableRoot.key[0]))
      .toBe(stableRoot);
    expect(shifted.rows.find(({ key }) =>
      key[0] === previousGrandchild.key[0])).not.toBe(previousGrandchild);
    const currentChild = shifted.rows.find(({ key }) =>
      key[0] === child.key[0]);
    if (currentChild === undefined) throw new Error('shifted child missing');
    const deleted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'delete',
        relationId: currentChild.relationId,
        key: currentChild.key as JsonValue,
        locator: currentChild.locator as unknown as JsonValue
      }],
      commit: commit(
        source.snapshot().basis as JsonValue,
        'operation:recursive-array-delete',
        'b'
      )
    });
    expect(deleted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.children[1]?.children).toEqual([]);
    source.close();
  });

  it('projects stable source identity and retargets an edit after array positions shift', async () => {
    const { runtime, source, binding } = await arrayFixture('source');
    const initial = binding.project(source.snapshot());
    expect(initial).toMatchObject({
      completeness: 'exact',
      rows: [
        { fields: { name: 'First', order: 0 } },
        { fields: { name: 'Second', order: 1 } }
      ]
    });
    const second = initial.rows[1]!;
    const occurrenceId = second.key[0];
    runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => {
      draft.links.unshift({ name: 'Before' });
    }));
    const shifted = binding.project(source.snapshot());
    expect(shifted.rows.find(({ key }) => key[0] === occurrenceId)).toMatchObject({
      fields: { name: 'Second', order: 2 }
    });

    const replaced = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'replace-fields',
        relationId: second.relationId,
        key: second.key as JsonValue,
        locator: second.locator as unknown as JsonValue,
        fields: { name: 'Changed' }
      }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:shifted-array-edit', '8')
    });
    expect(replaced.outcome).toBe('committed');
    expect(runtime.snapshot().storage.links.map(({ name }) => name)).toEqual(['Before', 'First', 'Changed']);
    source.close();
  });

  it('inserts and deletes explicitly keyed array rows through the ordinary binding path', async () => {
    const { runtime, source, binding } = await arrayFixture('field');
    const inserted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'insert', relationId: 'relation:links', key: ['third'], fields: { name: 'Third' } }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:array-insert', '7')
    });
    expect(inserted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.links.at(-1)).toEqual({ id: 'third', name: 'Third' });

    await expect(coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'insert', relationId: 'relation:links', key: ['third'], fields: { name: 'Duplicate' } }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:duplicate-array-insert', '5')
    })).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.upsert_conflict' }] });

    const third = binding.project(source.snapshot()).rows.find(({ key }) => key[0] === 'third')!;
    const deleted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'delete', relationId: third.relationId, key: third.key as JsonValue, locator: third.locator as unknown as JsonValue }],
      commit: commit(source.snapshot().basis as JsonValue, 'operation:array-delete', '6')
    });
    expect(deleted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.links.map(({ id }) => id)).toEqual(['first', 'second']);
    source.close();
  });

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
    expect(binding.project(
      source.snapshot(),
      new Set(['relation:file']),
      new Map([['relation:file', new Set(['mimeType'])]])
    )).toMatchObject({
      completeness: 'exact',
      rows: [{ fields: { id: 'content', mimeType: 'application/octet-stream' } }],
      issues: []
    });
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
