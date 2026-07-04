import { describe, expect, it } from 'vitest';
import { createDb, q, qResult, transact, tryTransact } from '@tarstate/core/db';
import { evaluate } from '@tarstate/core/evaluate';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import {
  demat,
  maintainMaterializationSnapshots,
  mat,
  materializedRelationForQuery,
  materializedRowsForQuery,
  materializedSourceFor,
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
  uniqueIndex,
  value,
  where
} from '@tarstate/core/query';
import { deleteByKey, insert } from '@tarstate/core/write';
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
const directEntriesByAccount = pipe(from(entry), hash(entry.accountId));
const directEntriesById = pipe(from(entry), uniqueIndex(entry.id));

const cashEntriesByBaseLookup = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

const entryByIdBaseLookup = pipe(
  from(entry),
  where(eq(entry.id, value('e2'))),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount
  })
);

const filteredProjectedEntriesByAccount = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  project({
    id: entry.id,
    accountId: entry.accountId
  }),
  hash(field<string>('row', 'accountId'))
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

  it('preserves unsorted source order across same-relation delete and insert batches', () => {
    const db = mat(makeDb(), entryRows);
    const result = tryTransact(
      db,
      deleteByKey(schema.entries, 'e1'),
      insert(schema.entries, { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true })
    );

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'incremental',
      recomputed: false
    }));
    expect(q(result.db, entryRows).map((row) => row.id)).toEqual(['e2', 'e3', 'e4', 'e1']);
    expect(q(result.db, entryRows)).toEqual(q(demat(result.db, entryRows), entryRows));
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

  it('uses a direct materialized hash for base relation equality lookups', () => {
    const instrumented = instrumentEntryArrayReads();
    const db = mat(instrumented.db, directEntriesByAccount);
    instrumented.reset();

    expect(q(db, cashEntriesByBaseLookup)).toEqual([
      { id: 'e1', amount: 120 },
      { id: 'e4', amount: 0 }
    ]);
    expect(instrumented.reads.rows).toBe(0);
  });

  it('uses a direct materialized unique index for base relation equality lookups', () => {
    const instrumented = instrumentEntryArrayReads();
    const db = mat(instrumented.db, directEntriesById);
    instrumented.reset();

    expect(q(db, entryByIdBaseLookup)).toEqual([
      { id: 'e2', accountId: 'sales', amount: -120 }
    ]);
    expect(instrumented.reads.rows).toBe(0);
  });

  it('does not use filtered or projected hash materializations for broader base relation lookups', () => {
    const db = mat(makeDb(), filteredProjectedEntriesByAccount);
    const fullCashEntries = pipe(
      from(entry),
      where(eq(entry.accountId, value('cash'))),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        accountId: entry.accountId,
        amount: entry.amount,
        posted: entry.posted
      })
    );
    const feesEntries = pipe(
      from(entry),
      where(eq(entry.accountId, value('fees'))),
      project({
        id: entry.id,
        accountId: entry.accountId,
        amount: entry.amount,
        posted: entry.posted
      })
    );

    expect(q(db, fullCashEntries)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120, posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false }
    ]);
    expect(q(db, feesEntries)).toEqual([
      { id: 'e3', accountId: 'fees', amount: -5, posted: true }
    ]);
  });

  it('falls back to base rows after direct hash materialization is removed', () => {
    const instrumented = instrumentEntryArrayReads();
    const db = demat(mat(instrumented.db, directEntriesByAccount), directEntriesByAccount);
    instrumented.reset();

    expect(q(db, cashEntriesByBaseLookup)).toEqual([
      { id: 'e1', amount: 120 },
      { id: 'e4', amount: 0 }
    ]);
    expect(instrumented.reads.rows).toBeGreaterThan(0);
  });

  it('uses materialized index lookups for q equality filters over materialized relations', () => {
    const db = mat(makeDb(), entriesByAccount);
    const relation = materializedRelationForQuery(db, entriesByAccount);
    const materializedSource = materializedSourceFor(db);
    if (relation === undefined || materializedSource === undefined) {
      throw new Error('expected materialized index relation and source');
    }

    const scanQuery = pipe(
      from(relation),
      sort(asc(field<string>('row', 'id')))
    );
    const indexedFilter = pipe(
      from(relation),
      where(eq(field<string>('row', 'accountId'), value('cash'))),
      sort(asc(field<string>('row', 'id')))
    );

    const scannedRows = q(db, scanQuery).filter((row) => row.accountId === 'cash');
    const filteredRows = q(db, indexedFilter);

    expect(filteredRows).toEqual(scannedRows);
    expect(filteredRows).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120, posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false }
    ]);

    const instrumented = instrumentSourceLookups(materializedSource);
    expect(evaluate(instrumented.source, indexedFilter)).toEqual({
      rows: scannedRows,
      diagnostics: []
    });
    expect(instrumented.reads).toEqual({ rows: 0, lookup: 1 });
    expect(instrumented.lookups).toEqual([{
      relation: relation.name,
      field: 'accountId',
      value: 'cash'
    }]);
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

