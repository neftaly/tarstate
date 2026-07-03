import { describe, expect, it } from 'vitest';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import {
  aggregate,
  and,
  asc,
  btree,
  clauses,
  constRows,
  count,
  desc,
  difference,
  eq,
  extend,
  expand,
  field,
  from,
  gt,
  gte,
  hash,
  ifElse,
  intersection,
  join,
  leftJoin,
  not,
  or,
  pipe,
  project,
  qualify,
  rename,
  sort,
  sortLimit,
  sum,
  uniqueIndex,
  value,
  where,
  without,
  union,
  type Query
} from '@tarstate/core/query';
import { fromRelicQuery, fromRelicTx } from '@tarstate/core/relic';
import {
  deleteExact,
  deleteRows,
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  replaceAll,
  update,
  type WritePatch
} from '@tarstate/core/write';
import { account, entry, makeDb, schema, type Account, type Entry } from './behavior-fixtures.js';
import { chooseSeeded, createSeededRandom } from './fuzz-helpers.js';

type RelicQueryCase = {
  readonly label: string;
  readonly form: readonly unknown[];
  readonly query: Query<unknown>;
  readonly db?: Db;
};
type EntryWithEntryId = Omit<Entry, 'id'> & { readonly entryId: string };

type TxCase = {
  readonly label: string;
  readonly form: unknown;
  readonly patches: readonly WritePatch[];
};

const querySeeds = Array.from({ length: 48 }, (_, index) => index + 1);
const txSeeds = Array.from({ length: 32 }, (_, index) => index + 101);

describe('Relic compatibility seeded fuzz', () => {
  it('parses generated query forms like equivalent builder queries', () => {
    for (const seed of querySeeds) {
      const testCase = relicQueryCase(seed);
      const db = testCase.db ?? makeDb();

      expect(q(db, fromRelicQuery(testCase.form, schema)), `seed ${seed} ${testCase.label}`).toEqual(
        q(db, testCase.query)
      );
    }
  });

  it('parses generated transaction forms like equivalent write patches', () => {
    for (const seed of txSeeds) {
      const testCase = relicTxCase(seed);
      const parsed = fromRelicTx(testCase.form, schema);

      expect(parsed, `seed ${seed} ${testCase.label} patches`).toEqual(testCase.patches);
      expect(transact(makeDb(), parsed).data, `seed ${seed} ${testCase.label} db`).toEqual(
        transact(makeDb(), testCase.patches).data
      );
    }
  });
});

