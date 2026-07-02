import { describe, expect, it } from 'vitest';
import {
  aggregate,
  and,
  asc,
  as,
  avg,
  bottomBy,
  btree,
  call,
  count,
  countDistinct,
  constRows,
  createDb,
  deleteByKey,
  desc,
  difference,
  eq,
  env,
  extend,
  expand,
  field,
  from,
  gt,
  hash,
  any as anyAggregate,
  insert,
  index,
  intersection,
  join,
  keyBy,
  leftJoin,
  limit,
  maintainMaterializations,
  mat,
  materializationForQuery,
  materializedRowsForQuery,
  max,
  maxBy,
  maybe,
  min,
  minBy,
  neq,
  notAny,
  pipe,
  project,
  qualify,
  qRows,
  rename,
  sel,
  sel1,
  setConcat,
  sort,
  sortLimit,
  sum,
  trackTransact,
  transact,
  topBy,
  union,
  uniqueIndex,
  updateWhere,
  updateEnv,
  value,
  watch,
  where,
  withEnv,
  without
} from '@tarstate/core';
import type { MaterializationMaintenanceResult, Query, RelationDelta, WatchEvent } from '@tarstate/core';
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

type MinimumAgeUserRow = {
  readonly id: string;
  readonly name: string;
  readonly minimumAge: number | undefined;
};

type UserTeamRow = {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly rank: number;
};

type UserTeammateRow = {
  readonly employeeId: string;
  readonly teammateId: string;
  readonly employee: string;
  readonly teammate: string;
  readonly teamId: string;
};

type UserAgeRow = {
  readonly id: string;
  readonly name: string;
  readonly age: number;
};

type UserAgeBandRow = {
  readonly id: string;
  readonly band: string;
};

type UserAgeDecadeRollupRow = {
  readonly decade: number;
  readonly users: number;
  readonly activeUsers: number;
};

type UserNameRow = {
  readonly id: string;
  readonly name: string;
};

type UserOpenTasksTeamRow = {
  readonly id: string;
  readonly name: string;
  readonly openTasks: readonly { readonly title: string }[];
  readonly team: { readonly name: string } | undefined;
};

type UserRankRow = {
  readonly id: string;
  readonly rank: number | undefined;
};

type MaybeUserTeamRow = {
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

type SortedTaskRow = {
  readonly id: string;
  readonly title: string;
  readonly points: number;
};

type TaskProjectRollupRow = {
  readonly projectId: string;
  readonly tasks: number;
  readonly points: number;
  readonly averagePoints: number;
};

type TaskOwnerRollupRow = {
  readonly ownerId: string;
  readonly tasks: number;
  readonly points: number;
};

type TaskOwnerInfoRollupRow = TaskOwnerRollupRow & {
  readonly owner: string;
  readonly team: string;
};

type TaskOwnerMaybeInfoRollupRow = TaskOwnerRollupRow & {
  readonly owner: string | undefined;
};

type TaskProjectStatsRow = TaskProjectRollupRow & {
  readonly minPoints: number;
  readonly maxPoints: number;
};

type RankedTask = {
  readonly task: TaskRow;
};

type TaskProjectRankingRow = {
  readonly projectId: string;
  readonly topTasks: readonly RankedTask[];
  readonly bottomTasks: readonly RankedTask[];
  readonly maxTask: RankedTask | undefined;
  readonly minTask: RankedTask | undefined;
  readonly topTask: readonly RankedTask[];
  readonly bottomTask: readonly RankedTask[];
};

type TaskProjectRankingSummary = {
  readonly projectId: string;
  readonly top: readonly string[];
  readonly bottom: readonly string[];
  readonly max: string | undefined;
  readonly min: string | undefined;
  readonly topOne: readonly string[];
  readonly bottomOne: readonly string[];
};

type TeamUserFacetRow = {
  readonly teamId: string;
  readonly anyActive: boolean;
  readonly noneActive: boolean;
  readonly distinctNames: number;
  readonly tags: ReadonlySet<string>;
};

type TaskOwnerTeamRow = {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly owner: string;
  readonly teamId: string;
  readonly team: string;
  readonly points: number;
};

type TaskOwnerTagRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly tag: string;
};

type TaskActiveOwnerRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
};

type UserTopTaskRow = {
  readonly ownerId: string;
  readonly owner: string;
  readonly taskId: string;
  readonly title: string;
  readonly points: number;
};

type UserTaskRollupRow = {
  readonly ownerId: string;
  readonly owner: string;
  readonly taskCount: number;
  readonly totalPoints: number;
};

type TaskNestedOwnerTeamRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly owner: string;
  readonly team: string;
};

type JoinedTaskOwnerTeamRollupRow = {
  readonly teamId: string;
  readonly tasks: number;
  readonly points: number;
  readonly averagePoints: number;
};

type LeftJoinedUserTeamRollupRow = {
  readonly teamId: string;
  readonly users: number;
  readonly matchedTeams: number;
};

type JoinedTaskOwnerRow = {
  readonly task: TaskRow;
  readonly owner: UserRow;
};

type JoinedTaskOwnerWinnerRow = {
  readonly teamId: string;
  readonly maxTask: JoinedTaskOwnerRow | undefined;
  readonly topTask: readonly JoinedTaskOwnerRow[];
};

type JoinedTaskOwnerWinnerSummary = {
  readonly teamId: string;
  readonly maxTask: string | undefined;
  readonly maxOwner: string | undefined;
  readonly topTask: readonly string[];
  readonly topOwner: readonly string[];
};

type LargeCoreData = {
  readonly teams: readonly TeamRow[];
  readonly users: readonly UserRow[];
  readonly tasks: readonly TaskRow[];
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

function minimumAgeUsersQuery(): Query<MinimumAgeUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(gt(user.age, env<number>('minimumAge'))),
    project({ id: user.id, name: user.name, minimumAge: env<number>('minimumAge') }),
    keyBy('id')
  ) as Query<MinimumAgeUserRow>;
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

function userTeammatesByTeamQuery(): Query<UserTeammateRow> {
  const employee = as(coreSchema.users, 'employee');
  const teammate = as(coreSchema.users, 'teammate');
  return pipe(
    from(employee),
    join(from(teammate), eq(employee.teamId, teammate.teamId)),
    project({
      employeeId: employee.id,
      teammateId: teammate.id,
      employee: employee.name,
      teammate: teammate.name,
      teamId: employee.teamId
    }),
    keyBy('employeeId', 'teammateId')
  ) as Query<UserTeammateRow>;
}

function sameAliasUserSelfJoinQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  const sameUser = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    join(from(sameUser), eq(user.teamId, sameUser.teamId)),
    project({ id: user.id, name: user.name })
  ) as Query<UserNameRow>;
}

function leftUserTeamsQuery(): Query<MaybeUserTeamRow> {
  const user = as(coreSchema.users, 'user');
  const team = as(coreSchema.teams, 'team');
  return pipe(
    from(user),
    leftJoin(from(team), eq(user.teamId, team.id)),
    project({ id: user.id, name: user.name, team: maybe(team.name), rank: maybe(team.rank) }),
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

function taskProjectRollupsQuery(): Query<TaskProjectRollupRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    aggregate({
      groupBy: { projectId: task.ownerId },
      aggregates: {
        tasks: count(),
        points: sum(task.points),
        averagePoints: avg(task.points)
      }
    }),
    keyBy('projectId')
  ) as Query<TaskProjectRollupRow>;
}

function taskProjectStatsQuery(): Query<TaskProjectStatsRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    aggregate({
      groupBy: { projectId: task.ownerId },
      aggregates: {
        tasks: count(),
        points: sum(task.points),
        averagePoints: avg(task.points),
        minPoints: min(task.points),
        maxPoints: max(task.points)
      }
    }),
    keyBy('projectId')
  ) as Query<TaskProjectStatsRow>;
}

function taskProjectRankingsQuery(): Query<TaskProjectRankingRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    aggregate({
      groupBy: { projectId: task.ownerId },
      aggregates: {
        topTasks: topBy<RankedTask>(2, task.points),
        bottomTasks: bottomBy<RankedTask>(2, task.points),
        maxTask: maxBy<RankedTask>(task.points),
        minTask: minBy<RankedTask>(task.points),
        topTask: topBy<RankedTask>(1, task.points),
        bottomTask: bottomBy<RankedTask>(1, task.points)
      }
    }),
    keyBy('projectId')
  ) as Query<TaskProjectRankingRow>;
}

function teamUserFacetsQuery(): Query<TeamUserFacetRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    aggregate({
      groupBy: { teamId: user.teamId },
      aggregates: {
        anyActive: anyAggregate(user.active),
        noneActive: notAny(user.active),
        distinctNames: countDistinct(user.name),
        tags: setConcat(user.tags)
      }
    }),
    keyBy('teamId')
  ) as Query<TeamUserFacetRow>;
}

function taskOwnerTeamQuery(): Query<TaskOwnerTeamRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  const team = as(coreSchema.teams, 'team');
  return pipe(
    from(task),
    join(from(owner), eq(task.ownerId, owner.id)),
    join(from(team), eq(owner.teamId, team.id)),
    project({
      id: task.id,
      title: task.title,
      ownerId: owner.id,
      owner: owner.name,
      teamId: team.id,
      team: team.name,
      points: task.points
    }),
    keyBy('id')
  ) as Query<TaskOwnerTeamRow>;
}

function taskOwnerTagsViaRightExpandQuery(): Query<TaskOwnerTagRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  const branchOwnerId = field<string>('ownerTag', 'ownerId');
  const branchTag = field<string>('ownerTag', 'tag');
  const tag = field<string>('tag', 'tag');
  const ownerTags = pipe(
    from(owner),
    expand(owner.tags, { as: 'tag' }),
    project({ ownerId: owner.id, tag })
  );

  return pipe(
    from(task),
    join(ownerTags, eq(task.ownerId, branchOwnerId)),
    project({ id: task.id, ownerId: task.ownerId, tag: branchTag }),
    keyBy('id', 'tag')
  ) as Query<TaskOwnerTagRow>;
}

function taskActiveOwnersViaRightStaticFilterQuery(): Query<TaskActiveOwnerRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  const branchOwnerId = field<string>('activeOwner', 'ownerId');
  const activeOwnerIds = pipe(
    from(owner),
    where(eq(owner.active, true)),
    project({ ownerId: owner.id })
  );
  const allowedOwnerIds = constRows([
    { ownerId: 'ada' },
    { ownerId: 'bea' },
    { ownerId: 'cal' }
  ]);
  const blockedOwnerIds = constRows([{ ownerId: 'bea' }]);
  const activeAllowedOwnerIds = difference(
    intersection(activeOwnerIds, allowedOwnerIds),
    blockedOwnerIds
  );

  return pipe(
    from(task),
    join(activeAllowedOwnerIds, eq(task.ownerId, branchOwnerId)),
    project({ id: task.id, ownerId: task.ownerId, title: task.title }),
    keyBy('id')
  ) as Query<TaskActiveOwnerRow>;
}

function usersWithTaskRollupsRightAggregateQuery(): Query<UserTaskRollupRow> {
  const owner = as(coreSchema.users, 'owner');
  const task = as(coreSchema.tasks, 'task');
  const aggregateOwnerId = field<string>('taskRollup', 'ownerId');
  const aggregateTasks = field<number>('taskRollup', 'tasks');
  const aggregatePoints = field<number>('taskRollup', 'points');
  const rollupOwnerId = field<string>('rollup', 'ownerId');
  const rollupTaskCount = field<number>('rollup', 'taskCount');
  const rollupTotalPoints = field<number>('rollup', 'totalPoints');
  const taskRollups = pipe(
    from(task),
    aggregate({
      groupBy: { ownerId: task.ownerId },
      aggregates: {
        tasks: count(),
        points: sum(task.points)
      }
    }),
    project({ ownerId: aggregateOwnerId, tasks: aggregateTasks, points: aggregatePoints }),
    extend({ label: value('task-rollup') }),
    without('label'),
    rename({ tasks: 'taskCount', points: 'totalPoints' }),
    qualify('rollup')
  );

  return pipe(
    from(owner),
    join(taskRollups, eq(owner.id, rollupOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskCount: rollupTaskCount,
      totalPoints: rollupTotalPoints
    }),
    keyBy('ownerId')
  ) as Query<UserTaskRollupRow>;
}

function usersWithSortedTaskRollupsRightAggregateQuery(): Query<UserTaskRollupRow> {
  const owner = as(coreSchema.users, 'owner');
  const task = as(coreSchema.tasks, 'task');
  const branchOwnerId = field<string>('taskRollup', 'ownerId');
  const branchTaskCount = field<number>('taskRollup', 'taskCount');
  const branchTotalPoints = field<number>('taskRollup', 'totalPoints');
  const taskRollups = pipe(
    from(task),
    sortLimit(2, desc(task.points), asc(task.id)),
    aggregate({
      groupBy: { ownerId: task.ownerId },
      aggregates: {
        taskCount: count(),
        totalPoints: sum(task.points)
      }
    })
  );

  return pipe(
    from(owner),
    join(taskRollups, eq(owner.id, branchOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskCount: branchTaskCount,
      totalPoints: branchTotalPoints
    }),
    keyBy('ownerId')
  ) as Query<UserTaskRollupRow>;
}

function usersWithGlobalTopTasksRightSortLimitQuery(count = 2): Query<UserTopTaskRow> {
  const owner = as(coreSchema.users, 'owner');
  const task = as(coreSchema.tasks, 'task');
  const branchOwnerId = field<string>('topTask', 'ownerId');
  const branchTaskId = field<string>('topTask', 'taskId');
  const branchTitle = field<string>('topTask', 'title');
  const branchPoints = field<number>('topTask', 'points');
  const topTasks = pipe(
    from(task),
    sortLimit(count, desc(task.points), asc(task.id)),
    project({ ownerId: task.ownerId, taskId: task.id, title: task.title, points: task.points })
  );

  return pipe(
    from(owner),
    join(topTasks, eq(owner.id, branchOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskId: branchTaskId,
      title: branchTitle,
      points: branchPoints
    }),
    keyBy('ownerId', 'taskId')
  ) as Query<UserTopTaskRow>;
}

function usersWithSortedTasksRightBranchQuery(): Query<UserTopTaskRow> {
  const owner = as(coreSchema.users, 'owner');
  const task = as(coreSchema.tasks, 'task');
  const branchOwnerId = field<string>('sortedTask', 'ownerId');
  const branchTaskId = field<string>('sortedTask', 'taskId');
  const branchTitle = field<string>('sortedTask', 'title');
  const branchPoints = field<number>('sortedTask', 'points');
  const sortedTasks = pipe(
    from(task),
    sort(desc(task.points), asc(task.id)),
    project({ ownerId: task.ownerId, taskId: task.id, title: task.title, points: task.points })
  );

  return pipe(
    from(owner),
    join(sortedTasks, eq(owner.id, branchOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskId: branchTaskId,
      title: branchTitle,
      points: branchPoints
    }),
    keyBy('ownerId', 'taskId')
  ) as Query<UserTopTaskRow>;
}

function usersWithLimitedTasksRightBranchQuery(): Query<UserTopTaskRow> {
  const owner = as(coreSchema.users, 'owner');
  const task = as(coreSchema.tasks, 'task');
  const branchOwnerId = field<string>('limitedTask', 'ownerId');
  const branchTaskId = field<string>('limitedTask', 'taskId');
  const branchTitle = field<string>('limitedTask', 'title');
  const branchPoints = field<number>('limitedTask', 'points');
  const limitedTasks = pipe(
    from(task),
    limit(1),
    project({ ownerId: task.ownerId, taskId: task.id, title: task.title, points: task.points })
  );

  return pipe(
    from(owner),
    join(limitedTasks, eq(owner.id, branchOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskId: branchTaskId,
      title: branchTitle,
      points: branchPoints
    }),
    keyBy('ownerId', 'taskId')
  ) as Query<UserTopTaskRow>;
}

function taskProjectionBranch(): Query<{
  readonly ownerId: string;
  readonly taskId: string;
  readonly title: string;
  readonly points: number;
}> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    project({ ownerId: task.ownerId, taskId: task.id, title: task.title, points: task.points })
  ) as Query<{
    readonly ownerId: string;
    readonly taskId: string;
    readonly title: string;
    readonly points: number;
  }>;
}

function usersWithUnionTasksRightBranchQuery(): Query<UserTopTaskRow> {
  const owner = as(coreSchema.users, 'owner');
  const branchOwnerId = field<string>('unionTask', 'ownerId');
  const branchTaskId = field<string>('unionTask', 'taskId');
  const branchTitle = field<string>('unionTask', 'title');
  const branchPoints = field<number>('unionTask', 'points');
  const staticBefore = pipe(
    constRows([{ ownerId: 'cal', taskId: 'pin-cal', title: 'Pinned Cal', points: 0 }]),
    keyBy('taskId')
  );
  const staticAfter = pipe(
    constRows([{ ownerId: 'bea', taskId: 'pin-bea', title: 'Pinned Bea', points: 1 }]),
    keyBy('taskId')
  );
  const unionTasks = union(staticBefore, taskProjectionBranch(), staticAfter);

  return pipe(
    from(owner),
    join(unionTasks, eq(owner.id, branchOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskId: branchTaskId,
      title: branchTitle,
      points: branchPoints
    }),
    keyBy('ownerId', 'taskId')
  ) as Query<UserTopTaskRow>;
}

function usersWithDynamicUnionTasksRightBranchQuery(): Query<UserTopTaskRow> {
  const owner = as(coreSchema.users, 'owner');
  const task = as(coreSchema.tasks, 'task');
  const branchOwnerId = field<string>('unionTask', 'ownerId');
  const branchTaskId = field<string>('unionTask', 'taskId');
  const branchTitle = field<string>('unionTask', 'title');
  const branchPoints = field<number>('unionTask', 'points');
  const activeTasks = pipe(
    from(task),
    where(eq(task.done, false)),
    project({ ownerId: task.ownerId, taskId: task.id, title: task.title, points: task.points })
  );
  const unionTasks = union(taskProjectionBranch(), activeTasks);

  return pipe(
    from(owner),
    join(unionTasks, eq(owner.id, branchOwnerId)),
    project({
      ownerId: owner.id,
      owner: owner.name,
      taskId: branchTaskId,
      title: branchTitle,
      points: branchPoints
    }),
    keyBy('ownerId', 'taskId')
  ) as Query<UserTopTaskRow>;
}

function taskOwnerTeamNestedRightBranchQuery(): Query<TaskNestedOwnerTeamRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  const team = as(coreSchema.teams, 'team');
  const branchOwnerId = field<string>('ownerTeam', 'ownerId');
  const branchOwner = field<string>('ownerTeam', 'owner');
  const branchTeam = field<string>('ownerTeam', 'team');
  const ownerTeams = pipe(
    from(owner),
    join(from(team), eq(owner.teamId, team.id)),
    project({ ownerId: owner.id, owner: owner.name, team: team.name })
  );

  return pipe(
    from(task),
    join(ownerTeams, eq(task.ownerId, branchOwnerId)),
    project({ id: task.id, ownerId: task.ownerId, owner: branchOwner, team: branchTeam }),
    keyBy('id')
  ) as Query<TaskNestedOwnerTeamRow>;
}

function taskOwnerTeamDeeperNestedRightBranchQuery(): Query<TaskNestedOwnerTeamRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  const team = as(coreSchema.teams, 'team');
  const teamByRank = as(coreSchema.teams, 'teamByRank');
  const branchOwnerId = field<string>('ownerTeam', 'ownerId');
  const branchOwner = field<string>('ownerTeam', 'owner');
  const branchTeam = field<string>('ownerTeam', 'team');
  const ownerTeams = pipe(
    from(owner),
    join(from(team), eq(owner.teamId, team.id)),
    join(from(teamByRank), eq(team.rank, teamByRank.rank)),
    project({ ownerId: owner.id, owner: owner.name, team: teamByRank.name })
  );

  return pipe(
    from(task),
    join(ownerTeams, eq(task.ownerId, branchOwnerId)),
    project({ id: task.id, ownerId: task.ownerId, owner: branchOwner, team: branchTeam }),
    keyBy('id')
  ) as Query<TaskNestedOwnerTeamRow>;
}

function joinedTaskOwnerTeamRollupsQuery(): Query<JoinedTaskOwnerTeamRollupRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  return pipe(
    from(task),
    join(from(owner), eq(task.ownerId, owner.id)),
    aggregate({
      groupBy: { teamId: owner.teamId },
      aggregates: {
        tasks: count(),
        points: sum(task.points),
        averagePoints: avg(task.points)
      }
    }),
    keyBy('teamId')
  ) as Query<JoinedTaskOwnerTeamRollupRow>;
}

