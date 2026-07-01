import { bench, describe } from 'vitest';
import { evaluate, qMany, qRows, queryKey } from '@tarstate/core';
import { benchSchema, consumeBenchResult, createBenchFixture } from './fixtures';

const options = {
  time: 200,
  warmupTime: 50,
  iterations: 10
};

const medium = createBenchFixture('medium');
const large = createBenchFixture('large');

describe('core query benchmarks', () => {
  bench('relation scan: qRows(tasks relation)', async () => {
    consumeBenchResult(await qRows(medium.db, benchSchema.tasks));
  }, options);

  bench('filter/project: open tasks above point threshold', async () => {
    consumeBenchResult(await qRows(medium.db, medium.queries.filteredProjectedTasks));
  }, options);

  bench('join: tasks to projects and owners', async () => {
    consumeBenchResult(await qRows(medium.db, medium.queries.taskProjectOwnerJoin));
  }, options);

  bench('join large: tasks to projects and owners', async () => {
    consumeBenchResult(await qRows(large.db, large.queries.taskProjectOwnerJoin));
  }, options);

  bench('leftJoin: reviewer lookup miss-heavy path', async () => {
    consumeBenchResult(await qRows(medium.db, medium.queries.reviewerLeftJoinMissHeavy));
  }, options);

  bench('leftJoin large: reviewer lookup miss-heavy path', async () => {
    consumeBenchResult(await qRows(large.db, large.queries.reviewerLeftJoinMissHeavy));
  }, options);

  bench('sortLimit: top priority tasks', async () => {
    consumeBenchResult(await qRows(medium.db, medium.queries.topPriorityTasks));
  }, options);

  bench('aggregate: task rollups by project', async () => {
    consumeBenchResult(await qRows(medium.db, medium.queries.projectTaskAggregates));
  }, options);

  bench('expand: task label rows', async () => {
    consumeBenchResult(await qRows(medium.db, medium.queries.expandedTaskLabels));
  }, options);

  bench('qMany: active people, open tasks, rollups', async () => {
    consumeBenchResult(await qMany(medium.db, medium.queries.batch));
  }, options);

  bench('queryKey: stable key for joined query', () => {
    consumeBenchResult(queryKey(medium.queries.taskProjectOwnerJoin));
  }, options);

  bench('object source lookup: owner task lookup fallback', async () => {
    consumeBenchResult(await evaluate(large.objectSource, large.queries.lookupTasksByOwner));
  }, options);

  bench('indexed source lookup: owner task lookup index', async () => {
    consumeBenchResult(await evaluate(large.indexedSource, large.queries.lookupTasksByOwner));
  }, options);
});
