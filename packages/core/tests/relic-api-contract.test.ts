import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  as,
  call,
  check,
  constrain,
  createDb,
  demat,
  env,
  eq,
  fk,
  from,
  getEnv,
  hash,
  hostCall,
  index,
  insert,
  keyBy,
  mat,
  pipe,
  project,
  q,
  qMany,
  qManyRows,
  qRows,
  req,
  setEnvTx,
  snapshotHashIndex,
  snapshotIndex,
  sort,
  trackTransact,
  transact,
  tryTransact,
  unique,
  unwatch,
  updateEnv,
  updateWhere,
  value,
  watch,
  where,
  withEnv
} from '@tarstate/core';
import type {
  CheckConstraintData,
  ConstrainedDb,
  ConstraintSet,
  Db,
  DbQueryIntoResult,
  DbQueryOptions,
  DbQuerySort,
  DbTransactionContext,
  DbTransactionResult,
  ExprData,
  ForeignKeyConstraintData,
  MaterializationBtreeIndexResult,
  MaterializationHashIndexResult,
  MaterializationIndexResult,
  MaterializationUniqueIndexResult,
  MaterializedDb,
  Query,
  QueryBatchResult,
  QueryBatchRows,
  RequiredConstraintData,
  TrackTransactResult,
  UniqueConstraintData,
  UnwatchResult,
  WatchEvent,
  WatchHandle
} from '@tarstate/core';
import { adaUser, beaUser, coreSchema, sourceData, type TeamRow, type UserRow } from './fixtures';

type UserListRow = {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
};

type UserLabelRow = {
  readonly id: string;
  readonly label: string;
  readonly senior: boolean;
};

function usersByNameQuery(): Query<UserListRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    hash(user.teamId),
    project({ id: user.id, name: user.name, teamId: user.teamId }),
    sort(user.name)
  ) satisfies Query<UserListRow>;
}

