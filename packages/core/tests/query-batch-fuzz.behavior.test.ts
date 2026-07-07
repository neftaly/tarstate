import { describe, expect, it } from 'vitest';
import { q, qMany, qManyResult, qResult, type Db, type DbQueryOptions } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { asc, call, env, eq, field, from, gt, gte, hostFn, pipe, project, sort, value, where, type Query } from '@tarstate/core/query';
import { entry, makeDb, openingAccounts, openingEntries, type Entry } from './behavior-fixtures.js';
import { chooseSeeded, createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';

type IdRow = {
  readonly id: string;
  readonly accountId?: string;
  readonly amount?: number;
  readonly marker?: number;
};

type QueryFactory = {
  readonly label: string;
  readonly make: () => Query<IdRow>;
};

const duplicateCacheSeeds = resolveFuzzSeeds([5, 17, 31, 43] as const);
const unsafeDuplicateSeeds = resolveFuzzSeeds([7, 19, 53] as const);
const batchShapeSeeds = resolveFuzzSeeds([3, 8, 13, 21, 34, 55, 89, 144] as const);

describe('qMany seeded duplicate cache behavior', () => {
  it('reuses generated safe duplicate query batches once per duplicate key', () => {
    for (const seed of duplicateCacheSeeds) {
      const [first, second] = safeFactories(seed);
      const batch = {
        first: first.make(),
        duplicate: first.make(),
        wrappedDuplicate: { q: first.make() },
        other: second.make(),
        otherDuplicate: second.make()
      };
      const expectedRows = {
        first: q(makeDb(), first.make()),
        duplicate: q(makeDb(), first.make()),
        wrappedDuplicate: q(makeDb(), first.make()),
        other: q(makeDb(), second.make()),
        otherDuplicate: q(makeDb(), second.make())
      };

      const resultDb = countedEntriesDb();
      expect(qManyResult(resultDb.db, batch), `seed ${seed} ${first.label}/${second.label}`).toEqual({
        first: { rows: expectedRows.first, diagnostics: [] },
        duplicate: { rows: expectedRows.duplicate, diagnostics: [] },
        wrappedDuplicate: { rows: expectedRows.wrappedDuplicate, diagnostics: [] },
        other: { rows: expectedRows.other, diagnostics: [] },
        otherDuplicate: { rows: expectedRows.otherDuplicate, diagnostics: [] }
      });
      expect(resultDb.reads(), `seed ${seed} qManyResult reads`).toBe(2);

      const rowsDb = countedEntriesDb();
      expect(qMany(rowsDb.db, batch), `seed ${seed} qMany rows`).toEqual(expectedRows);
      expect(rowsDb.reads(), `seed ${seed} qMany reads`).toBe(2);
    }
  });

  it('skips generated duplicate reuse for unsafe options, host functions, and function sort keys', () => {
    for (const seed of unsafeDuplicateSeeds) {
      const duplicateQuery = safeFactories(seed)[0].make;

      let mapCalls = 0;
      assertUnsafeDuplicateReads(`seed ${seed} mapRows`, duplicateQuery, {
        mapRows: (rows) => {
          mapCalls += 1;
          return (rows as readonly IdRow[]).map((row) => ({ ...row, marker: mapCalls }));
        }
      });
      expect(mapCalls, `seed ${seed} mapRows calls`).toBe(2);

      assertUnsafeDuplicateReads(`seed ${seed} functions option`, duplicateQuery, {
        functions: { unused: () => seed }
      });

      let sortCalls = 0;
      assertUnsafeDuplicateReads(`seed ${seed} function sort`, entryIds, {
        sort: (row) => {
          sortCalls += 1;
          return (row as IdRow).id;
        }
      });
      expect(sortCalls, `seed ${seed} function sort calls`).toBeGreaterThan(0);

      let hostCalls = 0;
      const marker = hostFn<number>(`qMany.fuzz.marker.${seed}`, () => ++hostCalls);
      const hostQuery = () => pipe(
        from(entry),
        sort(asc(entry.row.id)),
        project({ id: entry.row.id, marker: call(marker) })
      );
      const hostDb = countedEntriesDb();
      const hostResult = qManyResult(hostDb.db, { first: hostQuery(), duplicate: hostQuery() });
      expect(hostDb.reads(), `seed ${seed} host reads`).toBe(2);
      expect(hostResult.first.rows.map((row) => row.marker), `seed ${seed} host first markers`).toEqual([1, 2, 3, 4]);
      expect(hostResult.duplicate.rows.map((row) => row.marker), `seed ${seed} host duplicate markers`).toEqual([5, 6, 7, 8]);
    }
  });

  it('matches independent reads across generated batch target and option shapes', () => {
    for (const seed of batchShapeSeeds) {
      const testCase = batchCase(seed);

      expect(qMany(testCase.db, testCase.batch, testCase.options), `seed ${seed} ${testCase.label} rows`).toEqual(
        expectedBatchRows(testCase.db, testCase.batch, testCase.options)
      );
      expect(qManyResult(testCase.db, testCase.batch, testCase.options), `seed ${seed} ${testCase.label} result`).toEqual(
        expectedBatchResult(testCase.db, testCase.batch, testCase.options)
      );
    }
  });
});

function safeFactories(seed: number): readonly [QueryFactory, QueryFactory] {
  const variants = safeFactoryVariants(seed);
  const firstIndex = seed % variants.length;
  const secondIndex = (firstIndex + 2) % variants.length;
  const first = variants[firstIndex];
  const second = variants[secondIndex];
  if (first === undefined || second === undefined) throw new Error('missing qMany fuzz variant');
  return [first, second];
}

function safeFactoryVariants(seed: number): readonly QueryFactory[] {
  const next = createSeededRandom(seed);
  const accountId = openingAccounts[Math.floor(next() * openingAccounts.length)]?.id ?? 'cash';
  const amount = [-40, -5, 0, 12, 75][Math.floor(next() * 5)] ?? 0;
  const posted = next() > 0.5;
  return [
    {
      label: `posted:${posted}`,
      make: () => pipe(
        from(entry),
        where(eq(entry.row.posted, value(posted))),
        sort(asc(entry.row.id)),
        project({ id: entry.row.id })
      )
    },
    {
      label: `account:${accountId}`,
      make: () => pipe(
        from(entry),
        where(eq(entry.row.accountId, value(accountId))),
        sort(asc(entry.row.id)),
        project({ id: entry.row.id, accountId: entry.row.accountId })
      )
    },
    {
      label: `amount:${amount}`,
      make: () => pipe(
        from(entry),
        where(gt(entry.row.amount, value(amount))),
        sort(asc(entry.row.id)),
        project({ id: entry.row.id, amount: entry.row.amount })
      )
    },
    {
      label: 'plain-sort',
      make: () => pipe(
        from(entry),
        sort(asc(field<string>('row', 'accountId')), asc(entry.row.id)),
        project({ id: entry.row.id, accountId: entry.row.accountId, amount: entry.row.amount })
      )
    }
  ];
}

function assertUnsafeDuplicateReads(
  label: string,
  makeQuery: () => Query<IdRow>,
  options: Parameters<typeof qManyResult>[2]
): void {
  const db = countedEntriesDb();
  const result = qManyResult(db.db, { first: makeQuery(), duplicate: makeQuery() }, options);
  expect(result.first.diagnostics, `${label} first diagnostics`).toEqual([]);
  expect(result.duplicate.diagnostics, `${label} duplicate diagnostics`).toEqual([]);
  expect(result.first.rows.length, `${label} first row count`).toBe(result.duplicate.rows.length);
  expect(db.reads(), `${label} relation reads`).toBe(2);
}

function entryIds(): Query<IdRow> {
  return pipe(from(entry), project({ id: entry.row.id }));
}

function countedEntriesDb(rows: readonly Entry[] = openingEntries): { readonly db: Db; readonly reads: () => number } {
  let entryReads = 0;
  const entryRows = rows.map((row) => ({ ...row }));
  const data: Record<string, readonly unknown[]> = {
    accounts: openingAccounts.map((row) => ({ ...row }))
  };
  Object.defineProperty(data, 'entries', {
    enumerable: true,
    get: () => {
      entryReads += 1;
      return entryRows;
    }
  });
  return {
    db: { data, env: {} } satisfies Db,
    reads: () => entryReads
  };
}

type AnyBatchTarget =
  | Query<unknown>
  | (DbQueryOptions<unknown, unknown, unknown> & { readonly q: Query<unknown> });
type AnyBatch = Record<string, AnyBatchTarget>;
type BatchOptions = DbQueryOptions<unknown, unknown>;
type BatchCase = {
  readonly label: string;
  readonly db: Db;
  readonly batch: AnyBatch;
  readonly options: BatchOptions;
};

function batchCase(seed: number): BatchCase {
  const next = createSeededRandom(seed);
  const minAmount = chooseSeeded(next, [-120, -5, 0, 1, 50] as const);
  const projected = () => pipe(
    from(entry),
    project({
      id: entry.row.id,
      accountId: entry.row.accountId,
      amount: entry.row.amount,
      posted: entry.row.posted
    })
  );
  const envFiltered = () => pipe(
    from(entry),
    where(gte(entry.row.amount, env<number>('minAmount'))),
    project({
      id: entry.row.id,
      accountId: entry.row.accountId,
      amount: entry.row.amount,
      posted: entry.row.posted
    })
  );
  const materializedQuery = projected();
  const db = seed % 2 === 0 ? mat(makeDb(), materializedQuery) : makeDb();

  switch (seed % 4) {
    case 0:
      return {
        label: 'global-env-and-sort',
        db,
        options: { env: { minAmount }, sort: ['accountId', 'id'] },
        batch: {
          raw: envFiltered(),
          wrapped: { q: envFiltered() },
          targetOverride: { q: envFiltered(), rsort: ['amount', 'id'] }
        }
      };
    case 1:
      return {
        label: 'map-rows-and-into',
        db,
        options: { env: { minAmount } },
        batch: {
          raw: envFiltered(),
          labels: {
            q: envFiltered(),
            sort: ['accountId', 'id'],
            mapRows: (rows) => rows.map((row) => {
              const value = idRow(row);
              return { id: value.id, label: `${value.accountId}:${value.amount}` };
            })
          },
          joinedIds: {
            q: envFiltered(),
            sort: 'id',
            mapRows: (rows) => rows.map((row) => idRow(row).id),
            into: (rows) => rows.join('|')
          }
        }
      };
    case 2:
      return {
        label: 'materialized-targets',
        db,
        options: { sort: ['accountId', 'id'] },
        batch: {
          rawMaterialized: materializedQuery,
          wrappedMaterialized: { q: materializedQuery },
          descendingMaterialized: { q: materializedQuery, rsort: ['amount', 'id'] }
        }
      };
    default:
      return {
        label: 'function-sort-keys',
        db,
        options: {},
        batch: {
          raw: projected(),
          functionSorted: {
            q: projected(),
            sort: [
              (row) => idRow(row).accountId ?? '',
              (row) => idRow(row).id
            ]
          },
          functionReverse: {
            q: projected(),
            rsort: (row) => idRow(row).amount ?? 0
          }
        }
      };
  }
}

function expectedBatchRows(
  db: Db,
  batch: AnyBatch,
  options: BatchOptions
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, target] of Object.entries(batch)) {
    output[name] = readRows(db, targetQuery(target), targetOptions(target, options));
  }
  return output;
}

