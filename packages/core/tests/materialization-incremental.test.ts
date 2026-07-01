import { describe, expect, it } from 'vitest';
import {
  and,
  as,
  call,
  createDb,
  desc,
  eq,
  env,
  from,
  gt,
  insert,
  join,
  keyBy,
  leftJoin,
  maintainMaterializations,
  mat,
  materializationForQuery,
  materializedRowsForQuery,
  maybe,
  pipe,
  project,
  qRows,
  sortLimit,
  trackTransact,
  transact,
  value,
  where
} from '@tarstate/core';
import type { MaterializationMaintenanceResult, Query, RelationDelta } from '@tarstate/core';
import {
  adaUser,
  beaUser,
  calUser,
  coreSchema,
  designTeam,
  draftEvaluatorTask,
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
  readonly team: string;
  readonly rank: number;
};

type MaybeUserTeamRow = {
  readonly id: string;
  readonly name: string;
  readonly team: string | undefined;
};

type TaskOwnerRow = {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly points: number;
};

const diaUser: UserRow = {
  id: 'dia',
  teamId: 'eng',
  name: 'Dia',
  active: true,
  age: 24,
  tags: []
};

const floUser: UserRow = {
  id: 'flo',
  teamId: 'ops',
  name: 'Flo',
  active: true,
  age: 31,
  tags: []
};

const piaUser: UserRow = {
  id: 'pia',
  teamId: 'platform',
  name: 'Pia',
  active: true,
  age: 34,
  tags: []
};

const operationsTeam: TeamRow = { id: 'ops', name: 'Operations', rank: 4 };
const platformTeam: TeamRow = { id: 'platform', name: 'Engineering', rank: 1 };

function activeUsersQuery(): Query<ActiveUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
    keyBy('id')
  ) as Query<ActiveUserRow>;
}

function activeUserTeamsQuery(): Query<UserTeamRow> {
  const user = as(coreSchema.users, 'user');
  const team = as(coreSchema.teams, 'team');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    join(from(team), eq(user.teamId, team.id)),
    project({ id: user.id, name: user.name, team: team.name, rank: team.rank }),
    keyBy('id')
  ) as Query<UserTeamRow>;
}

function leftUserTeamsQuery(): Query<MaybeUserTeamRow> {
  const user = as(coreSchema.users, 'user');
  const team = as(coreSchema.teams, 'team');
  return pipe(
    from(user),
    leftJoin(from(team), eq(user.teamId, team.id)),
    project({ id: user.id, name: user.name, team: maybe(team.name) }),
    keyBy('id')
  ) as Query<MaybeUserTeamRow>;
}

function residualTaskOwnersQuery(): Query<TaskOwnerRow> {
  const task = as(coreSchema.tasks, 'task');
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(task),
    join(from(user), and(eq(task.ownerId, user.id), gt(task.points, value(4)))),
    project({ id: task.id, title: task.title, owner: user.name, points: task.points }),
    keyBy('id')
  ) as Query<TaskOwnerRow>;
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

function singleMaterializationChange(result: MaterializationMaintenanceResult, id: string) {
  const change = result.changes.find((item) => item.id === id);
  expect(change).toBeDefined();
  return change!;
}

function expectNoIncrementalFallback(diagnostics: readonly { readonly code: string }[]): void {
  expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('materialization_incremental_fallback');
}

function expectIncrementalFallback(diagnostics: readonly { readonly code: string }[]): void {
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'materialization_incremental_fallback' })
  ]));
}

