import { bench, describe } from 'vitest';
import {
  aggregate,
  asc,
  avg,
  btree,
  bottomBy,
  call,
  constrain,
  count,
  createDb,
  db,
  deleteRows,
  desc,
  diffQuery,
  eq,
  extend,
  field,
  from,
  gte,
  hash,
  index,
  insert,
  join,
  keyBy,
  mat,
  pipe,
  project,
  qRows,
  qualify,
  sort,
  sum,
  trackTransact,
  transact,
  tryTransact,
  topBy,
  unique,
  uniqueIndex,
  update,
  watch
} from '@tarstate/core';
import {
  benchSchema,
  consumeBenchResult,
  createBenchFixture,
  duplicateEmailPerson,
  extraPerson,
  extraTask,
  extraTasks,
  personRef,
  taskRef
} from './fixtures';

const options = {
  time: 200,
  warmupTime: 50,
  iterations: 10
};

function activeBucket(active: boolean): string {
  return active ? 'active' : 'inactive';
}

function capacityBand(capacity: number): number {
  return Math.floor(capacity / 10) * 10;
}

function regionEmailSlug(region: string, email: string): string {
  return `${region}:${email}`;
}

const medium = createBenchFixture('medium');
const large = createBenchFixture('large');
const activeBucketRef = field<string>('computed', 'activeBucket');
const capacityBandRef = field<number>('computed', 'capacityBand');
const regionEmailRef = field<string>('computed', 'regionEmail');
const compoundIndexedPeople = pipe(
  from(personRef),
  hash(personRef.role, personRef.region),
  uniqueIndex(personRef.region, personRef.id),
  project({
    id: personRef.id,
    email: personRef.email,
    role: personRef.role,
    region: personRef.region,
    capacity: personRef.capacity
  }),
  keyBy('id')
);
const expressionIndexedPeople = pipe(
  from(personRef),
  extend({
    activeBucket: call(activeBucket, personRef.active),
    capacityBand: call(capacityBand, personRef.capacity),
    regionEmail: call(regionEmailSlug, personRef.region, personRef.email)
  }),
  hash(activeBucketRef),
  btree(capacityBandRef),
  uniqueIndex(regionEmailRef),
  project({
    id: personRef.id,
    email: personRef.email,
    region: personRef.region,
    activeBucket: activeBucketRef,
    capacityBand: capacityBandRef,
    regionEmail: regionEmailRef
  }),
  keyBy('id')
);
const singlePersonInsert = insert(benchSchema.people, extraPerson(0));
const batchTaskInserts = extraTasks(medium.data, 24).map((row) => insert(benchSchema.tasks, row));
const predicateTaskUpdate = update(benchSchema.tasks, gte(taskRef.points, 8), { priority: 5 });
const predicateTaskDelete = deleteRows(benchSchema.tasks, eq(taskRef.done, true));
const constrained = mat(createDb(medium.data), constrain(unique(benchSchema.people, 'email')));
const duplicateEmailInsert = insert(benchSchema.people, duplicateEmailPerson(medium.data));
const materialized = mat(createDb(medium.data), {
  activePeople: medium.queries.activePeople,
  openTasks: medium.queries.openTasks,
  projectTaskAggregates: medium.queries.projectTaskAggregates
});
const materializedIndexedPeople = mat(createDb(medium.data), {
  indexedPeople: medium.queries.indexedPeople
}, { mode: 'incremental' });
const materializedCompoundIndexedPeople = mat(createDb(medium.data), {
  compoundIndexedPeople
}, { mode: 'incremental' });
const materializedExpressionIndexedPeople = mat(createDb(medium.data), {
  expressionIndexedPeople
});
const incrementalMaterialized = mat(createDb(medium.data), {
  activePeople: medium.queries.activePeople,
  openTasks: medium.queries.openTasks
}, { mode: 'incremental' });
const materializedTaskInsert = insert(benchSchema.tasks, extraTask(medium.data, 100));
const materializedIndexedPeopleInsert = extraPerson(102);
const compoundIndexedPeopleInsert = extraPerson(502, { role: 'engineer', region: 'apac' });
const expressionIndexedPeopleInsert = extraPerson(503, { active: false, capacity: 44, region: 'emea' });
const maintainedMaterializedIndexedPeople = transact(
  materializedIndexedPeople,
  insert(benchSchema.people, materializedIndexedPeopleInsert)
);
const maintainedMaterializedCompoundIndexedPeople = transact(
  materializedCompoundIndexedPeople,
  insert(benchSchema.people, compoundIndexedPeopleInsert)
);
const maintainedMaterializedExpressionIndexedPeople = transact(
  materializedExpressionIndexedPeople,
  insert(benchSchema.people, expressionIndexedPeopleInsert)
);
const materializedIndexedPeopleExisting = medium.data.people[Math.floor(medium.data.people.length / 2)]
  ?? medium.data.people[0]!;
