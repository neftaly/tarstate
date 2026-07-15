import { describe, expect, it } from 'vitest';
import {
  ExactArtifactResolver,
  ResourceResolver,
  sealSchema,
  type ArtifactRef,
  type ResolverDriver
} from '../src/index.js';

describe('exact artifact resolution', () => {
  it('tries prioritized candidates and verifies semantic identity independently of location', async () => {
    const artifact = await sealSchema({ id: 'urn:test:resolved-schema', body: { relations: {} } });
    const reference: ArtifactRef = { id: artifact.id, contentHash: artifact.contentHash, locations: ['memory:correct'] };
    const resources = new ResourceResolver({ authority: { permits: () => true } });
    resources.register('memory', {
      resolve: async () => ({ state: 'ready', freshness: 'current', value: artifact })
    });
    const resolver = new ExactArtifactResolver({
      resourceResolver: resources,
      embedded: { get: () => ({ ...artifact, id: 'urn:test:wrong' }) }
    });
    const resolved = await resolver.resolve({ expectedKind: 'schema', reference, authorityScope: 'scope:test' });
    expect(resolved).toMatchObject({
      state: 'ready',
      artifact: { id: artifact.id, contentHash: artifact.contentHash },
      selected: { origin: 'location' },
      attempts: [
        { origin: 'embedded', state: 'failed', issues: [{ code: 'artifact.hash_mismatch' }] },
        { origin: 'location', state: 'ready' }
      ]
    });
  });

  it('retains denied, missing, and unsupported location lifecycle evidence', async () => {
    const artifact = await sealSchema({ id: 'urn:test:unavailable-schema', body: { relations: {} } });
    const missing: ResolverDriver = { resolve: async () => ({ state: 'missing', freshness: 'none' }) };
    const resources = new ResourceResolver({ authority: { permits: (_scope, ref) => !ref.uri.startsWith('denied:') } });
    resources.register('missing', missing);
    const resolved = await new ExactArtifactResolver({ resourceResolver: resources }).resolve({
      expectedKind: 'schema',
      reference: { id: artifact.id, contentHash: artifact.contentHash, locations: ['denied:value', 'missing:value', 'unknown:value'] },
      authorityScope: 'scope:test'
    });
    expect(resolved).toMatchObject({
      state: 'unavailable',
      attempts: [
        { state: 'denied', issues: [{ code: 'resolver.authority_denied' }] },
        { state: 'missing' },
        { state: 'unsupported', issues: [{ code: 'resolver.scheme_unsupported' }] }
      ]
    });
  });

  it('does not let two locations select different content for one exact reference', async () => {
    const expected = await sealSchema({ id: 'urn:test:exact-schema', body: { relations: {} } });
    const other = await sealSchema({ id: expected.id, body: { relations: { other: { relationId: 'other', key: ['id'], fields: { id: { type: { kind: 'string' } } } } } } });
    const resources = new ResourceResolver({ authority: { permits: () => true } });
    resources.register('carrier', {
      resolve: async (reference) => ({ state: 'ready', freshness: 'current', value: reference.uri.endsWith('wrong') ? other : expected })
    });
    const resolved = await new ExactArtifactResolver({ resourceResolver: resources }).resolve({
      expectedKind: 'schema',
      reference: { id: expected.id, contentHash: expected.contentHash, locations: ['carrier:wrong', 'carrier:correct'] },
      authorityScope: 'scope:test'
    });
    expect(resolved).toMatchObject({ state: 'ready', selected: { candidateId: expect.stringContaining('carrier:correct') }, attempts: [{ state: 'failed' }, { state: 'ready' }] });
  });

  it('passes authority and cancellation context to stores and refuses success after cancellation', async () => {
    const artifact = await sealSchema({ id: 'urn:test:cancelled-schema', body: { relations: {} } });
    const controller = new AbortController();
    const observed: unknown[] = [];
    const resolver = new ExactArtifactResolver({
      resourceResolver: new ResourceResolver({ authority: { permits: () => true } }),
      embedded: {
        get: (_reference, context) => {
          observed.push(context);
          controller.abort();
          return artifact;
        }
      }
    });
    const resolved = await resolver.resolve({
      expectedKind: 'schema',
      reference: { id: artifact.id, contentHash: artifact.contentHash },
      authorityScope: 'scope:cancelled',
      signal: controller.signal
    });
    expect(observed).toMatchObject([{ expectedKind: 'schema', authorityScope: 'scope:cancelled', signal: controller.signal }]);
    expect(resolved).toMatchObject({ state: 'unavailable', issues: [{ code: 'lifecycle.cancelled' }] });
  });

  it('passes cancellation context to catalogs and stops before accepting their candidates', async () => {
    const artifact = await sealSchema({ id: 'urn:test:cancelled-catalog-schema', body: { relations: {} } });
    const controller = new AbortController();
    const resolver = new ExactArtifactResolver({
      resourceResolver: new ResourceResolver({ authority: { permits: () => true } }),
      catalogs: [{
        candidates: (_reference, context) => {
          expect(context).toMatchObject({ expectedKind: 'schema', authorityScope: 'scope:catalog' });
          controller.abort();
          return [{ id: 'cancelled', value: artifact }];
        }
      }]
    });
    await expect(resolver.resolve({
      expectedKind: 'schema',
      reference: { id: artifact.id, contentHash: artifact.contentHash },
      authorityScope: 'scope:catalog',
      signal: controller.signal
    })).resolves.toMatchObject({ state: 'unavailable', attempts: [], issues: [{ code: 'lifecycle.cancelled' }] });
  });
});