describe('Relic public TypeScript API contract', () => {
  it('keeps Db reads, q/qRows, and batch overloads typed from public imports', async () => {
    const state = createDb(sourceData, { env: { minimumAge: 30 } });
    const userRows = qRows(state, coreSchema.users);
    const usersByName = usersByNameQuery();
    const queryRows = qRows(state, usersByName);
    const mappedRows = qRows(state, usersByName, {
      mapRows: (rows) => rows.map((row) => row.id)
    });
    const keyedUsers = q(state, coreSchema.users, {
      into: (rows) => new Map(rows.map((row) => [row.id, row]))
    });
    const batch = {
      users: usersByName,
      teams: coreSchema.teams
    } as const;
    const batchResult = qMany(state, batch);
    const batchRows = qManyRows(state, batch);
    const options = {
      sort: [(row: UserListRow) => row.name],
      env: { minimumAge: 21 }
    } satisfies DbQueryOptions<UserListRow>;
    const sortSpec: DbQuerySort<UserListRow> | undefined = options.sort;

    expectTypeOf(state).toEqualTypeOf<Db>();
    expectTypeOf(userRows).toEqualTypeOf<Promise<readonly UserRow[]>>();
    expectTypeOf(queryRows).toEqualTypeOf<Promise<readonly UserListRow[]>>();
    expectTypeOf(mappedRows).toEqualTypeOf<Promise<readonly string[]>>();
    expectTypeOf(keyedUsers).toEqualTypeOf<Promise<DbQueryIntoResult<UserRow, Map<string, UserRow>>>>();
    expectTypeOf(batchResult).toEqualTypeOf<Promise<QueryBatchResult<typeof batch>>>();
    expectTypeOf(batchRows).toEqualTypeOf<Promise<QueryBatchRows<typeof batch>>>();
    expectTypeOf(sortSpec).toMatchTypeOf<DbQuerySort<UserListRow> | undefined>();
    await expect(queryRows).resolves.toEqual([
      { id: 'ada', name: 'Ada', teamId: 'eng' },
      { id: 'bea', name: 'Bea', teamId: 'design' },
      { id: 'cal', name: 'Cal', teamId: 'missing' }
    ]);
  });

  it('infers projected pipe row types for public query consumers', async () => {
    const user = as(coreSchema.users, 'user');
    const state = createDb(sourceData);
    const usersById = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) satisfies Query<{ readonly id: string; readonly name: string }>;
    const rows = qRows(state, usersById);
    const materialized = mat(state, usersById, { id: 'active-user-names' });
    const events: WatchEvent<{ readonly id: string; readonly name: string }>[] = [];
    const handle = watch(state, usersById, (event) => {
      events.push(event);
    });

    expectTypeOf(rows).toEqualTypeOf<Promise<readonly { readonly id: string; readonly name: string }[]>>();
    expectTypeOf(materialized).toMatchTypeOf<Db & MaterializedDb>();
    expectTypeOf(handle).toEqualTypeOf<WatchHandle<Db, { readonly id: string; readonly name: string }>>();
    expect(unwatch(handle)).toMatchObject({ kind: 'unwatch', closed: true });
    expect(events).toEqual([]);
    await expect(rows).resolves.toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);
  });

  it('keeps transactions and environment updates as public typed data', () => {
    const state = createDb(sourceData, { env: { minimumAge: 30 } });
    const txBuilder = (tx: DbTransactionContext) => [
      tx.insert(coreSchema.users, { ...beaUser, id: 'bea-copy' }),
      setEnvTx((currentEnv) => ({ ...currentEnv, minimumAge: 35 }))
    ];
    const next = transact(
      state,
      insert(coreSchema.users, { ...adaUser, id: 'ada-copy' }),
      txBuilder,
      updateWhere(coreSchema.users, eq(as(coreSchema.users, 'user').id, 'ada'), { age: 38 })
    );
    const rejected = tryTransact(next, insert(coreSchema.users, { ...adaUser, name: 'Duplicate Ada' }));
    const withExplicitEnv = withEnv(next, { minimumAge: 40 });
    const withUpdatedEnv = updateEnv(withExplicitEnv, (currentEnv) => ({
      ...currentEnv,
      minimumAge: Number(currentEnv.minimumAge) + 1
    }));

    expectTypeOf(next).toEqualTypeOf<Db>();
    expectTypeOf(rejected).toEqualTypeOf<DbTransactionResult>();
    expectTypeOf(getEnv(withUpdatedEnv)).toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expect(rejected).toMatchObject({ committed: false, applied: 0 });
    expect(getEnv(withUpdatedEnv).minimumAge).toBe(41);
  });

  it('keeps materialization, dematerialization, and index facades explicit', () => {
    const usersByName = usersByNameQuery();
    const state = mat(createDb(sourceData), usersByName, { id: 'users-by-name' });
    const setIndex = index<UserListRow>(state, usersByName, { kind: 'set' });
    const hashIndex = index<UserListRow, string>(state, usersByName, { kind: 'hash', field: 'teamId' });
    const inferredIndex = index(state, usersByName);
    const snapshotSet = snapshotIndex<UserListRow>(state, usersByName);
    const snapshotHash = snapshotHashIndex<UserListRow, string>(state, usersByName, 'teamId');
    const dematerialized = demat(state, usersByName);

    expectTypeOf(state).toMatchTypeOf<Db & MaterializedDb>();
    expectTypeOf(setIndex).toEqualTypeOf<MaterializationIndexResult<UserListRow>>();
    expectTypeOf(hashIndex).toEqualTypeOf<MaterializationHashIndexResult<UserListRow, string>>();
    expectTypeOf(inferredIndex).toEqualTypeOf<
      | MaterializationIndexResult<UserListRow>
      | MaterializationHashIndexResult<UserListRow, unknown>
      | MaterializationBtreeIndexResult<UserListRow, unknown>
      | MaterializationUniqueIndexResult<UserListRow, unknown>
    >();
    expectTypeOf(snapshotSet).toEqualTypeOf<MaterializationIndexResult<UserListRow>>();
    expectTypeOf(snapshotHash).toEqualTypeOf<MaterializationHashIndexResult<UserListRow, string>>();
    expectTypeOf(dematerialized).toMatchTypeOf<Db>();
    expect(hashIndex.index?.get('eng')).toEqual([{ id: 'ada', name: 'Ada', teamId: 'eng' }]);
    expect(snapshotSet.indexed).toBe(true);
  });

  it('keeps constraints and env expressions as public query-adjacent data', () => {
    const user = as(coreSchema.users, 'user');
    const adults = pipe(
      from(user),
      where(eq(user.active, true)),
      where(eq(user.age, env<number>('minimumAge'))),
      project({ id: user.id, name: user.name })
    ) satisfies Query<{ readonly id: string; readonly name: string }>;
    const requiredName = req(coreSchema.users, 'name');
    const taskOwner = fk(coreSchema.tasks, 'ownerId', coreSchema.users, 'id');
    const uniqueUserName = unique(coreSchema.users, ['teamId', 'name'] as const);
    const ageCheck = check(adults, eq(value(true), true));
    const constrained = constrain(requiredName, taskOwner, uniqueUserName, ageCheck);
    const attached = mat(createDb(sourceData), constrained);

    expectTypeOf(requiredName).toEqualTypeOf<RequiredConstraintData<typeof coreSchema.users, 'name'>>();
    expectTypeOf(taskOwner).toEqualTypeOf<
      ForeignKeyConstraintData<typeof coreSchema.tasks, typeof coreSchema.users, readonly ['ownerId'], readonly ['id']>
    >();
    expectTypeOf(uniqueUserName).toEqualTypeOf<
      UniqueConstraintData<typeof coreSchema.users, readonly ['teamId', 'name']>
    >();
    expectTypeOf(ageCheck).toEqualTypeOf<CheckConstraintData<{ readonly id: string; readonly name: string }>>();
    expectTypeOf(constrained).toEqualTypeOf<
      ConstraintSet<readonly [
        RequiredConstraintData<typeof coreSchema.users, 'name'>,
        ForeignKeyConstraintData<typeof coreSchema.tasks, typeof coreSchema.users, readonly ['ownerId'], readonly ['id']>,
        UniqueConstraintData<typeof coreSchema.users, readonly ['teamId', 'name']>,
        CheckConstraintData<{ readonly id: string; readonly name: string }>
      ]>
    >();
    expectTypeOf(attached).toMatchTypeOf<Db & ConstrainedDb>();
    expect(constrained.constraints.map((constraint) => constraint.op)).toEqual(['req', 'fk', 'unique', 'check']);

    const typeOnly = false as boolean;
    if (typeOnly) {
      // @ts-expect-error relation constraints only accept fields from the relation row.
      req(coreSchema.users, 'missing');
      // @ts-expect-error relation unique constraints only accept fields from the relation row.
      unique(coreSchema.users, ['teamId', 'missing'] as const);
    }
  });

  it('keeps watch/unwatch and trackTransact overloads typed without exposing internals', async () => {
    const usersByName = usersByNameQuery();
    const watchedDb = watch(createDb(sourceData), usersByName, coreSchema.users);
    const events: WatchEvent<UserListRow>[] = [];
    const handle = watch(createDb(sourceData), usersByName, (event) => {
      events.push(event);
    }, { label: 'users-by-name' });
    const closed = unwatch(handle);
    const unwatchedDb = unwatch(watchedDb, usersByName);
    const tracked = trackTransact(
      watchedDb,
      insert(coreSchema.users, { ...adaUser, id: 'ada-copy' }),
      { label: 'insert-user' }
    );
    const callbackTracked = trackTransact(
      watchedDb,
      (db) => transact(db, insert(coreSchema.users, { ...beaUser, id: 'bea-copy' })),
      { mode: 'callback', label: 'callback-user' }
    );

    expectTypeOf(watchedDb).toEqualTypeOf<Db>();
    expectTypeOf(handle).toEqualTypeOf<WatchHandle<Db, UserListRow>>();
    expectTypeOf(closed).toEqualTypeOf<UnwatchResult>();
    expectTypeOf(unwatchedDb).toEqualTypeOf<Db>();
    expectTypeOf(tracked).toEqualTypeOf<Promise<TrackTransactResult<Db>>>();
    expectTypeOf(callbackTracked).toEqualTypeOf<Promise<TrackTransactResult<Db>>>();
    expect(closed).toMatchObject({ kind: 'unwatch', closed: true });
    expect(events).toEqual([]);
    await expect(tracked).resolves.toMatchObject({ kind: 'trackTransact', supported: true, label: 'insert-user' });
    await expect(callbackTracked).resolves.toMatchObject({ kind: 'trackTransact', supported: true, label: 'callback-user' });
  });

  it('keeps named and host-backed function calls typed as expression data', async () => {
    const user = as(coreSchema.users, 'user');
    const labelCall = call<string>('label', user.name, env<string>('suffix'));
    const seniorCall = hostCall((age: number) => age >= 35, user.age);
    const inferredHostCall = call((name: string, senior: boolean) => `${name}:${senior}`, user.name, seniorCall);
    const query = pipe(
      from(user),
      project({
        id: user.id,
        label: labelCall,
        senior: seniorCall
      }),
      sort(user.id)
    ) satisfies Query<UserLabelRow>;
    const rows = qRows(createDb(sourceData), query, {
      env: { suffix: 'core' },
      functions: { label: (name, suffix) => `${String(name)}:${String(suffix)}` }
    });

    expectTypeOf(labelCall).toEqualTypeOf<ExprData<string>>();
    expectTypeOf(seniorCall).toEqualTypeOf<ExprData<boolean>>();
    expectTypeOf(inferredHostCall).toEqualTypeOf<ExprData<string>>();
    expectTypeOf(rows).toEqualTypeOf<Promise<readonly UserLabelRow[]>>();
    await expect(rows).resolves.toEqual([
      { id: 'ada', label: 'Ada:core', senior: true },
      { id: 'bea', label: 'Bea:core', senior: false },
      { id: 'cal', label: 'Cal:core', senior: true }
    ]);
  });

  it('keeps relation row types distinct from plain relation names', async () => {
    const state = createDb(sourceData);
    const typedRows = qRows(state, coreSchema.teams);
    const namedRows = qRows(state, 'teams');

    expectTypeOf(typedRows).toEqualTypeOf<Promise<readonly TeamRow[]>>();
    expectTypeOf(namedRows).toEqualTypeOf<Promise<readonly unknown[]>>();
    await expect(typedRows).resolves.toEqual(sourceData.teams);
    await expect(namedRows).resolves.toEqual(sourceData.teams);
  });
});
