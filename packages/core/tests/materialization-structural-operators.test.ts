import { describe, expect, it } from 'vitest';
import {
  aggregate,
  as,
  constRows,
  count,
  createDb,
  desc,
  difference,
  eq,
  expand,
  field,
  from,
  keyBy,
  limit,
  maintainMaterializations,
  mat,
  materializationForQuery,
  materializedRowsForQuery,
  pipe,
  project,
  qRows,
  qualify,
  qualifyRow,
  sort,
  sortLimit,
  sum,
  union,
  intersection,
  value,
  where
} from '@tarstate/core';
import type { MaterializationMaintenanceResult, Query, RelationDelta } from '@tarstate/core';
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

type LiteralRow = {
  readonly id: string;
  readonly label: string;
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

const adaNameTask: TaskRow = {
  id: 'name-ada',
  ownerId: 'ada',
  title: 'Ada',
  done: false,
  points: 1
};

const adaNameTaskDuplicate: TaskRow = {
  id: 'name-ada-duplicate',
  ownerId: 'ada',
  title: 'Ada',
  done: false,
  points: 2
};

const calNameTask: TaskRow = {
  id: 'name-cal',
  ownerId: 'cal',
  title: 'Cal',
  done: false,
  points: 3
};

const diaUser: UserRow = {
  id: 'dia',
  teamId: 'eng',
  name: 'Dia',
  active: true,
  age: 24,
  tags: ['compiler', 'docs']
};

const pinnedRows: readonly LiteralRow[] = [
  { id: 'pin-a', label: 'Pinned A' },
  { id: 'pin-b', label: 'Pinned B' }
];

const metricRows: readonly LiteralMetricRow[] = [
  { id: 'metric-a', team: 'eng', points: 3 },
  { id: 'metric-b', team: 'design', points: 4 },
  { id: 'metric-c', team: 'eng', points: 5 }
];

function activeUserRows(): Query<ActiveUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId })
  ) as Query<ActiveUserRow>;
}

function qualifiedActiveUsersQuery(): Query<QualifiedActiveUserRow> {
  return pipe(
    activeUserRows(),
    qualify('user')
  ) as Query<QualifiedActiveUserRow>;
}

function qualifiedRowActiveUsersQuery(): Query<QualifiedRowActiveUserRow> {
  return pipe(
    activeUserRows(),
    qualifyRow('item')
  ) as Query<QualifiedRowActiveUserRow>;
}

function literalRowsQuery(): Query<LiteralRow> {
  return pipe(
    constRows(pinnedRows),
    keyBy('id')
  ) as Query<LiteralRow>;
}