function relicQueryCase(seed: number): RelicQueryCase {
  const next = createSeededRandom(seed);
  const minAmount = chooseSeeded(next, [-121, -5, 0, 1, 50] as const);
  const accountId = chooseSeeded(next, ['cash', 'sales', 'fees'] as const);
  const posted = chooseSeeded(next, [true, false] as const);
  const variant = seed % 12;

  switch (variant) {
    case 0:
      return {
        label: 'from/where/select',
        form: [
          [':from', ':entries'],
          [':where', ['>=', ':amount', minAmount]],
          [':select', ':id', ':amount'],
          [':sort', ':id']
        ],
        query: pipe(
          from(entry),
          where(gte(entry.amount, value(minAmount))),
          project({ id: entry.id, amount: entry.amount }),
          sort(asc(field<string>('row', 'id')))
        )
      };
    case 1: {
      const rows = generatedEntries(seed);
      return {
        label: 'const/where/project',
        db: createDb(),
        form: [
          [':const', rows],
          [':where', ['>', ':amount', minAmount]],
          [':select', ':id', ':amount'],
          [':sort', ':id']
        ],
        query: pipe(
          constRows(rows),
          where(gt(field<number>('row', 'amount'), value(minAmount))),
          project({ id: field<string>('row', 'id'), amount: field<number>('row', 'amount') }),
          sort(asc(field<string>('row', 'id')))
        )
      };
    }
    case 2:
      return {
        label: 'extend/without/rename/qualify',
        form: [
          [':from', ':entries'],
          [':where', ['=', ':posted', posted]],
          [':extend',
            [':entryId', ':id'],
            [':bucket', [':if', ['>=', ':amount', 0], 'inflow', 'outflow']]],
          [':sort', ':entryId'],
          [':without', ':id', ':memo'],
          [':rename', { ':entryId': ':id' }],
          [':qualify', 'entry']
        ],
        query: pipe(
          from(entry),
          where(eq(entry.posted, value(posted))),
          extend({
            entryId: entry.id,
            bucket: ifElse(gte(entry.amount, value(0)), value('inflow'), value('outflow'))
          }),
          sort(asc(field<string>('row', 'entryId'))),
          without('id', 'memo'),
          rename({ entryId: 'id' }),
          qualify('entry')
        )
      };
    case 3: {
      const orders = generatedOrders(seed);
      return {
        label: 'expand',
        db: createDb(),
        form: [
          [':const', orders],
          [':expand', [[':sku', ':qty'], ':lines']],
          [':select', [':orderId', ':id'], ':sku', ':qty'],
          [':sort', ':orderId', ':sku']
        ],
        query: pipe(
          constRows(orders),
          expand(field<readonly OrderLine[]>('row', 'lines'), { fields: ['sku', 'qty'] as const }),
          project({
            orderId: field<string>('row', 'id'),
            sku: field<string>('row', 'sku'),
            qty: field<number>('row', 'qty')
          }),
          sort(asc(field<string>('row', 'orderId')), asc(field<string>('row', 'sku')))
        )
      };
    }
    case 4:
      return {
        label: 'join',
        form: [
          [':from', ':entries'],
          [':extend', [':entryId', ':id']],
          [':without', ':id'],
          [':join', ':accounts', { ':accountId': ':id' }],
          [':select', [':entryId', ':entryId'], [':accountName', ':name'], ':amount'],
          [':sort', ':entryId']
        ],
        query: pipe(
          from(entry),
          extend({ entryId: entry.id }),
          without('id'),
          join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
          project({
            entryId: field<string>('row', 'entryId'),
            accountName: account.$.name,
            amount: entry.amount
          }),
          sort(asc(field<string>('row', 'entryId')))
        )
      };
    case 5:
      return {
        label: 'left-join',
        form: [
          [':from', ':accounts'],
          [
            ':left-join',
            [
              [':from', ':entries'],
              [':extend', [':entryId', ':id']],
              [':without', ':id']
            ],
            { ':id': ':accountId' }
          ],
          [':select', [':accountId', ':id'], [':accountName', ':name'], ':entryId'],
          [':sort', ':accountId', [':entryId', ':asc', ':last']]
        ],
        query: pipe(
          from(account),
          leftJoin(
            pipe(from(entry), extend({ entryId: entry.id }), without('id')),
            clauses<Account, EntryWithEntryId>({ id: 'accountId' })
          ),
          project({
            accountId: account.id,
            accountName: account.$.name,
            entryId: field<string>('row', 'entryId')
          }),
          sort(asc(field<string>('row', 'accountId')), asc(field<string>('row', 'entryId'), 'last'))
        )
      };
    case 6:
      return {
        label: 'aggregate',
        form: [
          [':from', ':entries'],
          [
            ':agg',
            [':accountId'],
            [':entryCount', ['count']],
            [':postedCount', ['count', ['=', ':posted', true]]],
            [':total', ['rel/sum', ':amount']]
          ],
          [':sort', ':accountId']
        ],
        query: pipe(
          from(entry),
          aggregate({
            groupBy: { accountId: entry.accountId },
            aggregates: {
              entryCount: count(),
              postedCount: count(eq(entry.posted, value(true))),
              total: sum(entry.amount)
            }
          }),
          sort(asc(field<string>('row', 'accountId')))
        )
      };
    case 7:
      return setOpCase(seed);
    case 8: {
      const limitCount = chooseSeeded(next, [1, 2, 3] as const);
      const direction = chooseSeeded(next, ['asc', 'desc'] as const);
      return {
        label: 'sort-limit',
        form: [
          [':from', ':entries'],
          [':sort-limit', limitCount, [':amount', `:${direction}`], ':id'],
          [':select', ':id', ':amount']
        ],
        query: pipe(
          from(entry),
          sortLimit(limitCount, direction === 'desc' ? desc(entry.amount) : asc(entry.amount), asc(entry.id)),
          project({ id: entry.id, amount: entry.amount })
        )
      };
    }
    case 9:
      return indexCase(seed);
    case 10:
      return {
        label: 'compound-where',
        form: [
          [':from', ':entries'],
          [':where',
            ['or', ['=', ':accountId', accountId], ['>=', ':amount', minAmount]],
            ['not', ['=', ':posted', false]]],
          [':select', ':id', ':accountId', ':amount', ':posted'],
          [':sort', ':id']
        ],
        query: pipe(
          from(entry),
          where(and(
            or(eq(entry.accountId, value(accountId)), gte(entry.amount, value(minAmount))),
            not(eq(entry.posted, value(false)))
          )),
          project({
            id: entry.id,
            accountId: entry.accountId,
            amount: entry.amount,
            posted: entry.posted
          }),
          sort(asc(field<string>('row', 'id')))
        )
      };
    default:
      return {
        label: 'aggregate-without-group',
        form: [
          [':from', ':entries'],
          [':agg', [':entryCount', ['count']], [':total', ['rel/sum', ':amount']]]
        ],
        query: pipe(
          from(entry),
          aggregate({
            aggregates: {
              entryCount: count(),
              total: sum(entry.amount)
            }
          })
        )
      };
  }
}

