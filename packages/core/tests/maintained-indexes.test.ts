import { describe, expect, it } from 'vitest';
import {
  as,
  btree,
  call,
  createDb,
  deleteByKey,
  eq,
  extend,
  field,
  from,
  hash,
  index,
  insert,
  keyBy,
  lookup,
  mat,
  materializationForQuery,
  pipe,
  project,
  qRows,
  transact,
  tryTransact,
  uniqueIndex,
  updateWhere,
  type Db,
  type DbTransactionResult,
  type Query
} from '@tarstate/core';
import {
  adaUser,
  coreSchema,
  sourceData,
  type UserRow
} from './fixtures';

type ExpressionIndexedUser = UserRow & {
  readonly normalizedTeam: string;
  readonly ageDecade: number;
  readonly slug: string;
};

const diaUser: UserRow = {
  id: 'dia',
  teamId: 'eng',
  name: 'Dia',
  active: true,
  age: 24,
  tags: ['runtime']
};

function normalizeTeam(teamId: string): string {
  return teamId.toUpperCase();
}

function ageDecade(age: number): number {
  return Math.floor(age / 10) * 10;
}

function userSlug(teamId: string, id: string): string {
  return `${teamId}:${id}`;
}

function expectIncrementalMaintenance(result: DbTransactionResult, id: string): Db {
  expect(result).toMatchObject({ committed: true });
  const change = result.materializations?.changes.find((item) => item.id === id);
  expect(change).toMatchObject({
    id,
    update: 'incremental',
    maintenance: 'incremental',
    recomputed: false
  });
  expect([
    ...result.diagnostics,
    ...(result.materializations?.diagnostics ?? []),
    ...(change?.diagnostics ?? [])
  ].map((diagnostic) => diagnostic.code)).not.toContain('materialization_incremental_fallback');
  return result.db;
}

function ids(rows: readonly { readonly id: string }[] | undefined): readonly string[] {
  return (rows ?? []).map((row) => row.id);
}

function cloneUsers(): UserRow[] {
  return sourceData.users.map((row) => ({
    ...(row as UserRow),
    tags: [...(row as UserRow).tags]
  }));
}

function testData(users: readonly UserRow[] = cloneUsers()): typeof sourceData {
  return {
    ...sourceData,
    users
  };
}

function compoundIndexedUsersQuery(): Query<UserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    hash(user.teamId, user.active),
    uniqueIndex(user.teamId, user.id),
    project({
      id: user.id,
      teamId: user.teamId,
      name: user.name,
      active: user.active,
      age: user.age,
      tags: user.tags
    }),
    keyBy('id')
  ) as Query<UserRow>;
}

function expressionIndexedUsersQuery(): Query<ExpressionIndexedUser> {
  const user = as(coreSchema.users, 'user');
  const normalizedTeam = field<string>('computed', 'normalizedTeam');
  const ageDecadeField = field<number>('computed', 'ageDecade');
  const slug = field<string>('computed', 'slug');

  return pipe(
    from(user),
    extend({
      normalizedTeam: call(normalizeTeam, user.teamId),
      ageDecade: call(ageDecade, user.age),
      slug: call(userSlug, user.teamId, user.id)
    }),
    hash(normalizedTeam),
    btree(ageDecadeField),
    uniqueIndex(slug),
    project({
      id: user.id,
      teamId: user.teamId,
      name: user.name,
      active: user.active,
      age: user.age,
      tags: user.tags,
      normalizedTeam,
      ageDecade: ageDecadeField,
      slug
    }),
    keyBy('id')
  ) as Query<ExpressionIndexedUser>;
}

function lookupRoutedUsersQuery(): Query<UserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    hash(user.teamId),
    uniqueIndex(user.id),
    project({
      id: user.id,
      teamId: user.teamId,
      name: user.name,
      active: user.active,
      age: user.age,
      tags: user.tags
    }),
    keyBy('id')
  ) as Query<UserRow>;
}

