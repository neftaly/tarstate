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
  demat,
  difference,
  env,
  eq,
  exists,
  extend,
  fk,
  field,
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
  materializationsFor,
  materializedRowsForQuery,
  maybe,
  pipe,
  project,
  q,
  qMany,
  qManyRows,
  qRows,
  qualify,
  queryKey,
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
  unwatch,
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

  it('supports in-memory host function expressions without replacing named calls', async () => {
    const state = createDb(sourceData);
    const user = as(coreSchema.users, 'user');
    const ageBand = (age: number) => age >= 30 ? 'senior' : 'junior';
    const initials = (name: string, teamId: string) => `${name[0]}:${teamId}`;
    const query = pipe(
      from(user),
      project({
        id: user.id,
        band: call(ageBand, user.age),
        initials: call(initials, user.name, user.teamId)
      }),
      sort(user.id)
    );
    const sameFunctionQuery = pipe(
      from(user),
      project({ id: user.id, band: call(ageBand, user.age) })
    );
    const sameFunctionQueryAgain = pipe(
      from(user),
      project({ id: user.id, band: call(ageBand, user.age) })
    );

    await expect(qRows(state, query)).resolves.toEqual([
      { id: 'ada', band: 'senior', initials: 'A:eng' },
      { id: 'bea', band: 'junior', initials: 'B:design' },
      { id: 'cal', band: 'senior', initials: 'C:missing' }
    ]);
    expect(queryKey(sameFunctionQuery)).toBe(queryKey(sameFunctionQueryAgain));
    expect(JSON.stringify(query.data)).not.toContain('fn');

    const serialized = {
      ...query,
      data: JSON.parse(JSON.stringify(query.data))
    };
    await expect(q(state, serialized)).resolves.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: 'unsupported_expression',
          message: expect.stringContaining('host function')
        }),
        expect.objectContaining({
          code: 'unsupported_expression',
          message: expect.stringContaining('host function')
        }),
        expect.objectContaining({
          code: 'unsupported_expression',
          message: expect.stringContaining('host function')
        }),
        expect.objectContaining({
          code: 'unsupported_expression',
          message: expect.stringContaining('host function')
        }),
        expect.objectContaining({
          code: 'unsupported_expression',
          message: expect.stringContaining('host function')
        }),
        expect.objectContaining({
          code: 'unsupported_expression',
          message: expect.stringContaining('host function')
        })
      ]
    });
  });

  it('applies q output options and per-entry batch query specs', async () => {
    const state = createDb(sourceData);
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, age: user.age, name: user.name })
    );

    await expect(qRows(state, coreSchema.users, {
      sort: 'age',
      mapRows: (rows) => rows.map((row) => row.name)
    })).resolves.toEqual(['Bea', 'Ada', 'Cal']);

    const idSet = await q(state, activeUsers, {
      rsort: (row) => row.age,
      mapRows: (rows) => rows.map((row) => row.id),
      into: (rows) => new Set(rows)
    });
    expect(idSet.rows).toEqual(new Set(['ada', 'bea']));

    await expect(qManyRows(state, {
      activeIds: {
        q: activeUsers,
        rsort: 'age',
        mapRows: (rows) => rows.map((row) => row.id)
      },
      teamNames: {
        q: coreSchema.teams,
        sort: 'name',
        mapRows: (rows) => rows.map((row) => row.name)
      }
    })).resolves.toEqual({
      activeIds: ['ada', 'bea'],
      teamNames: ['Design', 'Engineering']
    });
  });

  it('accepts extra where predicates on row and exists reads', async () => {
    const state = createDb(sourceData);
    const user = as(coreSchema.users, 'user');

    await expect(row(state, from(user), eq(user.id, 'bea'))).resolves.toMatchObject({ id: 'bea' });
    await expect(row(state, coreSchema.users, eq(field('users', 'id'), 'ada'))).resolves.toMatchObject({ id: 'ada' });
    await expect(exists(state, from(user), eq(user.id, 'bea'), eq(user.active, true))).resolves.toBe(true);
    await expect(exists(state, from(user), eq(user.id, 'cal'), eq(user.active, true))).resolves.toBe(false);
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

  it('maintains multiple materialized queries independently across transactions', async () => {
    const user = as(coreSchema.users, 'user');
    const task = as(coreSchema.tasks, 'task');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name, teamId: user.teamId }),
      keyBy('id')
    );
    const openTasks = pipe(
      from(task),
      where(eq(task.done, false)),
      project({ id: task.id, ownerId: task.ownerId, points: task.points }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), { activeUsers, openTasks });

    expect(materializationsFor(state).map((entry) => entry.id).sort()).toEqual(['activeUsers', 'openTasks']);

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
      insert(coreSchema.tasks, {
        id: 't4',
        ownerId: 'dia',
        title: 'Wire materialization',
        done: false,
        points: 2
      }),
      updateWhere(coreSchema.users, eq(user.id, 'bea'), { active: false })
    );

    await expect(qRows(next, activeUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada', teamId: 'eng' },
      { id: 'dia', name: 'Dia', teamId: 'eng' }
    ]);
    await expect(qRows(next, openTasks)).resolves.toEqual([
      { id: 't1', ownerId: 'ada', points: 5 },
      { id: 't3', ownerId: 'bea', points: 3 },
      { id: 't4', ownerId: 'dia', points: 2 }
    ]);
    expect(materializedRowsForQuery(next, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada', teamId: 'eng' },
      { id: 'dia', name: 'Dia', teamId: 'eng' }
    ]);
    expect(materializedRowsForQuery(next, openTasks)).toEqual([
      { id: 't1', ownerId: 'ada', points: 5 },
      { id: 't3', ownerId: 'bea', points: 3 },
      { id: 't4', ownerId: 'dia', points: 2 }
    ]);
  });

  it('materializes and maintains joined query rows through snapshot recompute', () => {
    const user = as(coreSchema.users, 'user');
    const team = as(coreSchema.teams, 'team');
    const activeUserTeams = pipe(
      from(user),
      where(eq(user.active, true)),
      join(from(team), eq(user.teamId, team.id)),
      project({ id: user.id, name: user.name, team: team.name, rank: team.rank }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), activeUserTeams, { id: 'active-user-teams' });

    expect(materializedRowsForQuery(state, activeUserTeams)).toEqual([
      { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
      { id: 'bea', name: 'Bea', team: 'Design', rank: 2 }
    ]);

    const next = transact(
      state,
      updateWhere(coreSchema.teams, eq(team.id, 'eng'), { rank: 3 }),
      updateWhere(coreSchema.users, eq(user.id, 'bea'), { active: false })
    );

    expect(materializedRowsForQuery(next, activeUserTeams)).toEqual([
      { id: 'ada', name: 'Ada', team: 'Engineering', rank: 3 }
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
    expect(hashIndex.index?.get('eng')).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]);
    expect(hashIndex.index?.has('ops')).toBe(false);
    expect(uniqueIndex.index?.get('ada')).toEqual({ id: 'ada', name: 'Ada', age: 37, teamId: 'eng' });
    expect(btreeIndex.index?.range({ lower: 30 })).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]);
  });

  it('refreshes materialized index facades after transact and removes them with demat', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users' });
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

    const hashIndex = index(next, 'active-users', { kind: 'hash', field: 'teamId' });
    const btreeIndex = index(next, 'active-users', { kind: 'btree', field: 'age' });

    expect(hashIndex.index?.get('eng')).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }
    ]);
    expect(btreeIndex.index?.range({ lower: { value: 25, inclusive: true }, upper: 40 })).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]);

    const materializedResult = await qRows(next, activeUsers);
    const dematerialized = demat(next, activeUsers);

    expect(materializedRowsForQuery(dematerialized, activeUsers)).toBeUndefined();
    expect(index(dematerialized, 'active-users').indexed).toBe(false);
    await expect(qRows(dematerialized, activeUsers)).resolves.toEqual(materializedResult);
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

  it('registers Relic-style watched queries on returned DB values', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    );
    const state = createDb(sourceData);
    const watched = watch(state, activeUsers);

    expect(watched).not.toBe(state);
    await expect(trackTransact(
      state,
      insert(coreSchema.users, {
        id: 'dia',
        teamId: 'eng',
        name: 'Dia',
        active: true,
        age: 24,
        tags: []
      })
    )).resolves.toMatchObject({ changes: [] });

    const tracked = await trackTransact(
      watched,
      insert(coreSchema.users, {
        id: 'dia',
        teamId: 'eng',
        name: 'Dia',
        active: true,
        age: 24,
        tags: []
      })
    );
    const activeUsersChange = tracked.changes.find((change) => change.id === queryKey(activeUsers));

    expect(tracked.result).toMatchObject({ committed: true, applied: 1 });
    expect(activeUsersChange).toMatchObject({
      changed: true,
      addedRows: [{ id: 'dia', name: 'Dia' }],
      removedRows: [],
      rowChanges: [expect.objectContaining({ kind: 'added', row: { id: 'dia', name: 'Dia' } })]
    });

    const removed = await trackTransact(tracked.db, deleteByKey(coreSchema.users, 'bea'));
    expect(removed.changes.find((change) => change.id === queryKey(activeUsers))).toMatchObject({
      changed: true,
      addedRows: [],
      deletedRows: [{ id: 'bea', name: 'Bea' }],
      removedRows: [{ id: 'bea', name: 'Bea' }],
      rowChanges: [expect.objectContaining({ kind: 'removed', row: { id: 'bea', name: 'Bea' } })]
    });

    const unwatched = unwatch(removed.db, activeUsers);
    const afterUnwatch = await trackTransact(
      unwatched,
      insert(coreSchema.users, {
        id: 'eli',
        teamId: 'eng',
        name: 'Eli',
        active: true,
        age: 31,
        tags: []
      })
    );
    expect(afterUnwatch.result).toMatchObject({ committed: true, applied: 1 });
    expect(afterUnwatch.changes).toEqual([]);
  });

  it('does not publish watched changes for rejected transactions', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    );
    const watched = watch(createDb(sourceData), activeUsers);
    const failed = await trackTransact(watched, insert(coreSchema.users, adaUser));

    expect(failed.result).toMatchObject({ committed: false, applied: 0 });
    expect(failed.changes).toEqual([]);
    expect(failed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_key' })
    ]));
    await expect(qRows(failed.db, activeUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
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
