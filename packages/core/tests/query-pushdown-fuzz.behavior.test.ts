import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import {
  and,
  asc,
  eq,
  from,
  gt,
  gte,
  lt,
  lte,
  neq,
  pipe,
  project,
  sort,
  value,
  where,
  type PredicateData,
  type Query
} from '@tarstate/core/query';
import { type RelationLookup, type RelationRangeLookup, type RelationSource } from '@tarstate/core/source';
import { entry, openingEntries, type Entry } from './behavior-fixtures.js';
import { createSeededRandom, pickSeeded } from './fuzz-helpers.js';

type HookMode = 'exact' | 'superset' | 'decline' | 'missing';
type HookProfile = {
  readonly lookup: HookMode;
  readonly range: HookMode;
};
type RangeOp = 'gt' | 'gte' | 'lt' | 'lte';
type PredicateOrientation = 'direct' | 'reversed';
type ExpectedRangeBound = {
  readonly value: unknown;
  readonly inclusive: boolean;
};
type ExpectedPushdown =
  | {
      readonly kind: 'lookup';
      readonly field: string;
      readonly value: unknown;
    }
  | {
      readonly kind: 'range';
      readonly field: string;
      readonly lower?: ExpectedRangeBound;
      readonly upper?: ExpectedRangeBound;
    };
type PredicateSpec = {
  readonly label: string;
  readonly predicate: PredicateData;
  readonly pushdown?: ExpectedPushdown;
};
type ProjectedEntry = Pick<Entry, 'id' | 'accountId' | 'amount' | 'posted'>;
type InstrumentedReads = {
  rows: number;
  lookup: number;
  range: number;
};
type ObservedPushdown =
  | {
      readonly kind: 'lookup';
      readonly relation: string;
      readonly field: string;
      readonly value: unknown;
    }
  | {
      readonly kind: 'range';
      readonly relation: string;
      readonly field: string;
      readonly lower?: ExpectedRangeBound;
      readonly upper?: ExpectedRangeBound;
    };

const seeds = [0x5151, 0x5152, 0x5153, 0x5154] as const;
const hookModes = ['exact', 'superset', 'decline', 'missing'] as const satisfies readonly HookMode[];
const rangeOps = ['gt', 'gte', 'lt', 'lte'] as const satisfies readonly RangeOp[];
const orientations = ['direct', 'reversed'] as const satisfies readonly PredicateOrientation[];
const accountIds = ['cash', 'sales', 'fees', 'equity', 'tax', 'missing'] as const;
const hookProfiles = hookModes.flatMap((lookupMode) =>
  hookModes.map((rangeMode): HookProfile => ({ lookup: lookupMode, range: rangeMode }))
);

describe('query pushdown seeded fuzz behavior', () => {
  it('matches row-scan results for direct and reversed equality and range predicates', () => {
    for (const seed of seeds) {
      const rows = seededEntries(seed);
      const equalityValue = pickSeeded(accountIds, seed);
      const threshold = amountThreshold(seed);
      const cases = [
        lookupPredicate('direct', equalityValue),
        lookupPredicate('reversed', equalityValue),
        ...rangeOps.flatMap((op) => orientations.map((orientation) => rangePredicate(op, orientation, threshold)))
      ];

      for (const testCase of cases) {
        for (const mode of hookModes) {
          const profile = singleHookProfile(testCase.pushdown.kind, mode);
          expectPushdownCase(`${testCase.label} seed=${seed} mode=${mode}`, rows, testCase.predicate, [
            testCase.pushdown
          ], profile);
        }
      }
    }
  });

  it('matches row-scan results across and() permutations and hook modes', () => {
    for (const seed of seeds) {
      const rows = seededEntries(seed);
      const equality = lookupPredicate(pickSeeded(orientations, seed ^ 0xa11d), pickSeeded(accountIds, seed ^ 0xe9));
      const range = rangePredicate(pickSeeded(rangeOps, seed ^ 0x51), pickSeeded(orientations, seed ^ 0x7a), amountThreshold(seed ^ 0x37));
      const posted: PredicateSpec = {
        label: 'posted neq false',
        predicate: neq(entry.posted, value(false))
      };

      for (const ordered of permutations([equality, range, posted])) {
        const predicate = and(...ordered.map((spec) => spec.predicate));
        const pushdowns = ordered.flatMap((spec) => spec.pushdown === undefined ? [] : [spec.pushdown]);
        for (const profile of hookProfiles) {
          expectPushdownCase(
            `and(${ordered.map((spec) => spec.label).join(', ')}) seed=${seed} lookup=${profile.lookup} range=${profile.range}`,
            rows,
            predicate,
            pushdowns,
            profile
          );
        }
      }
    }
  });
});