function literalMetricRollupsQuery(): Query<LiteralMetricRollupRow> {
  const team = field<string>('metric', 'team');
  const points = field<number>('metric', 'points');
  return pipe(
    constRows(metricRows),
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

function topLiteralMetricsQuery(): Query<LiteralMetricRow> {
  const points = field<number>('metric', 'points');
  return pipe(
    constRows(metricRows),
    sortLimit(2, desc(points))
  ) as Query<LiteralMetricRow>;
}

function sortedLimitedLiteralMetricsQuery(): Query<LiteralMetricRow> {
  const points = field<number>('metric', 'points');
  return pipe(
    constRows(metricRows),
    sort(desc(points)),
    limit(2)
  ) as Query<LiteralMetricRow>;
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

function sortedUserNamesQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    sortLimit(1, desc(user.age)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function usersDelta(added: readonly UserRow[], removed: readonly UserRow[]): RelationDelta<typeof coreSchema.users> {
  return { relation: coreSchema.users, added, removed };
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

function expectIncrementalMaintenance(
  result: MaterializationMaintenanceResult | undefined,
  id: string
) {
  if (result === undefined) {
    throw new Error(`missing materialization maintenance result for ${id}`);
  }

  const change = singleMaterializationChange(result, id);
  expect(change).toMatchObject({
    update: 'incremental',
    maintenance: 'incremental',
    recomputed: false
  });
  expectNoIncrementalFallback([...result.diagnostics, ...change.diagnostics]);
  return change;
}

describe('incremental materialization for pure structural operators', () => {
  it('incrementally maintains qualify over supported root query inserts, updates, and deletes', () => {
    const qualifiedUsers = qualifiedActiveUsersQuery();
    const state = mat(createDb(sourceData), qualifiedUsers, {
      id: 'qualified-active-users',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, qualifiedUsers);

    expect(metadata).toMatchObject({
      id: 'qualified-active-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, qualifiedUsers)).toEqual([
      { user: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' } },
      { user: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } }
    ]);

    const insertedState = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    }) as typeof state;
    const inserted = maintainMaterializations(state, insertedState, {
      deltas: [usersDelta([diaUser], [])]
    });
    const insertedChange = expectIncrementalMaintenance(inserted, 'qualified-active-users');

    expect(insertedChange.rows).toEqual([
      { user: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' } },
      { user: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } },
      { user: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' } }
    ]);
    expect(materializedRowsForQuery(insertedState, qualifiedUsers)).toEqual(insertedChange.rows);

    const updatedAda = { ...adaUser, name: 'Ada Lovelace', age: 38 };
    const updatedState = createDb({
      ...sourceData,
      users: [updatedAda, beaUser, calUser, diaUser]
    }) as typeof state;
    const updated = maintainMaterializations(insertedState, updatedState, {
      deltas: [usersDelta([updatedAda], [adaUser])]
    });
    const updatedChange = expectIncrementalMaintenance(updated, 'qualified-active-users');

    expect(updatedChange.rows).toEqual([
      { user: { id: 'ada', name: 'Ada Lovelace', age: 38, teamId: 'eng' } },
      { user: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } },
      { user: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' } }
    ]);
    expect(materializedRowsForQuery(updatedState, qualifiedUsers)).toEqual(updatedChange.rows);

    const deletedState = createDb({
      ...sourceData,
      users: [updatedAda, calUser, diaUser]
    }) as typeof state;
    const deleted = maintainMaterializations(updatedState, deletedState, {
      deltas: [usersDelta([], [beaUser])]
    });
    const deletedChange = expectIncrementalMaintenance(deleted, 'qualified-active-users');

    expect(deletedChange.rows).toEqual([
      { user: { id: 'ada', name: 'Ada Lovelace', age: 38, teamId: 'eng' } },
      { user: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' } }
    ]);
    expect(materializedRowsForQuery(deletedState, qualifiedUsers)).toEqual(deletedChange.rows);
  });

  it('builds qualifyRow materializations incrementally without fallback', () => {
    const qualifiedRows = qualifiedRowActiveUsersQuery();
    const state = mat(createDb(sourceData), qualifiedRows, {
      id: 'qualified-row-active-users',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, qualifiedRows);

    expect(metadata).toMatchObject({
      id: 'qualified-row-active-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, qualifiedRows)).toEqual([
      { item: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' } },
      { item: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } }
    ]);
  });

  it('builds constRows materializations incrementally and skips unrelated deltas unchanged', () => {
    const literalRows = literalRowsQuery();
    const state = mat(createDb(sourceData), literalRows, {
      id: 'literal-rows',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, literalRows);

    expect(metadata).toMatchObject({
      id: 'literal-rows',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: []
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, literalRows)).toEqual(pinnedRows);

    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    }) as typeof state;
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([diaUser], [])]
    });
    const change = singleMaterializationChange(maintained, 'literal-rows');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 1 });
    expect(change).toMatchObject({
      update: 'skipped',
      maintenance: 'incremental',
      recomputed: false,
      dependencies: [],
      touchedDependencies: [],
      rows: pinnedRows,
      addedRows: [],
      removedRows: [],
      rowChanges: []
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(materializedRowsForQuery(next, literalRows)).toEqual(pinnedRows);
  });

  it('builds constRows aggregate materializations incrementally and skips unrelated deltas unchanged', () => {
    const literalRollups = literalMetricRollupsQuery();
    const state = mat(createDb(sourceData), literalRollups, {
      id: 'literal-rollups',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, literalRollups);

    expect(metadata).toMatchObject({
      id: 'literal-rollups',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: []
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, literalRollups)).toEqual([
      { team: 'eng', items: 2, points: 8 },
      { team: 'design', items: 1, points: 4 }
    ]);

    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    }) as typeof state;
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([diaUser], [])]
    });
    const change = singleMaterializationChange(maintained, 'literal-rollups');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 1 });
    expect(change).toMatchObject({
      update: 'skipped',
      maintenance: 'incremental',
      recomputed: false,
      dependencies: [],
      touchedDependencies: [],
      rows: [
        { team: 'eng', items: 2, points: 8 },
        { team: 'design', items: 1, points: 4 }
      ],
      addedRows: [],
      removedRows: [],
      rowChanges: []
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(materializedRowsForQuery(next, literalRollups)).toEqual(change.rows);
  });

  it('builds constRows sortLimit materializations incrementally with static row order', () => {
    const topMetrics = topLiteralMetricsQuery();
    const state = mat(createDb(sourceData), topMetrics, {
      id: 'top-literal-metrics',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, topMetrics);

    expect(metadata).toMatchObject({
      id: 'top-literal-metrics',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: []
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, topMetrics)).toEqual([
      { id: 'metric-c', team: 'eng', points: 5 },
      { id: 'metric-b', team: 'design', points: 4 }
    ]);

    const sortedLimitedMetrics = sortedLimitedLiteralMetricsQuery();
    const sortedLimitedState = mat(createDb(sourceData), sortedLimitedMetrics, {
      id: 'sorted-limited-literal-metrics',
      mode: 'incremental'
    });
    const sortedLimitedMetadata = materializationForQuery(sortedLimitedState, sortedLimitedMetrics);

    expect(sortedLimitedMetadata).toMatchObject({
      id: 'sorted-limited-literal-metrics',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: []
    });
    expectNoIncrementalFallback(sortedLimitedMetadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(sortedLimitedState, sortedLimitedMetrics)).toEqual([
      { id: 'metric-c', team: 'eng', points: 5 },
      { id: 'metric-b', team: 'design', points: 4 }
    ]);
  });

  it('incrementally maintains expand output rows affected by root inserts, updates, and deletes', () => {
    const userTags = expandedUserTagsQuery();
    const state = mat(createDb(sourceData), userTags, {
      id: 'expanded-user-tags',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, userTags);

    expect(metadata).toMatchObject({
      id: 'expanded-user-tags',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, userTags)).toEqual([
      { id: 'ada', tag: 'compiler' },
      { id: 'ada', tag: 'runtime' },
      { id: 'bea', tag: 'research' }
    ]);

    const updatedAda = { ...adaUser, tags: ['compiler', 'logic'] };
    const next = createDb({
      ...sourceData,
      users: [updatedAda, calUser, diaUser]
    }) as typeof state;
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda, diaUser], [adaUser, beaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'expanded-user-tags');

    expect(change.rows).toEqual([
      { id: 'ada', tag: 'compiler' },
      { id: 'ada', tag: 'logic' },
      { id: 'dia', tag: 'compiler' },
      { id: 'dia', tag: 'docs' }
    ]);
    expect(change.addedRows).toEqual([
      { id: 'ada', tag: 'logic' },
      { id: 'dia', tag: 'compiler' },
      { id: 'dia', tag: 'docs' }
    ]);
    expect(change.removedRows).toEqual([
      { id: 'ada', tag: 'runtime' },
      { id: 'bea', tag: 'research' }
    ]);
    expect(change.rowChanges).toHaveLength(5);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 'ada', tag: 'runtime' } }),
      expect.objectContaining({ kind: 'removed', row: { id: 'bea', tag: 'research' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'ada', tag: 'logic' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'dia', tag: 'compiler' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'dia', tag: 'docs' } })
    ]));
    expect(materializedRowsForQuery(next, userTags)).toEqual(change.rows);
  });

  it.each([
    {
      name: 'union',
      id: 'dynamic-set-union',
      query: () => union(userNamesQuery(), taskOwnerNamesQuery())
    },
    {
      name: 'intersection',
      id: 'dynamic-set-intersection',
      query: () => intersection(userNamesQuery(), taskOwnerNamesQuery())
    },
    {
      name: 'difference',
      id: 'dynamic-set-difference',
      query: () => difference(userNamesQuery(), taskOwnerNamesQuery())
    }
  ])('plans dynamic $name over supported branches incrementally', ({ id, query }) => {
    const setQuery = query();
    const state = mat(createDb(sourceData), setQuery, { id, mode: 'incremental' });
    const metadata = materializationForQuery(state, setQuery);

    expect(metadata).toMatchObject({
      id,
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['users', 'tasks']));
    expect(metadata?.dependencies).toHaveLength(2);
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
  });

  it('incrementally maintains dynamic union across both branch deltas', () => {
    const setQuery = union(userNamesQuery(), taskOwnerNamesQuery());
    const initial = createDb({ ...sourceData, tasks: [adaNameTask] });
    const state = mat(initial, setQuery, { id: 'dynamic-union-deltas', mode: 'incremental' });

    expect(materializedRowsForQuery(state, setQuery)).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);

    const insertedTaskState = createDb({ ...sourceData, tasks: [adaNameTask, calNameTask] }) as typeof state;
    const insertedTask = maintainMaterializations(state, insertedTaskState, {
      deltas: [tasksDelta([calNameTask], [])]
    });
    const insertedTaskChange = expectIncrementalMaintenance(insertedTask, 'dynamic-union-deltas');

    expect(insertedTaskChange.rows).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' },
      { id: 'cal', name: 'Cal' }
    ]);

    const inactiveAda = { ...adaUser, active: false };
    const inactiveUserState = createDb({
      ...sourceData,
      users: [inactiveAda, beaUser, calUser],
      tasks: [adaNameTask, calNameTask]
    }) as typeof state;
    const inactiveUser = maintainMaterializations(insertedTaskState, inactiveUserState, {
      deltas: [usersDelta([inactiveAda], [adaUser])]
    });
    const inactiveUserChange = expectIncrementalMaintenance(inactiveUser, 'dynamic-union-deltas');

    expect(inactiveUserChange.rows).toEqual([
      { id: 'bea', name: 'Bea' },
      { id: 'ada', name: 'Ada' },
      { id: 'cal', name: 'Cal' }
    ]);

    const deletedTaskState = createDb({
      ...sourceData,
      users: [inactiveAda, beaUser, calUser],
      tasks: [calNameTask]
    }) as typeof state;
    const deletedTask = maintainMaterializations(inactiveUserState, deletedTaskState, {
      deltas: [tasksDelta([], [adaNameTask])]
    });
    const deletedTaskChange = expectIncrementalMaintenance(deletedTask, 'dynamic-union-deltas');

    expect(deletedTaskChange.rows).toEqual([
      { id: 'bea', name: 'Bea' },
      { id: 'cal', name: 'Cal' }
    ]);
    expect(materializedRowsForQuery(deletedTaskState, setQuery)).toEqual(deletedTaskChange.rows);
  });

  it('incrementally maintains dynamic intersection with duplicate right contributors', () => {
    const setQuery = intersection(userNamesQuery(), taskOwnerNamesQuery());
    const initial = createDb({ ...sourceData, tasks: [adaNameTask, adaNameTaskDuplicate] });
    const state = mat(initial, setQuery, { id: 'dynamic-intersection-duplicates', mode: 'incremental' });

    expect(materializedRowsForQuery(state, setQuery)).toEqual([{ id: 'ada', name: 'Ada' }]);

    const oneDuplicateState = createDb({ ...sourceData, tasks: [adaNameTaskDuplicate] }) as typeof state;
    const oneDuplicate = maintainMaterializations(state, oneDuplicateState, {
      deltas: [tasksDelta([], [adaNameTask])]
    });
    const oneDuplicateChange = expectIncrementalMaintenance(oneDuplicate, 'dynamic-intersection-duplicates');

    expect(oneDuplicateChange.rows).toEqual([{ id: 'ada', name: 'Ada' }]);
    expect(oneDuplicateChange.addedRows).toEqual([]);
    expect(oneDuplicateChange.removedRows).toEqual([]);

    const noDuplicateState = createDb({ ...sourceData, tasks: [] }) as typeof state;
    const noDuplicate = maintainMaterializations(oneDuplicateState, noDuplicateState, {
      deltas: [tasksDelta([], [adaNameTaskDuplicate])]
    });
    const noDuplicateChange = expectIncrementalMaintenance(noDuplicate, 'dynamic-intersection-duplicates');

    expect(noDuplicateChange.rows).toEqual([]);
    expect(noDuplicateChange.removedRows).toEqual([{ id: 'ada', name: 'Ada' }]);

    const activeCal = { ...calUser, active: true };
    const activeInsertedState = createDb({
      ...sourceData,
      users: [adaUser, beaUser, activeCal],
      tasks: [calNameTask]
    }) as typeof state;
    const activeInserted = maintainMaterializations(noDuplicateState, activeInsertedState, {
      deltas: [
        usersDelta([activeCal], [calUser]),
        tasksDelta([calNameTask], [])
      ]
    });
    const activeInsertedChange = expectIncrementalMaintenance(activeInserted, 'dynamic-intersection-duplicates');

    expect(activeInsertedChange.rows).toEqual([{ id: 'cal', name: 'Cal' }]);
    expect(activeInsertedChange.addedRows).toEqual([{ id: 'cal', name: 'Cal' }]);
    expect(materializedRowsForQuery(activeInsertedState, setQuery)).toEqual(activeInsertedChange.rows);
  });

  it('incrementally maintains dynamic difference when the right branch inserts and deletes', () => {
    const setQuery = difference(userNamesQuery(), taskOwnerNamesQuery());
    const initial = createDb({ ...sourceData, tasks: [adaNameTask] });
    const state = mat(initial, setQuery, { id: 'dynamic-difference-right-deltas', mode: 'incremental' });

    expect(materializedRowsForQuery(state, setQuery)).toEqual([{ id: 'bea', name: 'Bea' }]);

    const deletedRightState = createDb({ ...sourceData, tasks: [] }) as typeof state;
    const deletedRight = maintainMaterializations(state, deletedRightState, {
      deltas: [tasksDelta([], [adaNameTask])]
    });
    const deletedRightChange = expectIncrementalMaintenance(deletedRight, 'dynamic-difference-right-deltas');

    expect(deletedRightChange.rows).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);
    expect(deletedRightChange.addedRows).toEqual([{ id: 'ada', name: 'Ada' }]);

    const inactiveBea = { ...beaUser, active: false };
    const inactiveLeftState = createDb({
      ...sourceData,
      users: [adaUser, inactiveBea, calUser],
      tasks: []
    }) as typeof state;
    const inactiveLeft = maintainMaterializations(deletedRightState, inactiveLeftState, {
      deltas: [usersDelta([inactiveBea], [beaUser])]
    });
    const inactiveLeftChange = expectIncrementalMaintenance(inactiveLeft, 'dynamic-difference-right-deltas');

    expect(inactiveLeftChange.rows).toEqual([{ id: 'ada', name: 'Ada' }]);
    expect(inactiveLeftChange.removedRows).toEqual([{ id: 'bea', name: 'Bea' }]);

    const insertedRightState = createDb({
      ...sourceData,
      users: [adaUser, inactiveBea, calUser],
      tasks: [adaNameTask]
    }) as typeof state;
    const insertedRight = maintainMaterializations(inactiveLeftState, insertedRightState, {
      deltas: [tasksDelta([adaNameTask], [])]
    });
    const insertedRightChange = expectIncrementalMaintenance(insertedRight, 'dynamic-difference-right-deltas');

    expect(insertedRightChange.rows).toEqual([]);
    expect(insertedRightChange.removedRows).toEqual([{ id: 'ada', name: 'Ada' }]);
    expect(materializedRowsForQuery(insertedRightState, setQuery)).toEqual(insertedRightChange.rows);
  });

  it('falls back when a dynamic set has duplicate final row keys after keyBy', () => {
    const setQuery = pipe(
      union(userNamesQuery(), taskOwnerCollisionNamesQuery()),
      keyBy('id')
    ) as Query<UserNameRow>;
    const state = mat(createDb(sourceData), setQuery, {
      id: 'dynamic-set-final-key-collision',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, setQuery);

    expect(metadata).toMatchObject({
      id: 'dynamic-set-final-key-collision',
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expect(metadata?.maintenanceReason).toContain('duplicate');
    expectIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, setQuery)).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' },
      { id: 'ada', name: 'Task' },
      { id: 'bea', name: 'Task' }
    ]);
  });

  it.each([
    {
      name: 'union',
      id: 'set-union-unsupported-branch',
      query: () => union(userNamesQuery(), sortedUserNamesQuery()),
      expected: [
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' },
        { id: 'cal', name: 'Cal' }
      ]
    },
    {
      name: 'intersection',
      id: 'set-intersection-unsupported-branch',
      query: () => intersection(userNamesQuery(), sortedUserNamesQuery()),
      expected: []
    },
    {
      name: 'difference',
      id: 'set-difference-unsupported-branch',
      query: () => difference(userNamesQuery(), sortedUserNamesQuery()),
      expected: [
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' }
      ]
    }
  ])('keeps fallback diagnostics for $name with an unsupported branch shape', async ({ id, query, expected }) => {
    const setQuery = query();
    const state = mat(createDb(sourceData), setQuery, { id, mode: 'incremental' });
    const metadata = materializationForQuery(state, setQuery);

    expect(metadata).toMatchObject({
      id,
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expectIncrementalFallback(metadata?.diagnostics ?? []);
    expect(metadata?.maintenanceReason).toMatch(/not supported|sortLimit/);
    await expect(qRows(state, setQuery)).resolves.toEqual(expected);
  });
});
