import { describe, expect, it } from 'vitest';
import {
  as,
  constRows,
  createDb,
  desc,
  difference,
  eq,
  expand,
  field,
  from,
  keyBy,
  maintainMaterializations,
  mat,
  materializationForQuery,
  materializedRowsForQuery,
  pipe,
  project,
  qRows,
  qualify,
  qualifyRow,
  sortLimit,
  union,
  intersection,
  where
} from '@tarstate/core';
import type { MaterializationMaintenanceResult, Query, RelationDelta } from '@tarstate/core';
import {
  adaUser,
  beaUser,
  calUser,
  coreSchema,
  sourceData,
  type UserRow
} from './fixtures';

type ActiveUserRow = {
  readonly id: string;
  readonly name: string;
  readonly age: number;
  readonly teamId: string;
};

type QualifiedActiveUserRow = {
  readonly user: ActiveUserRow;
};

type QualifiedRowActiveUserRow = {
  readonly item: ActiveUserRow;
};

type LiteralRow = {
  readonly id: string;
  readonly label: string;
};

type UserTagRow = {
  readonly id: string;
  readonly tag: string;
};

type UserNameRow = {
  readonly id: string;
  readonly name: string;
};

const diaUser: UserRow = {
  id: 'dia',
  teamId: 'eng',
  name: 'Dia',
  active: true,
  age: 24,
  tags: ['compiler', 'docs']
};

const pinnedRows: readonly LiteralRow[] = [
  { id: 'pin-a', label: 'Pinned A' },
  { id: 'pin-b', label: 'Pinned B' }
];

function activeUserRows(): Query<ActiveUserRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId })
  ) as Query<ActiveUserRow>;
}

function qualifiedActiveUsersQuery(): Query<QualifiedActiveUserRow> {
  return pipe(
    activeUserRows(),
    qualify('user')
  ) as Query<QualifiedActiveUserRow>;
}

function qualifiedRowActiveUsersQuery(): Query<QualifiedRowActiveUserRow> {
  return pipe(
    activeUserRows(),
    qualifyRow('item')
  ) as Query<QualifiedRowActiveUserRow>;
}

function literalRowsQuery(): Query<LiteralRow> {
  return pipe(
    constRows(pinnedRows),
    keyBy('id')
  ) as Query<LiteralRow>;
}

function expandedUserTagsQuery(): Query<UserTagRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    expand(user.tags, { as: 'tag' }),
    project({ id: user.id, tag: field<string>('tag', 'tag') }),
    keyBy('id', 'tag')
  ) as Query<UserTagRow>;
}

function userNamesQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    where(eq(user.active, true)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function sortedUserNamesQuery(): Query<UserNameRow> {
  const user = as(coreSchema.users, 'user');
  return pipe(
    from(user),
    sortLimit(1, desc(user.age)),
    project({ id: user.id, name: user.name }),
    keyBy('id')
  ) as Query<UserNameRow>;
}

function usersDelta(added: readonly UserRow[], removed: readonly UserRow[]): RelationDelta<typeof coreSchema.users> {
  return { relation: coreSchema.users, added, removed };
}

function singleMaterializationChange(result: MaterializationMaintenanceResult, id: string) {
  const change = result.changes.find((item) => item.id === id);
  expect(change).toBeDefined();
  return change!;
}

function expectNoIncrementalFallback(diagnostics: readonly { readonly code: string }[]): void {
  expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('materialization_incremental_fallback');
}

function expectIncrementalFallback(diagnostics: readonly { readonly code: string }[]): void {
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'materialization_incremental_fallback' })
  ]));
}

function expectIncrementalMaintenance(
  result: MaterializationMaintenanceResult | undefined,
  id: string
) {
  if (result === undefined) {
    throw new Error(`missing materialization maintenance result for ${id}`);
  }

  const change = singleMaterializationChange(result, id);
  expect(change).toMatchObject({
    update: 'incremental',
    maintenance: 'incremental',
    recomputed: false
  });
  expectNoIncrementalFallback([...result.diagnostics, ...change.diagnostics]);
  return change;
}

