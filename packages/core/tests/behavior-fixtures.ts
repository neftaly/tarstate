import { createDb, type Db } from '@tarstate/core/db';
import { as, asc, from, pipe, sort, type Query } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';

export type Account = {
  readonly id: string;
  readonly name: string;
  readonly kind: 'asset' | 'income' | 'expense' | 'equity' | 'liability';
};

export type Entry = {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly memo?: string | null;
  readonly posted: boolean;
};

export type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;

export const schema = defineSchema({
  accounts: relation<Account>({
    key: 'id',
    fields: {
      id: idField('account'),
      name: stringField(),
      kind: stringField()
    }
  }),
  entries: relation<Entry>({
    key: 'id',
    fields: {
      id: idField('entry'),
      accountId: refField('accounts.id'),
      amount: numberField(),
      memo: optional(nullable(stringField())),
      posted: booleanField()
    }
  })
});

export const account = as(schema.accounts, 'account');
export const entry = as(schema.entries, 'entry');

export const openingAccounts = [
  { id: 'cash', name: 'Cash', kind: 'asset' },
  { id: 'sales', name: 'Sales', kind: 'income' },
  { id: 'fees', name: 'Bank fees', kind: 'expense' },
  { id: 'equity', name: 'Owner equity', kind: 'equity' }
] as const satisfies readonly Account[];

export const openingEntries = [
  { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
  { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid', posted: true },
  { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true },
  { id: 'e4', accountId: 'cash', amount: 0, posted: false }
] as const satisfies readonly Entry[];

export function makeDb(): Db {
  return createDb({
    accounts: openingAccounts.map((row) => ({ ...row })),
    entries: openingEntries.map((row) => ({ ...row }))
  });
}

export const accountsById = pipe(from(account), sort(asc(account.id)));
export const entriesById = pipe(from(entry), sort(asc(entry.id)));
