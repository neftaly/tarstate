import { describe, expect, it } from 'vitest';
import { sealArtifact, type ArtifactRef } from '../src/artifacts.js';
import type { ConstraintSetBody } from '../src/constraint-artifact.js';
import { sealSchemaLens, type SchemaLensBody } from '../src/lens.js';
import { sealStorageMapping, type StorageMappingBody } from '../src/mapping.js';
import type { QueryArtifactBody } from '../src/query-builder.js';
import { prepareSchema, sealSchema, type SchemaBody } from '../src/schema.js';
import { capabilityRefFor, CapabilityRegistry } from '../src/registry.js';
import {
  defaultSemanticArtifactParseBudget,
  parseQueryArtifact,
  safeEvaluateQueryArtifact,
  safeParseConstraintSetArtifact,
  safeParseQueryArtifact,
  safeParseSchemaLensArtifact,
  safeParseStorageMappingArtifact,
  safeParseTransactionArtifact,
  safePrepareConstraintSetArtifact,
  safePrepareQueryArtifact,
  safePrepareSchemaLensArtifact,
  safePrepareStorageMappingArtifact,
  safePrepareTransactionArtifact
} from '../src/semantic-artifact-parsers.js';
import type { TransactionBody } from '../src/transaction.js';
import type { JsonValue } from '../src/value.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaRef: ArtifactRef = { id: 'urn:test:parser:schema', contentHash: hash('a') };
const otherSchemaRef: ArtifactRef = { id: 'urn:test:parser:other-schema', contentHash: hash('b') };
const capability = { id: 'urn:test:parser:capability', version: '1', contractHash: hash('c') } as const;
const relationUse = { schemaView: schemaRef, relationId: 'test.person' } as const;
const literal = (value: JsonValue) => ({ kind: 'literal', value } as const);
const parameter = (name: string) => ({ kind: 'parameter', name } as const);
const field = (alias: string, name: string) => ({ kind: 'field', alias, name } as const);
const values = (alias = 'v') => ({ kind: 'values', alias, rows: [{ id: 1 }] } as const);

let artifactSequence = 0;
const seal = (kind: 'query' | 'transaction' | 'constraint-set' | 'storage-mapping' | 'schema-lens', body: unknown) =>
  sealArtifact({ kind, id: `urn:test:parser:${kind}:${artifactSequence++}`, body: body as JsonValue });

const queryBody = (): QueryArtifactBody => ({
  schemaViews: [schemaRef],
  parameters: {
    minimum: { kind: 'integer' },
    filters: { kind: 'record', fields: { active: { kind: 'boolean' }, tags: { kind: 'array', items: { kind: 'string' } } }, optional: ['tags'] }
  },
  root: {
    kind: 'where',
    input: { kind: 'from', relation: relationUse, alias: 'person' },
    predicate: { kind: 'compare', op: 'gte', left: field('person', 'score'), right: parameter('minimum') }
  },
  requiredCapabilities: []
});

const transactionBody = (): TransactionBody => ({
  schemaView: schemaRef,
  parameters: { name: 'Ada', amount: 2 },
  statements: [
    { kind: 'statement.insert', relation: relationUse, rows: [{ id: literal(1), name: parameter('name') }] },
    { kind: 'statement.insert-from-query', relation: relationUse, root: values('inserted') },
    { kind: 'statement.upsert', relation: relationUse, rows: [{ id: literal(2) }], onConflict: 'keep-existing' },
    { kind: 'statement.replace-all', relation: relationUse, rows: [{ id: literal(3) }] },
    {
      kind: 'statement.update',
      target: { relation: relationUse, alias: 'person', where: { kind: 'compare', op: 'eq', left: field('person', 'id'), right: literal(1) } },
      edits: {
        name: { kind: 'edit.replace', value: parameter('name') },
        count: { kind: 'edit.counter-increment', amount: parameter('amount') },
        text: { kind: 'edit.text-splice', index: literal(0), deleteCount: literal(0), insert: literal('A') },
        list: { kind: 'edit.list-splice', index: literal(0), deleteCount: literal(0), values: [literal('A')], requires: capability },
        conflict: { kind: 'edit.conflict-resolve', observed: ['old'], value: literal('new') },
        custom: { kind: 'extension', capability, payload: { action: 'custom' } }
      }
    },
    { kind: 'statement.delete', target: { relation: relationUse, alias: 'person' } },
    { kind: 'statement.rekey', target: { relation: relationUse, alias: 'person' }, key: { id: literal(4) }, references: 'reject-if-referenced', requires: capability },
    { kind: 'statement.move', target: { relation: relationUse, alias: 'person' }, parent: literal('root'), position: { kind: 'after', anchor: field('person', 'id') }, missingAnchor: 'end', requires: capability },
    { kind: 'extension', capability, payload: { operation: 'future' } }
  ],
  guards: [
    { kind: 'guard.affected-count', statementIndex: 0, count: 'inserted', op: 'gte', value: 1 },
    { kind: 'guard.query', root: values('guard'), expect: 'exists' },
    { kind: 'extension', capability, payload: { guard: true } }
  ],
  returning: [{ name: 'people', root: { kind: 'from', relation: relationUse, alias: 'person' } }],
  requiredCapabilities: [capability]
});

