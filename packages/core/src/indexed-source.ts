import type { RelationRangeBound, RelationRangeLookup, RelationSource } from './source.js';

/**
 * Build an object source with equality and primitive range lookup support.
 *
 * @remarks Fixture/planner helper only; production adapters should own index policy.
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