function expectPushdownCase(
  label: string,
  rows: readonly Entry[],
  predicate: PredicateData,
  pushdowns: readonly ExpectedPushdown[],
  profile: HookProfile
): void {
  const query = queryFor(predicate);
  const baselineSource = instrumentedSource(rows, { lookup: 'missing', range: 'missing' });
  const baseline = evaluate(baselineSource.source, query);
  expect(baselineSource.reads, `${label} baseline reads`).toEqual({ rows: 1, lookup: 0, range: 0 });

  const pushdownSource = instrumentedSource(rows, profile);
  const actual = evaluate(pushdownSource.source, query);
  const expected = expectedAccess(pushdowns, profile);

  expect(actual, `${label} rows`).toEqual(baseline);
  expect(pushdownSource.reads, `${label} source reads`).toEqual(expected.reads);
  expect(pushdownSource.attempts, `${label} pushdown attempts`).toEqual(expected.attempts);
}

function queryFor(predicate: PredicateData): Query<ProjectedEntry> {
  return pipe(
    from(entry),
    where(predicate),
    sort(asc(entry.id)),
    project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted })
  );
}

function instrumentedSource(rows: readonly Entry[], profile: HookProfile): {
  readonly source: RelationSource;
  readonly reads: InstrumentedReads;
  readonly attempts: ObservedPushdown[];
} {
  const reads: InstrumentedReads = { rows: 0, lookup: 0, range: 0 };
  const attempts: ObservedPushdown[] = [];

  return {
    reads,
    attempts,
    source: {
      rows: (relationRef) => {
        reads.rows += 1;
        return relationRef.name === 'entries' ? rows : [];
      },
      ...(profile.lookup === 'missing'
        ? {}
        : {
            lookup: (lookup) => {
              reads.lookup += 1;
              attempts.push(observedLookup(lookup));
              if (profile.lookup === 'decline') return undefined;
              return profile.lookup === 'exact' ? lookupRows(rows, lookup) : rows;
            }
          }),
      ...(profile.range === 'missing'
        ? {}
        : {
            rangeLookup: (lookup) => {
              reads.range += 1;
              attempts.push(observedRange(lookup));
              if (profile.range === 'decline') return undefined;
              return profile.range === 'exact' ? rangeRows(rows, lookup) : rows;
            }
          })
    }
  };
}

function expectedAccess(pushdowns: readonly ExpectedPushdown[], profile: HookProfile): {
  readonly reads: InstrumentedReads;
  readonly attempts: readonly ObservedPushdown[];
} {
  const reads: InstrumentedReads = { rows: 0, lookup: 0, range: 0 };
  const attempts: ObservedPushdown[] = [];
  for (const pushdown of pushdowns) {
    const mode = profile[pushdown.kind];
    if (mode === 'missing') continue;

    reads[pushdown.kind] += 1;
    attempts.push(expectedObservedPushdown(pushdown));
    if (mode === 'exact' || mode === 'superset') {
      return { reads, attempts };
    }
  }

  reads.rows = 1;
  return { reads, attempts };
}

function lookupPredicate(orientation: PredicateOrientation, lookupValue: string): PredicateSpec & { readonly pushdown: ExpectedPushdown } {
  return {
    label: `eq ${orientation}`,
    predicate: orientation === 'direct'
      ? eq(entry.accountId, value(lookupValue))
      : eq(value<string>(lookupValue), entry.accountId),
    pushdown: { kind: 'lookup', field: 'accountId', value: lookupValue }
  };
}

function rangePredicate(op: RangeOp, orientation: PredicateOrientation, threshold: number): PredicateSpec & { readonly pushdown: ExpectedPushdown } {
  return {
    label: `${op} ${orientation}`,
    predicate: rangePredicateData(op, orientation, threshold),
    pushdown: rangePushdown(op, orientation, threshold)
  };
}

function rangePredicateData(op: RangeOp, orientation: PredicateOrientation, threshold: number): PredicateData {
  switch (op) {
    case 'gt':
      return orientation === 'direct' ? gt(entry.amount, value(threshold)) : gt(value<number>(threshold), entry.amount);
    case 'gte':
      return orientation === 'direct' ? gte(entry.amount, value(threshold)) : gte(value<number>(threshold), entry.amount);
    case 'lt':
      return orientation === 'direct' ? lt(entry.amount, value(threshold)) : lt(value<number>(threshold), entry.amount);
    case 'lte':
      return orientation === 'direct' ? lte(entry.amount, value(threshold)) : lte(value<number>(threshold), entry.amount);
  }
}

