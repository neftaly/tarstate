import { describe, expect, it } from 'vitest';
import { createDb, q, qResult, transact } from '@tarstate/core/db';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import {
  maintainMaterializationSnapshots,
  mat,
  materializedRelationForQuery,
  materializedRowsForQuery,
  readMaterializedQuery
} from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  btree,
  call,
  count,
  env,
  eq,
  field,
  from,
  gte,
  hash,
  hostFn,
  lookup,
  pipe,
  project,
  sort,
  sum,
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

const entryRows = pipe(
  from(entry),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount,
    posted: entry.posted
  })
);

const entryTotalsByAccount = pipe(
  from(entry),
  aggregate({
    groupBy: { accountId: entry.accountId },
    aggregates: {
      entryCount: count(),
      total: sum(entry.amount)
    }
  })
);

const entriesByAccount = pipe(entryRows, hash(field<string>('row', 'accountId')));
const entriesByAmount = pipe(entryRows, btree(field<number>('row', 'amount')));

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

  it('exposes aggregate materializations through q using non-id group keys', () => {
    const db = mat(makeDb(), entryTotalsByAccount);
    const relation = materializedRelationForQuery(db, entryTotalsByAccount);
    if (relation === undefined) throw new Error('expected materialized aggregate relation');

    expect(relation.key).toBe('accountId');
    expect(qResult(db, pipe(
      from(relation),
      sort(asc(field<string>('row', 'accountId')))
    ))).toEqual({
      rows: [
        { accountId: 'cash', entryCount: 2, total: 120 },
        { accountId: 'fees', entryCount: 1, total: -5 },
        { accountId: 'sales', entryCount: 1, total: -120 }
      ],
      diagnostics: []
    });
  });

  it('uses materialized lookup and range reads through q while preserving live db reads', () => {
    const db = mat(makeDb(), entriesByAccount, entriesByAmount);
    const accountRelation = materializedRelationForQuery(db, entriesByAccount);
    const amountRelation = materializedRelationForQuery(db, entriesByAmount);
    if (accountRelation === undefined || amountRelation === undefined) {
      throw new Error('expected materialized index relations');
    }

    expect(q(db, pipe(
      lookup(accountRelation, 'accountId', 'cash'),
      sort(asc(field<string>('row', 'id')))
    ))).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120, posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false }
    ]);

    expect(qResult(db, pipe(
      from(amountRelation),
      where(gte(field<number>('row', 'amount'), value(-10))),
      sort(asc(field<string>('row', 'id')))
    ))).toEqual({
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120, posted: true },
        { id: 'e3', accountId: 'fees', amount: -5, posted: true },
        { id: 'e4', accountId: 'cash', amount: 0, posted: false }
      ],
      diagnostics: []
    });

    expect(q(db, pipe(
      from(entry),
      where(eq(entry.accountId, value('sales'))),
      project({ id: entry.id, amount: entry.amount })
    ))).toEqual([{ id: 'e2', amount: -120 }]);
  });

  it('materializes readable relation sources without treating arbitrary objects as empty sources', () => {
    const source = fromObjectSource(makeDb().data);
    const materialized = mat(source, cashEntryProjection);

    expect(readMaterializedQuery(materialized, cashEntryProjection)).toEqual({
      rows: [
        { id: 'e1', amount: 120 },
        { id: 'e4', amount: 0 }
      ],
      diagnostics: [],
      materialized: true
    });

    expect(() => mat({} as unknown as RelationSource, cashEntryProjection))
      .toThrow('materialization target must be a Db or RelationSource');
  });

  it('fails initial materialization refreshes that report error diagnostics', () => {
    const source: RelationSource = {
      rows: () => makeDb().data.entries ?? [],
      diagnostics: () => [{
        code: 'query_invalid',
        severity: 'error',
        message: 'source is broken',
        surface: 'test'
      }]
    };

    expect(() => mat(source, cashEntryProjection)).toThrow(/source is broken/);
  });

});
