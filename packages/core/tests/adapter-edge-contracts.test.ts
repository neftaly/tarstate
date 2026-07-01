import { describe, expect, it } from 'vitest';
import {
  composeRelationRuntimes,
  insert,
  tryApplyRelationPatches,
  tryCommitAdapter,
  type RelationAdapter,
  type RelationApplyResult,
  type RelationRuntime,
  type WritePatch
} from '@tarstate/core';
import { adaUser, beaUser, coreSchema, engineeringTeam, reviewFixturesTask } from './fixtures';

type VersionTag = `head:${string}`;

describe('adapter edge contracts', () => {
  it('normalizes thrown and rejected commit/apply failures while preserving requested source versions', async () => {
    const thrownCommit = new Error('commit exploded');
    const rejectedCommit = new Error('commit rejected');
    const thrownApply = new Error('apply exploded');
    const rejectedApply = new Error('apply rejected');
    const throwingAdapter = adapterWithCommit(() => {
      throw thrownCommit;
    });
    const rejectingAdapter = adapterWithCommit(async () => {
      throw rejectedCommit;
    });
    const throwingRuntime = runtimeWithApply(() => {
      throw thrownApply;
    });
    const rejectingRuntime = runtimeWithApply(async () => {
      throw rejectedApply;
    });

    await expect(tryCommitAdapter(throwingAdapter, [insert(coreSchema.teams, engineeringTeam)], {
      readVersion: true
    })).resolves.toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      version: 'head:source',
      diagnostics: [expect.objectContaining({ message: 'adapter commit failed', detail: thrownCommit })]
    });
    await expect(tryCommitAdapter(rejectingAdapter, [insert(coreSchema.users, adaUser)], {
      readVersion: true
    })).resolves.toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      version: 'head:source',
      diagnostics: [expect.objectContaining({ message: 'adapter commit failed', detail: rejectedCommit })]
    });
    await expect(tryApplyRelationPatches(throwingRuntime, [insert(coreSchema.users, adaUser)], {
      readVersion: true
    })).resolves.toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      version: 'head:source',
      diagnostics: [expect.objectContaining({ message: 'relation runtime apply failed', detail: thrownApply })]
    });
    await expect(tryApplyRelationPatches(rejectingRuntime, [insert(coreSchema.users, beaUser)], {
      readVersion: true
    })).resolves.toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      version: 'head:source',
      diagnostics: [expect.objectContaining({ message: 'relation runtime apply failed', detail: rejectedApply })]
    });
  });

  it('preserves partial acceptance details, explicit heads, and normalizes legacy durable false', async () => {
    const runtime = runtimeWithApply(() => legacyApplyResult<VersionTag>({
      status: 'partial',
      patches: 99,
      applied: 1,
      deltas: [{ relation: coreSchema.users, added: [adaUser], removed: [] }],
      diagnostics: [{ code: 'missing_ref', relation: 'teams', message: 'team write was not applied' }],
      durability: false,
      version: 'head:target'
    }));

    const result = await tryApplyRelationPatches(runtime, [
      insert(coreSchema.users, adaUser),
      insert(coreSchema.teams, engineeringTeam)
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'partial',
      patches: 2,
      applied: 1,
      version: 'head:target',
      diagnostics: [expect.objectContaining({ code: 'missing_ref', relation: 'teams' })]
    });
    expect(result.deltas).toEqual([{ relation: coreSchema.users, added: [adaUser], removed: [] }]);
    expect(result).not.toHaveProperty('durability');
  });

  it('routes multi-relation composed writes to the runtime that owns each relation', async () => {
    const users = ownedRuntime('users', 'head:users');
    const teams = ownedRuntime('teams', 'head:teams');
    const runtime = composeRelationRuntimes(users.runtime, teams.runtime);

    const result = await tryApplyRelationPatches(runtime, [
      insert(coreSchema.users, adaUser),
      insert(coreSchema.teams, engineeringTeam),
      insert(coreSchema.users, beaUser)
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 3,
      applied: 3,
      diagnostics: [],
      version: ['head:users', 'head:teams']
    });
    expect(users.calls).toEqual([[insert(coreSchema.users, adaUser), insert(coreSchema.users, beaUser)]]);
    expect(teams.calls).toEqual([[insert(coreSchema.teams, engineeringTeam)]]);
  });

  it('rejects mixed writable and unwritable composed batches atomically', async () => {
    const users = ownedRuntime('users', 'head:users');
    const runtime = composeRelationRuntimes(users.runtime);

    const result = await tryApplyRelationPatches(runtime, [
      insert(coreSchema.users, adaUser),
      insert(coreSchema.tasks, reviewFixturesTask)
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 2,
      applied: 0,
      deltas: [],
      version: ['head:users'],
      diagnostics: [expect.objectContaining({ relation: 'tasks' })]
    });
    expect(users.calls).toEqual([]);
  });
});

function adapterWithCommit(
  commit: RelationAdapter<VersionTag>['commit']
): RelationAdapter<VersionTag> {
  return {
    source: { rows: () => [], version: () => 'head:source' },
    commit
  };
}

function runtimeWithApply(
  apply: NonNullable<RelationRuntime<VersionTag>['target']>['apply']
): RelationRuntime<VersionTag> {
  return {
    source: { rows: () => [], version: () => 'head:source' },
    target: { relationNames: ['users', 'teams'], apply }
  };
}

function ownedRuntime(relationName: string, version: VersionTag): {
  readonly calls: WritePatch[][];
  readonly runtime: RelationRuntime<VersionTag>;
} {
  const calls: WritePatch[][] = [];

  return {
    calls,
    runtime: {
      source: { relationNames: [relationName], rows: () => [], version: () => version },
      target: {
        relationNames: [relationName],
        ownsRelation: (candidate) => candidate === relationName,
        apply: (patches) => {
          calls.push([...patches]);
          return {
            status: 'accepted',
            patches: patches.length,
            applied: patches.length,
            deltas: [],
            diagnostics: [],
            version
          };
        }
      }
    }
  };
}

function legacyApplyResult<Version>(result: unknown): RelationApplyResult<Version> {
  return result as RelationApplyResult<Version>;
}
