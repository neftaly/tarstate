import { describe, expect, it } from 'vitest';
import { capabilityRefFor, CapabilityRegistry, type CapabilityDeclaration } from '../src/registry.js';
import { createIssue } from '../src/issues.js';
import { prepareSchema, parseRelationCandidate, parseLogicalKey, type SchemaBody } from '../src/schema.js';
import { compileStorageMapping, planStoragePatch, projectStorage, type StorageMappingBody } from '../src/mapping.js';
import { projectLensRelation, resolveLensPath, translateLensEdits, validateLens, type LensArtifact, type LensRows, type SchemaLensBody } from '../src/lens.js';
import { parseScalarValue, type CodecImplementation } from '../src/codec.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaRef = { id: 'urn:test:schema', contentHash: hash('1') };
const replaceRef = { id: 'urn:test:edit:replace', version: '1', contractHash: hash('2') };

const makeFixture = async () => {
  const codecDeclaration: CapabilityDeclaration = {
    kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:codec:upper', version: '1', class: 'codec', contract: { type: 'urn:test:upper' }, implies: []
  };
  const codecRef = await capabilityRefFor(codecDeclaration);
  const codec: CodecImplementation = {
    kind: 'tarstate.codec',
    type: 'urn:test:upper',
    decode: (input) => typeof input === 'string' && /^[A-Z]+$/.test(input)
      ? { success: true, value: { kind: 'tarstate.value', type: 'urn:test:upper', value: input }, issues: [] }
      : { success: false, issues: [createIssue({ code: 'test.upper_invalid', phase: 'parse', severity: 'error', retry: 'after_input' })] },
    equals: (left, right) => left.value === right.value,
    hash: (value) => JSON.stringify(value.value)
  };
  const registry = new CapabilityRegistry('test');
  const registered = await registry.registerDeclaration(codecDeclaration);
  if (!registered.success) throw new Error('codec declaration failed');
  registry.registerImplementation({ ref: codecRef, integrity: 'test:upper:1', implementation: codec });

  const body: SchemaBody = {
    requiredCodecs: [codecRef],
    relations: {
      users: {
        relationId: 'test.user', key: ['id'], fields: {
          id: { type: { kind: 'string' } },
          nickname: { type: { kind: 'string' }, optional: true, nullable: true },
          code: { type: { kind: 'custom', codec: codecRef } }
        }
      },
      notes: {
        relationId: 'test.note', key: ['id'], fields: {
          id: { type: { kind: 'string' } }, body: { type: { kind: 'string' }, optional: true }
        }
      },
      refs: {
        relationId: 'test.ref', key: ['id'], fields: {
          id: { type: { kind: 'string' } }, user: { type: { kind: 'ref', target: { relationId: 'test.user' } } }
        }
      }
    }
  };
  const prepared = prepareSchema(body, registry);
  if (!prepared.success) throw new Error('schema failed: ' + prepared.issues.map((issue) => issue.code).join(','));
  return { codecRef, registry, schema: prepared.value };
};

