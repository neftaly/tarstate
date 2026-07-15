import * as Automerge from '@automerge/automerge';
import {
  CapabilityRegistry,
  builtInCapabilityRefs,
  compileStorageMapping,
  coordinateSourceCommit,
  executePreparedTransaction,
  prepareWritableExecutionContext,
  prepareSchema,
  registerBuiltInCapabilities,
  sealTransaction,
  type ArtifactRef,
  type JsonValue,
  type PreparedWritableExecutionContext,
  type StorageMappingBody
} from '@tarstate/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeAtomicSource,
  AutomergeMappedStorageBinding,
  AutomergeSourceRuntime,
  type AutomergeSourceCommand
} from '../src/index.js';

type TaskDoc = {
  tasks?: Record<string, {
    id: string;
    title?: string;
    nested?: { priority: number };
    unknown?: { keep: boolean };
  }>;
};

const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;
const schemaRef: ArtifactRef = { id: 'urn:test:mapped-schema', contentHash: hash('a') };

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
  const schema = prepareSchema({
    relations: {
      tasks: {
        relationId: 'relation:tasks', key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' } },
          priority: { type: { kind: 'number' } }
        }
      }
    }
  }, registry);
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
          priority: { path: ['nested', 'priority'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } }
        }
      }
    }
  };
  const compiled = compileStorageMapping(body, schemaRef, schema.value, registry);
  if (!compiled.success) {
    throw new Error('mapping fixture failed: ' + compiled.issues.map(({ code, path }) => `${code}:${JSON.stringify(path)}`).join(','));
  }
  const runtime = new AutomergeSourceRuntime({ sourceId: 'source:mapped', doc: Automerge.from<TaskDoc>(doc) });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:mapped' });
  const binding = new AutomergeMappedStorageBinding<TaskDoc>({ id: 'binding:mapped', mapping: compiled.value, registry });
  return { runtime, source, binding };
};

const commit = (basis: JsonValue, operationId: string, digit: string) => ({
  operationEpoch: 'epoch:mapped', operationId, expectedBasis: basis, intentHash: hash(digit)
});

describe('compiled-mapping-backed Automerge storage binding', () => {
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

  it('executes ordered transaction statements through one Automerge commit', async () => {
    const { runtime, source, binding } = await fixture();
    const context: PreparedWritableExecutionContext<Automerge.Doc<TaskDoc>, AutomergeSourceCommand<TaskDoc>> = prepareWritableExecutionContext({
      attachmentId: 'attachment:mapped',
      attachmentIncarnation: 'attachment-incarnation:mapped',
      attachmentFingerprint: hash('e'),
      authorityViewFingerprint: hash('f'),
      writable: true,
      schemaView: schemaRef,
      source,
      operationEpoch: 'epoch:mapped',
      bindings: [binding],
      relationKeys: new Map([['relation:tasks', ['id']]]),
      query: {
        evaluate: (_root, state) => ({
          rows: state.rows.map(({ fields }) => fields),
          resultKeys: state.rows.map(({ key }) => JSON.stringify(key)),
          completeness: 'exact',
          issues: []
        })
      },
      durability: 'memory'
    });
    const relation = { relationId: 'relation:tasks', schemaView: schemaRef };
    const target = {
      relation,
      alias: 'task',
      where: {
        kind: 'compare' as const,
        op: 'eq' as const,
        left: { kind: 'field' as const, alias: 'task', name: 'id' },
        right: { kind: 'literal' as const, value: 'first' }
      }
    };
    const transaction = await sealTransaction({ body: {
      schemaView: schemaRef,
      parameters: {},
      statements: [
        { kind: 'statement.update', target, edits: { title: { kind: 'edit.replace', value: { kind: 'literal', value: 'Intermediate' } } } },
        { kind: 'statement.update', target, edits: { title: { kind: 'edit.replace', value: { kind: 'literal', value: 'Final' } } } }
      ],
      guards: [],
      returning: [{ name: 'tasks', root: { kind: 'values', alias: 'task', rows: [] } }],
      requiredCapabilities: []
    } });
    const receipt = await executePreparedTransaction(context, {
      operationEpoch: 'epoch:mapped',
      operationId: 'operation:transaction',
      attachmentId: 'attachment:mapped',
      transaction
    });
    expect(receipt).toMatchObject({
      outcome: 'committed',
      statementResults: [{ matched: 1, logicallyChanged: 1 }, { matched: 1, logicallyChanged: 1 }],
      returning: [{ rows: [{ id: 'first', title: 'Final', priority: 1 }] }]
    });
    expect(runtime.snapshot().storage.tasks!.first).toMatchObject({ title: 'Final', unknown: { keep: true } });
    source.close();
  });
});
