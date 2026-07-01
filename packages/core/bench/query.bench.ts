import { bench, describe } from 'vitest';
import {
  createDb,
  evaluate,
  from,
  hash,
  index,
  insert,
  keyBy,
  lookup,
  mat,
  materializedRowsForQuery,
  pipe,
  project,
  qMany,
  qRows,
  queryKey,
  transact,
  type Query,
  type RelationSource
} from '@tarstate/core';
import { benchSchema, consumeBenchResult, createBenchFixture, extraPerson, personRef } from './fixtures';

const options = {
  time: 200,
  warmupTime: 50,
  iterations: 10
};

const medium = createBenchFixture('medium');
const large = createBenchFixture('large');
const largeLookupPerson = large.data.people[Math.floor(large.data.people.length / 2)] ?? large.data.people[0]!;
const maintainedLookupPerson = extraPerson(700);
const peopleById = pipe(
  from(personRef),
  hash(personRef.id),
  project({
    id: personRef.id,
    name: personRef.name,
    email: personRef.email,
    role: personRef.role,
    region: personRef.region,
    active: personRef.active,
    capacity: personRef.capacity,
    skills: personRef.skills
  }),
  keyBy('id')
);
const lookupExistingPersonById = pipe(
  lookup(personRef, 'id', largeLookupPerson.id),
  project({
    id: personRef.id,
    email: personRef.email,
    role: personRef.role,
    capacity: personRef.capacity
  }),
  keyBy('id')
);
const lookupMaintainedPersonById = pipe(
  lookup(personRef, 'id', maintainedLookupPerson.id),
  project({
    id: personRef.id,
    email: personRef.email,
    role: personRef.role,
    capacity: personRef.capacity
  }),
  keyBy('id')
);
const materializedPeopleById = mat(createDb(large.data), peopleById, {
  id: 'people-by-id',
  mode: 'incremental'
});
const maintainedPeopleById = transact(
  materializedPeopleById,
  insert(benchSchema.people, maintainedLookupPerson)
);
const materializedPeopleLookupSource = materializedHashLookupSource(materializedPeopleById, peopleById, 'id');
const maintainedPeopleLookupSource = materializedHashLookupSource(maintainedPeopleById, peopleById, 'id');

function materializedHashLookupSource<Row>(
  db: object,
  query: Query<Row>,
  field: string
): RelationSource {
  return {
    relationNames: [benchSchema.people.name],
    rows: () => materializedRowsForQuery(db, query) ?? [],
    lookup: ({ relation, field: lookupField, value }) => {
      if (relation.name !== benchSchema.people.name || lookupField !== field) {
        return undefined;
      }

      return index<Row, unknown>(db, query, { kind: 'hash', field }).index?.get(value) ?? [];
    }
  };
}

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

  bench('lookup query path: materialized hash source before maintained insert', async () => {
    consumeBenchResult(await evaluate(materializedPeopleLookupSource, lookupExistingPersonById));
  }, options);

  bench('lookup query path: materialized hash source after maintained insert', async () => {
    consumeBenchResult(await evaluate(maintainedPeopleLookupSource, lookupMaintainedPersonById));
  }, options);
});
