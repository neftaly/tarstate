import { describe, expect, it } from 'vitest';
import { createDb, q, transact } from '@tarstate/core/db';
import { asc, field, pipe, sort } from '@tarstate/core/query';
import {
  RelicParseError,
  fromRelicExpr,
  fromRelicQuery,
  fromRelicTx
} from '@tarstate/core/relic';
import { entry, makeDb, schema } from './behavior-fixtures.js';

type JsonScalar = string | number | boolean | null;
type JsonRow = Record<string, JsonScalar>;

const setLeft = [[':const', [{ id: 'a' }, { id: 'b' }]]] as const;
const setRight = [[':const', [{ id: 'b' }, { id: 'c' }]]] as const;
const byId = sort(asc(field<string>('row', 'id')));

describe('Relic compatibility parser', () => {
  it('parses projection queries', () => {
    const query = fromRelicQuery([
      [':from', ':entries'],
      [':where', ['>', ':amount', 0]],
      [':select', ':id', ':amount']
    ], schema);

    expect(q(makeDb(), query)).toEqual([{ id: 'e1', amount: 120 }]);
  });

  it('parses joins', () => {
    const query = fromRelicQuery([
      [':from', ':entries'],
      [':extend', [':entryId', ':id']],
      [':without', ':id'],
      [':join', ':accounts', { accountId: ':id' }],
      [':select', [':entryId', ':entryId'], [':accountName', ':name'], ':amount']
    ], schema);

    expect(q(makeDb(), query)).toEqual([
      { entryId: 'e1', accountName: 'Cash', amount: 120 },
      { entryId: 'e2', accountName: 'Sales', amount: -120 },
      { entryId: 'e3', accountName: 'Bank fees', amount: -5 },
      { entryId: 'e4', accountName: 'Cash', amount: 0 }
    ]);
  });

  it('parses left joins', () => {
    const query = fromRelicQuery([
      [':from', ':accounts'],
      [
        ':left-join',
        [
          [':from', ':entries'],
          [':extend', [':entryId', ':id']],
          [':without', ':id']
        ],
        { id: ':accountId' }
      ],
      [':select', [':accountId', ':id'], [':accountName', ':name'], ':entryId']
    ], schema);

    expect(sortRows(normalizeRows(q(makeDb(), query)), 'accountId', 'entryId')).toEqual([
      { accountId: 'cash', accountName: 'Cash', entryId: 'e1' },
      { accountId: 'cash', accountName: 'Cash', entryId: 'e4' },
      { accountId: 'equity', accountName: 'Owner equity', entryId: null },
      { accountId: 'fees', accountName: 'Bank fees', entryId: 'e3' },
      { accountId: 'sales', accountName: 'Sales', entryId: 'e2' }
    ]);
  });

  it('parses aggregates', () => {
    const query = fromRelicQuery([
      [':from', ':entries'],
      [
        ':agg',
        [':accountId'],
        [':entryCount', ['count']],
        [':total', ['rel/sum', ':amount']],
        [':average', ['rel/avg', ':amount']]
      ]
    ], schema);

    expect(sortRows(normalizeRows(q(makeDb(), query)), 'accountId')).toEqual([
      { accountId: 'cash', entryCount: 2, total: 120, average: 60 },
      { accountId: 'fees', entryCount: 1, total: -5, average: -5 },
      { accountId: 'sales', entryCount: 1, total: -120, average: -120 }
    ]);
  });

  it('parses set operations over const queries', () => {
    expect(q(createDb(), pipe(fromRelicQuery([[':from', setLeft], [':union', setRight]], schema), byId))).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' }
    ]);
    expect(q(createDb(), pipe(fromRelicQuery([[':from', setLeft], [':intersection', setRight]], schema), byId))).toEqual([
      { id: 'b' }
    ]);
    expect(q(createDb(), pipe(fromRelicQuery([[':from', setLeft], [':difference', setRight]], schema), byId))).toEqual([
      { id: 'a' }
    ]);
  });

  it('parses transaction vectors', () => {
    const db = transact(makeDb(), fromRelicTx([
      [':insert', ':entries', { id: 'e5', accountId: 'cash', amount: 15, posted: true }],
      [':update', ':entries', { amount: 125 }, ['=', ':id', 'e1']],
      [':delete', ':entries', ['=', ':id', 'e2']]
    ], schema));

    const rows = q(
      db,
      pipe(
        fromRelicQuery([[':from', ':entries'], [':select', ':id', ':accountId', ':amount', ':posted']], schema),
        sort(asc(entry.id))
      )
    );

    expect(rows).toEqual([
      { id: 'e1', accountId: 'cash', amount: 125, posted: true },
      { id: 'e3', accountId: 'fees', amount: -5, posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false },
      { id: 'e5', accountId: 'cash', amount: 15, posted: true }
    ]);
  });

  it('parses seed maps and write variants', () => {
    const seedPatches = fromRelicTx({
      ':accounts': [{ id: 'cash', name: 'Cash', kind: 'asset' }],
      ':entries': { id: 'e1', accountId: 'cash', amount: 10, posted: true }
    }, schema);
    const variantPatches = fromRelicTx([
      [':insert-ignore', ':entries', { id: 'e1', accountId: 'cash', amount: 10, posted: true }],
      [':insert-or-replace', ':entries', { id: 'e1', accountId: 'cash', amount: 11, posted: true }],
      [':delete-exact', ':entries', { id: 'e1', accountId: 'cash', amount: 11, posted: true }],
      [':replace-all', ':entries', [{ id: 'e2', accountId: 'cash', amount: 12, posted: true }]]
    ], schema);

    expect(seedPatches.map((patch) => patch.op)).toEqual(['insert', 'insert']);
    expect(variantPatches.map((patch) => patch.op)).toEqual([
      'insertIgnore',
      'insertOrReplace',
      'deleteExact',
      'replaceAll'
    ]);
  });

  it('exposes expression parsing and explicit unsupported-form errors', () => {
    expect(fromRelicExpr(['=', ':id', 'e1'])).toEqual({
      op: 'eq',
      left: { op: 'field', alias: 'row', field: 'id' },
      right: { op: 'value', value: 'e1' }
    });
    expectRelicError(
      () => fromRelicQuery([[':lookup', ':entries', ':id', 'e1']], schema),
      'relic_unsupported'
    );
    expectRelicError(
      () => fromRelicTx([':insert-or-merge', ':entries', ':*', { id: 'e1' }], schema),
      'relic_unsupported'
    );
    expectRelicError(
      () => fromRelicQuery([[':from', ':missing']], schema),
      'relic_relation_missing'
    );
    expectRelicError(
      () => fromRelicExpr(['unknown.call', ':id']),
      'relic_function_missing'
    );
    expectRelicError(
      () => fromRelicQuery([], schema),
      'relic_invalid'
    );
  });
});

function expectRelicError(run: () => unknown, code: RelicParseError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RelicParseError);
    expect((error as RelicParseError).code).toBe(code);
    expect((error as RelicParseError).path).toEqual([]);
    return;
  }

  throw new Error('Expected RelicParseError');
}

function normalizeRows(rows: readonly unknown[]): readonly JsonRow[] {
  return rows.map((rowValue) => {
    if (!isRecord(rowValue)) throw new TypeError('Expected query row object');

    return Object.fromEntries(
      Object.entries(rowValue).map(([key, value]) => [key, value === undefined ? null : value])
    ) as JsonRow;
  });
}

function sortRows(rows: readonly JsonRow[], ...fields: readonly string[]): readonly JsonRow[] {
  return [...rows].sort((left, right) => {
    for (const fieldName of fields) {
      const compared = String(left[fieldName] ?? '').localeCompare(String(right[fieldName] ?? ''));
      if (compared !== 0) return compared;
    }
    return 0;
  });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
