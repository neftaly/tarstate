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

/** Read interface used by evaluators and adapters. */
export type RelationSource = {
  /** Relation names this source can read; omit when unknown or dynamic. */
  readonly relationNames?: readonly string[];
  readonly rows: (relation: RelationRef) => MaybePromise<Iterable<unknown>>;
  /** Return `undefined` when this lookup is unsupported; return `[]` for no matches. */
  readonly lookup?: (lookup: RelationLookup) => MaybePromise<Iterable<unknown> | undefined>;
  readonly diagnostics?: () => MaybePromise<Iterable<TarstateDiagnostic>>;
};

/** Build a simple source from relation-name arrays. */
export function fromObjectSource(data: Record<string, readonly unknown[]>): RelationSource {
  return {
    relationNames: Object.keys(data),
    rows: (relationRef) => data[relationRef.name] ?? []
  };
}

/**
 * Build an object source with equality lookup support.
 *
 * @remarks Fixture helper only; production adapters should own their index policy.
 */
export function fromIndexedObjectSource(data: Record<string, readonly unknown[]>): RelationSource {
  const indexes = new Map<string, Map<unknown, unknown[]>>();

  return {
    relationNames: Object.keys(data),
    rows: (relationRef) => data[relationRef.name] ?? [],
    lookup: ({ relation: relationRef, field: fieldName, value: lookupValue }) =>
      indexFor(data, indexes, relationRef.name, fieldName).get(lookupValue) ?? []
  };
}

/**
 * Overlay multiple sources as one read source.
 *
 * @returns Concatenated rows/diagnostics; lookup if any child supports it.
 */
export function composeSources(...sources: readonly RelationSource[]): RelationSource {
  return {
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
        const supported = lookups.filter((rows): rows is Iterable<unknown> => rows !== undefined);
        return supported.length === 0 ? undefined : supported.flatMap((rows) => Array.from(rows));
      });
    },
    diagnostics: async () => {
      const diagnostics = await Promise.all(
        sources.map(async (source) => (source.diagnostics === undefined ? [] : Array.from(await source.diagnostics())))
      );
      return diagnostics.flat();
    }
  };
}

function relevantSources(sources: readonly RelationSource[], relationName: string): readonly RelationSource[] {
  return sources.filter((source) => source.relationNames === undefined || source.relationNames.includes(relationName));
}

function indexFor(
  data: Record<string, readonly unknown[]>,
  indexes: Map<string, Map<unknown, unknown[]>>,
  relationName: string,
  fieldName: string
): Map<unknown, unknown[]> {
  const indexKey = `${relationName}.${fieldName}`;
  const existingIndex = indexes.get(indexKey);

  if (existingIndex !== undefined) {
    return existingIndex;
  }

  const nextIndex = new Map<unknown, unknown[]>();

  for (const row of data[relationName] ?? []) {
    if (!isRecord(row)) {
      continue;
    }

    const value = row[fieldName];
    const rows = nextIndex.get(value);

    if (rows === undefined) {
      nextIndex.set(value, [row]);
    } else {
      rows.push(row);
    }
  }

  indexes.set(indexKey, nextIndex);
  return nextIndex;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
