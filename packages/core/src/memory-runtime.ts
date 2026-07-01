import type {
  AdapterSnapshot,
  AdapterSource,
  RelationRuntime
} from './adapter.js';
import type { RelationRangeBound, RelationRangeLookup } from './source.js';
import type { RelationRef } from './schema.js';
import { applyWritesAtomic, type MutableObjectSourceData } from './write-apply.js';

export type MemoryRelationRuntimeOptions = {
  readonly relationNames?: readonly string[];
  readonly version?: number;
};

type OrderedRangeKind = 'number' | 'string';
type OrderedRangeValue = number | string;
type NormalizedRangeBound = {
  readonly value: OrderedRangeValue;
  readonly inclusive: boolean;
};

/** Create a small non-durable relation runtime backed by mutable in-memory object rows. */
export function createMemoryRelationRuntime(
  input: Record<string, readonly unknown[]> = {},
  options: MemoryRelationRuntimeOptions = {}
): RelationRuntime<number> {
  const data = cloneMutableData(input);
  const ownedRelationNames = ownedRelationNamesFor(input, options);
  const listeners = new Set<() => void>();
  let version = options.version ?? 0;

  const source = memorySource(data, () => relationNames(data, ownedRelationNames), () => version);

  return {
    source,
    target: {
      ...(ownedRelationNames === undefined
        ? {}
        : {
            relationNames: ownedRelationNames,
            ownsRelation: (relationName: string) => ownedRelationNames.includes(relationName)
          }),
      apply: (patches) => {
        const patchList = [...patches];
        const ownershipDiagnostics = ownershipDiagnosticsFor(patchList, ownedRelationNames);

        if (ownershipDiagnostics.length > 0) {
          return {
            status: 'rejected',
            patches: patchList.length,
            applied: 0,
            deltas: [],
            diagnostics: ownershipDiagnostics,
            durability: 'memory',
            version
          };
        }

        const applied = applyWritesAtomic(data, patchList);

        if (!applied.committed) {
          return {
            status: 'rejected',
            patches: applied.patches,
            applied: 0,
            deltas: [],
            diagnostics: applied.diagnostics,
            durability: 'memory',
            version
          };
        }

        if (applied.deltas.length > 0) {
          version += 1;
          notifyListeners(listeners);
        }

        return {
          status: 'accepted',
          patches: applied.patches,
          applied: applied.applied,
          deltas: applied.deltas,
          diagnostics: applied.diagnostics,
          durability: 'memory',
          version
        };
      }
    },
    snapshot: (): AdapterSnapshot<number> => {
      const snapshotData = cloneMutableData(data);
      const snapshotRelationNames = relationNames(snapshotData, ownedRelationNames);
      const snapshotVersion = version;

      return {
        source: memorySource(snapshotData, () => snapshotRelationNames, () => snapshotVersion),
        version: snapshotVersion
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function memorySource(
  data: MutableObjectSourceData,
  relationNamesForData: () => readonly string[] | undefined,
  version: () => number
): AdapterSource<number> {
  const names = relationNamesForData();

  return {
    ...(names === undefined ? {} : { relationNames: names }),
    rows: (relationRef) => data[relationRef.name] ?? [],
    lookup: ({ relation: relationRef, field, value }) => lookupRows(data, relationRef, field, value),
    rangeLookup: (lookup) => rangeRows(data, lookup),
    version,
    diagnostics: () => []
  };
}

function lookupRows(
  data: MutableObjectSourceData,
  relationRef: RelationRef,
  field: string,
  value: unknown
): readonly unknown[] {
  return (data[relationRef.name] ?? []).filter((row) => isRecord(row) && row[field] === value);
}

function rangeRows(
  data: MutableObjectSourceData,
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

  const rows = data[lookup.relation.name] ?? [];
  const output: unknown[] = [];

  for (const row of rows) {
    if (!isRecord(row)) {
      return undefined;
    }

    const value = row[lookup.field];
    const orderedValue = orderedRangeValue(value, rangeKind);

    if (orderedValue === undefined) {
      return undefined;
    }

    if (rangeContains(orderedValue, lower, upper)) {
      output.push(row);
    }
  }

  return output;
}

function rangeContains(
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

function compareOrderedRangeValues(left: OrderedRangeValue, right: OrderedRangeValue): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function relationNames(
  data: MutableObjectSourceData,
  ownedRelationNames: readonly string[] | undefined
): readonly string[] | undefined {
  if (ownedRelationNames === undefined) {
    return undefined;
  }

  return Array.from(new Set([...ownedRelationNames, ...Object.keys(data)]));
}

function ownedRelationNamesFor(
  input: Record<string, readonly unknown[]>,
  options: MemoryRelationRuntimeOptions
): readonly string[] | undefined {
  const inputRelationNames = Object.keys(input);

  if (options.relationNames === undefined && inputRelationNames.length === 0) {
    return undefined;
  }

  return Array.from(new Set([...(options.relationNames ?? []), ...inputRelationNames]));
}

function ownershipDiagnosticsFor(
  patches: readonly { readonly relation: RelationRef }[],
  ownedRelationNames: readonly string[] | undefined
): readonly {
  readonly code: 'source_error';
  readonly message: string;
  readonly relation: string;
}[] {
  if (ownedRelationNames === undefined) {
    return [];
  }

  return patches.flatMap((patch) =>
    ownedRelationNames.includes(patch.relation.name)
      ? []
      : [{
          code: 'source_error' as const,
          message: `memory runtime does not own relation ${patch.relation.name}`,
          relation: patch.relation.name
        }]
  );
}

function cloneMutableData(input: Record<string, readonly unknown[]>): MutableObjectSourceData {
  const output: MutableObjectSourceData = {};

  for (const [relationName, rows] of Object.entries(input)) {
    output[relationName] = rows.map((row) => (isRecord(row) ? { ...row } : row));
  }

  return output;
}

function notifyListeners(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    listener();
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
