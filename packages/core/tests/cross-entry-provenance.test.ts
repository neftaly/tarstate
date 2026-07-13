import { describe, expect, it, vi } from 'vitest';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;

describe('cross-entry prepared-value provenance', () => {
  it('accepts a root-entry prepared plan after the query entry is loaded independently', async () => {
    const root = await import('../src/index.js');
    const plan = await root.prepareQuery({
      root: { kind: 'values', alias: 'value', rows: [{ id: 1 }] },
      registryFingerprint: 'registry:cross-entry',
      authorityFingerprint: 'authority:cross-entry',
      datasetId: 'dataset:cross-entry'
    });

    vi.resetModules();
    const query = await import('../src/query/index.js');
    const session = query.openIncrementalQueryMaintenance(plan, { relations: [] });
    expect(session.getCurrentResult().rows).toEqual([{ id: 1 }]);
    session.close();

    const subpathPlan = await query.prepareQuery({
      root: { kind: 'values', alias: 'value', rows: [{ id: 2 }] },
      registryFingerprint: 'registry:cross-entry',
      authorityFingerprint: 'authority:cross-entry',
      datasetId: 'dataset:cross-entry'
    });
    vi.resetModules();
    const reloadedRoot = await import('../src/index.js');
    const reverseSession = reloadedRoot.openIncrementalQueryMaintenance(subpathPlan, { relations: [] });
    expect(reverseSession.getCurrentResult().rows).toEqual([{ id: 2 }]);
    reverseSession.close();

    expect(() => query.openIncrementalQueryMaintenance({ ...plan } as typeof plan, { relations: [] }))
      .toThrow('not produced by a plan preparation API');
  });

  it('shares schema, mapping, and lens provenance across independently loaded entries', async () => {
    const root = await import('../src/index.js');
    const prepared = root.prepareSchema({
      relations: {
        values: {
          relationId: 'test.value',
          key: ['id'],
          fields: { id: { type: { kind: 'number' } } }
        }
      }
    });
    if (!prepared.success) throw new Error('schema preparation failed');

    const schemaRef = { id: 'urn:test:schema:cross-entry', contentHash: hash('1') };
    const mapping = root.compileStorageMapping({
      schema: schemaRef,
      model: 'json-tree-v1',
      relations: {
        'test.value': {
          collection: { kind: 'array', path: ['values'], absent: 'empty' },
          keys: { id: { kind: 'field', path: ['id'] } },
          fields: {}
        }
      }
    }, schemaRef, prepared.value);
    if (!mapping.success) throw new Error('mapping compilation failed');

    const lens = root.validateLens({
      from: { id: 'urn:test:schema:from', contentHash: hash('2') },
      to: { id: 'urn:test:schema:to', contentHash: hash('3') },
      relations: [{
        fromRelationId: 'test.value',
        toRelationId: 'test.projected-value',
        steps: [{ kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' }]
      }]
    });
    if (!lens.success) throw new Error('lens validation failed');

    vi.resetModules();
    const schema = await import('../src/schema/index.js');
    expect(schema.parseRelationCandidate(prepared.value, 'test.value', { id: 1 })).toMatchObject({ success: true });
    expect(schema.projectStorage(mapping.value, { values: [{ id: 1 }] }).relations.get('test.value')?.rows).toHaveLength(1);
    expect(schema.projectLensRelation(lens.value, 'test.projected-value', { 'test.value': [{ id: 1 }] }).rows).toEqual([{ id: 1 }]);

    const subpathPrepared = schema.prepareSchema({
      relations: { reverse: { relationId: 'test.reverse', key: ['id'], fields: { id: { type: { kind: 'number' } } } } }
    });
    if (!subpathPrepared.success) throw new Error('subpath schema preparation failed');
    expect(root.parseRelationCandidate(subpathPrepared.value, 'test.reverse', { id: 2 })).toMatchObject({ success: true });

    const subpathMapping = schema.compileStorageMapping({
      schema: schemaRef,
      model: 'json-tree-v1',
      relations: {
        'test.reverse': {
          collection: { kind: 'array', path: ['reverse'], absent: 'empty' },
          keys: { id: { kind: 'field', path: ['id'] } },
          fields: {}
        }
      }
    }, schemaRef, subpathPrepared.value);
    if (!subpathMapping.success) throw new Error('subpath mapping compilation failed');
    expect(root.projectStorage(subpathMapping.value, { reverse: [{ id: 2 }] }).relations.get('test.reverse')?.rows).toHaveLength(1);

    const subpathLens = schema.validateLens({
      from: { id: 'urn:test:schema:reverse-from', contentHash: hash('4') },
      to: { id: 'urn:test:schema:reverse-to', contentHash: hash('5') },
      relations: [{
        fromRelationId: 'test.reverse',
        toRelationId: 'test.reverse-view',
        steps: [{ kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' }]
      }]
    });
    if (!subpathLens.success) throw new Error('subpath lens validation failed');
    expect(root.projectLensRelation(subpathLens.value, 'test.reverse-view', { 'test.reverse': [{ id: 2 }] }).rows).toEqual([{ id: 2 }]);

    expect(() => schema.parseRelationCandidate({ ...prepared.value } as typeof prepared.value, 'test.value', { id: 1 }))
      .toThrow('not produced by prepareSchema');
    expect(() => schema.projectStorage({ ...mapping.value } as typeof mapping.value, {}))
      .toThrow('not produced by compileStorageMapping');
    expect(() => schema.projectLensRelation({ ...lens.value } as typeof lens.value, 'test.projected-value', {}))
      .toThrow('not produced by validateLens');
  });
});