function leftJoinedUserTeamRollupsQuery(): Query<LeftJoinedUserTeamRollupRow> {
  const user = as(coreSchema.users, 'user');
  const team = as(coreSchema.teams, 'team');
  return pipe(
    from(user),
    leftJoin(from(team), eq(user.teamId, team.id)),
    aggregate({
      groupBy: { teamId: user.teamId },
      aggregates: {
        users: count(),
        matchedTeams: count(team.id)
      }
    }),
    keyBy('teamId')
  ) as Query<LeftJoinedUserTeamRollupRow>;
}

function joinedTaskOwnerWinnersQuery(): Query<JoinedTaskOwnerWinnerRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  return pipe(
    from(task),
    join(from(owner), eq(task.ownerId, owner.id)),
    aggregate({
      groupBy: { teamId: owner.teamId },
      aggregates: {
        maxTask: maxBy<JoinedTaskOwnerRow>(task.points),
        topTask: topBy<JoinedTaskOwnerRow>(1, task.points)
      }
    }),
    keyBy('teamId')
  ) as Query<JoinedTaskOwnerWinnerRow>;
}

function largeCoreData(): LargeCoreData {
  const teamCount = 32;
  const userCount = 256;
  const taskCount = 4096;
  const teams = Array.from({ length: teamCount }, (_, index): TeamRow => ({
    id: `team-${index}`,
    name: `Team ${index}`,
    rank: 1 + index % 8
  }));
  const users = Array.from({ length: userCount }, (_, index): UserRow => ({
    id: `user-${index}`,
    teamId: teams[index % teams.length]?.id ?? teams[0]!.id,
    name: `User ${index}`,
    active: index % 5 !== 0,
    age: 20 + index % 40,
    tags: index % 3 === 0 ? ['runtime', `tag-${index % 7}`] : [`tag-${index % 7}`]
  }));
  const tasks = Array.from({ length: taskCount }, (_, index): TaskRow => ({
    id: `task-${index}`,
    ownerId: users[(index * 17) % users.length]?.id ?? users[0]!.id,
    title: `Task ${index}`,
    done: index % 7 === 0,
    points: 1 + index % 13
  }));

  return { teams, users, tasks };
}

function taskOwnerTeamRow(task: TaskRow, owner: UserRow, team: TeamRow): TaskOwnerTeamRow {
  return {
    id: task.id,
    title: task.title,
    ownerId: owner.id,
    owner: owner.name,
    teamId: team.id,
    team: team.name,
    points: task.points
  };
}

function requiredRow<Row>(rows: readonly Row[], predicate: (row: Row) => boolean, label: string): Row {
  const row = rows.find(predicate);
  if (row === undefined) {
    throw new Error(`missing test fixture row: ${label}`);
  }
  return row;
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

function activeIndexedUsersQuery(): Query<UserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    hash(user.teamId),
    uniqueIndex(user.id),
    btree(user.age),
    project({
      id: user.id,
      teamId: user.teamId,
      name: user.name,
      active: user.active,
      age: user.age,
      tags: user.tags
    }),
    keyBy('id')
  ) as Query<UserRow>;
}

function uniqueUsersByTeamQuery(): Query<UserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    uniqueIndex(user.teamId),
    project({
      id: user.id,
      teamId: user.teamId,
      name: user.name,
      active: user.active,
      age: user.age,
      tags: user.tags
    }),
    keyBy('id')
  ) as Query<UserRow>;
}

function topUsersByAgeQuery(count = 2): Query<UserAgeRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    sortLimit(count, desc(user.age), asc(user.id)),
    project({ id: user.id, name: user.name, age: user.age }),
    keyBy('id')
  ) as Query<UserAgeRow>;
}