function expectedBatchResult(
  db: Db,
  batch: AnyBatch,
  options: BatchOptions
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, target] of Object.entries(batch)) {
    output[name] = readResult(db, targetQuery(target), targetOptions(target, options));
  }
  return output;
}

function targetQuery(target: AnyBatchTarget): Query<unknown> {
  return isWrappedTarget(target) ? target.q : target;
}

function targetOptions(
  target: AnyBatchTarget,
  options: BatchOptions
): DbQueryOptions<unknown, unknown, unknown> {
  if (!isWrappedTarget(target)) return options;
  const { q: _query, ...targetOnlyOptions } = target;
  return { ...options, ...targetOnlyOptions };
}

function readRows(
  db: Db,
  query: Query<unknown>,
  options: DbQueryOptions<unknown, unknown, unknown>
): unknown {
  return hasInto(options)
    ? q(db, query, options)
    : q(db, query, options as DbQueryOptions<unknown, unknown>);
}

function readResult(
  db: Db,
  query: Query<unknown>,
  options: DbQueryOptions<unknown, unknown, unknown>
): unknown {
  return hasInto(options)
    ? qResult(db, query, options)
    : qResult(db, query, options as DbQueryOptions<unknown, unknown>);
}

function hasInto(
  options: DbQueryOptions<unknown, unknown, unknown>
): options is DbQueryOptions<unknown, unknown, unknown> & { readonly into: (rows: readonly unknown[]) => unknown } {
  return options.into !== undefined;
}

function isWrappedTarget(
  target: AnyBatchTarget
): target is DbQueryOptions<unknown, unknown, unknown> & { readonly q: Query<unknown> } {
  return 'q' in target;
}

function idRow(input: unknown): IdRow {
  if (!isRecord(input)) throw new TypeError('Expected object row');
  const id = input.id;
  if (typeof id !== 'string') throw new TypeError('Expected row id');
  const output: { id: string; accountId?: string; amount?: number; marker?: number } = { id };
  if (typeof input.accountId === 'string') output.accountId = input.accountId;
  if (typeof input.amount === 'number') output.amount = input.amount;
  if (typeof input.marker === 'number') output.marker = input.marker;
  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
