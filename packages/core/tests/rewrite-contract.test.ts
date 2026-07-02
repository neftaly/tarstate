import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  attachConstraints,
  check,
  constrain,
  fk,
  req,
  tryTransactConstrained,
  unique
} from '@tarstate/core/constraints';
import {
  composeRelationRuntimes,
  type ComposedRelationRuntimeVersion,
  type RelationRuntime,
  type RelationRuntimeVersion
} from '@tarstate/core/adapter';
import {
  createDb,
  exists,
  qManyRows,
  qRows,
  row,
  transact,
  type DbOptions
} from '@tarstate/core/db';
import {
  collectDiagnostics,
  diagnostic,
  type TarstateCoreDiagnosticCode,
  type TarstateDiagnostic,
  type TarstateDiagnosticCode,
  type TarstateDiagnosticMode,
  type TarstateDiagnosticOptions,
  type TarstateDiagnosticSeverity
} from '@tarstate/core/diagnostics';
import { type EvaluateOptions, type QueryResult } from '@tarstate/core/evaluate';
import { mat } from '@tarstate/core/materialization';
import {
  aggregate,
  as,
  count,
  eq,
  field,
  from,
  gt,
  leftJoin,
  maybe,
  pipe,
  project,
  sum,
  value,
  where
} from '@tarstate/core/query';
import {
  defineSchema,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import {
  createStore,
  type StoreViewSnapshot
} from '@tarstate/core/store';
import { insert } from '@tarstate/core/write';

type Account = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
};

type Entry = {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly memo: string;
};

const schema = defineSchema({
  accounts: relation<Account>({
    key: 'id',
    fields: {
      id: stringField(),
      name: stringField(),
      kind: stringField()
    }
  }),
  entries: relation<Entry>({
    key: 'id',
    fields: {
      id: stringField(),
      accountId: stringField(),
      amount: numberField(),
      memo: stringField()
    }
  })
});

