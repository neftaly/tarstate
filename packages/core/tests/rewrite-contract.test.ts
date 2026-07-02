import { describe, expect, expectTypeOf, it } from 'vitest';
import * as constraintsApi from '@tarstate/core/constraints';
import {
  attachConstraints,
  check,
  constrain,
  fk,
  req,
  unique
} from '@tarstate/core/constraints';
import * as dbApi from '@tarstate/core/db';
import {
  createDb,
  exists,
  q,
  qMany,
  qManyResult,
  qResult,
  row,
  transact,
  tryTransact,
  type DbOptions,
  type DbTransactionResult,
  type QueryBatchResult,
  type QueryBatchRows
} from '@tarstate/core/db';
import {
  diagnostic,
  type TarstateCoreDiagnosticCode,
  type TarstateDiagnostic,
  type TarstateDiagnosticCode,
  type TarstateDiagnosticMode,
  type TarstateDiagnosticOptions,
  type TarstateDiagnosticSeverity
} from '@tarstate/core/diagnostics';
import { type EvaluateOptions, type QueryResult } from '@tarstate/core/evaluate';
import * as queryApi from '@tarstate/core/query';
import {
  aggregate,
  as,
  count,
  eq,
  field,
  from,
  gt,
  isMissing,
  isNull,
  join,
  leftJoin,
  maybe,
  notMissing,
  notNull,
  pipe,
  project,
  sel,
  sel1,
  self,
  sum,
  value,
  where,
  type CorrelationClauseMap,
  type EquiJoinClauseMap,
  type ExprData,
  type PredicateData,
  type Query
} from '@tarstate/core/query';
import {
  defineSchema,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import {
  createStore,
  type StoreCommitResult,
  type StoreViewSnapshot
} from '@tarstate/core/store';
import {
  insert,
  seed,
  type SchemaSeedInput,
  type SchemaSeedPatches
} from '@tarstate/core/write';

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

type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;
type HasKind<Input> = Input extends { readonly kind: unknown } ? true : false;

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

describe('rewrite public API contracts', () => {
  it('keeps TarstateDiagnostic as the canonical diagnostic type', () => {
    const known = diagnostic({
      code: 'not_implemented',
      severity: 'warning',
      message: 'stubbed'
    });
    const dbWithEnv = createDb({}, { env: { tenant: 'acme' } });

    expectTypeOf<TarstateCoreDiagnosticCode>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<'foreign_key'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'app/custom-rule'>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<TarstateDiagnosticSeverity>().toEqualTypeOf<'info' | 'warning' | 'error'>();
    expectTypeOf<TarstateDiagnosticMode>().toEqualTypeOf<'collect' | 'throw' | 'warn'>();
    expectTypeOf<TarstateDiagnosticOptions>().toMatchTypeOf<{ readonly diagnosticMode?: TarstateDiagnosticMode }>();
    expectTypeOf<EvaluateOptions>().toMatchTypeOf<TarstateDiagnosticOptions>();
    expectTypeOf<DbOptions>().toMatchTypeOf<TarstateDiagnosticOptions>();
    expectTypeOf<typeof known>().toEqualTypeOf<TarstateDiagnostic>();
    expect(dbWithEnv.env).toEqual({ tenant: 'acme' });

    // @ts-expect-error createDb env must be passed through DbOptions.env.
    createDb({}, { tenant: 'acme' });
  });

  it('makes q and qMany row-first with explicit result envelopes', () => {
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
    const batch = { positiveEntries, summary };

    const readRows = () => q(openingDb, positiveEntries);
    const readRelationRows = () => q(openingDb, schema.entries);
    const readResult = () => qResult(openingDb, positiveEntries);
    const readBatchRows = () => qMany(openingDb, batch);
    const readBatchResult = () => qManyResult(openingDb, batch);

    expectTypeOf<ReturnType<typeof readRows>>().toEqualTypeOf<readonly {
      readonly id: string;
      readonly amount: number;
    }[]>();
    expectTypeOf<ReturnType<typeof readRelationRows>>().toEqualTypeOf<readonly Entry[]>();
    expectTypeOf<ReturnType<typeof readResult>>().toEqualTypeOf<QueryResult<{
      readonly id: string;
      readonly amount: number;
    }>>();
    expectTypeOf<ReturnType<typeof readBatchRows>>().toEqualTypeOf<QueryBatchRows<typeof batch>>();
    expectTypeOf<ReturnType<typeof readBatchResult>>().toEqualTypeOf<QueryBatchResult<typeof batch>>();
  });

  it('removes duplicated row-only read helpers and the constrained transaction fork from public exports', () => {
    expect('qRows' in dbApi).toBe(false);
    expect('qManyRows' in dbApi).toBe(false);
    expect('tryTransactConstrained' in constraintsApi).toBe(false);
    expect('transactConstrained' in constraintsApi).toBe(false);
    expect('any' in queryApi).toBe(false);
    expect('notAny' in queryApi).toBe(false);

    // @ts-expect-error qRows is intentionally not exported.
    expect(dbApi.qRows).toBeUndefined();
    // @ts-expect-error qManyRows is intentionally not exported.
    expect(dbApi.qManyRows).toBeUndefined();
    // @ts-expect-error constrained transaction forks are intentionally not exported.
    expect(constraintsApi.tryTransactConstrained).toBeUndefined();
    // @ts-expect-error constrained transaction forks are intentionally not exported.
    expect(constraintsApi.transactConstrained).toBeUndefined();
    // @ts-expect-error any is intentionally not exported; use or/not instead.
    expect(queryApi.any).toBeUndefined();
    // @ts-expect-error notAny is intentionally not exported; use or/not instead.
    expect(queryApi.notAny).toBeUndefined();
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

    expectTypeOf<ReturnType<typeof readById>>().toEqualTypeOf<KeyedEntry | undefined>();
    expectTypeOf<ReturnType<typeof readByTenantAndId>>().toEqualTypeOf<TenantEntry | undefined>();
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

  it('treats attached constraints as normal Db transaction metadata', () => {
    const constrained = attachConstraints(openingDb, constrain(
      req(schema.entries, 'id', 'accountId', 'amount'),
      unique(schema.entries, 'id'),
      fk(schema.entries, 'accountId', schema.accounts, 'id'),
      check(from(as(schema.entries, 'entry')), gt(field('entry', 'amount'), value(-1_000_000)))
    ));

    const tryCommit = () => tryTransact(
      constrained,
      insert(schema.entries, { id: 'bad', accountId: 'missing', amount: 10, memo: 'bad account' })
    );
    const commit = () => transact(
      constrained,
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expectTypeOf<ReturnType<typeof tryCommit>>().toEqualTypeOf<DbTransactionResult<typeof constrained>>();
    expectTypeOf<ReturnType<typeof commit>>().toEqualTypeOf<typeof constrained>();
  });

  it('adds Relic-shaped helper signatures without evaluator behavior', () => {
    const account = as(schema.accounts, 'account');
    const entry = as(schema.entries, 'entry');
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
    const byPredicate = pipe(from(entry), join(from(account), eq(entry.accountId, account.id)));
    const byClause = pipe(
      from(entry),
      join(from(account), { accountId: 'id' } satisfies EquiJoinClauseMap<Entry, Account>)
    );
    const leftByClause = pipe(
      from(account),
      leftJoin(summaryRows, { id: 'accountId' } satisfies EquiJoinClauseMap<Account, QueryRow<typeof summaryRows>>),
      project({
        id: account.id,
        name: account.$.name,
        entryCount: maybe(summary.entryCount),
        total: maybe(summary.total)
      })
    );
    const correlatedRows = sel(from(account), { accountId: 'id' } satisfies CorrelationClauseMap<Entry, Account>);
    const correlatedRow = sel1(from(account), { accountId: 'id' } satisfies CorrelationClauseMap<Entry, Account>);
    const wholeRow = self<Entry>();
    const predicates = [
      isNull(account.id),
      notNull(account.$.name),
      isMissing(field('entry', 'optional')),
      notMissing(entry.id)
    ];

    expectTypeOf<QueryRow<typeof byPredicate>>().toMatchTypeOf<Entry & Account>();
    expectTypeOf<QueryRow<typeof byClause>>().toMatchTypeOf<Entry & Account>();
    expectTypeOf<QueryRow<typeof leftByClause>>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
      readonly entryCount: number | undefined;
      readonly total: number | undefined;
    }>();
    expectTypeOf<typeof correlatedRows>().toEqualTypeOf<ExprData<readonly Account[]>>();
    expectTypeOf<typeof correlatedRow>().toEqualTypeOf<ExprData<Account | undefined>>();
    expectTypeOf<typeof wholeRow>().toEqualTypeOf<ExprData<Entry>>();
    expectTypeOf<(typeof predicates)[number]>().toEqualTypeOf<PredicateData>();
  });

  it('adds a schema-keyed seed helper for terse transaction rows', () => {
    const rows = {
      accounts: [{ id: 'cash', name: 'Cash', kind: 'asset' }],
      entries: [{ id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid' }]
    } satisfies SchemaSeedInput<typeof schema>;
    const patches = () => seed(schema, rows);
    const commit = () => transact(openingDb, patches());

    expectTypeOf<ReturnType<typeof patches>>().toEqualTypeOf<SchemaSeedPatches<typeof schema>>();
    expectTypeOf<ReturnType<typeof commit>>().toEqualTypeOf<typeof openingDb>();

    // @ts-expect-error schema-keyed seed rows must match their relation row type.
    const invalidRows: SchemaSeedInput<typeof schema> = { entries: [{ id: 'e1' }] };
    void invalidRows;
  });

  it('trims StoreView and StoreViewSnapshot to the sync external store shape', () => {
    const view = createStore(openingDb).view(from(schema.entries));
    const snapshot = view.getSnapshot();
    const commitResult = () => createStore(openingDb).commit(
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expectTypeOf<typeof snapshot>().toEqualTypeOf<StoreViewSnapshot<Entry>>();
    expectTypeOf<StoreViewSnapshot<Entry>>().toEqualTypeOf<{
      readonly rows: readonly Entry[];
      readonly diagnostics: readonly TarstateDiagnostic[];
      readonly revision: number;
      readonly queryKey: string;
      readonly version?: unknown;
    }>();
    expectTypeOf<Awaited<ReturnType<typeof commitResult>>>().toEqualTypeOf<StoreCommitResult>();
    expectTypeOf<HasKind<StoreCommitResult>>().toEqualTypeOf<false>();

    // @ts-expect-error StoreView.read is intentionally not public.
    expect(view.read).toBeUndefined();
    // @ts-expect-error StoreView.rows is intentionally not public.
    expect(view.rows).toBeUndefined();
    // @ts-expect-error StoreView.kind is intentionally not public.
    expect(view.kind).toBeUndefined();
    // @ts-expect-error StoreViewSnapshot.db is intentionally not public.
    expect(snapshot.db).toBeUndefined();
    // @ts-expect-error StoreViewSnapshot.source is intentionally not public.
    expect(snapshot.source).toBeUndefined();
    // @ts-expect-error StoreViewSnapshot.snapshot is intentionally not public.
    expect(snapshot.snapshot).toBeUndefined();
  });
});
