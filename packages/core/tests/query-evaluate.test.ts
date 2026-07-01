import { describe, expect, it } from 'vitest';
import {
  aggregate,
  as,
  asc,
  call,
  count,
  desc,
  env,
  eq,
  evaluate,
  expand,
  field,
  from,
  gt,
  join,
  leftJoin,
  limit,
  maybe,
  pipe,
  project,
  sort,
  sum,
  where
} from '@tarstate/core';
import { coreSchema, indexedSource, objectSource } from './fixtures';

describe('query and evaluate contracts', () => {
  it('evaluates from/where/project/sort/limit against an object source', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(
      from(user),
      where(eq(user.active, true)),
      project({ id: user.id, name: user.name, age: user.age }),
      sort(desc(field('user', 'age'))),
      limit(1)
    );

    await expect(evaluate(objectSource(), query)).resolves.toEqual({
      rows: [{ id: 'ada', name: 'Ada', age: 37 }],
      diagnostics: []
    });
  });

  it('uses indexed equality lookups without changing query results', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(
      from(user),
      where(eq(user.teamId, 'eng')),
      project({ id: user.id, name: user.name })
    );

    await expect(evaluate(indexedSource(), query)).resolves.toMatchObject({
      rows: [{ id: 'ada', name: 'Ada' }],
      diagnostics: []
    });
  });

  it('evaluates inner and left joins with optional projections', async () => {
    const user = as(coreSchema.users, 'user');
    const team = as(coreSchema.teams, 'team');
    const inner = pipe(
      from(user),
      join(from(team), eq(user.teamId, team.id)),
      project({ user: user.name, team: team.name }),
      sort(asc(user.name))
    );
    const left = pipe(
      from(user),
      leftJoin(from(team), eq(user.teamId, team.id)),
      project({ user: user.name, team: maybe(team.name) }),
      sort(asc(user.name))
    );

    await expect(evaluate(objectSource(), inner)).resolves.toMatchObject({
      rows: [
        { user: 'Ada', team: 'Engineering' },
        { user: 'Bea', team: 'Design' }
      ]
    });
    await expect(evaluate(objectSource(), left)).resolves.toMatchObject({
      rows: [
        { user: 'Ada', team: 'Engineering' },
        { user: 'Bea', team: 'Design' },
        { user: 'Cal', team: undefined }
      ]
    });
  });

  it('evaluates aggregate, expand, env, and call expressions', async () => {
    const user = as(coreSchema.users, 'user');
    const task = as(coreSchema.tasks, 'task');
    const summary = pipe(
      from(task),
      where(gt(task.points, env<number>('minimumPoints'))),
      aggregate({
        groupBy: { ownerId: task.ownerId },
        aggregates: { count: count(), points: sum(task.points) }
      }),
      sort(desc(field('task', 'points')))
    );
    const expanded = pipe(
      from(user),
      expand(field<readonly string[]>('user', 'tags'), { as: 'tag' }),
      project({ user: user.id, label: call<string>('upper', field('tag', 'value')) })
    );

    await expect(evaluate(objectSource(), summary, { env: { minimumPoints: 3 } })).resolves.toMatchObject({
      rows: [
        { ownerId: 'ada', count: 2, points: 13 }
      ]
    });
    await expect(evaluate(objectSource(), expanded, {
      functions: { upper: (value) => String(value).toUpperCase() }
    })).resolves.toMatchObject({
      rows: [
        { user: 'ada', label: 'COMPILER' },
        { user: 'ada', label: 'RUNTIME' },
        { user: 'bea', label: 'RESEARCH' }
      ]
    });
  });

  it('retains canonical construction for currently supported advanced query nodes', () => {
    const task = as(coreSchema.tasks, 'task');
    const query = pipe(
      from(task),
      aggregate({
        groupBy: { ownerId: task.ownerId },
        aggregates: { total: sum(task.points), count: count() }
      })
    );

    expect(query.data).toMatchObject({
      op: 'aggregate',
      groupBy: { ownerId: { op: 'field', alias: 'task', field: 'ownerId' } },
      aggregates: {
        total: { op: 'aggregateCall', name: 'sum' },
        count: { op: 'aggregateCall', name: 'count' }
      }
    });
  });
});