const openingDb = createDb({
  accounts: [
    { id: 'cash', name: 'Cash', kind: 'asset' },
    { id: 'sales', name: 'Sales', kind: 'income' }
  ],
  entries: [
    { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid' },
    { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid' }
  ]
});

describe('rewrite public contracts', () => {
  it('names core diagnostic codes while preserving app-extension codes and severity', () => {
    const known = diagnostic({
      code: 'not_implemented',
      severity: 'warning',
      message: 'stubbed'
    });
    const extended = diagnostic({
      code: 'app/custom-rule',
      severity: 'error',
      message: 'custom app diagnostic'
    });
    const normalized = collectDiagnostics('plain message');

    expectTypeOf<TarstateCoreDiagnosticCode>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<'foreign_key'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'app/custom-rule'>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<TarstateDiagnosticSeverity>().toEqualTypeOf<'info' | 'warning' | 'error'>();
    expectTypeOf<TarstateDiagnosticMode>().toEqualTypeOf<'collect' | 'throw' | 'warn'>();
    expectTypeOf<TarstateDiagnosticOptions>().toMatchTypeOf<{ readonly diagnosticMode?: TarstateDiagnosticMode }>();
    expectTypeOf<EvaluateOptions>().toMatchTypeOf<TarstateDiagnosticOptions>();
    expectTypeOf<DbOptions>().toMatchTypeOf<TarstateDiagnosticOptions>();
    expectTypeOf<typeof known>().toEqualTypeOf<TarstateDiagnostic>();
    expect(known).toEqual({ code: 'not_implemented', severity: 'warning', message: 'stubbed' });
    expect(extended.code).toBe('app/custom-rule');
    expect(normalized[0]).toMatchObject({ code: 'diagnostic', severity: 'info', message: 'plain message' });
  });

  it('evaluates Relic-style query data synchronously over a Db snapshot', () => {
    const cashEntries = pipe(
      from(as(schema.entries, 'entry')),
      where(eq(field('entry', 'accountId'), value('cash'))),
      project({
        id: field<string>('entry', 'id'),
        amount: field<number>('entry', 'amount')
      })
    );

    const rows = qRows(openingDb, cashEntries);

    expectTypeOf(rows).toEqualTypeOf<readonly { readonly id: string; readonly amount: number }[]>();
    expect(rows).toEqual([{ id: 'e1', amount: 120 }]);
  });

  it('supports sync batch reads, row lookup, and aggregate projections from one snapshot', () => {
    const positiveEntries = pipe(
      from(as(schema.entries, 'entry')),
      where(gt(field('entry', 'amount'), value(0))),
      project({ id: field<string>('entry', 'id') })
    );
    const summary = pipe(
      from(as(schema.entries, 'entry')),
      project({ entryCount: count() })
    );

    expect(qManyRows(openingDb, { positiveEntries, summary })).toEqual({
      positiveEntries: [{ id: 'e1' }],
      summary: [{ entryCount: 2 }]
    });
    const entry = row(openingDb, schema.entries, 'e1');
    expectTypeOf(entry).toEqualTypeOf<Entry | undefined>();
    expect(entry).toEqual({ id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid' });
  });

  it('keeps relation key lookup typed from relation metadata', () => {
    type KeyedEntry = {
      readonly id: string;
      readonly amount: number;
    };
    type TenantEntry = {
      readonly tenantId: string;
      readonly id: string;
      readonly amount: number;
    };
    const keyedSchema = defineSchema({
      byId: relation<KeyedEntry, 'id'>({
        key: 'id',
        fields: {
          id: stringField(),
          amount: numberField()
        }
      }),
      byTenantAndId: relation<TenantEntry, readonly ['tenantId', 'id']>({
        key: ['tenantId', 'id'] as const,
        fields: {
          tenantId: stringField(),
          id: stringField(),
          amount: numberField()
        }
      })
    });

    const readById = () => row(openingDb, keyedSchema.byId, 'entry-a');
    const readByTenantAndId = () => row(openingDb, keyedSchema.byTenantAndId, ['acme', 'entry-a'] as const);
    const hasById = () => exists(openingDb, keyedSchema.byId, 'entry-a');

    expectTypeOf<ReturnType<typeof readById>>().toEqualTypeOf<{ readonly id: string; readonly amount: number } | undefined>();
    expectTypeOf<ReturnType<typeof readByTenantAndId>>().toEqualTypeOf<{
      readonly tenantId: string;
      readonly id: string;
      readonly amount: number;
    } | undefined>();
    expectTypeOf<ReturnType<typeof hasById>>().toEqualTypeOf<boolean>();

    const invalidReadById = () =>
      // @ts-expect-error row keys must match the relation key field type.
      row(openingDb, keyedSchema.byId, 1);
    const invalidHasById = () =>
      // @ts-expect-error exists keys must match the relation key field type.
      exists(openingDb, keyedSchema.byId, 1);
    const invalidCompositeRead = () =>
      // @ts-expect-error composite row keys use the relation key tuple shape.
      row(openingDb, keyedSchema.byTenantAndId, 'entry-a');
    const invalidCompositeExists = () =>
      // @ts-expect-error composite key component types follow row fields.
      exists(openingDb, keyedSchema.byTenantAndId, ['acme', 1] as const);
    void invalidReadById;
    void invalidHasById;
    void invalidCompositeRead;
    void invalidCompositeExists;
  });

  it('preserves composed relation runtime version types', () => {
    const numberRuntime = {
      source: {
        relationNames: ['numbers'],
        version: () => 1,
        rows: () => []
      }
    } satisfies RelationRuntime<number>;
    const labelRuntime = {
      source: {
        relationNames: ['labels'],
        version: () => 'ready',
        rows: () => []
      }
    } satisfies RelationRuntime<'ready'>;
    const runtime = composeRelationRuntimes(numberRuntime, labelRuntime);

    expectTypeOf<RelationRuntimeVersion<typeof numberRuntime>>().toEqualTypeOf<number>();
    expectTypeOf<ComposedRelationRuntimeVersion<[typeof numberRuntime, typeof labelRuntime]>>()
      .toEqualTypeOf<readonly [number, 'ready']>();
    expectTypeOf(runtime).toMatchTypeOf<RelationRuntime<readonly [number, 'ready']>>();
    expectTypeOf<NonNullable<typeof runtime.source.version>>()
      .returns.toEqualTypeOf<readonly [number, 'ready'] | undefined>();
    expect(runtime.source.rows(schema.entries)).toEqual([]);
  });

  it('keeps derived query field access typed without casts', () => {
    const entry = as(schema.entries, 'entry');
    const account = as(schema.accounts, 'account');
    const summaryRows = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          entryCount: count(),
          total: sum(entry.amount)
        }
      }),
      project({
        accountId: field<string>('row', 'accountId'),
        entryCount: field<number>('row', 'entryCount'),
        total: field<number>('row', 'total')
      })
    );
    const summary = as(summaryRows, 'summary');
    const accountSummaryRows = pipe(
      from(account),
      leftJoin(summaryRows, eq(account.id, summary.accountId)),
      project({
        id: account.id,
        name: field<string>('account', 'name'),
        entryCount: maybe(summary.entryCount),
        total: maybe(summary.total)
      })
    );

    const readAccountSummaryRows = () => qRows(openingDb, accountSummaryRows);
    expectTypeOf<ReturnType<typeof readAccountSummaryRows>>().toEqualTypeOf<readonly {
      readonly id: string;
      readonly name: string;
      readonly entryCount: number | undefined;
      readonly total: number | undefined;
    }[]>();
    expect(() => qRows(openingDb, accountSummaryRows)).toThrow('q is not implemented in rewrite stub');
  });

  it('preserves row types for zero-cast batch query rows', () => {
    const entry = as(schema.entries, 'entry');
    const positiveEntries = pipe(
      from(entry),
      where(gt(entry.amount, value(0))),
      project({ id: entry.id, amount: entry.amount })
    );
    const summary = pipe(
      from(entry),
      project({ entryCount: count() })
    );
    const readBatchRows = () => qManyRows(openingDb, { positiveEntries, summary });
    expectTypeOf<ReturnType<typeof readBatchRows>>().toEqualTypeOf<{
      readonly positiveEntries: readonly { readonly id: string; readonly amount: number }[];
      readonly summary: readonly { readonly entryCount: number }[];
    }>();
    expect(() => qManyRows(openingDb, { positiveEntries, summary })).toThrow('qMany is not implemented in rewrite stub');
  });

  it('keeps writes functional and returns a new Db value', () => {
    const next = transact(
      openingDb,
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expect(qRows(openingDb, from(schema.entries))).toHaveLength(2);
    expect(qRows(next, from(schema.entries))).toHaveLength(3);
  });

  it('enforces required, unique, foreign-key, and check constraints as query data', () => {
    const constrained = attachConstraints(openingDb, constrain(
      req(schema.entries, 'id', 'accountId', 'amount'),
      unique(schema.entries, 'id'),
      fk(schema.entries, 'accountId', schema.accounts, 'id'),
      check(from(as(schema.entries, 'entry')), gt(field('entry', 'amount'), value(-1_000_000)))
    ));

    const result = tryTransactConstrained(
      constrained,
      insert(schema.entries, { id: 'bad', accountId: 'missing', amount: 10, memo: 'bad account' })
    );

    expect(result.committed).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'foreign_key' })
    ]));
  });

  it('gives React-facing stores stable synchronous view snapshots by revision', () => {
    const store = createStore(openingDb);
    const view = store.view(from(schema.entries));
    const first = view.getSnapshot();
    const second = view.getSnapshot();

    expectTypeOf(first).toMatchTypeOf<StoreViewSnapshot<Entry>>();
    expect(first.rows).toBe(second.rows);
    expect(first.revision).toBe(0);
    expect(first.rows).toHaveLength(2);
  });

  it('materializes query results without changing the query-facing API', () => {
    const entries = from(schema.entries);
    const materialized = mat(openingDb, entries);

    expect(qRows(materialized, entries)).toHaveLength(2);
    expect(qRows(materialized, entries)).toBe(qRows(materialized, entries));
  });

  it('keeps projection result types on QueryResult and qRows', () => {
    const query = pipe(
      from(as(schema.accounts, 'account')),
      project({ name: field<string>('account', 'name') })
    );
    const result: QueryResult<{ readonly name: string }> = { rows: qRows(openingDb, query), diagnostics: [] };

    expect(result.rows).toEqual([{ name: 'Cash' }, { name: 'Sales' }]);
  });
});
