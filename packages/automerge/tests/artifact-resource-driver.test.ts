import * as Automerge from '@automerge/automerge';
import {
  ExactArtifactResolver,
  ResourceResolver
} from '@tarstate/core/artifacts';
import { sealSchema } from '@tarstate/core/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  automergeArtifactResourceDriver,
  extractAutomergeArtifactCarrier,
  type AutomergeArtifactCarrierRepo
} from '../src/index.js';

describe('Automerge artifact resource driver', () => {
  it('extracts inert carrier data and heads, then releases the temporary lease', async () => {
    const artifact = await sealSchema({ id: 'urn:test:automerge-carrier-schema', body: { relations: {} } });
    const key = artifact.id + '@' + artifact.contentHash;
    type CarrierDoc = { artifacts: Record<string, typeof artifact> };
    const doc = Automerge.from<CarrierDoc>({ artifacts: { [key]: artifact } });
    const release = vi.fn();
    const repo: AutomergeArtifactCarrierRepo<CarrierDoc, readonly string[]> = {
      acquire: vi.fn(async () => ({
        waitForSnapshot: async () => ({ state: 'ready' as const, doc, heads: ['head:one'] as const }),
        release
      }))
    };
    const resources = new ResourceResolver({ authority: { permits: () => true } });
    resources.register('automerge', automergeArtifactResourceDriver({ repo, normalizeHeads: (heads) => heads }));
    const resolver = new ExactArtifactResolver({ resourceResolver: resources, extract: extractAutomergeArtifactCarrier });
    const resolved = await resolver.resolve({
      expectedKind: 'schema',
      reference: { id: artifact.id, contentHash: artifact.contentHash, locations: ['automerge:carrier'] },
      authorityScope: 'scope:test'
    });
    expect(resolved).toMatchObject({
      state: 'ready',
      artifact: { id: artifact.id },
      selected: { resource: { state: 'ready' }, provenance: { kind: 'automerge-heads', heads: ['head:one'] } }
    });
    if (resolved.state !== 'ready') throw new Error('artifact carrier must resolve');
    expect(resolved.selected.resource).not.toHaveProperty('value');
    expect(release).toHaveBeenCalledOnce();
    expect(JSON.stringify(resolved)).not.toContain('waitForSnapshot');
  });

  it.each(['missing', 'failed', 'deleted', 'unsupported'] as const)('releases a %s carrier lease', async (state) => {
    const release = vi.fn();
    const repo: AutomergeArtifactCarrierRepo<object, readonly string[]> = {
      acquire: async () => ({ waitForSnapshot: async () => ({ state }), release })
    };
    const driver = automergeArtifactResourceDriver({ repo, normalizeHeads: (heads) => heads });
    await expect(driver.resolve({ uri: 'automerge:value', kind: 'data' }, { authorityScope: 'scope:test' })).resolves.toMatchObject({ state });
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the lease when snapshot acquisition throws', async () => {
    const release = vi.fn();
    const repo: AutomergeArtifactCarrierRepo<object, readonly string[]> = {
      acquire: async () => ({ waitForSnapshot: async () => { throw new Error('load failed'); }, release })
    };
    const driver = automergeArtifactResourceDriver({ repo, normalizeHeads: (heads) => heads });
    await expect(driver.resolve({ uri: 'automerge:value', kind: 'data' }, { authorityScope: 'scope:test' })).resolves.toMatchObject({ state: 'failed', issues: [{ code: 'resolver.failed' }] });
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not publish a ready result when lease release fails', async () => {
    const doc = Automerge.from({ artifacts: {} });
    const repo: AutomergeArtifactCarrierRepo<{ artifacts: Record<string, never> }, readonly string[]> = {
      acquire: async () => ({
        waitForSnapshot: async () => ({ state: 'ready', doc, heads: [] }),
        release: () => { throw new Error('release failed'); }
      })
    };
    const driver = automergeArtifactResourceDriver({ repo, normalizeHeads: (heads) => heads });
    await expect(driver.resolve({ uri: 'automerge:value', kind: 'data' }, { authorityScope: 'scope:test' })).resolves.toMatchObject({
      state: 'failed',
      issues: [{ code: 'resolver.failed', details: { reason: 'lease_release_failed' } }]
    });
  });
});
