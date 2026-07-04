import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { defineSchema, nullable, numberField, optional, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import type { RelationLookup, RelationRangeBound, RelationRangeLookup, RelationSource } from '@tarstate/core/source';
import {
  automergeMapAdapter,
  automergeMapSource,
  defineAutomergeMapRelations,
  type AutomergeMapAdapter
} from '@tarstate/automerge';
import { choose, isRecord, mulberry32 } from './fuzz-helpers.js';

type IndexedRow = {
  readonly id: string;
  readonly bucket?: string | null;
  readonly score?: number | null;
  readonly rank: number;
  readonly note?: string | null;
};

type IndexedDoc = {
  readonly workspace: {
    readonly arrayItems: readonly IndexedRow[];
    readonly mapItemsById: Readonly<Record<string, IndexedRow>>;
  };
};

const schema = defineSchema({
  indexedItems: relation<IndexedRow>({
    key: 'id',
    fields: {
      id: stringField(),
      bucket: optional(nullable(stringField())),
      score: optional(nullable(numberField())),
      rank: numberField(),
      note: optional(nullable(stringField()))
    }
  })
});

const defineIndexedRelations = defineAutomergeMapRelations<IndexedDoc>();
const relations = defineIndexedRelations([
  { relation: schema.indexedItems, path: ['workspace', 'arrayItems'] },
  { relation: schema.indexedItems, path: ['workspace', 'mapItemsById'] }
]);

const seeds = [0x1eed_5001, 0x1eed_5002, 0x1eed_5003] as const;
const lookupFields = ['id', 'bucket', 'score', 'note', 'missing'] as const;
const rangeFields = ['id', 'rank'] as const;
const lookupValues = [
  undefined,
  null,
  '',
  'alpha',
  'beta',
  'map',
  0,
  -0,
  Number.NaN,
  -5,
  5,
  25
] as const;

describe('automerge source lookup index fuzz', () => {
  it.each(seeds)('matches scan oracles for array and map-backed mappings %#', (seed) => {
    const doc = initialDoc(seed);
    const source = automergeMapSource(doc, { relations });

    assertRelationOrder(source, docRows(doc), 'static source');
    assertLookupIndexes(source, seed, 'static source');
    assertRangeIndexes(source, seed, 'static source');
  });

  it.each(seeds)('invalidates lookup and range index caches after adapter mutations %#', async (seed) => {
    const adapter = automergeMapAdapter({ doc: initialDoc(seed, { includeNaN: false }), relations });
    const next = mulberry32(seed);

    assertLookupIndexes(adapter.source, seed, 'initial', { requireNaN: false });
    assertRangeIndexes(adapter.source, seed, 'initial');

    for (let step = 0; step < 18; step += 1) {
      warmIndexes(adapter.source, seed, `seed ${seed} step ${step} warm`, { requireNaN: false });

      if (step % 2 === 0) {
        const row = fuzzRow(seed, step, next);
        const result = await adapter.target.apply([write(schema.indexedItems).insertOrReplace(row)]);
        expect(result.status, `seed ${seed} step ${step} apply status`).toBe('accepted');
      } else {
        mutateMapBackedRows(adapter, seed, step, next);
      }

      assertRelationOrder(adapter.source, docRows(adapter.getDoc()), `seed ${seed} step ${step}`);
      assertLookupIndexes(adapter.source, seed, `seed ${seed} step ${step}`, { requireNaN: false });
      assertRangeIndexes(adapter.source, seed, `seed ${seed} step ${step}`);
    }
  });
});

function assertRelationOrder(source: RelationSource, expectedRows: readonly IndexedRow[], label: string): void {
  const rows = source.rows(schema.indexedItems);
  expect(rows, `${label} row order`).toEqual(expectedRows);
}

function assertLookupIndexes(
  source: RelationSource,
  seed: number,
  label: string,
  options: { readonly requireNaN?: boolean } = {}
): void {
  for (const field of lookupFields) {
    for (const value of lookupValues) {
      const lookup: RelationLookup = { relation: schema.indexedItems, field, value };
      expect(source.lookup?.(lookup), `${label} lookup ${field}=${valueLabel(value)}`).toEqual(
        expectedLookup(source.rows(schema.indexedItems), lookup)
      );
    }
  }

  const rows = source.rows(schema.indexedItems).filter(isRecord);
  const negativeZeroRow = rows.find((row) => Object.is(row.score, -0));
  const positiveZeroRow = rows.find((row) => Object.is(row.score, 0));
  const nanRow = rows.find((row) => typeof row.score === 'number' && Number.isNaN(row.score));

  expect(negativeZeroRow, `${label} has -0 row for seed ${seed}`).toBeDefined();
  expect(positiveZeroRow, `${label} has 0 row for seed ${seed}`).toBeDefined();
  if (options.requireNaN !== false) expect(nanRow, `${label} has NaN row for seed ${seed}`).toBeDefined();
  expect(source.lookup?.({ relation: schema.indexedItems, field: 'score', value: -0 }), `${label} -0 lookup`)
    .toEqual(expectedLookup(source.rows(schema.indexedItems), { relation: schema.indexedItems, field: 'score', value: -0 }));
  expect(source.lookup?.({ relation: schema.indexedItems, field: 'score', value: 0 }), `${label} 0 lookup`)
    .toEqual(expectedLookup(source.rows(schema.indexedItems), { relation: schema.indexedItems, field: 'score', value: 0 }));
  expect(source.lookup?.({ relation: schema.indexedItems, field: 'score', value: Number.NaN }), `${label} NaN lookup`)
    .toEqual(expectedLookup(source.rows(schema.indexedItems), {
      relation: schema.indexedItems,
      field: 'score',
      value: Number.NaN
    }));
}

function assertRangeIndexes(source: RelationSource, seed: number, label: string): void {
  for (const lookup of rangeLookups(seed)) {
    expect(source.rangeLookup?.(lookup), `${label} range ${rangeLabel(lookup)}`).toEqual(
      expectedRangeLookup(source.rows(schema.indexedItems), lookup)
    );
  }
}

function warmIndexes(
  source: RelationSource,
  seed: number,
  label: string,
  options: { readonly requireNaN?: boolean } = {}
): void {
  assertLookupIndexes(source, seed, label, options);
  assertRangeIndexes(source, seed, label);
}

function expectedLookup(rows: readonly unknown[], lookup: RelationLookup): readonly unknown[] {
  return rows.filter((row) => isRecord(row) && Object.is(row[lookup.field], lookup.value));
}

function expectedRangeLookup(rows: readonly unknown[], lookup: RelationRangeLookup): readonly unknown[] {
  return rows.filter((row) => {
    if (!isRecord(row)) return false;
    const value = row[lookup.field];
    if (lookup.lower !== undefined) {
      const comparison = compareRangeValues(value, lookup.lower.value);
      if (comparison < 0 || (comparison === 0 && !lookup.lower.inclusive)) return false;
    }
    if (lookup.upper !== undefined) {
      const comparison = compareRangeValues(value, lookup.upper.value);
      if (comparison > 0 || (comparison === 0 && !lookup.upper.inclusive)) return false;
    }
    return true;
  });
}

function rangeLookups(seed: number): readonly RelationRangeLookup[] {
  const next = mulberry32(seed ^ 0xa11c_e500);
  const fixed: RelationRangeLookup[] = [
    {
      relation: schema.indexedItems,
      field: 'rank',
      lower: { value: -5, inclusive: false },
      upper: { value: 25, inclusive: true }
    },
    {
      relation: schema.indexedItems,
      field: 'id',
      lower: { value: `array-${seed}-`, inclusive: true },
      upper: { value: `map-${seed}-z`, inclusive: false }
    },
    {
      relation: schema.indexedItems,
      field: 'missing'
    },
    { relation: schema.indexedItems, field: 'note' }
  ];

  return [
    ...fixed,
    ...Array.from({ length: 8 }, (): RelationRangeLookup => {
      const field = choose(next, rangeFields);
      const lower = next() > 0.2 ? randomBound(field, next) : undefined;
      const upper = next() > 0.2 ? randomBound(field, next) : undefined;
      return {
        relation: schema.indexedItems,
        field,
        ...(lower === undefined ? {} : { lower }),
        ...(upper === undefined ? {} : { upper })
      };
    })
  ];
}

function randomBound(field: typeof rangeFields[number], next: () => number): RelationRangeBound {
  return {
    value: field === 'id'
      ? choose(next, ['array-', 'array-z', 'map-', 'map-z'] as const)
      : choose(next, [-10, -5, 0, 5, 10, 25, 50] as const),
    inclusive: next() > 0.5
  };
}

function initialDoc(seed: number, options: { readonly includeNaN?: boolean } = {}): Automerge.Doc<IndexedDoc> {
  return Automerge.from({
    workspace: {
      arrayItems: arrayRows(seed, options),
      mapItemsById: Object.fromEntries(mapRows(seed).map((row) => [row.id, row]))
    }
  });
}

function docRows(doc: Automerge.Doc<IndexedDoc>): readonly IndexedRow[] {
  return [
    ...doc.workspace.arrayItems,
    ...Object.values(doc.workspace.mapItemsById)
  ];
}

function arrayRows(seed: number, options: { readonly includeNaN?: boolean } = {}): IndexedRow[] {
  return [
    { id: `array-${seed}-missing`, bucket: 'alpha', rank: -10, note: 'array' },
    { id: `array-${seed}-undefined`, rank: -1 },
    { id: `array-${seed}-negative-zero`, bucket: 'alpha', score: -0, rank: 0, note: null },
    { id: `array-${seed}-nan`, bucket: null, score: options.includeNaN === false ? 10 : Number.NaN, rank: 10, note: 'nan' },
    { id: `array-${seed}-five`, bucket: 'beta', score: 5, rank: 25, note: '' }
  ];
}

function mapRows(seed: number): IndexedRow[] {
  return [
    { id: `map-${seed}-zero`, bucket: 'map', score: 0, rank: 5, note: 'zero' },
    { id: `map-${seed}-missing`, score: -5, rank: -5 },
    { id: `map-${seed}-null`, bucket: null, score: null, rank: 15, note: null },
    { id: `map-${seed}-twenty-five`, bucket: 'beta', score: 25, rank: 50, note: 'map' }
  ];
}

function fuzzRow(seed: number, step: number, next: () => number): IndexedRow {
  const bucket = choose(next, [undefined, null, 'alpha', 'beta', 'map'] as const);
  const score = choose(next, [undefined, null, -5, -0, 0, 5, 25] as const);
  const rank = choose(next, [-10, -5, 0, 5, 10, 25, 50] as const);
  const note = choose(next, [undefined, null, '', 'alpha', 'map', `note-${step}`] as const);
  return {
    id: `array-${seed}-fuzz-${step}`,
    rank,
    ...(bucket === undefined ? {} : { bucket }),
    ...(score === undefined ? {} : { score }),
    ...(note === undefined ? {} : { note })
  };
}

function mutateMapBackedRows(
  adapter: AutomergeMapAdapter<IndexedDoc>,
  seed: number,
  step: number,
  next: () => number
): void {
  adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
    const key = `map-${seed}-fuzz-${step}`;
    (draft.workspace.mapItemsById as Record<string, IndexedRow>)[key] = fuzzRow(seed, step, next);

    const zero = draft.workspace.mapItemsById[`map-${seed}-zero`];
    if (zero !== undefined) {
      const mutableZero = zero as {
        bucket?: string | null;
        score?: number | null;
        rank?: number;
        note?: string | null;
      };
      if (step % 4 === 1) {
        mutableZero.bucket = 'alpha';
        mutableZero.score = -0;
        mutableZero.rank = 10;
        delete mutableZero.note;
      } else {
        delete mutableZero.bucket;
        mutableZero.score = 0;
        mutableZero.rank = 5;
        mutableZero.note = 'zero';
      }
    }
  }));
}

function compareRangeValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return stableKey(left).localeCompare(stableKey(right));
}

function stableKey(input: unknown): string {
  if (input === undefined) return '~undefined';
  if (typeof input === 'number') {
    if (Number.isNaN(input)) return '~number:NaN';
    if (input === Infinity) return '~number:Infinity';
    if (input === -Infinity) return '~number:-Infinity';
    if (Object.is(input, -0)) return '~number:-0';
    return JSON.stringify(input);
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'bigint') return `~bigint:${input.toString()}`;
  if (Array.isArray(input)) return `[${input.map(stableKey).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableKey(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

function rangeLabel(lookup: RelationRangeLookup): string {
  return [
    lookup.field,
    lookup.lower === undefined ? '' : `>=${lookup.lower.inclusive ? '' : '!'}${valueLabel(lookup.lower.value)}`,
    lookup.upper === undefined ? '' : `<=${lookup.upper.inclusive ? '' : '!'}${valueLabel(lookup.upper.value)}`
  ].filter(Boolean).join(' ');
}

function valueLabel(value: unknown): string {
  if (Object.is(value, -0)) return '-0';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  return JSON.stringify(value) ?? '[object]';
}
