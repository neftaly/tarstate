import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  as,
  attachConstraints,
  check,
  constrain,
  count,
  createDb,
  createStore,
  defineSchema,
  eq,
  field,
  fk,
  from,
  gt,
  insert,
  mat,
  numberField,
  pipe,
  project,
  qManyRows,
  qRows,
  relation,
  req,
  row,
  stringField,
  transact,
  tryTransactConstrained,
  unique,
  value,
  where,
  type QueryResult,
  type StoreViewSnapshot
} from '@tarstate/core';

type Account = {
  readonly id: string;
  readonly name: string;
  readonly kind: 'asset' | 'liability' | 'income' | 'expense';
};

type Entry = {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly memo: string;
};

const schema = defineSchema({
  accounts: relation<Account>({
    key: 'id',
    fields: {
      id: stringField(),
      name: stringField(),
      kind: stringField()
    }
  }),
  entries: relation<Entry>({
    key: 'id',
    fields: {
      id: stringField(),
      accountId: stringField(),
      amount: numberField(),
      memo: stringField()
    }
  })
});

const openingDb = createDb({
  accounts: [
    { id: 'cash', name: 'Cash', kind: 'asset' },
    { id: 'sales', name: 'Sales', kind: 'income' }
  ],
  entries: [
    { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid' },
    { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid' }
  ]
});

describe('rewrite public contracts', () => {
  it('evaluates Relic-style query data synchronously over a Db snapshot', () => {
    const cashEntries = pipe(
      from(as(schema.entries, 'entry')),
      where(eq(field('entry', 'accountId'), value('cash'))),
      project({
        id: field<string>('entry', 'id'),
        amount: field<number>('entry', 'amount')
      })
    );

    const rows = qRows(openingDb, cashEntries);

    expectTypeOf(rows).toEqualTypeOf<readonly { readonly id: string; readonly amount: number }[]>();
    expect(rows).toEqual([{ id: 'e1', amount: 120 }]);
  });

  it('supports sync batch reads, row lookup, and aggregate projections from one snapshot', () => {
    const positiveEntries = pipe(
      from(as(schema.entries, 'entry')),
      where(gt(field('entry', 'amount'), value(0))),
      project({ id: field<string>('entry', 'id') })
    );
    const summary = pipe(
      from(as(schema.entries, 'entry')),
      project({ entryCount: count() })
    );

    expect(qManyRows(openingDb, { positiveEntries, summary })).toEqual({
      positiveEntries: [{ id: 'e1' }],
      summary: [{ entryCount: 2 }]
    });
    expect(row(openingDb, positiveEntries, 'e1')).toEqual({ id: 'e1' });
  });

  it('keeps writes functional and returns a new Db value', () => {
    const next = transact(
      openingDb,
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expect(qRows(openingDb, from(schema.entries))).toHaveLength(2);
    expect(qRows(next, from(schema.entries))).toHaveLength(3);
  });

  it('enforces required, unique, foreign-key, and check constraints as query data', () => {
    const constrained = attachConstraints(openingDb, constrain(
      req(schema.entries, 'id', 'accountId', 'amount'),
      unique(schema.entries, 'id'),
      fk(schema.entries, 'accountId', schema.accounts, 'id'),
      check(from(as(schema.entries, 'entry')), gt(field('entry', 'amount'), value(-1_000_000)))
    ));

    const result = tryTransactConstrained(
      constrained,
      insert(schema.entries, { id: 'bad', accountId: 'missing', amount: 10, memo: 'bad account' })
    );

    expect(result.committed).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'foreign_key' })
    ]));
  });

  it('gives React-facing stores stable synchronous view snapshots by revision', () => {
    const store = createStore(openingDb);
    const view = store.view(from(schema.entries));
    const first = view.getSnapshot();
    const second = view.getSnapshot();

    expectTypeOf(first).toMatchTypeOf<StoreViewSnapshot<Entry>>();
    expect(first.rows).toBe(second.rows);
    expect(first.revision).toBe(0);
    expect(first.rows).toHaveLength(2);
  });

  it('materializes query results without changing the query-facing API', () => {
    const entries = from(schema.entries);
    const materialized = mat(openingDb, entries);

    expect(qRows(materialized, entries)).toHaveLength(2);
    expect(qRows(materialized, entries)).toBe(qRows(materialized, entries));
  });

  it('keeps projection result types on QueryResult and qRows', () => {
    const query = pipe(
      from(as(schema.accounts, 'account')),
      project({ name: field<string>('account', 'name') })
    );
    const result: QueryResult<{ readonly name: string }> = { rows: qRows(openingDb, query), diagnostics: [] };

    expect(result.rows).toEqual([{ name: 'Cash' }, { name: 'Sales' }]);
  });
});
