import { describe, expect, it } from 'vitest';
import {
  aggregate,
  as,
  asc,
  bottom,
  bottomBy,
  btree,
  constRows,
  defineSchema,
  desc,
  difference,
  evaluate,
  field,
  from,
  fromObjectSource,
  hash,
  intersection,
  keyBy,
  lookup,
  nullable,
  numberField,
  pipe,
  project,
  queryRowKeyFields,
  relation,
  rowKeyFields,
  sort,
  sortLimit,
  stringField,
  top,
  topBy,
  union,
  uniqueIndex,
  type QueryData
} from '@tarstate/core';
import { coreSchema, indexedSource, objectSource, reviewFixturesTask, shipRuntimeTask, type TaskRow } from './fixtures';

type PointRow = {
  readonly id: string;
  readonly score: number;
};

type RankingRow = {
  readonly id: string;
  readonly rank: number | null;
};

type TaskContext = {
  readonly task: TaskRow;
};

const leftPoints = constRows<PointRow>([
  { id: 'a', score: 1 },
  { id: 'b', score: 2 },
  { id: 'b', score: 2 },
  { id: 'c', score: 3 }
]);
const rightPoints = constRows<PointRow>([
  { id: 'b', score: 2 },
  { id: 'd', score: 4 }
]);

const rankingSchema = defineSchema({
  rankings: relation<RankingRow>({
    key: 'id',
    fields: {
      id: stringField(),
      rank: nullable(numberField())
    }
  })
});

const rankingSource = fromObjectSource({
  rankings: [
    { id: 'missing', rank: null },
    { id: 'third', rank: 3 },
    { id: 'first', rank: 1 },
    { id: 'second', rank: 2 }
  ] satisfies readonly RankingRow[]
});

function expectQueryData(input: QueryData | undefined): QueryData {
  expect(input).toBeDefined();
  if (input === undefined) {
    throw new Error('expected query data');
  }

  return input;
}

