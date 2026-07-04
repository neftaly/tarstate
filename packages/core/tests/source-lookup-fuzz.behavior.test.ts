import { describe, expect, it } from 'vitest';
import {
  composeSources,
  fromObjectSource,
  type RelationLookup,
  type RelationRangeBound,
  type RelationRangeLookup,
  type RelationSource
} from '@tarstate/core/source';
import { schema } from './behavior-fixtures.js';
import { chooseSeeded, createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';

type HookMode = 'handled' | 'declined' | 'missing';

type FuzzSourcePart = {
  readonly lookupMode: HookMode;
  readonly rangeMode: HookMode;
  readonly rows: readonly unknown[];
  readonly lookupRows: readonly unknown[];
  readonly rangeRows: readonly unknown[];
  readonly reads: {
    rows: number;
  };
  readonly source: RelationSource;
};

const seeds = resolveFuzzSeeds([0x500a, 0x500b, 0x500c, 0x500d] as const);
const lookupFields = ['amount', 'accountId', 'memo', 'rank', 'missing'] as const;
const lookupValues = [0, -0, Number.NaN, null, undefined, 'cash', 'fees', true] as const;

describe('source lookup fuzz behavior', () => {
  it('fuzzes object-source equality and range lookup against seeded row scans', () => {
    for (const seed of seeds) {
      const rows = randomSourceRows(seed, 36);
      const source = fromObjectSource({ entries: rows });

      for (const field of lookupFields) {
        for (const value of lookupValues) {
          const lookup = { relation: schema.entries, field, value };
          expect(source.lookup?.(lookup), `seed ${seed} lookup ${field}=${valueLabel(value)}`).toEqual(
            expectedLookup(rows, lookup)
          );
        }
      }

      for (const lookup of rangeLookups(seed)) {
        expect(source.rangeLookup?.(lookup), `seed ${seed} range ${rangeLabel(lookup)}`).toEqual(
          expectedRangeLookup(rows, lookup)
        );
      }
    }
  });

  it('fuzzes composed lookup and range hooks with handled, declined, and missing cases', () => {
    for (const seed of seeds) {
      const parts = sourceParts(seed);
      const source = composeSources(...parts.map((part) => part.source));

      for (const field of lookupFields) {
        for (const value of lookupValues) {
          const lookup = { relation: schema.entries, field, value };
          const beforeReads = parts.map((part) => part.reads.rows);

          expect(source.lookup?.(lookup), `seed ${seed} composed lookup ${field}=${valueLabel(value)}`).toEqual(
            expectedComposedLookup(parts, lookup)
          );
          expect(
            parts.map((part, index) => part.reads.rows - beforeReads[index]!),
            `seed ${seed} composed lookup reads ${field}=${valueLabel(value)}`
          ).toEqual(parts.map((part) => rowsReadForMode(part.lookupMode)));
        }
      }

      for (const lookup of rangeLookups(seed * 97)) {
        const beforeReads = parts.map((part) => part.reads.rows);

        expect(source.rangeLookup?.(lookup), `seed ${seed} composed range ${rangeLabel(lookup)}`).toEqual(
          expectedComposedRangeLookup(parts, lookup)
        );
        expect(
          parts.map((part, index) => part.reads.rows - beforeReads[index]!),
          `seed ${seed} composed range reads ${rangeLabel(lookup)}`
        ).toEqual(parts.map((part) => rowsReadForMode(part.rangeMode)));
      }
    }
  });
});

function sourceParts(seed: number): FuzzSourcePart[] {
  const lookupModes: readonly HookMode[] = ['handled', 'declined', 'missing'];
  const rangeModes: readonly HookMode[] = ['declined', 'missing', 'handled'];
  return lookupModes.map((lookupMode, index) => {
    const rangeMode = rangeModes[index] ?? 'missing';
    const rows = randomSourceRows(seed * 101 + index, 18);
    const lookupRows = randomSourceRows(seed * 211 + index, 12);
    const rangeRows = randomSourceRows(seed * 307 + index, 12);
    const reads = { rows: 0 };
    const source: RelationSource = {
      rows: (relationRef) => {
        reads.rows += 1;
        return relationRef.name === schema.entries.name ? rows : [];
      },
      ...(lookupMode === 'missing'
        ? {}
        : {
            lookup: (lookup: RelationLookup) =>
              lookupMode === 'handled'
                ? expectedLookup(lookupRows, lookup)
                : undefined
          }),
      ...(rangeMode === 'missing'
        ? {}
        : {
            rangeLookup: (lookup: RelationRangeLookup) =>
              rangeMode === 'handled'
                ? expectedRangeLookup(rangeRows, lookup)
                : undefined
          })
    };
    return {
      lookupMode,
      rangeMode,
      rows,
      lookupRows,
      rangeRows,
      reads,
      source
    };
  });
}

function expectedComposedLookup(parts: readonly FuzzSourcePart[], lookup: RelationLookup): readonly unknown[] {
  return parts.flatMap((part) =>
    expectedLookup(part.lookupMode === 'handled' ? part.lookupRows : part.rows, lookup));
}

function expectedComposedRangeLookup(parts: readonly FuzzSourcePart[], lookup: RelationRangeLookup): readonly unknown[] {
  return parts.flatMap((part) =>
    expectedRangeLookup(part.rangeMode === 'handled' ? part.rangeRows : part.rows, lookup));
}

function rowsReadForMode(mode: HookMode): number {
  return mode === 'handled' ? 0 : 1;
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
  const next = createSeededRandom(seed);
  const fixed: RelationRangeLookup[] = [
    {
      relation: schema.entries,
      field: 'amount',
      lower: { value: 0, inclusive: true },
      upper: { value: 10, inclusive: false }
    },
    {
      relation: schema.entries,
      field: 'amount',
      lower: { value: -0, inclusive: false }
    },
    {
      relation: schema.entries,
      field: 'amount',
      upper: { value: Number.NaN, inclusive: true }
    },
    {
      relation: schema.entries,
      field: 'memo',
      lower: { value: null, inclusive: true }
    },
    {
      relation: schema.entries,
      field: 'missing',
      lower: { value: undefined, inclusive: true },
      upper: { value: undefined, inclusive: true }
    },
    {
      relation: schema.entries,
      field: 'rank'
    }
  ];
  return [
    ...fixed,
    ...Array.from({ length: 10 }, (): RelationRangeLookup => {
      const lower = next() > 0.25 ? randomBound(next) : undefined;
      const upper = next() > 0.25 ? randomBound(next) : undefined;
      return {
        relation: schema.entries,
        field: chooseSeeded(next, lookupFields),
        ...(lower === undefined ? {} : { lower }),
        ...(upper === undefined ? {} : { upper })
      };
    })
  ];
}

function randomBound(next: () => number): RelationRangeBound {
  return {
    value: chooseSeeded(next, [0, -0, Number.NaN, null, undefined, -5, 5, 10, 'cash', 'fees'] as const),
    inclusive: next() > 0.5
  };
}

function randomSourceRows(seed: number, count: number): readonly unknown[] {
  const next = createSeededRandom(seed);
  const rows: unknown[] = [
    { id: `zero-${seed}`, amount: 0, accountId: 'cash', memo: null, rank: 0 },
    { id: `negative-zero-${seed}`, amount: -0, accountId: 'cash', memo: 'negative-zero', rank: -0 },
    { id: `nan-${seed}`, amount: Number.NaN, accountId: 'fees', memo: null, rank: Number.NaN },
    { id: `null-${seed}`, amount: null, accountId: null, memo: null, rank: null },
    { id: `missing-amount-${seed}`, accountId: 'cash', memo: 'missing-amount' },
    { id: `missing-account-${seed}`, amount: 5, memo: 'missing-account', rank: 5 },
    'not-a-row',
    null,
    undefined,
    0,
    [{ id: `array-${seed}`, amount: 0 }]
  ];

  for (let index = 0; index < count; index += 1) {
    if (next() < 0.18) {
      rows.push(randomNonRecord(next));
      continue;
    }

    const row: Record<string, unknown> = { id: `r${seed}-${index}` };
    if (next() > 0.18) row.amount = randomFieldValue(next);
    if (next() > 0.18) row.accountId = randomAccountId(next);
    if (next() > 0.18) row.memo = randomMemo(next, seed, index);
    if (next() > 0.18) row.rank = randomFieldValue(next);
    rows.push(row);
  }

  return rows;
}

function randomFieldValue(next: () => number): unknown {
  return chooseSeeded(next, [0, -0, Number.NaN, null, undefined, -10, -5, 5, 10, 25] as const);
}

function randomAccountId(next: () => number): unknown {
  return chooseSeeded(next, ['cash', 'fees', 'sales', null, undefined, 0, -0, Number.NaN] as const);
}

function randomMemo(next: () => number, seed: number, index: number): unknown {
  return chooseSeeded(next, [null, undefined, 'cash', 'fees', `memo-${seed}-${index}`, 0, -0, Number.NaN] as const);
}

function randomNonRecord(next: () => number): unknown {
  return chooseSeeded(next, ['scalar', null, undefined, 0, -0, Number.NaN, true, ['array-row']] as const);
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
  if (typeof input === 'symbol') return `~symbol:${String(input.description)}`;
  if (typeof input === 'function') return `~function:${input.name}`;
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
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.description === undefined ? 'Symbol()' : `Symbol(${value.description})`;
  if (typeof value === 'function') return '[function]';
  return JSON.stringify(value) ?? '[object]';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
