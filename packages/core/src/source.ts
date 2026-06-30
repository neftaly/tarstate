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
  /** Optional opaque identity for the current source snapshot. */
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
 * Build an object source with equality and primitive range lookup support.
 *
 * @remarks Fixture helper only; production adapters should own their index policy.
 */
export function fromIndexedObjectSource(data: Record<string, readonly unknown[]>): RelationSource {
  const indexes = new Map<string, Map<unknown, unknown[]>>();

  return {
    relationNames: Object.keys(data),
    rows: (relationRef) => data[relationRef.name] ?? [],
    lookup: ({ relation: relationRef, field: fieldName, value: lookupValue }) =>
      indexFor(data, indexes, relationRef.name, fieldName).get(lookupValue) ?? [],
    rangeLookup: (lookup) => rangeRowsFor(data, lookup),
    version: () => data
  };
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
    version: async () => Promise.all(sources.map(async (source) => source.version?.()))
  };
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

type OrderedRangeKind = 'number' | 'string';
type OrderedRangeValue = number | string;
type NormalizedRangeBound = {
  readonly value: OrderedRangeValue;
  readonly inclusive: boolean;
};

function rangeRowsFor(
  data: Record<string, readonly unknown[]>,
  lookup: RelationRangeLookup
): readonly unknown[] | undefined {
  if (lookup.lower === undefined && lookup.upper === undefined) {
    return undefined;
  }

  const rangeKind = orderedRangeKindFor(lookup.relation.fields[lookup.field]?.valueKind);

  if (rangeKind === undefined) {
    return undefined;
  }

  const lower = normalizeRangeBound(lookup.lower, rangeKind);
  const upper = normalizeRangeBound(lookup.upper, rangeKind);

  if ((lookup.lower !== undefined && lower === undefined) || (lookup.upper !== undefined && upper === undefined)) {
    return undefined;
  }

  const output: unknown[] = [];

  for (const row of data[lookup.relation.name] ?? []) {
    if (!isRecord(row)) {
      return undefined;
    }

    const value = orderedRangeValue(row[lookup.field], rangeKind);

    if (value === undefined) {
      return undefined;
    }

    if (valueWithinRange(value, lower, upper)) {
      output.push(row);
    }
  }

  return output;
}

function orderedRangeKindFor(valueKind: string | undefined): OrderedRangeKind | undefined {
  switch (valueKind) {
    case 'number':
      return 'number';
    case 'id':
    case 'ref':
    case 'string':
      return 'string';
    default:
      return undefined;
  }
}

function normalizeRangeBound(
  bound: RelationRangeBound | undefined,
  rangeKind: OrderedRangeKind
): NormalizedRangeBound | undefined {
  if (bound === undefined) {
    return undefined;
  }

  const value = orderedRangeValue(bound.value, rangeKind);

  return value === undefined ? undefined : { value, inclusive: bound.inclusive };
}

function orderedRangeValue(value: unknown, rangeKind: OrderedRangeKind): OrderedRangeValue | undefined {
  switch (rangeKind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'string':
      return typeof value === 'string' ? value : undefined;
  }
}

function valueWithinRange(
  value: OrderedRangeValue,
  lower: NormalizedRangeBound | undefined,
  upper: NormalizedRangeBound | undefined
): boolean {
  if (lower !== undefined) {
    const comparison = compareOrderedRangeValues(value, lower.value);
    if (comparison < 0 || (!lower.inclusive && comparison === 0)) {
      return false;
    }
  }

  if (upper !== undefined) {
    const comparison = compareOrderedRangeValues(value, upper.value);
    if (comparison > 0 || (!upper.inclusive && comparison === 0)) {
      return false;
    }
  }

  return true;
}

function compareOrderedRangeValues(left: OrderedRangeValue, right: OrderedRangeValue): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