function setOpCase(seed: number): RelicQueryCase {
  const leftRows = [{ id: 'a' }, { id: 'b' }, { id: `seed-${seed % 3}` }];
  const rightRows = [{ id: 'b' }, { id: 'c' }, { id: `seed-${(seed + 1) % 3}` }];
  const leftForm = [[':const', leftRows]];
  const rightForm = [[':const', rightRows]];
  const left = constRows(leftRows);
  const right = constRows(rightRows);
  const op = seed % 3;

  if (op === 0) {
    return {
      label: 'set-union',
      db: createDb(),
      form: [[':from', leftForm], [':union', rightForm], [':sort', ':id']],
      query: pipe(union(left, right), sort(asc(field<string>('row', 'id'))))
    };
  }

  if (op === 1) {
    return {
      label: 'set-intersection',
      db: createDb(),
      form: [[':from', leftForm], [':intersection', rightForm], [':sort', ':id']],
      query: pipe(intersection(left, right), sort(asc(field<string>('row', 'id'))))
    };
  }

  return {
    label: 'set-difference',
    db: createDb(),
    form: [[':from', leftForm], [':difference', rightForm], [':sort', ':id']],
    query: pipe(difference(left, right), sort(asc(field<string>('row', 'id'))))
  };
}

function indexCase(seed: number): RelicQueryCase {
  const variant = seed % 3;
  const indexed = variant === 0
    ? {
      label: 'hash',
      form: [':hash', ':accountId'],
      query: hash(entry.accountId)
    }
    : variant === 1
      ? {
        label: 'btree',
        form: [':btree', ':amount'],
        query: btree(entry.amount)
      }
      : {
        label: 'unique',
        form: [':unique', ':id'],
        query: uniqueIndex(entry.id)
      };

  return {
    label: `index-${indexed.label}`,
    form: [
      [':from', ':entries'],
      indexed.form,
      [':select', ':id', ':accountId', ':amount'],
      [':sort', ':id']
    ],
    query: pipe(
      from(entry),
      indexed.query,
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      sort(asc(field<string>('row', 'id')))
    )
  };
}

type OrderLine = {
  readonly sku: string;
  readonly qty: number;
};

type Order = {
  readonly id: string;
  readonly lines: readonly OrderLine[];
};

function generatedOrders(seed: number): readonly Order[] {
  return [
    {
      id: `o${seed}`,
      lines: [
        { sku: 'tea', qty: 1 + seed % 3 },
        { sku: 'milk', qty: 1 }
      ]
    },
    {
      id: `p${seed}`,
      lines: [{ sku: 'coffee', qty: 2 }]
    }
  ];
}

function generatedEntries(seed: number): readonly Entry[] {
  return [
    { id: `g${seed}-a`, accountId: 'cash', amount: seed % 10, memo: 'generated', posted: true },
    { id: `g${seed}-b`, accountId: 'fees', amount: -(seed % 7), posted: seed % 2 === 0 },
    { id: `g${seed}-c`, accountId: 'sales', amount: 20 - seed % 30, memo: null, posted: true }
  ];
}

function relicTxCase(seed: number): TxCase {
  const next = createSeededRandom(seed);
  const id = `seed-${seed}`;
  const amount = chooseSeeded(next, [1, 5, 13, 21] as const);
  const row = { id, accountId: 'cash', amount, posted: true };
  const relation = schema.entries;

  switch (seed % 8) {
    case 0:
      return {
        label: 'insert',
        form: [':insert', ':entries', row],
        patches: [insert(relation, row)]
      };
    case 1:
      return {
        label: 'insert-ignore',
        form: [':insert-ignore', ':entries', row],
        patches: [insertIgnore(relation, row)]
      };
    case 2:
      return {
        label: 'insert-or-replace',
        form: [':insert-or-replace', ':entries', row],
        patches: [insertOrReplace(relation, row)]
      };
    case 3:
      return {
        label: 'update',
        form: [':update', ':entries', { ':amount': amount }, ['=', ':id', 'e1']],
        patches: [update(relation, eq(field<string>('row', 'id'), value('e1')), { amount })]
      };
    case 4:
      return {
        label: 'delete',
        form: [':delete', ':entries', ['=', ':id', 'e2']],
        patches: [deleteRows(relation, eq(field<string>('row', 'id'), value('e2')))]
      };
    case 5:
      return {
        label: 'delete-exact',
        form: [':delete-exact', ':entries', { id: 'e4', accountId: 'cash', amount: 0, posted: false }],
        patches: [deleteExact(relation, { id: 'e4', accountId: 'cash', amount: 0, posted: false })]
      };
    case 6:
      return {
        label: 'replace-all',
        form: [':replace-all', ':entries', [row]],
        patches: [replaceAll(relation, [row])]
      };
    default:
      return seed % 16 === 7
        ? {
          label: 'insert-or-merge',
          form: [':insert-or-merge', ':entries', [':amount'], { ...row, id: 'e1' }],
          patches: [insertOrMerge(relation, { ...row, id: 'e1' }, { merge: ['amount'] })]
        }
        : {
          label: 'insert-or-update',
          form: [':insert-or-update', ':entries', { ':memo': 'updated' }, { ...row, id: 'e1' }],
          patches: [insertOrUpdate(relation, { ...row, id: 'e1' }, { update: { memo: 'updated' } })]
        };
  }
}
