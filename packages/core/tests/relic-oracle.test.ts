import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDb, q, transact } from '@tarstate/core/db';
import {
  aggregate,
  asc,
  avg,
  clauses,
  constRows,
  count,
  difference,
  field,
  from,
  gt,
  intersection,
  join,
  leftJoin,
  maybe,
  pipe,
  project,
  sort,
  sum,
  union,
  value,
  where
} from '@tarstate/core/query';
import { deleteByKey, insert, updateByKey } from '@tarstate/core/write';
import { account, entry, makeDb, schema, type Account, type Entry } from './behavior-fixtures.js';

type JsonScalar = string | number | boolean | null;
type JsonRow = Record<string, JsonScalar>;

type OracleCase = {
  readonly id: string;
  readonly expected: readonly JsonRow[];
  readonly tarstateRows: () => readonly unknown[];
};

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const oracleScript = path.join(repoRoot, 'scripts/relic-oracle/oracle.clj');
const relicDeps = '{:deps {com.wotbrew/relic {:mvn/version "0.1.7"}}}';

const left = constRows<{ readonly id: string }>([{ id: 'a' }, { id: 'b' }]);
const right = constRows<{ readonly id: string }>([{ id: 'b' }, { id: 'c' }]);
const sortedById = sort(asc(field<string>('row', 'id')));

const cases = [
  {
    id: 'simpleProjection',
    expected: [{ id: 'e1', amount: 120 }],
    tarstateRows: () => q(
      makeDb(),
      pipe(
        from(entry),
        where(gt(entry.row.amount, value(0))),
        sort(asc(entry.row.id)),
        project({ id: entry.row.id, amount: entry.row.amount })
      )
    )
  },
  {
    id: 'join',
    expected: [
      { entryId: 'e1', accountName: 'Cash', amount: 120 },
      { entryId: 'e2', accountName: 'Sales', amount: -120 },
      { entryId: 'e3', accountName: 'Bank fees', amount: -5 },
      { entryId: 'e4', accountName: 'Cash', amount: 0 }
    ],
    tarstateRows: () => q(
      makeDb(),
      pipe(
        from(entry),
        join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
        sort(asc(entry.row.id)),
        project({
          entryId: entry.row.id,
          accountName: account.row.name,
          amount: entry.row.amount
        })
      )
    )
  },
  {
    id: 'leftJoin',
    expected: [
      { accountId: 'cash', accountName: 'Cash', entryId: 'e1' },
      { accountId: 'cash', accountName: 'Cash', entryId: 'e4' },
      { accountId: 'equity', accountName: 'Owner equity', entryId: null },
      { accountId: 'fees', accountName: 'Bank fees', entryId: 'e3' },
      { accountId: 'sales', accountName: 'Sales', entryId: 'e2' }
    ],
    tarstateRows: () => q(
      makeDb(),
      pipe(
        from(account),
        leftJoin(from(entry), clauses<Account, Entry>({ id: 'accountId' })),
        sort(asc(account.row.id), asc(entry.row.id, 'last')),
        project({
          accountId: account.row.id,
          accountName: account.row.name,
          entryId: maybe(entry.row.id)
        })
      )
    )
  },
  {
    id: 'aggregate',
    expected: [
      { accountId: 'cash', entryCount: 2, total: 120, average: 60 },
      { accountId: 'fees', entryCount: 1, total: -5, average: -5 },
      { accountId: 'sales', entryCount: 1, total: -120, average: -120 }
    ],
    tarstateRows: () => q(
      makeDb(),
      pipe(
        from(entry),
        aggregate({
          groupBy: { accountId: entry.row.accountId },
          aggregates: {
            entryCount: count(),
            total: sum(entry.row.amount),
            average: avg(entry.row.amount)
          }
        }),
        sort(asc(field<string>('row', 'accountId')))
      )
    )
  },
  {
    id: 'setUnion',
    expected: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    tarstateRows: () => q(createDb(), pipe(union(left, right), sortedById))
  },
  {
    id: 'setIntersection',
    expected: [{ id: 'b' }],
    tarstateRows: () => q(createDb(), pipe(intersection(left, right), sortedById))
  },
  {
    id: 'setDifference',
    expected: [{ id: 'a' }],
    tarstateRows: () => q(createDb(), pipe(difference(left, right), sortedById))
  },
  {
    id: 'transaction',
    expected: [
      { id: 'e1', accountId: 'cash', amount: 125, posted: true },
      { id: 'e3', accountId: 'fees', amount: -5, posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false },
      { id: 'e5', accountId: 'cash', amount: 15, posted: true }
    ],
    tarstateRows: () => q(
      transact(makeDb(), [
        insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 15, posted: true }),
        updateByKey(schema.entries, 'e1', { amount: 125 }),
        deleteByKey(schema.entries, 'e2')
      ]),
      pipe(
        from(entry),
        sort(asc(entry.row.id)),
        project({
          id: entry.row.id,
          accountId: entry.row.accountId,
          amount: entry.row.amount,
          posted: entry.row.posted
        })
      )
    )
  }
] as const satisfies readonly OracleCase[];

