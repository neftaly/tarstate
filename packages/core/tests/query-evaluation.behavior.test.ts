import { describe, expect, expectTypeOf, it } from 'vitest';
import { createDb, q, qMany, qManyResult, qResult } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { defineSchema, jsonField, relation } from '@tarstate/core/schema';
import {
  aggregate,
  any as anyAggregate,
  as,
  asc,
  bottom,
  bottomBy,
  callMaybe,
  clauses,
  constRows,
  correlate,
  count,
  countDistinct,
  desc,
  difference,
  eq,
  env,
  expand,
  extend,
  field,
  from,
  gt,
  gte,
  getKey,
  hostFn,
  ifElse,
  intersection,
  isMissing,
  isNull,
  join,
  leftJoin,
  limit,
  lte,
  max,
  maybe,
  notAny,
  notMissing,
  notNull,
  pipe,
  project,
  qualify,
  rename,
  sel,
  sel1,
  sort,
  setConcat,
  sum,
  top,
  topBy,
  union,
  value,
  where,
  without
} from '@tarstate/core/query';
import {
  account,
  entry,
  makeDb,
  openingAccounts,
  schema,
  type Account,
  type Entry
} from './behavior-fixtures.js';

describe('query evaluation behavior', () => {
  it('reads relations, queries, row envelopes, and query batches', () => {
    const db = makeDb();
    const positiveEntries = pipe(
      from(entry),
      where(gt(entry.row.amount, value(0))),
      project({ id: entry.row.id, amount: entry.row.amount })
    );
    const totals = pipe(
      from(entry),
      aggregate({
        aggregates: {
          entryCount: count(),
          total: sum(entry.row.amount)
        }
      })
    );
    const batch = {
      accounts: schema.accounts,
      positives: positiveEntries,
      wrappedTotals: { q: totals }
    };

    expect(q(db, schema.accounts)).toEqual(openingAccounts);
    expect(q(db, positiveEntries)).toEqual([{ id: 'e1', amount: 120 }]);
    expect(qResult(db, positiveEntries)).toEqual({
      rows: [{ id: 'e1', amount: 120 }],
      diagnostics: []
    });
    expect(qMany(db, batch)).toEqual({
      accounts: openingAccounts,
      positives: [{ id: 'e1', amount: 120 }],
      wrappedTotals: [{ entryCount: 4, total: -5 }]
    });
    expect(qManyResult(db, batch)).toEqual({
      accounts: { rows: openingAccounts, diagnostics: [] },
      positives: { rows: [{ id: 'e1', amount: 120 }], diagnostics: [] },
      wrappedTotals: { rows: [{ entryCount: 4, total: -5 }], diagnostics: [] }
    });
  });

  it('applies q option sorting and row mapping across single and batch reads', () => {
    const db = makeDb();
    const amounts = pipe(
      from(entry),
      project({
        id: entry.row.id,
        amount: entry.row.amount
      })
    );

    expect(q(db, amounts, { sort: 'amount' })).toEqual([
      { id: 'e2', amount: -120 },
      { id: 'e3', amount: -5 },
      { id: 'e4', amount: 0 },
      { id: 'e1', amount: 120 }
    ]);
    expect(q(db, amounts, { rsort: 'amount' })).toEqual([
      { id: 'e1', amount: 120 },
      { id: 'e4', amount: 0 },
      { id: 'e3', amount: -5 },
      { id: 'e2', amount: -120 }
    ]);
    expect(qMany(db, { first: amounts, wrapped: { q: amounts } }, {
      rsort: 'amount',
      mapRows: (rows) => rows.slice(0, 2).map((row) => ({ id: (row as { readonly id: string }).id }))
    })).toEqual({
      first: [{ id: 'e1' }, { id: 'e4' }],
      wrapped: [{ id: 'e1' }, { id: 'e4' }]
    });

    const joinedIds = q(db, amounts, {
      sort: 'amount',
      mapRows: (rows) => rows.map((row) => row.id),
      into: (rows) => rows.join('|')
    });
    expectTypeOf(joinedIds).toEqualTypeOf<string>();
    expect(joinedIds).toBe('e2|e3|e4|e1');

    const summarized = qResult(db, amounts, {
      rsort: 'amount',
      mapRows: (rows) => rows.map((row) => row.id),
      into: (rows): { readonly count: number; readonly first: string | undefined } => ({
        count: rows.length,
        first: rows[0]
      })
    });
    expectTypeOf(summarized.rows).toEqualTypeOf<{ readonly count: number; readonly first: string | undefined }>();
    expect(summarized).toEqual({
      rows: { count: 4, first: 'e1' },
      diagnostics: []
    });

    expect(q(mat(db, amounts), amounts, {
      sort: 'amount',
      mapRows: (rows) => rows.map((row) => row.id),
      into: (rows) => rows.join('|')
    })).toBe('e2|e3|e4|e1');
  });

  it('applies per-target qMany options and keeps unsafe target transforms out of duplicate cache', () => {
    const db = makeDb();
    const amounts = pipe(
      from(entry),
      project({
        id: entry.row.id,
        amount: entry.row.amount
      })
    );
    let firstMapCalls = 0;
    let secondMapCalls = 0;
    const batch = {
      ascendingIds: {
        q: amounts,
        sort: 'amount',
        mapRows: (rows: readonly { readonly id: string; readonly amount: number }[]) => {
          firstMapCalls += 1;
          return rows.map((row) => row.id);
        },
        into: (rows: readonly string[]) => rows.join(',')
      },
      topDescending: {
        q: amounts,
        rsort: 'amount',
        mapRows: (rows: readonly { readonly id: string; readonly amount: number }[]): readonly { readonly id: string }[] => {
          secondMapCalls += 1;
          return rows.slice(0, 2).map((row) => ({ id: row.id }));
        }
      },
      raw: amounts
    };

    const rows = qMany(db, batch);
    expectTypeOf(rows.ascendingIds).toEqualTypeOf<string>();
    expectTypeOf(rows.topDescending).toEqualTypeOf<readonly { readonly id: string }[]>();
    expect(rows).toEqual({
      ascendingIds: 'e2,e3,e4,e1',
      topDescending: [{ id: 'e1' }, { id: 'e4' }],
      raw: [
        { id: 'e1', amount: 120 },
        { id: 'e2', amount: -120 },
        { id: 'e3', amount: -5 },
        { id: 'e4', amount: 0 }
      ]
    });

    const result = qManyResult(db, batch);
    expectTypeOf(result.ascendingIds.rows).toEqualTypeOf<string>();
    expectTypeOf(result.topDescending.rows).toEqualTypeOf<readonly { readonly id: string }[]>();
    expect(result.ascendingIds).toEqual({ rows: 'e2,e3,e4,e1', diagnostics: [] });
    expect(result.topDescending).toEqual({ rows: [{ id: 'e1' }, { id: 'e4' }], diagnostics: [] });
    expect(firstMapCalls).toBe(2);
    expect(secondMapCalls).toBe(2);
  });

  it('distinguishes null from missing fields', () => {
    const db = makeDb();
    const nullMemo = pipe(from(entry), where(isNull(entry.row.memo)), project({ id: entry.row.id }));
    const missingMemo = pipe(from(entry), where(isMissing(entry.row.memo)), project({ id: entry.row.id }));
    const presentMemo = pipe(
      from(entry),
      where(notMissing(entry.row.memo)),
      sort(asc(entry.row.id)),
      project({ id: entry.row.id })
    );
    const nonNullMemo = pipe(
      from(entry),
      where(notNull(entry.row.memo)),
      sort(asc(entry.row.id)),
      project({ id: entry.row.id })
    );

    expect(q(db, nullMemo)).toEqual([{ id: 'e3' }]);
    expect(q(db, missingMemo)).toEqual([{ id: 'e4' }]);
    expect(q(db, presentMemo)).toEqual([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
    expect(q(db, nonNullMemo)).toEqual([{ id: 'e1' }, { id: 'e2' }]);
  });

  it('compares JSON field values structurally', () => {
    const jsonSchema = defineSchema({
      nodes: relation({
        key: 'key',
        fields: {
          key: jsonField(),
          parentKey: jsonField()
        }
      })
    });
    const node = as(jsonSchema.nodes, 'node');
    const db = createDb({
      nodes: [
        { key: [], parentKey: null },
        { key: [0], parentKey: [] },
        { key: [1], parentKey: [] }
      ]
    });

    expect(q(db, pipe(from(node), where(eq(node.row.key, env('key')))), { env: { key: [] } })).toEqual([{ key: [], parentKey: null }]);
    expect(q(db, pipe(from(node), where(eq(node.row.parentKey, env('key')))), { env: { key: [] } })).toEqual([
      { key: [0], parentKey: [] },
      { key: [1], parentKey: [] }
    ]);
  });

  it('projects, extends, removes, renames, and qualifies rows', () => {
    const rows = q(
      makeDb(),
      pipe(
        from(account),
        where(eq(account.row.id, value('cash'))),
        extend({
          label: account.row.name,
          stableKind: account.row.kind
        }),
        without('kind'),
        rename({ label: 'displayName' }),
        qualify('acct')
      )
    );

    expect(rows).toEqual([
      {
        acct: {
          id: 'cash',
          name: 'Cash',
          displayName: 'Cash',
          stableKind: 'asset'
        }
      }
    ]);
  });

  it('evaluates Relic expression helpers for conditional values, keyed lookup, and nil-safe calls', () => {
    const upper = hostFn<string>('text.upperMaybe', (input) => String(input).toUpperCase());
    const rows = constRows([
      { id: 'a', amount: 2, meta: { kind: 'asset' }, memo: 'cash' },
      { id: 'b', amount: -1, meta: { kind: 'expense' }, memo: null },
      { id: 'c', amount: 0, meta: {}, memo: undefined }
    ]);
    const result = q(createDb(), pipe(
      rows,
      sort(asc(field<string>('row', 'id'))),
      project({
        id: field<string>('row', 'id'),
        bucket: ifElse(gte(field<number>('row', 'amount'), value(0)), value('non-negative'), value('negative')),
        kind: getKey<string>(field('row', 'meta'), value('kind')),
        shout: callMaybe(upper, field('row', 'memo'))
      })
    ));

    expect(result).toEqual([
      { id: 'a', bucket: 'non-negative', kind: 'asset', shout: 'CASH' },
      { id: 'b', bucket: 'negative', kind: 'expense', shout: undefined },
      { id: 'c', bucket: 'non-negative', kind: undefined, shout: undefined }
    ]);
  });

  it('joins with equality clauses, predicate joins, and left joins', () => {
    const db = makeDb();
    const byClause = pipe(
      from(entry),
      join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
      sort(asc(entry.row.id)),
      project({
        entryId: entry.row.id,
        accountName: account.row.name,
        amount: entry.row.amount
      })
    );
    const byPredicate = pipe(
      from(entry),
      join(from(account), eq(entry.row.accountId, account.row.id)),
      sort(asc(entry.row.id)),
      project({
        entryId: entry.row.id,
        accountName: account.row.name,
        amount: entry.row.amount
      })
    );
    const withOptionalEntries = pipe(
      from(account),
      leftJoin(from(entry), clauses<Account, Entry>({ id: 'accountId' })),
      sort(asc(account.row.id), asc(entry.row.id, 'last')),
      project({
        accountId: account.row.id,
        accountName: account.row.name,
        entryId: maybe(entry.row.id)
      })
    );

    expect(q(db, byClause)).toEqual([
      { entryId: 'e1', accountName: 'Cash', amount: 120 },
      { entryId: 'e2', accountName: 'Sales', amount: -120 },
      { entryId: 'e3', accountName: 'Bank fees', amount: -5 },
      { entryId: 'e4', accountName: 'Cash', amount: 0 }
    ]);
    expect(q(db, byPredicate)).toEqual(q(db, byClause));
    expect(q(db, withOptionalEntries)).toEqual([
      { accountId: 'cash', accountName: 'Cash', entryId: 'e1' },
      { accountId: 'cash', accountName: 'Cash', entryId: 'e4' },
      { accountId: 'equity', accountName: 'Owner equity', entryId: undefined },
      { accountId: 'fees', accountName: 'Bank fees', entryId: 'e3' },
      { accountId: 'sales', accountName: 'Sales', entryId: 'e2' }
    ]);
  });

  it('keeps clause joins identity-sensitive for cyclic object values', () => {
    const shared: { key: string; self?: unknown } = { key: 'shared' };
    shared.self = shared;
    const left = constRows([
      { leftId: 'same-shape', tag: { key: 'shape' } },
      { leftId: 'same-ref', tag: shared }
    ]);
    const right = constRows([
      { rightId: 'same-shape', tag: { key: 'shape' } },
      { rightId: 'same-ref', tag: shared }
    ]);
    const query = pipe(
      left,
      join(right, clauses<{ readonly tag: unknown }, { readonly tag: unknown }>({ tag: 'tag' })),
      project({
        leftId: field<string>('row', 'leftId'),
        rightId: field<string>('row', 'rightId')
      })
    );

    expect(q(createDb(), query)).toEqual([{ leftId: 'same-ref', rightId: 'same-ref' }]);
  });

  it('evaluates correlated selections and single-row selections', () => {
    const entriesForAccount = pipe(from(entry), sort(asc(entry.row.id)));
    const rows = q(
      makeDb(),
      pipe(
        from(account),
        where(eq(account.row.id, value('cash'))),
        project({
          id: account.row.id,
          entries: sel(entriesForAccount, correlate<Account, Entry>({ id: 'accountId' })),
          firstEntry: sel1(entriesForAccount, correlate<Account, Entry>({ id: 'accountId' }))
        })
      )
    );

    expect(rows).toEqual([
      {
        id: 'cash',
        entries: [
          { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
          { id: 'e4', accountId: 'cash', amount: 0, posted: false }
        ],
        firstEntry: { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true }
      }
    ]);
  });

  it('evaluates env-backed subqueries and single-row selections', () => {
    const db = createDb(makeDb().data, {
      env: {
        selectedAccount: 'cash',
        minimumAmount: 1
      }
    });
    const selectedEntries = pipe(
      from(entry),
      where(eq(entry.row.accountId, env<string>('selectedAccount'))),
      where(gte(entry.row.amount, env<number>('minimumAmount'))),
      sort(asc(entry.row.id)),
      project({
        id: entry.row.id,
        amount: entry.row.amount
      })
    );
    const summary = pipe(
      constRows([{}]),
      project({
        entries: sel(selectedEntries),
        firstEntry: sel1(selectedEntries)
      })
    );

    expect(q(db, summary)).toEqual([
      {
        entries: [{ id: 'e1', amount: 120 }],
        firstEntry: { id: 'e1', amount: 120 }
      }
    ]);
  });

  it('aggregates, sorts, and limits rows', () => {
    const db = makeDb();
    const summary = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.row.accountId },
        aggregates: {
          entryCount: count(),
          total: sum(entry.row.amount),
          largest: max(entry.row.amount)
        }
      }),
      sort(asc(field<string>('row', 'accountId'))),
      project({
        accountId: field<string>('row', 'accountId'),
        entryCount: field<number>('row', 'entryCount'),
        total: field<number>('row', 'total'),
        largest: field<number>('row', 'largest')
      })
    );
    const largestOutflows = pipe(
      from(entry),
      where(lte(entry.row.amount, value(0))),
      sort(asc(entry.row.amount), desc(entry.row.id)),
      limit(2),
      project({ id: entry.row.id, amount: entry.row.amount })
    );

    expect(q(db, summary)).toEqual([
      { accountId: 'cash', entryCount: 2, total: 120, largest: 120 },
      { accountId: 'fees', entryCount: 1, total: -5, largest: -5 },
      { accountId: 'sales', entryCount: 1, total: -120, largest: -120 }
    ]);
    expect(q(db, largestOutflows)).toEqual([
      { id: 'e2', amount: -120 },
      { id: 'e3', amount: -5 }
    ]);
  });

  it('evaluates predicate-aware aggregate helpers', () => {
    const db = makeDb();
    const summary = pipe(
      from(entry),
      aggregate({
        aggregates: {
          postedCount: count(eq(entry.row.posted, value(true))),
          hasDraft: anyAggregate(eq(entry.row.posted, value(false))),
          hasNoLargeOutflow: notAny(lte(entry.row.amount, value(-1_000)))
        }
      })
    );

    expect(q(db, summary)).toEqual([
      { postedCount: 3, hasDraft: true, hasNoLargeOutflow: true }
    ]);
  });

  it('evaluates Relic aggregate helpers for top, bottom, distinct counts, and set concatenation', () => {
    const scoredRows = constRows([
      { id: 'a', score: 2, tags: ['red', 'blue'], archived: false },
      { id: 'b', score: 9, tags: ['blue', 'green'], archived: false },
      { id: 'c', score: 7, tags: [], archived: false },
      { id: 'd', score: 9, tags: ['red'], archived: false }
    ]);
    const score = field<number>('row', 'score');
    const id = field<string>('row', 'id');
    const tags = field<readonly string[]>('row', 'tags');
    const archived = field<boolean>('row', 'archived');
    const summary = pipe(
      scoredRows,
      aggregate({
        aggregates: {
          topScores: top(score, 2),
          bottomScores: bottom(score, 2),
          topIds: topBy(id, score, 2),
          bottomIds: bottomBy(id, score, 2),
          distinctScores: countDistinct(score),
          allTags: setConcat(tags),
          noneArchived: notAny(eq(archived, value(true)))
        }
      })
    );

    expect(q(createDb(), summary)).toEqual([
      {
        topScores: [9, 9],
        bottomScores: [2, 7],
        topIds: ['b', 'd'],
        bottomIds: ['a', 'c'],
        distinctScores: 3,
        allTags: ['red', 'blue', 'green'],
        noneArchived: true
      }
    ]);
  });

  it('evaluates set operations with set semantics', () => {
    const left = constRows<{ readonly id: string }>([{ id: 'a' }, { id: 'b' }]);
    const right = constRows<{ readonly id: string }>([{ id: 'b' }, { id: 'c' }]);
    const sorted = sort(asc(field<string>('row', 'id')));
    const db = createDb();

    expect(q(db, pipe(union(left, right), sorted))).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(q(db, pipe(intersection(left, right), sorted))).toEqual([{ id: 'b' }]);
    expect(q(db, pipe(difference(left, right), sorted))).toEqual([{ id: 'a' }]);
  });

  it('expands nested collections into rows and projected item fields', () => {
    type Line = { readonly sku: string; readonly qty: number };
    type Order = { readonly id: string; readonly lines: readonly Line[] };
    const orders = constRows<Order>([
      { id: 'o1', lines: [{ sku: 'tea', qty: 2 }, { sku: 'milk', qty: 1 }] },
      { id: 'o2', lines: [] }
    ]);
    const lines = pipe(
      orders,
      expand(field<readonly Line[]>('row', 'lines'), { as: 'line', fields: ['sku', 'qty'] as const }),
      sort(asc(field<string>('row', 'id')), asc(field<string>('row', 'sku'))),
      project({
        orderId: field<string>('row', 'id'),
        sku: field<string>('row', 'sku'),
        qty: field<number>('row', 'qty'),
        line: field<Line>('row', 'line')
      })
    );

    expect(q(createDb(), lines)).toEqual([
      { orderId: 'o1', sku: 'milk', qty: 1, line: { sku: 'milk', qty: 1 } },
      { orderId: 'o1', sku: 'tea', qty: 2, line: { sku: 'tea', qty: 2 } }
    ]);
  });

});
