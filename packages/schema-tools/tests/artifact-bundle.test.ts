import { describe, expect, it } from 'vitest';
import { sealArtifact } from '@tarstate/core';
import { sealConstraintSet } from '@tarstate/core/artifacts/constraint-set';
import { sealSchema, sealStorageMapping } from '@tarstate/core/schema';
import {
  buildArtifactOutputs,
  type ArtifactBuildBundle
} from '../src/index.js';
import * as schemaTools from '../src/index.js';
import {
  defaultArtifactBuildBudget,
  prepareArtifactBundle
} from '../src/artifact-bundle/index.js';
import * as artifactBundleRuntime from '../src/artifact-bundle/index.js';

const schema = async (
  id: string,
  dependencies: readonly { readonly id: string; readonly contentHash: `sha256:${string}` }[] = []
) => sealSchema({
  id,
  dependencies,
  body: {
    relations: {
      items: {
        relationId: id + ':items',
        key: ['id'],
        fields: { id: { type: { kind: 'string' } } }
      }
    }
  }
});

const ref = <Value extends { readonly id: string; readonly contentHash: `sha256:${string}` }>(
  value: Value
) => ({ id: value.id, contentHash: value.contentHash });

const fixture = async (): Promise<{
  readonly bundle: ArtifactBuildBundle;
  readonly ids: {
    readonly leaf: string;
    readonly support: string;
    readonly semanticSchema: string;
    readonly query: string;
    readonly transaction: string;
    readonly lens: string;
    readonly constraintSupport: string;
    readonly primary: string;
    readonly unrelated: string;
    readonly mapping: string;
    readonly constraints: string;
  };
  readonly primaryRef: ReturnType<typeof ref>;
}> => {
  const leaf = await schema('urn:test:bundle:leaf');
  const support = await schema('urn:test:bundle:support', [ref(leaf)]);
  const semanticSchema = await schema('urn:test:bundle:semantic-schema');
  const constraintSupport = await schema('urn:test:bundle:constraint-support');
  const primary = await schema('urn:test:bundle:primary');
  const unrelated = await schema('urn:test:bundle:unrelated');
  const query = await sealArtifact({
    kind: 'query',
    id: 'urn:test:bundle:query',
    body: { schemaViews: [ref(semanticSchema)] }
  });
  const transaction = await sealArtifact({
    kind: 'transaction',
    id: 'urn:test:bundle:transaction',
    body: { schemaView: ref(semanticSchema) }
  });
  const lens = await sealArtifact({
    kind: 'schema-lens',
    id: 'urn:test:bundle:lens',
    body: {
      from: ref(semanticSchema),
      to: ref(primary),
      relations: []
    }
  });
  const mapping = await sealStorageMapping({
    id: 'urn:test:bundle:mapping',
    dependencies: [ref(support), ref(query), ref(transaction), ref(lens)],
    body: {
      schema: ref(primary),
      model: 'json-tree-v1',
      relations: {}
    }
  });
  const constraints = await sealConstraintSet({
    id: 'urn:test:bundle:constraints',
    dependencies: [ref(constraintSupport)],
    body: {
      schemaView: ref(primary),
      constraints: [],
      requiredCapabilities: []
    }
  });
  const declaration = {
    formatVersion: 1 as const,
    storageSchema: ref(primary),
    projection: {
      kind: 'storage-mapping' as const,
      storageMapping: ref(mapping)
    }
  };
  const built = await buildArtifactOutputs({
    artifacts: {
      leaf,
      support,
      semanticSchema,
      query,
      transaction,
      lens,
      constraintSupport,
      primary,
      unrelated,
      mapping,
      constraints
    },
    declarations: {
      plain: declaration,
      guarded: {
        ...declaration,
        constraints: { set: ref(constraints), mode: 'required' as const }
      }
    }
  });
  if (!built.success) throw new Error('artifact bundle fixture failed');
  return {
    bundle: built.value.bundle,
    ids: {
      leaf: leaf.id,
      support: support.id,
      semanticSchema: semanticSchema.id,
      query: query.id,
      transaction: transaction.id,
      lens: lens.id,
      constraintSupport: constraintSupport.id,
      primary: primary.id,
      unrelated: unrelated.id,
      mapping: mapping.id,
      constraints: constraints.id
    },
    primaryRef: ref(primary)
  };
};

