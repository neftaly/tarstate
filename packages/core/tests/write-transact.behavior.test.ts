import { describe, expect, it } from 'vitest';
import { unique } from '@tarstate/core/constraints';
import {
  createDb,
  DbTransactionError,
  q,
  row,
  transact,
  tryTransact,
  type DbTransactionContext
} from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { any as anyAggregate, asc, call, count, eq, field, from, hostFn, pipe, project, sort, value } from '@tarstate/core/query';
import { defineSchema, idField, numberField, relation, stringField } from '@tarstate/core/schema';
import {
  deleteExact,
  incrementByKey,
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  replaceAll,
  seed,
  update,
  updateByKey,
  write,
  type WritePatch
} from '@tarstate/core/write';
import {
  accountsById,
  entriesById,
  entry,
  makeDb,
  schema,
  type Account,
  type Entry
} from './behavior-fixtures.js';

type Contact = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
};

const contactSchema = defineSchema({
  contacts: relation<Contact>({
    key: 'id',
    fields: {
      id: idField('contact'),
      email: stringField(),
      name: stringField()
    }
  })
});

type CounterMetric = {
  readonly id: number;
  readonly value: number;
};

const counterMetricSchema = defineSchema({
  metrics: relation<CounterMetric>({
    key: 'id',
    fields: {
      id: numberField(),
      value: numberField()
    }
  })
});