const expressionIndexedPeopleInsertBucket = activeBucket(expressionIndexedPeopleInsert.active);
const expressionIndexedPeopleInsertCapacityBand = capacityBand(expressionIndexedPeopleInsert.capacity);
const incrementalPeopleInsert = insert(benchSchema.people, extraPerson(101));
const largeMaterializedJoin = mat(createDb(large.data), {
  taskProjectOwnerJoin: large.queries.taskProjectOwnerJoin
});
const largeIncrementalMaterializedJoin = mat(createDb(large.data), {
  taskProjectOwnerJoin: large.queries.taskProjectOwnerJoin
}, { mode: 'incremental' });
const largeMaterializedJoinTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 200));
const largeJoinOwnerId = large.data.tasks[Math.floor(large.data.tasks.length / 2)]?.ownerId
  ?? large.data.people[0]?.id
  ?? '';
const largeMaterializedJoinOwnerUpdate = update(benchSchema.people, eq(personRef.id, largeJoinOwnerId), {
  name: 'Updated Owner',
  role: 'principal'
});
const largeSnapshotMaterializedLeftJoin = mat(createDb(large.data), {
  reviewerLeftJoin: large.queries.reviewerLeftJoinMissHeavy
});
const largeIncrementalMaterializedLeftJoin = mat(createDb(large.data), {
  reviewerLeftJoin: large.queries.reviewerLeftJoinMissHeavy
}, { mode: 'incremental' });
const largeLeftJoinReviewerId = large.data.tasks.find((task) => task.reviewerId !== undefined)?.reviewerId
  ?? large.data.people[0]?.id
  ?? '';
