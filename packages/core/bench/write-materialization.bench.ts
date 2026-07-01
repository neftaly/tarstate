import { bench, describe } from 'vitest';
import {
  constrain,
  createDb,
  db,
  deleteWhere,
  diffQuery,
  eq,
  gte,
  index,
  insert,
  mat,
  qRows,
  trackTransact,
  transact,
  tryTransact,
  unique,
  updateWhere,
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

const medium = createBenchFixture('medium');
const large = createBenchFixture('large');
const singlePersonInsert = insert(benchSchema.people, extraPerson(0));
const batchTaskInserts = extraTasks(medium.data, 24).map((row) => insert(benchSchema.tasks, row));
const predicateTaskUpdate = updateWhere(benchSchema.tasks, gte(taskRef.points, 8), { priority: 5 });
const predicateTaskDelete = deleteWhere(benchSchema.tasks, eq(taskRef.done, true));
const constrained = mat(createDb(medium.data), constrain(unique(benchSchema.people, 'email')));
const duplicateEmailInsert = insert(benchSchema.people, duplicateEmailPerson(medium.data));
const materialized = mat(createDb(medium.data), {
  activePeople: medium.queries.activePeople,
  openTasks: medium.queries.openTasks,
  projectTaskAggregates: medium.queries.projectTaskAggregates
});
const incrementalMaterialized = mat(createDb(medium.data), {
  activePeople: medium.queries.activePeople,
  openTasks: medium.queries.openTasks
}, { mode: 'incremental' });
const materializedTaskInsert = insert(benchSchema.tasks, extraTask(medium.data, 100));
const incrementalPeopleInsert = insert(benchSchema.people, extraPerson(101));
const largeMaterializedJoin = mat(createDb(large.data), {
  taskProjectOwnerJoin: large.queries.taskProjectOwnerJoin
});
const largeIncrementalMaterializedJoin = mat(createDb(large.data), {
  taskProjectOwnerJoin: large.queries.taskProjectOwnerJoin
}, { mode: 'incremental' });
const largeMaterializedJoinTaskInsert = insert(benchSchema.tasks, extraTask(large.data, 200));
const watchBase = createDb(medium.data);
const watchNext = transact(watchBase, insert(benchSchema.people, extraPerson(200)));
const watchHandle = watch(watchBase, medium.queries.activePeople, () => undefined);
const trackedBase = watch(createDb(medium.data), medium.queries.activePeople, benchSchema.people);
const trackedInsert = insert(benchSchema.people, extraPerson(300));
const diffBefore = createDb(medium.data);
const diffAfter = transact(diffBefore, updateWhere(benchSchema.people, eq(personRef.id, medium.data.people[1]?.id ?? ''), {
  active: false
}));

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

  bench('materialized transact large: maintain joined task query', () => {
    consumeBenchResult(transact(largeMaterializedJoin, largeMaterializedJoinTaskInsert));
  }, options);

  bench('materialized transact large incremental: maintain joined task query', () => {
    consumeBenchResult(transact(largeIncrementalMaterializedJoin, largeMaterializedJoinTaskInsert));
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
