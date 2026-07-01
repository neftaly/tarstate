import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRef } from './schema.js';

export type MaybePromise<T> = T | Promise<T>;

export type RelationLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly value: unknown;
};

export type RelationRangeBound = {
  readonly value: unknown;
  readonly inclusive: boolean;
};

export type RelationRangeLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly lower?: RelationRangeBound;
  readonly upper?: RelationRangeBound;
};

export type RelationSource = {
  readonly relationNames?: readonly string[];
  readonly rows: (relation: RelationRef) => MaybePromise<readonly unknown[]>;
  readonly lookup?: (lookup: RelationLookup) => MaybePromise<readonly unknown[] | undefined>;
  readonly rangeLookup?: (lookup: RelationRangeLookup) => MaybePromise<readonly unknown[] | undefined>;
  readonly version?: () => MaybePromise<unknown>;
  readonly diagnostics?: () => MaybePromise<readonly TarstateDiagnostic[]>;
};

export function fromObjectSource(data: Record<string, readonly unknown[]>): RelationSource {
  return {
    relationNames: Object.keys(data),
    rows: (relation) => data[relation.name] ?? []
  };
}

export function isRelationSource(input: unknown): input is RelationSource {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { readonly rows?: unknown }).rows === 'function';
}

export function composeSources(...sources: readonly RelationSource[]): RelationSource {
  return {
    relationNames: Array.from(new Set(sources.flatMap((source) => source.relationNames ?? []))),
    rows: async (relation) => {
      const rows: unknown[] = [];
      for (const source of sources) {
        rows.push(...await source.rows(relation));
      }
      return rows;
    }
  };
}