const largeMaterializedLeftJoinReviewerUpdate = update(
  benchSchema.people,
  eq(personRef.id, largeLeftJoinReviewerId),
  {
    name: 'Updated Reviewer',
    role: 'review-lead'
  }
);
const largeSnapshotMaterializedTopPriorityTasks = mat(createDb(large.data), {
  topPriorityTasks: large.queries.topPriorityTasks
});
const largeIncrementalMaterializedTopPriorityTasks = mat(createDb(large.data), {
  topPriorityTasks: large.queries.topPriorityTasks
}, { mode: 'incremental' });
const largeTopPriorityTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 700, {
  priority: 100,
  points: 100,
  createdAt: -1
}));
const largeSortedTasks = pipe(
  from(taskRef),
  sort(desc(taskRef.priority), desc(taskRef.points), asc(taskRef.createdAt)),
  project({
    id: taskRef.id,
    title: taskRef.title,
    priority: taskRef.priority,
    points: taskRef.points,
    createdAt: taskRef.createdAt
  }),
  keyBy('id')
);
const largeSnapshotMaterializedSortedTasks = mat(createDb(large.data), {
  sortedTasks: largeSortedTasks
});
const largeIncrementalMaterializedSortedTasks = mat(createDb(large.data), {
  sortedTasks: largeSortedTasks
}, { mode: 'incremental' });
const largeSortedTaskUpdateId = large.data.tasks[Math.floor(large.data.tasks.length / 3)]?.id ?? '';
const largeMaterializedSortedTaskUpdate = update(
  benchSchema.tasks,
  eq(taskRef.id, largeSortedTaskUpdateId),
  { title: 'Updated sorted benchmark task' }
);
const largeProjectTaskRollups = pipe(
  from(taskRef),
  aggregate({
    groupBy: { projectId: taskRef.projectId },
    aggregates: {
      tasks: count(),
      totalPoints: sum(taskRef.points),
      averagePoints: avg(taskRef.points)
    }
  }),
  keyBy('projectId')
);
const largeSnapshotMaterializedAggregate = mat(createDb(large.data), {
  projectTaskRollups: largeProjectTaskRollups
});
const largeIncrementalMaterializedAggregate = mat(createDb(large.data), {
  projectTaskRollups: largeProjectTaskRollups
}, { mode: 'incremental' });
const largeJoinedTaskOwnerRollups = pipe(
  from(taskRef),
  join(from(personRef), eq(taskRef.ownerId, personRef.id)),
  aggregate({
    groupBy: { region: personRef.region },
    aggregates: {
      tasks: count(),
      totalPoints: sum(taskRef.points),
      averagePoints: avg(taskRef.points)
    }
  }),
  keyBy('region')
);
const largeSnapshotMaterializedJoinedAggregate = mat(createDb(large.data), {
  joinedTaskOwnerRollups: largeJoinedTaskOwnerRollups
});
const largeIncrementalMaterializedJoinedAggregate = mat(createDb(large.data), {
  joinedTaskOwnerRollups: largeJoinedTaskOwnerRollups
}, { mode: 'incremental' });
const largeProjectTaskRankings = pipe(
  from(taskRef),
  aggregate({
    groupBy: { projectId: taskRef.projectId },
    aggregates: {
      topTasks: topBy(5, taskRef.points),
      bottomTasks: bottomBy(5, taskRef.points)
    }
  }),
  keyBy('projectId')
);
const largeSnapshotMaterializedRankings = mat(createDb(large.data), {
  projectTaskRankings: largeProjectTaskRankings
});
const largeIncrementalMaterializedRankings = mat(createDb(large.data), {
  projectTaskRankings: largeProjectTaskRankings
}, { mode: 'incremental' });
const largeAggregateInsertProjectId = large.data.projects[0]?.id ?? '';
const largeAggregateTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 400, {
  projectId: largeAggregateInsertProjectId,
  points: 11
}));
const largeSnapshotMaterializedAggregateSortLimit = mat(createDb(large.data), {
  projectTaskAggregates: large.queries.projectTaskAggregates
});
const largeIncrementalMaterializedAggregateSortLimit = mat(createDb(large.data), {
  projectTaskAggregates: large.queries.projectTaskAggregates
}, { mode: 'incremental' });
const largeAggregateSortLimitTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 710, {
  projectId: largeAggregateInsertProjectId,
  points: 100
}));
const largeAggregateMoveTask = large.data.tasks.find((task) => task.projectId !== largeAggregateInsertProjectId)
  ?? large.data.tasks[0];