type SourceReadCounts = {
  rows: number;
  lookup: number;
};

function instrumentEntryArrayReads(): {
  readonly db: ReturnType<typeof makeDb>;
  readonly reads: { rows: number };
  readonly reset: () => void;
} {
  const db = makeDb();
  const instrumented = instrumentArrayReads(db.data.entries ?? []);
  return {
    db: {
      ...db,
      data: {
        ...db.data,
        entries: instrumented.rows
      }
    },
    reads: instrumented.reads,
    reset: instrumented.reset
  };
}

function instrumentArrayReads<Row>(input: readonly Row[]): {
  readonly rows: readonly Row[];
  readonly reads: { rows: number };
  readonly reset: () => void;
} {
  const reads = { rows: 0 };
  const target = [...input];
  const rows = new Proxy(target, {
    get(targetRows, prop, receiver) {
      if (prop === 'filter') {
        return (callbackfn: (value: Row, index: number, array: Row[]) => unknown, thisArg?: unknown): Row[] => {
          reads.rows += 1;
          return targetRows.filter(callbackfn, thisArg);
        };
      }
      if (prop === Symbol.iterator) {
        return function* iterator(): IterableIterator<Row> {
          reads.rows += 1;
          yield* targetRows;
        };
      }
      if (isArrayIndexProperty(prop)) reads.rows += 1;
      return Reflect.get(targetRows, prop, receiver);
    }
  });

  return {
    rows,
    reads,
    reset: () => {
      reads.rows = 0;
    }
  };
}

function isArrayIndexProperty(prop: string | symbol): boolean {
  if (typeof prop !== 'string' || prop.length === 0) return false;
  const index = Number(prop);
  return Number.isInteger(index) && index >= 0 && String(index) === prop;
}

function instrumentSourceLookups(source: RelationSource): {
  readonly source: RelationSource;
  readonly reads: SourceReadCounts;
  readonly lookups: readonly { readonly relation: string; readonly field: string; readonly value: unknown }[];
} {
  const reads: SourceReadCounts = { rows: 0, lookup: 0 };
  const lookups: { relation: string; field: string; value: unknown }[] = [];

  return {
    reads,
    lookups,
    source: {
      ...(source.relationNames === undefined ? {} : { relationNames: source.relationNames }),
      rows: (relationRef) => {
        reads.rows += 1;
        return source.rows(relationRef);
      },
      lookup: (lookupValue) => {
        reads.lookup += 1;
        lookups.push({
          relation: lookupValue.relation.name,
          field: lookupValue.field,
          value: lookupValue.value
        });
        return source.lookup?.(lookupValue);
      },
      ...(source.rangeLookup === undefined
        ? {}
        : { rangeLookup: (lookupValue) => source.rangeLookup?.(lookupValue) }),
      ...(source.version === undefined ? {} : { version: source.version }),
      ...(source.diagnostics === undefined ? {} : { diagnostics: source.diagnostics })
    }
  };
}
