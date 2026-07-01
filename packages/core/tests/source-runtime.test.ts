import { describe, expect, it } from 'vitest';
import {
  composeRelationRuntimes,
  composeSources,
  createMemoryRelationRuntime,
  insert,
  isRelationAdapter,
  isRelationRuntime,
  tryApplyRelationPatches,
  tryCommitAdapter,
  type RelationAdapter,
  type RelationRuntime
} from '@tarstate/core';
import { fromIndexedObjectSource } from '@tarstate/core/experimental/indexed-source';
import { adaUser, beaUser, coreSchema, engineeringTeam, sourceData } from './fixtures';

describe('source and runtime contracts', () => {
  it('composes relation sources and preserves relation discovery', async () => {
    const source = composeSources(
      { relationNames: ['teams'], rows: (relation) => relation.name === 'teams' ? [engineeringTeam] : [] },
      { relationNames: ['users'], rows: (relation) => relation.name === 'users' ? [adaUser] : [] }
    );

    expect(source.relationNames).toEqual(['teams', 'users']);
    await expect(source.rows(coreSchema.teams)).resolves.toEqual([engineeringTeam]);
    await expect(source.rows(coreSchema.users)).resolves.toEqual([adaUser]);
  });

  it('serves indexed object equality and range lookups', async () => {
    const source = fromIndexedObjectSource(sourceData);

    await expect(Promise.resolve(source.lookup?.({
      relation: coreSchema.users,
      field: 'teamId',
      value: 'eng'
    }))).resolves.toEqual([
      adaUser
    ]);
    await expect(Promise.resolve(source.rangeLookup?.({
      relation: coreSchema.users,
      field: 'age',
      lower: { value: 30, inclusive: true },
      upper: { value: 40, inclusive: false }
    }))).resolves.toEqual([adaUser]);
  });

  it('keeps memory runtimes readable, writable, versioned, and subscribable', async () => {
    const runtime = createMemoryRelationRuntime({ users: [adaUser] }, { relationNames: ['users'], version: 7 });
    let notifications = 0;
    const unsubscribe = runtime.subscribe?.(() => {
      notifications += 1;
    });
    const result = await tryApplyRelationPatches(runtime, [insert(coreSchema.users, beaUser)], { readVersion: true });

    await expect(Promise.resolve(runtime.source.rows(coreSchema.users))).resolves.toEqual([adaUser, beaUser]);
    expect(result).toMatchObject({ status: 'accepted', applied: 1, durability: 'memory', version: 8 });
    expect(notifications).toBe(1);
    unsubscribe?.();
  });

  it('routes composed runtime patches to the target that owns each relation', async () => {
    const usersRuntime = targetRuntime('users');
    const teamsRuntime = targetRuntime('teams');
    const runtime = composeRelationRuntimes(usersRuntime, teamsRuntime);
    const result = await tryApplyRelationPatches(runtime, [
      insert(coreSchema.users, adaUser),
      insert(coreSchema.teams, engineeringTeam)
    ]);

    expect(result).toMatchObject({ status: 'accepted', patches: 2, applied: 2, diagnostics: [] });
  });

  it('normalizes adapter/runtime guard and commit helper results', async () => {
    const adapter: RelationAdapter<string> = {
      source: { rows: () => [], version: () => 'v2' },
      commit: () => ({ status: 'accepted', patches: 0, applied: 99, deltas: [], diagnostics: [] })
    };

    expect(isRelationRuntime(adapter)).toBe(true);
    expect(isRelationAdapter(adapter)).toBe(true);
    await expect(tryCommitAdapter(adapter, [insert(coreSchema.teams, engineeringTeam)], { readVersion: true })).resolves.toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 99,
      version: 'v2',
      diagnostics: []
    });
  });
});

function targetRuntime(relationName: string): RelationRuntime {
  return {
    source: { relationNames: [relationName], rows: () => [], version: () => relationName },
    target: {
      relationNames: [relationName],
      ownsRelation: (candidate) => candidate === relationName,
      apply: (patches) => ({
        status: 'accepted',
        patches: patches.length,
        applied: patches.length,
        deltas: [],
        diagnostics: [],
        version: relationName
      })
    }
  };
}
