import { describe, expect, it } from 'vitest';
import { q, qMany, qManyResult, type Db } from '@tarstate/core/db';
import { asc, call, eq, field, from, gt, hostFn, pipe, project, sort, value, where, type Query } from '@tarstate/core/query';
import { entry, makeDb, openingAccounts, openingEntries, type Entry } from './behavior-fixtures.js';
import { createSeededRandom } from './fuzz-helpers.js';

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

describe('qMany seeded duplicate cache behavior', () => {
  it('reuses generated safe duplicate query batches once per duplicate key', () => {
    for (const seed of [5, 17, 31, 43] as const) {
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
    for (const seed of [7, 19, 53] as const) {
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
        sort(asc(entry.id)),
        project({ id: entry.id, marker: call(marker) })
      );
      const hostDb = countedEntriesDb();
      const hostResult = qManyResult(hostDb.db, { first: hostQuery(), duplicate: hostQuery() });
      expect(hostDb.reads(), `seed ${seed} host reads`).toBe(2);
      expect(hostResult.first.rows.map((row) => row.marker), `seed ${seed} host first markers`).toEqual([1, 2, 3, 4]);
      expect(hostResult.duplicate.rows.map((row) => row.marker), `seed ${seed} host duplicate markers`).toEqual([5, 6, 7, 8]);
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
        where(eq(entry.posted, value(posted))),
        sort(asc(entry.id)),
        project({ id: entry.id })
      )
    },
    {
      label: `account:${accountId}`,
      make: () => pipe(
        from(entry),
        where(eq(entry.accountId, value(accountId))),
        sort(asc(entry.id)),
        project({ id: entry.id, accountId: entry.accountId })
      )
    },
    {
      label: `amount:${amount}`,
      make: () => pipe(
        from(entry),
        where(gt(entry.amount, value(amount))),
        sort(asc(entry.id)),
        project({ id: entry.id, amount: entry.amount })
      )
    },
    {
      label: 'plain-sort',
      make: () => pipe(
        from(entry),
        sort(asc(field<string>('row', 'accountId')), asc(entry.id)),
        project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
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
  return pipe(from(entry), project({ id: entry.id }));
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
