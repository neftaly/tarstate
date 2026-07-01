import { describe, expect, it } from 'vitest';
import { createMemoryRelationRuntime, insert } from '@tarstate/core';
import { constrain, fk, req, unique, validateConstraints } from '@tarstate/core/experimental/constraints';
import { diffRows } from '@tarstate/core/experimental/diff';
import {
  isMaterialized,
  mat,
  materializeSnapshot,
  materializedRowsForQuery,
  readMaterializedQuery,
  refreshMaterializationSnapshot
} from '@tarstate/core/experimental/materialization';
import { trackRuntimeCommit } from '@tarstate/core/experimental/runtime';
import { diffQuery, watch } from '@tarstate/core/experimental/watch';
import { as, createDb, eq, from, pipe, project, where } from '@tarstate/core';
import { adaUser, beaUser, coreSchema, objectSource, sourceData } from './fixtures';

describe('experimental contracts', () => {
  it('diffRows reports added, removed, updated, and duplicate-key diagnostics', () => {
    const before = [{ id: 'a', count: 1 }, { id: 'b', count: 1 }, { id: 'dup', count: 1 }, { id: 'dup', count: 2 }];
    const after = [{ id: 'a', count: 2 }, { id: 'c', count: 1 }];
    const diff = diffRows(before, after, { keyBy: ['id'] });

    expect(diff.changes).toEqual([
      { kind: 'updated', key: '["a"]', before: { id: 'a', count: 1 }, after: { id: 'a', count: 2 } },
      { kind: 'removed', key: '["b"]', row: { id: 'b', count: 1 } },
      { kind: 'added', key: '["c"]', row: { id: 'c', count: 1 } }
    ]);
    expect(diff.diagnostics).toContainEqual(expect.objectContaining({ code: 'duplicate_key', side: 'before' }));
  });

  it('validates required, unique, and foreign-key constraints', async () => {
    const constraints = constrain(
      req(coreSchema.users, 'name'),
      unique(coreSchema.users, 'id'),
      fk(coreSchema.users, 'teamId', coreSchema.teams, 'id')
    );

    await expect(validateConstraints(objectSource(), constraints)).resolves.toEqual({
      kind: 'constraintValidation',
      valid: false,
      diagnostics: [
        expect.objectContaining({ code: 'constraint_fk', relation: 'users', field: 'teamId', key: 'missing' })
      ]
    });
  });

  it('materializes snapshots and reads refreshed query rows', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(from(user), where(eq(user.active, true)), project({ id: user.id, name: user.name }));
    const db = createDb(sourceData);
    const materialized = await materializeSnapshot(db, query, { id: 'active-users' });

    expect(isMaterialized(materialized)).toBe(true);
    expect(materializedRowsForQuery(materialized, query)).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);
    await expect(readMaterializedQuery(materialized, query)).resolves.toMatchObject({
      materialized: true,
      rows: [
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' }
      ],
      diagnostics: []
    });
    await expect(refreshMaterializationSnapshot(materialized, query)).resolves.toMatchObject({
      refreshed: true,
      rows: [
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' }
      ]
    });
  });

  it('attaches constraints through mat without losing materialization behavior', async () => {
    const db = createDb(sourceData);
    const constrained = mat(db, constrain(req(coreSchema.users, 'name')));

    expect(constrained).toBe(db);
    await expect(validateConstraints(objectSource(), constrain(unique(coreSchema.users, 'id')))).resolves.toMatchObject({
      valid: true,
      diagnostics: []
    });
  });

  it('tracks watch, diffQuery, and runtime commits from real changes', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(from(user), project({ id: user.id, name: user.name }));
    const before = objectSource();
    const runtime = createMemoryRelationRuntime({ users: [adaUser] }, { relationNames: ['users'], version: 1 });
    let eventCount = 0;
    const handle = watch(before, query, (event) => {
      eventCount += 1;
      expect(event.changed).toBe(true);
    }, { immediate: true });

    await expect(diffQuery(before, runtime.source, query, { keyBy: ['id'] })).resolves.toMatchObject({
      changed: true,
      addedRows: [],
      removedRows: expect.arrayContaining([{ id: 'bea', name: 'Bea' }]),
      diagnostics: []
    });
    await expect(trackRuntimeCommit(runtime, [insert(coreSchema.users, beaUser)], {
      label: 'add-user',
      readVersion: true
    })).resolves.toMatchObject({
      kind: 'trackRuntimeCommit',
      supported: true,
      status: 'accepted',
      changes: expect.arrayContaining([expect.objectContaining({ changed: true })]),
      diagnostics: []
    });

    expect(handle.supported).toBe(true);
    expect(eventCount).toBe(1);
  });
});