function expectCompoundIndexes(db: Db, query: Query<UserRow>, expected: {
  readonly engActive: readonly string[];
  readonly designInactive: readonly string[];
  readonly uniqueRow?: UserRow;
}): void {
  const hashByTeamActive = index<UserRow, string>(db, query, {
    kind: 'hash',
    fields: ['teamId', 'active']
  });
  const uniqueByTeamId = index<UserRow, string>(db, query, {
    kind: 'unique',
    fields: ['teamId', 'id']
  });

  expect(ids(hashByTeamActive.index?.rowsFor('eng', true))).toEqual(expected.engActive);
  expect(ids(hashByTeamActive.index?.rowsFor('design', false))).toEqual(expected.designInactive);
  expect(uniqueByTeamId.index?.rowFor('eng', 'ada')).toEqual(adaUser);
  if (expected.uniqueRow !== undefined) {
    expect(uniqueByTeamId.index?.rowFor(expected.uniqueRow.teamId, expected.uniqueRow.id)).toEqual(expected.uniqueRow);
  }
  expect(hashByTeamActive.maintained).toBe(true);
  expect(uniqueByTeamId.maintained).toBe(true);
}

function expectExpressionIndexes(db: Db, query: Query<ExpressionIndexedUser>, expected: {
  readonly eng: readonly string[];
  readonly design: readonly string[];
  readonly twenties: readonly string[];
  readonly thirties: readonly string[];
  readonly diaSlug?: string;
}): void {
  const byNormalizedTeam = index<ExpressionIndexedUser, string>(db, query, {
    kind: 'hash',
    field: 'normalizedTeam'
  });
  const byAgeDecade = index<ExpressionIndexedUser, number>(db, query, {
    kind: 'btree',
    field: 'ageDecade'
  });
  const bySlug = index<ExpressionIndexedUser, string>(db, query, {
    kind: 'unique',
    field: 'slug'
  });

  expect(ids(byNormalizedTeam.index?.get('ENG'))).toEqual(expected.eng);
  expect(ids(byNormalizedTeam.index?.get('DESIGN'))).toEqual(expected.design);
  expect(ids(byAgeDecade.index?.get(20))).toEqual(expected.twenties);
  expect(ids(byAgeDecade.index?.get(30))).toEqual(expected.thirties);
  expect(byAgeDecade.index?.ordered).toEqual([20, 30, 40]);
  expect(bySlug.index?.get('eng:ada')).toMatchObject({ id: 'ada', normalizedTeam: 'ENG', slug: 'eng:ada' });
  if (expected.diaSlug !== undefined) {
    expect(bySlug.index?.get(expected.diaSlug)).toMatchObject({ id: 'dia', slug: expected.diaSlug });
  }
  expect(byNormalizedTeam.maintained).toBe(true);
  expect(byAgeDecade.maintained).toBe(true);
  expect(bySlug.maintained).toBe(true);
}

function poisonLookupScan(rows: readonly unknown[]): void {
  for (const row of rows) {
    if (!isMutableRecord(row)) {
      continue;
    }

    for (const fieldName of ['id', 'teamId']) {
      Object.defineProperty(row, fieldName, {
        configurable: true,
        get() {
          throw new Error('base relation scan should not be used for routed lookup');
        }
      });
    }
  }
}

function isMutableRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