describe('production schemas and codecs', () => {
  it('rejects unknown and incomplete schema declaration members at preparation', () => {
    expect(prepareSchema({ relations: {}, ambientAuthority: true })).toMatchObject({ success: false });
    expect(prepareSchema({ relations: { people: { relationId: 'test.person', key: ['id'], fields: { id: { type: { kind: 'string', ambient: true } } } } } }))
      .toMatchObject({ success: false });
    expect(prepareSchema({ relations: { people: { relationId: 'test.person', key: ['id'], fields: { id: { type: { kind: 'instant' } } } } } }))
      .toMatchObject({ success: false });
    expect(prepareSchema({ relations: { people: { relationId: 'test.person', key: ['id'], fields: { id: null } } } }))
      .toMatchObject({ success: false, issues: [{ code: 'schema.field_invalid' }] });
  });
  it('keeps missing and null distinct, enforces exact ref/key arity, and reports codec failure', async () => {
    const { registry, schema } = await makeFixture();
    expect(parseRelationCandidate(schema, 'test.user', { id: 'a', code: 'OK' }, registry)).toMatchObject({ success: true, value: { row: { id: 'a', code: { type: 'urn:test:upper' } } } });
    expect(parseRelationCandidate(schema, 'test.user', { id: 'a', nickname: null, code: 'OK' }, registry)).toMatchObject({ success: true, value: { row: { nickname: null } } });
    expect(parseRelationCandidate(schema, 'test.user', { id: 'a', code: 'lower' }, registry)).toMatchObject({ success: false, issues: [{ code: 'test.upper_invalid', path: ['code'] }] });
    expect(parseRelationCandidate(schema, 'test.ref', { id: 'r', user: 'a' }, registry)).toMatchObject({ success: false, issues: [{ code: 'schema.ref_arity' }] });
    expect(parseRelationCandidate(schema, 'test.ref', { id: 'r', user: ['a'] }, registry)).toMatchObject({ success: true });
    expect(parseLogicalKey(schema, 'test.user', 'a', registry)).toMatchObject({ success: false, issues: [{ code: 'schema.key_arity' }] });
    expect(parseLogicalKey(schema, 'test.user', ['a'], registry)).toMatchObject({ success: true, value: ['a'] });
  });

  it('turns a throwing custom codec into a structured issue', async () => {
    const { codecRef } = await makeFixture();
    const declaration: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: codecRef.id, version: codecRef.version, class: 'codec', contract: { type: 'urn:test:upper' }, implies: [] };
    const registry = new CapabilityRegistry('throwing');
    const actualRef = await capabilityRefFor(declaration);
    await registry.registerDeclaration(declaration);
    registry.registerImplementation({ ref: actualRef, integrity: 'throwing', implementation: { kind: 'tarstate.codec', type: 'urn:test:upper', decode: () => { throw new Error('bad host codec'); }, equals: () => false, hash: () => '' } satisfies CodecImplementation });
    const schema = prepareSchema({ relations: { values: { relationId: 'test.value', key: ['value'], fields: { value: { type: { kind: 'custom', codec: actualRef } } } } }, requiredCodecs: [actualRef] }, registry);
    if (!schema.success) throw new Error('schema failed');
    expect(parseRelationCandidate(schema.value, 'test.value', { value: 'ANY' }, registry)).toMatchObject({ success: false, issues: [{ code: 'schema.codec_failed', details: { reason: 'threw' } }] });
  });

  it('detaches successful custom codec output from host-owned state', async () => {
    const declaration: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:codec:owned', version: '1', class: 'codec', contract: { type: 'urn:test:owned' }, implies: [] };
    const ref = await capabilityRefFor(declaration);
    const registry = new CapabilityRegistry('owned-codec');
    await registry.registerDeclaration(declaration);
    const decoded = { kind: 'tarstate.value' as const, type: 'urn:test:owned', value: { state: 'before' } };
    registry.registerImplementation({
      ref,
      integrity: 'owned',
      implementation: { kind: 'tarstate.codec', type: 'urn:test:owned', decode: () => ({ success: true, value: decoded, issues: [] }), equals: () => false, hash: () => '' } satisfies CodecImplementation
    });

    const parsed = parseScalarValue({ kind: 'custom', codec: ref }, 'input', { registry });
    if (!parsed.success) throw new Error('codec parse failed');
    decoded.value.state = 'after';

    expect(parsed.value).toEqual({ kind: 'tarstate.value', type: 'urn:test:owned', value: { state: 'before' } });
  });

  it('owns prepared declarations and exposes lookup maps that cannot be mutated at runtime', () => {
    const input = {
      relations: {
        items: {
          relationId: 'test.item',
          key: ['id'],
          fields: {
            id: { type: { kind: 'string' } },
            state: { type: { kind: 'string', values: ['open'] } }
          }
        }
      }
    };
    const prepared = prepareSchema(input);
    if (!prepared.success) throw new Error('schema failed');

    input.relations.items.relationId = 'test.changed';
    input.relations.items.key.push('state');
    input.relations.items.fields.state.type.values.push('closed');

    expect(prepared.value.body.relations.items).toMatchObject({ relationId: 'test.item', key: ['id'] });
    expect(prepared.value.relationsById.has('test.changed')).toBe(false);
    expect(prepared.value.relationsById.get('test.item')?.declaration.fields.state?.type).toEqual({ kind: 'string', values: ['open'] });
    expect(Object.isFrozen(prepared.value)).toBe(true);
    expect(Object.isFrozen(prepared.value.body.relations.items)).toBe(true);
    expect(Object.isFrozen(prepared.value.relationsById.get('test.item')?.keyFields)).toBe(true);

    expect(() => (prepared.value.relationsById as Map<string, unknown>).set('test.changed', {})).toThrow();
    expect(() => Map.prototype.set.call(prepared.value.relationsById, 'test.changed', {})).toThrow();
    expect(() => { Object.getPrototypeOf(prepared.value.relationsById).get = () => undefined; }).toThrow();
    expect(prepared.value.relationsById.has('test.changed')).toBe(false);

    let callbackMap: ReadonlyMap<string, unknown> | undefined;
    prepared.value.relationsById.forEach((_value, _key, map) => { callbackMap = map; });
    expect(callbackMap).toBe(prepared.value.relationsById);
  });

  it('rejects hostile schema input before adopting it', () => {
    expect(prepareSchema(Object.create(null))).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
  });
});

