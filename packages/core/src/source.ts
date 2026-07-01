import { normalizeDiagnostics, type TarstateDiagnostic } from './diagnostics.js';
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
  const operationDiagnostics: TarstateDiagnostic[] = [];

  return {
    relationNames: Array.from(new Set(sources.flatMap((source) => source.relationNames ?? []))),
    rows: async (relation) => {
      const rows: unknown[] = [];
      for (const source of sources) {
        try {
          rows.push(...await source.rows(relation));
        } catch (error) {
          operationDiagnostics.push(...normalizeDiagnostics(error, {
            code: 'source_error',
            message: 'source rows failed',
            relation: relation.name
          }));
        }
      }
      return rows;
    },
    lookup: async (lookup) => {
      const rows: unknown[] = [];
      let supported = false;

      for (const source of sources) {
        if (source.lookup === undefined) {
          continue;
        }

        try {
          const result = await source.lookup(lookup);
          if (result !== undefined) {
            supported = true;
            rows.push(...result);
          }
        } catch (error) {
          supported = true;
          operationDiagnostics.push(...normalizeDiagnostics(error, {
            code: 'source_error',
            message: 'source lookup failed',
            relation: lookup.relation.name,
            field: lookup.field
          }));
        }
      }

      return supported ? rows : undefined;
    },
    rangeLookup: async (lookup) => {
      const rows: unknown[] = [];
      let supported = false;

      for (const source of sources) {
        if (source.rangeLookup === undefined) {
          continue;
        }

        try {
          const result = await source.rangeLookup(lookup);
          if (result !== undefined) {
            supported = true;
            rows.push(...result);
          }
        } catch (error) {
          supported = true;
          operationDiagnostics.push(...normalizeDiagnostics(error, {
            code: 'source_error',
            message: 'source range lookup failed',
            relation: lookup.relation.name,
            field: lookup.field
          }));
        }
      }

      return supported ? rows : undefined;
    },
    version: async () => {
      const versions: unknown[] = [];

      for (const source of sources) {
        if (source.version === undefined) {
          versions.push(undefined);
          continue;
        }

        try {
          versions.push(await source.version());
        } catch (error) {
          versions.push(undefined);
          operationDiagnostics.push(...normalizeDiagnostics(error, {
            code: 'source_error',
            message: 'source version failed'
          }));
        }
      }

      return versions;
    },
    diagnostics: async () => {
      const diagnostics: TarstateDiagnostic[] = [];
      const diagnosticsFailures: TarstateDiagnostic[] = [];

      for (const source of sources) {
        if (source.diagnostics === undefined) {
          continue;
        }

        try {
          diagnostics.push(...await source.diagnostics());
        } catch (error) {
          diagnosticsFailures.push(...normalizeDiagnostics(error, {
            code: 'source_error',
            message: 'source diagnostics failed'
          }));
        }
      }

      return [...diagnostics, ...operationDiagnostics, ...diagnosticsFailures];
    }
  };
}
