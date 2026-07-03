import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  index as rootMaterializedIndex,
  runtimeSystemRelations,
  runtimeSystemSource,
  type RuntimeObjectLocationRow,
  type RuntimeSystemState,
  type MaterializedIndex as RootMaterializedIndex,
  type StoreCommitEffects as RootStoreCommitEffects,
  type StoreCommitSnapshot as RootStoreCommitSnapshot,
  type StoreSnapshot as RootStoreSnapshot
} from '@tarstate/core';
import * as adapterApi from '@tarstate/core/adapter';
import * as constraintsApi from '@tarstate/core/constraints';
import {
  check,
  constrain,
  fk,
  req,
  unique,
  type ConstraintData,
  type ConstraintOptions,
  type ConstraintSet
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
import { validateRelationRow, type EvaluateOptions, type QueryResult } from '@tarstate/core/evaluate';
import {
  demat,
  index as materializedIndex,
  mat,
  type MaterializedHashIndex,
  type MaterializedIndex,
  type MaterializationInput,
  type MaterializationTarget,
  type MaterializationTargetValue,
  type MaterializedTarget,
  type MaterializedDb
} from '@tarstate/core/materialization';
import {
  aggregate,
  any as anyAggregate,
  as,
  clauses,
  correlate,
  count,
  eq,
  field,
  from,
  gt,
  hash,
  isMissing,
  isNull,
  join,
  leftJoin,
  maybe,
  notMissing,
  notAny,
  notNull,
  pipe,
  project,
  sel,
  sel1,
  self,
  sum,
  value,
  where,
  type ExprData,
  type PredicateData,
  type Query
} from '@tarstate/core/query';
import type {
  TrackRuntimeCommitResult,
  TrackRuntimeCommitSupportedResult,
  TrackRuntimeCommitUnsupportedResult,
  TrackTransactResult
} from '@tarstate/core/runtime';
import {
  customField,
  defineSchema,
  numberField,
  opaqueField,
  relation,
  stringField,
  type CustomFieldSpec
} from '@tarstate/core/schema';
import {
  createStore,
  type StoreCommitResult,
  type StoreCommitEffects,
  type StoreCommitSnapshot,
  type StoreSnapshot,
  type StoreViewSnapshot
} from '@tarstate/core/store';
import {
  deleteExact,
  insert,
  seed,
  type SchemaSeedInput,
  type SchemaSeedPatches
} from '@tarstate/core/write';
import {
  diffQuery,
  subscribeWatch,
  unwatch,
  watch,
  watchTarget,
  type QueryDiff,
  type TrackedChange,
  type UnwatchResult,
  type WatchEvent,
  type WatchHandle,
  type WatchRefreshResult,
  type WatchSubscription,
  type WatchTargetChange,
  type WatchTargetRegistration,
  type WatchUnsubscribeResult
} from '@tarstate/core/watch';

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

describe('public API contracts', () => {
  it('keeps TarstateDiagnostic as the canonical diagnostic type', () => {
    const known = diagnostic({
      code: 'not_implemented',
      severity: 'warning',
      message: 'stubbed'
    });
    const dbWithEnv = createDb({}, { env: { tenant: 'acme' } });

    expectTypeOf<TarstateCoreDiagnosticCode>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<'foreign_key'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'write_patch_invalid'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'transaction_failed'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
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

  it('exposes runtime system state as queryable relation rows', () => {
    const objectLocation = {
      id: 'runtime:object:1@actor',
      runtime: 'runtime',
      objectId: '1@actor',
      path: 'entries.[0]',
      pathSegments: ['entries', 0],
      relation: 'entries',
      key: 'entry-1'
    } satisfies RuntimeObjectLocationRow;
    const state = {
      sources: [{
        id: 'runtime:source:storage',
        runtime: 'runtime',
        source: 'storage',
        state: 'loading'
      }],
      diagnostics: [diagnostic({
        code: 'not_implemented',
        severity: 'warning',
        message: 'source is still loading',
        surface: 'runtime'
      })],
      interests: [{
        id: 'view:entries',
        runtime: 'runtime',
        queryKey: 'query:entries',
        state: 'active',
        relationNames: ['entries'],
        subscriberCount: 1
      }],
      objectLocations: [objectLocation]
    } satisfies RuntimeSystemState;
    const source = runtimeSystemSource(state);

    expect(runtimeSystemRelations.sources.name).toBe('tarstate.runtime.sources');
    expect(runtimeSystemRelations.diagnostics.ephemeral).toBe(true);
    expect(adapterApi.runtimeSystemRelations.objectLocations.name).toBe('tarstate.runtime.objectLocations');
    expect(runtimeSystemRelations.objectLocations.key).toBe('id');
    expectTypeOf<typeof objectLocation>().toMatchTypeOf<RuntimeObjectLocationRow>();
    expect(source.relationNames).toEqual([
      'tarstate.runtime.sources',
      'tarstate.runtime.diagnostics',
      'tarstate.runtime.peers',
      'tarstate.runtime.sync',
      'tarstate.runtime.conflicts',
      'tarstate.runtime.objectLocations',
      'tarstate.runtime.storage',
      'tarstate.runtime.interests'
    ]);
    expect(source.rows(runtimeSystemRelations.sources)).toEqual(state.sources);
    expect(source.rows(runtimeSystemRelations.interests)).toEqual(state.interests);
    expect(source.rows(runtimeSystemRelations.objectLocations)).toEqual(state.objectLocations);
    expect(source.rows(runtimeSystemRelations.diagnostics)).toEqual([
      expect.objectContaining({
        runtime: 'runtime',
        code: 'not_implemented',
        severity: 'warning',
        message: 'source is still loading'
      })
    ]);
    expect(source.diagnostics?.()).toEqual([
      expect.objectContaining({
        code: 'not_implemented',
        severity: 'warning',
        message: 'source is still loading'
      })
    ]);
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
    expect('attachConstraints' in constraintsApi).toBe(false);
    expect('detachConstraints' in constraintsApi).toBe(false);
    expect('attachedConstraintsFor' in constraintsApi).toBe(false);
    expect('hasAttachedConstraints' in constraintsApi).toBe(false);
    expect('tryTransactConstrained' in constraintsApi).toBe(false);
    expect('transactConstrained' in constraintsApi).toBe(false);

    // @ts-expect-error qRows is intentionally not exported.
    expect(dbApi.qRows).toBeUndefined();
    // @ts-expect-error qManyRows is intentionally not exported.
    expect(dbApi.qManyRows).toBeUndefined();
    // @ts-expect-error constraints install through mat, not a separate attachment API.
    expect(constraintsApi.attachConstraints).toBeUndefined();
    // @ts-expect-error constraints remove through demat, not a separate attachment API.
    expect(constraintsApi.detachConstraints).toBeUndefined();
    // @ts-expect-error attached constraint inspection is intentionally not public.
    expect(constraintsApi.attachedConstraintsFor).toBeUndefined();
    // @ts-expect-error attached constraint inspection is intentionally not public.
    expect(constraintsApi.hasAttachedConstraints).toBeUndefined();
    // @ts-expect-error constrained transaction forks are intentionally not exported.
    expect(constraintsApi.tryTransactConstrained).toBeUndefined();
    // @ts-expect-error constrained transaction forks are intentionally not exported.
    expect(constraintsApi.transactConstrained).toBeUndefined();
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

  it('supports custom and opaque field specs without making them stringly', () => {
    type RichText = {
      readonly text: string;
      readonly objectId: string;
    };
    const richTextSpec = {
      kind: 'automergeText',
      description: 'an Automerge text value',
      validate: (value: unknown): value is RichText =>
        typeof value === 'object'
        && value !== null
        && 'text' in value
        && typeof value.text === 'string',
      toScalar: (value: unknown) => typeof value === 'object' && value !== null && 'text' in value
        ? String(value.text)
        : null
    } satisfies CustomFieldSpec<RichText>;
    const customSchema = defineSchema({
      notes: relation<{ readonly id: string; readonly body: RichText; readonly raw: unknown }>({
        key: 'id',
        fields: {
          id: stringField(),
          body: customField(richTextSpec),
          raw: opaqueField('hostObject')
        }
      })
    });

    expect(validateRelationRow(customSchema.notes, {
      id: 'note-1',
      body: { text: 'hello', objectId: '1@actor' },
      raw: { host: true }
    })).toEqual([]);
    expect(validateRelationRow(customSchema.notes, {
      id: 'note-1',
      body: 'plain string',
      raw: { host: true }
    } as never)).toEqual([
      expect.objectContaining({
        code: 'field_invalid',
        field: 'body'
      })
    ]);

    const db = createDb({
      notes: [
        { id: 'note-1', body: { text: 'hello', objectId: '1@actor' }, raw: { host: true } },
        { id: 'note-2', body: { text: 'bye', objectId: '2@actor' }, raw: { host: true } }
      ]
    });
    const rows = q(
      db,
      pipe(
        from(customSchema.notes),
        where(eq(field<string>('notes', 'body'), value('hello'))),
        project({ id: field<string>('notes', 'id'), body: field<string>('notes', 'body') })
      )
    );

    expect(rows).toEqual([{ id: 'note-1', body: 'hello' }]);

    const unsafeKeySchema = defineSchema({
      notes: relation<{ readonly id: RichText }>({
        key: 'id',
        fields: {
          id: opaqueField<RichText>('automergeText')
        }
      })
    });
    const safeKeySchema = defineSchema({
      notes: relation<{ readonly id: RichText }>({
        key: 'id',
        fields: {
          id: customField<RichText>({
            kind: 'automergeText',
            stableKey: (value) => typeof value === 'object' && value !== null && 'objectId' in value
              ? String(value.objectId)
              : ''
          })
        }
      })
    });

    expect(validateRelationRow(unsafeKeySchema.notes, {
      id: { text: 'hello', objectId: '1@actor' }
    })).toEqual([
      expect.objectContaining({
        code: 'field_invalid',
        field: 'id'
      })
    ]);
    expect(validateRelationRow(safeKeySchema.notes, {
      id: { text: 'hello', objectId: '1@actor' }
    })).toEqual([]);
  });

  it('installs and removes constraints through materialization inputs', () => {
    const required = req(schema.entries, 'id', 'accountId', 'amount');
    const namedRequired = req(schema.entries, ['id', 'accountId'], { name: 'entries.required' });
    const namedUnique = unique(schema.entries, ['id'], { name: 'entries.id' });
    const namedForeignKey = fk(schema.entries, 'accountId', schema.accounts, 'id', { name: 'entries.account', cascade: 'delete' });
    const namedCheck = check(from(as(schema.entries, 'entry')), gt(field('entry', 'amount'), value(-1_000_000)), { name: 'entries.amount_floor' });
    const constraints = constrain(
      required,
      namedUnique,
      namedForeignKey,
      namedCheck
    );
    const constrained = mat(openingDb, constraints, required);
    const dematerialized = demat(constrained, constraints, required);

    const tryCommit = () => tryTransact(
      constrained,
      insert(schema.entries, { id: 'bad', accountId: 'missing', amount: 10, memo: 'bad account' })
    );
    const commit = () => transact(
      constrained,
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expectTypeOf<typeof constraints>().toEqualTypeOf<ConstraintSet>();
    expectTypeOf<(typeof constraints)[number]>().toEqualTypeOf<ConstraintData>();
    expectTypeOf<typeof namedRequired>().toMatchTypeOf<ConstraintData & ConstraintOptions>();
    expectTypeOf<typeof constraints>().toMatchTypeOf<MaterializationInput>();
    expectTypeOf<(typeof constraints)[number]>().toMatchTypeOf<MaterializationInput>();
    expectTypeOf<typeof constrained>().toMatchTypeOf<MaterializedDb>();
    expectTypeOf<typeof dematerialized>().toEqualTypeOf<typeof constrained>();
    expectTypeOf<ReturnType<typeof tryCommit>>().toEqualTypeOf<DbTransactionResult<typeof constrained>>();
    expectTypeOf<ReturnType<typeof commit>>().toEqualTypeOf<typeof constrained>();

    const invalidMaterializationInput = () =>
      // @ts-expect-error mat inputs are query/constraint/metadata values, not loose options objects.
      mat(openingDb, { id: 'entries' });
    void invalidMaterializationInput;
    expect(namedRequired.name).toBe('entries.required');
    expect(namedUnique.name).toBe('entries.id');
    expect(namedForeignKey).toEqual(expect.objectContaining({ name: 'entries.account', cascade: 'delete' }));
    expect(namedCheck.name).toBe('entries.amount_floor');
  });

  it('exports store snapshot types from root and the store subpath', () => {
    expectTypeOf<RootStoreSnapshot>().toEqualTypeOf<StoreSnapshot>();
    expectTypeOf<RootStoreCommitEffects>().toEqualTypeOf<StoreCommitEffects>();
    expectTypeOf<RootStoreCommitSnapshot>().toEqualTypeOf<StoreCommitSnapshot>();
  });

  it('exports materialized index helper types from root and materialization subpath', () => {
    const entry = as(schema.entries, 'entry');
    const indexedEntries = pipe(
      from(entry),
      project({
        id: entry.id,
        accountId: entry.accountId,
        amount: entry.amount
      }),
      hash(field<string>('row', 'accountId'))
    );
    const db = mat(openingDb, indexedEntries);
    const readIndex = () => materializedIndex(db, indexedEntries);
    const readRootIndex = () => rootMaterializedIndex(db, indexedEntries);
    type IndexedEntry = QueryRow<typeof indexedEntries>;

    expectTypeOf<ReturnType<typeof readIndex>>().toEqualTypeOf<MaterializedIndex<IndexedEntry> | undefined>();
    expectTypeOf<ReturnType<typeof readRootIndex>>().toEqualTypeOf<RootMaterializedIndex<IndexedEntry> | undefined>();
    expectTypeOf<RootMaterializedIndex<IndexedEntry>>().toEqualTypeOf<MaterializedIndex<IndexedEntry>>();
    expectTypeOf<MaterializationTargetValue<IndexedEntry>>().toEqualTypeOf<MaterializationTarget<IndexedEntry>>();
    expectTypeOf<MaterializedTarget<IndexedEntry>>().toEqualTypeOf<MaterializationTargetValue<IndexedEntry>>();

    const raw = readIndex();
    expect(raw?.op).toBe('hash');
    if (raw?.op !== 'hash') throw new Error('expected hash index');
    expectTypeOf<typeof raw>().toMatchTypeOf<MaterializedHashIndex<IndexedEntry>>();
    expect(raw.lookup('cash').map((row) => row.id)).toEqual(['e1']);
    expect(readRootIndex()?.op).toBe('hash');
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
          positiveCount: count(gt(entry.amount, value(0))),
          hasIncome: anyAggregate(gt(entry.amount, value(0))),
          hasNoMissingMemo: notAny(isMissing(entry.memo)),
          total: sum(entry.amount)
        }
      }),
      project({
        accountId: field<string>('row', 'accountId'),
        entryCount: field<number>('row', 'entryCount'),
        positiveCount: field<number>('row', 'positiveCount'),
        hasIncome: field<boolean>('row', 'hasIncome'),
        hasNoMissingMemo: field<boolean>('row', 'hasNoMissingMemo'),
        total: field<number>('row', 'total')
      })
    );
    const summary = as(summaryRows, 'summary');
    const byPredicate = pipe(from(entry), join(from(account), eq(entry.accountId, account.id)));
    const byClause = pipe(
      from(entry),
      join(from(account), clauses<Entry, Account>({ accountId: 'id' }))
    );
    const leftByClause = pipe(
      from(account),
      leftJoin(summaryRows, clauses<Account, QueryRow<typeof summaryRows>>({ id: 'accountId' })),
      project({
        id: account.id,
        name: account.$.name,
        entryCount: maybe(summary.entryCount),
        total: maybe(summary.total)
      })
    );
    const correlatedRows = sel(from(account), correlate<Entry, Account>({ accountId: 'id' }));
    const correlatedRow = sel1(from(account), correlate<Entry, Account>({ accountId: 'id' }));
    const wholeRow = self<Entry>();
    const hasPositiveAmount = anyAggregate(gt(entry.amount, value(0)));
    const hasNoPositiveAmount = notAny(gt(entry.amount, value(0)));
    const positiveCount = count(gt(entry.amount, value(0)));
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
    expectTypeOf<typeof hasPositiveAmount>().toMatchTypeOf<ExprData<boolean>>();
    expectTypeOf<typeof hasNoPositiveAmount>().toMatchTypeOf<ExprData<boolean>>();
    expectTypeOf<typeof positiveCount>().toMatchTypeOf<ExprData<number>>();
    expectTypeOf<typeof correlatedRows>().toEqualTypeOf<ExprData<readonly Account[]>>();
    expectTypeOf<typeof correlatedRow>().toEqualTypeOf<ExprData<Account | undefined>>();
    expectTypeOf<typeof wholeRow>().toEqualTypeOf<ExprData<Entry>>();
    expectTypeOf<(typeof predicates)[number]>().toEqualTypeOf<PredicateData>();

    const invalidJoinLeft = () =>
      // @ts-expect-error clause helpers reject keys outside the left row.
      clauses<Entry, Account>({ missingAccount: 'id' });
    const invalidJoinRight = () =>
      // @ts-expect-error clause helpers reject values outside the right row.
      clauses<Entry, Account>({ accountId: 'missingId' });
    const invalidCorrelationOuter = () =>
      // @ts-expect-error correlation helpers reject keys outside the outer row.
      correlate<Entry, Account>({ missingAccount: 'id' });
    const invalidCorrelationInner = () =>
      // @ts-expect-error correlation helpers reject values outside the inner row.
      correlate<Entry, Account>({ accountId: 'missingId' });
    void invalidJoinLeft;
    void invalidJoinRight;
    void invalidCorrelationOuter;
    void invalidCorrelationInner;
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

    // @ts-expect-error deleteExact requires a complete relation row, not a partial match shape.
    const invalidDeleteExact = deleteExact(schema.entries, { id: 'e1', accountId: 'cash' });
    void invalidDeleteExact;
  });

  it('keeps watch and change tracking results free of constant kind tags', async () => {
    const target = from(schema.entries);
    const handle = watch(openingDb, target, () => undefined, { label: 'entries' });
    const registration = watchTarget(openingDb, target);
    const refresh = await handle.refresh();
    const closed = handle.unwatch();
    const closedAgain = unwatch(handle);
    const subscription = subscribeWatch(handle, () => undefined);
    const unsubscribe = subscription.unsubscribe();
    const diff = await diffQuery(openingDb, openingDb, target);

    expect('kind' in handle).toBe(false);
    expect('kind' in registration).toBe(false);
    expect('kind' in refresh).toBe(false);
    expect('kind' in closed).toBe(false);
    expect('kind' in closedAgain).toBe(false);
    expect('kind' in subscription).toBe(false);
    expect('kind' in unsubscribe).toBe(false);
    expect('kind' in diff).toBe(false);

    expectTypeOf<typeof handle>().toEqualTypeOf<WatchHandle<typeof openingDb, Entry>>();
    expectTypeOf<typeof registration>().toEqualTypeOf<WatchTargetRegistration<typeof openingDb, Entry>>();
    expectTypeOf<typeof refresh>().toEqualTypeOf<WatchRefreshResult<Entry>>();
    expectTypeOf<typeof closed>().toEqualTypeOf<UnwatchResult>();
    expectTypeOf<typeof subscription>().toEqualTypeOf<WatchSubscription>();
    expectTypeOf<typeof unsubscribe>().toEqualTypeOf<WatchUnsubscribeResult>();
    expectTypeOf<typeof diff>().toEqualTypeOf<QueryDiff<Entry>>();
    expectTypeOf<HasKind<WatchEvent<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchRefreshResult<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchUnsubscribeResult>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchSubscription>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchHandle<typeof openingDb, Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchTargetRegistration<typeof openingDb, Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<UnwatchResult>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackedChange<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchTargetChange<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<QueryDiff<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackTransactResult<typeof openingDb>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackRuntimeCommitSupportedResult<number>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackRuntimeCommitUnsupportedResult<number>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackRuntimeCommitResult<number>>>().toEqualTypeOf<false>();

    // @ts-expect-error WatchHandle.kind is intentionally not public.
    expect(handle.kind).toBeUndefined();
    // @ts-expect-error WatchSubscription.kind is intentionally not public.
    expect(subscription.kind).toBeUndefined();
    // @ts-expect-error QueryDiff.kind is intentionally not public.
    expect(diff.kind).toBeUndefined();
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