function topUserNamesByAgeQuery(count = 2): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    sortLimit(count, desc(user.age), asc(user.id)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function sortedTasksByPointsQuery(): Query<SortedTaskRow> {
  const task = as(coreSchema.tasks, 'task');
  return pipe(
    from(task),
    sort(desc(task.points), asc(task.id)),
    project({ id: task.id, title: task.title, points: task.points }),
    keyBy('id')
  ) as Query<SortedTaskRow>;
}

function userNamesSortedByAgeQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    sort(desc(user.age), asc(user.id)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function limitedUserNamesQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    limit(2),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function duplicateFinalUserKeysQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    project({ id: value('duplicate'), name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function ownerRollupLeadersQuery(): Query<TaskProjectRollupRow> {
  const task = as(coreSchema.tasks, 'task');
  const points = field<number>('taskRollup', 'points');
  const leaders = pipe(
    from(task),
    aggregate({
      groupBy: { projectId: task.ownerId },
      aggregates: {
        tasks: count(),
        points: sum(task.points),
        averagePoints: avg(task.points)
      }
    }),
    sortLimit(1, desc(points))
  ) as Query<TaskProjectRollupRow>;
  return pipe(leaders, keyBy('projectId')) as Query<TaskProjectRollupRow>;
}

function joinedTaskOwnersSortedQuery(): Query<TaskOwnerRow> {
  const task = as(coreSchema.tasks, 'task');
  const owner = as(coreSchema.users, 'owner');
  const projectedId = field<string>('taskOwner', 'id');
  const projectedPoints = field<number>('taskOwner', 'points');
  return pipe(
    from(task),
    join(from(owner), eq(task.ownerId, owner.id)),
    project({ id: task.id, title: task.title, owner: owner.name, points: task.points }),
    keyBy('id'),
    sort(desc(projectedPoints), asc(projectedId))
  ) as Query<TaskOwnerRow>;
}

function userOpenTasksAndTeamSubqueriesQuery(): Query<UserOpenTasksTeamRow> {
  const user = as(coreSchema.users, 'user');
  const task = as(coreSchema.tasks, 'task');
  const team = as(coreSchema.teams, 'team');
  const openTasksForUser = pipe(
    from(task),
    where(and(eq(task.ownerId, user.id), eq(task.done, false))),
    project({ title: task.title })
  );
  const teamForUser = pipe(
    from(team),
    where(eq(team.id, user.teamId)),
    project({ name: team.name })
  );

  return pipe(
    from(user),
    project({
      id: user.id,
      name: user.name,
      openTasks: sel(openTasksForUser),
      team: sel1(teamForUser)
    }),
    keyBy('id')
  ) as Query<UserOpenTasksTeamRow>;
}

function usersWithAnyOpenTaskSubqueryQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  const task = as(coreSchema.tasks, 'task');
  const openTasksForUser = pipe(
    from(task),
    where(and(eq(task.ownerId, user.id), eq(task.done, false))),
    project({ id: task.id })
  );

  return pipe(
    from(user),
    where(neq(sel1(openTasksForUser), undefined)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function ids(rows: readonly { readonly id: string }[] | undefined): readonly string[] {
  return (rows ?? []).map((row) => row.id);
}

function rankedTaskIds(rows: readonly RankedTask[]): readonly string[] {
  return rows.map((row) => row.task.id);
}

function rankedTaskId(row: RankedTask | undefined): string | undefined {
  return row?.task.id;
}

function taskProjectRankingSummaries(
  rows: readonly TaskProjectRankingRow[]
): readonly TaskProjectRankingSummary[] {
  return rows.map((row) => ({
    projectId: row.projectId,
    top: rankedTaskIds(row.topTasks),
    bottom: rankedTaskIds(row.bottomTasks),
    max: rankedTaskId(row.maxTask),
    min: rankedTaskId(row.minTask),
    topOne: rankedTaskIds(row.topTask),
    bottomOne: rankedTaskIds(row.bottomTask)
  }));
}

function expectTaskProjectRankingSummaries(
  rows: readonly TaskProjectRankingRow[],
  expected: readonly TaskProjectRankingSummary[]
): void {
  expect(taskProjectRankingSummaries(rows)).toEqual(expected);
  for (const row of rows) {
    expect(row.maxTask).toEqual(row.topTask.at(0));
    expect(row.minTask).toEqual(row.bottomTask.at(0));
  }
}

function expectSingleUpdatedTaskProjectRanking(
  change: MaterializationMaintenanceResult<TaskProjectRankingRow>['changes'][number],
  before: readonly TaskProjectRankingSummary[],
  after: readonly TaskProjectRankingSummary[]
): void {
  expect(change.rowChanges).toHaveLength(1);
  const rowChange = change.rowChanges[0];
  if (rowChange?.kind !== 'updated') {
    throw new Error('expected a single updated task ranking row change');
  }
  expectTaskProjectRankingSummaries([rowChange.before], before);
  expectTaskProjectRankingSummaries([rowChange.after], after);
}

function joinedTaskOwnerWinnerSummaries(
  rows: readonly JoinedTaskOwnerWinnerRow[]
): readonly JoinedTaskOwnerWinnerSummary[] {
  return rows.map((row) => ({
    teamId: row.teamId,
    maxTask: row.maxTask?.task.id,
    maxOwner: row.maxTask?.owner.id,
    topTask: row.topTask.map((item) => item.task.id),
    topOwner: row.topTask.map((item) => item.owner.id)
  }));
}

describe('incremental materialization', () => {
  describe('aggregate queries', () => {
    it('marks initial task aggregate materialization as incrementally maintained', () => {
      const taskProjectRollups = taskProjectRollupsQuery();
      const state = mat(createDb(sourceData), taskProjectRollups, {
        id: 'task-project-rollups',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, taskProjectRollups);

      expect(metadata).toMatchObject({
        id: 'task-project-rollups',
        requestedMode: 'incremental',
        maintenance: 'incremental',
        dependencies: ['tasks']
      });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, taskProjectRollups)).toEqual([
        { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 },
        { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3 }
      ]);
    });

    it('incrementally updates only the affected aggregate group for a root insert', () => {
      const taskProjectRollups = taskProjectRollupsQuery();
      const state = mat(createDb(sourceData), taskProjectRollups, {
        id: 'task-project-rollups',
        mode: 'incremental'
      });
      const extraReviewTask: TaskRow = {
        id: 't4',
        ownerId: 'bea',
        title: 'Review incremental aggregates',
        done: false,
        points: 7
      };
      const next = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask]
      });

      const maintained = maintainMaterializations(state, next, {
        deltas: [tasksDelta([extraReviewTask], [])]
      });
      const change = singleMaterializationChange(maintained, 'task-project-rollups');

      expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(change).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['tasks'],
        rows: [
          { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 },
          { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }
        ],
        addedRows: [],
        removedRows: []
      });
      expect(change.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3 },
          after: { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }
        })
      ]);
      expect(materializedRowsForQuery(next, taskProjectRollups)).toEqual(change.rows);

      const newProjectTask: TaskRow = {
        id: 't5',
        ownerId: 'cal',
        title: 'Open new aggregate group',
        done: false,
        points: 2
      };
      const withNewProject = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask, newProjectTask]
      });

      const addedGroupMaintenance = maintainMaterializations(next, withNewProject, {
        deltas: [tasksDelta([newProjectTask], [])]
      });
      const addedGroupChange = singleMaterializationChange(addedGroupMaintenance, 'task-project-rollups');

      expect(addedGroupMaintenance).toMatchObject({ recomputed: 0 });
      expect(addedGroupChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 },
          { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 },
          { projectId: 'cal', tasks: 1, points: 2, averagePoints: 2 }
        ],
        addedRows: [{ projectId: 'cal', tasks: 1, points: 2, averagePoints: 2 }],
        removedRows: []
      });
      expect(addedGroupChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'added',
          row: { projectId: 'cal', tasks: 1, points: 2, averagePoints: 2 }
        })
      ]);
      expect(materializedRowsForQuery(withNewProject, taskProjectRollups)).toEqual(addedGroupChange.rows);
    });

    it('incrementally updates and removes affected aggregate groups for root deletes', () => {
      const taskProjectRollups = taskProjectRollupsQuery();
      const state = mat(createDb(sourceData), taskProjectRollups, {
        id: 'task-project-rollups',
        mode: 'incremental'
      });
      const next = createDb({
        ...sourceData,
        tasks: [shipRuntimeTask]
      });

      const maintained = maintainMaterializations(state, next, {
        deltas: [tasksDelta([], [draftEvaluatorTask, reviewFixturesTask])]
      });
      const change = singleMaterializationChange(maintained, 'task-project-rollups');

      expect(maintained).toMatchObject({ recomputed: 0 });
      expect(change).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 1, points: 8, averagePoints: 8 }
        ],
        addedRows: [],
        removedRows: [{ projectId: 'bea', tasks: 1, points: 3, averagePoints: 3 }]
      });
      expect(change.rowChanges).toHaveLength(2);
      expect(change.rowChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'updated',
          before: { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 },
          after: { projectId: 'ada', tasks: 1, points: 8, averagePoints: 8 }
        }),
        expect.objectContaining({
          kind: 'removed',
          row: { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3 }
        })
      ]));
      expect(materializedRowsForQuery(next, taskProjectRollups)).toEqual(change.rows);
    });

    it('incrementally updates both aggregate groups when a root update moves a row', () => {
      const taskProjectRollups = taskProjectRollupsQuery();
      const extraReviewTask: TaskRow = {
        id: 't4',
        ownerId: 'bea',
        title: 'Review incremental aggregates',
        done: false,
        points: 7
      };
      const initial = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask]
      });
      const state = mat(initial, taskProjectRollups, {
        id: 'task-project-rollups',
        mode: 'incremental'
      });
      const movedReviewTask = { ...extraReviewTask, ownerId: 'ada', points: 4 };
      const next = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, movedReviewTask]
      });

      const maintained = maintainMaterializations(state, next, {
        deltas: [tasksDelta([movedReviewTask], [extraReviewTask])]
      });
      const change = singleMaterializationChange(maintained, 'task-project-rollups');

      expect(maintained).toMatchObject({ recomputed: 0 });
      expect(change).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 3, points: 17, averagePoints: 17 / 3 },
          { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3 }
        ],
        addedRows: [],
        removedRows: []
      });
      expect(change.rowChanges).toHaveLength(2);
      expect(change.rowChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'updated',
          before: { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 },
          after: { projectId: 'ada', tasks: 3, points: 17, averagePoints: 17 / 3 }
        }),
        expect.objectContaining({
          kind: 'updated',
          before: { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 },
          after: { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3 }
        })
      ]));
      expect(materializedRowsForQuery(next, taskProjectRollups)).toEqual(change.rows);
    });

    it('keeps count, sum, avg, min, and max correct when aggregate extrema are removed and updated', () => {
      const taskProjectStats = taskProjectStatsQuery();
      const state = mat(createDb(sourceData), taskProjectStats, {
        id: 'task-project-stats',
        mode: 'incremental'
      });
      const withoutRemovedMin = createDb({
        ...sourceData,
        tasks: [shipRuntimeTask, reviewFixturesTask]
      });

      const removedMinMaintenance = maintainMaterializations(state, withoutRemovedMin, {
        deltas: [tasksDelta([], [draftEvaluatorTask])]
      });
      const removedMinChange = singleMaterializationChange(removedMinMaintenance, 'task-project-stats');

      expect(removedMinMaintenance).toMatchObject({ recomputed: 0 });
      expect(removedMinChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 1, points: 8, averagePoints: 8, minPoints: 8, maxPoints: 8 },
          { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3, minPoints: 3, maxPoints: 3 }
        ],
        addedRows: [],
        removedRows: []
      });
      expect(removedMinChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5, minPoints: 5, maxPoints: 8 },
          after: { projectId: 'ada', tasks: 1, points: 8, averagePoints: 8, minPoints: 8, maxPoints: 8 }
        })
      ]);
      expect(materializedRowsForQuery(withoutRemovedMin, taskProjectStats)).toEqual(removedMinChange.rows);

      const updatedShipRuntimeTask = { ...shipRuntimeTask, points: 2 };
      const withUpdatedExtremum = createDb({
        ...sourceData,
        tasks: [updatedShipRuntimeTask, reviewFixturesTask]
      });
      const updatedExtremumMaintenance = maintainMaterializations(withoutRemovedMin, withUpdatedExtremum, {
        deltas: [tasksDelta([updatedShipRuntimeTask], [shipRuntimeTask])]
      });
      const updatedExtremumChange = singleMaterializationChange(updatedExtremumMaintenance, 'task-project-stats');

      expect(updatedExtremumMaintenance).toMatchObject({ recomputed: 0 });
      expect(updatedExtremumChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 1, points: 2, averagePoints: 2, minPoints: 2, maxPoints: 2 },
          { projectId: 'bea', tasks: 1, points: 3, averagePoints: 3, minPoints: 3, maxPoints: 3 }
        ],
        addedRows: [],
        removedRows: []
      });
      expect(updatedExtremumChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { projectId: 'ada', tasks: 1, points: 8, averagePoints: 8, minPoints: 8, maxPoints: 8 },
          after: { projectId: 'ada', tasks: 1, points: 2, averagePoints: 2, minPoints: 2, maxPoints: 2 }
        })
      ]);
      expect(materializedRowsForQuery(withUpdatedExtremum, taskProjectStats)).toEqual(updatedExtremumChange.rows);
    });

    it('keeps any, notAny, countDistinct, and setConcat correct with duplicate and distinct values', () => {
      const teamUserFacets = teamUserFacetsQuery();
      const inactiveEngUser: UserRow = {
        ...diaUser,
        active: false,
        tags: ['runtime', 'ui']
      };
      const initial = createDb({
        ...sourceData,
        users: [adaUser, inactiveEngUser, beaUser, calUser]
      });
      const state = mat(initial, teamUserFacets, {
        id: 'team-user-facets',
        mode: 'incremental'
      });

      expect(materializedRowsForQuery(state, teamUserFacets)).toEqual([
        {
          teamId: 'eng',
          anyActive: true,
          noneActive: false,
          distinctNames: 2,
          tags: new Set(['compiler', 'runtime', 'ui'])
        },
        {
          teamId: 'design',
          anyActive: true,
          noneActive: false,
          distinctNames: 1,
          tags: new Set(['research'])
        },
        {
          teamId: 'missing',
          anyActive: false,
          noneActive: true,
          distinctNames: 1,
          tags: new Set()
        }
      ]);

      const duplicateNameUser: UserRow = {
        id: 'eli',
        teamId: 'eng',
        name: 'Ada',
        active: false,
        age: 31,
        tags: ['ui', 'ops']
      };
      const withDuplicateValues = createDb({
        ...sourceData,
        users: [adaUser, inactiveEngUser, duplicateNameUser, beaUser, calUser]
      });

      const insertedDuplicateMaintenance = maintainMaterializations(state, withDuplicateValues, {
        deltas: [usersDelta([duplicateNameUser], [])]
      });
      const insertedDuplicateChange = singleMaterializationChange(insertedDuplicateMaintenance, 'team-user-facets');

      expect(insertedDuplicateMaintenance).toMatchObject({ recomputed: 0 });
      expect(insertedDuplicateChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        addedRows: [],
        removedRows: []
      });
      expect(insertedDuplicateChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 2,
            tags: new Set(['compiler', 'runtime', 'ui'])
          },
          after: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 2,
            tags: new Set(['compiler', 'runtime', 'ui', 'ops'])
          }
        })
      ]);

      const withoutOriginalActive = createDb({
        ...sourceData,
        users: [inactiveEngUser, duplicateNameUser, beaUser, calUser]
      });
      const removedOriginalMaintenance = maintainMaterializations(withDuplicateValues, withoutOriginalActive, {
        deltas: [usersDelta([], [adaUser])]
      });
      const removedOriginalChange = singleMaterializationChange(removedOriginalMaintenance, 'team-user-facets');

      expect(removedOriginalMaintenance).toMatchObject({ recomputed: 0 });
      expect(removedOriginalChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          {
            teamId: 'eng',
            anyActive: false,
            noneActive: true,
            distinctNames: 2,
            tags: new Set(['runtime', 'ui', 'ops'])
          },
          {
            teamId: 'design',
            anyActive: true,
            noneActive: false,
            distinctNames: 1,
            tags: new Set(['research'])
          },
          {
            teamId: 'missing',
            anyActive: false,
            noneActive: true,
            distinctNames: 1,
            tags: new Set()
          }
        ],
        addedRows: [],
        removedRows: []
      });
      expect(removedOriginalChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 2,
            tags: new Set(['compiler', 'runtime', 'ui', 'ops'])
          },
          after: {
            teamId: 'eng',
            anyActive: false,
            noneActive: true,
            distinctNames: 2,
            tags: new Set(['runtime', 'ui', 'ops'])
          }
        })
      ]);
      expect(materializedRowsForQuery(withoutOriginalActive, teamUserFacets)).toEqual(removedOriginalChange.rows);
    });

    it('reports only affected aggregate groups for insert, update, and delete with set aggregates', () => {
      const teamUserFacets = teamUserFacetsQuery();
      const state = mat(createDb(sourceData), teamUserFacets, {
        id: 'team-user-facets-reporting',
        mode: 'incremental'
      });
      const eliUser: UserRow = {
        id: 'eli',
        teamId: 'eng',
        name: 'Eli',
        active: false,
        age: 32,
        tags: ['ops']
      };
      const withEli = createDb({
        ...sourceData,
        users: [...sourceData.users, eliUser]
      });

      const inserted = maintainMaterializations(state, withEli, {
        deltas: [usersDelta([eliUser], [])]
      });
      const insertedChange = singleMaterializationChange(inserted, 'team-user-facets-reporting');

      expect(inserted).toMatchObject({ recomputed: 0 });
      expect(insertedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback(insertedChange.diagnostics);
      expect(insertedChange.rowChanges).toHaveLength(1);
      expect(insertedChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 1,
            tags: new Set(['compiler', 'runtime'])
          },
          after: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 2,
            tags: new Set(['compiler', 'runtime', 'ops'])
          }
        })
      ]);

      const movedEli = { ...eliUser, teamId: 'design', active: true };
      const withMovedEli = createDb({
        ...sourceData,
        users: [...sourceData.users, movedEli]
      });
      const moved = maintainMaterializations(withEli, withMovedEli, {
        deltas: [usersDelta([movedEli], [eliUser])]
      });
      const movedChange = singleMaterializationChange(moved, 'team-user-facets-reporting');

      expect(moved).toMatchObject({ recomputed: 0 });
      expect(movedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback(movedChange.diagnostics);
      expect(movedChange.rowChanges).toHaveLength(2);
      expect(movedChange.rowChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'updated',
          before: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 2,
            tags: new Set(['compiler', 'runtime', 'ops'])
          },
          after: {
            teamId: 'eng',
            anyActive: true,
            noneActive: false,
            distinctNames: 1,
            tags: new Set(['compiler', 'runtime'])
          }
        }),
        expect.objectContaining({
          kind: 'updated',
          before: {
            teamId: 'design',
            anyActive: true,
            noneActive: false,
            distinctNames: 1,
            tags: new Set(['research'])
          },
          after: {
            teamId: 'design',
            anyActive: true,
            noneActive: false,
            distinctNames: 2,
            tags: new Set(['research', 'ops'])
          }
        })
      ]));

      const withoutMissingGroup = createDb({
        ...sourceData,
        users: [adaUser, beaUser, movedEli]
      });
      const deleted = maintainMaterializations(withMovedEli, withoutMissingGroup, {
        deltas: [usersDelta([], [calUser])]
      });
      const deletedChange = singleMaterializationChange(deleted, 'team-user-facets-reporting');

      expect(deleted).toMatchObject({ recomputed: 0 });
      expect(deletedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        addedRows: [],
        removedRows: [{
          teamId: 'missing',
          anyActive: false,
          noneActive: true,
          distinctNames: 1,
          tags: new Set()
        }]
      });
      expectNoIncrementalFallback(deletedChange.diagnostics);
      expect(deletedChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'removed',
          row: {
            teamId: 'missing',
            anyActive: false,
            noneActive: true,
            distinctNames: 1,
            tags: new Set()
          }
        })
      ]);
      expect(materializedRowsForQuery(withoutMissingGroup, teamUserFacets)).toEqual(deletedChange.rows);
    });

    it('incrementally maintains aggregate output followed by where threshold changes', () => {
      const task = as(coreSchema.tasks, 'task');
      const points = field<number>('taskRollup', 'points');
      const taskProjectRollups = pipe(
        from(task),
        aggregate({
          groupBy: { projectId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points),
            averagePoints: avg(task.points)
          }
        })
      ) as Query<TaskProjectRollupRow>;
      const filteredTaskProjectRollups = where<TaskProjectRollupRow>(
        gt(points, value(9))
      )(taskProjectRollups);
      const taskProjectRollupsOverNine = keyBy('projectId')(filteredTaskProjectRollups);
      const state = mat(createDb(sourceData), taskProjectRollupsOverNine, {
        id: 'task-project-rollups-over-nine',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, taskProjectRollupsOverNine);
      const extraReviewTask: TaskRow = {
        id: 't4',
        ownerId: 'bea',
        title: 'Cross aggregate threshold',
        done: false,
        points: 7
      };
      const withExtraReview = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, taskProjectRollupsOverNine)).toEqual([
        { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 }
      ]);

      const inserted = maintainMaterializations(state, withExtraReview, {
        deltas: [tasksDelta([extraReviewTask], [])]
      });
      const insertedChange = singleMaterializationChange(inserted, 'task-project-rollups-over-nine');

      expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(insertedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 },
          { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }
        ],
        addedRows: [{ projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }],
        removedRows: []
      });
      expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
      expect(insertedChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'added',
          row: { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }
        })
      ]);
      expect(materializedRowsForQuery(withExtraReview, taskProjectRollupsOverNine)).toEqual(insertedChange.rows);

      const withoutExtraReview = createDb(sourceData);
      const deleted = maintainMaterializations(withExtraReview, withoutExtraReview, {
        deltas: [tasksDelta([], [extraReviewTask])]
      });
      const deletedChange = singleMaterializationChange(deleted, 'task-project-rollups-over-nine');

      expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(deletedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 }
        ],
        addedRows: [],
        removedRows: [{ projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }]
      });
      expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
      expect(deletedChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'removed',
          row: { projectId: 'bea', tasks: 2, points: 10, averagePoints: 5 }
        })
      ]);
      expect(materializedRowsForQuery(withoutExtraReview, taskProjectRollupsOverNine)).toEqual(deletedChange.rows);
    });

    it('incrementally maintains aggregate output followed by project, extend, without, rename, and qualify', () => {
      const task = as(coreSchema.tasks, 'task');
      const projectId = field<string>('taskRollup', 'projectId');
      const tasks = field<number>('taskRollup', 'tasks');
      const points = field<number>('taskRollup', 'points');
      const qualifiedTaskRollups = pipe(
        from(task),
        aggregate({
          groupBy: { projectId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        }),
        project({ projectId, tasks, points }),
        extend({ label: value('rollup') }),
        without('tasks'),
        rename({ projectId: 'ownerId', points: 'totalPoints' }),
        qualify('rollup')
      ) as Query<{ readonly rollup: { readonly ownerId: string; readonly totalPoints: number; readonly label: string } }>;
      const state = mat(createDb(sourceData), qualifiedTaskRollups, {
        id: 'qualified-task-rollups',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, qualifiedTaskRollups);
      const extraReviewTask: TaskRow = {
        id: 't4',
        ownerId: 'bea',
        title: 'Transform aggregate output',
        done: false,
        points: 7
      };
      const next = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, qualifiedTaskRollups)).toEqual([
        { rollup: { ownerId: 'ada', totalPoints: 13, label: 'rollup' } },
        { rollup: { ownerId: 'bea', totalPoints: 3, label: 'rollup' } }
      ]);

      const maintained = maintainMaterializations(state, next, {
        deltas: [tasksDelta([extraReviewTask], [])]
      });
      const change = singleMaterializationChange(maintained, 'qualified-task-rollups');

      expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(change).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { rollup: { ownerId: 'ada', totalPoints: 13, label: 'rollup' } },
          { rollup: { ownerId: 'bea', totalPoints: 10, label: 'rollup' } }
        ]
      });
      expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
      expect(change.rowChanges.length).toBeGreaterThan(0);
      expect(materializedRowsForQuery(next, qualifiedTaskRollups)).toEqual(change.rows);
    });

    it('incrementally maintains aggregate output followed by expand', () => {
      const user = as(coreSchema.users, 'user');
      const teamId = field<string>('teamFacet', 'teamId');
      const tags = field<ReadonlySet<string>>('teamFacet', 'tags');
      const tag = field<string>('tag', 'value');
      const teamTags = pipe(
        from(user),
        aggregate({
          groupBy: { teamId: user.teamId },
          aggregates: {
            tags: setConcat(user.tags)
          }
        }),
        expand(tags, { as: 'tag' }),
        project({ teamId, tag }),
        keyBy('teamId', 'tag')
      ) as Query<{ readonly teamId: string; readonly tag: string }>;
      const state = mat(createDb(sourceData), teamTags, {
        id: 'team-tags-from-aggregate',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, teamTags);
      const updatedAda = { ...adaUser, tags: ['compiler', 'logic'] };
      const next = createDb({
        ...sourceData,
        users: [updatedAda, beaUser, calUser]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, teamTags)).toEqual([
        { teamId: 'eng', tag: 'compiler' },
        { teamId: 'eng', tag: 'runtime' },
        { teamId: 'design', tag: 'research' }
      ]);

      const maintained = maintainMaterializations(state, next, {
        deltas: [usersDelta([updatedAda], [adaUser])]
      });
      const change = singleMaterializationChange(maintained, 'team-tags-from-aggregate');

      expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(change).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { teamId: 'eng', tag: 'compiler' },
          { teamId: 'eng', tag: 'logic' },
          { teamId: 'design', tag: 'research' }
        ],
        addedRows: [{ teamId: 'eng', tag: 'logic' }],
        removedRows: [{ teamId: 'eng', tag: 'runtime' }]
      });
      expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
      expect(change.rowChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'added',
          row: { teamId: 'eng', tag: 'logic' }
        }),
        expect.objectContaining({
          kind: 'removed',
          row: { teamId: 'eng', tag: 'runtime' }
        })
      ]));
      expect(materializedRowsForQuery(next, teamTags)).toEqual(change.rows);
    });

    it('incrementally maintains aggregate output followed by join with nested right branch updates', () => {
      const task = as(coreSchema.tasks, 'task');
      const user = as(coreSchema.users, 'user');
      const team = as(coreSchema.teams, 'team');
      const ownerId = field<string>('ownerRollup', 'ownerId');
      const tasks = field<number>('ownerRollup', 'tasks');
      const points = field<number>('ownerRollup', 'points');
      const ownerInfoUserId = field<string>('ownerInfo', 'userId');
      const ownerInfoOwner = field<string>('ownerInfo', 'owner');
      const ownerInfoTeam = field<string>('ownerInfo', 'team');
      const ownerInfo = pipe(
        from(user),
        join(from(team), eq(user.teamId, team.id)),
        project({ userId: user.id, owner: user.name, team: team.name })
      );
      const ownerRollups = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        }),
        join(ownerInfo, eq(ownerId, ownerInfoUserId)),
        project({ ownerId, tasks, points, owner: ownerInfoOwner, team: ownerInfoTeam }),
        keyBy('ownerId')
      ) as Query<TaskOwnerInfoRollupRow>;
      const state = mat(createDb(sourceData), ownerRollups, {
        id: 'aggregate-then-owner-info',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, ownerRollups);
      const renamedAda = { ...adaUser, name: 'Ada Lovelace' };
      const withRenamedAda = createDb({
        ...sourceData,
        users: [renamedAda, beaUser, calUser]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users', 'teams']));
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, ownerRollups)).toEqual([
        { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada', team: 'Engineering' },
        { ownerId: 'bea', tasks: 1, points: 3, owner: 'Bea', team: 'Design' }
      ]);

      const renamedOwner = maintainMaterializations(state, withRenamedAda, {
        deltas: [usersDelta([renamedAda], [adaUser])]
      });
      const renamedOwnerChange = singleMaterializationChange(renamedOwner, 'aggregate-then-owner-info');

      expect(renamedOwner).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(renamedOwnerChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['users'],
        rows: [
          { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada Lovelace', team: 'Engineering' },
          { ownerId: 'bea', tasks: 1, points: 3, owner: 'Bea', team: 'Design' }
        ],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...renamedOwner.diagnostics, ...renamedOwnerChange.diagnostics]);
      expect(renamedOwnerChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada', team: 'Engineering' },
          after: { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada Lovelace', team: 'Engineering' }
        })
      ]);
      expect(materializedRowsForQuery(withRenamedAda, ownerRollups)).toEqual(renamedOwnerChange.rows);

      const renamedEngineering = { ...engineeringTeam, name: 'Platform' };
      const withRenamedTeam = createDb({
        ...sourceData,
        teams: [designTeam, renamedEngineering],
        users: [renamedAda, beaUser, calUser]
      });
      const renamedTeam = maintainMaterializations(withRenamedAda, withRenamedTeam, {
        deltas: [teamsDelta([renamedEngineering], [engineeringTeam])]
      });
      const renamedTeamChange = singleMaterializationChange(renamedTeam, 'aggregate-then-owner-info');

      expect(renamedTeam).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(renamedTeamChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['teams'],
        rows: [
          { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada Lovelace', team: 'Platform' },
          { ownerId: 'bea', tasks: 1, points: 3, owner: 'Bea', team: 'Design' }
        ],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...renamedTeam.diagnostics, ...renamedTeamChange.diagnostics]);
      expect(renamedTeamChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada Lovelace', team: 'Engineering' },
          after: { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada Lovelace', team: 'Platform' }
        })
      ]);
      expect(materializedRowsForQuery(withRenamedTeam, ownerRollups)).toEqual(renamedTeamChange.rows);
    });

    it('incrementally maintains aggregate output followed by leftJoin when a right row appears', () => {
      const task = as(coreSchema.tasks, 'task');
      const user = as(coreSchema.users, 'user');
      const ownerId = field<string>('ownerRollup', 'ownerId');
      const tasks = field<number>('ownerRollup', 'tasks');
      const points = field<number>('ownerRollup', 'points');
      const orphanTask: TaskRow = {
        id: 't-flo',
        ownerId: 'flo',
        title: 'Unmatched owner aggregate',
        done: false,
        points: 6
      };
      const ownerRollups = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        }),
        leftJoin(from(user), eq(ownerId, user.id)),
        project({ ownerId, tasks, points, owner: maybe(user.name) }),
        keyBy('ownerId')
      ) as Query<TaskOwnerMaybeInfoRollupRow>;
      const initial = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, orphanTask]
      });
      const state = mat(initial, ownerRollups, {
        id: 'aggregate-then-left-owner',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, ownerRollups);

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, ownerRollups)).toEqual([
        { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada' },
        { ownerId: 'bea', tasks: 1, points: 3, owner: 'Bea' },
        { ownerId: 'flo', tasks: 1, points: 6, owner: undefined }
      ]);

      const withFlo = createDb({
        ...sourceData,
        users: [...sourceData.users, floUser],
        tasks: [...sourceData.tasks, orphanTask]
      });
      const inserted = maintainMaterializations(state, withFlo, {
        deltas: [usersDelta([floUser], [])]
      });
      const insertedChange = singleMaterializationChange(inserted, 'aggregate-then-left-owner');

      expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(insertedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['users'],
        rows: [
          { ownerId: 'ada', tasks: 2, points: 13, owner: 'Ada' },
          { ownerId: 'bea', tasks: 1, points: 3, owner: 'Bea' },
          { ownerId: 'flo', tasks: 1, points: 6, owner: 'Flo' }
        ],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
      expect(insertedChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { ownerId: 'flo', tasks: 1, points: 6, owner: undefined },
          after: { ownerId: 'flo', tasks: 1, points: 6, owner: 'Flo' }
        })
      ]);
      expect(materializedRowsForQuery(withFlo, ownerRollups)).toEqual(insertedChange.rows);
    });

    it('incrementally maintains aggregate output followed by static intersection filters', () => {
      const task = as(coreSchema.tasks, 'task');
      const ownerRollupBase = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        })
      ) as Query<TaskOwnerRollupRow>;
      const matchingRollups = constRows([
        { ownerId: 'ada', tasks: 2, points: 13 },
        { ownerId: 'bea', tasks: 2, points: 10 }
      ]);
      const matchingOwnerRollups = pipe(
        intersection(ownerRollupBase, matchingRollups),
        keyBy('ownerId')
      ) as Query<TaskOwnerRollupRow>;
      const state = mat(createDb(sourceData), matchingOwnerRollups, {
        id: 'aggregate-then-static-intersection',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, matchingOwnerRollups);
      const extraReviewTask: TaskRow = {
        id: 't4',
        ownerId: 'bea',
        title: 'Match static aggregate filter',
        done: false,
        points: 7
      };
      const withExtraReview = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, matchingOwnerRollups)).toEqual([
        { ownerId: 'ada', tasks: 2, points: 13 }
      ]);

      const inserted = maintainMaterializations(state, withExtraReview, {
        deltas: [tasksDelta([extraReviewTask], [])]
      });
      const insertedChange = singleMaterializationChange(inserted, 'aggregate-then-static-intersection');

      expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(insertedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'ada', tasks: 2, points: 13 },
          { ownerId: 'bea', tasks: 2, points: 10 }
        ],
        addedRows: [{ ownerId: 'bea', tasks: 2, points: 10 }],
        removedRows: []
      });
      expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
      expect(insertedChange.rowChanges).toEqual([
        expect.objectContaining({ kind: 'added', row: { ownerId: 'bea', tasks: 2, points: 10 } })
      ]);
      expect(materializedRowsForQuery(withExtraReview, matchingOwnerRollups)).toEqual(insertedChange.rows);

      const deleted = maintainMaterializations(withExtraReview, createDb(sourceData), {
        deltas: [tasksDelta([], [extraReviewTask])]
      });
      const deletedChange = singleMaterializationChange(deleted, 'aggregate-then-static-intersection');

      expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(deletedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'ada', tasks: 2, points: 13 }
        ],
        addedRows: [],
        removedRows: [{ ownerId: 'bea', tasks: 2, points: 10 }]
      });
      expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
      expect(deletedChange.rowChanges).toEqual([
        expect.objectContaining({ kind: 'removed', row: { ownerId: 'bea', tasks: 2, points: 10 } })
      ]);
    });

    it('incrementally maintains aggregate output followed by static difference filters', () => {
      const task = as(coreSchema.tasks, 'task');
      const ownerRollupBase = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        })
      ) as Query<TaskOwnerRollupRow>;
      const blockedRollups = constRows([{ ownerId: 'ada', tasks: 2, points: 13 }]);
      const unblockedOwnerRollups = pipe(
        difference(ownerRollupBase, blockedRollups),
        keyBy('ownerId')
      ) as Query<TaskOwnerRollupRow>;
      const state = mat(createDb(sourceData), unblockedOwnerRollups, {
        id: 'aggregate-then-static-difference',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, unblockedOwnerRollups);
      const updatedDraft = { ...draftEvaluatorTask, points: 6 };
      const withUpdatedDraft = createDb({
        ...sourceData,
        tasks: [updatedDraft, shipRuntimeTask, reviewFixturesTask]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, unblockedOwnerRollups)).toEqual([
        { ownerId: 'bea', tasks: 1, points: 3 }
      ]);

      const updated = maintainMaterializations(state, withUpdatedDraft, {
        deltas: [tasksDelta([updatedDraft], [draftEvaluatorTask])]
      });
      const updatedChange = singleMaterializationChange(updated, 'aggregate-then-static-difference');

      expect(updated).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(updatedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'ada', tasks: 2, points: 14 },
          { ownerId: 'bea', tasks: 1, points: 3 }
        ],
        addedRows: [{ ownerId: 'ada', tasks: 2, points: 14 }],
        removedRows: []
      });
      expectNoIncrementalFallback([...updated.diagnostics, ...updatedChange.diagnostics]);
      expect(updatedChange.rowChanges).toEqual([
        expect.objectContaining({ kind: 'added', row: { ownerId: 'ada', tasks: 2, points: 14 } })
      ]);
      expect(materializedRowsForQuery(withUpdatedDraft, unblockedOwnerRollups)).toEqual(updatedChange.rows);

      const restored = maintainMaterializations(withUpdatedDraft, createDb(sourceData), {
        deltas: [tasksDelta([draftEvaluatorTask], [updatedDraft])]
      });
      const restoredChange = singleMaterializationChange(restored, 'aggregate-then-static-difference');

      expect(restored).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(restoredChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'bea', tasks: 1, points: 3 }
        ],
        addedRows: [],
        removedRows: [{ ownerId: 'ada', tasks: 2, points: 14 }]
      });
      expectNoIncrementalFallback([...restored.diagnostics, ...restoredChange.diagnostics]);
      expect(restoredChange.rowChanges).toEqual([
        expect.objectContaining({ kind: 'removed', row: { ownerId: 'ada', tasks: 2, points: 14 } })
      ]);
    });

    it('incrementally maintains aggregate output followed by static union', () => {
      const task = as(coreSchema.tasks, 'task');
      const ownerRollupBase = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        })
      ) as Query<TaskOwnerRollupRow>;
      const staticExtraRollups = constRows([{ ownerId: 'cal', tasks: 0, points: 0 }]);
      const ownerRollups = pipe(
        union(ownerRollupBase, staticExtraRollups),
        keyBy('ownerId')
      ) as Query<TaskOwnerRollupRow>;
      const state = mat(createDb(sourceData), ownerRollups, {
        id: 'aggregate-then-static-union',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, ownerRollups);
      const extraReviewTask: TaskRow = {
        id: 't4',
        ownerId: 'bea',
        title: 'Update static union aggregate',
        done: false,
        points: 7
      };
      const withExtraReview = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraReviewTask]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, ownerRollups)).toEqual([
        { ownerId: 'ada', tasks: 2, points: 13 },
        { ownerId: 'bea', tasks: 1, points: 3 },
        { ownerId: 'cal', tasks: 0, points: 0 }
      ]);

      const updated = maintainMaterializations(state, withExtraReview, {
        deltas: [tasksDelta([extraReviewTask], [])]
      });
      const updatedChange = singleMaterializationChange(updated, 'aggregate-then-static-union');

      expect(updated).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(updatedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'ada', tasks: 2, points: 13 },
          { ownerId: 'bea', tasks: 2, points: 10 },
          { ownerId: 'cal', tasks: 0, points: 0 }
        ],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...updated.diagnostics, ...updatedChange.diagnostics]);
      expect(updatedChange.rowChanges).toEqual([
        expect.objectContaining({
          kind: 'updated',
          before: { ownerId: 'bea', tasks: 1, points: 3 },
          after: { ownerId: 'bea', tasks: 2, points: 10 }
        })
      ]);
      expect(materializedRowsForQuery(withExtraReview, ownerRollups)).toEqual(updatedChange.rows);
    });

    it('applies aggregate static union once for the relation instead of once per aggregate group', () => {
      const task = as(coreSchema.tasks, 'task');
      const ownerRollupBase = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        })
      ) as Query<TaskOwnerRollupRow>;
      const ownerRollups = union(
        ownerRollupBase,
        constRows([{ ownerId: 'cal', tasks: 0, points: 0 }])
      ) as Query<TaskOwnerRollupRow>;
      const state = mat(createDb(sourceData), ownerRollups, {
        id: 'aggregate-then-static-union-once',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, ownerRollups);
      const rows = materializedRowsForQuery(state, ownerRollups);

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(rows).toEqual([
        { ownerId: 'ada', tasks: 2, points: 13 },
        { ownerId: 'bea', tasks: 1, points: 3 },
        { ownerId: 'cal', tasks: 0, points: 0 }
      ]);
      expect(rows?.filter((row) => row.ownerId === 'cal')).toHaveLength(1);
    });

    it('reveals a static union row when an equal aggregate row changes or is removed', () => {
      const task = as(coreSchema.tasks, 'task');
      const ownerRollupBase = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        })
      ) as Query<TaskOwnerRollupRow>;
      const ownerRollups = union(
        ownerRollupBase,
        constRows([{ ownerId: 'ada', tasks: 2, points: 13 }])
      ) as Query<TaskOwnerRollupRow>;
      const state = mat(createDb(sourceData), ownerRollups, {
        id: 'aggregate-then-static-union-duplicate-row',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, ownerRollups);
      const updatedDraft = { ...draftEvaluatorTask, points: 6 };
      const withUpdatedDraft = createDb({
        ...sourceData,
        tasks: [updatedDraft, shipRuntimeTask, reviewFixturesTask]
      });
      const withoutAdaTasks = createDb({
        ...sourceData,
        tasks: [reviewFixturesTask]
      });

      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expect(materializedRowsForQuery(state, ownerRollups)).toEqual([
        { ownerId: 'ada', tasks: 2, points: 13 },
        { ownerId: 'bea', tasks: 1, points: 3 }
      ]);

      const updated = maintainMaterializations(state, withUpdatedDraft, {
        deltas: [tasksDelta([updatedDraft], [draftEvaluatorTask])]
      });
      const updatedChange = singleMaterializationChange(updated, 'aggregate-then-static-union-duplicate-row');

      expect(updated).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(updatedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'ada', tasks: 2, points: 14 },
          { ownerId: 'bea', tasks: 1, points: 3 },
          { ownerId: 'ada', tasks: 2, points: 13 }
        ],
        addedRows: [{ ownerId: 'ada', tasks: 2, points: 14 }],
        removedRows: []
      });
      expectNoIncrementalFallback([...updated.diagnostics, ...updatedChange.diagnostics]);
      expect(updatedChange.rowChanges).toEqual([
        expect.objectContaining({ kind: 'added', row: { ownerId: 'ada', tasks: 2, points: 14 } })
      ]);
      expect(materializedRowsForQuery(withUpdatedDraft, ownerRollups)).toEqual(updatedChange.rows);

      const removed = maintainMaterializations(withUpdatedDraft, withoutAdaTasks, {
        deltas: [tasksDelta([], [updatedDraft, shipRuntimeTask])]
      });
      const removedChange = singleMaterializationChange(removed, 'aggregate-then-static-union-duplicate-row');

      expect(removed).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(removedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        rows: [
          { ownerId: 'bea', tasks: 1, points: 3 },
          { ownerId: 'ada', tasks: 2, points: 13 }
        ],
        addedRows: [],
        removedRows: [{ ownerId: 'ada', tasks: 2, points: 14 }]
      });
      expectNoIncrementalFallback([...removed.diagnostics, ...removedChange.diagnostics]);
      expect(removedChange.rowChanges).toEqual([
        expect.objectContaining({ kind: 'removed', row: { ownerId: 'ada', tasks: 2, points: 14 } })
      ]);
      expect(materializedRowsForQuery(withoutAdaTasks, ownerRollups)).toEqual(removedChange.rows);
    });

    it('keeps aggregate output followed by dynamic set branches on snapshot fallback', () => {
      const task = as(coreSchema.tasks, 'task');
      const user = as(coreSchema.users, 'user');
      const ownerRollupBase = pipe(
        from(task),
        aggregate({
          groupBy: { ownerId: task.ownerId },
          aggregates: {
            tasks: count(),
            points: sum(task.points)
          }
        })
      ) as Query<TaskOwnerRollupRow>;
      const dynamicAllowedRollups = pipe(
        from(user),
        project({ ownerId: user.id, tasks: value(2), points: value(13) })
      ) as Query<TaskOwnerRollupRow>;
      const cases: readonly {
        readonly id: string;
        readonly query: Query<unknown>;
        readonly reason: string;
      }[] = [
        {
          id: 'aggregate-then-dynamic-union-fallback',
          query: pipe(
            union(ownerRollupBase, dynamicAllowedRollups),
            keyBy('ownerId')
          ) as Query<unknown>,
          reason: 'union incremental maintenance requires exactly one supported dynamic branch'
        },
        {
          id: 'aggregate-then-dynamic-intersection-fallback',
          query: pipe(
            intersection(ownerRollupBase, dynamicAllowedRollups),
            keyBy('ownerId')
          ) as Query<unknown>,
          reason: 'intersection static branch'
        }
      ];

      for (const item of cases) {
        const state = mat(createDb(sourceData), item.query, {
          id: item.id,
          mode: 'incremental'
        });
        const metadata = materializationForQuery(state, item.query);

        expect(metadata).toMatchObject({
          requestedMode: 'incremental',
          maintenance: 'snapshot'
        });
        expect(metadata?.maintenanceReason).toContain(item.reason);
        expectIncrementalFallback(metadata?.diagnostics ?? []);
      }
    });

    it('marks initial by-row aggregate winner materialization as incrementally maintained', () => {
      const taskProjectRankings = taskProjectRankingsQuery();
      const state = mat(createDb(sourceData), taskProjectRankings, {
        id: 'task-project-rankings',
        mode: 'incremental'
      });
      const metadata = materializationForQuery(state, taskProjectRankings);

      expect(metadata).toMatchObject({
        id: 'task-project-rankings',
        requestedMode: 'incremental',
        maintenance: 'incremental',
        dependencies: ['tasks']
      });
      expectNoIncrementalFallback(metadata?.diagnostics ?? []);
      expectTaskProjectRankingSummaries(materializedRowsForQuery(state, taskProjectRankings) ?? [], [
        {
          projectId: 'ada',
          top: ['t2', 't1'],
          bottom: ['t1', 't2'],
          max: 't2',
          min: 't1',
          topOne: ['t2'],
          bottomOne: ['t1']
        },
        {
          projectId: 'bea',
          top: ['t3'],
          bottom: ['t3'],
          max: 't3',
          min: 't3',
          topOne: ['t3'],
          bottomOne: ['t3']
        }
      ]);
    });

    it('incrementally updates by-row aggregate winners across inserts, updates, and deletes', () => {
      const taskProjectRankings = taskProjectRankingsQuery();
      const state = mat(createDb(sourceData), taskProjectRankings, {
        id: 'task-project-rankings',
        mode: 'incremental'
      });
      const initialAda: TaskProjectRankingSummary = {
        projectId: 'ada',
        top: ['t2', 't1'],
        bottom: ['t1', 't2'],
        max: 't2',
        min: 't1',
        topOne: ['t2'],
        bottomOne: ['t1']
      };
      const initialBea: TaskProjectRankingSummary = {
        projectId: 'bea',
        top: ['t3'],
        bottom: ['t3'],
        max: 't3',
        min: 't3',
        topOne: ['t3'],
        bottomOne: ['t3']
      };
      const insertedTopTask: TaskRow = {
        id: 't4',
        ownerId: 'ada',
        title: 'Spike aggregate maintenance',
        done: false,
        points: 10
      };
      const withInsertedTop = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, insertedTopTask]
      });
      const insertedAda: TaskProjectRankingSummary = {
        projectId: 'ada',
        top: ['t4', 't2'],
        bottom: ['t1', 't2'],
        max: 't4',
        min: 't1',
        topOne: ['t4'],
        bottomOne: ['t1']
      };

      const inserted = maintainMaterializations(state, withInsertedTop, {
        deltas: [tasksDelta([insertedTopTask], [])]
      });
      const insertedChange = singleMaterializationChange(inserted, 'task-project-rankings') as
        MaterializationMaintenanceResult<TaskProjectRankingRow>['changes'][number];

      expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(insertedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['tasks'],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
      expectTaskProjectRankingSummaries(insertedChange.rows, [insertedAda, initialBea]);
      expectSingleUpdatedTaskProjectRanking(insertedChange, [initialAda], [insertedAda]);
      expect(materializedRowsForQuery(withInsertedTop, taskProjectRankings)).toEqual(insertedChange.rows);

      const updatedBottomTask = { ...insertedTopTask, points: 1 };
      const withUpdatedBottom = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, updatedBottomTask]
      });
      const updatedAda: TaskProjectRankingSummary = {
        projectId: 'ada',
        top: ['t2', 't1'],
        bottom: ['t4', 't1'],
        max: 't2',
        min: 't4',
        topOne: ['t2'],
        bottomOne: ['t4']
      };

      const updated = maintainMaterializations(withInsertedTop, withUpdatedBottom, {
        deltas: [tasksDelta([updatedBottomTask], [insertedTopTask])]
      });
      const updatedChange = singleMaterializationChange(updated, 'task-project-rankings') as
        MaterializationMaintenanceResult<TaskProjectRankingRow>['changes'][number];

      expect(updated).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(updatedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['tasks'],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...updated.diagnostics, ...updatedChange.diagnostics]);
      expectTaskProjectRankingSummaries(updatedChange.rows, [updatedAda, initialBea]);
      expectSingleUpdatedTaskProjectRanking(updatedChange, [insertedAda], [updatedAda]);
      expect(materializedRowsForQuery(withUpdatedBottom, taskProjectRankings)).toEqual(updatedChange.rows);

      const withoutInsertedTask = createDb(sourceData);
      const deleted = maintainMaterializations(withUpdatedBottom, withoutInsertedTask, {
        deltas: [tasksDelta([], [updatedBottomTask])]
      });
      const deletedChange = singleMaterializationChange(deleted, 'task-project-rankings') as
        MaterializationMaintenanceResult<TaskProjectRankingRow>['changes'][number];

      expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(deletedChange).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['tasks'],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
      expectTaskProjectRankingSummaries(deletedChange.rows, [initialAda, initialBea]);
      expectSingleUpdatedTaskProjectRanking(deletedChange, [updatedAda], [initialAda]);
      expect(materializedRowsForQuery(withoutInsertedTask, taskProjectRankings)).toEqual(deletedChange.rows);
    });

    it('incrementally updates both by-row aggregate groups when a ranked row moves group', () => {
      const taskProjectRankings = taskProjectRankingsQuery();
      const extraAdaTask: TaskRow = {
        id: 't4',
        ownerId: 'ada',
        title: 'Move ranked task between groups',
        done: false,
        points: 10
      };
      const initial = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, extraAdaTask]
      });
      const state = mat(initial, taskProjectRankings, {
        id: 'task-project-rankings',
        mode: 'incremental'
      });
      const movedToBea = { ...extraAdaTask, ownerId: 'bea', points: 9 };
      const next = createDb({
        ...sourceData,
        tasks: [...sourceData.tasks, movedToBea]
      });

      const maintained = maintainMaterializations(state, next, {
        deltas: [tasksDelta([movedToBea], [extraAdaTask])]
      });
      const change = singleMaterializationChange(maintained, 'task-project-rankings') as
        MaterializationMaintenanceResult<TaskProjectRankingRow>['changes'][number];

      const initialAda: TaskProjectRankingSummary = {
        projectId: 'ada',
        top: ['t4', 't2'],
        bottom: ['t1', 't2'],
        max: 't4',
        min: 't1',
        topOne: ['t4'],
        bottomOne: ['t1']
      };
      const movedAda: TaskProjectRankingSummary = {
        projectId: 'ada',
        top: ['t2', 't1'],
        bottom: ['t1', 't2'],
        max: 't2',
        min: 't1',
        topOne: ['t2'],
        bottomOne: ['t1']
      };
      const initialBea: TaskProjectRankingSummary = {
        projectId: 'bea',
        top: ['t3'],
        bottom: ['t3'],
        max: 't3',
        min: 't3',
        topOne: ['t3'],
        bottomOne: ['t3']
      };
      const movedBea: TaskProjectRankingSummary = {
        projectId: 'bea',
        top: ['t4', 't3'],
        bottom: ['t3', 't4'],
        max: 't4',
        min: 't3',
        topOne: ['t4'],
        bottomOne: ['t3']
      };

      expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
      expect(change).toMatchObject({
        maintenance: 'incremental',
        recomputed: false,
        touchedDependencies: ['tasks'],
        addedRows: [],
        removedRows: []
      });
      expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
      expectTaskProjectRankingSummaries(change.rows, [movedAda, movedBea]);
      expect(change.rowChanges).toHaveLength(2);
      const updatedRows = change.rowChanges.filter((rowChange) => rowChange.kind === 'updated');
      expect(updatedRows).toHaveLength(2);
      expectTaskProjectRankingSummaries(
        updatedRows.map((rowChange) => rowChange.before),
        [initialAda, initialBea]
      );
      expectTaskProjectRankingSummaries(
        updatedRows.map((rowChange) => rowChange.after),
        [movedAda, movedBea]
      );
      expect(materializedRowsForQuery(next, taskProjectRankings)).toEqual(change.rows);
    });

    describe('aggregate over join queries', () => {
      it('marks aggregate over inner equality join as incrementally maintained without fallback', () => {
        const joinedRollups = joinedTaskOwnerTeamRollupsQuery();
        const state = mat(createDb(sourceData), joinedRollups, {
          id: 'joined-task-owner-team-rollups',
          mode: 'incremental'
        });
        const metadata = materializationForQuery(state, joinedRollups);

        expect(metadata).toMatchObject({
          id: 'joined-task-owner-team-rollups',
          requestedMode: 'incremental',
          maintenance: 'incremental'
        });
        expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users']));
        expectNoIncrementalFallback(metadata?.diagnostics ?? []);
        expect(materializedRowsForQuery(state, joinedRollups)).toEqual([
          { teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 },
          { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 }
        ]);
      });

      it('incrementally maintains root inserts, updates, and deletes with only affected joined aggregate groups', () => {
        const joinedRollups = joinedTaskOwnerTeamRollupsQuery();
        const state = mat(createDb(sourceData), joinedRollups, {
          id: 'joined-task-owner-team-rollups',
          mode: 'incremental'
        });
        const extraReviewTask: TaskRow = {
          id: 't4',
          ownerId: 'bea',
          title: 'Review joined aggregates',
          done: false,
          points: 7
        };
        const withInserted = createDb({
          ...sourceData,
          tasks: [...sourceData.tasks, extraReviewTask]
        });

        const inserted = maintainMaterializations(state, withInserted, {
          deltas: [tasksDelta([extraReviewTask], [])]
        });
        const insertedChange = singleMaterializationChange(inserted, 'joined-task-owner-team-rollups');

        expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(insertedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['tasks'],
          rows: [
            { teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 },
            { teamId: 'design', tasks: 2, points: 10, averagePoints: 5 }
          ],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
        expect(insertedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 },
            after: { teamId: 'design', tasks: 2, points: 10, averagePoints: 5 }
          })
        ]);
        expect(materializedRowsForQuery(withInserted, joinedRollups)).toEqual(insertedChange.rows);

        const updatedDraftEvaluatorTask = { ...draftEvaluatorTask, points: 6 };
        const withUpdated = createDb({
          ...sourceData,
          tasks: [updatedDraftEvaluatorTask, shipRuntimeTask, reviewFixturesTask, extraReviewTask]
        });
        const updated = maintainMaterializations(withInserted, withUpdated, {
          deltas: [tasksDelta([updatedDraftEvaluatorTask], [draftEvaluatorTask])]
        });
        const updatedChange = singleMaterializationChange(updated, 'joined-task-owner-team-rollups');

        expect(updated).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(updatedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['tasks'],
          rows: [
            { teamId: 'eng', tasks: 2, points: 14, averagePoints: 7 },
            { teamId: 'design', tasks: 2, points: 10, averagePoints: 5 }
          ],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...updated.diagnostics, ...updatedChange.diagnostics]);
        expect(updatedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 },
            after: { teamId: 'eng', tasks: 2, points: 14, averagePoints: 7 }
          })
        ]);
        expect(materializedRowsForQuery(withUpdated, joinedRollups)).toEqual(updatedChange.rows);

        const withDeleted = createDb({
          ...sourceData,
          tasks: [updatedDraftEvaluatorTask, shipRuntimeTask, reviewFixturesTask]
        });
        const deleted = maintainMaterializations(withUpdated, withDeleted, {
          deltas: [tasksDelta([], [extraReviewTask])]
        });
        const deletedChange = singleMaterializationChange(deleted, 'joined-task-owner-team-rollups');

        expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(deletedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['tasks'],
          rows: [
            { teamId: 'eng', tasks: 2, points: 14, averagePoints: 7 },
            { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 }
          ],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
        expect(deletedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'design', tasks: 2, points: 10, averagePoints: 5 },
            after: { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 }
          })
        ]);
        expect(materializedRowsForQuery(withDeleted, joinedRollups)).toEqual(deletedChange.rows);
      });

      it('incrementally maintains right relation inserts, updates, and deletes with only affected joined aggregate groups', () => {
        const joinedRollups = joinedTaskOwnerTeamRollupsQuery();
        const orphanOpsTask: TaskRow = {
          id: 't-flo',
          ownerId: 'flo',
          title: 'Ops follow-up',
          done: false,
          points: 6
        };
        const initial = createDb({
          ...sourceData,
          tasks: [...sourceData.tasks, orphanOpsTask]
        });
        const state = mat(initial, joinedRollups, {
          id: 'joined-task-owner-team-rollups',
          mode: 'incremental'
        });
        const withInsertedOwner = createDb({
          ...sourceData,
          users: [...sourceData.users, floUser],
          tasks: [...sourceData.tasks, orphanOpsTask]
        });

        const inserted = maintainMaterializations(state, withInsertedOwner, {
          deltas: [usersDelta([floUser], [])]
        });
        const insertedChange = singleMaterializationChange(inserted, 'joined-task-owner-team-rollups');

        expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(insertedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['users'],
          rows: [
            { teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 },
            { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 },
            { teamId: 'ops', tasks: 1, points: 6, averagePoints: 6 }
          ],
          addedRows: [{ teamId: 'ops', tasks: 1, points: 6, averagePoints: 6 }],
          removedRows: []
        });
        expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
        expect(insertedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'added',
            row: { teamId: 'ops', tasks: 1, points: 6, averagePoints: 6 }
          })
        ]);
        expect(materializedRowsForQuery(withInsertedOwner, joinedRollups)).toEqual(insertedChange.rows);

        const movedAdaUser = { ...adaUser, teamId: 'design' };
        const withMovedOwner = createDb({
          ...sourceData,
          users: [movedAdaUser, beaUser, calUser, floUser],
          tasks: [...sourceData.tasks, orphanOpsTask]
        });
        const moved = maintainMaterializations(withInsertedOwner, withMovedOwner, {
          deltas: [usersDelta([movedAdaUser], [adaUser])]
        });
        const movedChange = singleMaterializationChange(moved, 'joined-task-owner-team-rollups');

        expect(moved).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(movedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['users'],
          rows: [
            { teamId: 'design', tasks: 3, points: 16, averagePoints: 16 / 3 },
            { teamId: 'ops', tasks: 1, points: 6, averagePoints: 6 }
          ],
          addedRows: [],
          removedRows: [{ teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 }]
        });
        expectNoIncrementalFallback([...moved.diagnostics, ...movedChange.diagnostics]);
        expect(movedChange.rowChanges).toHaveLength(2);
        expect(movedChange.rowChanges).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'removed',
            row: { teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 }
          }),
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 },
            after: { teamId: 'design', tasks: 3, points: 16, averagePoints: 16 / 3 }
          })
        ]));
        expect(materializedRowsForQuery(withMovedOwner, joinedRollups)).toEqual(movedChange.rows);

        const withoutOpsOwner = createDb({
          ...sourceData,
          users: [movedAdaUser, beaUser, calUser],
          tasks: [...sourceData.tasks, orphanOpsTask]
        });
        const deleted = maintainMaterializations(withMovedOwner, withoutOpsOwner, {
          deltas: [usersDelta([], [floUser])]
        });
        const deletedChange = singleMaterializationChange(deleted, 'joined-task-owner-team-rollups');

        expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(deletedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['users'],
          rows: [
            { teamId: 'design', tasks: 3, points: 16, averagePoints: 16 / 3 }
          ],
          addedRows: [],
          removedRows: [{ teamId: 'ops', tasks: 1, points: 6, averagePoints: 6 }]
        });
        expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
        expect(deletedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'removed',
            row: { teamId: 'ops', tasks: 1, points: 6, averagePoints: 6 }
          })
        ]);
        expect(materializedRowsForQuery(withoutOpsOwner, joinedRollups)).toEqual(deletedChange.rows);
      });

      it('incrementally maintains aggregate over leftJoin unmatched and matched right-row transitions', () => {
        const leftJoinedRollups = leftJoinedUserTeamRollupsQuery();
        const state = mat(createDb(sourceData), leftJoinedRollups, {
          id: 'left-joined-user-team-rollups',
          mode: 'incremental'
        });
        const supportTeam: TeamRow = { id: 'missing', name: 'Support', rank: 5 };
        const withSupport = createDb({
          ...sourceData,
          teams: [...sourceData.teams, supportTeam]
        });

        const inserted = maintainMaterializations(state, withSupport, {
          deltas: [teamsDelta([supportTeam], [])]
        });
        const insertedChange = singleMaterializationChange(inserted, 'left-joined-user-team-rollups');

        expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(insertedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['teams'],
          rows: [
            { teamId: 'eng', users: 1, matchedTeams: 1 },
            { teamId: 'design', users: 1, matchedTeams: 1 },
            { teamId: 'missing', users: 1, matchedTeams: 1 }
          ],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
        expect(insertedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'missing', users: 1, matchedTeams: 0 },
            after: { teamId: 'missing', users: 1, matchedTeams: 1 }
          })
        ]);
        expect(materializedRowsForQuery(withSupport, leftJoinedRollups)).toEqual(insertedChange.rows);

        const withoutDesign = createDb({
          ...sourceData,
          teams: [engineeringTeam, supportTeam]
        });
        const deleted = maintainMaterializations(withSupport, withoutDesign, {
          deltas: [teamsDelta([], [designTeam])]
        });
        const deletedChange = singleMaterializationChange(deleted, 'left-joined-user-team-rollups');

        expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(deletedChange).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['teams'],
          rows: [
            { teamId: 'eng', users: 1, matchedTeams: 1 },
            { teamId: 'design', users: 1, matchedTeams: 0 },
            { teamId: 'missing', users: 1, matchedTeams: 1 }
          ],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
        expect(deletedChange.rowChanges).toEqual([
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'design', users: 1, matchedTeams: 1 },
            after: { teamId: 'design', users: 1, matchedTeams: 0 }
          })
        ]);
        expect(materializedRowsForQuery(withoutDesign, leftJoinedRollups)).toEqual(deletedChange.rows);
      });

      it('updates both old and new aggregate groups when a joined root row moves group', () => {
        const joinedRollups = joinedTaskOwnerTeamRollupsQuery();
        const state = mat(createDb(sourceData), joinedRollups, {
          id: 'joined-task-owner-team-rollups',
          mode: 'incremental'
        });
        const movedShipRuntimeTask = { ...shipRuntimeTask, ownerId: 'bea', points: 4 };
        const next = createDb({
          ...sourceData,
          tasks: [draftEvaluatorTask, movedShipRuntimeTask, reviewFixturesTask]
        });

        const maintained = maintainMaterializations(state, next, {
          deltas: [tasksDelta([movedShipRuntimeTask], [shipRuntimeTask])]
        });
        const change = singleMaterializationChange(maintained, 'joined-task-owner-team-rollups');

        expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(change).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['tasks'],
          rows: [
            { teamId: 'eng', tasks: 1, points: 5, averagePoints: 5 },
            { teamId: 'design', tasks: 2, points: 7, averagePoints: 3.5 }
          ],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
        expect(change.rowChanges).toHaveLength(2);
        expect(change.rowChanges).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'eng', tasks: 2, points: 13, averagePoints: 6.5 },
            after: { teamId: 'eng', tasks: 1, points: 5, averagePoints: 5 }
          }),
          expect.objectContaining({
            kind: 'updated',
            before: { teamId: 'design', tasks: 1, points: 3, averagePoints: 3 },
            after: { teamId: 'design', tasks: 2, points: 7, averagePoints: 3.5 }
          })
        ]));
        expect(materializedRowsForQuery(next, joinedRollups)).toEqual(change.rows);
      });

      it('incrementally maintains row-winner aggregates over joined rows', () => {
        const joinedWinners = joinedTaskOwnerWinnersQuery();
        const state = mat(createDb(sourceData), joinedWinners, {
          id: 'joined-task-owner-winners',
          mode: 'incremental'
        });
        const metadata = materializationForQuery(state, joinedWinners);
        const initialSummaries: readonly JoinedTaskOwnerWinnerSummary[] = [
          {
            teamId: 'eng',
            maxTask: 't2',
            maxOwner: 'ada',
            topTask: ['t2'],
            topOwner: ['ada']
          },
          {
            teamId: 'design',
            maxTask: 't3',
            maxOwner: 'bea',
            topTask: ['t3'],
            topOwner: ['bea']
          }
        ];
        const insertedWinnerTask: TaskRow = {
          id: 't4',
          ownerId: 'bea',
          title: 'Win joined aggregate',
          done: false,
          points: 9
        };
        const withInsertedWinner = createDb({
          ...sourceData,
          tasks: [...sourceData.tasks, insertedWinnerTask]
        });
        const updatedSummaries: readonly JoinedTaskOwnerWinnerSummary[] = [
          initialSummaries[0]!,
          {
            teamId: 'design',
            maxTask: 't4',
            maxOwner: 'bea',
            topTask: ['t4'],
            topOwner: ['bea']
          }
        ];

        expect(metadata).toMatchObject({
          id: 'joined-task-owner-winners',
          requestedMode: 'incremental',
          maintenance: 'incremental'
        });
        expectNoIncrementalFallback(metadata?.diagnostics ?? []);
        expect(joinedTaskOwnerWinnerSummaries(materializedRowsForQuery(state, joinedWinners) ?? [])).toEqual(
          initialSummaries
        );

        const maintained = maintainMaterializations(state, withInsertedWinner, {
          deltas: [tasksDelta([insertedWinnerTask], [])]
        });
        const change = singleMaterializationChange(maintained, 'joined-task-owner-winners') as
          MaterializationMaintenanceResult<JoinedTaskOwnerWinnerRow>['changes'][number];

        expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
        expect(change).toMatchObject({
          maintenance: 'incremental',
          recomputed: false,
          touchedDependencies: ['tasks'],
          addedRows: [],
          removedRows: []
        });
        expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
        expect(joinedTaskOwnerWinnerSummaries(change.rows)).toEqual(updatedSummaries);
        expect(change.rowChanges).toHaveLength(1);

        const rowChange = change.rowChanges[0];
        if (rowChange?.kind !== 'updated') {
          throw new Error('expected a single updated joined winner aggregate row change');
        }
        expect(joinedTaskOwnerWinnerSummaries([rowChange.before])).toEqual([initialSummaries[1]]);
        expect(joinedTaskOwnerWinnerSummaries([rowChange.after])).toEqual([updatedSummaries[1]]);
        expect(materializedRowsForQuery(withInsertedWinner, joinedWinners)).toEqual(change.rows);
      });
    });
  });

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

  it('reports zero row changes for conservative no-net root deltas', () => {
    const activeUsers = activeUsersQuery();
    const state = mat(createDb(sourceData), activeUsers, { id: 'active-users', mode: 'incremental' });
    const next = createDb(sourceData);

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([adaUser], [adaUser])]
    });
    const change = singleMaterializationChange(maintained, 'active-users');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 1, skipped: 0 });
    expect(change).toMatchObject({
      update: 'carried',
      maintenance: 'incremental',
      recomputed: true,
      addedRows: [],
      removedRows: [],
      rowChanges: []
    });
    expectIncrementalFallback(change.diagnostics);
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

  it('supports env expressions in incremental materializations under stable env', async () => {
    const adultUsers = minimumAgeUsersQuery();
    const state = mat(
      createDb(sourceData, { env: { minimumAge: 30 } }),
      adultUsers,
      { id: 'adult-users', mode: 'incremental' }
    );
    const metadata = materializationForQuery(state, adultUsers);

    expect(metadata).toMatchObject({
      id: 'adult-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users'],
      envDependencies: ['minimumAge']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    await expect(qRows(state, adultUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada', minimumAge: 30 },
      { id: 'cal', name: 'Cal', minimumAge: 30 }
    ]);

    const adultDia = { ...diaUser, age: 32 };
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, adultDia]
    }, { env: { minimumAge: 30 } });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([adultDia], [])]
    });
    const change = singleMaterializationChange(maintained, 'adult-users');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      touchedEnvDependencies: [],
      rows: [
        { id: 'ada', name: 'Ada', minimumAge: 30 },
        { id: 'cal', name: 'Cal', minimumAge: 30 },
        { id: 'dia', name: 'Dia', minimumAge: 30 }
      ],
      addedRows: [{ id: 'dia', name: 'Dia', minimumAge: 30 }]
    });
    expectNoIncrementalFallback(change.diagnostics);
    expect(materializedRowsForQuery(next, adultUsers)).toEqual([
      { id: 'ada', name: 'Ada', minimumAge: 30 },
      { id: 'cal', name: 'Cal', minimumAge: 30 },
      { id: 'dia', name: 'Dia', minimumAge: 30 }
    ]);
  });

  it('refreshes env-dependent materializations when withEnv and updateEnv change env', async () => {
    const adultUsers = minimumAgeUsersQuery();
    const state = mat(
      createDb(sourceData, { env: { minimumAge: 30 } }),
      adultUsers,
      { id: 'adult-users', mode: 'incremental' }
    );
    const directlyRaised = createDb(sourceData, { env: { minimumAge: 38 } });
    const maintained = maintainMaterializations(state, directlyRaised, { deltas: [] });
    const change = singleMaterializationChange(maintained, 'adult-users');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 1, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: true,
      touchedDependencies: [],
      touchedEnvDependencies: ['minimumAge'],
      rows: [{ id: 'cal', name: 'Cal', minimumAge: 38 }]
    });
    expectNoIncrementalFallback(change.diagnostics);

    const raised = withEnv(state, { minimumAge: 38 });
    expect(materializedRowsForQuery(raised, adultUsers)).toEqual([
      { id: 'cal', name: 'Cal', minimumAge: 38 }
    ]);
    await expect(qRows(raised, adultUsers)).resolves.toEqual([
      { id: 'cal', name: 'Cal', minimumAge: 38 }
    ]);

    const lowered = updateEnv(raised, (current) => ({
      ...current,
      minimumAge: 28
    }));
    expect(materializedRowsForQuery(lowered, adultUsers)).toEqual([
      { id: 'ada', name: 'Ada', minimumAge: 28 },
      { id: 'bea', name: 'Bea', minimumAge: 28 },
      { id: 'cal', name: 'Cal', minimumAge: 28 }
    ]);
  });

  it('materializes missing env values the same as normal evaluation', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(
      from(user),
      project({ id: user.id, missing: env<unknown>('missingValue') }),
      keyBy('id')
    );
    const expected = await qRows(createDb(sourceData), query);
    const state = mat(createDb(sourceData), query, {
      id: 'missing-env',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, query);

    expect(metadata).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'incremental',
      envDependencies: ['missingValue']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, query)).toEqual(expected);
    await expect(qRows(state, query)).resolves.toEqual(expected);
  });

  it('incrementally maintains projected sel and sel1 equality-correlated subqueries', () => {
    const userSubqueries = userOpenTasksAndTeamSubqueriesQuery();
    const state = mat(createDb(sourceData), userSubqueries, {
      id: 'user-subqueries',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, userSubqueries);

    expect(metadata).toMatchObject({
      id: 'user-subqueries',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: expect.arrayContaining(['users', 'tasks', 'teams'])
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, userSubqueries)).toEqual([
      {
        id: 'ada',
        name: 'Ada',
        openTasks: [{ title: 'Draft evaluator' }],
        team: { name: 'Engineering' }
      },
      {
        id: 'bea',
        name: 'Bea',
        openTasks: [{ title: 'Review fixtures' }],
        team: { name: 'Design' }
      },
      {
        id: 'cal',
        name: 'Cal',
        openTasks: [],
        team: undefined
      }
    ]);

    const renamedAdaTask: TaskRow = {
      ...draftEvaluatorTask,
      title: 'Draft incremental evaluator'
    };
    const renamedEngineeringTeam: TeamRow = {
      ...engineeringTeam,
      name: 'Platform Engineering'
    };
    const next = createDb({
      ...sourceData,
      teams: [designTeam, renamedEngineeringTeam],
      tasks: [renamedAdaTask, shipRuntimeTask, reviewFixturesTask]
    });
    const maintained = maintainMaterializations(state, next, {
      deltas: [
        tasksDelta([renamedAdaTask], [draftEvaluatorTask]),
        teamsDelta([renamedEngineeringTeam], [engineeringTeam])
      ]
    });
    const change = singleMaterializationChange(maintained, 'user-subqueries');

    expect(maintained).toMatchObject({ recomputed: 0 });
    expect(change).toMatchObject({ maintenance: 'incremental', recomputed: false });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'updated',
        before: {
          id: 'ada',
          name: 'Ada',
          openTasks: [{ title: 'Draft evaluator' }],
          team: { name: 'Engineering' }
        },
        after: {
          id: 'ada',
          name: 'Ada',
          openTasks: [{ title: 'Draft incremental evaluator' }],
          team: { name: 'Platform Engineering' }
        }
      })
    ]);
    expect(materializedRowsForQuery(next, userSubqueries)).toEqual(change.rows);
  });

  it('incrementally maintains predicates that read sel1 equality-correlated subqueries', () => {
    const usersWithOpenTasks = usersWithAnyOpenTaskSubqueryQuery();
    const state = mat(createDb(sourceData), usersWithOpenTasks, {
      id: 'users-with-open-tasks',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, usersWithOpenTasks);

    expect(metadata).toMatchObject({
      id: 'users-with-open-tasks',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: expect.arrayContaining(['users', 'tasks'])
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, usersWithOpenTasks)).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);

    const completedAdaTask: TaskRow = {
      ...draftEvaluatorTask,
      done: true
    };
    const next = createDb({
      ...sourceData,
      tasks: [completedAdaTask, shipRuntimeTask, reviewFixturesTask]
    });
    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta([completedAdaTask], [draftEvaluatorTask])]
    });
    const change = singleMaterializationChange(maintained, 'users-with-open-tasks');

    expect(maintained).toMatchObject({ recomputed: 0 });
    expect(change).toMatchObject({ maintenance: 'incremental', recomputed: false });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'removed',
        row: { id: 'ada', name: 'Ada' }
      })
    ]);
    expect(materializedRowsForQuery(next, usersWithOpenTasks)).toEqual(change.rows);
  });

  it('keeps unsupported non-equality correlated subqueries on snapshot fallback', () => {
    const user = as(coreSchema.users, 'user');
    const task = as(coreSchema.tasks, 'task');
    const largeTasksForUser = pipe(
      from(task),
      where(gt(task.points, user.age)),
      project({ title: task.title })
    );
    const query = pipe(
      from(user),
      project({ id: user.id, task: sel1(largeTasksForUser) }),
      keyBy('id')
    );
    const state = mat(createDb(sourceData), query, {
      id: 'non-equality-subquery',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, query);

    expect(metadata).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expect(metadata?.maintenanceReason).toContain('non-equality correlated subquery');
    expectIncrementalFallback(metadata?.diagnostics ?? []);
  });

  it('marks requested sortLimit materialization as incremental for supported keyed shapes', () => {
    const topUsers = topUsersByAgeQuery();
    const state = mat(createDb(sourceData), topUsers, { id: 'top-users', mode: 'incremental' });
    const metadata = materializationForQuery(state, topUsers);

    expect(metadata).toMatchObject({
      id: 'top-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, topUsers)).toEqual([
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 }
    ]);
  });

  it('incrementally maintains sortLimit window inserts, deletes, visible updates, and non-visible updates', () => {
    const topUsers = topUsersByAgeQuery();
    const state = mat(createDb(sourceData), topUsers, { id: 'top-users', mode: 'incremental' });
    const eliUser: UserRow = {
      id: 'eli',
      teamId: 'eng',
      name: 'Eli',
      active: true,
      age: 45,
      tags: []
    };

    const insertedNext = createDb({ ...sourceData, users: [...sourceData.users, eliUser] });
    const inserted = maintainMaterializations(state, insertedNext, {
      deltas: [usersDelta([eliUser], [])]
    });
    const insertChange = expectIncrementalMaintenance(inserted, 'top-users');

    expect(insertChange.rows).toEqual([
      { id: 'eli', name: 'Eli', age: 45 },
      { id: 'cal', name: 'Cal', age: 41 }
    ]);
    expect(insertChange.addedRows).toEqual([{ id: 'eli', name: 'Eli', age: 45 }]);
    expect(insertChange.removedRows).toEqual([{ id: 'ada', name: 'Ada', age: 37 }]);
    expect(insertChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 'ada', name: 'Ada', age: 37 } }),
      expect.objectContaining({ kind: 'added', row: { id: 'eli', name: 'Eli', age: 45 } })
    ]));

    const deleteWinnerNext = createDb({ ...sourceData, users: [adaUser, beaUser] });
    const deleted = maintainMaterializations(state, deleteWinnerNext, {
      deltas: [usersDelta([], [calUser])]
    });
    const deleteChange = expectIncrementalMaintenance(deleted, 'top-users');

    expect(deleteChange.rows).toEqual([
      { id: 'ada', name: 'Ada', age: 37 },
      { id: 'bea', name: 'Bea', age: 29 }
    ]);
    expect(deleteChange.addedRows).toEqual([{ id: 'bea', name: 'Bea', age: 29 }]);
    expect(deleteChange.removedRows).toEqual([{ id: 'cal', name: 'Cal', age: 41 }]);
    expect(deleteChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 'cal', name: 'Cal', age: 41 } }),
      expect.objectContaining({ kind: 'added', row: { id: 'bea', name: 'Bea', age: 29 } })
    ]));

    const updatedAda = { ...adaUser, name: 'Ada Visible', age: 38 };
    const visibleUpdateNext = createDb({ ...sourceData, users: [updatedAda, beaUser, calUser] });
    const visibleUpdated = maintainMaterializations(state, visibleUpdateNext, {
      deltas: [usersDelta([updatedAda], [adaUser])]
    });
    const visibleUpdateChange = expectIncrementalMaintenance(visibleUpdated, 'top-users');

    expect(visibleUpdateChange.rows).toEqual([
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada Visible', age: 38 }
    ]);
    expect(visibleUpdateChange.addedRows).toEqual([]);
    expect(visibleUpdateChange.removedRows).toEqual([]);
    expect(visibleUpdateChange.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', age: 37 },
        after: { id: 'ada', name: 'Ada Visible', age: 38 }
      })
    ]);

    const updatedBea = { ...beaUser, name: 'Bea Outside', age: 30 };
    const nonVisibleUpdateNext = createDb({ ...sourceData, users: [adaUser, updatedBea, calUser] });
    const nonVisibleUpdated = maintainMaterializations(state, nonVisibleUpdateNext, {
      deltas: [usersDelta([updatedBea], [beaUser])]
    });
    const nonVisibleUpdateChange = expectIncrementalMaintenance(nonVisibleUpdated, 'top-users');

    expect(nonVisibleUpdateChange.rows).toEqual([
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 }
    ]);
    expect(nonVisibleUpdateChange.addedRows).toEqual([]);
    expect(nonVisibleUpdateChange.removedRows).toEqual([]);
    expect(nonVisibleUpdateChange.rowChanges).toEqual([]);
  });

  it('incrementally maintains sortLimit when the sort field is projected away', () => {
    const topUserNames = topUserNamesByAgeQuery();
    const state = mat(createDb(sourceData), topUserNames, { id: 'top-user-names', mode: 'incremental' });
    const metadata = materializationForQuery(state, topUserNames);
    const eliUser: UserRow = {
      id: 'eli',
      teamId: 'eng',
      name: 'Eli',
      active: true,
      age: 45,
      tags: []
    };
    const next = createDb({ ...sourceData, users: [...sourceData.users, eliUser] });

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, topUserNames)).toEqual([
      { id: 'cal', name: 'Cal' },
      { id: 'ada', name: 'Ada' }
    ]);

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([eliUser], [])]
    });
    const change = expectIncrementalMaintenance(maintained, 'top-user-names');

    expect(change.rows).toEqual([
      { id: 'eli', name: 'Eli' },
      { id: 'cal', name: 'Cal' }
    ]);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 'ada', name: 'Ada' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'eli', name: 'Eli' } })
    ]));
  });

  it('incrementally maintains full sort insert, update, and delete deltas without reporting every row', async () => {
    const data = largeCoreData();
    const sortedTasks = sortedTasksByPointsQuery();
    const state = mat(createDb(data), sortedTasks, { id: 'sorted-tasks', mode: 'incremental' });
    const metadata = materializationForQuery(state, sortedTasks);
    const taskToUpdate = data.tasks[123]!;
    const taskToDelete = data.tasks[456]!;
    const updatedTask = { ...taskToUpdate, title: 'Updated sorted task' };
    const insertedTask: TaskRow = {
      id: 'task-extra-sort',
      ownerId: data.users[0]!.id,
      title: 'Inserted sorted task',
      done: false,
      points: 14
    };
    const next = createDb({
      ...data,
      tasks: [
        ...data.tasks.map((task) => task.id === taskToUpdate.id ? updatedTask : task)
          .filter((task) => task.id !== taskToDelete.id),
        insertedTask
      ]
    });

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);

    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta([updatedTask, insertedTask], [taskToUpdate, taskToDelete])]
    });
    const change = expectIncrementalMaintenance(maintained, 'sorted-tasks');

    expect(change.rowChanges.length).toBeGreaterThanOrEqual(3);
    expect(change.rowChanges.length).toBeLessThan(change.rows.length);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: taskToUpdate.id, title: taskToUpdate.title, points: taskToUpdate.points },
        after: { id: updatedTask.id, title: updatedTask.title, points: updatedTask.points }
      }),
      expect.objectContaining({
        kind: 'removed',
        row: { id: taskToDelete.id, title: taskToDelete.title, points: taskToDelete.points }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { id: insertedTask.id, title: insertedTask.title, points: insertedTask.points }
      })
    ]));
    await expect(qRows(next, sortedTasks)).resolves.toEqual(change.rows);
  });

  it('emits a row change for move-only full-sort reorders and preserves final row order', () => {
    const sortedUserNames = userNamesSortedByAgeQuery();
    const state = mat(createDb(sourceData), sortedUserNames, { id: 'sorted-user-names', mode: 'incremental' });
    const metadata = materializationForQuery(state, sortedUserNames);
    const promotedBea = { ...beaUser, age: 42 };
    const next = createDb({ ...sourceData, users: [adaUser, promotedBea, calUser] });

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(ids(materializedRowsForQuery(state, sortedUserNames))).toEqual(['cal', 'ada', 'bea']);

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([promotedBea], [beaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'sorted-user-names') as
      MaterializationMaintenanceResult<UserNameRow>['changes'][number];

    expect(ids(change.rows)).toEqual(['bea', 'cal', 'ada']);
    expect(change.rowChanges.length).toBeGreaterThan(0);
    expect(materializedRowsForQuery(next, sortedUserNames)).toEqual(change.rows);
  });

  it('incrementally maintains aggregate output followed by sortLimit', () => {
    const ownerLeaders = ownerRollupLeadersQuery();
    const state = mat(createDb(sourceData), ownerLeaders, { id: 'owner-rollup-leaders', mode: 'incremental' });
    const metadata = materializationForQuery(state, ownerLeaders);
    const beaWinnerTask: TaskRow = {
      id: 't4',
      ownerId: 'bea',
      title: 'Win aggregate window',
      done: false,
      points: 20
    };
    const next = createDb({ ...sourceData, tasks: [...sourceData.tasks, beaWinnerTask] });

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, ownerLeaders)).toEqual([
      { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 }
    ]);

    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta([beaWinnerTask], [])]
    });
    const change = expectIncrementalMaintenance(maintained, 'owner-rollup-leaders');

    expect(change.rows).toEqual([
      { projectId: 'bea', tasks: 2, points: 23, averagePoints: 11.5 }
    ]);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { projectId: 'ada', tasks: 2, points: 13, averagePoints: 6.5 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { projectId: 'bea', tasks: 2, points: 23, averagePoints: 11.5 }
      })
    ]));
  });

  it('incrementally maintains a joined query followed by a final sort', () => {
    const sortedTaskOwners = joinedTaskOwnersSortedQuery();
    const state = mat(createDb(sourceData), sortedTaskOwners, { id: 'sorted-task-owners', mode: 'incremental' });
    const metadata = materializationForQuery(state, sortedTaskOwners);
    const promotedReviewTask = { ...reviewFixturesTask, points: 9 };
    const next = createDb({
      ...sourceData,
      tasks: [draftEvaluatorTask, shipRuntimeTask, promotedReviewTask]
    });

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, sortedTaskOwners)).toEqual([
      { id: 't2', title: 'Ship runtime', owner: 'Ada', points: 8 },
      { id: 't1', title: 'Draft evaluator', owner: 'Ada', points: 5 },
      { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 3 }
    ]);

    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta([promotedReviewTask], [reviewFixturesTask])]
    });
    const change = expectIncrementalMaintenance(maintained, 'sorted-task-owners');

    expect(change.rows).toEqual([
      { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 9 },
      { id: 't2', title: 'Ship runtime', owner: 'Ada', points: 8 },
      { id: 't1', title: 'Draft evaluator', owner: 'Ada', points: 5 }
    ]);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 3 },
        after: { id: 't3', title: 'Review fixtures', owner: 'Bea', points: 9 }
      })
    ]));
  });

  it('maintains limit promotion when supported and otherwise reports an explicit fallback diagnostic', async () => {
    const limitedUsers = limitedUserNamesQuery();
    const state = mat(createDb(sourceData), limitedUsers, { id: 'limited-users', mode: 'incremental' });
    const metadata = materializationForQuery(state, limitedUsers);

    if (metadata?.maintenance === 'snapshot') {
      expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'snapshot' });
      expect(metadata.maintenanceReason).toContain('limit');
      expectIncrementalFallback(metadata.diagnostics);
      expect(materializedRowsForQuery(state, limitedUsers)).toEqual([
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' }
      ]);

      const next = transact(state, deleteByKey(coreSchema.users, 'ada'));
      await expect(qRows(next, limitedUsers)).resolves.toEqual([
        { id: 'bea', name: 'Bea' },
        { id: 'cal', name: 'Cal' }
      ]);
      return;
    }

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);

    const next = createDb({ ...sourceData, users: [beaUser, calUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([], [adaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'limited-users');

    expect(change.rows).toEqual([
      { id: 'bea', name: 'Bea' },
      { id: 'cal', name: 'Cal' }
    ]);
    expect(change.addedRows).toEqual([{ id: 'cal', name: 'Cal' }]);
    expect(change.removedRows).toEqual([{ id: 'ada', name: 'Ada' }]);
  });

  it('falls back with diagnostics when the final materialized row keys are duplicated', () => {
    const duplicateUsers = duplicateFinalUserKeysQuery();
    const state = mat(createDb(sourceData), duplicateUsers, { id: 'duplicate-final-user-keys', mode: 'incremental' });
    const metadata = materializationForQuery(state, duplicateUsers);

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'snapshot' });
    expect(metadata?.maintenanceReason).toContain('duplicate');
    expectIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, duplicateUsers)).toEqual([
      { id: 'duplicate', name: 'Ada' },
      { id: 'duplicate', name: 'Bea' },
      { id: 'duplicate', name: 'Cal' }
    ]);
  });

  it('keeps materialized sort ordering in parity with qRows for explicit null placement', async () => {
    const user = as(coreSchema.users, 'user');
    const team = as(coreSchema.teams, 'team');
    const cases = [
      { name: 'asc nulls first', order: asc(team.rank, 'first'), expectedIds: ['cal', 'ada', 'bea'] },
      { name: 'asc nulls last', order: asc(team.rank, 'last'), expectedIds: ['ada', 'bea', 'cal'] },
      { name: 'desc nulls first', order: desc(team.rank, 'first'), expectedIds: ['cal', 'bea', 'ada'] },
      { name: 'desc nulls last', order: desc(team.rank, 'last'), expectedIds: ['bea', 'ada', 'cal'] }
    ] as const;

    for (const testCase of cases) {
      const rankedUsers = pipe(
        from(user),
        leftJoin(from(team), eq(user.teamId, team.id)),
        sort(testCase.order, asc(user.id)),
        project({ id: user.id, rank: maybe(team.rank) }),
        keyBy('id')
      ) as Query<UserRankRow>;
      const db = createDb(sourceData);
      const state = mat(db, rankedUsers, { id: `ranked-users-${testCase.name}`, mode: 'incremental' });
      const evaluatedRows = await qRows(db, rankedUsers);
      const materializedRows = materializedRowsForQuery(state, rankedUsers);

      expect(ids(evaluatedRows)).toEqual(testCase.expectedIds);
      expect(materializedRows).toEqual(evaluatedRows);
    }
  });

  it('incrementally maintains row-local hostCall projection and where expressions', async () => {
    const user = as(coreSchema.users, 'user');
    const ageBand = (age: number) => age >= 30 ? 'senior' : 'junior';
    const seniorOrUndefined = (age: number) => {
      if (age === beaUser.age) {
        throw new Error('expected hostCall test failure');
      }
      return age >= 30;
    };
    const withAgeBand = pipe(
      from(user),
      where(eq(call(seniorOrUndefined, user.age), true)),
      project({
        id: user.id,
        band: call(ageBand, user.age)
      }),
      keyBy('id')
    ) as Query<UserAgeBandRow>;

    const state = mat(createDb(sourceData), withAgeBand, { id: 'age-bands', mode: 'incremental' });
    const metadata = materializationForQuery(state, withAgeBand);

    expect(metadata).toMatchObject({
      id: 'age-bands',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, withAgeBand)).toEqual([
      { id: 'ada', band: 'senior' },
      { id: 'cal', band: 'senior' }
    ]);
    await expect(qRows(state, withAgeBand)).resolves.toEqual([
      { id: 'ada', band: 'senior' },
      { id: 'cal', band: 'senior' }
    ]);

    const updatedBea = { ...beaUser, age: 36 };
    const next = createDb({ ...sourceData, users: [adaUser, updatedBea, calUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedBea], [beaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'age-bands');

    expect(change.rows).toEqual([
      { id: 'ada', band: 'senior' },
      { id: 'bea', band: 'senior' },
      { id: 'cal', band: 'senior' }
    ]);
    expect(change.addedRows).toEqual([{ id: 'bea', band: 'senior' }]);
    expect(change.removedRows).toEqual([]);
    expect(change.rowChanges).toEqual([
      expect.objectContaining({ kind: 'added', row: { id: 'bea', band: 'senior' } })
    ]);
    expect(materializedRowsForQuery(next, withAgeBand)).toEqual(change.rows);
  });

  it('incrementally maintains sort order expressions with row-local hostCall', () => {
    const user = as(coreSchema.users, 'user');
    const ageOnes = (age: number) => age % 10;
    const sortedUsers = pipe(
      from(user),
      sort(asc(call(ageOnes, user.age)), asc(user.id)),
      project({ id: user.id, name: user.name, age: user.age }),
      keyBy('id')
    ) as Query<UserAgeRow>;
    const state = mat(createDb(sourceData), sortedUsers, { id: 'users-by-age-ones', mode: 'incremental' });
    const metadata = materializationForQuery(state, sortedUsers);

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, sortedUsers)).toEqual([
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 },
      { id: 'bea', name: 'Bea', age: 29 }
    ]);

    const updatedBea = { ...beaUser, age: 40 };
    const next = createDb({ ...sourceData, users: [adaUser, updatedBea, calUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedBea], [beaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'users-by-age-ones');

    expect(change.rows).toEqual([
      { id: 'bea', name: 'Bea', age: 40 },
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 }
    ]);
    expect(materializedRowsForQuery(next, sortedUsers)).toEqual(change.rows);
  });

  it('incrementally maintains aggregate hostCall groupBy and input expressions', () => {
    const user = as(coreSchema.users, 'user');
    const decade = field<number>('ageRollup', 'decade');
    const ageDecade = (age: number) => Math.floor(age / 10) * 10;
    const activeScore = (active: boolean) => active ? 1 : 0;
    const ageRollupRows = pipe(
      from(user),
      aggregate({
        groupBy: { decade: call(ageDecade, user.age) },
        aggregates: {
          users: count(),
          activeUsers: sum(call(activeScore, user.active))
        }
      }),
      sort(asc(decade))
    ) as Query<UserAgeDecadeRollupRow>;
    const ageRollups = pipe(ageRollupRows, keyBy('decade')) as Query<UserAgeDecadeRollupRow>;
    const state = mat(createDb(sourceData), ageRollups, { id: 'age-rollups', mode: 'incremental' });
    const metadata = materializationForQuery(state, ageRollups);

    expect(metadata).toMatchObject({ requestedMode: 'incremental', maintenance: 'incremental' });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, ageRollups)).toEqual([
      { decade: 20, users: 1, activeUsers: 1 },
      { decade: 30, users: 1, activeUsers: 1 },
      { decade: 40, users: 1, activeUsers: 0 }
    ]);

    const updatedBea = { ...beaUser, age: 36 };
    const next = createDb({ ...sourceData, users: [adaUser, updatedBea, calUser] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedBea], [beaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'age-rollups');

    expect(change.rows).toEqual([
      { decade: 30, users: 2, activeUsers: 2 },
      { decade: 40, users: 1, activeUsers: 0 }
    ]);
    expect(materializedRowsForQuery(next, ageRollups)).toEqual(change.rows);
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

  it('incrementally maintains aliased self equality joins for inserts, updates, and deletes', () => {
    const userTeammates = userTeammatesByTeamQuery();
    const state = mat(createDb(sourceData), userTeammates, { id: 'user-teammates-by-team', mode: 'incremental' });
    const metadata = materializationForQuery(state, userTeammates);

    expect(metadata).toMatchObject({
      id: 'user-teammates-by-team',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(['users']);
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, userTeammates)).toEqual([
      { employeeId: 'ada', teammateId: 'ada', employee: 'Ada', teammate: 'Ada', teamId: 'eng' },
      { employeeId: 'bea', teammateId: 'bea', employee: 'Bea', teammate: 'Bea', teamId: 'design' },
      { employeeId: 'cal', teammateId: 'cal', employee: 'Cal', teammate: 'Cal', teamId: 'missing' }
    ]);

    const withDia = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    });
    const inserted = maintainMaterializations(state, withDia, {
      deltas: [usersDelta([diaUser], [])]
    });
    const insertedChange = singleMaterializationChange(inserted, 'user-teammates-by-team');

    expect(inserted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(insertedChange).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { employeeId: 'ada', teammateId: 'ada', employee: 'Ada', teammate: 'Ada', teamId: 'eng' },
        { employeeId: 'ada', teammateId: 'dia', employee: 'Ada', teammate: 'Dia', teamId: 'eng' },
        { employeeId: 'bea', teammateId: 'bea', employee: 'Bea', teammate: 'Bea', teamId: 'design' },
        { employeeId: 'cal', teammateId: 'cal', employee: 'Cal', teammate: 'Cal', teamId: 'missing' },
        { employeeId: 'dia', teammateId: 'ada', employee: 'Dia', teammate: 'Ada', teamId: 'eng' },
        { employeeId: 'dia', teammateId: 'dia', employee: 'Dia', teammate: 'Dia', teamId: 'eng' }
      ],
      addedRows: [
        { employeeId: 'ada', teammateId: 'dia', employee: 'Ada', teammate: 'Dia', teamId: 'eng' },
        { employeeId: 'dia', teammateId: 'ada', employee: 'Dia', teammate: 'Ada', teamId: 'eng' },
        { employeeId: 'dia', teammateId: 'dia', employee: 'Dia', teammate: 'Dia', teamId: 'eng' }
      ],
      removedRows: []
    });
    expectNoIncrementalFallback([...inserted.diagnostics, ...insertedChange.diagnostics]);
    expect(materializedRowsForQuery(withDia, userTeammates)).toEqual(insertedChange.rows);

    const movedDia = { ...diaUser, teamId: 'design' };
    const withMovedDia = createDb({
      ...sourceData,
      users: [adaUser, beaUser, calUser, movedDia]
    });
    const moved = maintainMaterializations(withDia, withMovedDia, {
      deltas: [usersDelta([movedDia], [diaUser])]
    });
    const movedChange = singleMaterializationChange(moved, 'user-teammates-by-team');

    expect(moved).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(movedChange).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { employeeId: 'ada', teammateId: 'ada', employee: 'Ada', teammate: 'Ada', teamId: 'eng' },
        { employeeId: 'bea', teammateId: 'bea', employee: 'Bea', teammate: 'Bea', teamId: 'design' },
        { employeeId: 'bea', teammateId: 'dia', employee: 'Bea', teammate: 'Dia', teamId: 'design' },
        { employeeId: 'cal', teammateId: 'cal', employee: 'Cal', teammate: 'Cal', teamId: 'missing' },
        { employeeId: 'dia', teammateId: 'bea', employee: 'Dia', teammate: 'Bea', teamId: 'design' },
        { employeeId: 'dia', teammateId: 'dia', employee: 'Dia', teammate: 'Dia', teamId: 'design' }
      ],
      addedRows: [
        { employeeId: 'bea', teammateId: 'dia', employee: 'Bea', teammate: 'Dia', teamId: 'design' },
        { employeeId: 'dia', teammateId: 'bea', employee: 'Dia', teammate: 'Bea', teamId: 'design' }
      ],
      removedRows: [
        { employeeId: 'ada', teammateId: 'dia', employee: 'Ada', teammate: 'Dia', teamId: 'eng' },
        { employeeId: 'dia', teammateId: 'ada', employee: 'Dia', teammate: 'Ada', teamId: 'eng' }
      ]
    });
    expectNoIncrementalFallback([...moved.diagnostics, ...movedChange.diagnostics]);
    expect(movedChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { employeeId: 'dia', teammateId: 'dia', employee: 'Dia', teammate: 'Dia', teamId: 'eng' },
        after: { employeeId: 'dia', teammateId: 'dia', employee: 'Dia', teammate: 'Dia', teamId: 'design' }
      })
    ]));
    expect(materializedRowsForQuery(withMovedDia, userTeammates)).toEqual(movedChange.rows);

    const withoutBea = createDb({
      ...sourceData,
      users: [adaUser, calUser, movedDia]
    });
    const deleted = maintainMaterializations(withMovedDia, withoutBea, {
      deltas: [usersDelta([], [beaUser])]
    });
    const deletedChange = singleMaterializationChange(deleted, 'user-teammates-by-team');

    expect(deleted).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(deletedChange).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { employeeId: 'ada', teammateId: 'ada', employee: 'Ada', teammate: 'Ada', teamId: 'eng' },
        { employeeId: 'cal', teammateId: 'cal', employee: 'Cal', teammate: 'Cal', teamId: 'missing' },
        { employeeId: 'dia', teammateId: 'dia', employee: 'Dia', teammate: 'Dia', teamId: 'design' }
      ],
      addedRows: [],
      removedRows: [
        { employeeId: 'bea', teammateId: 'bea', employee: 'Bea', teammate: 'Bea', teamId: 'design' },
        { employeeId: 'bea', teammateId: 'dia', employee: 'Bea', teammate: 'Dia', teamId: 'design' },
        { employeeId: 'dia', teammateId: 'bea', employee: 'Dia', teammate: 'Bea', teamId: 'design' }
      ]
    });
    expectNoIncrementalFallback([...deleted.diagnostics, ...deletedChange.diagnostics]);
    expect(materializedRowsForQuery(withoutBea, userTeammates)).toEqual(deletedChange.rows);
  });

  it('keeps same-alias self joins on snapshot fallback', () => {
    const sameAliasSelfJoin = sameAliasUserSelfJoinQuery();
    const state = mat(createDb(sourceData), sameAliasSelfJoin, {
      id: 'same-alias-user-self-join',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, sameAliasSelfJoin);

    expect(metadata).toMatchObject({
      id: 'same-alias-user-self-join',
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expectIncrementalFallback(metadata?.diagnostics ?? []);
    expect(metadata?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'materialization_incremental_fallback',
        detail: expect.objectContaining({
          reason: expect.stringContaining('ambiguous join field or alias shapes')
        })
      })
    ]));
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

  it('reports a single row change for large two-join root inserts', () => {
    const data = largeCoreData();
    const taskOwnerTeams = taskOwnerTeamQuery();
    const state = mat(createDb(data), taskOwnerTeams, {
      id: 'large-task-owner-teams',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, taskOwnerTeams);
    const owner = data.users[13]!;
    const team = requiredRow(data.teams, (row) => row.id === owner.teamId, owner.teamId);
    const extraTask: TaskRow = {
      id: 'task-extra-root-insert',
      ownerId: owner.id,
      title: 'Inserted task',
      done: false,
      points: 9
    };
    const next = createDb({
      ...data,
      tasks: [...data.tasks, extraTask]
    });
    const expected = taskOwnerTeamRow(extraTask, owner, team);

    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta([extraTask], [])]
    });
    const change = singleMaterializationChange(maintained, 'large-task-owner-teams') as
      MaterializationMaintenanceResult<TaskOwnerTeamRow>['changes'][number];

    expect(metadata).toMatchObject({
      id: 'large-task-owner-teams',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users', 'teams']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expectNoIncrementalFallback(maintained.diagnostics);
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['tasks'],
      addedRows: [expected],
      removedRows: []
    });
    expectNoIncrementalFallback(change.diagnostics);
    expect(change.rowChanges).toHaveLength(1);
    expect(change.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'added',
        row: expected
      })
    ]);
    expect(change.rows).toHaveLength(data.tasks.length + 1);
    expect(materializedRowsForQuery(next, taskOwnerTeams)).toEqual(change.rows);
  });

  it('reports only affected rows for large two-join right-side owner updates', () => {
    const data = largeCoreData();
    const taskOwnerTeams = taskOwnerTeamQuery();
    const owner = data.users[37]!;
    const updatedOwner = { ...owner, name: 'Updated Owner' };
    const team = requiredRow(data.teams, (row) => row.id === owner.teamId, owner.teamId);
    const ownerTasks = data.tasks.filter((task) => task.ownerId === owner.id);
    const state = mat(createDb(data), taskOwnerTeams, {
      id: 'large-task-owner-teams',
      mode: 'incremental'
    });
    const next = createDb({
      ...data,
      users: data.users.map((user) => user.id === owner.id ? updatedOwner : user)
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedOwner], [owner])]
    });
    const change = singleMaterializationChange(maintained, 'large-task-owner-teams') as
      MaterializationMaintenanceResult<TaskOwnerTeamRow>['changes'][number];

    expect(ownerTasks.length).toBeGreaterThan(1);
    expect(ownerTasks.length).toBeLessThan(data.tasks.length);
    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expectNoIncrementalFallback(maintained.diagnostics);
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      addedRows: [],
      removedRows: []
    });
    expectNoIncrementalFallback(change.diagnostics);
    expect(change.rowChanges).toHaveLength(ownerTasks.length);
    expect(change.rowChanges.length).toBeLessThan(change.rows.length);
    expect(change.rowChanges).toEqual(expect.arrayContaining(
      ownerTasks.slice(0, 3).map((task) => expect.objectContaining({
        kind: 'updated',
        before: taskOwnerTeamRow(task, owner, team),
        after: taskOwnerTeamRow(task, updatedOwner, team)
      }))
    ));
    expect(new Set(change.rowChanges.flatMap((rowChange) => (
      rowChange.kind === 'updated' ? [rowChange.after.id] : []
    )))).toEqual(new Set(ownerTasks.map((task) => task.id)));
    expect(materializedRowsForQuery(next, taskOwnerTeams)).toEqual(change.rows);
  });

  it('delivers delta-first rowChanges for large watched two-join queries', async () => {
    const data = largeCoreData();
    const taskOwnerTeams = taskOwnerTeamQuery();
    const owner = data.users[37]!;
    const updatedOwner = { ...owner, name: 'Watched Owner' };
    const team = requiredRow(data.teams, (row) => row.id === owner.teamId, owner.teamId);
    const ownerTasks = data.tasks.filter((task) => task.ownerId === owner.id);
    const state = mat(createDb(data), taskOwnerTeams, {
      id: 'large-task-owner-teams',
      mode: 'incremental'
    });
    const next = createDb({
      ...data,
      users: data.users.map((user) => user.id === owner.id ? updatedOwner : user)
    });
    const delta = usersDelta([updatedOwner], [owner]);
    const materializedNext = next as typeof state;
    const materializations = maintainMaterializations(state, materializedNext, { deltas: [delta] });
    const materializedChange = singleMaterializationChange(materializations, 'large-task-owner-teams') as
      MaterializationMaintenanceResult<TaskOwnerTeamRow>['changes'][number];
    const events: Array<WatchEvent<TaskOwnerTeamRow>> = [];
    const handle = watch(state, taskOwnerTeams, (event) => {
      events.push(event);
    });

    const tracked = await trackTransact(state, () => ({
      db: materializedNext,
      deltas: [delta],
      materializations
    }));

    expect(ownerTasks.length).toBeGreaterThan(1);
    expect(ownerTasks.length).toBeLessThan(data.tasks.length);
    expect(tracked.materializations).toBe(materializations);
    expect(materializedChange).toMatchObject({
      update: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      addedRows: [],
      removedRows: []
    });
    expectNoIncrementalFallback(tracked.diagnostics);
    expectNoIncrementalFallback(materializedChange.diagnostics);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: true,
      addedRows: [],
      removedRows: []
    });
    expectNoIncrementalFallback(events[0]?.diagnostics ?? []);
    expect(events[0]?.rowChanges).toHaveLength(ownerTasks.length);
    expect(events[0]?.rowChanges.length).toBeLessThan(events[0]?.rows.length ?? 0);
    expect(events[0]?.rowChanges).toEqual(expect.arrayContaining([...materializedChange.rowChanges]));
    expect(events[0]?.rowChanges).toEqual(expect.arrayContaining(
      ownerTasks.slice(0, 3).map((task) => expect.objectContaining({
        kind: 'updated',
        before: taskOwnerTeamRow(task, owner, team),
        after: taskOwnerTeamRow(task, updatedOwner, team)
      }))
    ));
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
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

  it('incrementally maintains a join whose right branch expands rows', () => {
    const taskOwnerTags = taskOwnerTagsViaRightExpandQuery();
    const state = mat(createDb(sourceData), taskOwnerTags, {
      id: 'task-owner-tags-right-expand',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, taskOwnerTags);

    expect(metadata).toMatchObject({
      id: 'task-owner-tags-right-expand',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, taskOwnerTags)).toEqual([
      { id: 't1', ownerId: 'ada', tag: 'compiler' },
      { id: 't1', ownerId: 'ada', tag: 'runtime' },
      { id: 't2', ownerId: 'ada', tag: 'compiler' },
      { id: 't2', ownerId: 'ada', tag: 'runtime' },
      { id: 't3', ownerId: 'bea', tag: 'research' }
    ]);

    const updatedAda = { ...adaUser, tags: ['runtime', 'logic'] };
    const next = createDb({
      ...sourceData,
      users: [updatedAda, beaUser, calUser]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda], [adaUser])]
    });
    const change = singleMaterializationChange(maintained, 'task-owner-tags-right-expand');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { id: 't1', ownerId: 'ada', tag: 'runtime' },
        { id: 't1', ownerId: 'ada', tag: 'logic' },
        { id: 't2', ownerId: 'ada', tag: 'runtime' },
        { id: 't2', ownerId: 'ada', tag: 'logic' },
        { id: 't3', ownerId: 'bea', tag: 'research' }
      ],
      addedRows: [
        { id: 't1', ownerId: 'ada', tag: 'logic' },
        { id: 't2', ownerId: 'ada', tag: 'logic' }
      ],
      removedRows: [
        { id: 't1', ownerId: 'ada', tag: 'compiler' },
        { id: 't2', ownerId: 'ada', tag: 'compiler' }
      ]
    });
    expect(change.rowChanges).toHaveLength(4);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 't1', ownerId: 'ada', tag: 'compiler' } }),
      expect.objectContaining({ kind: 'removed', row: { id: 't2', ownerId: 'ada', tag: 'compiler' } }),
      expect.objectContaining({ kind: 'added', row: { id: 't1', ownerId: 'ada', tag: 'logic' } }),
      expect.objectContaining({ kind: 'added', row: { id: 't2', ownerId: 'ada', tag: 'logic' } })
    ]));
    expect(materializedRowsForQuery(next, taskOwnerTags)).toEqual(change.rows);
  });

  it('incrementally maintains a join whose right branch uses a static set filter', () => {
    const taskActiveOwners = taskActiveOwnersViaRightStaticFilterQuery();
    const calTask: TaskRow = {
      id: 't-cal',
      ownerId: 'cal',
      title: 'Cal onboarding',
      done: false,
      points: 2
    };
    const initial = createDb({
      ...sourceData,
      tasks: [...sourceData.tasks, calTask]
    });
    const state = mat(initial, taskActiveOwners, {
      id: 'task-active-owners-right-static-filter',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, taskActiveOwners);

    expect(metadata).toMatchObject({
      id: 'task-active-owners-right-static-filter',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, taskActiveOwners)).toEqual([
      { id: 't1', ownerId: 'ada', title: 'Draft evaluator' },
      { id: 't2', ownerId: 'ada', title: 'Ship runtime' }
    ]);

    const inactiveAda = { ...adaUser, active: false };
    const activeCal = { ...calUser, active: true };
    const next = createDb({
      ...sourceData,
      users: [inactiveAda, beaUser, activeCal],
      tasks: [...sourceData.tasks, calTask]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([inactiveAda, activeCal], [adaUser, calUser])]
    });
    const change = singleMaterializationChange(maintained, 'task-active-owners-right-static-filter');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { id: 't-cal', ownerId: 'cal', title: 'Cal onboarding' }
      ],
      addedRows: [
        { id: 't-cal', ownerId: 'cal', title: 'Cal onboarding' }
      ],
      removedRows: [
        { id: 't1', ownerId: 'ada', title: 'Draft evaluator' },
        { id: 't2', ownerId: 'ada', title: 'Ship runtime' }
      ]
    });
    expect(change.rowChanges).toHaveLength(3);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 't1', ownerId: 'ada', title: 'Draft evaluator' } }),
      expect.objectContaining({ kind: 'removed', row: { id: 't2', ownerId: 'ada', title: 'Ship runtime' } }),
      expect.objectContaining({ kind: 'added', row: { id: 't-cal', ownerId: 'cal', title: 'Cal onboarding' } })
    ]));
    expect(materializedRowsForQuery(next, taskActiveOwners)).toEqual(change.rows);
  });

  it('incrementally maintains a join whose right branch uses aggregate', () => {
    const userTaskRollups = usersWithTaskRollupsRightAggregateQuery();
    const state = mat(createDb(sourceData), userTaskRollups, {
      id: 'user-task-rollups-right-aggregate',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, userTaskRollups);

    expect(metadata).toMatchObject({
      id: 'user-task-rollups-right-aggregate',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['users', 'tasks']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, userTaskRollups)).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskCount: 2, totalPoints: 13 },
      { ownerId: 'bea', owner: 'Bea', taskCount: 1, totalPoints: 3 }
    ]);

    const adaTask: TaskRow = {
      id: 't4',
      ownerId: 'ada',
      title: 'Add right branch aggregate work',
      done: false,
      points: 2
    };
    const withAdaTask = createDb({
      ...sourceData,
      tasks: [...sourceData.tasks, adaTask]
    });
    const inserted = maintainMaterializations(state, withAdaTask, {
      deltas: [tasksDelta([adaTask], [])]
    });
    const insertedChange = expectIncrementalMaintenance(inserted, 'user-task-rollups-right-aggregate');

    expect(insertedChange).toMatchObject({
      touchedDependencies: ['tasks'],
      rows: [
        { ownerId: 'ada', owner: 'Ada', taskCount: 3, totalPoints: 15 },
        { ownerId: 'bea', owner: 'Bea', taskCount: 1, totalPoints: 3 }
      ],
      addedRows: [],
      removedRows: []
    });
    expect(insertedChange.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'updated',
        before: { ownerId: 'ada', owner: 'Ada', taskCount: 2, totalPoints: 13 },
        after: { ownerId: 'ada', owner: 'Ada', taskCount: 3, totalPoints: 15 }
      })
    ]);
    expect(materializedRowsForQuery(withAdaTask, userTaskRollups)).toEqual(insertedChange.rows);

    const movedDraftTask = { ...draftEvaluatorTask, ownerId: 'bea' };
    const withMovedTask = createDb({
      ...sourceData,
      tasks: [movedDraftTask, shipRuntimeTask, reviewFixturesTask]
    });
    const moved = maintainMaterializations(state, withMovedTask, {
      deltas: [tasksDelta([movedDraftTask], [draftEvaluatorTask])]
    });
    const movedChange = expectIncrementalMaintenance(moved, 'user-task-rollups-right-aggregate');

    expect(movedChange).toMatchObject({
      touchedDependencies: ['tasks'],
      rows: [
        { ownerId: 'ada', owner: 'Ada', taskCount: 1, totalPoints: 8 },
        { ownerId: 'bea', owner: 'Bea', taskCount: 2, totalPoints: 8 }
      ],
      addedRows: [],
      removedRows: []
    });
    expect(movedChange.rowChanges).toHaveLength(2);
    expect(movedChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { ownerId: 'ada', owner: 'Ada', taskCount: 2, totalPoints: 13 },
        after: { ownerId: 'ada', owner: 'Ada', taskCount: 1, totalPoints: 8 }
      }),
      expect.objectContaining({
        kind: 'updated',
        before: { ownerId: 'bea', owner: 'Bea', taskCount: 1, totalPoints: 3 },
        after: { ownerId: 'bea', owner: 'Bea', taskCount: 2, totalPoints: 8 }
      })
    ]));
    expect(materializedRowsForQuery(withMovedTask, userTaskRollups)).toEqual(movedChange.rows);

    const withoutBeaTasks = createDb({
      ...sourceData,
      tasks: [draftEvaluatorTask, shipRuntimeTask]
    });
    const deleted = maintainMaterializations(state, withoutBeaTasks, {
      deltas: [tasksDelta([], [reviewFixturesTask])]
    });
    const deletedChange = expectIncrementalMaintenance(deleted, 'user-task-rollups-right-aggregate');

    expect(deletedChange).toMatchObject({
      touchedDependencies: ['tasks'],
      rows: [
        { ownerId: 'ada', owner: 'Ada', taskCount: 2, totalPoints: 13 }
      ],
      addedRows: [],
      removedRows: [
        { ownerId: 'bea', owner: 'Bea', taskCount: 1, totalPoints: 3 }
      ]
    });
    expect(deletedChange.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'removed',
        row: { ownerId: 'bea', owner: 'Bea', taskCount: 1, totalPoints: 3 }
      })
    ]);
    expect(materializedRowsForQuery(withoutBeaTasks, userTaskRollups)).toEqual(deletedChange.rows);
  });

  it('incrementally maintains a join whose right branch uses sortLimit', () => {
    const userTopTasks = usersWithGlobalTopTasksRightSortLimitQuery(2);
    const state = mat(createDb(sourceData), userTopTasks, {
      id: 'user-global-top-tasks-right-sort-limit',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, userTopTasks);

    expect(metadata).toMatchObject({
      id: 'user-global-top-tasks-right-sort-limit',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['users', 'tasks']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, userTopTasks)).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
      { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 }
    ]);

    const beaWinnerTask: TaskRow = {
      id: 't4',
      ownerId: 'bea',
      title: 'Win right branch window',
      done: false,
      points: 20
    };
    const insertedWinnerDb = createDb({ ...sourceData, tasks: [...sourceData.tasks, beaWinnerTask] });
    const insertedWinner = maintainMaterializations(state, insertedWinnerDb, {
      deltas: [tasksDelta([beaWinnerTask], [])]
    });
    const insertedWinnerChange = expectIncrementalMaintenance(
      insertedWinner,
      'user-global-top-tasks-right-sort-limit'
    );

    expect(insertedWinnerChange).toMatchObject({
      touchedDependencies: ['tasks'],
      rows: [
        { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
        { ownerId: 'bea', owner: 'Bea', taskId: 't4', title: 'Win right branch window', points: 20 }
      ],
      addedRows: [
        { ownerId: 'bea', owner: 'Bea', taskId: 't4', title: 'Win right branch window', points: 20 }
      ],
      removedRows: [
        { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 }
      ]
    });
    expect(insertedWinnerChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { ownerId: 'bea', owner: 'Bea', taskId: 't4', title: 'Win right branch window', points: 20 }
      })
    ]));
    expect(materializedRowsForQuery(insertedWinnerDb, userTopTasks)).toEqual(insertedWinnerChange.rows);

    const deletedWinnerDb = createDb({
      ...sourceData,
      tasks: [draftEvaluatorTask, reviewFixturesTask]
    });
    const deletedWinner = maintainMaterializations(state, deletedWinnerDb, {
      deltas: [tasksDelta([], [shipRuntimeTask])]
    });
    const deletedWinnerChange = expectIncrementalMaintenance(
      deletedWinner,
      'user-global-top-tasks-right-sort-limit'
    );

    expect(deletedWinnerChange).toMatchObject({
      touchedDependencies: ['tasks'],
      rows: [
        { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 },
        { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 }
      ],
      addedRows: [
        { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 }
      ],
      removedRows: [
        { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 }
      ]
    });
    expect(deletedWinnerChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 }
      })
    ]));
    expect(materializedRowsForQuery(deletedWinnerDb, userTopTasks)).toEqual(deletedWinnerChange.rows);

    const updatedNonVisibleTask = { ...reviewFixturesTask, title: 'Non-visible update', points: 4 };
    const nonVisibleDb = createDb({
      ...sourceData,
      tasks: [draftEvaluatorTask, shipRuntimeTask, updatedNonVisibleTask]
    });
    const nonVisible = maintainMaterializations(state, nonVisibleDb, {
      deltas: [tasksDelta([updatedNonVisibleTask], [reviewFixturesTask])]
    });
    const nonVisibleChange = expectIncrementalMaintenance(
      nonVisible,
      'user-global-top-tasks-right-sort-limit'
    );

    expect(nonVisibleChange).toMatchObject({
      touchedDependencies: ['tasks'],
      rows: [
        { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
        { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 }
      ],
      addedRows: [],
      removedRows: []
    });
    expect(nonVisibleChange.rowChanges).toEqual([]);
    expect(materializedRowsForQuery(nonVisibleDb, userTopTasks)).toEqual(nonVisibleChange.rows);
  });

  it('incrementally maintains joins whose right branch uses plain sort or standalone limit', () => {
    const sortedTasks = usersWithSortedTasksRightBranchQuery();
    const sortedState = mat(createDb(sourceData), sortedTasks, {
      id: 'user-sorted-tasks-right-branch',
      mode: 'incremental'
    });
    const sortedMetadata = materializationForQuery(sortedState, sortedTasks);

    expect(sortedMetadata).toMatchObject({
      id: 'user-sorted-tasks-right-branch',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(sortedMetadata?.dependencies).toEqual(expect.arrayContaining(['users', 'tasks']));
    expectNoIncrementalFallback(sortedMetadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(sortedState, sortedTasks)).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
      { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 },
      { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 }
    ]);

    const beaWinnerTask: TaskRow = {
      id: 't4',
      ownerId: 'bea',
      title: 'Win sorted branch',
      done: false,
      points: 20
    };
    const sortedNext = createDb({ ...sourceData, tasks: [...sourceData.tasks, beaWinnerTask] });
    const sortedMaintained = maintainMaterializations(sortedState, sortedNext, {
      deltas: [tasksDelta([beaWinnerTask], [])]
    });
    const sortedChange = expectIncrementalMaintenance(sortedMaintained, 'user-sorted-tasks-right-branch');

    expect(sortedChange.rows).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
      { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 },
      { ownerId: 'bea', owner: 'Bea', taskId: 't4', title: 'Win sorted branch', points: 20 },
      { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 }
    ]);
    expect(materializedRowsForQuery(sortedNext, sortedTasks)).toEqual(sortedChange.rows);

    const limitedTasks = usersWithLimitedTasksRightBranchQuery();
    const limitedState = mat(createDb(sourceData), limitedTasks, {
      id: 'user-limited-tasks-right-branch',
      mode: 'incremental'
    });
    const limitedMetadata = materializationForQuery(limitedState, limitedTasks);

    expect(limitedMetadata).toMatchObject({
      id: 'user-limited-tasks-right-branch',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(limitedMetadata?.dependencies).toEqual(expect.arrayContaining(['users', 'tasks']));
    expectNoIncrementalFallback(limitedMetadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(limitedState, limitedTasks)).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 }
    ]);

    const limitedNext = createDb({
      ...sourceData,
      tasks: [shipRuntimeTask, reviewFixturesTask]
    });
    const limitedMaintained = maintainMaterializations(limitedState, limitedNext, {
      deltas: [tasksDelta([], [draftEvaluatorTask])]
    });
    const limitedChange = expectIncrementalMaintenance(limitedMaintained, 'user-limited-tasks-right-branch');

    expect(limitedChange.rows).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 }
    ]);
    expect(limitedChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'removed',
        row: { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 }
      }),
      expect.objectContaining({
        kind: 'added',
        row: { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 }
      })
    ]));
    expect(materializedRowsForQuery(limitedNext, limitedTasks)).toEqual(limitedChange.rows);
  });

  it('incrementally maintains joins whose right branch is a mixed static/dynamic union', () => {
    const unionTasks = usersWithUnionTasksRightBranchQuery();
    const state = mat(createDb(sourceData), unionTasks, {
      id: 'user-union-tasks-right-branch',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, unionTasks);

    expect(metadata).toMatchObject({
      id: 'user-union-tasks-right-branch',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['users', 'tasks']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, unionTasks)).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 },
      { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
      { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 },
      { ownerId: 'bea', owner: 'Bea', taskId: 'pin-bea', title: 'Pinned Bea', points: 1 },
      { ownerId: 'cal', owner: 'Cal', taskId: 'pin-cal', title: 'Pinned Cal', points: 0 }
    ]);

    const calTask: TaskRow = {
      id: 't4',
      ownerId: 'cal',
      title: 'Cal right branch union',
      done: false,
      points: 4
    };
    const next = createDb({ ...sourceData, tasks: [...sourceData.tasks, calTask] });
    const maintained = maintainMaterializations(state, next, {
      deltas: [tasksDelta([calTask], [])]
    });
    const change = expectIncrementalMaintenance(maintained, 'user-union-tasks-right-branch');

    expect(change.rows).toEqual([
      { ownerId: 'ada', owner: 'Ada', taskId: 't1', title: 'Draft evaluator', points: 5 },
      { ownerId: 'ada', owner: 'Ada', taskId: 't2', title: 'Ship runtime', points: 8 },
      { ownerId: 'bea', owner: 'Bea', taskId: 't3', title: 'Review fixtures', points: 3 },
      { ownerId: 'bea', owner: 'Bea', taskId: 'pin-bea', title: 'Pinned Bea', points: 1 },
      { ownerId: 'cal', owner: 'Cal', taskId: 'pin-cal', title: 'Pinned Cal', points: 0 },
      { ownerId: 'cal', owner: 'Cal', taskId: 't4', title: 'Cal right branch union', points: 4 }
    ]);
    expect(change.addedRows).toEqual([
      { ownerId: 'cal', owner: 'Cal', taskId: 't4', title: 'Cal right branch union', points: 4 }
    ]);
    expect(materializedRowsForQuery(next, unionTasks)).toEqual(change.rows);
  });

  it('keeps dynamic-dynamic right branch union and aggregate after sortLimit on snapshot fallback', () => {
    const cases: Array<{ readonly id: string; readonly query: Query<unknown>; readonly reason: string }> = [
      {
        id: 'user-dynamic-union-tasks-right-branch',
        query: usersWithDynamicUnionTasksRightBranchQuery() as Query<unknown>,
        reason: 'right branch union incremental maintenance requires exactly one supported dynamic branch'
      },
      {
        id: 'user-sorted-task-rollups-right-branch',
        query: usersWithSortedTaskRollupsRightAggregateQuery() as Query<unknown>,
        reason: 'aggregate after order/window is not supported'
      }
    ];

    for (const testCase of cases) {
      const state = mat(createDb(sourceData), testCase.query, { id: testCase.id, mode: 'incremental' });
      const metadata = materializationForQuery(state, testCase.query);

      expect(metadata).toMatchObject({
        id: testCase.id,
        requestedMode: 'incremental',
        maintenance: 'snapshot'
      });
      expect(metadata?.maintenanceReason).toContain(testCase.reason);
      expectIncrementalFallback(metadata?.diagnostics ?? []);
    }
  });

  it('incrementally maintains a join whose right branch contains one nested equality join', () => {
    const taskOwnerTeams = taskOwnerTeamNestedRightBranchQuery();
    const state = mat(createDb(sourceData), taskOwnerTeams, {
      id: 'task-owner-team-nested-right-branch',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, taskOwnerTeams);

    expect(metadata).toMatchObject({
      id: 'task-owner-team-nested-right-branch',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users', 'teams']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, taskOwnerTeams)).toEqual([
      { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Engineering' },
      { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Engineering' },
      { id: 't3', ownerId: 'bea', owner: 'Bea', team: 'Design' }
    ]);

    const renamedEngineeringTeam = { ...engineeringTeam, name: 'Engineering Platform' };
    const renamedTeamDb = createDb({
      ...sourceData,
      teams: [designTeam, renamedEngineeringTeam]
    });
    const renamedTeamMaintenance = maintainMaterializations(state, renamedTeamDb, {
      deltas: [teamsDelta([renamedEngineeringTeam], [engineeringTeam])]
    });
    const renamedTeamChange = singleMaterializationChange(renamedTeamMaintenance, 'task-owner-team-nested-right-branch');

    expect(renamedTeamMaintenance).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expectNoIncrementalFallback([...renamedTeamMaintenance.diagnostics, ...renamedTeamChange.diagnostics]);
    expect(renamedTeamChange).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['teams'],
      rows: [
        { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Engineering Platform' },
        { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Engineering Platform' },
        { id: 't3', ownerId: 'bea', owner: 'Bea', team: 'Design' }
      ],
      addedRows: [],
      removedRows: []
    });
    expect(renamedTeamChange.rowChanges).toHaveLength(2);
    expect(renamedTeamChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Engineering' },
        after: { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Engineering Platform' }
      }),
      expect.objectContaining({
        kind: 'updated',
        before: { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Engineering' },
        after: { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Engineering Platform' }
      })
    ]));
    expect(materializedRowsForQuery(renamedTeamDb, taskOwnerTeams)).toEqual(renamedTeamChange.rows);

    const movedAda = { ...adaUser, teamId: 'design' };
    const movedOwnerDb = createDb({
      ...sourceData,
      teams: [designTeam, renamedEngineeringTeam],
      users: [movedAda, beaUser, calUser]
    });
    const movedOwnerMaintenance = maintainMaterializations(renamedTeamDb, movedOwnerDb, {
      deltas: [usersDelta([movedAda], [adaUser])]
    });
    const movedOwnerChange = singleMaterializationChange(movedOwnerMaintenance, 'task-owner-team-nested-right-branch');

    expect(movedOwnerMaintenance).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expectNoIncrementalFallback([...movedOwnerMaintenance.diagnostics, ...movedOwnerChange.diagnostics]);
    expect(movedOwnerChange).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Design' },
        { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Design' },
        { id: 't3', ownerId: 'bea', owner: 'Bea', team: 'Design' }
      ],
      addedRows: [],
      removedRows: []
    });
    expect(movedOwnerChange.rowChanges).toHaveLength(2);
    expect(movedOwnerChange.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Engineering Platform' },
        after: { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Design' }
      }),
      expect.objectContaining({
        kind: 'updated',
        before: { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Engineering Platform' },
        after: { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Design' }
      })
    ]));
    expect(materializedRowsForQuery(movedOwnerDb, taskOwnerTeams)).toEqual(movedOwnerChange.rows);
  });

  it('keeps an explicit fallback diagnostic for deeper nested right branch joins', async () => {
    const taskOwnerTeams = taskOwnerTeamDeeperNestedRightBranchQuery();
    const state = mat(createDb(sourceData), taskOwnerTeams, {
      id: 'task-owner-team-deeper-nested-right-branch',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, taskOwnerTeams);

    expect(metadata).toMatchObject({
      id: 'task-owner-team-deeper-nested-right-branch',
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['tasks', 'users', 'teams']));
    expect(metadata?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'materialization_incremental_fallback',
        detail: expect.objectContaining({
          reason: expect.stringContaining('nested right branch join left side is not supported')
        })
      })
    ]));
    await expect(qRows(state, taskOwnerTeams)).resolves.toEqual([
      { id: 't1', ownerId: 'ada', owner: 'Ada', team: 'Engineering' },
      { id: 't2', ownerId: 'ada', owner: 'Ada', team: 'Engineering' },
      { id: 't3', ownerId: 'bea', owner: 'Bea', team: 'Design' }
    ]);
  });

  it('marks initial left equality joins as incrementally maintained without fallback', () => {
    const leftUserTeams = leftUserTeamsQuery();
    const state = mat(createDb(sourceData), leftUserTeams, { id: 'left-user-teams', mode: 'incremental' });
    const metadata = materializationForQuery(state, leftUserTeams);

    expect(metadata).toMatchObject({
      id: 'left-user-teams',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(metadata?.dependencies).toEqual(expect.arrayContaining(['users', 'teams']));
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, leftUserTeams)).toEqual([
      { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
      { id: 'bea', name: 'Bea', team: 'Design', rank: 2 },
      { id: 'cal', name: 'Cal', team: undefined, rank: undefined }
    ]);
  });

  it('incrementally maintains left equality joins for left relation inserts, updates, and deletes', () => {
    const leftUserTeams = leftUserTeamsQuery();
    const state = mat(createDb(sourceData), leftUserTeams, { id: 'left-user-teams', mode: 'incremental' });
    const updatedAda = { ...adaUser, name: 'Ada Lovelace' };
    const updatedCal = { ...calUser, name: 'Cal Unmatched' };
    const next = createDb({
      ...sourceData,
      users: [updatedAda, updatedCal, diaUser]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda, updatedCal, diaUser], [adaUser, calUser, beaUser])]
    });
    const change = singleMaterializationChange(maintained, 'left-user-teams');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['users'],
      rows: [
        { id: 'ada', name: 'Ada Lovelace', team: 'Engineering', rank: 1 },
        { id: 'cal', name: 'Cal Unmatched', team: undefined, rank: undefined },
        { id: 'dia', name: 'Dia', team: 'Engineering', rank: 1 }
      ],
      addedRows: [{ id: 'dia', name: 'Dia', team: 'Engineering', rank: 1 }],
      removedRows: [{ id: 'bea', name: 'Bea', team: 'Design', rank: 2 }]
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change.rowChanges).toHaveLength(4);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
        after: { id: 'ada', name: 'Ada Lovelace', team: 'Engineering', rank: 1 }
      }),
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'cal', name: 'Cal', team: undefined, rank: undefined },
        after: { id: 'cal', name: 'Cal Unmatched', team: undefined, rank: undefined }
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
    expect(materializedRowsForQuery(next, leftUserTeams)).toEqual(change.rows);
  });

  it('updates previously unmatched left rows when a matching right row is inserted', () => {
    const leftUserTeams = leftUserTeamsQuery();
    const state = mat(createDb(sourceData), leftUserTeams, { id: 'left-user-teams', mode: 'incremental' });
    const supportTeam: TeamRow = { id: 'missing', name: 'Support', rank: 5 };
    const next = createDb({
      ...sourceData,
      teams: [...sourceData.teams, supportTeam]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [teamsDelta([supportTeam], [])]
    });
    const change = singleMaterializationChange(maintained, 'left-user-teams');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['teams'],
      rows: [
        { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
        { id: 'bea', name: 'Bea', team: 'Design', rank: 2 },
        { id: 'cal', name: 'Cal', team: 'Support', rank: 5 }
      ],
      addedRows: [],
      removedRows: []
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'cal', name: 'Cal', team: undefined, rank: undefined },
        after: { id: 'cal', name: 'Cal', team: 'Support', rank: 5 }
      })
    ]);
    expect(materializedRowsForQuery(next, leftUserTeams)).toEqual(change.rows);
  });

  it('turns matched left rows into unmatched rows when a matching right row is deleted', () => {
    const leftUserTeams = leftUserTeamsQuery();
    const state = mat(createDb(sourceData), leftUserTeams, { id: 'left-user-teams', mode: 'incremental' });
    const next = createDb({
      ...sourceData,
      teams: [engineeringTeam]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [teamsDelta([], [designTeam])]
    });
    const change = singleMaterializationChange(maintained, 'left-user-teams');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['teams'],
      rows: [
        { id: 'ada', name: 'Ada', team: 'Engineering', rank: 1 },
        { id: 'bea', name: 'Bea', team: undefined, rank: undefined },
        { id: 'cal', name: 'Cal', team: undefined, rank: undefined }
      ],
      addedRows: [],
      removedRows: []
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change.rowChanges).toEqual([
      expect.objectContaining({
        kind: 'updated',
        before: { id: 'bea', name: 'Bea', team: 'Design', rank: 2 },
        after: { id: 'bea', name: 'Bea', team: undefined, rank: undefined }
      })
    ]);
    expect(materializedRowsForQuery(next, leftUserTeams)).toEqual(change.rows);
  });

  it('updates many left rows from one right row change without expanding the report to a snapshot diff', () => {
    const leftUserTeams = leftUserTeamsQuery();
    const initial = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    });
    const state = mat(initial, leftUserTeams, { id: 'left-user-teams', mode: 'incremental' });
    const updatedEngineeringTeam = { ...engineeringTeam, name: 'Engineering Platform', rank: 3 };
    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser],
      teams: [designTeam, updatedEngineeringTeam]
    });

    const maintained = maintainMaterializations(state, next, {
      deltas: [teamsDelta([updatedEngineeringTeam], [engineeringTeam])]
    });
    const change = singleMaterializationChange(maintained, 'left-user-teams');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 0 });
    expect(change).toMatchObject({
      maintenance: 'incremental',
      recomputed: false,
      touchedDependencies: ['teams'],
      rows: [
        { id: 'ada', name: 'Ada', team: 'Engineering Platform', rank: 3 },
        { id: 'bea', name: 'Bea', team: 'Design', rank: 2 },
        { id: 'cal', name: 'Cal', team: undefined, rank: undefined },
        { id: 'dia', name: 'Dia', team: 'Engineering Platform', rank: 3 }
      ],
      addedRows: [],
      removedRows: []
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(change.rowChanges).toHaveLength(2);
    expect(change.rowChanges.length).toBeLessThan(change.rows.length);
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
    expect(materializedRowsForQuery(next, leftUserTeams)).toEqual(change.rows);
  });

  it('keeps declared hash and btree facades correct after incremental insert, key move, and delete', async () => {
    const user = as(coreSchema.users, 'user');
    const activeIndexedUsers = activeIndexedUsersQuery();
    const state = mat(createDb(sourceData), activeIndexedUsers, {
      id: 'active-indexed-users',
      mode: 'incremental'
    });

    expect(materializationForQuery(state, activeIndexedUsers)).toMatchObject({
      id: 'active-indexed-users',
      maintenance: 'incremental',
      indexSpecs: expect.arrayContaining([
        expect.objectContaining({ kind: 'hash', field: 'teamId' }),
        expect.objectContaining({ kind: 'unique', field: 'id' }),
        expect.objectContaining({ kind: 'btree', field: 'age' })
      ])
    });
    expect(index<UserRow, string>(state, activeIndexedUsers, { kind: 'hash', field: 'teamId' }).index?.get('eng')).toEqual([
      adaUser
    ]);
    expect(index<UserRow, number>(state, activeIndexedUsers, { kind: 'btree', field: 'age' }).index?.ordered).toEqual([
      29,
      37
    ]);

    const inserted = await trackTransact(state, insert(coreSchema.users, diaUser));
    expectIncrementalMaintenance(inserted.result?.materializations, 'active-indexed-users');

    expect(ids(index<UserRow, string>(inserted.db, activeIndexedUsers, { kind: 'hash', field: 'teamId' }).index?.get('eng'))).toEqual([
      'ada',
      'dia'
    ]);
    expect(index<UserRow, number>(inserted.db, activeIndexedUsers, { kind: 'btree', field: 'age' }).index?.ordered).toEqual([
      24,
      29,
      37
    ]);

    const movedDia = await trackTransact(
      inserted.db,
      updateWhere(coreSchema.users, eq(user.id, 'dia'), { teamId: 'design', age: 35 })
    );
    expectIncrementalMaintenance(movedDia.result?.materializations, 'active-indexed-users');

    const movedHash = index<UserRow, string>(movedDia.db, activeIndexedUsers, { kind: 'hash', field: 'teamId' });
    const movedBtree = index<UserRow, number>(movedDia.db, activeIndexedUsers, { kind: 'btree', field: 'age' });
    expect(ids(movedHash.index?.get('eng'))).toEqual(['ada']);
    expect(ids(movedHash.index?.get('design'))).toEqual(['bea', 'dia']);
    expect(movedBtree.index?.ordered).toEqual([29, 35, 37]);
    expect(ids(movedBtree.index?.range({ lower: 30, upper: 40 }))).toEqual(['dia', 'ada']);

    const deleted = await trackTransact(movedDia.db, deleteByKey(coreSchema.users, 'dia'));
    expectIncrementalMaintenance(deleted.result?.materializations, 'active-indexed-users');

    const deletedHash = index<UserRow, string>(deleted.db, activeIndexedUsers, { kind: 'hash', field: 'teamId' });
    const deletedBtree = index<UserRow, number>(deleted.db, activeIndexedUsers, { kind: 'btree', field: 'age' });
    expect(ids(deletedHash.index?.get('eng'))).toEqual(['ada']);
    expect(ids(deletedHash.index?.get('design'))).toEqual(['bea']);
    expect(deletedBtree.index?.ordered).toEqual([29, 37]);
    expect(ids(deletedBtree.index?.range({ lower: 30, upper: 40 }))).toEqual(['ada']);
    await expect(qRows(deleted.db, activeIndexedUsers)).resolves.toEqual([
      adaUser,
      beaUser
    ]);
  });

  it('reports materialized unique index duplicates and recovers lookup behavior after key moves', async () => {
    const user = as(coreSchema.users, 'user');
    const usersByUniqueTeam = uniqueUsersByTeamQuery();
    const state = mat(createDb(sourceData), usersByUniqueTeam, {
      id: 'users-by-unique-team',
      mode: 'incremental'
    });

    const initialUnique = index<UserRow, string>(state, usersByUniqueTeam, { kind: 'unique', field: 'teamId' });
    expect(initialUnique.indexed).toBe(true);
    expect(initialUnique.index?.get('eng')).toEqual(adaUser);
    expect(initialUnique.index?.get('design')).toEqual(beaUser);

    const duplicate = await trackTransact(state, insert(coreSchema.users, diaUser));
    expectIncrementalMaintenance(duplicate.result?.materializations, 'users-by-unique-team');

    const duplicateUnique = index<UserRow, string>(duplicate.db, usersByUniqueTeam, { kind: 'unique', field: 'teamId' });
    expect(duplicateUnique.indexed).toBe(false);
    expect(duplicateUnique.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'materialization_index_unsupported',
        detail: { fields: ['teamId'], key: 'eng' }
      })
    ]));
    expect(duplicateUnique.index?.get('eng')).toEqual(adaUser);
    expect(duplicateUnique.index?.has('eng')).toBe(true);

    const moved = await trackTransact(
      duplicate.db,
      insert(coreSchema.teams, operationsTeam),
      updateWhere(coreSchema.users, eq(user.id, 'dia'), { teamId: 'ops' })
    );
    expectIncrementalMaintenance(moved.result?.materializations, 'users-by-unique-team');

    const movedUnique = index<UserRow, string>(moved.db, usersByUniqueTeam, { kind: 'unique', field: 'teamId' });
    expect(movedUnique.indexed).toBe(true);
    expect(movedUnique.index?.get('eng')).toEqual(adaUser);
    expect(movedUnique.index?.get('ops')).toEqual({ ...diaUser, teamId: 'ops' });
    expect(movedUnique.index?.has('missing')).toBe(true);

    const deleted = await trackTransact(moved.db, deleteByKey(coreSchema.users, 'dia'));
    expectIncrementalMaintenance(deleted.result?.materializations, 'users-by-unique-team');

    const deletedUnique = index<UserRow, string>(deleted.db, usersByUniqueTeam, { kind: 'unique', field: 'teamId' });
    expect(deletedUnique.indexed).toBe(true);
    expect(deletedUnique.index?.get('ops')).toBeUndefined();
    expect(deletedUnique.index?.get('eng')).toEqual(adaUser);
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
