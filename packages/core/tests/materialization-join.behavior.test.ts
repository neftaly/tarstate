import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { demat, explainMaterialization, mat } from '@tarstate/core/materialization';
import {
  asc,
  clauses,
  eq,
  field,
  from,
  join,
  keyBy,
  pipe,
  project,
  sort,
  value,
  where
} from '@tarstate/core/query';
import { updateByKey } from '@tarstate/core/write';
import { account, entry, makeDb, schema } from './behavior-fixtures.js';

const joinedEntryAccounts = pipe(
  from(entry),
  join(from(account), clauses({ accountId: 'id' })),
  project({
    entryId: entry.id,
    accountId: account.id,
    entryAccountId: entry.accountId,
    amount: entry.amount,
    accountName: account.$.name
  })
);

const joinedEntryAccountsSortedByAccount = pipe(
  joinedEntryAccounts,
  sort(
    asc(field('row', 'accountName')),
    asc(field('row', 'entryId')),
    asc(field('row', 'accountId'))
  )
);

describe('materialization join behavior', () => {
  it('falls back instead of collapsing non-unique right fanout identities', () => {
    const base = makeDb();
    const db = mat(createDb({
      accounts: [
        ...(base.data.accounts ?? []),
        { id: 'cash', name: 'Duplicate cash', kind: 'asset' }
      ],
      entries: base.data.entries ?? []
    }), joinedEntryAccounts);

    const result = tryTransact(db, updateByKey(schema.accounts, 'cash', { name: 'Operating cash' }));
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: expect.stringContaining('incremental maintenance requires unique materialized row keys')
        })
      ])
    }));
    expect(q(result.db, joinedEntryAccounts)).toEqual(q(demat(result.db, joinedEntryAccounts), joinedEntryAccounts));
  });

  it('falls back when a join projection drops required source identity fields', () => {
    const query = pipe(
      from(entry),
      join(from(account), clauses({ accountId: 'id' })),
      project({
        accountId: account.id,
        amount: entry.amount,
        accountName: account.$.name
      })
    );
    const reason = 'incremental maintenance requires a stable materialized row identity';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: reason })]
    }));

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: 125 }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported', message: reason })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('does not let explicit keyBy bypass required joined-pair identity fields', () => {
    const query = pipe(
      from(entry),
      join(from(account), clauses({ accountId: 'id' })),
      project({
        entryId: entry.id,
        amount: entry.amount,
        accountName: account.$.name
      }),
      keyBy('entryId')
    );
    const reason = 'incremental maintenance requires a stable materialized row identity';
    const db = mat(makeDb(), query);

    expect(explainMaterialization(query)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      reason,
      diagnostics: [expect.objectContaining({ code: 'materialization_unsupported', message: reason })]
    }));

    const result = tryTransact(db, [
      updateByKey(schema.entries, 'e1', { amount: 125 }),
      updateByKey(schema.entries, 'e1', { amount: 130 })
    ]);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported', message: reason })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

  it('trusts final total join sorts that include the full materialized identity', () => {
    const db = mat(makeDb(), joinedEntryAccountsSortedByAccount);

    const result = tryTransact(db, updateByKey(schema.accounts, 'cash', { name: 'ZZZ cash' }));
    const afterRows = q(demat(result.db, joinedEntryAccountsSortedByAccount), joinedEntryAccountsSortedByAccount);
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      diagnostics: []
    }));
    expect(q(result.db, joinedEntryAccountsSortedByAccount)).toEqual(afterRows);
  });

  it('falls back for non-total final join sort ties when an earlier filtered source row enters', () => {
    const query = pipe(
      from(entry),
      join(from(account), clauses({ accountId: 'id' })),
      where(eq(entry.posted, value(true))),
      project({
        entryId: entry.id,
        accountId: account.id,
        entryAccountId: entry.accountId,
        amount: entry.amount,
        accountName: account.$.name
      }),
      sort(asc(field('row', 'accountName')))
    );
    const db = mat(createDb({
      accounts: [
        { id: 'cash', name: 'Cash', kind: 'asset' },
        { id: 'fees', name: 'Fees', kind: 'expense' }
      ],
      entries: [
        { id: 'a', accountId: 'cash', amount: 10, posted: false },
        { id: 'b', accountId: 'cash', amount: 20, posted: true },
        { id: 'c', accountId: 'fees', amount: 30, posted: true }
      ]
    }), query);

    const result = tryTransact(db, updateByKey(schema.entries, 'a', { posted: true }));
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      rows: [
        { entryId: 'a', accountId: 'cash', entryAccountId: 'cash', amount: 10, accountName: 'Cash' },
        { entryId: 'b', accountId: 'cash', entryAccountId: 'cash', amount: 20, accountName: 'Cash' },
        { entryId: 'c', accountId: 'fees', entryAccountId: 'fees', amount: 30, accountName: 'Fees' }
      ],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: 'incremental materialization candidate differed from full recompute'
        })
      ])
    }));
    expect(q(result.db, query)).toEqual(q(demat(result.db, query), query));
  });

});
