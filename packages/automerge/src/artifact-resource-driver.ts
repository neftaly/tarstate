import * as Automerge from '@automerge/automerge';
import {
  artifactCarrierExtraction,
  defaultArtifactCarrierExtractor,
  type ArtifactCarrierExtractor,
  type ResolverDriver
} from '@tarstate/core/artifacts';
import { createIssue, type Issue } from '@tarstate/core';
import { adoptConflictFreeAutomergeJsonValue } from './automerge-json.js';

export type AutomergeArtifactCarrierSnapshot<T extends object, Heads = readonly string[]> =
  | { readonly state: 'ready'; readonly doc: Automerge.Doc<T>; readonly heads: Heads; readonly freshness?: 'current' | 'stale'; readonly issues?: readonly Issue[] }
  | { readonly state: 'loading' | 'missing' | 'failed' | 'deleted' | 'unsupported'; readonly freshness?: 'stale' | 'none'; readonly issues?: readonly Issue[] };

export type AutomergeArtifactCarrierLease<T extends object, Heads = readonly string[]> = {
  readonly waitForSnapshot: (signal?: AbortSignal) => Promise<AutomergeArtifactCarrierSnapshot<T, Heads>>;
  readonly release: () => void | Promise<void>;
};

/** Host-owned structural boundary; no Automerge Repo dependency is required. */
export type AutomergeArtifactCarrierRepo<T extends object, Heads = readonly string[]> = {
  readonly acquire: (uri: string, options: { readonly signal?: AbortSignal }) => Promise<AutomergeArtifactCarrierLease<T, Heads>>;
};

export type InertAutomergeArtifactCarrier = {
  readonly kind: 'automerge-artifact-carrier';
  readonly value: import('@tarstate/core').JsonValue;
  readonly provenance: { readonly heads: readonly string[] };
};

/**
 * Temporary Repo leases are released on ready, unavailable, cancellation, and
 * failure paths. The resolver receives only inert data and exact heads.
 */
export const automergeArtifactResourceDriver = <T extends object, Heads>(options: {
  readonly repo: AutomergeArtifactCarrierRepo<T, Heads>;
  readonly normalizeHeads: (heads: Heads) => readonly string[];
}): ResolverDriver => ({
  resolve: async (reference, context) => {
    if (reference.kind !== 'data') return { state: 'unsupported', freshness: 'none', issues: [driverIssue('resolver.scheme_unsupported', reference.uri, { kind: reference.kind })] };
    if (isAborted(context.signal)) return { state: 'failed', freshness: 'none', issues: [driverIssue('lifecycle.cancelled', reference.uri)] };
    let lease: AutomergeArtifactCarrierLease<T, Heads>;
    try {
      lease = await options.repo.acquire(reference.uri, context.signal === undefined ? {} : { signal: context.signal });
    } catch (error) {
      return { state: 'failed', freshness: 'none', issues: [driverIssue(isAborted(context.signal) ? 'lifecycle.cancelled' : 'resolver.failed', reference.uri, { error: errorName(error) })] };
    }
    let result: Awaited<ReturnType<ResolverDriver['resolve']>>;
    try {
      result = await readLease(lease, reference.uri, context.signal, options.normalizeHeads);
    } catch (error) {
      result = { state: 'failed', freshness: 'none', issues: [driverIssue(isAborted(context.signal) ? 'lifecycle.cancelled' : 'resolver.failed', reference.uri, { error: errorName(error) })] };
    }
    try {
      await lease.release();
    } catch (error) {
      return { state: 'failed', freshness: 'none', issues: [driverIssue('resolver.failed', reference.uri, { reason: 'lease_release_failed', error: errorName(error) })] };
    }
    return result;
  }
});

const readLease = async <T extends object, Heads>(
  lease: AutomergeArtifactCarrierLease<T, Heads>,
  uri: string,
  signal: AbortSignal | undefined,
  normalizeHeads: (heads: Heads) => readonly string[]
): Promise<Awaited<ReturnType<ResolverDriver['resolve']>>> => {
  const snapshot = await lease.waitForSnapshot(signal);
  if (snapshot.state !== 'ready') return {
    state: snapshot.state,
    freshness: snapshot.freshness ?? (snapshot.state === 'loading' ? 'stale' : 'none'),
    ...(snapshot.issues === undefined ? {} : { issues: snapshot.issues })
  };
  if (isAborted(signal)) return { state: 'failed', freshness: 'none', issues: [driverIssue('lifecycle.cancelled', uri)] };
  const value = adoptConflictFreeAutomergeJsonValue(snapshot.doc);
  if (!value.success) return { state: 'failed', freshness: 'none', issues: value.issues };
  let heads: readonly string[];
  try {
    heads = Object.freeze([...normalizeHeads(snapshot.heads)]);
  } catch (error) {
    return { state: 'failed', freshness: 'none', issues: [driverIssue('resolver.failed', uri, { reason: 'heads_invalid', error: errorName(error) })] };
  }
  if (heads.some((head) => typeof head !== 'string')) return { state: 'failed', freshness: 'none', issues: [driverIssue('resolver.failed', uri, { reason: 'heads_invalid' })] };
  const carrier: InertAutomergeArtifactCarrier = Object.freeze({
    kind: 'automerge-artifact-carrier',
    value: value.value,
    provenance: Object.freeze({ heads })
  });
  return {
    state: 'ready',
    freshness: snapshot.freshness ?? 'current',
    value: carrier,
    ...(snapshot.issues === undefined ? {} : { issues: snapshot.issues })
  };
};

export const extractAutomergeArtifactCarrier: ArtifactCarrierExtractor = (input) => {
  if (!isAutomergeCarrier(input.carrier)) return defaultArtifactCarrierExtractor(input);
  return artifactCarrierExtraction(
    defaultArtifactCarrierExtractor({ ...input, carrier: input.carrier.value }),
    { kind: 'automerge-heads', heads: input.carrier.provenance.heads }
  );
};

const isAutomergeCarrier = (value: unknown): value is InertAutomergeArtifactCarrier => value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { readonly kind?: unknown }).kind === 'automerge-artifact-carrier';
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const driverIssue = (code: string, uri: string, details?: unknown): Issue => createIssue({
  code,
  phase: code === 'lifecycle.cancelled' ? 'lifecycle' : 'resolve',
  severity: 'error',
  retry: code === 'lifecycle.cancelled' ? 'never' : code === 'resolver.scheme_unsupported' ? 'after_capability' : 'after_refresh',
  details: { uri, ...(details !== undefined && typeof details === 'object' && details !== null && !Array.isArray(details) ? details : details === undefined ? {} : { value: details }) }
});
