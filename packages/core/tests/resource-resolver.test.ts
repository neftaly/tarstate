import { describe, expect, it, vi } from 'vitest';
import { ResourceResolver, type ResourceRef } from '../src/resolver.js';

describe('resource resolver', () => {
  it('preserves integrity pins across driver aliases and does not cache loading results', async () => {
    const calls = vi.fn();
    const resolver = new ResourceResolver({ authority: { permits: () => true } });
    resolver.register('mem', {
      resolve: async (reference) => {
        calls(reference.uri);
        if (reference.uri === 'mem:loading') return { state: 'loading', freshness: 'none' };
        return {
          state: 'ready',
          resolved: { uri: reference.uri, kind: reference.kind },
          freshness: 'current',
          value: 'unverified',
          contentHash: `sha256:${'b'.repeat(64)}`
        };
      }
    });
    const pinned: ResourceRef = { uri: 'mem:pinned', kind: 'data', integrity: `sha256:${'a'.repeat(64)}` };
    expect(await resolver.resolve(pinned, { authorityScope: 'public' })).toMatchObject({
      state: 'failed',
      issues: [{ code: 'resolver.integrity_mismatch' }]
    });
    await resolver.resolve({ uri: 'mem:loading', kind: 'data' }, { authorityScope: 'public' });
    await resolver.resolve({ uri: 'mem:loading', kind: 'data' }, { authorityScope: 'public' });
    expect(calls.mock.calls.filter(([uri]) => uri === 'mem:loading')).toHaveLength(2);
  });

  it('rejects accessor and malformed integrity evidence from resolver drivers', async () => {
    const getter = vi.fn(() => `sha256:${'a'.repeat(64)}`);
    const resolver = new ResourceResolver({ authority: { permits: () => true } });
    resolver.register('mem', {
      resolve: async (reference) => ({
        state: 'ready',
        freshness: 'current',
        value: 'unverified',
        resolved: reference.uri.endsWith('accessor')
          ? Object.defineProperty({ uri: reference.uri, kind: reference.kind }, 'integrity', { enumerable: true, get: getter }) as ResourceRef
          : { uri: reference.uri, kind: reference.kind, integrity: 'not-a-content-hash' as `sha256:${string}` }
      })
    });

    await expect(resolver.resolve({ uri: 'mem:accessor', kind: 'data' }, { authorityScope: 'public' })).resolves.toMatchObject({
      state: 'failed', issues: [{ code: 'resolver.failed', details: { reason: 'invalid_driver_reference', field: 'resolved' } }]
    });
    await expect(resolver.resolve({ uri: 'mem:malformed', kind: 'data' }, { authorityScope: 'public' })).resolves.toMatchObject({
      state: 'failed', issues: [{ code: 'resolver.failed', details: { reason: 'invalid_driver_reference', field: 'resolved' } }]
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('scopes caches by authority, follows redirects, detects cycles, and never invokes denied drivers', async () => {
    const calls = vi.fn();
    const resolver = new ResourceResolver({ authority: { permits: (scope, reference) => scope === 'admin' || !reference.uri.includes('secret') } });
    resolver.register('mem', {
      resolve: async (reference) => {
        calls(reference.uri);
        if (reference.uri === 'mem:start') return { state: 'redirect', target: { ...reference, uri: 'mem:value' } };
        if (reference.uri === 'mem:cycle-a') return { state: 'redirect', target: { ...reference, uri: 'mem:cycle-b' } };
        if (reference.uri === 'mem:cycle-b') return { state: 'redirect', target: { ...reference, uri: 'mem:cycle-a' } };
        return { state: 'ready', freshness: 'current', value: { inert: true } };
      }
    });
    const executable: ResourceRef = { uri: 'mem:start', kind: 'executable-code' };
    const first = await resolver.resolve(executable, { authorityScope: 'public' });
    const cached = await resolver.resolve(executable, { authorityScope: 'public' });
    expect(first).toBe(cached);
    expect(first).toMatchObject({ state: 'ready', redirects: ['mem:start'], value: { inert: true } });
    expect(calls).toHaveBeenCalledTimes(2);
    await resolver.resolve(executable, { authorityScope: 'admin' });
    expect(calls).toHaveBeenCalledTimes(4);

    const beforeDenied = calls.mock.calls.length;
    expect(await resolver.resolve({ uri: 'mem:secret', kind: 'data' }, { authorityScope: 'public' })).toMatchObject({ state: 'denied', issues: [{ code: 'resolver.authority_denied' }] });
    expect(calls).toHaveBeenCalledTimes(beforeDenied);
    expect(await resolver.resolve({ uri: 'mem:cycle-a', kind: 'data' }, { authorityScope: 'admin' })).toMatchObject({ state: 'failed', issues: [{ code: 'resolver.cycle' }] });
  });

  it('authorizes the final reference supplied by a driver before returning its value', async () => {
    const permits = vi.fn((_scope: string, reference: ResourceRef) => reference.uri !== 'mem:forbidden');
    const resolver = new ResourceResolver({ authority: { permits } });
    resolver.register('mem', {
      resolve: async () => ({
        state: 'ready',
        resolved: { uri: 'mem:forbidden', kind: 'data' },
        freshness: 'current',
        value: 'secret'
      })
    });

    const result = await resolver.resolve({ uri: 'mem:allowed', kind: 'data' }, { authorityScope: 'public' });

    expect(result).toMatchObject({
      state: 'denied',
      resolved: { uri: 'mem:forbidden' },
      issues: [{ code: 'resolver.authority_denied' }]
    });
    expect(result).not.toHaveProperty('value');
    expect(permits.mock.calls.map(([, reference]) => reference.uri)).toEqual(['mem:allowed', 'mem:forbidden']);
  });

  it('contains authority callback failures without invoking a resolver driver', async () => {
    const driver = vi.fn(async () => ({
      state: 'ready' as const,
      freshness: 'current' as const,
      value: 'unreachable'
    }));
    const resolver = new ResourceResolver({
      authority: { permits: () => { throw new Error('authority unavailable'); } }
    });
    resolver.register('mem', { resolve: driver });

    await expect(resolver.resolve({ uri: 'mem:value', kind: 'data' }, {
      authorityScope: 'public'
    })).resolves.toMatchObject({
      state: 'failed',
      issues: [{
        code: 'resolver.failed',
        details: { reason: 'authority_check_failed', error: 'Error' }
      }]
    });
    expect(driver).not.toHaveBeenCalled();
  });

  it('uses unambiguous authority-scoped cache keys', async () => {
    const calls = vi.fn();
    const resolver = new ResourceResolver({ authority: { permits: (scope) => scope === 'public' } });
    resolver.register('mem', {
      resolve: async (reference) => {
        calls(reference);
        return { state: 'ready', freshness: 'current', value: 'allowed' };
      }
    });
    const firstReference: ResourceRef = { uri: 'mem:\u0000data\u0000secret', kind: 'bytes' };
    const collidingScope = 'public\u0000bytes\u0000mem:';

    expect(await resolver.resolve(firstReference, { authorityScope: 'public' })).toMatchObject({ state: 'ready', value: 'allowed' });
    expect(await resolver.resolve({ uri: 'secret', kind: 'data' }, { authorityScope: collidingScope })).toMatchObject({
      state: 'denied',
      issues: [{ code: 'resolver.authority_denied' }]
    });
    expect(calls).toHaveBeenCalledOnce();
  });

  it('owns and freezes references and authority scope before asynchronous resolution', async () => {
    let continueResolution: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { continueResolution = resolve; });
    const firstDriverInput: { uri?: string; authorityScope?: string; referenceFrozen?: boolean; contextFrozen?: boolean } = {};
    let calls = 0;
    const resolver = new ResourceResolver({ authority: { permits: (scope) => scope === 'public' } });
    resolver.register('mem', {
      resolve: async (reference, context) => {
        calls += 1;
        if (calls === 1) {
          await gate;
          firstDriverInput.uri = reference.uri;
          firstDriverInput.authorityScope = context.authorityScope;
          firstDriverInput.referenceFrozen = Object.isFrozen(reference);
          firstDriverInput.contextFrozen = Object.isFrozen(context);
          return { state: 'redirect', target: { uri: 'mem:finish', kind: 'data' } };
        }
        return { state: 'ready', freshness: 'current', value: reference.uri };
      }
    });
    const reference = { uri: 'mem:start', kind: 'data' as const };
    const options = { authorityScope: 'public' };

    const pending = resolver.resolve(reference, options);
    reference.uri = 'mem:forbidden';
    options.authorityScope = 'denied';
    continueResolution?.();

    await expect(pending).resolves.toMatchObject({
      state: 'ready',
      requested: { uri: 'mem:start' },
      resolved: { uri: 'mem:finish' },
      value: 'mem:finish'
    });
    expect(firstDriverInput).toEqual({
      uri: 'mem:start', authorityScope: 'public', referenceFrozen: true, contextFrozen: true
    });
  });

  it('does not invoke work for pre-cancelled requests or accept success after driver cancellation', async () => {
    const permits = vi.fn(() => true);
    const driver = vi.fn(async () => ({
      state: 'ready' as const,
      freshness: 'current' as const,
      value: 'too-late'
    }));
    const resolver = new ResourceResolver({ authority: { permits } });
    resolver.register('mem', { resolve: driver });
    const reference: ResourceRef = { uri: 'mem:cancelled', kind: 'data' };

    const beforeStart = new AbortController();
    beforeStart.abort();
    await expect(resolver.resolve(reference, {
      authorityScope: 'public',
      signal: beforeStart.signal
    })).resolves.toMatchObject({
      state: 'failed',
      issues: [{ code: 'lifecycle.cancelled' }]
    });
    expect(permits).not.toHaveBeenCalled();
    expect(driver).not.toHaveBeenCalled();

    const duringDriver = new AbortController();
    driver.mockImplementationOnce(async () => {
      duringDriver.abort();
      return { state: 'ready', freshness: 'current', value: 'too-late' };
    });
    const resolved = await resolver.resolve(reference, {
      authorityScope: 'public',
      signal: duringDriver.signal
    });
    expect(resolved).toMatchObject({
      state: 'failed',
      issues: [{ code: 'lifecycle.cancelled' }]
    });
    expect(resolved).not.toHaveProperty('value');
  });

  it('keeps missing, stale, denied, failed, and deleted resource evidence distinct across alias chains', async () => {
    const resolver = new ResourceResolver({ authority: { permits: (_scope, reference) => reference.uri !== 'mem:denied' } });
    resolver.register('mem', {
      resolve: async (reference) => {
        if (reference.uri === 'mem:alias-a') return { state: 'redirect', target: { ...reference, uri: 'mem:alias-b' } };
        if (reference.uri === 'mem:alias-b') return { state: 'redirect', target: { ...reference, uri: 'mem:stale' } };
        if (reference.uri === 'mem:stale') return { state: 'ready', freshness: 'stale', value: { cached: true } };
        if (reference.uri === 'mem:missing') return { state: 'missing', freshness: 'none' };
        if (reference.uri === 'mem:deleted') return { state: 'deleted', freshness: 'none' };
        return { state: 'failed', freshness: 'none' };
      }
    });

    expect(await resolver.resolve({ uri: 'mem:alias-a', kind: 'data' }, { authorityScope: 'public' })).toMatchObject({
      state: 'ready',
      freshness: 'stale',
      redirects: ['mem:alias-a', 'mem:alias-b'],
      resolved: { uri: 'mem:stale' },
      value: { cached: true }
    });
    expect(await resolver.resolve({ uri: 'mem:missing', kind: 'document' }, { authorityScope: 'public' })).toMatchObject({ state: 'missing', freshness: 'none' });
    expect(await resolver.resolve({ uri: 'mem:deleted', kind: 'document' }, { authorityScope: 'public' })).toMatchObject({ state: 'deleted', freshness: 'none' });
    expect(await resolver.resolve({ uri: 'mem:failed', kind: 'document' }, { authorityScope: 'public' })).toMatchObject({ state: 'failed', freshness: 'none' });
    expect(await resolver.resolve({ uri: 'mem:denied', kind: 'document' }, { authorityScope: 'public' })).toMatchObject({ state: 'denied', freshness: 'none' });
  });

  it('evicts completed entries by deterministic least-recently-used order', async () => {
    const calls = new Map<string, number>();
    const resolver = new ResourceResolver({ authority: { permits: () => true }, maxCacheEntries: 2 });
    resolver.register('mem', {
      resolve: async (reference) => {
        calls.set(reference.uri, (calls.get(reference.uri) ?? 0) + 1);
        return { state: 'ready', freshness: 'current', value: reference.uri };
      }
    });
    const resolve = (uri: string) => resolver.resolve({ uri, kind: 'data' }, { authorityScope: 'public' });

    await resolve('mem:a');
    await resolve('mem:b');
    await resolve('mem:a'); // touch A, making B least-recently used
    await resolve('mem:c'); // evict B
    await resolve('mem:b');

    expect(Object.fromEntries(calls)).toEqual({ 'mem:a': 1, 'mem:b': 2, 'mem:c': 1 });
    expect(() => new ResourceResolver({ authority: { permits: () => true }, maxRedirects: -1 })).toThrow(/non-negative safe integer/);
    expect(() => new ResourceResolver({ authority: { permits: () => true }, maxCacheEntries: -1 })).toThrow(/non-negative safe integer/);
  });

  it('shares in-flight work independently of completed-cache capacity', async () => {
    let finish: ((value: { readonly state: 'ready'; readonly freshness: 'current'; readonly value: string }) => void) | undefined;
    const calls = vi.fn();
    const resolver = new ResourceResolver({ authority: { permits: () => true }, maxCacheEntries: 0 });
    resolver.register('mem', {
      resolve: (reference) => {
        calls(reference.uri);
        return new Promise((resolve) => { finish = resolve; });
      }
    });
    const reference: ResourceRef = { uri: 'mem:pending', kind: 'data' };
    const first = resolver.resolve(reference, { authorityScope: 'public' });
    const shared = resolver.resolve(reference, { authorityScope: 'public' });
    expect(shared).toBe(first);
    expect(calls).toHaveBeenCalledOnce();
    finish?.({ state: 'ready', freshness: 'current', value: 'first' });
    await expect(first).resolves.toMatchObject({ value: 'first' });

    const second = resolver.resolve(reference, { authorityScope: 'public' });
    expect(calls).toHaveBeenCalledTimes(2);
    finish?.({ state: 'ready', freshness: 'current', value: 'second' });
    await expect(second).resolves.toMatchObject({ value: 'second' });
  });

  it('bounds retained shared resolutions without starting excess driver work', async () => {
    const calls = vi.fn();
    const resolver = new ResourceResolver({
      authority: { permits: () => true },
      maxInflightResolutions: 1
    });
    resolver.register('mem', {
      resolve: (reference) => {
        calls(reference.uri);
        return new Promise(() => undefined);
      }
    });

    void resolver.resolve({ uri: 'mem:first', kind: 'data' }, { authorityScope: 'public' });
    await expect(resolver.resolve(
      { uri: 'mem:second', kind: 'data' },
      { authorityScope: 'public' }
    )).resolves.toMatchObject({
      state: 'failed',
      issues: [{ code: 'resolver.capacity_exhausted' }]
    });
    expect(calls).toHaveBeenCalledOnce();
  });

  it('invalidates one authority scope and prevents detached in-flight completions from repopulating it', async () => {
    const completions: ((value: { readonly state: 'ready'; readonly freshness: 'current'; readonly value: string }) => void)[] = [];
    const calls = vi.fn();
    const resolver = new ResourceResolver({ authority: { permits: () => true }, maxCacheEntries: 4 });
    resolver.register('mem', {
      resolve: (reference, context) => {
        calls(context.authorityScope, reference.uri);
        return new Promise((resolve) => { completions.push(resolve); });
      }
    });
    const reference: ResourceRef = { uri: 'mem:value', kind: 'data' };
    const stalePublic = resolver.resolve(reference, { authorityScope: 'public' });
    const admin = resolver.resolve(reference, { authorityScope: 'admin' });
    resolver.invalidate('public');
    const currentPublic = resolver.resolve(reference, { authorityScope: 'public' });
    expect(calls).toHaveBeenCalledTimes(3);

    completions[0]?.({ state: 'ready', freshness: 'current', value: 'stale-public' });
    completions[1]?.({ state: 'ready', freshness: 'current', value: 'admin' });
    completions[2]?.({ state: 'ready', freshness: 'current', value: 'current-public' });
    await expect(stalePublic).resolves.toMatchObject({ value: 'stale-public' });
    await expect(admin).resolves.toMatchObject({ value: 'admin' });
    await expect(currentPublic).resolves.toMatchObject({ value: 'current-public' });

    expect(await resolver.resolve(reference, { authorityScope: 'public' })).toMatchObject({ value: 'current-public' });
    expect(await resolver.resolve(reference, { authorityScope: 'admin' })).toMatchObject({ value: 'admin' });
    expect(calls).toHaveBeenCalledTimes(3);
  });
});
