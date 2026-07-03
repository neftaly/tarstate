import { describe, expect, it } from 'vitest';
import { createDb, q, qMany, qManyResult, qResult } from '@tarstate/core/db';
import {
  aggregate,
  any as anyAggregate,
  asc,
  clauses,
  constRows,
  correlate,
  count,
  desc,
  difference,
  eq,
  expand,
  extend,
  field,
  from,
  gt,
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
  sum,
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
      where(gt(entry.amount, value(0))),
      project({ id: entry.id, amount: entry.amount })
    );
    const totals = pipe(
      from(entry),
      aggregate({
        aggregates: {
          entryCount: count(),
          total: sum(entry.amount)
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

  it('distinguishes null from missing fields', () => {
    const db = makeDb();
    const nullMemo = pipe(from(entry), where(isNull(entry.memo)), project({ id: entry.id }));
    const missingMemo = pipe(from(entry), where(isMissing(entry.memo)), project({ id: entry.id }));
    const presentMemo = pipe(
      from(entry),
      where(notMissing(entry.memo)),
      sort(asc(entry.id)),
      project({ id: entry.id })
    );
    const nonNullMemo = pipe(
      from(entry),
      where(notNull(entry.memo)),
      sort(asc(entry.id)),
      project({ id: entry.id })
    );

    expect(q(db, nullMemo)).toEqual([{ id: 'e3' }]);
    expect(q(db, missingMemo)).toEqual([{ id: 'e4' }]);
    expect(q(db, presentMemo)).toEqual([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
    expect(q(db, nonNullMemo)).toEqual([{ id: 'e1' }, { id: 'e2' }]);
  });

  it('projects, extends, removes, renames, and qualifies rows', () => {
    const rows = q(
      makeDb(),
      pipe(
        from(account),
        where(eq(account.id, value('cash'))),
        extend({
          label: account.$.name,
          stableKind: account.$.kind
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

  it('joins with equality clauses, predicate joins, and left joins', () => {
    const db = makeDb();
    const byClause = pipe(
      from(entry),
      join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
      sort(asc(entry.id)),
      project({
        entryId: entry.id,
        accountName: account.$.name,
        amount: entry.amount
      })
    );
    const byPredicate = pipe(
      from(entry),
      join(from(account), eq(entry.accountId, account.id)),
      sort(asc(entry.id)),
      project({
        entryId: entry.id,
        accountName: account.$.name,
        amount: entry.amount
      })
    );
    const withOptionalEntries = pipe(
      from(account),
      leftJoin(from(entry), clauses<Account, Entry>({ id: 'accountId' })),
      sort(asc(account.id), asc(entry.id, 'last')),
      project({
        accountId: account.id,
        accountName: account.$.name,
        entryId: maybe(entry.id)
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

  it('evaluates correlated selections and single-row selections', () => {
    const entriesForAccount = pipe(from(entry), sort(asc(entry.id)));
    const rows = q(
      makeDb(),
      pipe(
        from(account),
        where(eq(account.id, value('cash'))),
        project({
          id: account.id,
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

  it('aggregates, sorts, and limits rows', () => {
    const db = makeDb();
    const summary = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          entryCount: count(),
          total: sum(entry.amount),
          largest: max(entry.amount)
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
      where(lte(entry.amount, value(0))),
      sort(asc(entry.amount), desc(entry.id)),
      limit(2),
      project({ id: entry.id, amount: entry.amount })
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
          postedCount: count(eq(entry.posted, value(true))),
          hasDraft: anyAggregate(eq(entry.posted, value(false))),
          hasNoLargeOutflow: notAny(lte(entry.amount, value(-1_000)))
        }
      })
    );

    expect(q(db, summary)).toEqual([
      { postedCount: 3, hasDraft: true, hasNoLargeOutflow: true }
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
