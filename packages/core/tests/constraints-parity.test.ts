import { describe, expect, it } from 'vitest';
import {
  as,
  check,
  constrain,
  createDb,
  deleteByKey,
  eq,
  field,
  fk,
  from,
  gt,
  insert,
  insertOrMerge,
  insertOrReplace,
  mat,
  pipe,
  project,
  qRows,
  req,
  transact,
  tryTransact,
  tryTransactConstrained,
  unique,
  value,
  where
} from '@tarstate/core';
import {
  booleanField,
  defineSchema,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';

type TeamRow = {
  readonly id: string;
  readonly name: string;
};

type MemberRow = {
  readonly id: string;
  readonly teamId: string;
  readonly email: string;
  readonly active: boolean;
  readonly age: number;
};

const schema = defineSchema({
  teams: relation<TeamRow>({
    key: 'id',
    fields: {
      id: stringField(),
      name: stringField()
    }
  }),
  members: relation<MemberRow>({
    key: 'id',
    fields: {
      id: stringField(),
      teamId: stringField(),
      email: stringField(),
      active: booleanField(),
      age: numberField()
    }
  })
});

const teamA: TeamRow = { id: 'a', name: 'Alpha' };
const teamB: TeamRow = { id: 'b', name: 'Beta' };
const ann: MemberRow = { id: 'ann', teamId: 'a', email: 'ann@example.test', active: true, age: 31 };
const bob: MemberRow = { id: 'bob', teamId: 'a', email: 'bob@example.test', active: true, age: 24 };
const cy: MemberRow = { id: 'cy', teamId: 'b', email: 'cy@example.test', active: false, age: 17 };

const member = as(schema.members, 'member');
const activeMembers = pipe(
  from(member),
  where(eq(member.active, true)),
  project({
    id: member.id,
    teamId: member.teamId,
    email: member.email,
    age: member.age
  })
);

function baseDb() {
  return createDb({
    teams: [teamA, teamB],
    members: [ann, bob, cy]
  });
}

describe('Relic-style constraints', () => {
  it('enforces attached query-bound constraints through normal and constrained transactions', async () => {
    const constrained = mat(baseDb(), constrain(
      unique(activeMembers, 'email'),
      fk(activeMembers, 'teamId', schema.teams, 'id'),
      check(activeMembers, gt(field('member', 'age'), value(17)))
    ));

    expect(() => transact(constrained, insert(schema.members, {
      id: 'duplicate',
      teamId: 'a',
      email: 'ann@example.test',
      active: true,
      age: 28
    }))).toThrow();

    expect(() => transact(constrained, insert(schema.members, {
      id: 'too-young',
      teamId: 'a',
      email: 'young@example.test',
      active: true,
      age: 16
    }))).toThrow();

    await expect(tryTransactConstrained(
      baseDb(),
      [insert(schema.members, {
        id: 'orphan',
        teamId: 'missing',
        email: 'orphan@example.test',
        active: true,
        age: 22
      })],
      constrain(fk(activeMembers, 'teamId', schema.teams, 'id'))
    )).resolves.toMatchObject({
      committed: false,
      diagnostics: [expect.objectContaining({
        code: 'constraint_fk',
        field: 'teamId'
      })]
    });
  });

  it('rolls back multi-op transactions when a later query constraint rejects the result', async () => {
    const constrained = mat(baseDb(), constrain(unique(activeMembers, 'email')));
    const insertedFirst: MemberRow = {
      id: 'dee',
      teamId: 'a',
      email: 'dee@example.test',
      active: true,
      age: 27
    };
    const duplicateLater: MemberRow = {
      id: 'duplicate-ann',
      teamId: 'a',
      email: 'ann@example.test',
      active: true,
      age: 28
    };

    const result = tryTransact(
      constrained,
      [insert(schema.members, insertedFirst), insert(schema.members, duplicateLater)]
    );

    expect(result).toMatchObject({
      committed: false,
      db: constrained,
      patches: 2,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({
        code: 'constraint_unique',
        relation: expect.stringContaining('query:'),
        field: 'email',
        detail: expect.objectContaining({
          error: 'unique-key-violation',
          relvar: expect.stringContaining('query:'),
          oldRow: expect.objectContaining({ id: 'ann', email: 'ann@example.test' }),
          newRow: expect.objectContaining({ id: 'duplicate-ann', email: 'ann@example.test' }),
          rows: [
            expect.objectContaining({ id: 'ann', email: 'ann@example.test' }),
            expect.objectContaining({ id: 'duplicate-ann', email: 'ann@example.test' })
          ],
          clause: { op: 'unique', fields: ['email'] }
        })
      })]
    });
    await expect(qRows(result.db, schema.members)).resolves.toEqual([ann, bob, cy]);

    try {
      transact(constrained, [insert(schema.members, insertedFirst), insert(schema.members, duplicateLater)]);
      throw new Error('expected transact to throw');
    } catch (error) {
      expect(error).toMatchObject({
        result: expect.objectContaining({
          committed: false,
          db: constrained,
          applied: 0,
          deltas: []
        })
      });
    }
    await expect(qRows(constrained, schema.members)).resolves.toEqual([ann, bob, cy]);

    const explicitBase = baseDb();
    const explicit = await tryTransactConstrained(
      explicitBase,
      [insert(schema.members, insertedFirst), insert(schema.members, duplicateLater)],
      constrain(unique(activeMembers, 'email'))
    );
    expect(explicit).toMatchObject({
      committed: false,
      db: explicitBase,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({ code: 'constraint_unique' })]
    });
    await expect(qRows(explicitBase, schema.members)).resolves.toEqual([ann, bob, cy]);
  });

  it('scopes filtered query unique, foreign key, and check constraints to matching rows', async () => {
    const constrained = mat(baseDb(), constrain(
      unique(activeMembers, 'email'),
      fk(activeMembers, 'teamId', schema.teams, 'id'),
      check(activeMembers, gt(field('member', 'age'), value(17)))
    ));
    const inactiveDuplicateOrphanAndUnderage: MemberRow = {
      id: 'inactive-duplicate',
      teamId: 'missing',
      email: 'ann@example.test',
      active: false,
      age: 16
    };

    const allowed = transact(constrained, insert(schema.members, inactiveDuplicateOrphanAndUnderage));
    await expect(qRows(allowed, schema.members)).resolves.toEqual([
      ann,
      bob,
      cy,
      inactiveDuplicateOrphanAndUnderage
    ]);

    expect(tryTransact(allowed, insert(schema.members, {
      id: 'active-duplicate',
      teamId: 'a',
      email: 'ann@example.test',
      active: true,
      age: 29
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_unique',
        field: 'email',
        detail: expect.objectContaining({
          error: 'unique-key-violation',
          oldRow: expect.objectContaining({ id: 'ann' }),
          newRow: expect.objectContaining({ id: 'active-duplicate' })
        })
      })]
    });

    expect(tryTransact(allowed, insert(schema.members, {
      id: 'active-orphan',
      teamId: 'missing',
      email: 'orphan@example.test',
      active: true,
      age: 29
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_fk',
        field: 'teamId',
        detail: expect.objectContaining({
          error: 'foreign-key-violation',
          row: expect.objectContaining({ id: 'active-orphan', teamId: 'missing' }),
          clause: { op: 'fk', fields: ['teamId'], targetFields: ['id'], optional: false }
        })
      })]
    });

    expect(tryTransact(allowed, insert(schema.members, {
      id: 'active-underage',
      teamId: 'a',
      email: 'young@example.test',
      active: true,
      age: 16
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_check',
        detail: expect.objectContaining({
          error: 'check-violation',
          row: expect.objectContaining({ id: 'active-underage' }),
          clause: expect.objectContaining({ op: 'gt' })
        })
      })]
    });
  });

  it('scopes filtered query required constraints to rows selected by the query', () => {
    const probe = pipe(
      from(member),
      where(eq(member.id, value('probe'))),
      project({ id: member.id, email: value(undefined) })
    );
    const constrained = mat(baseDb(), constrain(req(probe, 'email')));

    expect(tryTransact(constrained, insert(schema.members, {
      id: 'outside-probe',
      teamId: 'a',
      email: 'outside@example.test',
      active: true,
      age: 29
    }))).toMatchObject({
      committed: true,
      applied: 1,
      diagnostics: []
    });

    expect(tryTransact(constrained, insert(schema.members, {
      id: 'probe',
      teamId: 'a',
      email: 'probe@example.test',
      active: true,
      age: 29
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_req',
        relation: expect.stringContaining('query:'),
        field: 'email',
        key: 'probe',
        detail: expect.objectContaining({
          error: 'required-field-violation',
          row: { id: 'probe', email: undefined },
          clause: { op: 'req', field: 'email' }
        })
      })]
    });
  });

  it('reports query-bound required diagnostics with query identity and row key', () => {
    const idsOnly = pipe(
      from(member),
      project({ id: member.id, email: value(undefined) })
    );
    const constrained = mat(baseDb(), constrain(req(idsOnly, 'email')));
    const result = tryTransact(constrained, insert(schema.teams, { id: 'c', name: 'Gamma' }));

    expect(result).toMatchObject({
      committed: false
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
        code: 'constraint_req',
        relation: expect.stringContaining('query:'),
        field: 'email',
        key: 'ann'
      })]));
  });

  it('cascades direct relation foreign-key deletes and rejects unsupported cascade modes', async () => {
    const constrained = mat(baseDb(), constrain(
      fk(schema.members, 'teamId', schema.teams, 'id', { cascade: 'delete' })
    ));
    const next = transact(constrained, deleteByKey(schema.teams, 'a'));

    await expect(qRows(next, schema.members)).resolves.toEqual([cy]);

    const unsupported = mat(baseDb(), constrain(
      fk(schema.members, 'teamId', schema.teams, 'id', { cascade: 'setNull' })
    ));
    expect(tryTransact(unsupported, deleteByKey(schema.teams, 'a'))).toMatchObject({
      committed: false,
      diagnostics: [expect.objectContaining({
        code: 'constraint_fk_cascade_unsupported',
        relation: 'members',
        field: 'teamId'
      })]
    });
  });

  it('uses direct unique constraints as insert-or-replace and insert-or-merge conflict targets', async () => {
    const constrained = mat(createDb({
      teams: [teamA],
      members: [ann]
    }), constrain(unique(schema.members, 'email')));

    const replaced = transact(constrained, insertOrReplace(schema.members, {
      id: 'ann-replacement',
      teamId: 'a',
      email: 'ann@example.test',
      active: false,
      age: 32
    }));
    await expect(qRows(replaced, schema.members)).resolves.toEqual([{
      id: 'ann-replacement',
      teamId: 'a',
      email: 'ann@example.test',
      active: false,
      age: 32
    }]);

    const merged = transact(constrained, insertOrMerge(schema.members, {
      id: 'ann-merged',
      email: 'ann@example.test',
      active: false
    }, { merge: 'provided' }));
    await expect(qRows(merged, schema.members)).resolves.toEqual([{
      id: 'ann-merged',
      teamId: 'a',
      email: 'ann@example.test',
      active: false,
      age: 31
    }]);
  });
});
