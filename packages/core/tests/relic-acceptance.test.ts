import { describe, expect, it } from 'vitest';
import {
  aggregate,
  as,
  avg,
  btree,
  call,
  constRows,
  count,
  createDb,
  db,
  deleteByKey,
  desc,
  difference,
  env,
  eq,
  exists,
  extend,
  fk,
  from,
  getEnv,
  gt,
  hash,
  insert,
  insertOrMerge,
  insertOrUpdate,
  intersection,
  index,
  join,
  keyBy,
  leftJoin,
  limit,
  lookup,
  mat,
  materializedRowsForQuery,
  maybe,
  pipe,
  project,
  q,
  qMany,
  qManyRows,
  qRows,
  qualify,
  rename,
  row,
  sel,
  sel1,
  sort,
  stripMeta,
  sum,
  trackTransact,
  transact,
  tryTransactConstrained,
  tryTransact,
  union,
  updateEnv,
  updateWhere,
  value,
  whatIf,
  where,
  withEnv,
  watch,
  constrain,
  req,
  unique
} from '@tarstate/core';
import type { DbTransactionContext } from '@tarstate/core';
import { diffRows } from '@tarstate/core/experimental/diff';
import { stableKey } from '@tarstate/core/experimental/identity';
import {
  adaUser,
  beaUser,
  coreSchema,
  designTeam,
  draftEvaluatorTask,
  engineeringTeam,
  reviewFixturesTask,
  shipRuntimeTask,
  sourceData,
  teams,
  users
} from './fixtures';

