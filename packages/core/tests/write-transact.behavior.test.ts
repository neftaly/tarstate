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
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import {
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  seed,
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
