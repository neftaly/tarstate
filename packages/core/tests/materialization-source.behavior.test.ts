import { describe, expect, it } from 'vitest';
import { createDb, q, qResult, transact, tryTransact } from '@tarstate/core/db';
import { evaluate } from '@tarstate/core/evaluate';
import {
  maintainMaterializationSnapshots,
  mat,
  materializedRelationForQuery,
  materializedRowsForQuery,
  materializedSourceFor,
  readMaterializedQuery
} from '@tarstate/core/materialization';
import {
  asc,
  btree,
  call,
  env,
  eq,
  field,
  from,
  gt,
  hash,
  hostFn,
  lt,
  pipe,
  project,
  sort,
  uniqueIndex,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import { type RelationSource } from '@tarstate/core/source';
import { insert, updateByKey } from '@tarstate/core/write';
import { entry, makeDb, schema, type Entry } from './behavior-fixtures.js';

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

function requireMaterializedRelationForQuery(db: unknown, query: Query<unknown>) {
  const relation = materializedRelationForQuery(db, query);
  if (relation === undefined) throw new Error('expected materialized relation metadata');
  return relation;
}

function requireMaterializedSourceFor(input: unknown): RelationSource {
  const source = materializedSourceFor(input);
  if (source === undefined) throw new Error('expected materialized source');
  return source;
}

type SourceReadCounts = {
  rows: number;
  lookup: number;
  rangeLookup: number;
};

function observedSourceFor(source: RelationSource): {
  readonly source: RelationSource;
  readonly reads: SourceReadCounts;
} {
  const reads: SourceReadCounts = { rows: 0, lookup: 0, rangeLookup: 0 };
  return {
    reads,
    source: {
      ...(source.relationNames === undefined ? {} : { relationNames: source.relationNames }),
      rows: (relation) => {
        reads.rows += 1;
        return source.rows(relation);
      },
      lookup: (lookupValue) => {
        reads.lookup += 1;
        return source.lookup?.(lookupValue);
      },
      rangeLookup: (lookupValue) => {
        reads.rangeLookup += 1;
        return source.rangeLookup?.(lookupValue);
      },
      ...(source.version === undefined ? {} : { version: source.version }),
      ...(source.diagnostics === undefined ? {} : { diagnostics: source.diagnostics })
    }
  };
}

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

  it('serves materialized hash lookups from declared indexes and rebuilds them after maintenance', () => {
    const query = pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      hash(field<string>('row', 'accountId'))
    ) as Query<unknown>;
    const db = mat(makeDb(), query);
    const relation = requireMaterializedRelationForQuery(db, query);
    const source = materializedSourceFor(db);

    expect(source?.lookup?.({ relation, field: 'accountId', value: 'cash' })).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ]);

    const result = tryTransact(db, updateByKey(schema.entries, 'e2', { accountId: 'cash' }));
    const afterSource = materializedSourceFor(result.db);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]?.indexSpecs).toEqual([
      expect.objectContaining({ op: 'hash', field: 'accountId' })
    ]);
    expect(afterSource?.lookup?.({ relation, field: 'accountId', value: 'cash' })).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e2', accountId: 'cash', amount: -120 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ]);
  });

  it('serves materialized btree range lookups in materialized row order', () => {
    const query = pipe(
      from(entry),
      sort(asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      btree(field<number>('row', 'amount'))
    ) as Query<unknown>;
    const db = mat(makeDb(), query);
    const relation = requireMaterializedRelationForQuery(db, query);
    const source = materializedSourceFor(db);

    expect(source?.rangeLookup?.({
      relation,
      field: 'amount',
      lower: { value: -10, inclusive: true }
    })).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ]);
  });

  it('treats uniqueIndex as a lookup hint rather than a uniqueness constraint', () => {
    const query = pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      uniqueIndex(field<string>('row', 'accountId'))
    ) as Query<unknown>;
    const db = mat(makeDb(), query);
    const relation = requireMaterializedRelationForQuery(db, query);
    const source = materializedSourceFor(db);

    expect(source?.lookup?.({ relation, field: 'accountId', value: 'cash' })).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ]);

    const result = tryTransact(db, updateByKey(schema.entries, 'e2', { accountId: 'cash' }));

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]?.indexSpecs).toEqual([
      expect.objectContaining({ op: 'uniqueIndex', field: 'accountId' })
    ]);
    expect(materializedSourceFor(result.db)?.lookup?.({ relation, field: 'accountId', value: 'cash' })).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e2', accountId: 'cash', amount: -120 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ]);
  });

  it('evaluates where equality against materialized sources through declared hash indexes', () => {
    const query = pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      hash(field<string>('row', 'accountId'))
    ) as Query<unknown>;
    const db = mat(makeDb(), query);
    const relation = requireMaterializedRelationForQuery(db, query);
    const observed = observedSourceFor(requireMaterializedSourceFor(db));
    const result = evaluate(
      observed.source,
      pipe(
        from(relation),
        where(eq(field<string>('row', 'accountId'), value('cash'))),
        sort(asc(field<string>('row', 'id'))),
        project({
          id: field<string>('row', 'id'),
          amount: field<number>('row', 'amount')
        })
      )
    );

    expect(result).toEqual({
      rows: [{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }],
      diagnostics: []
    });
    expect(observed.reads).toEqual({ rows: 0, lookup: 1, rangeLookup: 0 });
  });

  it('evaluates materialized-source where filters through fallback lookups when indexes are mismatched or undeclared', () => {
    const hashByAccountQuery = pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      hash(field<string>('row', 'accountId'))
    ) as Query<unknown>;
    const hashDb = mat(makeDb(), hashByAccountQuery);
    const hashRelation = requireMaterializedRelationForQuery(hashDb, hashByAccountQuery);
    const mismatched = observedSourceFor(requireMaterializedSourceFor(hashDb));

    expect(evaluate(
      mismatched.source,
      pipe(
        from(hashRelation),
        where(eq(field<string>('row', 'id'), value('e3'))),
        project({
          id: field<string>('row', 'id'),
          amount: field<number>('row', 'amount')
        })
      )
    )).toEqual({
      rows: [{ id: 'e3', amount: -5 }],
      diagnostics: []
    });
    expect(mismatched.reads).toEqual({ rows: 0, lookup: 1, rangeLookup: 0 });

    const unindexedQuery = pipe(
      from(entry),
      sort(asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>;
    const unindexedDb = mat(makeDb(), unindexedQuery);
    const unindexedRelation = requireMaterializedRelationForQuery(unindexedDb, unindexedQuery);
    const undeclared = observedSourceFor(requireMaterializedSourceFor(unindexedDb));

    expect(evaluate(
      undeclared.source,
      pipe(
        from(unindexedRelation),
        where(gt(field<number>('row', 'amount'), value(0))),
        project({
          id: field<string>('row', 'id'),
          amount: field<number>('row', 'amount')
        })
      )
    )).toEqual({
      rows: [{ id: 'e1', amount: 120 }],
      diagnostics: []
    });
    expect(undeclared.reads).toEqual({ rows: 0, lookup: 0, rangeLookup: 1 });
  });

  it('evaluates materialized-source where ranges through declared btree indexes at edge bounds', () => {
    const entries = Array.from({ length: 64 }, (_, indexValue): Entry => ({
      id: `g${String(indexValue).padStart(2, '0')}`,
      accountId: indexValue % 2 === 0 ? 'cash' : 'sales',
      amount: indexValue - 32,
      posted: true
    }));
    const query = pipe(
      from(entry),
      sort(asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      btree(field<number>('row', 'amount'))
    ) as Query<unknown>;
    const db = mat(createDb({ ...makeDb().data, entries }), query);
    const relation = requireMaterializedRelationForQuery(db, query);
    const evaluateAmountWhere = (predicate: ReturnType<typeof lt>) => {
      const observed = observedSourceFor(requireMaterializedSourceFor(db));
      const result = evaluate(
        observed.source,
        pipe(
          from(relation),
          where(predicate),
          sort(asc(field<string>('row', 'id'))),
          project({
            id: field<string>('row', 'id'),
            amount: field<number>('row', 'amount')
          })
        )
      );
      expect(observed.reads).toEqual({ rows: 0, lookup: 0, rangeLookup: 1 });
      return result;
    };

    expect(evaluateAmountWhere(lt(field<number>('row', 'amount'), value(-30)))).toEqual({
      rows: [{ id: 'g00', amount: -32 }, { id: 'g01', amount: -31 }],
      diagnostics: []
    });
    expect(evaluateAmountWhere(gt(field<number>('row', 'amount'), value(30)))).toEqual({
      rows: [{ id: 'g63', amount: 31 }],
      diagnostics: []
    });
    expect(evaluateAmountWhere(lt(field<number>('row', 'amount'), value(-40)))).toEqual({
      rows: [],
      diagnostics: []
    });
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