describe('less-used query helper contracts', () => {
  it('evaluates union, intersection, and difference with structural set semantics', async () => {
    await expect(evaluate(objectSource(), union(leftPoints, rightPoints))).resolves.toMatchObject({
      rows: [
        { id: 'a', score: 1 },
        { id: 'b', score: 2 },
        { id: 'c', score: 3 },
        { id: 'd', score: 4 }
      ],
      diagnostics: []
    });
    await expect(evaluate(objectSource(), intersection(leftPoints, rightPoints))).resolves.toMatchObject({
      rows: [{ id: 'b', score: 2 }],
      diagnostics: []
    });
    await expect(evaluate(objectSource(), difference(leftPoints, rightPoints))).resolves.toMatchObject({
      rows: [
        { id: 'a', score: 1 },
        { id: 'c', score: 3 }
      ],
      diagnostics: []
    });
  });

  it('evaluates sortLimit as sorted top-N without a separate limit node', async () => {
    const task = as(coreSchema.tasks, 'task');
    const query = pipe(
      from(task),
      sortLimit(2, desc(task.points)),
      project({ id: task.id, points: task.points })
    );

    expect(query.data).toMatchObject({
      op: 'select',
      input: {
        op: 'sortLimit',
        count: 2,
        order: [{ direction: 'desc', expr: { op: 'field', alias: 'task', field: 'points' } }]
      }
    });
    await expect(evaluate(objectSource(), query)).resolves.toMatchObject({
      rows: [
        { id: 't2', points: 8 },
        { id: 't1', points: 5 }
      ],
      diagnostics: []
    });
  });

  it('preserves explicit null sort order for ascending and descending helpers', async () => {
    const ranking = as(rankingSchema.rankings, 'ranking');
    const ascending = pipe(from(ranking), sort(asc(ranking.rank, 'last')), project({ id: ranking.id }));
    const descending = pipe(from(ranking), sort(desc(ranking.rank, 'first')), project({ id: ranking.id }));

    expect(ascending.data).toMatchObject({
      input: {
        op: 'sort',
        order: [{ direction: 'asc', nulls: 'last', expr: { op: 'field', alias: 'ranking', field: 'rank' } }]
      }
    });
    expect(descending.data).toMatchObject({
      input: {
        op: 'sort',
        order: [{ direction: 'desc', nulls: 'first', expr: { op: 'field', alias: 'ranking', field: 'rank' } }]
      }
    });
    await expect(evaluate(rankingSource, ascending)).resolves.toMatchObject({
      rows: [{ id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'missing' }],
      diagnostics: []
    });
    await expect(evaluate(rankingSource, descending)).resolves.toMatchObject({
      rows: [{ id: 'missing' }, { id: 'third' }, { id: 'second' }, { id: 'first' }],
      diagnostics: []
    });
  });

  it('builds lookup roots from public relation aliases and evaluates through indexed sources', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(
      lookup(user, 'teamId', 'eng'),
      project({ id: user.id, name: user.name })
    );

    expect(query.data).toMatchObject({
      op: 'select',
      input: {
        op: 'lookup',
        relation: 'users',
        alias: 'user',
        field: 'teamId',
        value: { op: 'value', value: 'eng' }
      }
    });
    expect(Object.keys(query.relations)).toEqual(['users']);
    await expect(evaluate(indexedSource(), query)).resolves.toMatchObject({
      rows: [{ id: 'ada', name: 'Ada' }],
      diagnostics: []
    });
  });

  it('tracks keyBy row identity metadata across row-preserving helpers', () => {
    const task = as(coreSchema.tasks, 'task');
    const query = pipe(
      from(task),
      project({ id: task.id, ownerId: task.ownerId, points: task.points }),
      keyBy('ownerId', 'id'),
      sortLimit(1, desc(field('task', 'points')))
    );

    expect(query.data).toMatchObject({
      op: 'sortLimit',
      input: { op: 'keyBy', fields: ['ownerId', 'id'] }
    });
    expect(queryRowKeyFields(query)).toEqual(['ownerId', 'id']);
    expect(rowKeyFields(query.data)).toEqual(['ownerId', 'id']);
  });

  it('retains hash, uniqueIndex, and btree metadata in declaration order', () => {
    const task = as(coreSchema.tasks, 'task');
    const query = pipe(
      from(task),
      hash(task.ownerId),
      uniqueIndex(task.id),
      btree(task.points)
    );
    const btreeData = expectQueryData(query.data);
    const uniqueData = expectQueryData(btreeData.op === 'btree' ? btreeData.input : undefined);
    const hashData = expectQueryData(uniqueData.op === 'hash' ? uniqueData.input : undefined);

    expect(btreeData).toMatchObject({
      op: 'btree',
      expressions: [{ op: 'field', alias: 'task', field: 'points' }]
    });
    expect(uniqueData).toMatchObject({
      op: 'hash',
      unique: true,
      expressions: [{ op: 'field', alias: 'task', field: 'id' }]
    });
    expect(hashData).toMatchObject({
      op: 'hash',
      expressions: [{ op: 'field', alias: 'task', field: 'ownerId' }]
    });
  });

  it('constructs top and bottom aggregate calls with explicit counts', () => {
    const task = as(coreSchema.tasks, 'task');
    const query = pipe(
      from(task),
      aggregate({
        aggregates: {
          high: top(2, task.points),
          low: bottom(2, task.points)
        }
      })
    );

    expect(query.data).toMatchObject({
      op: 'aggregate',
      aggregates: {
        high: { op: 'aggregateCall', name: 'top', count: 2, distinct: false },
        low: { op: 'aggregateCall', name: 'bottom', count: 2, distinct: false }
      }
    });
    expect(() => top(-1, task.points)).toThrow(RangeError);
  });

  it('evaluates topBy and bottomBy aggregate rows by ordering expression', async () => {
    const task = as(coreSchema.tasks, 'task');
    const query = pipe(
      from(task),
      aggregate({
        aggregates: {
          topTasks: topBy<TaskContext>(1, task.points),
          bottomTasks: bottomBy<TaskContext>(1, task.points)
        }
      })
    );

    expect(query.data).toMatchObject({
      op: 'aggregate',
      aggregates: {
        topTasks: { op: 'aggregateCall', name: 'topBy', count: 1 },
        bottomTasks: { op: 'aggregateCall', name: 'bottomBy', count: 1 }
      }
    });
    await expect(evaluate(objectSource(), query)).resolves.toMatchObject({
      rows: [{
        topTasks: [{ task: shipRuntimeTask }],
        bottomTasks: [{ task: reviewFixturesTask }]
      }],
      diagnostics: []
    });
  });
});
