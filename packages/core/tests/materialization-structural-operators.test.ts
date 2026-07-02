import { describe, expect, it } from 'vitest';
import {
  aggregate,
  as,
  constRows,
  count,
  createDb,
  difference,
  eq,
  expand,
  field,
  from,
  intersection,
  keyBy,
  maintainMaterializations,
  mat,
  materializedRowsForQuery,
  pipe,
  project,
  qRows,
  qualify,
  sum,
  union,
  value,
  where
} from '@tarstate/core';
import type { Db, MaterializationMaintenanceResult, Query, RelationDelta } from '@tarstate/core';
import {
  adaUser,
  beaUser,
  calUser,
  coreSchema,
  sourceData,
  type TaskRow,
  type UserRow
} from './fixtures';

type ActiveUserRow = {
  readonly id: string;
  readonly name: string;
  readonly age: number;
  readonly teamId: string;
};

type QualifiedActiveUserRow = {
  readonly user: ActiveUserRow;
};

type QualifiedRowActiveUserRow = {
  readonly item: ActiveUserRow;
};

type LiteralMetricRow = {
  readonly id: string;
  readonly team: string;
  readonly points: number;
};

type LiteralMetricRollupRow = {
  readonly team: string;
  readonly items: number;
  readonly points: number;
};

type UserTagRow = {
  readonly id: string;
  readonly tag: string;
};

type UserNameRow = {
  readonly id: string;
  readonly name: string;
};

const pinnedMetrics: readonly LiteralMetricRow[] = [
  { id: 'metric-a', team: 'eng', points: 3 },
  { id: 'metric-b', team: 'design', points: 4 },
  { id: 'metric-c', team: 'eng', points: 5 }
];

const diaUser: UserRow = {
  id: 'dia',
  teamId: 'eng',
  name: 'Dia',
  active: true,
  age: 24,
  tags: ['compiler', 'docs']
};

const adaNameTask: TaskRow = {
  id: 'name-ada',
  ownerId: 'ada',
  title: 'Ada',
  done: false,
  points: 1
};

const calNameTask: TaskRow = {
  id: 'name-cal',
  ownerId: 'cal',
  title: 'Cal',
  done: false,
  points: 3
};

function activeUserRows(): Query<ActiveUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId })
  ) as Query<ActiveUserRow>;
}

function qualifiedActiveUsersQuery(): Query<QualifiedActiveUserRow> {
  return pipe(activeUserRows(), qualify('user')) as Query<QualifiedActiveUserRow>;
}

function qualifiedRowActiveUsersQuery(): Query<QualifiedRowActiveUserRow> {
  return pipe(activeUserRows(), qualify('item')) as Query<QualifiedRowActiveUserRow>;
}

function literalMetricRollupsQuery(): Query<LiteralMetricRollupRow> {
  const team = field<string>('metric', 'team');
  const points = field<number>('metric', 'points');
  return pipe(
    constRows(pinnedMetrics),
    aggregate({
      groupBy: { team },
      aggregates: {
        items: count(),
        points: sum(points)
      }
    }),
    keyBy('team')
  ) as Query<LiteralMetricRollupRow>;
}

function expandedUserTagsQuery(): Query<UserTagRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    expand(user.tags, { as: 'tag' }),
    project({ id: user.id, tag: field<string>('tag', 'tag') }),
    keyBy('id', 'tag')
  ) as Query<UserTagRow>;
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

function taskOwnerNamesQuery(): Query<UserNameRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    where(eq(task.done, false)),
    project({ id: task.ownerId, name: task.title }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function taskOwnerCollisionNamesQuery(): Query<UserNameRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    where(eq(task.done, false)),
    project({ id: task.ownerId, name: value('Task') })
  ) as Query<UserNameRow>;
}