describe('Relic oracle harness', () => {
  it.each(cases)('keeps Tarstate golden mapping for $id', (item) => {
    expect(normalizeRows(item.tarstateRows())).toEqual(item.expected);
  });

  it.skipIf(process.env.TARSTATE_RELIC_ORACLE !== '1')(
    'compares Tarstate golden cases with wotbrew/relic when TARSTATE_RELIC_ORACLE=1',
    (context) => {
      const relicRows = runRelicOracle(context.skip);

      for (const item of cases) {
        expect(relicRows[item.id], item.id).toEqual(item.expected);
      }
    },
    20_000
  );
});

function normalizeRows(rows: readonly unknown[]): readonly JsonRow[] {
  return rows.map((rowValue) => {
    if (!isRecord(rowValue)) throw new TypeError('Expected query row object');

    return Object.fromEntries(
      Object.entries(rowValue).map(([key, valueValue]) => [key, valueValue === undefined ? null : valueValue])
    ) as JsonRow;
  });
}

function runRelicOracle(skip: (note?: string) => void): Record<string, readonly JsonRow[]> {
  const availability = spawnClojure([
    '-Sdeps',
    relicDeps,
    '-M',
    '-e',
    '(require (quote [com.wotbrew.relic :as rel])) (println :ok)'
  ]);

  if (availability.error !== undefined) {
    if (isSpawnUnavailable(availability.error)) {
      skip(`Clojure could not be spawned (${spawnErrorCode(availability.error) ?? 'unknown'}); skipping optional Relic oracle comparison.`);
      return {};
    }

    throw availability.error;
  }

  if (availability.status !== 0) {
    const output = commandOutput(availability);
    skip(`Relic is not available to Clojure; skipping optional comparison. ${output}`);
    return {};
  }

  const result = spawnClojure([
    '-Sdeps',
    relicDeps,
    '-M',
    oracleScript
  ]);

  if (result.error !== undefined) {
    if (isSpawnUnavailable(result.error)) {
      skip(`Clojure could not be spawned (${spawnErrorCode(result.error) ?? 'unknown'}); skipping optional Relic oracle comparison.`);
      return {};
    }

    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error('Relic oracle command failed:\n' + commandOutput(result));
  }

  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed)) throw new TypeError('Relic oracle did not return a JSON object');

  return parsed as Record<string, readonly JsonRow[]>;
}

function spawnClojure(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync('clojure', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function isRecord(valueValue: unknown): valueValue is Record<string, unknown> {
  return typeof valueValue === 'object' && valueValue !== null && !Array.isArray(valueValue);
}

function isSpawnUnavailable(error: Error): boolean {
  return spawnErrorCode(error) === 'ENOENT' || spawnErrorCode(error) === 'EPERM';
}

function spawnErrorCode(error: Error): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
