import { describe, expect, it } from 'vitest';
import { fromObjectSource } from '@tarstate/core/source';
import { as, eq, from, keyBy, project, where } from '@tarstate/core/query';
import {
  deriveSnapshot,
  refreshDerivedSnapshot,
  rowsForDerivationIndex,
  type DerivationTarget
} from '../src/derivation-engine';
import { adaUser, beaUser, calUser, coreSchema, type UserRow } from './fixtures';

type ActiveUserRow = {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
};

const user = as(coreSchema.users, 'user');
const activeUsers = keyBy('id')(project({
  id: user.id,
  name: user.name,
  teamId: user.teamId
})(where(eq(user.active, true))(from(user))));

describe('derivation engine', () => {
  it('derives query snapshots with row identity, indexes, and diagnostics', async () => {
    const target: DerivationTarget<ActiveUserRow> = {
      kind: 'query',
      id: 'active-users',
      query: activeUsers,
      indexes: [{ id: 'by-team', kind: 'hash', fields: ['teamId'] }]
    };

    const snapshot = await deriveSnapshot(target, {
      source: fromObjectSource({ users: [adaUser, beaUser, calUser] }),
      version: 1
    });

    expect(snapshot.targetKey).toBe('active-users');
    expect(snapshot.version).toBe(1);
    expect(snapshot.rowIdentity).toEqual({ kind: 'fields', fields: ['id'] });
    expect([...snapshot.rowsByKey.keys()]).toEqual(['["ada"]', '["bea"]']);
    expect(rowsForDerivationIndex(snapshot, 'by-team', ['eng'])).toEqual([{
      id: 'ada',
      name: 'Ada',
      teamId: 'eng'
    }]);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('refreshes by diffing derived rows without consuming public materialization state', async () => {
    const target: DerivationTarget<ActiveUserRow> = {
      kind: 'query',
      query: activeUsers,
      indexes: [{ id: 'by-team', kind: 'hash', fields: ['teamId'] }]
    };
    const previous = await deriveSnapshot(target, {
      source: fromObjectSource({ users: [adaUser, beaUser] })
    });
    const nextAda: UserRow = { ...adaUser, name: 'Ada Lovelace' };
    const refresh = await refreshDerivedSnapshot(previous, {
      source: fromObjectSource({ users: [nextAda, calUser] }),
      deltas: [{
        relation: coreSchema.users,
        added: [nextAda, calUser],
        removed: [adaUser, beaUser]
      }]
    });

    expect(refresh.changed).toBe(true);
    expect(refresh.delta.added).toEqual([]);
    expect(refresh.delta.removed).toEqual([{
      id: 'bea',
      name: 'Bea',
      teamId: 'design'
    }]);
    expect(refresh.delta.updated).toEqual([{
      before: {
        id: 'ada',
        name: 'Ada',
        teamId: 'eng'
      },
      after: {
        id: 'ada',
        name: 'Ada Lovelace',
        teamId: 'eng'
      }
    }]);
    expect(refresh.delta.inputDeltas).toHaveLength(1);
    expect(refresh.diagnostics).toEqual([]);
  });
});