function usersDelta(added: readonly UserRow[], removed: readonly UserRow[]): RelationDelta<typeof coreSchema.users> {
  return { relation: coreSchema.users, added, removed };
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

describe('materialized structural operators', () => {
  it('keeps qualify and qualify materialized rows in parity with qRows', async () => {
    const qualified = qualifiedActiveUsersQuery();
    const qualifiedState = mat(createDb(sourceData), qualified, { id: 'qualified-active-users' });
    await expectMaterializedRowsMatchQRows(qualifiedState, qualified);

    const qualifiedNext = createDb({ ...sourceData, users: [...sourceData.users, diaUser] });
    const qualifiedMaintained = maintainMaterializations(qualifiedState, qualifiedNext, {
      deltas: [usersDelta([diaUser], [])]
    });
    const qualifiedChange = singleMaterializationChange<QualifiedActiveUserRow>(
      qualifiedMaintained,
      'qualified-active-users'
    );

    expect(qualifiedChange.rows).toEqual(await qRows(qualifiedNext, qualified));
    expect(materializedRowsForQuery(qualifiedNext, qualified)).toEqual(qualifiedChange.rows);

    const qualifiedRow = qualifiedRowActiveUsersQuery();
    const qualifiedRowState = mat(createDb(sourceData), qualifiedRow, { id: 'qualified-row-active-users' });
    await expectMaterializedRowsMatchQRows(qualifiedRowState, qualifiedRow);

    const qualifiedRowNext = createDb({ ...sourceData, users: [...sourceData.users, diaUser] });
    const qualifiedRowMaintained = maintainMaterializations(qualifiedRowState, qualifiedRowNext, {
      deltas: [usersDelta([diaUser], [])]
    });
    const qualifiedRowChange = singleMaterializationChange<QualifiedRowActiveUserRow>(
      qualifiedRowMaintained,
      'qualified-row-active-users'
    );

    expect(qualifiedRowChange.rows).toEqual(await qRows(qualifiedRowNext, qualifiedRow));
    expect(materializedRowsForQuery(qualifiedRowNext, qualifiedRow)).toEqual(qualifiedRowChange.rows);
  });

  it('keeps constRows aggregate materializations stable across unrelated deltas', async () => {
    const rollups = literalMetricRollupsQuery();
    const state = mat(createDb(sourceData), rollups, { id: 'literal-rollups' });

    expect(materializedRowsForQuery(state, rollups)).toEqual([
      { team: 'eng', items: 2, points: 8 },
      { team: 'design', items: 1, points: 4 }
    ]);

    const next = createDb({ ...sourceData, users: [...sourceData.users, diaUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([diaUser], [])]
    });
    const change = singleMaterializationChange<LiteralMetricRollupRow>(maintained, 'literal-rollups');

    expect(change.rows).toEqual(await qRows(next, rollups));
    expect(change.added).toEqual([]);
    expect(change.removed).toEqual([]);
    expect(materializedRowsForQuery(next, rollups)).toEqual(change.rows);
  });

  it('reports expanded row additions and removals from changed source arrays', async () => {
    const tags = expandedUserTagsQuery();
    const state = mat(createDb(sourceData), tags, { id: 'expanded-user-tags' });
    const updatedAda = { ...adaUser, tags: ['compiler', 'logic'] };
    const next = createDb({ ...sourceData, users: [updatedAda, calUser, diaUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda, diaUser], [adaUser, beaUser])]
    });
    const change = singleMaterializationChange<UserTagRow>(maintained, 'expanded-user-tags');

    expect(change.rows).toEqual(await qRows(next, tags));
    expect(change.added).toEqual(expect.arrayContaining([
      { id: 'ada', tag: 'logic' },
      { id: 'dia', tag: 'compiler' },
      { id: 'dia', tag: 'docs' }
    ]));
    expect(change.removed).toEqual(expect.arrayContaining([
      { id: 'ada', tag: 'runtime' },
      { id: 'bea', tag: 'research' }
    ]));
    expect(materializedRowsForQuery(next, tags)).toEqual(change.rows);
  });

  it('keeps union, intersection, and difference rows correct for both branch changes', async () => {
    const cases = [
      { id: 'dynamic-set-union', query: union(userNamesQuery(), taskOwnerNamesQuery()) as Query<UserNameRow> },
      {
        id: 'dynamic-set-intersection',
        query: intersection(userNamesQuery(), taskOwnerNamesQuery()) as Query<UserNameRow>
      },
      {
        id: 'dynamic-set-difference',
        query: difference(userNamesQuery(), taskOwnerCollisionNamesQuery()) as Query<UserNameRow>
      }
    ];
    const initial = createDb({ ...sourceData, tasks: [adaNameTask] });
    const next = createDb({ ...sourceData, tasks: [adaNameTask, calNameTask] });

    for (const { id, query } of cases) {
      const state = mat(initial, query, { id });
      const maintained = maintainMaterializations(state, next, {
        deltas: [tasksDelta([calNameTask], [])]
      });
      const change = singleMaterializationChange<UserNameRow>(maintained, id);

      expect(change.rows).toEqual(await qRows(next, query));
      expect(materializedRowsForQuery(next, query)).toEqual(change.rows);
    }
  });
});
