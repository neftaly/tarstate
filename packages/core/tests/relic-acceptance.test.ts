import { describe, expect, it } from 'vitest';
import {
  aggregate,
  as,
  avg,
  bottom,
  bottomBy,
  btree,
  call,
  constRows,
  count,
  countDistinct,
  createDb,
  db,
  deleteByKey,
  desc,
  demat,
  difference,
  env,
  eq,
  evaluate,
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
  maintainMaterializations,
  materializationsFor,
  materializedRowsForQuery,
  maybe,
  max,
  maxBy,
  min,
  minBy,
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
  setConcat,
  sort,
  stripMeta,
  subscribeWatch,
  sum,
  top,
  topBy,
  trackTransact,
  transact,
  tryTransactConstrained,
  tryTransact,
  union,
  unwatch,
  updateEnv,
  updateWhere,
  uniqueIndex,
  value,
  whatIf,
  where,
  withEnv,
  watch,
  watchTargetKey,
  constrain,
  req,
  unique
} from '@tarstate/core';
import type { Db, DbTransactionContext, RelationDelta, RelationSource, WatchEvent } from '@tarstate/core';
import type { Query } from '@tarstate/core/query';
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

function expectNoMaterializationFallback(diagnostics: readonly { readonly code: string }[]): void {
  expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('materialization_incremental_fallback');
}

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

  it('skips recomputing materializations whose dependencies are untouched by transaction deltas', () => {
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
    const previousActiveRows = materializedRowsForQuery(state, activeUsers);
    const previousTaskRows = materializedRowsForQuery(state, openTasks);
    const dia = {
      id: 'dia',
      teamId: 'eng',
      name: 'Dia',
      active: true,
      age: 24,
      tags: []
    };
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, dia]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [{ relation: coreSchema.users, added: [dia], removed: [] }]
    });
    const activeChange = maintained.changes.find((change) => change.id === 'activeUsers');
    const taskChange = maintained.changes.find((change) => change.id === 'openTasks');

    expect(maintained).toMatchObject({ maintained: 2, recomputed: 1, skipped: 1 });
    expect(activeChange).toMatchObject({
      update: 'recomputed',
      recomputed: true,
      dependencies: ['users'],
      touchedDependencies: ['users']
    });
    expect(taskChange).toMatchObject({
      update: 'skipped',
      recomputed: false,
      dependencies: ['tasks'],
      touchedDependencies: []
    });
    expect(materializedRowsForQuery(next, activeUsers)).not.toBe(previousActiveRows);
    expect(materializedRowsForQuery(next, openTasks)).toBe(previousTaskRows);
  });

  it('carries independent materialized rows through transact when unrelated relations change', () => {
    const user = as(coreSchema.users, 'user');
    const task = as(coreSchema.tasks, 'task');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) as Query<{ readonly id: string; readonly name: string }>;
    const openTasks = pipe(
      from(task),
      where(eq(task.done, false)),
      project({ id: task.id, ownerId: task.ownerId }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), { activeUsers, openTasks });
    const previousTaskRows = materializedRowsForQuery(state, openTasks);
    const next = transact(
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

    expect(materializedRowsForQuery(next, openTasks)).toBe(previousTaskRows);
    expect(materializedRowsForQuery(next, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' },
      { id: 'dia', name: 'Dia' }
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

  it('maintains materialized min and max aggregates when extrema are removed or updated', async () => {
    const task = as(coreSchema.tasks, 'task');
    const pointRanges = pipe(
      from(task),
      aggregate({
        groupBy: { ownerId: task.ownerId },
        aggregates: {
          tasks: count(),
          minPoints: min(task.points),
          maxPoints: max(task.points)
        }
      }),
      sort(task.ownerId)
    );
    const state = mat(createDb(sourceData), pointRanges, { id: 'point-ranges' });

    await expect(qRows(state, pointRanges)).resolves.toEqual([
      { ownerId: 'ada', tasks: 2, minPoints: 5, maxPoints: 8 },
      { ownerId: 'bea', tasks: 1, minPoints: 3, maxPoints: 3 }
    ]);

    const removedMin = transact(state, deleteByKey(coreSchema.tasks, 't1'));

    await expect(qRows(removedMin, pointRanges)).resolves.toEqual([
      { ownerId: 'ada', tasks: 1, minPoints: 8, maxPoints: 8 },
      { ownerId: 'bea', tasks: 1, minPoints: 3, maxPoints: 3 }
    ]);
    expect(materializedRowsForQuery(removedMin, pointRanges)).toEqual([
      { ownerId: 'ada', tasks: 1, minPoints: 8, maxPoints: 8 },
      { ownerId: 'bea', tasks: 1, minPoints: 3, maxPoints: 3 }
    ]);

    const updatedExtremum = transact(
      removedMin,
      updateWhere(coreSchema.tasks, eq(task.id, 't2'), { points: 2 })
    );

    await expect(qRows(updatedExtremum, pointRanges)).resolves.toEqual([
      { ownerId: 'ada', tasks: 1, minPoints: 2, maxPoints: 2 },
      { ownerId: 'bea', tasks: 1, minPoints: 3, maxPoints: 3 }
    ]);
    expect(materializedRowsForQuery(updatedExtremum, pointRanges)).toEqual([
      { ownerId: 'ada', tasks: 1, minPoints: 2, maxPoints: 2 },
      { ownerId: 'bea', tasks: 1, minPoints: 3, maxPoints: 3 }
    ]);
  });

  it('maintains materialized top and bottom aggregates across inserted, removed, and updated rows', async () => {
    const task = as(coreSchema.tasks, 'task');
    const pointExtremes = pipe(
      from(task),
      aggregate({
        aggregates: {
          topPoints: top(2, task.points),
          bottomPoints: bottom(2, task.points)
        }
      })
    );
    const state = mat(createDb(sourceData), pointExtremes, { id: 'point-extremes' });

    await expect(qRows(state, pointExtremes)).resolves.toEqual([
      { topPoints: [8, 5], bottomPoints: [3, 5] }
    ]);

    const insertedTop = transact(
      state,
      insert(coreSchema.tasks, {
        id: 't4',
        ownerId: 'bea',
        title: 'Spike aggregate maintenance',
        done: false,
        points: 10
      })
    );

    await expect(qRows(insertedTop, pointExtremes)).resolves.toEqual([
      { topPoints: [10, 8], bottomPoints: [3, 5] }
    ]);

    const updatedIntoBottom = transact(
      insertedTop,
      updateWhere(coreSchema.tasks, eq(task.id, 't4'), { points: 1 })
    );

    await expect(qRows(updatedIntoBottom, pointExtremes)).resolves.toEqual([
      { topPoints: [8, 5], bottomPoints: [1, 3] }
    ]);

    const removedBottom = transact(updatedIntoBottom, deleteByKey(coreSchema.tasks, 't4'));

    await expect(qRows(removedBottom, pointExtremes)).resolves.toEqual([
      { topPoints: [8, 5], bottomPoints: [3, 5] }
    ]);
    expect(materializedRowsForQuery(removedBottom, pointExtremes)).toEqual([
      { topPoints: [8, 5], bottomPoints: [3, 5] }
    ]);
  });

  it('matches maxBy and minBy winners to topBy and bottomBy single-row aggregate semantics', async () => {
    type RankedTask = { readonly task: { readonly id: string } };
    type TaskWinnersRow = {
      readonly maxTask: RankedTask | undefined;
      readonly minTask: RankedTask | undefined;
      readonly topTask: readonly RankedTask[];
      readonly bottomTask: readonly RankedTask[];
    };
    const task = as(coreSchema.tasks, 'task');
    const taskWinners = pipe(
      from(task),
      aggregate({
        aggregates: {
          maxTask: maxBy<RankedTask>(task.points),
          minTask: minBy<RankedTask>(task.points),
          topTask: topBy<RankedTask>(1, task.points),
          bottomTask: bottomBy<RankedTask>(1, task.points)
        }
      })
    );

    const [ranking] = await qRows(createDb(sourceData), taskWinners) as readonly TaskWinnersRow[];

    expect(ranking?.maxTask).toEqual(ranking?.topTask.at(0));
    expect(ranking?.minTask).toEqual(ranking?.bottomTask.at(0));
    expect(ranking?.maxTask?.task.id).toBe('t2');
    expect(ranking?.minTask?.task.id).toBe('t3');
  });

  it('maintains materialized topBy and bottomBy aggregates across inserted, removed, and updated rows', async () => {
    type TaskRankingRow = {
      readonly topTasks: readonly { readonly task: { readonly id: string } }[];
      readonly bottomTasks: readonly { readonly task: { readonly id: string } }[];
    };
    const task = as(coreSchema.tasks, 'task');
    const taskRankings = pipe(
      from(task),
      aggregate({
        aggregates: {
          topTasks: topBy(2, task.points),
          bottomTasks: bottomBy(2, task.points)
        }
      })
    );
    const taskRankIds = async (input: Db): Promise<{ readonly top: readonly string[]; readonly bottom: readonly string[] }> => {
      const [ranking] = await qRows(input, taskRankings) as readonly TaskRankingRow[];
      return {
        top: ranking?.topTasks.map((entry) => entry.task.id) ?? [],
        bottom: ranking?.bottomTasks.map((entry) => entry.task.id) ?? []
      };
    };
    const state = mat(createDb(sourceData), taskRankings, { id: 'task-rankings' });

    await expect(taskRankIds(state)).resolves.toEqual({ top: ['t2', 't1'], bottom: ['t3', 't1'] });

    const insertedTop = transact(
      state,
      insert(coreSchema.tasks, {
        id: 't4',
        ownerId: 'bea',
        title: 'Spike aggregate maintenance',
        done: false,
        points: 10
      })
    );

    await expect(taskRankIds(insertedTop)).resolves.toEqual({ top: ['t4', 't2'], bottom: ['t3', 't1'] });

    const updatedIntoBottom = transact(
      insertedTop,
      updateWhere(coreSchema.tasks, eq(task.id, 't4'), { points: 1 })
    );

    await expect(taskRankIds(updatedIntoBottom)).resolves.toEqual({ top: ['t2', 't1'], bottom: ['t4', 't3'] });

    const removedBottom = transact(updatedIntoBottom, deleteByKey(coreSchema.tasks, 't4'));

    await expect(taskRankIds(removedBottom)).resolves.toEqual({ top: ['t2', 't1'], bottom: ['t3', 't1'] });
    expect(materializedRowsForQuery(removedBottom, taskRankings)?.at(0)).toMatchObject({
      topTasks: [{ task: { id: 't2' } }, { task: { id: 't1' } }],
      bottomTasks: [{ task: { id: 't3' } }, { task: { id: 't1' } }]
    });
  });

  it('maintains materialized countDistinct and setConcat aggregates with added and removed distinct values', async () => {
    const user = as(coreSchema.users, 'user');
    const userFacets = pipe(
      from(user),
      aggregate({
        aggregates: {
          distinctTeams: countDistinct(user.teamId),
          tags: setConcat(user.tags)
        }
      })
    );
    const state = mat(createDb(sourceData), userFacets, { id: 'user-facets' });

    await expect(qRows(state, userFacets)).resolves.toEqual([
      { distinctTeams: 3, tags: new Set(['compiler', 'runtime', 'research']) }
    ]);

    const withDuplicateTeamAndTag = transact(
      state,
      insert(coreSchema.users, {
        id: 'dia',
        teamId: 'eng',
        name: 'Dia',
        active: true,
        age: 24,
        tags: ['runtime', 'ui']
      })
    );

    await expect(qRows(withDuplicateTeamAndTag, userFacets)).resolves.toEqual([
      { distinctTeams: 3, tags: new Set(['compiler', 'runtime', 'research', 'ui']) }
    ]);

    const withoutOriginalDuplicate = transact(withDuplicateTeamAndTag, deleteByKey(coreSchema.users, 'ada'));

    await expect(qRows(withoutOriginalDuplicate, userFacets)).resolves.toEqual([
      { distinctTeams: 3, tags: new Set(['research', 'runtime', 'ui']) }
    ]);

    const withNewDistinctTeam = transact(
      withoutOriginalDuplicate,
      insert(coreSchema.teams, {
        id: 'qa',
        name: 'QA',
        rank: 3
      }),
      insert(coreSchema.users, {
        id: 'eli',
        teamId: 'qa',
        name: 'Eli',
        active: true,
        age: 31,
        tags: ['qa']
      })
    );

    await expect(qRows(withNewDistinctTeam, userFacets)).resolves.toEqual([
      { distinctTeams: 4, tags: new Set(['research', 'runtime', 'ui', 'qa']) }
    ]);

    const withoutNewDistinctTeam = transact(withNewDistinctTeam, deleteByKey(coreSchema.users, 'eli'));

    await expect(qRows(withoutNewDistinctTeam, userFacets)).resolves.toEqual([
      { distinctTeams: 3, tags: new Set(['research', 'runtime', 'ui']) }
    ]);
    expect(materializedRowsForQuery(withoutNewDistinctTeam, userFacets)).toEqual([
      { distinctTeams: 3, tags: new Set(['research', 'runtime', 'ui']) }
    ]);
  });

  it('builds set, hash, unique, and btree facades over materialized rows', () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      hash(user.teamId),
      btree(user.age),
      project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users' });
    const metadata = materializationsFor(state).find((entry) => entry.id === 'active-users');

    const setIndex = index(state, 'active-users');
    const hashIndex = index(state, activeUsers, { kind: 'hash', field: 'teamId' });
    const uniqueIndex = index(state, activeUsers, { kind: 'unique', field: 'id' });
    const btreeIndex = index(state, activeUsers, { kind: 'btree', field: 'age' });

    expect(metadata).toMatchObject({
      dependencies: ['users'],
      maintenance: 'snapshot',
      maintenanceReason: expect.stringContaining('dependency-aware'),
      indexSpecs: [
        { kind: 'set' },
        { kind: 'hash', field: 'teamId' },
        { kind: 'btree', field: 'age' }
      ]
    });
    expect(setIndex.rows.size).toBe(2);
    expect([...setIndex]).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'bea', name: 'Bea', age: 29, teamId: 'design' }
    ]);
    expect(hashIndex.lookup.get('eng')).toEqual(new Set([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]));
    expect(uniqueIndex.index?.lookup.get('bea')).toEqual({ id: 'bea', name: 'Bea', age: 29, teamId: 'design' });
    expect(btreeIndex.lookup.get(37)).toEqual(new Set([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]));
    expect(btreeIndex.index?.ordered).toEqual([29, 37]);
    expect(hashIndex.get('eng')).toEqual(new Set([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]));
    expect(hashIndex.index?.get('eng')).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]);
    expect(hashIndex.index?.has('ops')).toBe(false);
    expect(uniqueIndex.get('ada')).toEqual({ id: 'ada', name: 'Ada', age: 37, teamId: 'eng' });
    expect(uniqueIndex.has('ada')).toBe(true);
    expect(btreeIndex.has(37)).toBe(true);
    expect(btreeIndex.range({ lower: 30 })).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' }
    ]);
  });

  it('builds nested raw maps for multi-key hash, btree, and unique indexes', () => {
    const user = as(coreSchema.users, 'user');
    const userRows = pipe(
      from(user),
      hash(user.teamId, user.active),
      btree(user.active, user.age),
      uniqueIndex(user.teamId, user.id),
      project({ id: user.id, name: user.name, active: user.active, age: user.age, teamId: user.teamId }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), userRows, { id: 'users-by-compound-keys' });

    const hashByTeamActive = index(state, userRows, { kind: 'hash', fields: ['teamId', 'active'] });
    const btreeByActiveAge = index(state, userRows, { kind: 'btree', fields: ['active', 'age'] });
    const uniqueByTeamId = index(state, userRows, { kind: 'unique', fields: ['teamId', 'id'] });

    const engByActive = hashByTeamActive.get('eng') as ReadonlyMap<boolean, ReadonlySet<unknown>>;
    expect(engByActive).toBeInstanceOf(Map);
    expect(engByActive.get(true)).toEqual(new Set([
      { id: 'ada', name: 'Ada', active: true, age: 37, teamId: 'eng' }
    ]));
    expect(hashByTeamActive.index?.rowsFor('missing', false)).toEqual([
      { id: 'cal', name: 'Cal', active: false, age: 41, teamId: 'missing' }
    ]);

    const activeAges = btreeByActiveAge.get(true) as ReadonlyMap<number, ReadonlySet<unknown>>;
    expect([...btreeByActiveAge.keys()]).toEqual([false, true]);
    expect([...activeAges.keys()]).toEqual([29, 37]);
    expect(activeAges.get(29)).toEqual(new Set([
      { id: 'bea', name: 'Bea', active: true, age: 29, teamId: 'design' }
    ]));
    expect(btreeByActiveAge.range({ lower: true })).toEqual([
      { id: 'bea', name: 'Bea', active: true, age: 29, teamId: 'design' },
      { id: 'ada', name: 'Ada', active: true, age: 37, teamId: 'eng' }
    ]);

    const engById = uniqueByTeamId.get('eng') as ReadonlyMap<string, unknown>;
    expect(engById).toBeInstanceOf(Map);
    expect(engById.get('ada')).toEqual({ id: 'ada', name: 'Ada', active: true, age: 37, teamId: 'eng' });
    expect(uniqueByTeamId.index?.rowFor('design', 'bea')).toEqual({
      id: 'bea',
      name: 'Bea',
      active: true,
      age: 29,
      teamId: 'design'
    });
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

  it('evaluates lookup queries through a maintained materialized hash source when available', async () => {
    const user = as(coreSchema.users, 'user');
    const usersByTeam = pipe(
      from(user),
      hash(user.teamId),
      project({
        id: user.id,
        teamId: user.teamId,
        name: user.name,
        active: user.active,
        age: user.age,
        tags: user.tags
      }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), usersByTeam, {
      id: 'users-by-team',
      mode: 'incremental'
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

    if (tracked.result?.materializations === undefined) {
      throw new Error('missing materialization maintenance report');
    }
    expect(tracked.result.materializations).toMatchObject({ recomputed: 0 });
    expectNoMaterializationFallback(tracked.result.materializations.diagnostics);

    let rowsCalls = 0;
    let lookupCalls = 0;
    const indexedMaterializedSource: RelationSource = {
      relationNames: [coreSchema.users.name],
      rows: () => {
        rowsCalls += 1;
        return materializedRowsForQuery(tracked.db, usersByTeam) ?? [];
      },
      lookup: ({ relation, field, value }) => {
        lookupCalls += 1;
        if (relation.name !== coreSchema.users.name || field !== 'teamId') {
          return undefined;
        }

        return index(tracked.db, usersByTeam, { kind: 'hash', field: 'teamId' }).index?.get(value) ?? [];
      }
    };
    const engineeringUsers = pipe(
      lookup(user, 'teamId', 'eng'),
      project({ id: user.id, name: user.name, teamId: user.teamId }),
      keyBy('id')
    );

    await expect(evaluate(indexedMaterializedSource, engineeringUsers)).resolves.toEqual({
      rows: [
        { id: 'ada', name: 'Ada', teamId: 'eng' },
        { id: 'dia', name: 'Dia', teamId: 'eng' }
      ],
      diagnostics: []
    });
    expect({ rowsCalls, lookupCalls }).toEqual({ rowsCalls: 0, lookupCalls: 1 });
  });

  it('tracks DB-centered watch and materialization diffs through trackTransact', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) as Query<{ readonly id: string; readonly name: string }>;
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
    expect(tracked.materializations).toBe(tracked.result?.materializations);
    expect(tracked.result?.materializations).toMatchObject({ maintained: 1, recomputed: 1 });
    expect(events).toHaveLength(1);
    const materializedChange = tracked.changes.find((change) => change.id === 'active-users');
    expect(materializedChange?.unchangedRows).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);
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

  it('delivers query watch events from incremental materialization changes', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) as Query<{ readonly id: string; readonly name: string }>;
    const dia = {
      id: 'dia',
      teamId: 'eng',
      name: 'Dia',
      active: true,
      age: 24,
      tags: []
    };
    const eli = {
      id: 'eli',
      teamId: 'eng',
      name: 'Eli',
      active: true,
      age: 31,
      tags: []
    };
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const events: Array<WatchEvent<{ readonly id: string; readonly name: string }>> = [];
    const handle = watch(state, activeUsers, (event) => {
      events.push(event);
    });

    const tracked = await trackTransact(state, insert(coreSchema.users, dia));
    const materializedChange = tracked.materializations?.changes.find((change) => change.id === 'active-users');

    expect(tracked.result).toMatchObject({ committed: true, applied: 1 });
    expect(materializedChange).toMatchObject({
      update: 'incremental',
      recomputed: false,
      addedRows: [{ id: 'dia', name: 'Dia' }],
      removedRows: []
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: true,
      addedRows: [{ id: 'dia', name: 'Dia' }],
      removedRows: [],
      rowChanges: [expect.objectContaining({ kind: 'added', row: { id: 'dia', name: 'Dia' } })]
    });
    expect(events[0]?.rowChanges).toEqual(materializedChange?.rowChanges);
    expect(events[0]?.rowChanges).toHaveLength(1);
    expect(events[0]?.rowChanges.length).toBeLessThan(events[0]?.rows.length ?? 0);
    expectNoMaterializationFallback(tracked.diagnostics);
    expectNoMaterializationFallback(events[0]?.diagnostics ?? []);

    const transacted = transact(tracked.db, insert(coreSchema.users, eli));

    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      changed: true,
      addedRows: [{ id: 'eli', name: 'Eli' }],
      removedRows: [],
      rowChanges: [expect.objectContaining({ kind: 'added', row: { id: 'eli', name: 'Eli' } })]
    });
    expectNoMaterializationFallback(events.at(-1)?.diagnostics ?? []);
    await expect(qRows(transacted, activeUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' },
      { id: 'dia', name: 'Dia' },
      { id: 'eli', name: 'Eli' }
    ]);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
  });

  it('allows secondary watch subscribers to unsubscribe without closing the original watch', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) as Query<{ readonly id: string; readonly name: string }>;
    const state = createDb(sourceData);
    const primaryEvents: Array<WatchEvent<{ readonly id: string; readonly name: string }>> = [];
    const secondaryEvents: Array<WatchEvent<{ readonly id: string; readonly name: string }>> = [];
    const handle = watch(state, activeUsers, (event) => {
      primaryEvents.push(event);
    });
    const secondary = subscribeWatch(handle, (event) => {
      secondaryEvents.push(event);
    });

    const first = await trackTransact(
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

    expect(secondary).toMatchObject({ kind: 'watchSubscription', id: handle.id, active: true });
    expect(primaryEvents).toHaveLength(1);
    expect(secondaryEvents).toHaveLength(1);
    expect(primaryEvents[0]).toMatchObject({
      addedRows: [{ id: 'dia', name: 'Dia' }]
    });
    expect(secondaryEvents[0]).toMatchObject(primaryEvents[0] ?? {});

    expect(secondary.unsubscribe()).toMatchObject({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: true
    });

    await trackTransact(
      first.db,
      insert(coreSchema.users, {
        id: 'eli',
        teamId: 'eng',
        name: 'Eli',
        active: true,
        age: 31,
        tags: []
      })
    );

    expect(primaryEvents).toHaveLength(2);
    expect(secondaryEvents).toHaveLength(1);
    expect(primaryEvents.at(-1)).toMatchObject({
      addedRows: [{ id: 'eli', name: 'Eli' }]
    });
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
  });

  it('stops handle callbacks and target changes after unwatch(handle)', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) as Query<{ readonly id: string; readonly name: string }>;
    const state = createDb(sourceData);
    const events: Array<WatchEvent<{ readonly id: string; readonly name: string }>> = [];
    const handle = watch(state, activeUsers, (event) => {
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

    expect(events).toHaveLength(1);
    expect(unwatch(handle)).toMatchObject({ kind: 'unwatch', id: handle.id, closed: true });

    const afterUnwatch = await trackTransact(
      tracked.db,
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
    expect(events).toHaveLength(1);
    expect(afterUnwatch.changes).toEqual([]);
    expect(afterUnwatch.changesByTargetKey.get(queryKey(activeUsers))).toBeUndefined();
    expect(unwatch(handle)).toMatchObject({
      kind: 'unwatch',
      id: handle.id,
      closed: false,
      diagnostics: [expect.objectContaining({ code: 'watch_already_closed' })]
    });
  });

  it('skips watched query callbacks when transaction deltas leave dependencies untouched', async () => {
    const user = as(coreSchema.users, 'user');
    const activeUsers = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    ) as Query<{ readonly id: string; readonly name: string }>;
    const state = createDb(sourceData);
    const events: Array<WatchEvent<{ readonly id: string; readonly name: string }>> = [];
    const handle = watch(state, activeUsers, (event) => {
      events.push(event);
    });

    const tracked = await trackTransact(
      state,
      insert(coreSchema.tasks, {
        id: 't4',
        ownerId: 'bea',
        title: 'Document watch skipping',
        done: false,
        points: 1
      })
    );

    expect(tracked.result).toMatchObject({ committed: true, applied: 1 });
    expect(events).toEqual([]);
    expect(tracked.changes).toEqual([]);
    expect(tracked.changesByTargetKey.get(queryKey(activeUsers))).toBeUndefined();
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
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
    const watched = watch(state, activeUsers, coreSchema.users);

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
    const activeUsersMapChange = tracked.changesByTarget.get(activeUsers);
    const relationMapChange = tracked.changesByTarget.get(coreSchema.users);

    expect(tracked.result).toMatchObject({ committed: true, applied: 1 });
    expect(tracked.changeMap.get(activeUsers)).toMatchObject({
      targetKey: queryKey(activeUsers),
      added: [{ id: 'dia', name: 'Dia' }],
      deleted: []
    });
    expect(activeUsersMapChange).toMatchObject({
      targetKey: queryKey(activeUsers),
      added: [{ id: 'dia', name: 'Dia' }],
      deleted: [],
      addedRows: [{ id: 'dia', name: 'Dia' }]
    });
    expect(tracked.changesByTargetKey.get(queryKey(activeUsers))).toMatchObject({
      target: activeUsers,
      added: [{ id: 'dia', name: 'Dia' }]
    });
    expect(relationMapChange).toMatchObject({
      targetKey: watchTargetKey(coreSchema.users),
      added: [{
        id: 'dia',
        teamId: 'eng',
        name: 'Dia',
        active: true,
        age: 24,
        tags: []
      }],
      deleted: []
    });
    expect(activeUsersChange).toMatchObject({
      changed: true,
      added: [{ id: 'dia', name: 'Dia' }],
      deleted: [],
      addedRows: [{ id: 'dia', name: 'Dia' }],
      removedRows: [],
      rowChanges: [expect.objectContaining({ kind: 'added', row: { id: 'dia', name: 'Dia' } })]
    });

    const removed = await trackTransact(tracked.db, deleteByKey(coreSchema.users, 'bea'));
    expect(removed.changes.find((change) => change.id === queryKey(activeUsers))).toMatchObject({
      changed: true,
      added: [],
      deleted: [{ id: 'bea', name: 'Bea' }],
      addedRows: [],
      deletedRows: [{ id: 'bea', name: 'Bea' }],
      removedRows: [{ id: 'bea', name: 'Bea' }],
      rowChanges: [expect.objectContaining({ kind: 'removed', row: { id: 'bea', name: 'Bea' } })]
    });
    expect(removed.changesByTarget.get(coreSchema.users)).toMatchObject({
      deleted: [beaUser],
      deletedRows: [beaUser]
    });

    const updated = await trackTransact(
      removed.db,
      updateWhere(coreSchema.users, eq(user.id, 'ada'), { age: 38 })
    );
    expect(updated.changesByTarget.get(coreSchema.users)).toMatchObject({
      added: [{ ...adaUser, age: 38 }],
      deleted: [adaUser],
      rowChanges: [expect.objectContaining({
        kind: 'updated',
        before: adaUser,
        after: { ...adaUser, age: 38 }
      })]
    });

    const unwatched = unwatch(updated.db, activeUsers, coreSchema.users);
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

  it('aggregates fallback delta changes by target in trackTransact maps', async () => {
    const inserted = {
      id: 'dia',
      teamId: 'eng',
      name: 'Dia',
      active: true,
      age: 24,
      tags: []
    };
    const deltas = [
      { relation: coreSchema.users, added: [inserted], removed: [] },
      { relation: coreSchema.users, added: [], removed: [beaUser] }
    ] satisfies readonly RelationDelta[];
    const state = createDb(sourceData);

    const tracked = await trackTransact(state, (current) => ({
      db: current,
      committed: true,
      deltas,
      diagnostics: []
    }));

    expect(tracked.changes).toHaveLength(2);
    expect(tracked.changeMap.get(coreSchema.users)).toMatchObject({
      targetKey: watchTargetKey(coreSchema.users),
      added: [inserted],
      deleted: [beaUser],
      addedRows: [inserted],
      deletedRows: [beaUser]
    });
    expect(tracked.changesByTarget.get(coreSchema.users)).toMatchObject({
      added: [inserted],
      deleted: [beaUser]
    });
    expect(tracked.changesByTargetKey.get(watchTargetKey(coreSchema.users))).toMatchObject({
      target: coreSchema.users,
      added: [inserted],
      deleted: [beaUser]
    });
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