describe('TypeScript Relic core acceptance', () => {
  it('creates immutable database values and reads tables or queries', async () => {
    const state = db(sourceData, { env: { minimumAge: 30 } });
    const user = as(coreSchema.users, 'user');
    const activeAdults = pipe(
      from(user),
      where(eq(user.active, true)),
      where(gt(user.age, env<number>('minimumAge'))),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    );

    await expect(qRows(state, coreSchema.users)).resolves.toEqual(users);
    await expect(qRows(state, 'teams')).resolves.toEqual(teams);
    await expect(q(state, activeAdults)).resolves.toMatchObject({
      rows: [{ id: 'ada', name: 'Ada' }],
      diagnostics: []
    });
    await expect(row(state, activeAdults)).resolves.toEqual({ id: 'ada', name: 'Ada' });
    await expect(exists(state, pipe(from(user), where(eq(user.id, 'missing'))))).resolves.toBe(false);
    expect(stripMeta(state)).toEqual(sourceData);
    expect(() => {
      Reflect.apply(Array.prototype.push, state.data.users, [adaUser]);
    }).toThrow();
  });

  it('supports typed relational query builders and batches', async () => {
    const state = createDb(sourceData);
    const user = as(coreSchema.users, 'user');
    const team = as(coreSchema.teams, 'team');
    const task = as(coreSchema.tasks, 'task');
    const byTeam = pipe(
      from(user),
      join(from(team), eq(user.teamId, team.id)),
      extend({ label: call<string>('label', user.name, team.name) }),
      project({ user: user.name, team: team.name, label: value('unused') }),
      rename({ user: 'person' }),
      sort(desc(team.name)),
      limit(2)
    );
    const orphanUsers = pipe(
      from(user),
      leftJoin(from(team), eq(user.teamId, team.id)),
      project({ id: user.id, team: maybe(team.name) }),
      sort(desc(user.id))
    );
    const taskSummary = pipe(
      from(task),
      aggregate({
        groupBy: { ownerId: task.ownerId },
        aggregates: { tasks: count(), points: sum(task.points), average: avg(task.points) }
      }),
      sort(desc(task.points))
    );
    const setA = constRows([{ id: 'a' }, { id: 'b' }]);
    const setB = constRows([{ id: 'b' }, { id: 'c' }]);
    const setQueries = {
      union: union(setA, setB),
      intersection: intersection(setA, setB),
      difference: difference(setA, setB)
    };

    await expect(qRows(state, byTeam, {
      functions: { label: (...parts) => parts.join(' / ') }
    })).resolves.toEqual([
      { person: 'Ada', team: 'Engineering', label: 'unused' },
      { person: 'Bea', team: 'Design', label: 'unused' }
    ]);
    await expect(qRows(state, orphanUsers)).resolves.toEqual([
      { id: 'cal', team: undefined },
      { id: 'bea', team: 'Design' },
      { id: 'ada', team: 'Engineering' }
    ]);
    await expect(qRows(state, taskSummary)).resolves.toEqual([
      { ownerId: 'ada', tasks: 2, points: 13, average: 6.5 },
      { ownerId: 'bea', tasks: 1, points: 3, average: 3 }
    ]);
    await expect(qManyRows(state, setQueries)).resolves.toEqual({
      union: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      intersection: [{ id: 'b' }],
      difference: [{ id: 'a' }]
    });
    await expect(qMany(state, {
      indexed: pipe(from(user), hash(user.id), btree(user.age), project({ id: user.id })),
      lookup: pipe(lookup(user, 'id', 'ada'), project({ id: user.id, name: user.name })),
      qualified: pipe(constRows([{ id: 'x' }]), qualify('item'))
    })).resolves.toMatchObject({
      indexed: { rows: [{ id: 'ada' }, { id: 'bea' }, { id: 'cal' }] },
      lookup: { rows: [{ id: 'ada', name: 'Ada' }] },
      qualified: { rows: [{ item: { id: 'x' } }] }
    });
  });

  it('evaluates correlated sel and sel1 expressions', async () => {
    const state = createDb(sourceData);
    const user = as(coreSchema.users, 'user');
    const task = as(coreSchema.tasks, 'task');
    const team = as(coreSchema.teams, 'team');
    const taskTitles = pipe(
      from(task),
      where(eq(task.ownerId, user.id)),
      project({ title: task.title })
    );
    const currentTeam = pipe(
      from(team),
      where(eq(team.id, user.teamId)),
      project({ name: team.name })
    );
    const query = pipe(
      from(user),
      project({ id: user.id, tasks: sel(taskTitles), team: sel1(currentTeam) }),
      sort(desc(user.id))
    );

    await expect(qRows(state, query)).resolves.toEqual([
      { id: 'cal', tasks: [], team: undefined },
      { id: 'bea', tasks: [{ title: 'Review fixtures' }], team: { name: 'Design' } },
      { id: 'ada', tasks: [{ title: 'Draft evaluator' }, { title: 'Ship runtime' }], team: { name: 'Engineering' } }
    ]);
  });

  it('transacts immutable writes, builder callbacks, computed updates, and what-if reads', async () => {
    const initial = createDb({ teams: [engineeringTeam, designTeam], users: [adaUser], tasks: [draftEvaluatorTask] });
    const user = as(coreSchema.users, 'user');
    const task = as(coreSchema.tasks, 'task');
    const next = transact(
      initial,
      insert(coreSchema.users, beaUser),
      (tx: DbTransactionContext) => [
        tx.insert(coreSchema.tasks, reviewFixturesTask),
        tx.updateByKey(coreSchema.users, 'ada', (current) => ({ age: current.age + 1 }))
      ],
      insertOrUpdate(coreSchema.tasks, shipRuntimeTask, {
        update: (current, incoming) => ({ points: current.points + incoming.points })
      }),
      insertOrUpdate(coreSchema.tasks, { ...draftEvaluatorTask, points: 2 }, {
        update: (current, incoming) => ({ points: current.points + incoming.points, done: true })
      }),
      insertOrMerge(coreSchema.users, { id: 'bea', active: false }, {
        merge: (current, incoming) => ({ active: incoming.active ?? current.active, age: current.age + 10 })
      })
    );

    expect(next).not.toBe(initial);
    await expect(row(initial, pipe(from(user), where(eq(user.id, 'ada'))))).resolves.toMatchObject({ age: 37 });
    await expect(qRows(initial, coreSchema.users)).resolves.toEqual([adaUser]);
    await expect(row(next, pipe(from(user), where(eq(user.id, 'ada'))))).resolves.toMatchObject({ age: 38 });
    await expect(row(next, pipe(from(user), where(eq(user.id, 'bea'))))).resolves.toMatchObject({
      active: false,
      age: 39
    });
    await expect(row(next, pipe(from(task), where(eq(task.id, 't1'))))).resolves.toMatchObject({
      done: true,
      points: 7
    });

    const hypothetical = await whatIf(
      next,
      pipe(from(task), project({ id: task.id, points: task.points }), sort(desc(task.points))),
      updateWhere(coreSchema.tasks, eq(task.ownerId, 'ada'), (current) => ({ points: current.points * 2 })),
      deleteByKey(coreSchema.tasks, 't3')
    );
    expect(hypothetical.rows).toEqual([
      { id: 't2', points: 16 },
      { id: 't1', points: 14 }
    ]);
    await expect(qRows(next, coreSchema.tasks)).resolves.toHaveLength(3);
  });

  it('reports rejected transactions without committing', () => {
    const state = createDb(sourceData);
    const result = tryTransact(state, insert(coreSchema.users, { ...adaUser, name: 'Duplicate Ada' }));

    expect(result).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [{ code: 'duplicate_key', relation: 'users', key: 'ada' }]
    });
    expect(result.db).toBe(state);
  });

  it('materializes query rows on DB values and maintains them across transact', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users' });

    await expect(qRows(state, activeUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'bea', name: 'Bea', age: 29, teamId: 'design' }
    ]);

    const next = transact(
      state,
      insert(coreSchema.users, {
        id: 'dia',
        teamId: 'eng',
        name: 'Dia',
        active: true,
        age: 24,
        tags: []
      }),
      updateWhere(coreSchema.users, eq(user.id, 'bea'), { active: false })
    );

    await expect(qRows(next, activeUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }
    ]);
    expect(materializedRowsForQuery(next, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }
    ]);
  });

  it('builds set, hash, unique, and btree facades over materialized rows', () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users' });

    const setIndex = index(state, 'active-users');
    const hashIndex = index(state, activeUsers, { kind: 'hash', field: 'teamId' });
    const uniqueIndex = index(state, activeUsers, { kind: 'unique', field: 'id' });
    const btreeIndex = index(state, activeUsers, { kind: 'btree', field: 'age' });

    expect(setIndex.index?.rows.size).toBe(2);
    expect(hashIndex.index?.lookup.get('eng')).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]);
    expect(uniqueIndex.index?.lookup.get('bea')).toEqual({ id: 'bea', name: 'Bea', age: 29, teamId: 'design' });
    expect(btreeIndex.index?.ordered).toEqual([29, 37]);
  });

  it('tracks DB-centered watch and materialization diffs through trackTransact', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users' });
    const events: unknown[] = [];

    watch(state, activeUsers, (event) => {
      events.push(event);
    });

    const tracked = await trackTransact(
      state,
      insert(coreSchema.users, {
        id: 'dia',
        teamId: 'eng',
        name: 'Dia',
        active: true,
        age: 24,
        tags: []
      })
    );

    expect(tracked.result).toMatchObject({ committed: true, applied: 1 });
    expect(events).toHaveLength(1);
    expect(tracked.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changed: true,
        addedRows: [{ id: 'dia', name: 'Dia' }]
      })
    ]));
    await expect(qRows(tracked.db, activeUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' },
      { id: 'dia', name: 'Dia' }
    ]);
  });

  it('enforces attached and explicit constraints as transaction participants', async () => {
    const validState = createDb({
      teams: [engineeringTeam, designTeam],
      users: [adaUser, beaUser],
      tasks: []
    });
    const constrained = mat(
      validState,
      constrain(
        req(coreSchema.users, 'name'),
        unique(coreSchema.users, 'name'),
        fk(coreSchema.users, 'teamId', coreSchema.teams, 'id')
      )
    );

    expect(() => transact(constrained, insert(coreSchema.users, {
      id: 'dia',
      teamId: 'eng',
      name: 'Ada',
      active: true,
      age: 24,
      tags: []
    }))).toThrow();

    await expect(tryTransactConstrained(
      validState,
      [insert(coreSchema.users, {
        id: 'dia',
        teamId: 'eng',
        name: 'Ada',
        active: true,
        age: 24,
        tags: []
      })],
      constrain(unique(coreSchema.users, 'name'))
    )).resolves.toMatchObject({
      committed: false,
      db: validState,
      diagnostics: [expect.objectContaining({ code: 'constraint_unique', relation: 'users', field: 'name' })]
    });
  });

  it('handles env updates and support identity/diff APIs as secondary helpers', () => {
    const state = createDb(sourceData, { env: { minimumPoints: 4 } });
    const changed = updateEnv(withEnv(state, { minimumPoints: 5 }), (current) => ({
      ...current,
      minimumPoints: Number(current.minimumPoints) + 1
    }));

    expect(getEnv(changed)).toEqual({ minimumPoints: 6 });
    expect(stableKey({ b: 2, a: 1 })).toBe(stableKey({ a: 1, b: 2 }));
    expect(diffRows([{ id: 'a', n: 1 }], [{ id: 'a', n: 2 }, { id: 'b', n: 1 }], {
      keyBy: ['id']
    }).changes).toEqual([
      { kind: 'updated', key: '["a"]', before: { id: 'a', n: 1 }, after: { id: 'a', n: 2 } },
      { kind: 'added', key: '["b"]', row: { id: 'b', n: 1 } }
    ]);
  });
});