describe('production JSON-tree storage mappings', () => {
  it('rejects map-key mismatch, retains duplicate candidates for repair, and preserves unknown storage on edit', async () => {
    const { registry, schema } = await makeFixture();
    const mapping: StorageMappingBody = {
      schema: schemaRef,
      model: 'json-tree-v1',
      relations: {
        'test.user': {
          collection: { kind: 'object-map', path: ['users'], absent: 'invalid' },
          keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
          fields: {
            nickname: { path: ['profile', 'nickname'], write: { kind: 'replace', capability: replaceRef } },
            code: { path: ['code'], write: { kind: 'read-only' } }
          }
        },
        'test.note': {
          collection: { kind: 'array', path: ['notes'], absent: 'empty' },
          keys: { id: { kind: 'field', path: ['id'] } },
          fields: { body: { path: ['body'], write: { kind: 'read-only' } } }
        }
      }
    };
    const compiled = compileStorageMapping(mapping, schemaRef, schema);
    if (!compiled.success) throw new Error('mapping failed: ' + compiled.issues.map((issue) => issue.code).join(','));
    const snapshot = {
      users: {
        alice: { id: 'alice', profile: { nickname: null, color: 'blue' }, code: 'OK', serverOnly: { retained: true } },
        bob: { id: 'wrong-id', profile: {}, code: 'OK' }
      },
      notes: [{ id: 'duplicate', body: 'one' }, { id: 'duplicate', body: 'two' }],
      rootUnknown: true
    };
    const projection = projectStorage(compiled.value, snapshot, registry, 'source:test');
    expect(projection.relations.get('test.user')?.rows).toMatchObject([{ row: { id: 'alice', nickname: null, code: { type: 'urn:test:upper' } } }]);
    expect(projection.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'mapping.map_key_mismatch' }), expect.objectContaining({ code: 'schema.duplicate_key' })]));
    expect(projection.relations.get('test.note')?.rows).toHaveLength(2);
    expect(projection.relations.get('test.note')?.completeness).toBe('unknown');
    expect(projection.completeness).toBe('unknown');

    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('inspection failed'); } });
    const hostileProjection = projectStorage(compiled.value, hostile, registry, 'source:test');
    expect(hostileProjection.completeness).toBe('unknown');
    expect(hostileProjection.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'mapping.collection_invalid', details: { reason: 'inspection_failed', error: 'Error' } })]));

    let getterCalls = 0;
    const hostileNotes: unknown[] = [];
    Object.defineProperty(hostileNotes, 0, { enumerable: true, get: () => { getterCalls += 1; return { id: 'n' }; } });
    hostileNotes.length = 1;
    expect(projectStorage(compiled.value, { users: {}, notes: hostileNotes }, registry).relations.get('test.note'))
      .toMatchObject({ completeness: 'unknown', issues: [{ code: 'mapping.collection_invalid', details: { reason: 'descriptor' } }] });
    expect(getterCalls).toBe(0);

    const plan = planStoragePatch(compiled.value, snapshot, 'test.user', { kind: 'object-map-key', key: 'alice' }, { nickname: 'Al' }, undefined, 'source:test');
    expect(plan).toMatchObject({ success: true, value: { intents: [{ path: ['users', 'alice', 'profile', 'nickname'] }] } });
    if (!plan.success) throw new Error('plan failed');
    expect(plan.value.nextSnapshot).toEqual({
      ...snapshot,
      users: { ...snapshot.users, alice: { ...snapshot.users.alice, profile: { nickname: 'Al', color: 'blue' } } }
    });

    const hostileSibling = Object.defineProperty({ users: snapshot.users, notes: snapshot.notes }, 'ambient', {
      enumerable: true,
      get: () => { getterCalls += 1; return 'authority'; }
    });
    expect(planStoragePatch(compiled.value, hostileSibling, 'test.user', { kind: 'object-map-key', key: 'alice' }, { nickname: 'Al' }))
      .toMatchObject({ success: false, issues: [{ code: 'mapping.path_invalid', details: { reason: 'descriptor' } }] });
    expect(getterCalls).toBe(0);
  });

  it('owns compiled mapping paths and prevents mutation of the compiled relation lookup', async () => {
    const { schema } = await makeFixture();
    const input = {
      schema: { ...schemaRef },
      model: 'json-tree-v1',
      relations: {
        'test.note': {
          collection: { kind: 'array', path: ['notes'], absent: 'empty' },
          keys: { id: { kind: 'field', path: ['id'] } },
          fields: { body: { path: ['body'], write: { kind: 'read-only' } } }
        }
      }
    };
    const compiled = compileStorageMapping(input, schemaRef, schema);
    if (!compiled.success) throw new Error('mapping failed');

    input.relations['test.note'].collection.path[0] = 'changed';
    input.relations['test.note'].fields.body.path[0] = 'changed';

    expect(compiled.value.body.relations['test.note']?.collection.path).toEqual(['notes']);
    expect(projectStorage(compiled.value, { notes: [{ id: 'n', body: 'kept' }] }).relations.get('test.note')?.rows)
      .toMatchObject([{ row: { id: 'n', body: 'kept' } }]);
    expect(Object.isFrozen(compiled.value)).toBe(true);
    expect(Object.isFrozen(compiled.value.body.relations['test.note']?.collection.path)).toBe(true);
    expect(() => (compiled.value.relations as Map<string, unknown>).clear()).toThrow();
    expect(() => Map.prototype.set.call(compiled.value.relations, 'test.changed', {})).toThrow();
    expect(compiled.value.relations.has('test.changed')).toBe(false);
  });

  it('rejects hostile mapping input before adopting it', async () => {
    const { schema } = await makeFixture();
    expect(compileStorageMapping(Object.create(null), schemaRef, schema)).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
  });
});