describe('maintained materialized indexes', () => {
  it('keeps declared compound hash and unique indexes maintained after insert, update, and delete', () => {
    const user = as(coreSchema.users, 'user');
    const usersByCompoundKeys = compoundIndexedUsersQuery();
    const state = mat(createDb(testData()), usersByCompoundKeys, {
      id: 'users-by-compound-keys',
      mode: 'incremental'
    });

    expect(materializationForQuery(state, usersByCompoundKeys)).toMatchObject({
      id: 'users-by-compound-keys',
      maintenance: 'incremental'
    });
    expectCompoundIndexes(state, usersByCompoundKeys, {
      engActive: ['ada'],
      designInactive: [],
      uniqueRow: adaUser
    });

    const inserted = expectIncrementalMaintenance(
      tryTransact(state, insert(coreSchema.users, diaUser)),
      'users-by-compound-keys'
    );
    expectCompoundIndexes(inserted, usersByCompoundKeys, {
      engActive: ['ada', 'dia'],
      designInactive: [],
      uniqueRow: diaUser
    });

    const movedDia = { ...diaUser, teamId: 'design', active: false, age: 35 };
    const moved = expectIncrementalMaintenance(
      tryTransact(inserted, updateWhere(coreSchema.users, eq(user.id, 'dia'), {
        teamId: 'design',
        active: false,
        age: 35
      })),
      'users-by-compound-keys'
    );
    expectCompoundIndexes(moved, usersByCompoundKeys, {
      engActive: ['ada'],
      designInactive: ['dia'],
      uniqueRow: movedDia
    });

    const deleted = expectIncrementalMaintenance(
      tryTransact(moved, deleteByKey(coreSchema.users, 'dia')),
      'users-by-compound-keys'
    );
    expectCompoundIndexes(deleted, usersByCompoundKeys, {
      engActive: ['ada'],
      designInactive: []
    });
  });

  it('keeps expression-projected hash, btree, and unique indexes maintained after insert, update, and delete', () => {
    const user = as(coreSchema.users, 'user');
    const indexedUsers = expressionIndexedUsersQuery();
    const state = mat(createDb(testData()), indexedUsers, { id: 'expression-indexed-users' });

    expectExpressionIndexes(state, indexedUsers, {
      eng: ['ada'],
      design: ['bea'],
      twenties: ['bea'],
      thirties: ['ada']
    });

    const inserted = transact(state, insert(coreSchema.users, diaUser));
    expectExpressionIndexes(inserted, indexedUsers, {
      eng: ['ada', 'dia'],
      design: ['bea'],
      twenties: ['bea', 'dia'],
      thirties: ['ada'],
      diaSlug: 'eng:dia'
    });

    const moved = transact(inserted, updateWhere(coreSchema.users, eq(user.id, 'dia'), {
      teamId: 'design',
      age: 35
    }));
    expectExpressionIndexes(moved, indexedUsers, {
      eng: ['ada'],
      design: ['bea', 'dia'],
      twenties: ['bea'],
      thirties: ['ada', 'dia'],
      diaSlug: 'design:dia'
    });

    const deleted = transact(moved, deleteByKey(coreSchema.users, 'dia'));
    expectExpressionIndexes(deleted, indexedUsers, {
      eng: ['ada'],
      design: ['bea'],
      twenties: ['bea'],
      thirties: ['ada']
    });
  });

  it('routes qRows lookup through maintained hash and unique indexes without scanning the base relation', async () => {
    const indexedUsers = lookupRoutedUsersQuery();
    const user = as(coreSchema.users, 'user');
    const state = mat(createDb(testData()), indexedUsers, {
      id: 'lookup-routed-users',
      mode: 'incremental'
    });
    const next = transact(state, insert(coreSchema.users, diaUser));

    poisonLookupScan(next.data.users ?? []);

    const engineeringUsers = pipe(
      lookup(user, 'teamId', 'eng'),
      project({ id: user.id, name: user.name, teamId: user.teamId }),
      keyBy('id')
    );
    const diaById = pipe(
      lookup(user, 'id', 'dia'),
      project({ id: user.id, name: user.name, teamId: user.teamId }),
      keyBy('id')
    );

    await expect(qRows(next, engineeringUsers)).resolves.toEqual([
      { id: 'ada', name: 'Ada', teamId: 'eng' },
      { id: 'dia', name: 'Dia', teamId: 'eng' }
    ]);
    await expect(qRows(next, diaById)).resolves.toEqual([
      { id: 'dia', name: 'Dia', teamId: 'eng' }
    ]);
  });

  it('builds direct expression-backed hash, btree, and unique index facades', () => {
    const user = as(coreSchema.users, 'user');
    const normalizedTeam = call(normalizeTeam, user.teamId);
    const decade = call(ageDecade, user.age);
    const slug = call(userSlug, user.teamId, user.id);
    const directExpressionIndexes = pipe(
      from(user),
      hash(normalizedTeam),
      btree(decade),
      uniqueIndex(slug),
      project({
        id: user.id,
        teamId: user.teamId,
        name: user.name,
        active: user.active,
        age: user.age,
        tags: user.tags
      }),
      keyBy('id')
    ) as Query<UserRow>;
    const state = mat(createDb(testData()), directExpressionIndexes, {
      id: 'direct-expression-indexes'
    });

    expect(materializationForQuery(state, directExpressionIndexes)?.indexSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'hash', expression: normalizedTeam }),
      expect.objectContaining({ kind: 'btree', expression: decade }),
      expect.objectContaining({ kind: 'unique', expression: slug })
    ]));

    const byNormalizedTeam = index<UserRow, string>(
      state,
      directExpressionIndexes,
      { kind: 'hash', expression: normalizedTeam }
    );
    const byDecade = index<UserRow, number>(
      state,
      directExpressionIndexes,
      { kind: 'btree', expression: decade }
    );
    const bySlug = index<UserRow, string>(
      state,
      directExpressionIndexes,
      { kind: 'unique', expression: slug }
    );

    expect(byNormalizedTeam).toMatchObject({
      indexed: true,
      maintained: true,
      diagnostics: []
    });
    expect(ids(byNormalizedTeam.index?.get('ENG'))).toEqual(['ada']);
    expect(ids(byNormalizedTeam.index?.get('DESIGN'))).toEqual(['bea']);
    expect(ids(byDecade.index?.get(20))).toEqual(['bea']);
    expect(ids(byDecade.range({ lower: 30 }))).toEqual(['ada', 'cal']);
    expect(byDecade.ordered).toEqual([20, 30, 40]);
    expect(bySlug.index?.get('eng:ada')).toMatchObject({ id: 'ada', teamId: 'eng' });
  });

  it('infers an unambiguous direct expression-backed index from index(db, query)', () => {
    const user = as(coreSchema.users, 'user');
    const normalizedTeam = call(normalizeTeam, user.teamId);
    const usersByNormalizedTeam = pipe(
      from(user),
      hash(normalizedTeam),
      project({
        id: user.id,
        teamId: user.teamId,
        name: user.name,
        active: user.active,
        age: user.age,
        tags: user.tags
      }),
      keyBy('id')
    ) as Query<UserRow>;
    const state = mat(createDb(testData()), usersByNormalizedTeam, {
      id: 'users-by-normalized-team'
    });
    const inferred = index(state, usersByNormalizedTeam);

    expect(inferred.kind).toBe('materializationHashIndex');
    if (inferred.kind !== 'materializationHashIndex') {
      throw new Error('expected hash index');
    }
    expect(inferred.maintained).toBe(true);
    expect(ids(inferred.index?.get('ENG'))).toEqual(['ada']);
    expect(ids(inferred.index?.get('MISSING'))).toEqual(['cal']);
  });

  it('preserves unsupported diagnostics for unmatched direct expression index facade reads', () => {
    const user = as(coreSchema.users, 'user');
    const declared = call(normalizeTeam, user.teamId);
    const unmatched = call(ageDecade, user.age);
    const usersByNormalizedTeam = pipe(
      from(user),
      hash(declared),
      project({
        id: user.id,
        teamId: user.teamId,
        name: user.name,
        active: user.active,
        age: user.age,
        tags: user.tags
      }),
      keyBy('id')
    ) as Query<UserRow>;
    const state = mat(createDb(testData()), usersByNormalizedTeam, {
      id: 'users-by-normalized-team'
    });

    expect(index<UserRow, number>(state, usersByNormalizedTeam, {
      kind: 'hash',
      expression: unmatched
    })).toMatchObject({
      indexed: false,
      maintained: false,
      diagnostics: [
        expect.objectContaining({
          code: 'materialization_index_unsupported',
          detail: expect.objectContaining({
            kind: 'hash',
            expression: unmatched
          })
        })
      ]
    });
  });

});
