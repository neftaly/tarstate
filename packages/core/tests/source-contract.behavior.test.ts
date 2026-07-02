import { describe, expect, it } from 'vitest';
import { composeSources, fromObjectSource, type RelationSource } from '@tarstate/core/source';
import { schema } from './behavior-fixtures.js';

describe('source contracts', () => {
  it('looks up object rows by relation and field with Object.is equality', () => {
    const zeroRow = { id: 'zero', amount: 0, accountId: 'cash' };
    const negativeZeroRow = { id: 'negative-zero', amount: -0, accountId: 'cash' };
    const nanRow = { id: 'nan', amount: Number.NaN, accountId: 'fees' };
    const accountRow = { id: 'cash', amount: Number.NaN };
    const source = fromObjectSource({
      entries: [zeroRow, negativeZeroRow, nanRow, 'not-a-row'],
      accounts: [accountRow]
    });

    expect(source.relationNames).toEqual(['entries', 'accounts']);
    expect(source.lookup?.({ relation: schema.entries, field: 'accountId', value: 'cash' })).toEqual([
      zeroRow,
      negativeZeroRow
    ]);
    expect(source.lookup?.({ relation: schema.entries, field: 'amount', value: 0 })).toEqual([zeroRow]);
    expect(source.lookup?.({ relation: schema.entries, field: 'amount', value: Number.NaN })).toEqual([nanRow]);
    expect(source.lookup?.({ relation: schema.accounts, field: 'amount', value: Number.NaN })).toEqual([accountRow]);
  });

  it('applies range lookup bounds against object source rows', () => {
    const below = { id: 'below', amount: -1 };
    const lower = { id: 'lower', amount: 0 };
    const middle = { id: 'middle', amount: 5 };
    const upper = { id: 'upper', amount: 10 };
    const source = fromObjectSource({
      entries: [below, lower, middle, upper, 'not-a-row']
    });

    expect(source.rangeLookup?.({
      relation: schema.entries,
      field: 'amount',
      lower: { value: 0, inclusive: true },
      upper: { value: 10, inclusive: false }
    })).toEqual([lower, middle]);
    expect(source.rangeLookup?.({
      relation: schema.entries,
      field: 'amount',
      lower: { value: 0, inclusive: false }
    })).toEqual([middle, upper]);
    expect(source.rangeLookup?.({
      relation: schema.entries,
      field: 'amount',
      upper: { value: 0, inclusive: true }
    })).toEqual([below, lower]);
  });

  it('composes lookup hooks with fallback scans when hooks are missing or decline', () => {
    const indexedRow = { id: 'indexed', accountId: 'cash' };
    const declinedMatch = { id: 'declined-match', accountId: 'cash' };
    const declinedMiss = { id: 'declined-miss', accountId: 'sales' };
    const unhookedMatch = { id: 'unhooked-match', accountId: 'cash' };
    const unhookedMiss = { id: 'unhooked-miss', accountId: 'sales' };
    let indexedRowsRead = 0;
    let declinedRowsRead = 0;
    let unhookedRowsRead = 0;
    const indexed: RelationSource = {
      rows: () => {
        indexedRowsRead += 1;
        return [indexedRow];
      },
      lookup: () => [indexedRow]
    };
    const declined: RelationSource = {
      rows: () => {
        declinedRowsRead += 1;
        return [declinedMatch, declinedMiss, 'not-a-row'];
      },
      lookup: () => undefined
    };
    const unhooked: RelationSource = {
      rows: () => {
        unhookedRowsRead += 1;
        return [unhookedMatch, unhookedMiss];
      }
    };

    const source = composeSources(indexed, declined, unhooked);

    expect(source.lookup?.({ relation: schema.entries, field: 'accountId', value: 'cash' })).toEqual([
      indexedRow,
      declinedMatch,
      unhookedMatch
    ]);
    expect(indexedRowsRead).toBe(0);
    expect(declinedRowsRead).toBe(1);
    expect(unhookedRowsRead).toBe(1);
  });

  it('treats an empty composed lookup result as handled', () => {
    let rowsRead = 0;
    const source = composeSources({
      rows: () => {
        rowsRead += 1;
        return [{ id: 'fallback', accountId: 'cash' }];
      },
      lookup: () => []
    });

    expect(source.lookup?.({ relation: schema.entries, field: 'accountId', value: 'cash' })).toEqual([]);
    expect(rowsRead).toBe(0);
  });

  it('composes range lookup hooks with fallback scans when hooks are missing or decline', () => {
    const indexedRow = { id: 'indexed', amount: 2 };
    const declinedBelow = { id: 'declined-below', amount: -1 };
    const declinedLower = { id: 'declined-lower', amount: 0 };
    const declinedMiddle = { id: 'declined-middle', amount: 5 };
    const declinedUpper = { id: 'declined-upper', amount: 10 };
    const unhookedMiddle = { id: 'unhooked-middle', amount: 7 };
    const unhookedUpper = { id: 'unhooked-upper', amount: 10 };
    let indexedRowsRead = 0;
    let declinedRowsRead = 0;
    let unhookedRowsRead = 0;
    const indexed: RelationSource = {
      rows: () => {
        indexedRowsRead += 1;
        return [indexedRow];
      },
      rangeLookup: () => [indexedRow]
    };
    const declined: RelationSource = {
      rows: () => {
        declinedRowsRead += 1;
        return [declinedBelow, declinedLower, declinedMiddle, declinedUpper, 'not-a-row'];
      },
      rangeLookup: () => undefined
    };
    const unhooked: RelationSource = {
      rows: () => {
        unhookedRowsRead += 1;
        return [unhookedMiddle, unhookedUpper];
      }
    };

    const source = composeSources(indexed, declined, unhooked);

    expect(source.rangeLookup?.({
      relation: schema.entries,
      field: 'amount',
      lower: { value: 0, inclusive: true },
      upper: { value: 10, inclusive: false }
    })).toEqual([
      indexedRow,
      declinedLower,
      declinedMiddle,
      unhookedMiddle
    ]);
    expect(indexedRowsRead).toBe(0);
    expect(declinedRowsRead).toBe(1);
    expect(unhookedRowsRead).toBe(1);
  });

  it('treats an empty composed range lookup result as handled', () => {
    let rowsRead = 0;
    const source = composeSources({
      rows: () => {
        rowsRead += 1;
        return [{ id: 'fallback', amount: 5 }];
      },
      rangeLookup: () => []
    });

    expect(source.rangeLookup?.({
      relation: schema.entries,
      field: 'amount',
      lower: { value: 0, inclusive: true }
    })).toEqual([]);
    expect(rowsRead).toBe(0);
  });
});