const largeAggregateMoveTargetProjectId = large.data.projects.find((project) => (
  project.id !== largeAggregateMoveTask?.projectId
))?.id ?? largeAggregateInsertProjectId;
const largeAggregateTaskProjectUpdate = update(
  benchSchema.tasks,
  eq(taskRef.id, largeAggregateMoveTask?.id ?? ''),
  {
    projectId: largeAggregateMoveTargetProjectId,
    points: (largeAggregateMoveTask?.points ?? 0) + 5
  }
);
const largeAggregateDeleteTaskId = large.data.tasks[Math.floor(large.data.tasks.length / 2)]?.id ?? '';
const largeAggregateTaskDelete = deleteRows(benchSchema.tasks, eq(taskRef.id, largeAggregateDeleteTaskId));
const largeJoinedAggregateOwner = large.data.people.find((person) => (
  large.data.tasks.some((task) => task.ownerId === person.id)
)) ?? large.data.people[0];
const largeJoinedAggregateOwnerTargetRegion = large.data.people.find((person) => (
  person.region !== largeJoinedAggregateOwner?.region
))?.region ?? 'remote';
const largeJoinedAggregateTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 600, {
  ownerId: largeJoinedAggregateOwner?.id ?? large.data.people[0]?.id ?? '',
  points: 12
}));
const largeJoinedAggregateOwnerRegionUpdate = update(
  benchSchema.people,
  eq(personRef.id, largeJoinedAggregateOwner?.id ?? ''),
  { region: largeJoinedAggregateOwnerTargetRegion }
);
const largeRankingInsertProjectId = large.data.projects[0]?.id ?? '';
const largeRankingTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 500, {
  projectId: largeRankingInsertProjectId,
  points: 14
}));
const largeRankingLowestTask = [...large.data.tasks]
  .filter((task) => task.projectId === largeRankingInsertProjectId)
  .sort((left, right) => left.points - right.points)
  .at(0) ?? large.data.tasks[0];
const largeRankingTaskUpdate = update(
  benchSchema.tasks,
  eq(taskRef.id, largeRankingLowestTask?.id ?? ''),
  { points: 15 }
);
const largeRankingHighestTask = [...large.data.tasks]
  .filter((task) => task.projectId === largeRankingInsertProjectId)
  .sort((left, right) => right.points - left.points)
  .at(0) ?? large.data.tasks[0];
const largeRankingTaskDelete = deleteRows(benchSchema.tasks, eq(taskRef.id, largeRankingHighestTask?.id ?? ''));
const largeSnapshotMaterializedExpand = mat(createDb(large.data), {
  expandedTaskLabels: large.queries.expandedTaskLabels
});
const largeIncrementalMaterializedExpand = mat(createDb(large.data), {
  expandedTaskLabels: large.queries.expandedTaskLabels
}, { mode: 'incremental' });
const largeExpandTask = large.data.tasks.find((task) => task.labels.length > 0) ?? large.data.tasks[0];
const largeMaterializedExpandTaskLabelUpdate = update(
  benchSchema.tasks,
  eq(taskRef.id, largeExpandTask?.id ?? ''),
  {
    labels: [
      ...(largeExpandTask?.labels ?? []),
      { name: 'benchmark', weight: 9 }
    ]
  }
);
const largeQualifiedActivePeople = pipe(large.queries.activePeople, qualify('person'));
const largeSnapshotMaterializedQualify = mat(createDb(large.data), {
  qualifiedActivePeople: largeQualifiedActivePeople
});
const largeIncrementalMaterializedQualify = mat(createDb(large.data), {
  qualifiedActivePeople: largeQualifiedActivePeople
}, { mode: 'incremental' });
const largeQualifyPersonId = large.data.people.find((person) => person.active)?.id ?? '';
const largeMaterializedQualifyPersonUpdate = update(
  benchSchema.people,
  eq(personRef.id, largeQualifyPersonId),
  { name: 'Qualified Person' }
);
const watchBase = createDb(medium.data);
const watchNext = transact(watchBase, insert(benchSchema.people, extraPerson(200)));
const watchHandle = watch(watchBase, medium.queries.activePeople, () => undefined);
const trackedBase = watch(createDb(medium.data), medium.queries.activePeople, benchSchema.people);
const trackedInsert = insert(benchSchema.people, extraPerson(300));
const diffBefore = createDb(medium.data);
const diffAfter = transact(diffBefore, update(benchSchema.people, eq(personRef.id, medium.data.people[1]?.id ?? ''), {
  active: false
}));

