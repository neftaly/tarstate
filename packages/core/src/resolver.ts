import { createIssue, type Issue } from './issues.js';

export type ResourceKind = 'bytes' | 'data' | 'schema' | 'constraint' | 'document' | 'executable-code';
export type ResourceLifecycleState = 'loading' | 'ready' | 'missing' | 'failed' | 'denied' | 'deleted' | 'unsupported';

export type ResourceRef = {
  readonly uri: string;
  readonly kind: ResourceKind;
  readonly integrity?: `sha256:${string}`;
};

export type ResolvedResource<Value = unknown> = {
  readonly resourceId: string;
  readonly requested: ResourceRef;
  readonly resolved: ResourceRef;
  readonly state: ResourceLifecycleState;
  readonly freshness: 'current' | 'stale' | 'none';
  readonly redirects: readonly string[];
  readonly value?: Value;
  readonly issues: readonly Issue[];
};

export type ResolverDriverResult<Value = unknown> =
  | { readonly state: 'ready'; readonly resolved?: ResourceRef; readonly freshness: 'current' | 'stale'; readonly value: Value; readonly contentHash?: `sha256:${string}`; readonly issues?: readonly Issue[] }
  | { readonly state: 'loading' | 'missing' | 'failed' | 'deleted' | 'unsupported'; readonly resolved?: ResourceRef; readonly freshness: 'stale' | 'none'; readonly issues?: readonly Issue[] }
  | { readonly state: 'redirect'; readonly target: ResourceRef; readonly issues?: readonly Issue[] };

export type ResolverDriver = {
  readonly resolve: (reference: ResourceRef, context: {
    readonly authorityScope: string;
    readonly signal?: AbortSignal;
  }) => Promise<ResolverDriverResult>;
};

export type ResolverAuthority = {
  readonly permits: (authorityScope: string, reference: ResourceRef) => boolean;
};

/**
 * An authority-scoped resource resolver. Drivers return inert values; the
 * resolver never imports or executes a resource, including executable-code
 * leaves.
 */
export class ResourceResolver {
  readonly #authority: ResolverAuthority;
  readonly #drivers = new Map<string, ResolverDriver>();
  readonly #cache = new Map<string, ResolvedResource>();
  readonly #inflight = new Map<string, Promise<ResolvedResource>>();
  readonly #maxRedirects: number;
  readonly #maxCacheEntries: number;