describe('production schema lenses', () => {
  const from = { id: 'urn:test:schema:stored', contentHash: hash('3') };
  const to = { id: 'urn:test:schema:view', contentHash: hash('4') };
  const body: SchemaLensBody = {
    from,
    to,
    relations: [
      {
        fromRelationId: 'test.task', toRelationId: 'test.task', steps: [
          { kind: 'lens.field', from: 'slug', to: 'id', write: 'invertible' },
          { kind: 'lens.field', from: 'name', to: 'title', write: 'invertible' },
          { kind: 'lens.value-map', from: 'state', to: 'status', unmapped: 'reject', cases: [{ from: 'open', to: 'active', writeBack: 'to-from' }] },
          { kind: 'lens.hide', from: 'serverOnly', write: 'preserve' }
        ]
      },
      {
        fromRelationId: 'test.comment', toRelationId: 'test.comment', steps: [
          { kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' },
          { kind: 'lens.lookup', from: 'taskPair', to: 'taskSlug', through: { schemaView: from, relationId: 'test.task' }, sourceFields: ['slug', 'state'], resultFields: ['slug'], onMissing: 'reject', onAmbiguous: 'reject', write: 'invertible' }
        ]
      }
    ]
  };

  it('rejects an unmapped candidate instead of exposing partial exact data', () => {
    const rows: LensRows = { 'test.task': [{ slug: 'a', name: 'A', state: 'open' }, { slug: 'b', name: 'B', state: 'future' }] };
    const projection = projectLensRelation(body, 'test.task', rows);
    expect(projection.rows).toEqual([{ id: 'a', title: 'A', status: 'active' }]);
    expect(projection.rejected).toMatchObject([{ rowIndex: 1 }]);
    expect(projection.issues).toMatchObject([{ code: 'lens.unmapped_value' }]);
    expect(projection.completeness).toBe('unknown');
  });

  it('requires exact multi-field lookup tuples and translates writes as a minimal preserving patch', () => {
    const rows: LensRows = {
      'test.task': [{ slug: 'a', name: 'A', state: 'open', serverOnly: { retained: true } }],
      'test.comment': [{ id: 'c', taskPair: 'a' }]
    };
    expect(projectLensRelation(body, 'test.comment', rows)).toMatchObject({ rows: [], rejected: [{ rowIndex: 0 }], issues: [{ code: 'lens.lookup_arity' }] });
    const translated = translateLensEdits(body, 'test.task', rows['test.task']?.[0] ?? {}, { title: 'Renamed' }, rows);
    expect(translated).toEqual({ success: true, value: { name: 'Renamed' }, issues: [] });
  });

  it('rejects ambiguous inverse derivation instead of choosing a write path by order', () => {
    const task = body.relations[0]!;
    const ambiguous: SchemaLensBody = {
      ...body,
      relations: [{
        ...task,
        steps: [...task.steps, { kind: 'lens.field', from: 'legacyName', to: 'title', write: 'invertible' }]
      }, ...body.relations.slice(1)]
    };
    expect(translateLensEdits(ambiguous, 'test.task', { name: 'A', legacyName: 'Old' }, { title: 'Renamed' }, {}))
      .toMatchObject({ success: false, issues: [{ code: 'lens.inverse_ambiguous', path: ['title'] }] });
  });

  it('resolves only a single unambiguous exact path', () => {
    expect(validateLens(body)).toMatchObject({ success: true });
    const first: LensArtifact = { ref: { id: 'urn:test:lens:first', contentHash: hash('5') }, body };
    const second: LensArtifact = { ref: { id: 'urn:test:lens:second', contentHash: hash('6') }, body };
    expect(resolveLensPath(from, to, [first])).toMatchObject({ outcome: 'resolved', path: [{ ref: first.ref }] });
    expect(resolveLensPath(from, to, [first, second])).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.path_ambiguous' }] });
    expect(resolveLensPath(from, to, [first, second], [first.ref])).toMatchObject({ outcome: 'resolved', path: [{ ref: first.ref }] });
    expect(resolveLensPath(from, to, [first], undefined, { maxVisitedNodes: 1 })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lens.path_budget_exceeded' }] });
  });

  it('owns and freezes validated lens bodies', () => {
    const input = {
      from: { ...from },
      to: { ...to },
      relations: [{
        fromRelationId: 'test.task',
        toRelationId: 'test.task',
        steps: [{
          kind: 'lens.value-map',
          from: 'state',
          to: 'status',
          cases: [{ from: 'open', to: 'active', writeBack: 'to-from' }],
          unmapped: 'reject'
        }]
      }]
    };
    const validated = validateLens(input);
    if (!validated.success) throw new Error('lens failed');

    input.to.id = 'urn:test:changed';
    input.relations[0]!.steps[0]!.to = 'changed';
    input.relations[0]!.steps[0]!.cases[0]!.to = 'changed';

    expect(validated.value.to).toEqual(to);
    expect(projectLensRelation(validated.value, 'test.task', { 'test.task': [{ state: 'open' }] }).rows)
      .toEqual([{ status: 'active' }]);
    const ownedRelation = validated.value.relations[0];
    if (ownedRelation === undefined) throw new Error('validated relation missing');
    expect(Object.isFrozen(validated.value)).toBe(true);
    expect(Object.isFrozen(ownedRelation.steps)).toBe(true);
    expect(Object.isFrozen((ownedRelation.steps[0] as { readonly cases: readonly unknown[] }).cases)).toBe(true);
  });

  it('rejects hostile lens input before adopting it', () => {
    expect(validateLens(Object.create(null))).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
  });
});
