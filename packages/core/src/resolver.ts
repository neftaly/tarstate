import { isContentHash } from './canonical-json.js';
import { createIssue, type Issue } from './issues.js';
import { stringTupleKey } from './internal-string-key.js';

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

type ResolutionContext = {
  readonly authorityScope: string;
  readonly signal?: AbortSignal;
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
  readonly #maxInflightResolutions: number;

  constructor(options: {
    readonly authority: ResolverAuthority;
    readonly maxRedirects?: number;
    readonly maxCacheEntries?: number;
    /** Maximum shared, un-signalled driver requests retained for deduplication. */
    readonly maxInflightResolutions?: number;
  }) {
    this.#authority = options.authority;
    this.#maxRedirects = options.maxRedirects ?? 16;
    this.#maxCacheEntries = options.maxCacheEntries ?? 256;
    this.#maxInflightResolutions = options.maxInflightResolutions ?? 256;
    if (!Number.isSafeInteger(this.#maxRedirects) || this.#maxRedirects < 0) throw new TypeError('maxRedirects must be a non-negative safe integer');
    if (!Number.isSafeInteger(this.#maxCacheEntries) || this.#maxCacheEntries < 0) throw new TypeError('maxCacheEntries must be a non-negative safe integer');
    if (!Number.isSafeInteger(this.#maxInflightResolutions) || this.#maxInflightResolutions < 1) throw new TypeError('maxInflightResolutions must be a positive safe integer');
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

  /**
   * Signal-bound resolutions bypass shared cache reads, writes, and in-flight
   * deduplication so one caller cannot cancel another. Other terminal results
   * remain in the bounded LRU until eviction, registration, or `invalidate()`.
   */
  resolve<Value = unknown>(reference: ResourceRef, options: {
    readonly authorityScope: string;
    readonly signal?: AbortSignal;
    readonly bypassCache?: boolean;
  }): Promise<ResolvedResource<Value>> {
    const requested = adoptResourceRef(reference, 'reference');
    const context = adoptResolutionContext(options);
    const bypassCache = ownDataProperty(options, 'bypassCache');
    const key = resourceCacheKey(context.authorityScope, requested);
    const useCache = bypassCache !== true && context.signal === undefined;
    if (useCache) {
      const cached = this.#cache.get(key);
      if (cached !== undefined) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return Promise.resolve(cached as ResolvedResource<Value>);
      }
      const inflight = this.#inflight.get(key);
      if (inflight !== undefined) return inflight as Promise<ResolvedResource<Value>>;
      if (this.#inflight.size >= this.#maxInflightResolutions) {
        return Promise.resolve(resolution(
          requested,
          requested,
          [],
          'failed',
          'none',
          undefined,
          [resolverIssue('resolver.capacity_exhausted', 'after_refresh', { capacity: this.#maxInflightResolutions })]
        )) as Promise<ResolvedResource<Value>>;
      }
    }
    const pending = this.#resolve(requested, context);
    if (useCache) {
      this.#inflight.set(key, pending);
      void pending.then(
        (resolved) => {
          if (this.#inflight.get(key) !== pending) return;
          this.#inflight.delete(key);
          if (resolved.state !== 'loading') this.#remember(key, resolved);
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
    const prefix = authorityCachePrefix(authorityScope);
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

  async #resolve(reference: ResourceRef, context: ResolutionContext): Promise<ResolvedResource> {
    const redirects: string[] = [];
    const accumulatedIssues: Issue[] = [];
    const visited = new Set<string>();
    let current = reference;
    for (let depth = 0; depth <= this.#maxRedirects; depth += 1) {
      if (signalAborted(context.signal)) {
        return cancelledResolution(reference, current, redirects, accumulatedIssues);
      }
      let currentPermitted: boolean;
      try {
        currentPermitted = this.#authority.permits(context.authorityScope, current);
      } catch (error) {
        return authorityFailureResolution(
          reference,
          current,
          redirects,
          accumulatedIssues,
          error
        );
      }
      if (!currentPermitted) {
        return resolution(reference, current, redirects, 'denied', 'none', undefined, [...accumulatedIssues, resolverIssue('resolver.authority_denied', 'after_authority', { uri: current.uri })]);
      }
      const identity = stringTupleKey(current.kind, current.uri);
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
        result = await driver.resolve(current, context);
      } catch (error) {
        if (signalAborted(context.signal)) {
          return cancelledResolution(reference, current, redirects, accumulatedIssues);
        }
        result = {
          state: 'failed',
          freshness: 'none',
          issues: [resolverIssue('resolver.failed', 'after_refresh', { uri: current.uri, error: error instanceof Error ? error.name : typeof error })]
        };
      }
      if (signalAborted(context.signal)) {
        return cancelledResolution(reference, current, redirects, accumulatedIssues);
      }
      if (result.state === 'redirect') {
        accumulatedIssues.push(...(result.issues ?? []));
        redirects.push(current.uri);
        const target = tryAdoptResourceRef(result.target);
        if (target === undefined) {
          return invalidDriverReference(reference, current, redirects, accumulatedIssues, 'redirect_target');
        }
        if (current.integrity !== undefined && target.integrity !== undefined && current.integrity !== target.integrity) {
          return resolution(reference, current, redirects, 'failed', 'none', undefined, [
            ...accumulatedIssues,
            resolverIssue('resolver.integrity_mismatch', 'after_refresh', { expected: current.integrity, actual: target.integrity })
          ]);
        }
        current = withIntegrity(target, current.integrity);
        continue;
      }
      const driverResolved = result.resolved === undefined ? current : tryAdoptResourceRef(result.resolved);
      if (driverResolved === undefined) {
        return invalidDriverReference(reference, current, redirects, [...accumulatedIssues, ...(result.issues ?? [])], 'resolved');
      }
      if (current.integrity !== undefined && driverResolved.integrity !== undefined && current.integrity !== driverResolved.integrity) {
        return resolution(reference, current, redirects, 'failed', 'none', undefined, [
          ...accumulatedIssues,
          ...(result.issues ?? []),
          resolverIssue('resolver.integrity_mismatch', 'after_refresh', { expected: current.integrity, actual: driverResolved.integrity })
        ]);
      }
      const resolved = withIntegrity(driverResolved, current.integrity);
      if (!sameResourceRef(current, resolved)) {
        let resolvedPermitted: boolean;
        try {
          resolvedPermitted = this.#authority.permits(context.authorityScope, resolved);
        } catch (error) {
          return authorityFailureResolution(
            reference,
            resolved,
            redirects,
            [...accumulatedIssues, ...(result.issues ?? [])],
            error
          );
        }
        if (!resolvedPermitted) {
          return resolution(reference, resolved, redirects, 'denied', 'none', undefined, [
            ...accumulatedIssues,
            ...(result.issues ?? []),
            resolverIssue('resolver.authority_denied', 'after_authority', { uri: resolved.uri })
          ]);
        }
      }
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

/** Resolves through the platform URL grammar and throws `TypeError` for malformed references. */
export const resolveRelativeResourceRef = (reference: ResourceRef, base: ResourceRef): ResourceRef => ({
  ...reference,
  uri: new URL(reference.uri, base.uri).toString()
});

const schemeOf = (uri: string): string => {
  const separator = uri.indexOf(':');
  return separator === -1 ? '' : uri.slice(0, separator).toLowerCase();
};

const resourceKinds: readonly ResourceKind[] = ['bytes', 'data', 'schema', 'constraint', 'document', 'executable-code'];

const tryAdoptResourceRef = (value: unknown): ResourceRef | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let uri: unknown;
  let kind: unknown;
  let integrity: unknown;
  try {
    uri = ownDataProperty(value, 'uri', true);
    kind = ownDataProperty(value, 'kind', true);
    integrity = ownDataProperty(value, 'integrity');
  } catch {
    return undefined;
  }
  if (typeof uri !== 'string' || typeof kind !== 'string' || !resourceKinds.includes(kind as ResourceKind)) return undefined;
  if (integrity !== undefined && !isContentHash(integrity)) return undefined;
  return Object.freeze({
    uri,
    kind: kind as ResourceKind,
    ...(integrity === undefined ? {} : { integrity: integrity as `sha256:${string}` })
  });
};

const adoptResourceRef = (value: unknown, label: string): ResourceRef => {
  const adopted = tryAdoptResourceRef(value);
  if (adopted === undefined) throw new TypeError(label + ' must be a resource reference with own data properties');
  return adopted;
};

const adoptResolutionContext = (options: {
  readonly authorityScope: string;
  readonly signal?: AbortSignal;
}): ResolutionContext => {
  const authorityScope = ownDataProperty(options, 'authorityScope');
  const signal = ownDataProperty(options, 'signal');
  if (typeof authorityScope !== 'string') throw new TypeError('authorityScope must be an own string data property');
  return Object.freeze({
    authorityScope,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal })
  });
};

const ownDataProperty = (value: object, key: string, required = false): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) throw new TypeError(key + ' must be an own data property');
    return undefined;
  }
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(key + ' must be an enumerable data property');
  return descriptor.value;
};

const withIntegrity = (reference: ResourceRef, integrity: ResourceRef['integrity']): ResourceRef => integrity === undefined
  ? reference
  : Object.freeze({ uri: reference.uri, kind: reference.kind, integrity });

const sameResourceRef = (left: ResourceRef, right: ResourceRef): boolean =>
  left.uri === right.uri && left.kind === right.kind && left.integrity === right.integrity;

const encodeKeyPart = (value: string): string => value.length + ':' + value;
const authorityCachePrefix = (authorityScope: string): string => encodeKeyPart(authorityScope);
const resourceCacheKey = (authorityScope: string, reference: ResourceRef): string =>
  authorityCachePrefix(authorityScope)
  + encodeKeyPart(reference.kind)
  + encodeKeyPart(reference.uri)
  + (reference.integrity === undefined ? '0' : '1' + encodeKeyPart(reference.integrity));

const invalidDriverReference = (
  requested: ResourceRef,
  resolved: ResourceRef,
  redirects: readonly string[],
  issues: readonly Issue[],
  field: 'redirect_target' | 'resolved'
): ResolvedResource => resolution(requested, resolved, redirects, 'failed', 'none', undefined, [
  ...issues,
  resolverIssue('resolver.failed', 'after_refresh', { uri: resolved.uri, reason: 'invalid_driver_reference', field })
]);

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

const cancelledResolution = (
  requested: ResourceRef,
  resolved: ResourceRef,
  redirects: readonly string[],
  issues: readonly Issue[]
): ResolvedResource => resolution(
  requested,
  resolved,
  redirects,
  'failed',
  'none',
  undefined,
  [...issues, createIssue({
    code: 'lifecycle.cancelled',
    phase: 'lifecycle',
    severity: 'error',
    retry: 'never'
  })]
);

const authorityFailureResolution = (
  requested: ResourceRef,
  resolved: ResourceRef,
  redirects: readonly string[],
  issues: readonly Issue[],
  error: unknown
): ResolvedResource => resolution(
  requested,
  resolved,
  redirects,
  'failed',
  'none',
  undefined,
  [...issues, resolverIssue('resolver.failed', 'after_authority', {
    uri: resolved.uri,
    reason: 'authority_check_failed',
    error: error instanceof Error ? error.name : typeof error
  })]
);

const resolverIssue = (code: string, retry: 'after_input' | 'after_refresh' | 'after_capability' | 'after_authority', details: unknown): Issue => createIssue({
  code,
  phase: 'resolve',
  severity: 'error',
  retry,
  details
});

const signalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
