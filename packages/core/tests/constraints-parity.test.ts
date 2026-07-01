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