  constructor(options: { readonly authority: ResolverAuthority; readonly maxRedirects?: number; readonly maxCacheEntries?: number }) {
    this.#authority = options.authority;
    this.#maxRedirects = options.maxRedirects ?? 16;
    this.#maxCacheEntries = options.maxCacheEntries ?? 256;
    if (!Number.isSafeInteger(this.#maxCacheEntries) || this.#maxCacheEntries < 0) throw new TypeError('maxCacheEntries must be a non-negative safe integer');
  }

  register(scheme: string, driver: ResolverDriver): () => void {
    const normalized = scheme.toLowerCase().replace(/:$/, '');
    if (this.#drivers.has(normalized)) throw new Error('A resolver driver is already registered for ' + normalized);
    this.#drivers.set(normalized, driver);
    // A previously cached unsupported result may now be resolvable.
    this.invalidate();
    return () => {
      if (this.#drivers.get(normalized) !== driver) return;
      this.#drivers.delete(normalized);
      this.invalidate();
    };
  }

  resolve<Value = unknown>(reference: ResourceRef, options: {
    readonly authorityScope: string;
    readonly signal?: AbortSignal;
    readonly bypassCache?: boolean;
  }): Promise<ResolvedResource<Value>> {
    const key = options.authorityScope + '\u0000' + reference.kind + '\u0000' + reference.uri + '\u0000' + (reference.integrity ?? '');
    const useCache = options.bypassCache !== true && options.signal === undefined;
    if (useCache) {
      const cached = this.#cache.get(key);
      if (cached !== undefined) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return Promise.resolve(cached as ResolvedResource<Value>);
      }
      const inflight = this.#inflight.get(key);
      if (inflight !== undefined) return inflight as Promise<ResolvedResource<Value>>;
    }
    const pending = this.#resolve(reference, options);
    if (useCache) {
      this.#inflight.set(key, pending);
      void pending.then(
        (resolved) => {
          if (this.#inflight.get(key) !== pending) return;
          this.#inflight.delete(key);
          this.#remember(key, resolved);
        },
        () => {
          if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
        }
      );
    }
    return pending as Promise<ResolvedResource<Value>>;
  }

  invalidate(authorityScope?: string): void {
    if (authorityScope === undefined) {
      this.#cache.clear();
      this.#inflight.clear();
      return;
    }
    const prefix = authorityScope + '\u0000';
    for (const key of this.#cache.keys()) if (key.startsWith(prefix)) this.#cache.delete(key);
    for (const key of this.#inflight.keys()) if (key.startsWith(prefix)) this.#inflight.delete(key);
  }

  #remember(key: string, resolved: ResolvedResource): void {
    if (this.#maxCacheEntries === 0) return;
    this.#cache.delete(key);
    this.#cache.set(key, resolved);
    while (this.#cache.size > this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#cache.delete(oldest);
    }
  }

  async #resolve(reference: ResourceRef, options: { readonly authorityScope: string; readonly signal?: AbortSignal }): Promise<ResolvedResource> {
    const redirects: string[] = [];
    const accumulatedIssues: Issue[] = [];
    const visited = new Set<string>();
    let current = reference;
    for (let depth = 0; depth <= this.#maxRedirects; depth += 1) {
      if (!this.#authority.permits(options.authorityScope, current)) {
        return resolution(reference, current, redirects, 'denied', 'none', undefined, [...accumulatedIssues, resolverIssue('resolver.authority_denied', 'after_authority', { uri: current.uri })]);
      }
      const identity = current.kind + '\u0000' + current.uri;
      if (visited.has(identity)) {
        return resolution(reference, current, redirects, 'failed', 'none', undefined, [...accumulatedIssues, resolverIssue('resolver.cycle', 'after_input', { uri: current.uri })]);
      }
      visited.add(identity);
      const driver = this.#drivers.get(schemeOf(current.uri));
      if (driver === undefined) {
        return resolution(reference, current, redirects, 'unsupported', 'none', undefined, [...accumulatedIssues, resolverIssue('resolver.scheme_unsupported', 'after_capability', { uri: current.uri })]);
      }
      let result: ResolverDriverResult;
      try {
        result = await driver.resolve(current, {
          authorityScope: options.authorityScope,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        });
      } catch (error) {
        result = {
          state: 'failed',
          freshness: 'none',
          issues: [resolverIssue('resolver.failed', 'after_refresh', { uri: current.uri, error: error instanceof Error ? error.name : typeof error })]
        };
      }
      if (result.state === 'redirect') {
        accumulatedIssues.push(...(result.issues ?? []));
        redirects.push(current.uri);
        current = result.target;
        continue;
      }
      const resolved = result.resolved ?? current;
      if (result.state === 'ready' && resolved.integrity !== undefined && result.contentHash !== resolved.integrity) {
        return resolution(reference, resolved, redirects, 'failed', 'none', undefined, [
          ...accumulatedIssues,
          ...(result.issues ?? []),
          resolverIssue('resolver.integrity_mismatch', 'after_refresh', { expected: resolved.integrity, actual: result.contentHash ?? null })
        ]);
      }
      return resolution(
        reference,
        resolved,
        redirects,
        result.state,
        result.freshness,
        result.state === 'ready' ? result.value : undefined,
        [...accumulatedIssues, ...(result.issues ?? [])]
      );
    }
    return resolution(reference, current, redirects, 'failed', 'none', undefined, [...accumulatedIssues, resolverIssue('resolver.redirect_budget_exceeded', 'after_input', { limit: this.#maxRedirects })]);
  }
}

export const resolveRelativeResourceRef = (reference: ResourceRef, base: ResourceRef): ResourceRef => ({
  ...reference,
  uri: new URL(reference.uri, base.uri).toString()
});

const schemeOf = (uri: string): string => {
  const separator = uri.indexOf(':');
  return separator === -1 ? '' : uri.slice(0, separator).toLowerCase();
};

const resolution = (
  requested: ResourceRef,
  resolved: ResourceRef,
  redirects: readonly string[],
  state: ResourceLifecycleState,
  freshness: 'current' | 'stale' | 'none',
  value: unknown,
  issues: readonly Issue[]
): ResolvedResource => Object.freeze({
  resourceId: resolved.kind + ':' + resolved.uri,
  requested: Object.freeze({ ...requested }),
  resolved: Object.freeze({ ...resolved }),
  state,
  freshness,
  redirects: Object.freeze([...redirects]),
  ...(state === 'ready' ? { value } : {}),
  issues: Object.freeze([...issues])
});

const resolverIssue = (code: string, retry: 'after_input' | 'after_refresh' | 'after_capability' | 'after_authority', details: unknown): Issue => createIssue({
  code,
  phase: 'resolve',
  severity: 'error',
  retry,
  details
});
