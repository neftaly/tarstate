import { describe, expect, it } from 'vitest';
import {
  composeSources,
  fromObjectSource,
  relationRowCounts,
  relationRows,
  relationSet,
  relationSetCounts,
  relationSetFromRows,
  relationSetFromSource,
  relationSetNames,
  relationSetSource
} from '@tarstate/core/source';
import { schema } from './behavior-fixtures.js';

describe('source API behavior', () => {
  it('exposes minimal object-source and composed-source API shape', () => {
    const entryRow = { id: 'entry', accountId: 'cash', amount: 1 };
    const accountRow = { id: 'cash' };
    const objectSource = fromObjectSource({ entries: [entryRow] });
    const source = composeSources(objectSource, fromObjectSource({ accounts: [accountRow], entries: [] }));

    expect(objectSource.relationNames).toEqual(['entries']);
    expect(objectSource.rows(schema.entries)).toEqual([entryRow]);
    expect(objectSource.rows(schema.accounts)).toEqual([]);
    expect(typeof objectSource.lookup).toBe('function');
    expect(typeof objectSource.rangeLookup).toBe('function');

    expect(source.relationNames).toEqual(['entries', 'accounts']);
    expect(source.rows(schema.entries)).toEqual([entryRow]);
    expect(source.rows(schema.accounts)).toEqual([accountRow]);
    expect(typeof source.lookup).toBe('function');
    expect(typeof source.rangeLookup).toBe('function');
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

  it('keeps unconstrained composed sources visible when nested', () => {
    const row = { id: 'fallback', accountId: 'cash' };
    const unconstrained = composeSources({
      rows: () => [row]
    });
    const source = composeSources(fromObjectSource({ accounts: [] }), unconstrained);

    expect(unconstrained.relationNames).toBeUndefined();
    expect(source.relationNames).toBeUndefined();
    expect(source.rows(schema.entries)).toEqual([row]);
  });

  it('wraps relation sets and exposes them as sources', () => {
    const first = { id: 'e1', accountId: 'cash', amount: 10, posted: true };
    const second = { id: 'e2', accountId: 'sales', amount: -10, posted: true };
    const set = relationSetFromRows({
      entries: [first, second]
    });

    expect(relationRows(set, 'entries')).toEqual([first, second]);
    expect(relationRows(set, schema.entries)).toEqual([first, second]);
    expect(relationRows(set, 'missing')).toEqual([]);
    expect(relationSetNames(set)).toEqual(['entries']);
    expect(relationRowCounts(set)).toEqual({ entries: 2 });
    expect(relationSetCounts(set)).toEqual({ entries: 2 });
    expect(relationSet({ entries: [first] }).relations.entries).toEqual([first]);

    const counts = relationRowCounts({
      zeta: [first],
      alpha: [first, second]
    });
    expect(Object.keys(counts)).toEqual(['alpha', 'zeta']);

    const source = relationSetSource(set);
    expect(source.relationNames).toEqual(['entries']);
    expect(source.rows(schema.entries)).toEqual([first, second]);
    expect(source.lookup?.({ relation: schema.entries, field: 'id', value: 'e2' })).toEqual([second]);
    expect(relationSetFromSource(source, [schema.entries])).toEqual({
      relations: { entries: [first, second] }
    });
  });
});
