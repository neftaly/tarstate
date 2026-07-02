import { describe, expect, it } from 'vitest';
import {
  aggregate,
  and,
  as,
  call,
  check,
  constrain,
  count,
  createDb,
  deleteByKey,
  eq,
  field,
  fk,
  from,
  gt,
  hostCall,
  insert,
  insertOrMerge,
  insertOrReplace,
  join,
  lte,
  mat,
  pipe,
  project,
  qRows,
  req,
  sum,
  transact,
  tryTransact,
  tryTransactConstrained,
  tuple,
  unique,
  value,
  where
} from '@tarstate/core';
import {
  booleanField,
  defineSchema,
  numberField,
  optional,
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
  readonly nickname?: string;
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
      nickname: optional(stringField()),
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
const team = as(schema.teams, 'team');
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
const activeMemberTeams = pipe(
  from(member),
  where(eq(member.active, true)),
  join(from(team), eq(member.teamId, team.id)),
  project({
    id: member.id,
    teamId: member.teamId,
    email: member.email,
    teamName: team.name
  })
);
const activeMemberTotals = pipe(
  from(member),
  where(eq(member.active, true)),
  aggregate({
    groupBy: { teamId: member.teamId },
    aggregates: {
      activeCount: count(),
      totalAge: sum(member.age)
    }
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

  it('rejects invalid relationship rows through an attached inner-join check and rolls back', async () => {
    const constrained = mat(baseDb(), constrain(
      check(activeMemberTeams, eq(field('relationship', 'teamName'), value('Alpha')))
    ));
    const insertedFirst: MemberRow = {
      id: 'dee',
      teamId: 'a',
      email: 'dee@example.test',
      active: true,
      age: 28
    };
    const invalidRelationship: MemberRow = {
      id: 'eli',
      teamId: 'b',
      email: 'eli@example.test',
      active: true,
      age: 26
    };

    const result = tryTransact(constrained, [
      insert(schema.members, insertedFirst),
      insert(schema.members, invalidRelationship)
    ]);

    expect(result).toMatchObject({
      committed: false,
      db: constrained,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({
        code: 'constraint_check',
        relation: expect.stringContaining('query:'),
        detail: expect.objectContaining({
          error: 'check-violation',
          row: expect.objectContaining({
            id: 'eli',
            teamId: 'b',
            teamName: 'Beta'
          }),
          clause: expect.objectContaining({ op: 'eq' })
        })
      })]
    });
    await expect(qRows(result.db, schema.members)).resolves.toEqual([ann, bob, cy]);
  });

  it('rejects invalid grouped totals through an attached aggregate check and rolls back', async () => {
    const constrained = mat(baseDb(), constrain(
      check(activeMemberTotals, and(
        lte(field('summary', 'activeCount'), value(2)),
        lte(field('summary', 'totalAge'), value(80))
      ))
    ));
    const insertedFirst: MemberRow = {
      id: 'dee',
      teamId: 'b',
      email: 'dee@example.test',
      active: true,
      age: 30
    };
    const invalidTotal: MemberRow = {
      id: 'eli',
      teamId: 'a',
      email: 'eli@example.test',
      active: true,
      age: 40
    };

    const result = tryTransact(constrained, [
      insert(schema.members, insertedFirst),
      insert(schema.members, invalidTotal)
    ]);

    expect(result).toMatchObject({
      committed: false,
      db: constrained,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({
        code: 'constraint_check',
        relation: expect.stringContaining('query:'),
        detail: expect.objectContaining({
          error: 'check-violation',
          row: expect.objectContaining({
            teamId: 'a',
            activeCount: 3,
            totalAge: 95
          }),
          clause: expect.objectContaining({ op: 'and' })
        })
      })]
    });
    await expect(qRows(result.db, schema.members)).resolves.toEqual([ann, bob, cy]);
  });

  it('keeps direct req, fk, and unique constraints working when mixed with query checks', async () => {
    const namedAnn: MemberRow = { ...ann, nickname: 'ann' };
    const namedBob: MemberRow = { ...bob, nickname: 'bob' };
    const namedCy: MemberRow = { ...cy, nickname: 'cy' };
    const constrained = mat(createDb({
      teams: [teamA, teamB],
      members: [namedAnn, namedBob, namedCy]
    }), constrain(
      req(schema.members, 'nickname'),
      fk(schema.members, 'teamId', schema.teams, 'id'),
      unique(schema.members, 'email'),
      check(activeMembers, gt(field('member', 'age'), value(17)))
    ));
    const valid: MemberRow = {
      id: 'dee',
      teamId: 'b',
      email: 'dee@example.test',
      nickname: 'dee',
      active: true,
      age: 28
    };

    const passed = tryTransact(constrained, insert(schema.members, valid));
    expect(passed).toMatchObject({
      committed: true,
      applied: 1,
      diagnostics: []
    });
    await expect(qRows(passed.db, schema.members)).resolves.toEqual([
      namedAnn,
      namedBob,
      namedCy,
      valid
    ]);

    expect(tryTransact(passed.db, insert(schema.members, {
      id: 'missing-nickname',
      teamId: 'a',
      email: 'missing-nickname@example.test',
      active: false,
      age: 33
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_req',
        relation: 'members',
        field: 'nickname'
      })]
    });

    expect(tryTransact(passed.db, insert(schema.members, {
      id: 'duplicate-email',
      teamId: 'a',
      email: 'ann@example.test',
      nickname: 'duplicate',
      active: false,
      age: 33
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_unique',
        relation: 'members',
        field: 'email'
      })]
    });

    expect(tryTransact(passed.db, insert(schema.members, {
      id: 'orphan',
      teamId: 'missing',
      email: 'orphan@example.test',
      nickname: 'orphan',
      active: false,
      age: 33
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_fk',
        relation: 'members',
        field: 'teamId'
      })]
    });

    expect(tryTransact(passed.db, insert(schema.members, {
      id: 'active-underage',
      teamId: 'a',
      email: 'young@example.test',
      nickname: 'young',
      active: true,
      age: 16
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_check',
        relation: expect.stringContaining('query:')
      })]
    });
  });

  it('attaches bare check constraints to the current query with constrain(query, ...)', () => {
    const explicit = constrain(check(activeMembers, gt(field('member', 'age'), value(17))));
    const sugar = constrain(activeMembers, check(gt(field('member', 'age'), value(17))));

    expect(sugar).toMatchObject({
      kind: 'constraintSet',
      query: activeMembers,
      constraints: explicit.constraints
    });

    const constrained = mat(baseDb(), sugar);
    expect(tryTransact(constrained, insert(schema.members, {
      id: 'too-young',
      teamId: 'a',
      email: 'young@example.test',
      active: true,
      age: 16
    }))).toMatchObject({
      committed: false,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_check',
        relation: expect.stringContaining('query:')
      })]
    });
  });

  it('enforces query expression uniqueness and rejects unsupported direct expression uniques', async () => {
    const compositeIdentity = tuple(member.teamId, member.email);
    const constrained = mat(baseDb(), constrain(unique(activeMembers, compositeIdentity)));
    const inactiveDuplicateComposite: MemberRow = {
      id: 'ann-copy',
      teamId: 'a',
      email: 'ann@example.test',
      active: false,
      age: 42
    };

    const inactiveResult = tryTransact(constrained, insert(schema.members, inactiveDuplicateComposite));
    expect(inactiveResult).toMatchObject({
      committed: true,
      applied: 1,
      diagnostics: []
    });
    await expect(qRows(inactiveResult.db, schema.members)).resolves.toEqual([
      ann,
      bob,
      cy,
      inactiveDuplicateComposite
    ]);

    const activeDuplicateComposite: MemberRow = {
      id: 'ann-active-copy',
      teamId: 'a',
      email: 'ann@example.test',
      active: true,
      age: 42
    };

    const result = tryTransact(inactiveResult.db, insert(schema.members, activeDuplicateComposite));
    expect(result).toMatchObject({
      committed: false,
      db: inactiveResult.db,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_unique',
        relation: expect.stringContaining('query:'),
        field: expect.stringContaining('tuple'),
        detail: expect.objectContaining({
          error: 'unique-key-violation',
          expressions: [expect.objectContaining({ op: 'tuple' })],
          oldRow: expect.objectContaining({ id: 'ann' }),
          newRow: expect.objectContaining({ id: 'ann-active-copy' })
        })
      })]
    });
    await expect(qRows(result.db, schema.members)).resolves.toEqual([
      ann,
      bob,
      cy,
      inactiveDuplicateComposite
    ]);

    expect(() => unique(schema.members, compositeIdentity as never))
      .toThrow(/expression|unsupported|unique|project/i);
  });

  it('keeps named query functions unsupported without a registry', async () => {
    const namedFunctionProjection = pipe(
      from(member),
      project({
        id: member.id,
        normalizedEmail: call<string>('normalizeEmail', member.email)
      })
    );
    const namedFunctionDb = mat(baseDb(), constrain(unique(namedFunctionProjection, 'normalizedEmail')));

    const namedResult = tryTransact(namedFunctionDb, insert(schema.members, {
      id: 'dee',
      teamId: 'a',
      email: 'DEE@example.test',
      active: true,
      age: 28
    }));

    expect(namedResult).toMatchObject({
      committed: false,
      db: namedFunctionDb,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'unsupported_expression',
        message: expect.stringMatching(/function normalizeEmail/i)
      })]
    });
    await expect(qRows(namedResult.db, schema.members)).resolves.toEqual([ann, bob, cy]);
  });

  it('evaluates direct hostCall expressions in query-bound constraints', async () => {
    const normalizeEmail = (email: string) => email.toLowerCase();
    const hostFunctionProjection = pipe(
      from(member),
      project({
        id: member.id,
        normalizedEmail: hostCall(normalizeEmail, member.email)
      })
    );
    const hostFunctionDb = mat(baseDb(), constrain(unique(hostFunctionProjection, 'normalizedEmail')));

    const hostPass = tryTransact(hostFunctionDb, insert(schema.members, {
      id: 'dee',
      teamId: 'a',
      email: 'DEE@example.test',
      active: true,
      age: 28
    }));

    expect(hostPass).toMatchObject({
      committed: true,
      diagnostics: []
    });
    await expect(qRows(hostPass.db, schema.members)).resolves.toEqual([
      ann,
      bob,
      cy,
      {
        id: 'dee',
        teamId: 'a',
        email: 'DEE@example.test',
        active: true,
        age: 28
      }
    ]);

    const hostFail = tryTransact(hostFunctionDb, insert(schema.members, {
      id: 'ann-copy',
      teamId: 'a',
      email: 'ANN@example.test',
      active: true,
      age: 29
    }));

    expect(hostFail).toMatchObject({
      committed: false,
      db: hostFunctionDb,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_unique',
        field: 'normalizedEmail'
      })]
    });
    expect(hostFail.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported_expression' })
    ]));
    await expect(qRows(hostFail.db, schema.members)).resolves.toEqual([ann, bob, cy]);

    const isAdult = (age: number) => age >= 18;
    const hostCheckDb = mat(baseDb(), constrain(
      check(activeMembers, eq(hostCall(isAdult, field<number>('member', 'age')), true))
    ));

    const checkPass = tryTransact(hostCheckDb, insert(schema.members, {
      id: 'elder',
      teamId: 'a',
      email: 'elder@example.test',
      active: true,
      age: 64
    }));
    expect(checkPass).toMatchObject({
      committed: true,
      diagnostics: []
    });

    const checkFail = tryTransact(hostCheckDb, insert(schema.members, {
      id: 'young',
      teamId: 'a',
      email: 'young@example.test',
      active: true,
      age: 16
    }));
    expect(checkFail).toMatchObject({
      committed: false,
      db: hostCheckDb,
      applied: 0,
      diagnostics: [expect.objectContaining({
        code: 'constraint_check',
        relation: expect.stringContaining('query:')
      })]
    });
    expect(checkFail.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported_expression' })
    ]));
    await expect(qRows(checkFail.db, schema.members)).resolves.toEqual([ann, bob, cy]);
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
