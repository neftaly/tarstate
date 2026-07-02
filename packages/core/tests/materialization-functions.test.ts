import { describe, expect, it } from 'vitest';
import {
  aggregate,
  asc,
  as,
  call,
  count,
  createDb,
  eq,
  extend,
  field,
  from,
  mat,
  materializationForQuery,
  materializedRowsForQuery,
  pipe,
  project,
  qRows,
  queryRowsFromMaterialization,
  sort,
  sum,
  transact,
  updateWhere,
  where
} from '@tarstate/core';
import { coreSchema, sourceData } from './fixtures';

const functions = {
  activeScore: (active: unknown) => active === true ? 1 : 0,
  ageBucket: (age: unknown) => typeof age === 'number' && age >= 35 ? 'senior' : 'junior',
  ageDecade: (age: unknown) => typeof age === 'number' ? Math.floor(age / 10) * 10 : undefined,
  ageLabel: (name: unknown, age: unknown) => `${String(name)}:${String(age)}`,
  ageOnes: (age: unknown) => typeof age === 'number' ? age % 10 : undefined,
  isSenior: (age: unknown) => typeof age === 'number' && age >= 35
};

function ageBucketQuery() {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    project({
      id: user.id,
      bucket: call<string>('ageBucket', user.age)
    }),
    sort(user.id)
  );
}