describe('portable artifact bundle runtime catalog', () => {
  it('keeps runtime preparation on one narrow public path', () => {
    expect(artifactBundleRuntime.prepareArtifactBundle).toBeTypeOf('function');
    expect('prepareArtifactBundle' in schemaTools).toBe(false);
  });

  it('selects deterministic minimal explicit and semantic dependency closures', async () => {
    const { bundle, ids } = await fixture();
    const prepared = await prepareArtifactBundle(bundle);
    if (!prepared.success) throw new Error('artifact bundle preparation failed');

    const plain = prepared.value.attachment('plain');
    const guarded = prepared.value.attachment('guarded');
    expect(plain.success).toBe(true);
    expect(guarded.success).toBe(true);
    if (!plain.success || !guarded.success) throw new Error('attachment selection failed');

    expect(Object.keys(plain.value.artifacts)).toEqual([
      ids.leaf,
      ids.lens,
      ids.mapping,
      ids.primary,
      ids.query,
      ids.semanticSchema,
      ids.support,
      ids.transaction
    ].sort(compareStrings));
    expect(Object.keys(guarded.value.artifacts)).toEqual([
      ids.constraintSupport,
      ids.constraints,
      ids.leaf,
      ids.lens,
      ids.mapping,
      ids.primary,
      ids.query,
      ids.semanticSchema,
      ids.support,
      ids.transaction
    ].sort(compareStrings));
    expect(plain.value.artifacts).not.toHaveProperty(ids.unrelated);
    expect(Object.isFrozen(plain.value)).toBe(true);
    expect(Object.isFrozen(plain.value.artifacts)).toBe(true);
  });

  it('performs exact hash and kind lookup with ordinary parse failures', async () => {
    const { bundle, primaryRef } = await fixture();
    const prepared = await prepareArtifactBundle(bundle);
    if (!prepared.success) throw new Error('artifact bundle preparation failed');

    expect(prepared.value.artifact(primaryRef, 'schema')).toMatchObject({
      success: true,
      value: { kind: 'schema', id: primaryRef.id }
    });
    expect(prepared.value.artifact(primaryRef, 'storage-mapping')).toMatchObject({
      success: false,
      issues: [{
        code: 'schema_tools.artifact_build_invalid',
        details: { reason: 'artifact_lookup' }
      }]
    });
    expect(prepared.value.artifact({
      id: primaryRef.id,
      contentHash: `sha256:${'f'.repeat(64)}`
    }, 'schema')).toMatchObject({
      success: false,
      issues: [{ details: { reason: 'artifact_lookup' } }]
    });
    expect(prepared.value.attachment('missing')).toMatchObject({
      success: false,
      issues: [{ details: { reason: 'declaration_missing' } }]
    });
  });

  it('retains hostile but valid declaration names without prototype confusion', async () => {
    const { bundle } = await fixture();
    const declaration = bundle.declarations.plain;
    if (declaration === undefined) throw new Error('fixture declaration missing');
    const hostileBundle = {
      ...bundle,
      declarations: Object.fromEntries([['__proto__', declaration]])
    };
    const prepared = await prepareArtifactBundle(hostileBundle);
    if (!prepared.success) throw new Error('hostile bundle preparation failed');
    expect(prepared.value.attachment('__proto__')).toMatchObject({ success: true });
    expect(Object.getPrototypeOf(prepared.value)).toBe(Object.prototype);
  });

  it('retains parser budgets and whole-bundle closure validation', async () => {
    const { bundle } = await fixture();
    await expect(prepareArtifactBundle(bundle, {
      ...defaultArtifactBuildBudget,
      maxArtifacts: 1,
    })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'artifact.budget_exceeded' }]
    });
  });
});

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