describe('incremental materialization for pure structural operators', () => {
  it('incrementally maintains qualify over supported root query inserts, updates, and deletes', () => {
    const qualifiedUsers = qualifiedActiveUsersQuery();
    const state = mat(createDb(sourceData), qualifiedUsers, {
      id: 'qualified-active-users',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, qualifiedUsers);

    expect(metadata).toMatchObject({
      id: 'qualified-active-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, qualifiedUsers)).toEqual([
      { user: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' } },
      { user: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } }
    ]);

    const insertedState = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    }) as typeof state;
    const inserted = maintainMaterializations(state, insertedState, {
      deltas: [usersDelta([diaUser], [])]
    });
    const insertedChange = expectIncrementalMaintenance(inserted, 'qualified-active-users');

    expect(insertedChange.rows).toEqual([
      { user: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' } },
      { user: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } },
      { user: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' } }
    ]);
    expect(materializedRowsForQuery(insertedState, qualifiedUsers)).toEqual(insertedChange.rows);

    const updatedAda = { ...adaUser, name: 'Ada Lovelace', age: 38 };
    const updatedState = createDb({
      ...sourceData,
      users: [updatedAda, beaUser, calUser, diaUser]
    }) as typeof state;
    const updated = maintainMaterializations(insertedState, updatedState, {
      deltas: [usersDelta([updatedAda], [adaUser])]
    });
    const updatedChange = expectIncrementalMaintenance(updated, 'qualified-active-users');

    expect(updatedChange.rows).toEqual([
      { user: { id: 'ada', name: 'Ada Lovelace', age: 38, teamId: 'eng' } },
      { user: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } },
      { user: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' } }
    ]);
    expect(materializedRowsForQuery(updatedState, qualifiedUsers)).toEqual(updatedChange.rows);

    const deletedState = createDb({
      ...sourceData,
      users: [updatedAda, calUser, diaUser]
    }) as typeof state;
    const deleted = maintainMaterializations(updatedState, deletedState, {
      deltas: [usersDelta([], [beaUser])]
    });
    const deletedChange = expectIncrementalMaintenance(deleted, 'qualified-active-users');

    expect(deletedChange.rows).toEqual([
      { user: { id: 'ada', name: 'Ada Lovelace', age: 38, teamId: 'eng' } },
      { user: { id: 'dia', name: 'Dia', age: 24, teamId: 'eng' } }
    ]);
    expect(materializedRowsForQuery(deletedState, qualifiedUsers)).toEqual(deletedChange.rows);
  });

  it('builds qualifyRow materializations incrementally without fallback', () => {
    const qualifiedRows = qualifiedRowActiveUsersQuery();
    const state = mat(createDb(sourceData), qualifiedRows, {
      id: 'qualified-row-active-users',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, qualifiedRows);

    expect(metadata).toMatchObject({
      id: 'qualified-row-active-users',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, qualifiedRows)).toEqual([
      { item: { id: 'ada', name: 'Ada', age: 37, teamId: 'eng' } },
      { item: { id: 'bea', name: 'Bea', age: 29, teamId: 'design' } }
    ]);
  });

  it('builds constRows materializations incrementally and skips unrelated deltas unchanged', () => {
    const literalRows = literalRowsQuery();
    const state = mat(createDb(sourceData), literalRows, {
      id: 'literal-rows',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, literalRows);

    expect(metadata).toMatchObject({
      id: 'literal-rows',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: []
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, literalRows)).toEqual(pinnedRows);

    const next = createDb({
      ...sourceData,
      users: [...sourceData.users, diaUser]
    }) as typeof state;
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([diaUser], [])]
    });
    const change = singleMaterializationChange(maintained, 'literal-rows');

    expect(maintained).toMatchObject({ maintained: 1, recomputed: 0, skipped: 1 });
    expect(change).toMatchObject({
      update: 'skipped',
      maintenance: 'incremental',
      recomputed: false,
      dependencies: [],
      touchedDependencies: [],
      rows: pinnedRows,
      addedRows: [],
      removedRows: [],
      rowChanges: []
    });
    expectNoIncrementalFallback([...maintained.diagnostics, ...change.diagnostics]);
    expect(materializedRowsForQuery(next, literalRows)).toEqual(pinnedRows);
  });

  it('incrementally maintains expand output rows affected by root inserts, updates, and deletes', () => {
    const userTags = expandedUserTagsQuery();
    const state = mat(createDb(sourceData), userTags, {
      id: 'expanded-user-tags',
      mode: 'incremental'
    });
    const metadata = materializationForQuery(state, userTags);

    expect(metadata).toMatchObject({
      id: 'expanded-user-tags',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['users']
    });
    expectNoIncrementalFallback(metadata?.diagnostics ?? []);
    expect(materializedRowsForQuery(state, userTags)).toEqual([
      { id: 'ada', tag: 'compiler' },
      { id: 'ada', tag: 'runtime' },
      { id: 'bea', tag: 'research' }
    ]);

    const updatedAda = { ...adaUser, tags: ['compiler', 'logic'] };
    const next = createDb({
      ...sourceData,
      users: [updatedAda, calUser, diaUser]
    }) as typeof state;
    const maintained = maintainMaterializations(state, next, {
      deltas: [usersDelta([updatedAda, diaUser], [adaUser, beaUser])]
    });
    const change = expectIncrementalMaintenance(maintained, 'expanded-user-tags');

    expect(change.rows).toEqual([
      { id: 'ada', tag: 'compiler' },
      { id: 'ada', tag: 'logic' },
      { id: 'dia', tag: 'compiler' },
      { id: 'dia', tag: 'docs' }
    ]);
    expect(change.addedRows).toEqual([
      { id: 'ada', tag: 'logic' },
      { id: 'dia', tag: 'compiler' },
      { id: 'dia', tag: 'docs' }
    ]);
    expect(change.removedRows).toEqual([
      { id: 'ada', tag: 'runtime' },
      { id: 'bea', tag: 'research' }
    ]);
    expect(change.rowChanges).toHaveLength(5);
    expect(change.rowChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', row: { id: 'ada', tag: 'runtime' } }),
      expect.objectContaining({ kind: 'removed', row: { id: 'bea', tag: 'research' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'ada', tag: 'logic' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'dia', tag: 'compiler' } }),
      expect.objectContaining({ kind: 'added', row: { id: 'dia', tag: 'docs' } })
    ]));
    expect(materializedRowsForQuery(next, userTags)).toEqual(change.rows);
  });

  it.each([
    {
      name: 'union',
      id: 'set-union-unsupported-branch',
      query: () => union(userNamesQuery(), sortedUserNamesQuery()),
      expected: [
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' },
        { id: 'cal', name: 'Cal' }
      ]
    },
    {
      name: 'intersection',
      id: 'set-intersection-unsupported-branch',
      query: () => intersection(userNamesQuery(), sortedUserNamesQuery()),
      expected: []
    },
    {
      name: 'difference',
      id: 'set-difference-unsupported-branch',
      query: () => difference(userNamesQuery(), sortedUserNamesQuery()),
      expected: [
        { id: 'ada', name: 'Ada' },
        { id: 'bea', name: 'Bea' }
      ]
    }
  ])('keeps fallback diagnostics for $name with an unsupported branch shape', async ({ id, query, expected }) => {
    const setQuery = query();
    const state = mat(createDb(sourceData), setQuery, { id, mode: 'incremental' });
    const metadata = materializationForQuery(state, setQuery);

    expect(metadata).toMatchObject({
      id,
      requestedMode: 'incremental',
      maintenance: 'snapshot'
    });
    expectIncrementalFallback(metadata?.diagnostics ?? []);
    expect(metadata?.maintenanceReason).toMatch(/not supported|sortLimit/);
    await expect(qRows(state, setQuery)).resolves.toEqual(expected);
  });
});
