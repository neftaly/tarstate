import { describe, expect, it } from 'vitest';
import { createDb, q, qResult, transact } from '@tarstate/core/db';
import {
  maintainMaterializationSnapshots,
  mat,
  materializedRowsForQuery,
  readMaterializedQuery
} from '@tarstate/core/materialization';
import {
  asc,
  call,
  env,
  eq,
  from,
  hostFn,
  pipe,
  project,
  sort,
  value,
  where
} from '@tarstate/core/query';
import { insert } from '@tarstate/core/write';
import { entry, makeDb, schema } from './behavior-fixtures.js';

const cashEntryList = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

const cashEntryProjection = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

describe('materialized source behavior', () => {
  it('serves materialized query rows from a stable cache until dependencies change', () => {
    const db = mat(makeDb(), cashEntryList);
    const first = q(db, cashEntryList);
    const second = q(db, cashEntryList);

    expect(first).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
    expect(second).toBe(first);
    expect(materializedRowsForQuery(db, cashEntryList)).toBe(first);
    expect(readMaterializedQuery(db, cashEntryList)).toEqual({
      rows: first,
      diagnostics: [],
      materialized: true
    });

    const afterUnrelatedWrite = transact(
      db,
      insert(schema.accounts, { id: 'bank', name: 'Bank', kind: 'asset' })
    );
    expect(q(afterUnrelatedWrite, cashEntryList)).toBe(first);

    const afterEntryWrite = transact(
      afterUnrelatedWrite,
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const changed = q(afterEntryWrite, cashEntryList);

    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e1', amount: 120 },
      { id: 'e4', amount: 0 },
      { id: 'e5', amount: 35 }
    ]);
  });

  it('recomputes materialized rows when maintenance is called without relation deltas', () => {
    const base = makeDb();
    const before = mat(base, cashEntryProjection);
    const after = createDb({
      ...base.data,
      entries: [
        ...(base.data.entries ?? []),
        { id: 'e5', accountId: 'cash', amount: 35, posted: true }
      ]
    });

    const result = maintainMaterializationSnapshots(before, after);

    expect(result.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      rows: [
        { id: 'e1', amount: 120 },
        { id: 'e4', amount: 0 },
        { id: 'e5', amount: 35 }
      ]
    }));
    expect(result.changes[0]?.update).not.toBe('incremental');
  });

  it('bypasses materialized cached rows when query options override env or functions', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.accountId, env<string>('accountId'))),
      sort(asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId })
    );
    const tag = hostFn<string>('test.tag', () => 'base');
    const taggedEntries = pipe(
      from(entry),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        tag: call(tag)
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries, taggedEntries);

    expect(q(db, envFilteredEntries)).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);
    expect(q(db, envFilteredEntries, { env: { accountId: 'sales' } })).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
    expect(qResult(db, taggedEntries).rows[0]).toEqual({ id: 'e1', tag: 'base' });
    expect(qResult(db, taggedEntries, { functions: { 'test.tag': () => 'override' } }).rows[0]).toEqual({ id: 'e1', tag: 'override' });
  });

});
