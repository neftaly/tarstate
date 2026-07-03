import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { diffRows } from '@tarstate/core/diff';
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
import { deleteByKey, insert, updateByKey } from '@tarstate/core/write';
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

function joinedEntryAccountKey(row: unknown): readonly unknown[] {
  return isRecord(row) ? [row.entryId, row.accountId] : [undefined, undefined];
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

describe('materialization join behavior', () => {
  it('incrementally maintains a supported two-relation equi-join projection', () => {
    const db = mat(makeDb(), joinedEntryAccounts);
    const beforeRows = q(db, joinedEntryAccounts);

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { amount: 125 }));
    const afterRows = q(demat(result.db, joinedEntryAccounts), joinedEntryAccounts);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      previousRows: beforeRows,
      rows: afterRows,
      rowChanges: diff.changes,
      added: [],
      removed: [],
      diagnostics: []
    }));
    expect(q(result.db, joinedEntryAccounts)).toBe(change?.rows);
    expect(q(result.db, joinedEntryAccounts)).toEqual(afterRows);
    expect(diff.diagnostics).toEqual([]);
  });

  it('incrementally maintains every joined row affected by right-side fanout updates', () => {
    const db = mat(makeDb(), joinedEntryAccounts);
    const beforeRows = q(db, joinedEntryAccounts);

    const result = tryTransact(db, updateByKey(schema.accounts, 'cash', { name: 'Operating cash' }));
    const afterRows = q(demat(result.db, joinedEntryAccounts), joinedEntryAccounts);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(change?.rowChanges).toEqual([
      expect.objectContaining({ kind: 'updated', key: '["e1","cash"]' }),
      expect.objectContaining({ kind: 'updated', key: '["e4","cash"]' })
    ]);
    expect(q(result.db, joinedEntryAccounts)).toEqual(afterRows);
  });

  it('incrementally maintains join-key moves as a removed and added joined pair', () => {
    const db = mat(makeDb(), joinedEntryAccounts);
    const beforeRows = q(db, joinedEntryAccounts);

    const result = tryTransact(db, updateByKey(schema.entries, 'e1', { accountId: 'fees' }));
    const afterRows = q(demat(result.db, joinedEntryAccounts), joinedEntryAccounts);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      added: [{ entryId: 'e1', accountId: 'fees', entryAccountId: 'fees', amount: 120, accountName: 'Bank fees' }],
      removed: [{ entryId: 'e1', accountId: 'cash', entryAccountId: 'cash', amount: 120, accountName: 'Cash' }],
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(q(result.db, joinedEntryAccounts)).toEqual(afterRows);
  });

  it('coalesces same-pair join contributions from both sides in one transaction', () => {
    const query = pipe(
      joinedEntryAccounts,
      where(eq(field('row', 'entryId'), value('e1')))
    );
    const db = mat(makeDb(), query);
    const beforeRows = q(db, query);

    const result = tryTransact(db, [
      updateByKey(schema.entries, 'e1', { amount: 130 }),
      updateByKey(schema.accounts, 'cash', { name: 'Operating cash' })
    ]);
    const afterRows = q(demat(result.db, query), query);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(change?.rowChanges).toEqual([
      {
        kind: 'updated',
        key: '["e1","cash"]',
        before: { entryId: 'e1', accountId: 'cash', entryAccountId: 'cash', amount: 120, accountName: 'Cash' },
        after: { entryId: 'e1', accountId: 'cash', entryAccountId: 'cash', amount: 130, accountName: 'Operating cash' }
      }
    ]);
  });

  it('coalesces repeated same-side join updates in one transaction', () => {
    const query = pipe(
      joinedEntryAccounts,
      where(eq(field('row', 'entryId'), value('e1')))
    );
    const db = mat(makeDb(), query);
    const beforeRows = q(db, query);

    const result = tryTransact(db, [
      updateByKey(schema.entries, 'e1', { amount: 125 }),
      updateByKey(schema.entries, 'e1', { amount: 130 })
    ]);
    const afterRows = q(demat(result.db, query), query);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(change?.rowChanges).toEqual([
      {
        kind: 'updated',
        key: '["e1","cash"]',
        before: { entryId: 'e1', accountId: 'cash', entryAccountId: 'cash', amount: 120, accountName: 'Cash' },
        after: { entryId: 'e1', accountId: 'cash', entryAccountId: 'cash', amount: 130, accountName: 'Cash' }
      }
    ]);
  });

  it('coalesces adding both sides of a joined pair into exactly one added row', () => {
    const db = mat(makeDb(), joinedEntryAccounts);
    const beforeRows = q(db, joinedEntryAccounts);

    const result = tryTransact(db, [
      insert(schema.accounts, { id: 'bank', name: 'Bank', kind: 'asset' }),
      insert(schema.entries, { id: 'e5', accountId: 'bank', amount: 35, memo: 'top-up', posted: true })
    ]);
    const afterRows = q(demat(result.db, joinedEntryAccounts), joinedEntryAccounts);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      added: [{ entryId: 'e5', accountId: 'bank', entryAccountId: 'bank', amount: 35, accountName: 'Bank' }],
      removed: [],
      rowChanges: diff.changes,
      diagnostics: []
    }));
  });

  it('incrementally maintains joined rows when deleting a right row while moving one left row away', () => {
    const db = mat(makeDb(), joinedEntryAccounts);
    const beforeRows = q(db, joinedEntryAccounts);

    const result = tryTransact(db, [
      deleteByKey(schema.accounts, 'cash'),
      updateByKey(schema.entries, 'e4', { accountId: 'fees' })
    ]);
    const afterRows = q(demat(result.db, joinedEntryAccounts), joinedEntryAccounts);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      added: [{ entryId: 'e4', accountId: 'fees', entryAccountId: 'fees', amount: 0, accountName: 'Bank fees' }],
      removed: [
        { entryId: 'e1', accountId: 'cash', entryAccountId: 'cash', amount: 120, accountName: 'Cash' },
        { entryId: 'e4', accountId: 'cash', entryAccountId: 'cash', amount: 0, accountName: 'Cash' }
      ],
      rowChanges: diff.changes,
      diagnostics: []
    }));
    expect(q(result.db, joinedEntryAccounts)).toEqual(afterRows);
  });

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
    const beforeRows = q(db, joinedEntryAccountsSortedByAccount);

    const result = tryTransact(db, updateByKey(schema.accounts, 'cash', { name: 'ZZZ cash' }));
    const afterRows = q(demat(result.db, joinedEntryAccountsSortedByAccount), joinedEntryAccountsSortedByAccount);
    const diff = diffRows(beforeRows, afterRows, { keyBy: joinedEntryAccountKey });
    const change = result.materializations?.changes[0];

    expect(result.committed).toBe(true);
    expect(change).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false,
      rows: afterRows,
      rowChanges: diff.changes,
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