const constraintBody = (): ConstraintSetBody => ({
  schemaView: schemaRef,
  constraints: [
    { id: 'person-score', code: 'test.person_score', dependencyRelations: ['test.person'], violationQuery: { kind: 'where', input: { kind: 'from', relation: relationUse, alias: 'person' }, predicate: { kind: 'compare', op: 'lt', left: field('person', 'score'), right: literal(0) } } as unknown as JsonValue }
  ],
  requiredCapabilities: []
});

const mappingBody = (): StorageMappingBody => ({
  schema: schemaRef,
  model: 'json-tree-v1',
  relations: {
    'test.person': {
      collection: { kind: 'object-map', path: ['people'], absent: 'creatable' },
      keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
      fields: { name: { path: ['name'], write: { kind: 'replace', capability } } }
    }
  }
});

const lensBody = (): SchemaLensBody => ({
  from: schemaRef,
  to: otherSchemaRef,
  relations: [{
    fromRelationId: 'test.person',
    toRelationId: 'test.person.view',
    steps: [
      { kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' },
      { kind: 'lens.default', to: 'enabled', value: true, write: 'preserve' },
      { kind: 'lens.hide', from: 'secret', write: 'preserve' },
      { kind: 'lens.value-map', from: 'state', to: 'status', unmapped: 'reject', cases: [{ from: 'open', to: 'active', writeBack: 'to-from' }] },
      { kind: 'lens.lookup', from: 'managerId', to: 'managerName', through: relationUse, sourceFields: ['id'], resultFields: ['name'], onMissing: 'reject', onAmbiguous: 'reject', write: 'read-only' },
      { kind: 'extension', capability, payload: { future: true } }
    ]
  }]
});

const mutate = <Value>(value: Value, update: (copy: any) => void): Value => {
  const copy = structuredClone(value);
  update(copy);
  return copy;
};

describe('semantic artifact safe parsers', () => {
  it('seals typed schema, mapping, and lens bodies without caller casts', async () => {
    const schemaBody = { relations: {} } satisfies SchemaBody;
    await expect(sealSchema({ body: schemaBody })).resolves.toMatchObject({ kind: 'schema', body: schemaBody });
    await expect(sealStorageMapping({ body: mappingBody() })).resolves.toMatchObject({ kind: 'storage-mapping', body: mappingBody() });
    await expect(sealSchemaLens({ body: lensBody() })).resolves.toMatchObject({ kind: 'schema-lens', body: lensBody() });
  });

  it('accepts complete query ASTs, prepares plans, parses declared parameters, and evaluates safely', async () => {
    const artifact = await seal('query', queryBody());
    expect(await safeParseQueryArtifact(artifact)).toMatchObject({ success: true, value: { kind: 'query' } });
    expect(await safeParseQueryArtifact(JSON.stringify(artifact))).toMatchObject({ success: true });
    expect(await safePrepareQueryArtifact(artifact, { registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' }))
      .toMatchObject({ success: true, value: { plan: { query: queryBody().root, datasetId: 'dataset' } } });
    expect(await safeEvaluateQueryArtifact(artifact, {
      relations: [{ relation: relationUse, rows: [{ id: 1, score: 4 }, { id: 2, score: 1 }], completeness: 'exact' }],
      parameters: { minimum: 3, filters: { active: true } }
    })).toMatchObject({ success: true, value: { rows: [{ id: 1, score: 4 }], completeness: 'exact' } });
    expect(await safeEvaluateQueryArtifact(artifact, { relations: [], parameters: { minimum: 3, filters: { active: true }, extra: true } }))
      .toMatchObject({ success: false, issues: [{ code: 'query.parameter_invalid', details: { reason: 'extra' } }] });
  });

  it('refuses to evaluate query artifacts until every required capability is implemented', async () => {
    const declaration = {
      kind: 'tarstate.capability-contract' as const,
      formatVersion: 1 as const,
      id: 'urn:test:query-executor',
      version: '1',
      class: 'executor' as const,
      contract: { queryLanguage: 1 },
      implies: []
    };
    const required = await capabilityRefFor(declaration);
    const artifact = await seal('query', { ...queryBody(), requiredCapabilities: [required] });
    const request = {
      relations: [{ relation: relationUse, rows: [{ id: 1, score: 4 }], completeness: 'exact' as const }],
      parameters: { minimum: 3, filters: { active: true } }
    };
    expect(await safeEvaluateQueryArtifact(artifact, request))
      .toMatchObject({ success: false, issues: [{ code: 'capability.missing', requiredCapabilities: [required] }] });

    const registry = new CapabilityRegistry('trusted:test');
    expect(await registry.registerDeclaration(declaration)).toMatchObject({ success: true });
    expect(registry.registerImplementation({ ref: required, integrity: 'test:query-executor', implementation: {} })).toMatchObject({ success: true });
    expect(await safeEvaluateQueryArtifact(artifact, { ...request, registry }))
      .toMatchObject({ success: true, value: { rows: [{ id: 1, score: 4 }] } });
  });

  it('validates all transaction statement/edit/guard families and bound parameter references', async () => {
    const artifact = await seal('transaction', transactionBody());
    expect(await safeParseTransactionArtifact(artifact)).toMatchObject({ success: true });
    expect(await safePrepareTransactionArtifact(artifact)).toMatchObject({ success: true, value: { kind: 'transaction', body: transactionBody() } });
    const missingParameter = mutate(transactionBody(), (body) => { body.statements[0].rows[0].name.name = 'missing'; });
    expect(await safeParseTransactionArtifact(await seal('transaction', missingParameter)))
      .toMatchObject({ success: false, issues: [{ details: { reason: 'undeclared_parameter' } }] });
    const duplicateReturning = mutate(transactionBody(), (body) => { body.returning.push(body.returning[0]); });
    expect(await safeParseTransactionArtifact(await seal('transaction', duplicateReturning)))
      .toMatchObject({ success: false, issues: [{ details: { reason: 'duplicate_returning_name' } }] });
    const wrongSchema = mutate(transactionBody(), (body) => { body.statements[0].relation.schemaView = otherSchemaRef; });
    expect(await safeParseTransactionArtifact(await seal('transaction', wrongSchema)))
      .toMatchObject({ success: false, issues: expect.arrayContaining([expect.objectContaining({ details: { reason: 'transaction_schema_mismatch' } })]) });
  });

  it('parses and prepares constraint sets while rejecting duplicate IDs and malformed violation queries', async () => {
    const artifact = await seal('constraint-set', constraintBody());
    expect(await safeParseConstraintSetArtifact(artifact)).toMatchObject({ success: true });
    expect(await safePrepareConstraintSetArtifact(artifact, { mode: 'required', evaluateQuery: () => ({ rows: [], completeness: 'exact', issues: [] }) }))
      .toMatchObject({ success: true, value: { constraints: [{ id: 'person-score', mode: 'required' }] } });
    const duplicate = mutate(constraintBody(), (body) => { body.constraints.push(body.constraints[0]); });
    expect(await safeParseConstraintSetArtifact(await seal('constraint-set', duplicate)))
      .toMatchObject({ success: false, issues: [{ details: { reason: 'duplicate_constraint_id' } }] });
    const malformed = mutate(constraintBody(), (body) => { body.constraints[0].violationQuery = { kind: 'where', input: 4, predicate: true }; });
    expect(await safeParseConstraintSetArtifact(await seal('constraint-set', malformed))).toMatchObject({ success: false });
  });

  it('keeps required constraint sets inactive for old executors missing an exact capability', async () => {
    const declaration = {
      kind: 'tarstate.capability-contract' as const,
      formatVersion: 1 as const,
      id: 'urn:test:constraint-executor',
      version: '1',
      class: 'executor' as const,
      contract: { constraintLanguage: 1 },
      implies: []
    };
    const required = await capabilityRefFor(declaration);
    const artifact = await seal('constraint-set', { ...constraintBody(), requiredCapabilities: [required] });
    const evaluateQuery = () => ({ rows: [], completeness: 'exact' as const, issues: [] });
    expect(await safePrepareConstraintSetArtifact(artifact, { mode: 'required', evaluateQuery }))
      .toMatchObject({ success: false, issues: [{ code: 'capability.missing', retry: 'after_capability', requiredCapabilities: [required] }] });

    const registry = new CapabilityRegistry('trusted:test');
    expect(await registry.registerDeclaration(declaration)).toMatchObject({ success: true });
    expect(registry.registerImplementation({ ref: required, integrity: 'test:implementation', implementation: {} })).toMatchObject({ success: true });
    expect(await safePrepareConstraintSetArtifact(artifact, { mode: 'required', registry, evaluateQuery })).toMatchObject({ success: true });
  });

  it('parses exact storage mappings and safely invokes existing schema-aware compilation', async () => {
    const artifact = await seal('storage-mapping', mappingBody());
    expect(await safeParseStorageMappingArtifact(artifact)).toMatchObject({ success: true });
    const prepared = prepareSchema({ relations: { people: { relationId: 'test.person', key: ['id'], fields: { id: { type: { kind: 'string' } }, name: { type: { kind: 'string' } } } } } });
    if (!prepared.success) throw new Error('schema fixture failed');
    expect(await safePrepareStorageMappingArtifact(artifact, { schemaRef, schema: prepared.value }))
      .toMatchObject({ success: true, value: { compiled: { body: { model: 'json-tree-v1' } } } });
    const negativePath = mutate(mappingBody(), (body) => { body.relations['test.person'].collection.path = [-1]; });
    expect(await safeParseStorageMappingArtifact(await seal('storage-mapping', negativePath)))
      .toMatchObject({ success: false, issues: [{ details: { reason: 'storage_path_invalid' } }] });
    const unknownMember = mutate(mappingBody(), (body) => { body.relations['test.person'].collection.ambient = true; });
    expect(await safeParseStorageMappingArtifact(await seal('storage-mapping', unknownMember)))
      .toMatchObject({ success: false, issues: [{ details: { reason: 'unknown_member' } }] });
  });

  it('parses and prepares the complete schema-lens step subset with exact members', async () => {
    const artifact = await seal('schema-lens', lensBody());
    expect(await safeParseSchemaLensArtifact(artifact)).toMatchObject({ success: true });
    const prepared = await safePrepareSchemaLensArtifact(artifact);
    expect(prepared).toMatchObject({ success: true });
    if (!prepared.success) throw new Error('lens preparation failed');
    expect(Object.isFrozen(prepared.value)).toBe(true);
    expect(Object.isFrozen(prepared.value.dependencies)).toBe(true);
    expect(Object.isFrozen(prepared.value.body)).toBe(true);
    expect(Object.isFrozen(prepared.value.body.relations[0]?.steps)).toBe(true);
    const duplicateRelation = mutate(lensBody(), (body) => { body.relations.push(body.relations[0]); });
    expect(await safeParseSchemaLensArtifact(await seal('schema-lens', duplicateRelation)))
      .toMatchObject({ success: false, issues: [{ details: { reason: 'duplicate_lens_relation' } }] });
    const badCase = mutate(lensBody(), (body) => { body.relations[0].steps[3].cases[0].writeBack = 'guess'; });
    expect(await safeParseSchemaLensArtifact(await seal('schema-lens', badCase))).toMatchObject({ success: false });
  });

  it('rejects undeclared parameters, schema views, capabilities, duplicate aliases, and unknown members', async () => {
    const cases = [
      mutate(queryBody(), (body) => { body.root.predicate.right.name = 'not-declared'; }),
      mutate(queryBody(), (body) => { body.root.input.relation.schemaView = otherSchemaRef; }),
      mutate(queryBody(), (body) => { body.root = { kind: 'where', input: values(), predicate: { kind: 'call', capability, args: [] } }; }),
      mutate(queryBody(), (body) => { body.root = { kind: 'join', join: 'inner', left: values('same'), right: values('same'), on: literal(true) }; }),
      mutate(queryBody(), (body) => { body.root = { kind: 'set', op: 'union-all', left: values('left'), right: values('right') }; }),
      mutate(queryBody(), (body) => { body.ambientAuthority = true; })
    ];
    const reasons = ['undeclared_parameter', 'undeclared_schema_view', 'undeclared_capability', 'duplicate_join_alias', 'set_alias_shape_mismatch', 'unknown_member'];
    for (let index = 0; index < cases.length; index += 1) {
      expect(await safeParseQueryArtifact(await seal('query', cases[index])), reasons[index]).toMatchObject({ success: false, issues: expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ reason: reasons[index] }) })]) });
    }
  });

  it('preserves an outer recursion binding after rejecting a nested duplicate name', async () => {
    const recursiveBody = mutate(queryBody(), (body) => {
      body.root = {
        kind: 'recursive',
        name: 'walk',
        seed: values('row'),
        step: {
          kind: 'set',
          op: 'union-all',
          left: {
            kind: 'recursive',
            name: 'walk',
            seed: values('row'),
            step: { kind: 'recursion-ref', name: 'walk' },
            key: []
          },
          right: { kind: 'recursion-ref', name: 'walk' }
        },
        key: []
      };
    });
    const parsed = await safeParseQueryArtifact(await seal('query', recursiveBody));
    expect(parsed).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ details: { reason: 'duplicate_recursion_name' } })
      ])
    });
    if (parsed.success) throw new Error('duplicate recursion fixture was accepted');
    expect(parsed.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ details: { reason: 'recursion_reference_unbound' } })
    ]));
  });

  it('uses duplicate-aware envelopes, semantic recursion budgets, and total hostile-input handling', async () => {
    const artifact = await seal('query', queryBody());
    const duplicateText = JSON.stringify(artifact).replace('"requiredCapabilities":[]', '"requiredCapabilities":[],"requiredCapabilities":[]');
    expect(await safeParseQueryArtifact(duplicateText)).toMatchObject({ success: false, issues: [{ code: 'artifact.duplicate_member' }] });

    let expression: any = literal(true);
    for (let index = 0; index < 12; index += 1) expression = { kind: 'boolean', op: 'not', arg: expression };
    const deep = mutate(queryBody(), (body) => { body.root = { kind: 'where', input: values(), predicate: expression }; });
    expect(await safeParseQueryArtifact(await seal('query', deep), { ...defaultSemanticArtifactParseBudget, maxSemanticDepth: 4 }))
      .toMatchObject({ success: false, issues: [{ code: 'artifact.budget_exceeded', details: { budget: 'maxSemanticDepth' } }] });

    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('hostile'); } });
    await expect(safeParseQueryArtifact(proxy)).resolves.toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
    await expect(safeParseQueryArtifact(7)).resolves.toMatchObject({ success: false });
  });

  it('keeps throwing wrappers opt-in and preserves structured parse issues', async () => {
    const invalid = await seal('query', mutate(queryBody(), (body) => { body.root = { kind: 'unknown' }; }));
    await expect(parseQueryArtifact(invalid)).rejects.toMatchObject({ name: 'TarstateParseError', issues: [{ code: 'query.artifact_invalid' }] });
  });
});