async function trackLargeIncrementalJoinTaskInsert(): Promise<unknown> {
  const tracked = await trackTransact(largeIncrementalMaterializedJoin, largeMaterializedJoinTaskInsert);
  const change = tracked.materializations?.changes.find((item) => item.id === 'taskProjectOwnerJoin');
  if (change === undefined) {
    throw new Error('large joined materialization report is missing');
  }
  if (
    change.maintenance !== 'incremental'
    || change.recomputed
    || change.rowChanges.length !== 1
    || change.added.length !== 1
    || change.removed.length !== 0
  ) {
    throw new Error('large joined materialization report expanded beyond the task insert delta');
  }
  return tracked;
}

describe('core write and materialization benchmarks', () => {
  bench('createDb: medium fixture', () => {
    consumeBenchResult(createDb(medium.data));
  }, options);

  bench('db alias: medium fixture', () => {
    consumeBenchResult(db(medium.data));
  }, options);

  bench('tryTransact: single insert', () => {
    consumeBenchResult(tryTransact(medium.db, singlePersonInsert));
  }, options);

  bench('transact: single insert', () => {
    consumeBenchResult(transact(medium.db, singlePersonInsert));
  }, options);

  bench('tryTransact: batch task inserts', () => {
    consumeBenchResult(tryTransact(medium.db, batchTaskInserts));
  }, options);

  bench('tryTransact: predicate update', () => {
    consumeBenchResult(tryTransact(medium.db, predicateTaskUpdate));
  }, options);

  bench('tryTransact: predicate delete', () => {
    consumeBenchResult(tryTransact(medium.db, predicateTaskDelete));
  }, options);

  bench('tryTransact: rejected attached unique constraint', () => {
    consumeBenchResult(tryTransact(constrained, duplicateEmailInsert));
  }, options);

  bench('materialized qRows: active people', async () => {
    consumeBenchResult(await qRows(materialized, medium.queries.activePeople));
  }, options);

  bench('materialized transact: maintain affected task queries', () => {
    consumeBenchResult(transact(materialized, materializedTaskInsert));
  }, options);

  bench('materialized transact incremental: maintain active people delta', () => {
    consumeBenchResult(transact(incrementalMaterialized, incrementalPeopleInsert));
  }, options);

  bench('materialized transact incremental: maintain compound people indexes', () => {
    consumeBenchResult(transact(
      materializedCompoundIndexedPeople,
      insert(benchSchema.people, compoundIndexedPeopleInsert)
    ));
  }, options);

  bench('materialized transact: maintain expression-projected people indexes', () => {
    consumeBenchResult(transact(
      materializedExpressionIndexedPeople,
      insert(benchSchema.people, expressionIndexedPeopleInsert)
    ));
  }, options);

  bench('materialized transact large: maintain joined task query', () => {
    consumeBenchResult(transact(largeMaterializedJoin, largeMaterializedJoinTaskInsert));
  }, options);

  bench('materialized transact large incremental: maintain joined task query from task insert', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedJoin, largeMaterializedJoinTaskInsert));
  }, options);

  bench('trackTransact large incremental: joined task query from task insert', async () => {
    consumeBenchResult(await trackLargeIncrementalJoinTaskInsert());
  }, options);

  bench('materialized transact large incremental: maintain joined task query from owner update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedJoin, largeMaterializedJoinOwnerUpdate));
  }, options);

  bench('materialized transact large leftJoin snapshot: reviewer update', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedLeftJoin, largeMaterializedLeftJoinReviewerUpdate));
  }, options);

  bench('materialized transact large leftJoin requested incremental: reviewer update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedLeftJoin, largeMaterializedLeftJoinReviewerUpdate));
  }, options);

  bench('materialized transact large sortLimit snapshot: top priority task insert', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedTopPriorityTasks, largeTopPriorityTaskInsert));
  }, options);

  bench('materialized transact large sortLimit requested incremental: top priority task insert', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedTopPriorityTasks, largeTopPriorityTaskInsert));
  }, options);

  bench('materialized transact large full sort snapshot: task title update', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedSortedTasks, largeMaterializedSortedTaskUpdate));
  }, options);

  bench('materialized transact large full sort requested incremental: task title update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedSortedTasks, largeMaterializedSortedTaskUpdate));
  }, options);

  bench('materialized transact large aggregate snapshot: task insert', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedAggregate, largeAggregateTaskInsert));
  }, options);

  bench('materialized transact large aggregate requested incremental: task insert', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedAggregate, largeAggregateTaskInsert));
  }, options);

  bench('materialized transact large aggregate sortLimit snapshot: task insert', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedAggregateSortLimit, largeAggregateSortLimitTaskInsert));
  }, options);

  bench('materialized transact large aggregate sortLimit requested incremental: task insert', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedAggregateSortLimit, largeAggregateSortLimitTaskInsert));
  }, options);

  bench('materialized transact large aggregate snapshot: task update moves group and points', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedAggregate, largeAggregateTaskProjectUpdate));
  }, options);

  bench('materialized transact large aggregate requested incremental: task update moves group and points', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedAggregate, largeAggregateTaskProjectUpdate));
  }, options);

  bench('materialized transact large aggregate snapshot: task delete', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedAggregate, largeAggregateTaskDelete));
  }, options);

  bench('materialized transact large aggregate requested incremental: task delete', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedAggregate, largeAggregateTaskDelete));
  }, options);

  bench('materialized transact large joined aggregate snapshot: task insert', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedJoinedAggregate, largeJoinedAggregateTaskInsert));
  }, options);

  bench('materialized transact large joined aggregate requested incremental: task insert', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedJoinedAggregate, largeJoinedAggregateTaskInsert));
  }, options);

  bench('materialized transact large joined aggregate snapshot: owner region update', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedJoinedAggregate, largeJoinedAggregateOwnerRegionUpdate));
  }, options);

  bench('materialized transact large joined aggregate requested incremental: owner region update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedJoinedAggregate, largeJoinedAggregateOwnerRegionUpdate));
  }, options);

  bench('materialized transact large topBy/bottomBy aggregate snapshot: task insert', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedRankings, largeRankingTaskInsert));
  }, options);

  bench('materialized transact large topBy/bottomBy aggregate requested incremental: task insert', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedRankings, largeRankingTaskInsert));
  }, options);

  bench('materialized transact large topBy/bottomBy aggregate snapshot: task update', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedRankings, largeRankingTaskUpdate));
  }, options);

  bench('materialized transact large topBy/bottomBy aggregate requested incremental: task update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedRankings, largeRankingTaskUpdate));
  }, options);

  bench('materialized transact large topBy/bottomBy aggregate snapshot: task delete', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedRankings, largeRankingTaskDelete));
  }, options);

  bench('materialized transact large topBy/bottomBy aggregate requested incremental: task delete', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedRankings, largeRankingTaskDelete));
  }, options);

  bench('materialized transact large expand snapshot: task labels update', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedExpand, largeMaterializedExpandTaskLabelUpdate));
  }, options);

  bench('materialized transact large expand requested incremental: task labels update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedExpand, largeMaterializedExpandTaskLabelUpdate));
  }, options);

  bench('materialized transact large qualify snapshot: active person update', () => {
    consumeBenchResult(transact(largeSnapshotMaterializedQualify, largeMaterializedQualifyPersonUpdate));
  }, options);

  bench('materialized transact large qualify requested incremental: active person update', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedQualify, largeMaterializedQualifyPersonUpdate));
  }, options);

  bench('materialized index: set rows', () => {
    consumeBenchResult(index(materialized, medium.queries.openTasks));
  }, options);

  bench('materialized index: hash ownerId', () => {
    consumeBenchResult(index(materialized, medium.queries.openTasks, { kind: 'hash', field: 'ownerId' }));
  }, options);

  bench('materialized index: btree points', () => {
    consumeBenchResult(index(materialized, medium.queries.openTasks, { kind: 'btree', field: 'points' }));
  }, options);

  bench('materialized index: unique id', () => {
    consumeBenchResult(index(materialized, medium.queries.openTasks, { kind: 'unique', field: 'id' }));
  }, options);

  bench('materialized index facade read before maintained insert: hash id', () => {
    consumeBenchResult(index(materializedIndexedPeople, 'indexedPeople', {
      kind: 'hash',
      field: 'id'
    }).index?.get(materializedIndexedPeopleExisting.id));
  }, options);

  bench('materialized index facade read after maintained insert: hash id', () => {
    consumeBenchResult(index(maintainedMaterializedIndexedPeople, 'indexedPeople', {
      kind: 'hash',
      field: 'id'
    }).index?.get(materializedIndexedPeopleInsert.id));
  }, options);

  bench('materialized index facade read before maintained insert: unique email', () => {
    consumeBenchResult(index(materializedIndexedPeople, 'indexedPeople', {
      kind: 'unique',
      field: 'email'
    }).index?.get(materializedIndexedPeopleExisting.email));
  }, options);

  bench('materialized index facade read after maintained insert: unique email', () => {
    consumeBenchResult(index(maintainedMaterializedIndexedPeople, 'indexedPeople', {
      kind: 'unique',
      field: 'email'
    }).index?.get(materializedIndexedPeopleInsert.email));
  }, options);

  bench('materialized index facade read before maintained insert: btree capacity range', () => {
    consumeBenchResult(index(materializedIndexedPeople, 'indexedPeople', {
      kind: 'btree',
      field: 'capacity'
    }).index?.range({ lower: 35, upper: 45 }));
  }, options);

  bench('materialized index facade read after maintained insert: btree capacity range', () => {
    consumeBenchResult(index(maintainedMaterializedIndexedPeople, 'indexedPeople', {
      kind: 'btree',
      field: 'capacity'
    }).index?.range({ lower: 35, upper: 45 }));
  }, options);

  bench('materialized compound index facade read after maintained insert: hash role,region', () => {
    consumeBenchResult(index(maintainedMaterializedCompoundIndexedPeople, 'compoundIndexedPeople', {
      kind: 'hash',
      fields: ['role', 'region']
    }).index?.rowsFor(compoundIndexedPeopleInsert.role, compoundIndexedPeopleInsert.region));
  }, options);

  bench('materialized compound index facade read after maintained insert: unique region,id', () => {
    consumeBenchResult(index(maintainedMaterializedCompoundIndexedPeople, 'compoundIndexedPeople', {
      kind: 'unique',
      fields: ['region', 'id']
    }).index?.rowFor(compoundIndexedPeopleInsert.region, compoundIndexedPeopleInsert.id));
  }, options);

  bench('materialized expression index facade read after maintained insert: hash activeBucket', () => {
    consumeBenchResult(index(maintainedMaterializedExpressionIndexedPeople, 'expressionIndexedPeople', {
      kind: 'hash',
      field: 'activeBucket'
    }).index?.get(expressionIndexedPeopleInsertBucket));
  }, options);

  bench('materialized expression index facade read after maintained insert: btree capacityBand', () => {
    consumeBenchResult(index(maintainedMaterializedExpressionIndexedPeople, 'expressionIndexedPeople', {
      kind: 'btree',
      field: 'capacityBand'
    }).index?.get(expressionIndexedPeopleInsertCapacityBand));
  }, options);

  bench('watch refresh: active people diff', async () => {
    consumeBenchResult(await watchHandle.refresh(watchNext));
  }, options);

  bench('trackTransact: watched insert', async () => {
    consumeBenchResult(await trackTransact(trackedBase, trackedInsert));
  }, options);

  bench('diffQuery: active people before/after', async () => {
    consumeBenchResult(await diffQuery(diffBefore, diffAfter, medium.queries.activePeople));
  }, options);
});
