import {
  safeParseArtifactText,
  safeParseArtifactValue,
  type Artifact,
  type ArtifactKind,
  type ArtifactRef
} from './artifacts.js';
import { createIssue, type Issue } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import {
  type ResolvedResource,
  type ResourceLifecycleState,
  type ResourceRef,
  type ResourceResolver
} from './resolver.js';
import type { JsonValue } from './value.js';

export type ExactArtifactResolutionContext = {
  readonly expectedKind: ArtifactKind;
  readonly authorityScope: string;
  readonly signal?: AbortSignal;
};

export type ExactArtifactStore = {
  readonly get: (reference: ArtifactRef, context: ExactArtifactResolutionContext) => unknown;
};

export type ExactArtifactCatalogCandidate =
  | { readonly id: string; readonly value: unknown }
  | { readonly id: string; readonly resource: ResourceRef };

export type ExactArtifactCatalog = {
  readonly candidates: (reference: ArtifactRef, context: ExactArtifactResolutionContext) => readonly ExactArtifactCatalogCandidate[] | Promise<readonly ExactArtifactCatalogCandidate[]>;
};

export type ExactArtifactAttempt = {
  readonly candidateId: string;
  readonly origin: 'embedded' | 'registered' | 'catalog' | 'location';
  readonly state: ResourceLifecycleState;
  readonly freshness: 'current' | 'stale' | 'none';
  readonly resource?: Omit<ResolvedResource, 'value'>;
  readonly provenance?: JsonValue;
  readonly issues: readonly Issue[];
};

export type ExactArtifactResolution =
  | {
      readonly state: 'ready';
      readonly reference: ArtifactRef;
      readonly artifact: Artifact;
      readonly selected: ExactArtifactAttempt;
      readonly attempts: readonly ExactArtifactAttempt[];
    }
  | {
      readonly state: 'unavailable';
      readonly reference: ArtifactRef;
      readonly attempts: readonly ExactArtifactAttempt[];
      readonly issues: readonly Issue[];
    };

export type ArtifactCarrierExtractor = (input: {
  readonly carrier: unknown;
  readonly reference: ArtifactRef;
  readonly expectedKind: ArtifactKind;
  readonly resource?: ResolvedResource;
}) => unknown;

export type ArtifactCarrierExtraction = {
  readonly kind: 'artifact-carrier-extraction';
  readonly value: unknown;
  readonly provenance?: JsonValue;
};

export const artifactCarrierExtraction = (value: unknown, provenance?: JsonValue): ArtifactCarrierExtraction => {
  const owned = provenance === undefined ? undefined : detachAndFreezeJsonValue(provenance);
  if (owned !== undefined && !owned.success) throw new TypeError('Artifact carrier provenance must be portable JSON');
  return Object.freeze({
    kind: 'artifact-carrier-extraction',
    value,
    ...(owned === undefined ? {} : { provenance: owned.value })
  });
};

/** Resolves availability candidates, then independently verifies exact artifact identity. */
export class ExactArtifactResolver {
  readonly #resourceResolver: ResourceResolver;
  readonly #embedded: ExactArtifactStore | undefined;
  readonly #registered: ExactArtifactStore | undefined;
  readonly #catalogs: readonly ExactArtifactCatalog[];
  readonly #extract: ArtifactCarrierExtractor;

  constructor(options: {
    readonly resourceResolver: ResourceResolver;
    readonly embedded?: ExactArtifactStore;
    readonly registered?: ExactArtifactStore;
    readonly catalogs?: readonly ExactArtifactCatalog[];
    readonly extract?: ArtifactCarrierExtractor;
  }) {
    this.#resourceResolver = options.resourceResolver;
    this.#embedded = options.embedded;
    this.#registered = options.registered;
    this.#catalogs = Object.freeze([...(options.catalogs ?? [])]);
    this.#extract = options.extract ?? defaultArtifactCarrierExtractor;
  }

