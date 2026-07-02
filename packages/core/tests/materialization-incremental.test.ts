import { describe, expect, it } from 'vitest';
import {
  aggregate,
  asc,
  as,
  avg,
  call,
  constrain,
  constRows,
  count,
  createDb,
  desc,
  difference,
  eq,
  from,
  gt,
  insert,
  intersection,
  join,
  keyBy,
  leftJoin,
  maintainMaterializations,
  mat,
  maybe,
  materializedRowsForQuery,
  max,
  min,
  pipe,
  project,
  qRows,
  sortLimit,
  sum,
  trackTransact,
  tryTransact,
  unique,
  union,
  updateWhere,
  value,
  watch,
  where
} from '@tarstate/core';
import type { Db, MaterializationMaintenanceResult, Query, RelationDelta, WatchEvent } from '@tarstate/core';
import {
  adaUser,
  beaUser,
  calUser,
  coreSchema,
  designTeam,
  engineeringTeam,
  reviewFixturesTask,
  shipRuntimeTask,
  sourceData,
  type TaskRow,
  type TeamRow,
  type UserRow
} from './fixtures';

type ActiveUserRow = {
  readonly id: string;
  readonly name: string;
  readonly age: number;
  readonly teamId: string;
};

type UserTeamRow = {
  readonly id: string;
  readonly name: string;
  readonly team: string | undefined;
  readonly rank: number | undefined;
};

type TaskOwnerRow = {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly points: number;
};

type TaskProjectStatsRow = {
  readonly ownerId: string;
  readonly tasks: number;
  readonly points: number;
  readonly averagePoints: number;
  readonly minPoints: number;
  readonly maxPoints: number;
};

type UserNameRow = {
  readonly id: string;
  readonly name: string;
};

type UserBandRow = {
  readonly id: string;
  readonly band: string;
};

const diaUser: UserRow = {
  id: 'dia',
  teamId: 'eng',
  name: 'Dia',
  active: true,
  age: 24,
  tags: []
};

const extraTask: TaskRow = {
  id: 't4',
  ownerId: 'bea',
  title: 'Polish materialization tests',
  done: false,
  points: 7
};

function activeUsersQuery(): Query<ActiveUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
    keyBy('id')
  ) as Query<ActiveUserRow>;
}

function userTeamsQuery(): Query<UserTeamRow> {
  const user = as(coreSchema.users, 'user');
  const team = as(coreSchema.teams, 'team');
  return pipe(
    from(user),
    leftJoin(from(team), eq(user.teamId, team.id)),
    project({ id: user.id, name: user.name, team: maybe(team.name), rank: maybe(team.rank) }),
    keyBy('id')
  ) as Query<UserTeamRow>;
}

function openTaskOwnersQuery(): Query<TaskOwnerRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  return pipe(
    from(task),
    where(eq(task.done, false)),
    join(from(owner), eq(task.ownerId, owner.id)),
    where(gt(task.points, value(2))),
    project({ id: task.id, title: task.title, owner: owner.name, points: task.points }),
    keyBy('id')
  ) as Query<TaskOwnerRow>;
}

function taskProjectStatsQuery(): Query<TaskProjectStatsRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    aggregate({
      groupBy: { ownerId: task.ownerId },
      aggregates: {
        tasks: count(),
        points: sum(task.points),
        averagePoints: avg(task.points),
        minPoints: min(task.points),
        maxPoints: max(task.points)
      }
    }),
    keyBy('ownerId')
  ) as Query<TaskProjectStatsRow>;
}

function userNamesQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function allowedNamesQuery(): Query<UserNameRow> {
  return pipe(
    constRows([
      { id: 'ada', name: 'Ada' },
      { id: 'cal', name: 'Cal' },
      { id: 'pin', name: 'Pinned' }
    ]),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function blockedNamesQuery(): Query<UserNameRow> {
  return pipe(
    constRows([{ id: 'bea', name: 'Bea' }]),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function topUsersByAgeQuery(): Query<ActiveUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    sortLimit(2, desc(user.age), asc(user.id)),
    project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
    keyBy('id')
  ) as Query<ActiveUserRow>;
}

function userAgeBandsQuery(): Query<UserBandRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(call(isSenior, user.age), true)),
    project({ id: user.id, band: call(ageBand, user.age) }),
    keyBy('id')
  ) as Query<UserBandRow>;
}

