import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRef } from './schema.js';

/** Value that may be returned directly or by promise. */
export type MaybePromise<T> = T | Promise<T>;

/** Requested equality lookup for a relation field. */
export type RelationLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly value: unknown;
};

/** Inclusive or exclusive bound for an ordered relation field lookup. */
export type RelationRangeBound = {
  readonly value: unknown;
  readonly inclusive: boolean;
};

/** Requested ordered range lookup for a relation field. */
export type RelationRangeLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly lower?: RelationRangeBound;
  readonly upper?: RelationRangeBound;
};

/** Read interface used by evaluators and adapters. */
export type RelationSource = {
  /** Relation names this source can read; omit when unknown or dynamic. */
  readonly relationNames?: readonly string[];
  readonly rows: (relation: RelationRef) => MaybePromise<Iterable<unknown>>;
  /** Return `undefined` when this lookup is unsupported; return `[]` for no matches. */
  readonly lookup?: (lookup: RelationLookup) => MaybePromise<Iterable<unknown> | undefined>;
  /** Return `undefined` when this range lookup is unsupported; return `[]` for no matches. */
  readonly rangeLookup?: (lookup: RelationRangeLookup) => MaybePromise<Iterable<unknown> | undefined>;
  /** Optional opaque identity for the current source snapshot; `undefined` means the identity is unknown. */
  readonly version?: () => MaybePromise<unknown>;
  readonly diagnostics?: () => MaybePromise<Iterable<TarstateDiagnostic>>;
};

/** Build a simple source from relation-name arrays. */
export function fromObjectSource(data: Record<string, readonly unknown[]>): RelationSource {
  return {
    relationNames: Object.keys(data),
    rows: (relationRef) => data[relationRef.name] ?? [],
    version: () => data
  };
}

export function isRelationSource(input: unknown): input is RelationSource {
  return isRecord(input) && typeof input.rows === 'function';
}

/**
 * Overlay multiple sources as one read source.
 *
 * @returns Concatenated rows/diagnostics; lookup hooks only when every relevant child can answer.
 */
export function composeSources(...sources: readonly RelationSource[]): RelationSource {
  return {
    ...composedRelationNames(sources),
    rows: (relationRef) => {
      const rowSources = relevantSources(sources, relationRef.name);

      if (rowSources.length === 0) {
        return [];
      }

      if (rowSources.length === 1) {
        return rowSources[0]?.rows(relationRef) ?? [];
      }

      return Promise.all(rowSources.map(async (source) => Array.from(await source.rows(relationRef)))).then((rows) =>
        rows.flat()
      );
    },
    lookup: (lookup) => {
      const lookupSources = relevantSources(sources, lookup.relation.name);

      if (lookupSources.length === 0) {
        return undefined;
      }

      if (lookupSources.some((source) => source.lookup === undefined)) {
        return undefined;
      }

      if (lookupSources.length === 1) {
        return lookupSources[0]?.lookup?.(lookup);
      }

      return Promise.all(lookupSources.map(async (source) => source.lookup?.(lookup))).then((lookups) => {
        if (lookups.some((rows) => rows === undefined)) {
          return undefined;
        }

        return lookups.flatMap((rows) => Array.from(rows as Iterable<unknown>));
      });
    },
    rangeLookup: (lookup) => {
      const lookupSources = relevantSources(sources, lookup.relation.name);

      if (lookupSources.length === 0) {
        return undefined;
      }

      if (lookupSources.some((source) => source.rangeLookup === undefined)) {
        return undefined;
      }

      if (lookupSources.length === 1) {
        return lookupSources[0]?.rangeLookup?.(lookup);
      }

      return Promise.all(lookupSources.map(async (source) => source.rangeLookup?.(lookup))).then((lookups) => {
        if (lookups.some((rows) => rows === undefined)) {
          return undefined;
        }

        return lookups.flatMap((rows) => Array.from(rows as Iterable<unknown>));
      });
    },
    diagnostics: async () => {
      const diagnostics = await Promise.all(
        sources.map(async (source) => (source.diagnostics === undefined ? [] : Array.from(await source.diagnostics())))
      );
      return diagnostics.flat();
    },
    ...composedSourceVersion(sources)
  };
}

function composedSourceVersion(sources: readonly RelationSource[]): { readonly version?: () => Promise<unknown> } {
  if (sources.some((source) => source.version === undefined)) {
    return {};
  }

  const memoize = createComposedVersionMemo();

  return {
    version: async () => {
      const versions = await Promise.all(sources.map(async (source) => source.version?.()));
      return versions.some((version) => version === undefined) ? undefined : memoize(versions);
    }
  };
}

function createComposedVersionMemo(): (versions: readonly unknown[]) => readonly unknown[] {
  let cached: readonly unknown[] | undefined;

  return (versions) => {
    if (cached !== undefined && sameVersionTuple(cached, versions)) {
      return cached;
    }

    cached = Object.freeze([...versions]);
    return cached;
  };
}

function sameVersionTuple(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((version, index) => Object.is(version, right[index]));
}

function composedRelationNames(
  sources: readonly RelationSource[]
): { readonly relationNames?: readonly string[] } {
  if (sources.some((source) => source.relationNames === undefined)) {
    return {};
  }

  return {
    relationNames: Array.from(new Set(sources.flatMap((source) => source.relationNames ?? [])))
  };
}

function relevantSources(sources: readonly RelationSource[], relationName: string): readonly RelationSource[] {
  return sources.filter((source) => source.relationNames === undefined || source.relationNames.includes(relationName));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
