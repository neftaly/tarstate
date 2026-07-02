import { describe, expect, it } from 'vitest';
import {
  as,
  call,
  createDb,
  eq,
  from,
  mat,
  materializationForQuery,
  materializedRowsForQuery,
  pipe,
  project,
  qRows,
  queryRowsFromMaterialization,
  sort,
  transact,
  updateWhere
} from '@tarstate/core';
import { coreSchema, sourceData } from './fixtures';

const functions = {
  ageBucket: (age: unknown) => typeof age === 'number' && age >= 35 ? 'senior' : 'junior'
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

  it('diagnoses missing materialization function registries instead of serving wrong cached rows', async () => {
    const query = ageBucketQuery();
    const state = mat(createDb(sourceData), query, { id: 'missing-age-bucket' });
    const metadata = materializationForQuery(state, query);

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
});