function ageBand(age: unknown): string {
  return typeof age === 'number' && age >= 40 ? '40s' : '30s';
}

function isSenior(age: unknown): boolean {
  return typeof age === 'number' && age >= 35;
}

function usersDelta(added: readonly UserRow[], removed: readonly UserRow[]): RelationDelta<typeof coreSchema.users> {
  return { relation: coreSchema.users, added, removed };
}

function teamsDelta(added: readonly TeamRow[], removed: readonly TeamRow[]): RelationDelta<typeof coreSchema.teams> {
  return { relation: coreSchema.teams, added, removed };
}

function tasksDelta(added: readonly TaskRow[], removed: readonly TaskRow[]): RelationDelta<typeof coreSchema.tasks> {
  return { relation: coreSchema.tasks, added, removed };
}

function singleMaterializationChange<Row>(
  result: MaterializationMaintenanceResult | undefined,
  id: string
): MaterializationMaintenanceResult<Row>['changes'][number] {
  const change = result?.changes.find((item) => item.id === id);
  expect(change).toBeDefined();
  return change as MaterializationMaintenanceResult<Row>['changes'][number];
}

async function expectMaterializedRowsMatchQRows<Row>(db: Db, query: Query<Row>): Promise<void> {
  expect(materializedRowsForQuery(db, query)).toEqual(await qRows(db, query));
}