describe('materialized named function calls', () => {
  it('evaluates named calls in ordinary qRows with a function registry', async () => {
    const query = ageBucketQuery();

    await expect(qRows(createDb(sourceData), query, { functions })).resolves.toEqual([
      { id: 'ada', bucket: 'senior' },
      { id: 'bea', bucket: 'junior' },
      { id: 'cal', bucket: 'senior' }
    ]);
  });

  it('uses materialization function registries for initial rows and maintenance', async () => {
    const user = as(coreSchema.users, 'user');
    const query = ageBucketQuery();
    const state = mat(createDb(sourceData), query, {
      id: 'age-buckets',
      mode: 'incremental',
      functions
    });

    const initialRows = [
      { id: 'ada', bucket: 'senior' },
      { id: 'bea', bucket: 'junior' },
      { id: 'cal', bucket: 'senior' }
    ];
    expect(materializationForQuery(state, query)).toMatchObject({
      id: 'age-buckets',
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(materializationForQuery(state, query)?.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'materialization_unsupported' })
    );
    expect(materializedRowsForQuery(state, query)).toEqual(initialRows);
    await expect(qRows(state, query)).resolves.toEqual(initialRows);
    await expect(qRows(state, query, { functions })).resolves.toEqual(initialRows);

    const next = transact(state, updateWhere(coreSchema.users, eq(user.id, 'bea'), { age: 36 }));
    const nextRows = [
      { id: 'ada', bucket: 'senior' },
      { id: 'bea', bucket: 'senior' },
      { id: 'cal', bucket: 'senior' }
    ];

    expect(materializedRowsForQuery(next, query)).toEqual(nextRows);
    await expect(qRows(next, query)).resolves.toEqual(nextRows);
    await expect(qRows(next, query, { functions })).resolves.toEqual(nextRows);
  });

  it('incrementally maintains named calls in where, project, and extend expressions', async () => {
    const user = as(coreSchema.users, 'user');
    const label = field<string>('computed', 'label');
    const query = pipe(
      from(user),
      extend({ label: call<string>('ageLabel', user.name, user.age) }),
      where(eq(call<boolean>('isSenior', user.age), true)),
      project({
        id: user.id,
        label,
        bucket: call<string>('ageBucket', user.age)
      }),
      sort(user.id)
    );
    const state = mat(createDb(sourceData), query, {
      id: 'senior-labels',
      mode: 'incremental',
      functions
    });

    expect(materializationForQuery(state, query)).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(materializationForQuery(state, query)?.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'materialization_unsupported' })
    );
    expect(materializedRowsForQuery(state, query)).toEqual([
      { id: 'ada', label: 'Ada:37', bucket: 'senior' },
      { id: 'cal', label: 'Cal:41', bucket: 'senior' }
    ]);

    const next = transact(state, updateWhere(coreSchema.users, eq(user.id, 'bea'), { age: 36 }));

    expect(materializedRowsForQuery(next, query)).toEqual([
      { id: 'ada', label: 'Ada:37', bucket: 'senior' },
      { id: 'bea', label: 'Bea:36', bucket: 'senior' },
      { id: 'cal', label: 'Cal:41', bucket: 'senior' }
    ]);
  });

  it('incrementally maintains named calls in sort order expressions', () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(
      from(user),
      sort(asc(call<number>('ageOnes', user.age)), asc(user.id)),
      project({ id: user.id, name: user.name, age: user.age })
    );
    const state = mat(createDb(sourceData), query, {
      id: 'users-by-named-age-ones',
      mode: 'incremental',
      functions
    });

    expect(materializationForQuery(state, query)).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(materializedRowsForQuery(state, query)).toEqual([
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 },
      { id: 'bea', name: 'Bea', age: 29 }
    ]);

    const next = transact(state, updateWhere(coreSchema.users, eq(user.id, 'bea'), { age: 40 }));

    expect(materializedRowsForQuery(next, query)).toEqual([
      { id: 'bea', name: 'Bea', age: 40 },
      { id: 'cal', name: 'Cal', age: 41 },
      { id: 'ada', name: 'Ada', age: 37 }
    ]);
  });

  it('incrementally maintains named calls in aggregate groupBy and input expressions', () => {
    const user = as(coreSchema.users, 'user');
    const decade = field<number>('ageRollup', 'decade');
    const query = pipe(
      from(user),
      aggregate({
        groupBy: { decade: call<number>('ageDecade', user.age) },
        aggregates: {
          users: count(),
          activeUsers: sum(call<number>('activeScore', user.active))
        }
      }),
      sort(asc(decade))
    );
    const state = mat(createDb(sourceData), query, {
      id: 'named-age-rollups',
      mode: 'incremental',
      functions
    });

    expect(materializationForQuery(state, query)).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'incremental'
    });
    expect(materializedRowsForQuery(state, query)).toEqual([
      { decade: 20, users: 1, activeUsers: 1 },
      { decade: 30, users: 1, activeUsers: 1 },
      { decade: 40, users: 1, activeUsers: 0 }
    ]);

    const next = transact(state, updateWhere(coreSchema.users, eq(user.id, 'bea'), { age: 36 }));

    expect(materializedRowsForQuery(next, query)).toEqual([
      { decade: 30, users: 2, activeUsers: 2 },
      { decade: 40, users: 1, activeUsers: 0 }
    ]);
  });

  it('diagnoses missing materialization function registries instead of serving wrong cached rows', async () => {
    const query = ageBucketQuery();
    const state = mat(createDb(sourceData), query, { id: 'missing-age-bucket', mode: 'incremental' });
    const metadata = materializationForQuery(state, query);

    expect(metadata).toMatchObject({
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expect(metadata?.diagnostics).toContainEqual(expect.objectContaining({
      code: 'materialization_unsupported',
      message: 'materialization function ageBucket is not available'
    }));
    expect(queryRowsFromMaterialization(state, query)).toBeUndefined();
    await expect(qRows(state, query, { functions })).resolves.toEqual([
      { id: 'ada', bucket: 'senior' },
      { id: 'bea', bucket: 'junior' },
      { id: 'cal', bucket: 'senior' }
    ]);
  });

  it('does not serve cached rows when the requested registry uses a different function identity', async () => {
    const query = ageBucketQuery();
    const state = mat(createDb(sourceData), query, {
      id: 'age-buckets-registry-identity',
      mode: 'incremental',
      functions
    });
    const alternateFunctions = {
      ageBucket: () => 'alternate'
    };

    expect(materializedRowsForQuery(state, query)).toEqual([
      { id: 'ada', bucket: 'senior' },
      { id: 'bea', bucket: 'junior' },
      { id: 'cal', bucket: 'senior' }
    ]);
    await expect(qRows(state, query, { functions: alternateFunctions })).resolves.toEqual([
      { id: 'ada', bucket: 'alternate' },
      { id: 'bea', bucket: 'alternate' },
      { id: 'cal', bucket: 'alternate' }
    ]);
  });
});