  async resolve(input: {
    readonly expectedKind: ArtifactKind;
    readonly reference: ArtifactRef;
    readonly authorityScope: string;
    readonly signal?: AbortSignal;
  }): Promise<ExactArtifactResolution> {
    const attempts: ExactArtifactAttempt[] = [];
    const context: ExactArtifactResolutionContext = Object.freeze({
      expectedKind: input.expectedKind,
      authorityScope: input.authorityScope,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
    const stores = [
      ...(this.#embedded === undefined ? [] : [{ origin: 'embedded' as const, id: 'embedded', store: this.#embedded }]),
      ...(this.#registered === undefined ? [] : [{ origin: 'registered' as const, id: 'registered', store: this.#registered }])
    ];
    for (const candidate of stores) {
      if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
      let value: unknown;
      try {
        value = await candidate.store.get(input.reference, context);
      } catch (error) {
        if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
        attempts.push(failedAttempt(candidate.id, candidate.origin, resolutionIssue('resolver.failed', candidate.id, { error: errorName(error) })));
        continue;
      }
      if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
      if (value === undefined) {
        attempts.push(missingAttempt(candidate.id, candidate.origin));
        continue;
      }
      const verified = await verifyCarrier(value, input.expectedKind, input.reference, this.#extract, undefined, input.signal);
      const attempt = attemptFromVerification(candidate.id, candidate.origin, verified);
      attempts.push(attempt);
      if (verified.success) return readyResolution(input.reference, verified.artifact, attempt, attempts);
    }
    for (const [catalogIndex, catalog] of this.#catalogs.entries()) {
      if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
      let candidates: readonly ExactArtifactCatalogCandidate[];
      try {
        candidates = await catalog.candidates(input.reference, context);
      } catch (error) {
        if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
        attempts.push(failedAttempt('catalog:' + catalogIndex, 'catalog', resolutionIssue('resolver.failed', 'catalog:' + catalogIndex, { error: errorName(error) })));
        continue;
      }
      if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
        const id = 'catalog:' + catalogIndex + ':' + candidateIndex + ':' + candidate.id;
        const resolved = 'resource' in candidate
          ? await this.#resolveResource(id, 'catalog', candidate.resource, input, attempts)
          : await this.#verifyValue(id, 'catalog', candidate.value, input, attempts);
        if (resolved !== undefined) return resolved;
        if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
      }
    }
    for (const [index, uri] of (input.reference.locations ?? []).entries()) {
      if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
      const id = 'location:' + index + ':' + uri;
      const resolved = await this.#resolveResource(id, 'location', { uri, kind: 'data' }, input, attempts);
      if (resolved !== undefined) return resolved;
      if (isAborted(input.signal)) return unavailableResolution(input.reference, attempts, [cancelledIssue()]);
    }
    return unavailableResolution(input.reference, attempts);
  }

  async #verifyValue(
    id: string,
    origin: ExactArtifactAttempt['origin'],
    value: unknown,
    input: { readonly expectedKind: ArtifactKind; readonly reference: ArtifactRef; readonly signal?: AbortSignal },
    attempts: ExactArtifactAttempt[]
  ): Promise<ExactArtifactResolution | undefined> {
    const verified = await verifyCarrier(value, input.expectedKind, input.reference, this.#extract, undefined, input.signal);
    const attempt = attemptFromVerification(id, origin, verified);
    attempts.push(attempt);
    return verified.success ? readyResolution(input.reference, verified.artifact, attempt, attempts) : undefined;
  }

  async #resolveResource(
    id: string,
    origin: ExactArtifactAttempt['origin'],
    reference: ResourceRef,
    input: { readonly expectedKind: ArtifactKind; readonly reference: ArtifactRef; readonly authorityScope: string; readonly signal?: AbortSignal },
    attempts: ExactArtifactAttempt[]
  ): Promise<ExactArtifactResolution | undefined> {
    let resource: ResolvedResource;
    try {
      resource = await this.#resourceResolver.resolve(reference, {
        authorityScope: input.authorityScope,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
    } catch (error) {
      attempts.push(failedAttempt(id, origin, resolutionIssue('resolver.failed', id, { error: errorName(error) })));
      return undefined;
    }
    if (isAborted(input.signal)) return undefined;
    if (resource.state !== 'ready') {
      attempts.push(attemptFromResource(id, origin, resource));
      return undefined;
    }
    const verified = await verifyCarrier(resource.value, input.expectedKind, input.reference, this.#extract, resource, input.signal);
    const attempt = attemptFromResource(id, origin, resource, verified.success ? [] : verified.issues, verified.success ? 'ready' : 'failed', verified.provenance);
    attempts.push(attempt);
    return verified.success ? readyResolution(input.reference, verified.artifact, attempt, attempts) : undefined;
  }
}

export const defaultArtifactCarrierExtractor: ArtifactCarrierExtractor = ({ carrier, reference }) => {
  if (!isRecord(carrier)) return carrier;
  if (isArtifactEnvelope(carrier)) return carrier;
  const artifacts = carrier.artifacts;
  if (Array.isArray(artifacts)) return artifacts.find((candidate) => isRecord(candidate) && candidate.id === reference.id && candidate.contentHash === reference.contentHash);
  if (isRecord(artifacts)) return artifacts[reference.id + '@' + reference.contentHash] ?? artifacts[reference.contentHash] ?? artifacts[reference.id];
  return carrier;
};

type CarrierVerification =
  | { readonly success: true; readonly artifact: Artifact; readonly provenance?: JsonValue }
  | { readonly success: false; readonly issues: readonly Issue[]; readonly provenance?: JsonValue };

const verifyCarrier = async (
  carrier: unknown,
  expectedKind: ArtifactKind,
  reference: ArtifactRef,
  extract: ArtifactCarrierExtractor,
  resource?: ResolvedResource,
  signal?: AbortSignal
): Promise<CarrierVerification> => {
  if (isAborted(signal)) return { success: false, issues: [cancelledIssue()] };
  let extracted: unknown;
  try {
    extracted = await extract({ carrier, reference, expectedKind, ...(resource === undefined ? {} : { resource }) });
  } catch (error) {
    return { success: false, issues: [resolutionIssue('artifact.dependency_mismatch', reference.id, { reason: 'carrier_extraction_failed', error: errorName(error) })] };
  }
  if (isAborted(signal)) return { success: false, issues: [cancelledIssue()] };
  let extraction: ArtifactCarrierExtraction;
  try {
    extraction = isArtifactCarrierExtraction(extracted)
      ? artifactCarrierExtraction(extracted.value, extracted.provenance)
      : artifactCarrierExtraction(extracted);
  } catch (error) {
    return { success: false, issues: [resolutionIssue('artifact.dependency_mismatch', reference.id, { reason: 'carrier_provenance_invalid', error: errorName(error) })] };
  }
  if (extraction.value === undefined) return { success: false, issues: [resolutionIssue('artifact.dependency_mismatch', reference.id, { reason: 'artifact_absent_in_carrier' })], ...(extraction.provenance === undefined ? {} : { provenance: extraction.provenance }) };
  const parsed = typeof extraction.value === 'string' ? await safeParseArtifactText(extraction.value) : await safeParseArtifactValue(extraction.value);
  if (isAborted(signal)) return { success: false, issues: [cancelledIssue()], ...(extraction.provenance === undefined ? {} : { provenance: extraction.provenance }) };
  if (!parsed.success) return { ...parsed, ...(extraction.provenance === undefined ? {} : { provenance: extraction.provenance }) };
  const artifact = parsed.value;
  if (artifact.kind !== expectedKind || artifact.id !== reference.id || artifact.contentHash !== reference.contentHash) {
    return { success: false, issues: [resolutionIssue('artifact.dependency_mismatch', reference.id, {
      expected: { kind: expectedKind, id: reference.id, contentHash: reference.contentHash },
      actual: { kind: artifact.kind, id: artifact.id, contentHash: artifact.contentHash }
    })], ...(extraction.provenance === undefined ? {} : { provenance: extraction.provenance }) };
  }
  return { success: true, artifact, ...(extraction.provenance === undefined ? {} : { provenance: extraction.provenance }) };
};

const readyResolution = (reference: ArtifactRef, artifact: Artifact, selected: ExactArtifactAttempt, attempts: readonly ExactArtifactAttempt[]): ExactArtifactResolution => Object.freeze({
  state: 'ready',
  reference: Object.freeze({ ...reference, ...(reference.locations === undefined ? {} : { locations: Object.freeze([...reference.locations]) }) }),
  artifact,
  selected,
  attempts: Object.freeze([...attempts])
});

const unavailableResolution = (
  reference: ArtifactRef,
  attempts: readonly ExactArtifactAttempt[],
  extraIssues: readonly Issue[] = []
): ExactArtifactResolution => Object.freeze({
  state: 'unavailable',
  reference: Object.freeze({ ...reference, ...(reference.locations === undefined ? {} : { locations: Object.freeze([...reference.locations]) }) }),
  attempts: Object.freeze([...attempts]),
  issues: Object.freeze([...attempts.flatMap(({ issues }) => issues), ...extraIssues])
});

const attemptFromVerification = (candidateId: string, origin: ExactArtifactAttempt['origin'], verified: CarrierVerification): ExactArtifactAttempt => Object.freeze({
  candidateId,
  origin,
  state: verified.success ? 'ready' : 'failed',
  freshness: verified.success ? 'current' : 'none',
  ...(verified.provenance === undefined ? {} : { provenance: verified.provenance }),
  issues: Object.freeze(verified.success ? [] : [...verified.issues])
});

const attemptFromResource = (
  candidateId: string,
  origin: ExactArtifactAttempt['origin'],
  resource: ResolvedResource,
  extraIssues: readonly Issue[] = [],
  state: ResourceLifecycleState = resource.state,
  provenance?: JsonValue
): ExactArtifactAttempt => Object.freeze({
  candidateId,
  origin,
  state,
  freshness: state === 'failed' ? 'none' : resource.freshness,
  resource: Object.freeze({
    resourceId: resource.resourceId,
    requested: resource.requested,
    resolved: resource.resolved,
    state: resource.state,
    freshness: resource.freshness,
    redirects: resource.redirects,
    issues: resource.issues
  }),
  ...(provenance === undefined ? {} : { provenance }),
  issues: Object.freeze([...resource.issues, ...extraIssues])
});

const missingAttempt = (candidateId: string, origin: 'embedded' | 'registered'): ExactArtifactAttempt => Object.freeze({ candidateId, origin, state: 'missing', freshness: 'none', issues: Object.freeze([]) });
const failedAttempt = (candidateId: string, origin: ExactArtifactAttempt['origin'], issue: Issue): ExactArtifactAttempt => Object.freeze({ candidateId, origin, state: 'failed', freshness: 'none', issues: Object.freeze([issue]) });
const resolutionIssue = (code: string, candidateId: string, details: unknown): Issue => createIssue({ code, phase: 'resolve', severity: 'error', retry: code.startsWith('resolver.') ? 'after_refresh' : 'after_input', details: { candidateId, ...(isRecord(details) ? details : { value: details }) } });
const cancelledIssue = (): Issue => createIssue({ code: 'lifecycle.cancelled', phase: 'lifecycle', severity: 'error', retry: 'never' });
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const isRecord = (value: unknown): value is Readonly<Record<string, any>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isArtifactCarrierExtraction = (value: unknown): value is ArtifactCarrierExtraction => isRecord(value)
  && value.kind === 'artifact-carrier-extraction'
  && Object.hasOwn(value, 'value');
const isArtifactEnvelope = (value: Readonly<Record<string, unknown>>): boolean => typeof value.kind === 'string' && typeof value.id === 'string' && typeof value.contentHash === 'string' && 'body' in value;