describe('materialization public behavior', () => {
  it('keeps projected relation materializations in parity with qRows and exposes coherent transaction rows', async () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users' });

    await expectMaterializedRowsMatchQRows(state, activeUsers);

    const tracked = await trackTransact(state, insert(coreSchema.users, diaUser));
    const change = singleMaterializationChange<ActiveUserRow>(tracked.materializations, 'active-users');

    expect(tracked.result).toMatchObject({ committed: true });
    expect(change.rows).toEqual(await qRows(tracked.db, activeUsers));
    expect(change.addedRows).toEqual([{ id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }]);
    expect(change.removedRows).toEqual([]);
    expect(materializedRowsForQuery(tracked.db, activeUsers)).toEqual(change.rows);
  });

  it('keeps aggregate rows correct across inserts, deletes, and value updates', async () => {
    const stats = taskProjectStatsQuery();
    const state = mat(createDb(sourceData), stats, { id: 'task-project-stats' });

    expect(materializedRowsForQuery(state, stats)).toEqual([
      { ownerId: 'ada', tasks: 2, points: 13, averagePoints: 6.5, minPoints: 5, maxPoints: 8 },
      { ownerId: 'bea', tasks: 1, points: 3, averagePoints: 3, minPoints: 3, maxPoints: 3 }
    ]);

    const insertedDb = createDb({ ...sourceData, tasks: [...sourceData.tasks, extraTask] });
    const inserted = maintainMaterializations(state, insertedDb, {
      deltas: [tasksDelta([extraTask], [])]
    });
    const insertedChange = singleMaterializationChange<TaskProjectStatsRow>(inserted, 'task-project-stats');

    expect(insertedChange.rows).toEqual(await qRows(insertedDb, stats));
    expect(insertedChange.addedRows).toEqual([]);
    expect(insertedChange.removedRows).toEqual([]);
    expect(insertedChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { ownerId: 'bea', tasks: 1, points: 3, averagePoints: 3, minPoints: 3, maxPoints: 3 },
        after: { ownerId: 'bea', tasks: 2, points: 10, averagePoints: 5, minPoints: 3, maxPoints: 7 }
      })
    ]));

    const updatedShip = { ...shipRuntimeTask, points: 2 };
    const updatedDb = createDb({ ...sourceData, tasks: [updatedShip, reviewFixturesTask, extraTask] });
    const updated = maintainMaterializations(insertedDb, updatedDb, {
      deltas: [tasksDelta([updatedShip], [shipRuntimeTask])]
    });
    const updatedChange = singleMaterializationChange<TaskProjectStatsRow>(updated, 'task-project-stats');

    expect(updatedChange.rows).toEqual(await qRows(updatedDb, stats));
    expect(updatedChange.rows).toEqual([
      { ownerId: 'ada', tasks: 1, points: 2, averagePoints: 2, minPoints: 2, maxPoints: 2 },
      { ownerId: 'bea', tasks: 2, points: 10, averagePoints: 5, minPoints: 3, maxPoints: 7 }
    ]);
  });

  it('keeps inner and left joins readable after relation changes', async () => {
    const openTaskOwners = openTaskOwnersQuery();
    const state = mat(createDb(sourceData), openTaskOwners, { id: 'open-task-owners' });

    expect(materializedRowsForQuery(state, openTaskOwners)).toEqual([
      { id: 't1', title: 'Draft evaluator', owner: 'Ada', points: 5 },
      { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 3 }
    ]);

    const renamedBea = { ...beaUser, name: 'Beatrice' };
    const renamedDb = createDb({
      ...sourceData,
      users: [adaUser, renamedBea, calUser],
      tasks: [...sourceData.tasks, extraTask]
    });
    const renamed = maintainMaterializations(state, renamedDb, {
      deltas: [usersDelta([renamedBea], [beaUser]), tasksDelta([extraTask], [])]
    });
    const renamedChange = singleMaterializationChange<TaskOwnerRow>(renamed, 'open-task-owners');

    expect(renamedChange.rows).toEqual(await qRows(renamedDb, openTaskOwners));
    expect(renamedChange.rows).toEqual([
      { id: 't1', title: 'Draft evaluator', owner: 'Ada', points: 5 },
      { id: 't3', title: 'Review fixtures', owner: 'Beatrice', points: 3 },
      { id: 't4', title: 'Polish materialization tests', owner: 'Beatrice', points: 7 }
    ]);

    const userTeams = userTeamsQuery();
    const leftState = mat(createDb(sourceData), userTeams, { id: 'user-teams' });
    const restoredTeam = { id: 'missing', name: 'Support', rank: 4 };
    const withMissingTeam = createDb({ ...sourceData, teams: [...sourceData.teams, restoredTeam] });
    const joined = maintainMaterializations(leftState, withMissingTeam, {
      deltas: [teamsDelta([restoredTeam], [])]
    });
    const joinedChange = singleMaterializationChange<UserTeamRow>(joined, 'user-teams');

    expect(joinedChange.rows).toEqual(await qRows(withMissingTeam, userTeams));
    expect(joinedChange.rows).toContainEqual({ id: 'cal', name: 'Cal', team: 'Support', rank: 4 });
  });

  it('keeps set operators in parity with qRows as source rows move between branches', async () => {
    const setQueries = [
      {
        id: 'user-name-union',
        query: union(userNamesQuery(), allowedNamesQuery()) as Query<UserNameRow>
      },
      {
        id: 'user-name-intersection',
        query: intersection(userNamesQuery(), allowedNamesQuery()) as Query<UserNameRow>
      },
      {
        id: 'user-name-difference',
        query: difference(userNamesQuery(), blockedNamesQuery()) as Query<UserNameRow>
      }
    ];
    const activeCal = { ...calUser, active: true };

    for (const { id, query } of setQueries) {
      const state = mat(createDb(sourceData), query, { id });
      const next = createDb({ ...sourceData, users: [adaUser, beaUser, activeCal] });
      const maintained = maintainMaterializations(state, next, {
        deltas: [usersDelta([activeCal], [calUser])]
      });
      const change = singleMaterializationChange<UserNameRow>(maintained, id);

      expect(change.rows).toEqual(await qRows(next, query));
      expect(materializedRowsForQuery(next, query)).toEqual(change.rows);
    }
  });

  it('keeps sortLimit windows correct for inserts and visible updates', async () => {
    const topUsers = topUsersByAgeQuery();
    const state = mat(createDb(sourceData), topUsers, { id: 'top-users' });
    const eliUser: UserRow = {
      id: 'eli',
      teamId: 'eng',
      name: 'Eli',
      active: true,
      age: 45,
      tags: []
    };

    const insertedDb = createDb({ ...sourceData, users: [...sourceData.users, eliUser] });
    const inserted = maintainMaterializations(state, insertedDb, {
      deltas: [usersDelta([eliUser], [])]
    });
    const insertedChange = singleMaterializationChange<ActiveUserRow>(inserted, 'top-users');

    expect(insertedChange.rows).toEqual(await qRows(insertedDb, topUsers));
    expect(insertedChange.addedRows).toContainEqual({ id: 'eli', name: 'Eli', age: 45, teamId: 'eng' });
    expect(insertedChange.removedRows).toContainEqual({ id: 'ada', name: 'Ada', age: 37, teamId: 'eng' });

    const updatedAda = { ...adaUser, age: 46, name: 'Ada Prime' };
    const updatedDb = createDb({ ...sourceData, users: [updatedAda, beaUser, calUser, eliUser] });
    const updated = maintainMaterializations(insertedDb, updatedDb, {
      deltas: [usersDelta([updatedAda], [adaUser])]
    });
    const updatedChange = singleMaterializationChange<ActiveUserRow>(updated, 'top-users');

    expect(updatedChange.rows).toEqual(await qRows(updatedDb, topUsers));
    expect(updatedChange.rows).toEqual([
      { id: 'ada', name: 'Ada Prime', age: 46, teamId: 'eng' },
      { id: 'eli', name: 'Eli', age: 45, teamId: 'eng' }
    ]);
  });

  it('keeps direct host calls in filters and projections consistent with qRows', async () => {
    const bands = userAgeBandsQuery();
    const state = mat(createDb(sourceData), bands, { id: 'age-bands' });

    expect(materializedRowsForQuery(state, bands)).toEqual([
      { id: 'ada', band: '30s' },
      { id: 'cal', band: '40s' }
    ]);

    const seniorBea = { ...beaUser, age: 39 };
    const next = createDb({ ...sourceData, users: [adaUser, seniorBea, calUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([seniorBea], [beaUser])]
    });
    const change = singleMaterializationChange<UserBandRow>(maintained, 'age-bands');

    expect(change.rows).toEqual(await qRows(next, bands));
    expect(change.addedRows).toEqual([{ id: 'bea', band: '30s' }]);
  });

  it('delivers watch events from materialized rows and stops after unwatch', async () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'watched-active-users' });
    const events: Array<WatchEvent<ActiveUserRow>> = [];
    const handle = watch(state, activeUsers, (event) => {
      events.push(event);
    });

    const tracked = await trackTransact(state, insert(coreSchema.users, diaUser));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: true,
      addedRows: [{ id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }],
      removedRows: []
    });
    expect(events[0]?.rows).toEqual(await qRows(tracked.db, activeUsers));
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });

    const user = as(coreSchema.users, 'user');
    await trackTransact(tracked.db, updateWhere(coreSchema.users, eq(user.id, 'dia'), {
      name: 'Dia Updated'
    }));

    expect(events).toHaveLength(1);
  });

  it('keeps query-bound constraints active alongside materialized queries', async () => {
    const activeUsers = activeUsersQuery();
    const base = createDb({
      teams: [engineeringTeam, designTeam],
      users: [adaUser, beaUser],
      tasks: []
    });
    const state = mat(
      mat(base, activeUsers, { id: 'active-users' }),
      constrain(unique(activeUsers, 'name'))
    );

    const rejected = tryTransact(state, insert(coreSchema.users, {
      ...diaUser,
      name: 'Ada'
    }));

    expect(rejected).toMatchObject({
      committed: false,
      diagnostics: [expect.objectContaining({ code: 'constraint_unique', field: 'name' })]
    });
    expect(materializedRowsForQuery(rejected.db, activeUsers)).toEqual(await qRows(rejected.db, activeUsers));
  });
});
