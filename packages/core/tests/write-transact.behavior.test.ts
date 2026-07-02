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
import { any as anyAggregate, asc, call, count, eq, field, from, gt, hostFn, pipe, project, sort, value } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import {
  deleteByKey,
  deleteExact,
  deleteRows,
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
  openingAccounts,
  openingEntries,
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

function deltaRows(result: { readonly deltas: readonly { readonly relation: { readonly name: string }; readonly added: readonly unknown[]; readonly removed: readonly unknown[] }[] }, relationName: string): {
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
} {
  const deltas = result.deltas.filter((delta) => delta.relation.name === relationName);
  return {
    added: deltas.flatMap((delta) => delta.added),
    removed: deltas.flatMap((delta) => delta.removed)
  };
}

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

  it('applies insert variants by relation key', () => {
    const db = createDb({
      accounts: [{ id: 'cash', name: 'Cash', kind: 'asset' }],
      entries: []
    });
    const next = transact(db, [
      insert(schema.accounts, { id: 'bank', name: 'Bank', kind: 'asset' }),
      insertIgnore(schema.accounts, { id: 'cash', name: 'Ignored duplicate', kind: 'liability' }),
      insertOrReplace(schema.accounts, { id: 'cash', name: 'Operating cash', kind: 'asset' }),
      insertOrMerge(schema.accounts, { id: 'bank', name: 'Bank account', kind: 'liability' }, { merge: ['name'] }),
      insertOrUpdate(schema.accounts, { id: 'equity', name: 'Equity', kind: 'equity' }, { update: { name: 'Owner equity' } }),
      insertOrUpdate(schema.accounts, { id: 'cash', name: 'Cash', kind: 'asset' }, {
        update: (current) => ({ name: `${current.name} updated` })
      })
    ]);

    expect(q(next, accountsById)).toEqual([
      { id: 'bank', name: 'Bank account', kind: 'asset' },
      { id: 'cash', name: 'Operating cash updated', kind: 'asset' },
      { id: 'equity', name: 'Equity', kind: 'equity' }
    ]);
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

  it('updates and deletes by key, predicate, exact row, and replaceAll', () => {
    const db = makeDb();
    const replacementAccounts = [
      { id: 'cash', name: 'Wallet', kind: 'asset' },
      { id: 'equity', name: 'Owner equity', kind: 'equity' }
    ] as const satisfies readonly Account[];
    const result = tryTransact(
      db,
      updateByKey(schema.accounts, 'cash', { name: 'Wallet' }),
      update(schema.entries, gt(entry.amount, value(0)), (current) => ({
        memo: `${current.memo ?? 'unmemoed'} (cleared)`
      })),
      deleteByKey(schema.entries, 'e2'),
      deleteRows(schema.entries, eq(entry.posted, value(false))),
      deleteExact(schema.entries, { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true }),
      replaceAll(schema.accounts, replacementAccounts)
    );

    expect(result.committed).toBe(true);
    expect(result.patches).toBe(6);
    expect(result.applied).toBe(6);
    expect(result.diagnostics).toEqual([]);
    expect(result.db).not.toBe(db);
    expect(q(db, entriesById)).toEqual(openingEntries);
    expect(q(db, schema.accounts)).toEqual(openingAccounts);
    expect(q(result.db, entriesById)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid (cleared)', posted: true }
    ]);
    expect(q(result.db, accountsById)).toEqual(replacementAccounts);

    expect(deltaRows(result, 'entries')).toEqual({
      added: [
        { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid (cleared)', posted: true }
      ],
      removed: [
        { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
        { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid', posted: true },
        { id: 'e4', accountId: 'cash', amount: 0, posted: false },
        { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true }
      ]
    });
    expect(result.deltas.filter((delta) => delta.relation.name === 'accounts')).toEqual([
      {
        relation: schema.accounts,
        added: [{ id: 'cash', name: 'Wallet', kind: 'asset' }],
        removed: [{ id: 'cash', name: 'Cash', kind: 'asset' }]
      },
      {
        relation: schema.accounts,
        added: replacementAccounts,
        removed: [
          { id: 'cash', name: 'Wallet', kind: 'asset' },
          openingAccounts[1],
          openingAccounts[2],
          openingAccounts[3]
        ]
      }
    ]);
  });

  it('deleteExact requires full row equality', () => {
    const db = makeDb();
    const partialEntry = { id: 'e3', accountId: 'fees' } as unknown as Entry;
    const afterPartial = transact(db, deleteExact(schema.entries, partialEntry));

    expect(q(afterPartial, entriesById)).toEqual(openingEntries);

    const afterExact = transact(
      afterPartial,
      deleteExact(schema.entries, { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true })
    );

    expect(q(afterExact, entriesById)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
      { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid', posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false }
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