describe('incremental materialization', () => {
  it('marks simple filtered/projected/keyed relations as incrementally maintained', () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const metadata = materializationForQuery(state, activeUsers);

    expect(metadata).toMatchObject({
      id: 'active-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'bea', name: 'Bea', age: 29, teamId: 'design' }
    ]);
  });

  it('maintains root inserts, updates, and deletes from relation deltas without full recompute', () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const updatedAda = { ...adaUser, name: 'Ada Lovelace', age: 38 };
    const next = createDb({
      ...sourceData,
      users: [updatedAda, calUser, diaUser]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda, diaUser], [adaUser, beaUser])]
    });
    const change = singleMaterializationChange(maintained, 'active-users');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { id: 'ada', name: 'Ada Lovelace', age: 38, teamId: 'eng' },
        { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }
      ],
      addedRows: [{ id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }],
      removedRows: [{ id: 'bea', name: 'Bea', age: 29, teamId: 'design' }]
    });
    expect(change.rowChanges).toHaveLength(3);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
        after: { id: 'ada', name: 'Ada Lovelace', age: 38, teamId: 'eng' }
      }),
      expect.objectContaining({
        kind: 'removed',
        row: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }
      })
    ]));
    expect(materializedRowsForQuery(next, activeUsers)).toEqual(change.rows);
  });

  it('emits updated for same-key relation updates and remove/add for key-changing updates', () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const updatedAda = { ...adaUser, age: 38 };
    const sameKeyNext = createDb({ ...sourceData, users: [updatedAda, beaUser, calUser] });

    const sameKeyMaintenance = maintainMaterializations(state, sameKeyNext, {
      deltas: [usersDelta([updatedAda], [adaUser])]
    });
    const sameKeyChange = singleMaterializationChange(sameKeyMaintenance, 'active-users');

    expect(sameKeyMaintenance).toMatchObject({ recomputed: 0 });
    expect(sameKeyChange).toMatchObject({ maintenance: 'incremental', recomputed: false });
    expect(sameKeyChange.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
        after: { id: 'ada', name: 'Ada', age: 38, teamId: 'eng' }
      })
    ]);

    const keyChangedBea = { ...beaUser, id: 'bee' };
    const keyChangedNext = createDb({ ...sourceData, users: [adaUser, keyChangedBea, calUser] });
    const keyChangedMaintenance = maintainMaterializations(state, keyChangedNext, {
      deltas: [usersDelta([keyChangedBea], [beaUser])]
    });
    const keyChangedChange = singleMaterializationChange(keyChangedMaintenance, 'active-users');

    expect(keyChangedMaintenance).toMatchObject({ recomputed: 0 });
    expect(keyChangedChange).toMatchObject({ maintenance: 'incremental', recomputed: false });
    expect(keyChangedChange.rowChanges).toHaveLength(2);
    expect(keyChangedChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: 'bee', name: 'Bea', age: 29, teamId: 'design' }
      })
    ]));
    expect(keyChangedChange.rowChanges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'updated' })
    ]));
  });

  it('preserves the old root row position for key-changing relation updates', () => {
    const activeUsers = activeUsersQuery();
    const initial = createDb({
      ...sourceData,
      users: [adaUser, beaUser, diaUser, calUser]
    });
    const state = mat(initial, activeUsers, { id: 'active-users', mode: 'incremental' });
    const keyChangedBea = { ...beaUser, id: 'bee' };
    const next = createDb({
      ...sourceData,
      users: [adaUser, keyChangedBea, diaUser, calUser]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([keyChangedBea], [beaUser])]
    });
    const change = singleMaterializationChange(maintained, 'active-users');

    expect(maintained).toMatchObject({ recomputed: 0 });
    expect(change).toMatchObject({ maintenance: 'incremental', recomputed: false });
    expect(change.rows).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'bee', name: 'Bea', age: 29, teamId: 'design' },
      { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }
    ]);
    expect(materializedRowsForQuery(next, activeUsers)).toEqual(change.rows);
  });

  it('falls back to snapshot recompute when root relation keys are duplicated', () => {
    const activeUsers = activeUsersQuery();
    const duplicateAda = { ...adaUser, name: 'Ada Clone', age: 38 };
    const duplicateSourceState = mat(createDb({
      ...sourceData,
      users: [adaUser, duplicateAda, beaUser, calUser]
    }), activeUsers, { id: 'duplicate-active-users', mode: 'incremental' });
    const duplicateSourceMetadata = materializationForQuery(duplicateSourceState, activeUsers);

    expect(duplicateSourceMetadata).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expectIncrementalFallback(duplicateSourceMetadata?.diagnostics ?? []);
    expect(duplicateSourceMetadata?.maintenanceReason).toContain('duplicate key');
    expect(materializedRowsForQuery(duplicateSourceState, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'ada', name: 'Ada Clone', age: 38, teamId: 'eng' },
      { id: 'bea', name: 'Bea', age: 29, teamId: 'design' }
    ]);

    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, duplicateAda]
    });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([duplicateAda], [])]
    });
    const change = singleMaterializationChange(maintained, 'active-users');

    expect(maintained).toMatchObject({ recomputed: 1 });
    expect(change).toMatchObject({ recomputed: true });
    expectIncrementalFallback(change.diagnostics);
    expect(materializedRowsForQuery(next, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' },
      { id: 'bea', name: 'Bea', age: 29, teamId: 'design' },
      { id: 'ada', name: 'Ada Clone', age: 38, teamId: 'eng' }
    ]);
  });

  it('falls back to snapshot maintenance for env expressions', async () => {
    const user = as(coreSchema.users, 'user');
    const adultUsers = pipe(
      from(user),
      where(gt(user.age, env<number>('minimumAge'))),
      project({ id: user.id, name: user.name }),
      keyBy('id')
    );
    const state = mat(
      createDb(sourceData, { env: { minimumAge: 30 } }),
      adultUsers,
      { id: 'adult-users', mode: 'incremental' }
    );
    const metadata = materializationForQuery(state, adultUsers);

    expect(metadata).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expect(metadata?.maintenanceReason).toContain('env expressions');
    expectIncrementalFallback(metadata?.diagnostics ?? []);
    await expect(qRows(state, adultUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'cal', name: 'Cal' }
    ]);
  });

  it('keeps snapshot fallback diagnostics and correctness for unsupported sortLimit and host-call shapes', async () => {
    const user = as(coreSchema.users, 'user');
    const topUsers = pipe(
      from(user),
      sortLimit(2, desc(user.age)),
      project({ id: user.id, name: user.name, age: user.age }),
      keyBy('id')
    );
    const withAgeBand = pipe(
      from(user),
      project({
        id: user.id,
        band: call((age: number) => age >= 30 ? 'senior' : 'junior', user.age)
      }),
      keyBy('id')
    );

    const sortedState = mat(createDb(sourceData), topUsers, { id: 'top-users', mode: 'incremental' });
    const sortedMetadata = materializationForQuery(sortedState, topUsers);
    expect(sortedMetadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'snapshot' });
    expectIncrementalFallback(sortedMetadata?.diagnostics ?? []);
    await expect(qRows(sortedState, topUsers)).resolves.toEqual([
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 }
    ]);

    const nextSorted = transact(sortedState, insert(coreSchema.users, {
      id: 'eli',
      teamId: 'eng',
      name: 'Eli',
      active: true,
      age: 45,
      tags: []
    }));
    await expect(qRows(nextSorted, topUsers)).resolves.toEqual([
      { id: 'eli', name: 'Eli', age: 45 },
      { id: 'cal', name: 'Cal', age: 41 }
    ]);

    const hostState = mat(createDb(sourceData), withAgeBand, { id: 'age-bands', mode: 'incremental' });
    const hostMetadata = materializationForQuery(hostState, withAgeBand);
    expect(hostMetadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'snapshot' });
    expectIncrementalFallback(hostMetadata?.diagnostics ?? []);
    await expect(qRows(hostState, withAgeBand)).resolves.toEqual([
      { id: 'ada', band: 'senior' },
      { id: 'bea', band: 'junior' },
      { id: 'cal', band: 'senior' }
    ]);
  });

  it('marks initial inner equality joins as incrementally maintained', () => {
    const activeUserTeams = activeUserTeamsQuery();
    const state = mat(createDb(sourceData), activeUserTeams, { id: 'active-user-teams', mode: 'incremental' });
    const metadata = materializationForQuery(state, activeUserTeams);

    expect(metadata).toMatchObject({
      id: 'active-user-teams',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['users', 'teams']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, activeUserTeams)).toEqual([
      { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
      { id: 'bea', name: 'Bea', team: 'Design', rank: 2 }
    ]);
  });

  it('incrementally maintains inner equality joins for left relation inserts, updates, and deletes', () => {
    const activeUserTeams = activeUserTeamsQuery();
    const state = mat(createDb(sourceData), activeUserTeams, { id: 'active-user-teams', mode: 'incremental' });
    const updatedAda = { ...adaUser, name: 'Ada Lovelace' };
    const next = createDb({
      ...sourceData,
      users: [updatedAda, calUser, diaUser]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda, diaUser], [adaUser, beaUser])]
    });
    const change = singleMaterializationChange(maintained, 'active-user-teams');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { id: 'ada', name: 'Ada Lovelace', team: 'Engineering', rank: 1 },
        { id: 'dia', name: 'Dia', team: 'Engineering', rank: 1 }
      ],
      addedRows: [{ id: 'dia', name: 'Dia', team: 'Engineering', rank: 1 }],
      removedRows: [{ id: 'bea', name: 'Bea', team: 'Design', rank: 2 }]
    });
    expect(change.rowChanges).toHaveLength(3);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
        after: { id: 'ada', name: 'Ada Lovelace', team: 'Engineering', rank: 1 }
      }),
      expect.objectContaining({
        kind: 'removed',
        row: { id: 'bea', name: 'Bea', team: 'Design', rank: 2 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: 'dia', name: 'Dia', team: 'Engineering', rank: 1 }
      })
    ]));
    expect(materializedRowsForQuery(next, activeUserTeams)).toEqual(change.rows);
  });

  it('incrementally maintains inner equality joins for right relation updates, deletes, and inserts', () => {
    const activeUserTeams = activeUserTeamsQuery();
    const initial = createDb({
      ...sourceData,
      users: [...sourceData.users, floUser]
    });
    const state = mat(initial, activeUserTeams, { id: 'active-user-teams', mode: 'incremental' });
    const updatedEngineeringTeam = { ...engineeringTeam, name: 'Engineering Platform', rank: 3 };
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, floUser],
      teams: [updatedEngineeringTeam, operationsTeam]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [teamsDelta([updatedEngineeringTeam, operationsTeam], [engineeringTeam, designTeam])]
    });
    const change = singleMaterializationChange(maintained, 'active-user-teams');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['teams'],
      rows: [
        { id: 'ada', name: 'Ada', team: 'Engineering Platform', rank: 3 },
        { id: 'flo', name: 'Flo', team: 'Operations', rank: 4 }
      ],
      addedRows: [{ id: 'flo', name: 'Flo', team: 'Operations', rank: 4 }],
      removedRows: [{ id: 'bea', name: 'Bea', team: 'Design', rank: 2 }]
    });
    expect(change.rowChanges).toHaveLength(3);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
        after: { id: 'ada', name: 'Ada', team: 'Engineering Platform', rank: 3 }
      }),
      expect.objectContaining({
        kind: 'removed',
        row: { id: 'bea', name: 'Bea', team: 'Design', rank: 2 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: 'flo', name: 'Flo', team: 'Operations', rank: 4 }
      })
    ]));
    expect(materializedRowsForQuery(next, activeUserTeams)).toEqual(change.rows);
  });

  it('updates many left rows matching one right row when the right row changes', () => {
    const activeUserTeams = activeUserTeamsQuery();
    const initial = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    });
    const state = mat(initial, activeUserTeams, { id: 'active-user-teams', mode: 'incremental' });
    const updatedEngineeringTeam = { ...engineeringTeam, name: 'Engineering Platform', rank: 3 };
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser],
      teams: [designTeam, updatedEngineeringTeam]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [teamsDelta([updatedEngineeringTeam], [engineeringTeam])]
    });
    const change = singleMaterializationChange(maintained, 'active-user-teams');

    expect(maintained).toMatchObject({ recomputed: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      rows: [
        { id: 'ada', name: 'Ada', team: 'Engineering Platform', rank: 3 },
        { id: 'bea', name: 'Bea', team: 'Design', rank: 2 },
        { id: 'dia', name: 'Dia', team: 'Engineering Platform', rank: 3 }
      ],
      addedRows: [],
      removedRows: []
    });
    expect(change.rowChanges).toHaveLength(2);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
        after: { id: 'ada', name: 'Ada', team: 'Engineering Platform', rank: 3 }
      }),
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'dia', name: 'Dia', team: 'Engineering', rank: 1 },
        after: { id: 'dia', name: 'Dia', team: 'Engineering Platform', rank: 3 }
      })
    ]));
    expect(materializedRowsForQuery(next, activeUserTeams)).toEqual(change.rows);
  });

  it('moves affected rows when a right relation join key changes', () => {
    const activeUserTeams = activeUserTeamsQuery();
    const initial = createDb({
      ...sourceData,
      users: [...sourceData.users, piaUser]
    });
    const state = mat(initial, activeUserTeams, { id: 'active-user-teams', mode: 'incremental' });
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, piaUser],
      teams: [designTeam, platformTeam]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [teamsDelta([platformTeam], [engineeringTeam])]
    });
    const change = singleMaterializationChange(maintained, 'active-user-teams');

    expect(maintained).toMatchObject({ recomputed: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      rows: [
        { id: 'bea', name: 'Bea', team: 'Design', rank: 2 },
        { id: 'pia', name: 'Pia', team: 'Engineering', rank: 1 }
      ],
      addedRows: [{ id: 'pia', name: 'Pia', team: 'Engineering', rank: 1 }],
      removedRows: [{ id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 }]
    });
    expect(change.rowChanges).toHaveLength(2);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: 'pia', name: 'Pia', team: 'Engineering', rank: 1 }
      })
    ]));
    expect(change.rowChanges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'updated' })
    ]));
    expect(materializedRowsForQuery(next, activeUserTeams)).toEqual(change.rows);
  });

  it('incrementally maintains inner joins with residual and(eq(...), gt(...)) predicates', () => {
    const residualTaskOwners = residualTaskOwnersQuery();
    const state = mat(createDb(sourceData), residualTaskOwners, { id: 'residual-task-owners', mode: 'incremental' });
    const updatedDraftEvaluatorTask = { ...draftEvaluatorTask, points: 4 };
    const updatedReviewFixturesTask = { ...reviewFixturesTask, points: 6 };
    const next = createDb({
      ...sourceData,
      tasks: [updatedDraftEvaluatorTask, shipRuntimeTask, updatedReviewFixturesTask]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta(
        [updatedDraftEvaluatorTask, updatedReviewFixturesTask],
        [draftEvaluatorTask, reviewFixturesTask]
      )]
    });
    const change = singleMaterializationChange(maintained, 'residual-task-owners');

    expect(maintained).toMatchObject({ recomputed: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      rows: [
        { id: 't2', title: 'Ship runtime', owner: 'Ada', points: 8 },
        { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 6 }
      ],
      addedRows: [{ id: 't3', title: 'Review fixtures', owner: 'Bea', points: 6 }],
      removedRows: [{ id: 't1', title: 'Draft evaluator', owner: 'Ada', points: 5 }]
    });
    expect(change.rowChanges).toHaveLength(2);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { id: 't1', title: 'Draft evaluator', owner: 'Ada', points: 5 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 6 }
      })
    ]));
    expect(materializedRowsForQuery(next, residualTaskOwners)).toEqual(change.rows);
  });

  it('falls back to snapshot maintenance for unsupported left joins with an explicit diagnostic', () => {
    const leftUserTeams = leftUserTeamsQuery();
    const state = mat(createDb(sourceData), leftUserTeams, { id: 'left-user-teams', mode: 'incremental' });
    const metadata = materializationForQuery(state, leftUserTeams);

    expect(metadata).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expect(metadata?.maintenanceReason).toContain('left join');
    expect(metadata?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'materialization_incremental_fallback',
        detail: expect.objectContaining({
          reason: expect.stringContaining('left join')
        })
      })
    ]));
    expect(materializedRowsForQuery(state, leftUserTeams)).toEqual([
      { id: 'ada', name: 'Ada', team: 'Engineering' },
      { id: 'bea', name: 'Bea', team: 'Design' },
      { id: 'cal', name: 'Cal', team: undefined }
    ]);
  });

  it('uses provided materialization maintenance output in trackTransact', async () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const next = createDb({ ...sourceData, users: [...sourceData.users, diaUser] });
    const delta = usersDelta([diaUser], []);
    const materializedNext = next as typeof state;
    const materializations = maintainMaterializations(state, materializedNext, { deltas: [delta] });

    const tracked = await trackTransact(state, () => ({
      db: materializedNext,
      deltas: [delta],
      materializations
    }));
    const materializedChange = singleMaterializationChange(materializations, 'active-users');
    const trackedChange = tracked.changes.find((change) => change.id === 'active-users');

    expect(tracked.materializations).toBe(materializations);
    expect(trackedChange).toMatchObject({
      id: 'active-users',
      changed: true,
      rowChanges: materializedChange.rowChanges,
      addedRows: [{ id: 'dia', name: 'Dia', age: 24, teamId: 'eng' }]
    });
  });
});