function rangePushdown(op: RangeOp, orientation: PredicateOrientation, threshold: number): ExpectedPushdown {
  if (orientation === 'direct') {
    switch (op) {
      case 'gt':
        return { kind: 'range', field: 'amount', lower: { value: threshold, inclusive: false } };
      case 'gte':
        return { kind: 'range', field: 'amount', lower: { value: threshold, inclusive: true } };
      case 'lt':
        return { kind: 'range', field: 'amount', upper: { value: threshold, inclusive: false } };
      case 'lte':
        return { kind: 'range', field: 'amount', upper: { value: threshold, inclusive: true } };
    }
  }

  switch (op) {
    case 'gt':
      return { kind: 'range', field: 'amount', upper: { value: threshold, inclusive: false } };
    case 'gte':
      return { kind: 'range', field: 'amount', upper: { value: threshold, inclusive: true } };
    case 'lt':
      return { kind: 'range', field: 'amount', lower: { value: threshold, inclusive: false } };
    case 'lte':
      return { kind: 'range', field: 'amount', lower: { value: threshold, inclusive: true } };
  }
}

function singleHookProfile(kind: ExpectedPushdown['kind'], mode: HookMode): HookProfile {
  return kind === 'lookup' ? { lookup: mode, range: 'missing' } : { lookup: 'missing', range: mode };
}

function expectedObservedPushdown(pushdown: ExpectedPushdown): ObservedPushdown {
  return pushdown.kind === 'lookup'
    ? { kind: 'lookup', relation: 'entries', field: pushdown.field, value: pushdown.value }
    : {
        kind: 'range',
        relation: 'entries',
        field: pushdown.field,
        ...(pushdown.lower === undefined ? {} : { lower: pushdown.lower }),
        ...(pushdown.upper === undefined ? {} : { upper: pushdown.upper })
      };
}

function observedLookup(lookup: RelationLookup): ObservedPushdown {
  return { kind: 'lookup', relation: lookup.relation.name, field: lookup.field, value: lookup.value };
}

function observedRange(lookup: RelationRangeLookup): ObservedPushdown {
  return {
    kind: 'range',
    relation: lookup.relation.name,
    field: lookup.field,
    ...(lookup.lower === undefined ? {} : { lower: lookup.lower }),
    ...(lookup.upper === undefined ? {} : { upper: lookup.upper })
  };
}

function lookupRows(rows: readonly Entry[], lookup: RelationLookup): readonly Entry[] {
  if (lookup.relation.name !== 'entries') return [];
  return rows.filter((row) => Object.is(rowValue(row, lookup.field), lookup.value));
}

function rangeRows(rows: readonly Entry[], lookup: RelationRangeLookup): readonly Entry[] {
  if (lookup.relation.name !== 'entries') return [];
  return rows.filter((row) => rangeContains(row, lookup));
}

function rangeContains(row: Entry, lookup: RelationRangeLookup): boolean {
  const valueValue = rowValue(row, lookup.field);
  if (typeof valueValue !== 'number') return false;
  if (lookup.lower !== undefined) {
    const lowerValue = lookup.lower.value;
    if (typeof lowerValue !== 'number') return false;
    if (valueValue < lowerValue || (valueValue === lowerValue && !lookup.lower.inclusive)) return false;
  }
  if (lookup.upper !== undefined) {
    const upperValue = lookup.upper.value;
    if (typeof upperValue !== 'number') return false;
    if (valueValue > upperValue || (valueValue === upperValue && !lookup.upper.inclusive)) return false;
  }
  return true;
}

function rowValue(row: Entry, fieldName: string): unknown {
  return (row as unknown as Record<string, unknown>)[fieldName];
}

function seededEntries(seed: number): readonly Entry[] {
  const next = createSeededRandom(seed);
  const rows: Entry[] = openingEntries.map((row) => ({ ...row }));
  for (let index = 0; index < 18; index += 1) {
    const accountId = pickSeeded(accountIds, Math.floor(next() * 0xffff_ffff));
    const amount = Math.floor(next() * 421) - 210;
    rows.push({
      id: `s${seed.toString(16)}_${index}`,
      accountId,
      amount,
      posted: next() >= 0.35,
      ...(next() >= 0.25 ? { memo: `seed-${seed}-${index}` } : {})
    });
  }
  return rows;
}

function amountThreshold(seed: number): number {
  return Math.floor(createSeededRandom(seed ^ 0x71_3a)() * 301) - 150;
}

function permutations<const Value>(values: readonly Value[]): readonly (readonly Value[])[] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [value, ...tail])
  );
}