describe('write and transaction behavior', () => {
  it('turns schema-keyed seed rows into insert patches and commits them', () => {
    const db = createDb();
    const cash = { id: 'cash', name: 'Cash', kind: 'asset' } as const satisfies Account;
    const sales = { id: 'sales', name: 'Sales', kind: 'income' } as const satisfies Account;
    const firstEntry = { id: 'e1', accountId: 'cash', amount: 10, memo: 'seed', posted: true } as const satisfies Entry;
    const rows = {
      accounts: [cash, sales],
      entries: [firstEntry]
    } satisfies {
      readonly accounts: readonly Account[];
      readonly entries: readonly Entry[];
    };
    const patches = seed(schema, rows);

    expect(patches).toEqual([
      insert(schema.accounts, cash),
      insert(schema.accounts, sales),
      insert(schema.entries, firstEntry)
    ]);

    const next = transact(db, patches);

    expect(q(next, accountsById)).toEqual(rows.accounts);
    expect(q(next, entriesById)).toEqual(rows.entries);
  });

  it('commits variadic transaction inputs through transact like tryTransact', () => {
    const next = transact(
      createDb(),
      insert(schema.accounts, { id: 'cash', name: 'Cash', kind: 'asset' }),
      insert(schema.accounts, { id: 'sales', name: 'Sales', kind: 'income' }),
      insert(schema.entries, { id: 'e1', accountId: 'cash', amount: 10, posted: true })
    );

    expect(q(next, accountsById)).toEqual([
      { id: 'cash', name: 'Cash', kind: 'asset' },
      { id: 'sales', name: 'Sales', kind: 'income' }
    ]);
    expect(q(next, entriesById)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 10, posted: true }
    ]);

    const withOptions = transact(
      next,
      updateByKey(schema.entries, 'e1', { amount: 12 }),
      { label: 'variadic compatibility' }
    );
    expect(row(withOptions, schema.entries, 'e1')?.amount).toBe(12);
  });

  it('resolves insert variants against materialized unique constraints', () => {
    const uniqueEmail = unique(contactSchema.contacts, 'email');
    const original = { id: 'old', email: 'ada@example.test', name: 'Ada' } as const satisfies Contact;
    const incoming = { id: 'new', email: 'ada@example.test', name: 'Ada Lovelace' } as const satisfies Contact;
    const freshDb = () => mat(createDb({ contacts: [original] }), uniqueEmail);

    const ignored = tryTransact(freshDb(), insertIgnore(contactSchema.contacts, incoming));
    const replaced = tryTransact(freshDb(), insertOrReplace(contactSchema.contacts, incoming));
    const merged = tryTransact(
      freshDb(),
      insertOrMerge(contactSchema.contacts, incoming, { merge: ['name'] })
    );
    const updated = tryTransact(
      freshDb(),
      insertOrUpdate(contactSchema.contacts, incoming, { update: { name: 'Updated Ada' } })
    );

    expect(ignored.committed).toBe(true);
    expect(ignored.applied).toBe(0);
    expect(q(ignored.db, contactSchema.contacts)).toEqual([original]);

    expect(replaced.committed).toBe(true);
    expect(q(replaced.db, contactSchema.contacts)).toEqual([incoming]);

    expect(merged.committed).toBe(true);
    expect(q(merged.db, contactSchema.contacts)).toEqual([
      { id: 'old', email: 'ada@example.test', name: 'Ada Lovelace' }
    ]);

    expect(updated.committed).toBe(true);
    expect(q(updated.db, contactSchema.contacts)).toEqual([
      { id: 'old', email: 'ada@example.test', name: 'Updated Ada' }
    ]);
  });

  it('evaluates expression-valued update maps against the current row', () => {
    const add = hostFn<number>('math.add', (left, right) => Number(left) + Number(right));
    const memoFromRow = hostFn<string>('memo.from-row', (id, accountId) => `${String(id)}:${String(accountId)}`);

    const next = transact(
      makeDb(),
      updateByKey(schema.entries, 'e1', {
        accountId: field('row', 'accountId'),
        amount: call(add, entry.amount, value(8)),
        memo: call(memoFromRow, entry.id, entry.accountId),
        posted: field('row', 'posted')
      })
    );

    expect(row(next, schema.entries, 'e1')).toEqual({
      id: 'e1',
      accountId: 'cash',
      amount: 128,
      memo: 'e1:cash',
      posted: true
    });

    // @ts-expect-error aggregate expressions cannot be evaluated in a row update context.
    const invalidCountUpdate = updateByKey(schema.entries, 'e1', { amount: count() });
    void invalidCountUpdate;

    // @ts-expect-error aggregate expressions cannot be evaluated in a row update context.
    const invalidAnyUpdate = updateByKey(schema.entries, 'e1', { posted: anyAggregate(eq(entry.posted, value(true))) });
    void invalidAnyUpdate;
  });

  it('increments finite numeric fields by key through transaction helpers', () => {
    const next = transact(
      makeDb(),
      incrementByKey(schema.entries, 'e1', 'amount', 5),
      write(schema.entries).incrementByKey('e1', 'amount', -2)
    );

    expect(row(next, schema.entries, 'e1')?.amount).toBe(123);
  });

  it('rejects invalid numeric increments with diagnostics and leaves the input db unchanged', () => {
    const db = makeDb();
    const nonFiniteResultDb = createDb({
      entries: [{ id: 'max', accountId: 'cash', amount: Number.MAX_VALUE, posted: true }]
    });
    const numericKeyDb = createDb({ metrics: [{ id: 1, value: 10 }] });
    const cases = [
      {
        label: 'missing row',
        db,
        patch: incrementByKey(schema.entries, 'missing', 'amount', 1),
        applied: 0,
        diagnostic: { code: 'row_invalid', relation: 'entries', field: 'amount' }
      },
      {
        label: 'missing field',
        db,
        patch: { op: 'incrementByKey', relation: schema.entries, key: 'e1', field: 'missing', amount: 1 } as WritePatch,
        diagnostic: { code: 'field_invalid', relation: 'entries', field: 'missing' }
      },
      {
        label: 'non-number field',
        db,
        patch: { op: 'incrementByKey', relation: schema.entries, key: 'e1', field: 'memo', amount: 1 } as WritePatch,
        diagnostic: { code: 'field_invalid', relation: 'entries', field: 'memo' }
      },
      {
        label: 'non-finite amount',
        db,
        patch: incrementByKey(schema.entries, 'e1', 'amount', Number.POSITIVE_INFINITY),
        diagnostic: { code: 'write_patch_invalid', relation: 'entries' }
      },
      {
        label: 'non-finite result',
        db: nonFiniteResultDb,
        patch: incrementByKey(schema.entries, 'max', 'amount', Number.MAX_VALUE),
        diagnostic: { code: 'field_invalid', relation: 'entries', field: 'amount' },
        assertUnchanged: () => expect(row(nonFiniteResultDb, schema.entries, 'max')?.amount).toBe(Number.MAX_VALUE)
      },
      {
        label: 'numeric key field',
        db: numericKeyDb,
        patch: incrementByKey(counterMetricSchema.metrics, 1, 'id', 1),
        diagnostic: { code: 'field_invalid', relation: 'metrics', field: 'id' },
        assertUnchanged: () => expect(row(numericKeyDb, counterMetricSchema.metrics, 1)).toEqual({ id: 1, value: 10 })
      }
    ];

    for (const item of cases) {
      const result = tryTransact(item.db, item.patch);
      expect(result.committed, item.label).toBe(false);
      expect(result.db, item.label).toEqual(item.db);
      if (item.applied !== undefined) expect(result.applied, item.label).toBe(item.applied);
      expect(result.diagnostics, item.label).toEqual(expect.arrayContaining([
        expect.objectContaining(item.diagnostic)
      ]));
      item.assertUnchanged?.();
    }

    expect(row(db, schema.entries, 'e1')?.amount).toBe(120);
  });

  it('applies predicate updates, exact deletes, and relation replacement writes', () => {
    const updated = transact(
      makeDb(),
      update(schema.entries, eq(entry.accountId, value('cash')), {
        memo: 'cash movement',
        posted: true
      })
    );
    const deleted = transact(
      updated,
      deleteExact(schema.entries, { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true })
    );
    const replaced = transact(
      deleted,
      replaceAll(schema.accounts, [
        { id: 'cash', name: 'Operating cash', kind: 'asset' },
        { id: 'suspense', name: 'Suspense', kind: 'liability' }
      ])
    );

    expect(row(updated, schema.entries, 'e4')).toEqual({
      id: 'e4',
      accountId: 'cash',
      amount: 0,
      memo: 'cash movement',
      posted: true
    });
    expect(row(deleted, schema.entries, 'e3')).toBeUndefined();
    expect(q(replaced, accountsById)).toEqual([
      { id: 'cash', name: 'Operating cash', kind: 'asset' },
      { id: 'suspense', name: 'Suspense', kind: 'liability' }
    ]);
  });

  it('evaluates transaction callbacks against staged db state', () => {
    const db = makeDb();
    const bank = { id: 'bank', name: 'Bank', kind: 'asset' } as const satisfies Account;
    const bankEntry = { id: 'e5', accountId: 'bank', amount: 45, memo: 'transfer', posted: false } as const satisfies Entry;

    const next = transact(db, [
      write(schema.accounts).insert(bank),
      (tx: DbTransactionContext) => {
        expect(row(tx, schema.accounts, 'bank')).toEqual(bank);
        return [
          write(schema.entries).insert(bankEntry),
          write(schema.accounts).updateByKey('bank', { name: 'Bank account' })
        ];
      }
    ]);

    expect(row(db, schema.accounts, 'bank')).toBeUndefined();
    expect(row(next, schema.accounts, 'bank')).toEqual({ ...bank, name: 'Bank account' });
    expect(row(next, schema.entries, 'e5')).toEqual(bankEntry);
  });

  it('rejects duplicate and invalid writes with diagnostics and leaves the input db unchanged', () => {
    const db = makeDb();
    const duplicate = insert(schema.accounts, { id: 'cash', name: 'Duplicate cash', kind: 'asset' });
    const duplicateResult = tryTransact(db, duplicate);

    expect(duplicateResult.committed).toBe(false);
    expect(duplicateResult.db).toBe(db);
    expect(duplicateResult.applied).toBe(0);
    expect(duplicateResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unique', relation: 'accounts' })
    ]));
    expect(() => transact(db, duplicate)).toThrow(DbTransactionError);

    try {
      transact(db, duplicate);
    } catch (error) {
      expect(error).toBeInstanceOf(DbTransactionError);
      expect((error as DbTransactionError).result).toEqual(expect.objectContaining({
        committed: false,
        applied: 0,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unique', relation: 'accounts' })])
      }));
    }

    const invalidRow = insert(schema.entries, {
      id: 'bad',
      accountId: 'cash',
      posted: true
    } as never);
    const invalidResult = tryTransact(db, invalidRow);

    expect(invalidResult.committed).toBe(false);
    expect(invalidResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field_missing', relation: 'entries', field: 'amount' })
    ]));
    expect(q(db, pipe(from(entry), sort(asc(entry.id)), project({ id: entry.id })))).toEqual([
      { id: 'e1' },
      { id: 'e2' },
      { id: 'e3' },
      { id: 'e4' }
    ]);
  });

  it('reports accepted envelopes for no-op write batches', () => {
    const db = makeDb();
    const result = tryTransact(db, [] satisfies readonly WritePatch[]);

    expect(result).toEqual({
      db,
      patches: 0,
      applied: 0,
      deltas: [],
      diagnostics: [],
      committed: true
    });
  });
});
