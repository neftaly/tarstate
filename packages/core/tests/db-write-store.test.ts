import { describe, expect, it } from 'vitest';
import {
  as,
  createDb,
  createStore,
  dbDeleteWhere,
  dbUpdateWhere,
  eq,
  from,
  insert,
  pipe,
  project,
  qRows,
  replaceAll,
  row,
  transact,
  tryTransact,
  updateWhere,
  where,
  write
} from '@tarstate/core';
import { writeInputPatches } from '@tarstate/core/write';
import { adaUser, coreSchema, emptyCoreData, engineeringTeam, sourceData, teams } from './fixtures';

describe('db, write, and store contracts', () => {
  it('constructs relation-scoped writes and flattens write inputs', () => {
    const usersWriter = write(coreSchema.users);
    const insertPatch = usersWriter.insert(adaUser);
    const updatePatch = usersWriter.updateByKey('ada', { active: false });

    expect(insertPatch).toMatchObject({ op: 'insert', relation: coreSchema.users, row: adaUser });
    expect(updatePatch).toMatchObject({ op: 'updateByKey', key: 'ada', changes: { active: false } });
    expect(Array.from(writeInputPatches([insertPatch, updatePatch]))).toEqual([insertPatch, updatePatch]);
    expect(Array.from(writeInputPatches(insertPatch))).toEqual([insertPatch]);
  });

  it('applies insert/update/delete/replaceAll transactions immutably', async () => {
    const db = createDb(emptyCoreData());
    const result = tryTransact(
      db,
      insert(coreSchema.teams, engineeringTeam),
      insert(coreSchema.users, adaUser),
      updateWhere(coreSchema.users, eq(as(coreSchema.users, 'user').id, 'ada'), { age: 38 }),
      dbDeleteWhere(coreSchema.teams, 'design'),
      replaceAll(coreSchema.teams, teams)
    );
    const user = as(coreSchema.users, 'user');

    expect(result).toMatchObject({ committed: true, patches: 5, applied: 5, diagnostics: [] });
    await expect(row(result.db, pipe(from(user), where(eq(user.id, 'ada'))))).resolves.toMatchObject({ age: 38 });
    expect(result.db.data.users).not.toBe(db.data.users);
  });

  it('throws transaction errors for invalid transact calls with the rejected result attached', () => {
    const db = createDb(sourceData);

    expect(() => transact(db, dbUpdateWhere(coreSchema.users, 'ada', { teamId: 'missing' }))).toThrowError(
      /transaction/i
    );
  });

  it('supports createDb/createStore query, commit, revision, and subscriber flow', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(from(user), project({ id: user.id, name: user.name }));
    const store = createStore(createDb(sourceData));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    await expect(qRows(store.getSnapshot().db, query)).resolves.toHaveLength(3);
    await expect(store.query(query)).resolves.toMatchObject({ rows: expect.arrayContaining([{ id: 'ada', name: 'Ada' }]) });

    const commit = await store.commit(write(coreSchema.users).insert({
      id: 'dia',
      teamId: 'eng',
      name: 'Dia',
      active: true,
      age: 24,
      tags: []
    }));

    expect(commit).toMatchObject({ status: 'accepted', reflected: true, effects: { applied: 1 } });
    expect(store.getSnapshot().revision).toBe(1);
    expect(notifications).toBe(1);

    unsubscribe();
  });
});
