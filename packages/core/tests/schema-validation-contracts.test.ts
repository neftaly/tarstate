import { describe, expect, it } from 'vitest';
import { as, evaluate, from, pipe, project } from '@tarstate/core';
import { constrain, fk, req, unique, validateConstraints } from '@tarstate/core/experimental/constraints';
import {
  defineSchema,
  idField,
  isJsonValue,
  jsonField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { fromObjectSource } from '@tarstate/core/source';

type TeamRow = {
  readonly tenantId: string;
  readonly id: string;
  readonly name: string;
};

type ProfileRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly teamId?: string | null;
  readonly nickname?: string;
  readonly email?: string | null;
  readonly bio: string | null;
  readonly age: number | null;
  readonly settings: unknown;
};

type MembershipRow = {
  readonly tenantId: string;
  readonly userId: string;
  readonly teamId?: string | null;
  readonly role: string;
};

const validationSchema = defineSchema({
  teams: relation<TeamRow>({
    key: ['tenantId', 'id'],
    fields: {
      tenantId: idField('tenant'),
      id: idField('team'),
      name: stringField()
    }
  }),
  profiles: relation<ProfileRow>({
    key: 'id',
    fields: {
      id: idField('profile'),
      tenantId: refField('teams.tenantId'),
      teamId: optional(nullable(refField('teams.id'))),
      nickname: optional(stringField()),
      email: optional(nullable(stringField())),
      bio: nullable(stringField()),
      age: nullable(numberField()),
      settings: jsonField()
    }
  }),
  memberships: relation<MembershipRow>({
    key: ['tenantId', 'userId'],
    fields: {
      tenantId: idField('tenant'),
      userId: refField('profiles.id'),
      teamId: optional(nullable(refField('teams.id'))),
      role: stringField()
    }
  })
});

const teams = [
  { tenantId: 'acme', id: 'eng', name: 'Engineering' },
  { tenantId: 'beta', id: 'ops', name: 'Operations' }
] satisfies readonly TeamRow[];

describe('schema validation contracts', () => {
  it('preserves optional(nullable(...)) and nullable(optional(...)) field metadata', () => {
    expect(optional(nullable(stringField()))).toEqual({
      kind: 'field',
      valueKind: 'string',
      optional: true,
      nullable: true
    });
    expect(nullable(optional(refField('teams.id')))).toEqual({
      kind: 'field',
      valueKind: 'ref',
      ref: 'teams.id',
      optional: true,
      nullable: true
    });
  });

  it('keeps relation keys, composite keys, and ref/id field metadata validation-ready', () => {
    expect(validationSchema.teams).toMatchObject({
      name: 'teams',
      key: ['tenantId', 'id'],
      fields: {
        tenantId: { valueKind: 'id', idDomain: 'tenant', optional: false, nullable: false },
        id: { valueKind: 'id', idDomain: 'team', optional: false, nullable: false }
      }
    });
    expect(validationSchema.profiles.fields.teamId).toMatchObject({
      valueKind: 'ref',
      ref: 'teams.id',
      optional: true,
      nullable: true
    });
    expect(validationSchema.memberships.key).toEqual(['tenantId', 'userId']);
  });

  it('recognizes deeply nested JSON values and rejects non-JSON values', () => {
    const nestedJson = {
      theme: 'dark',
      flags: [true, false, null],
      layout: [{ columns: 2, widgets: ['activity', { id: 'summary' }] }]
    };
    const cycle: { child?: unknown } = {};
    cycle.child = cycle;

    expect(validationSchema.profiles.fields.settings).toMatchObject({ valueKind: 'json' });
    expect(isJsonValue(nestedJson)).toBe(true);
    expect(isJsonValue([nestedJson, { empty: [] }])).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date('2026-07-01T00:00:00.000Z'))).toBe(false);
    expect(isJsonValue(cycle)).toBe(false);
  });

  it('evaluates relation rows with required, optional, nullable, and JSON field semantics', async () => {
    const profile = as(validationSchema.profiles, 'profile');
    const query = pipe(
      from(profile),
      project({ id: profile.id, nickname: profile.nickname, bio: profile.bio, age: profile.age })
    );
    const source = fromObjectSource({
      profiles: [
        {
          id: 'valid-null',
          tenantId: 'acme',
          bio: null,
          age: null,
          settings: { nested: ['ok'] }
        },
        {
          id: 'bad-required',
          tenantId: 'acme',
          age: 42,
          settings: {}
        },
        {
          id: 'bad-nullable-type',
          tenantId: 'acme',
          bio: 123,
          age: 'old',
          settings: {}
        },
        {
          id: 'bad-json',
          tenantId: 'acme',
          bio: 'has settings',
          age: 42,
          settings: { value: Number.POSITIVE_INFINITY }
        }
      ]
    });

    await expect(evaluate(source, query)).resolves.toEqual({
      rows: [{ id: 'valid-null', nickname: undefined, bio: null, age: null }],
      diagnostics: [
        expect.objectContaining({ code: 'invalid_row', relation: 'profiles', field: 'bio', key: 'bad-required' }),
        expect.objectContaining({ code: 'invalid_row', relation: 'profiles', field: 'bio', key: 'bad-nullable-type' }),
        expect.objectContaining({ code: 'invalid_row', relation: 'profiles', field: 'age', key: 'bad-nullable-type' }),
        expect.objectContaining({ code: 'invalid_row', relation: 'profiles', field: 'settings', key: 'bad-json' })
      ]
    });
  });

  it('diagnoses required constraints on optional fields without rejecting nullable nulls', async () => {
    const source = fromObjectSource({
      profiles: [
        { id: 'valid', tenantId: 'acme', nickname: 'Ada', bio: null, age: 36, settings: {} },
        { id: 'missing-nickname', tenantId: 'acme', bio: 'present', age: 24, settings: {} },
        { id: 'undefined-nickname', tenantId: 'acme', nickname: undefined, bio: null, age: 31, settings: {} }
      ]
    });

    await expect(validateConstraints(source, constrain(
      req(validationSchema.profiles, 'nickname'),
      req(validationSchema.profiles, 'bio')
    ))).resolves.toEqual({
      kind: 'constraintValidation',
      valid: false,
      diagnostics: [
        expect.objectContaining({
          code: 'constraint_req',
          relation: 'profiles',
          field: 'nickname',
          key: 'missing-nickname'
        }),
        expect.objectContaining({
          code: 'constraint_req',
          relation: 'profiles',
          field: 'nickname',
          key: 'undefined-nickname'
        })
      ]
    });
  });

  it('treats optional nullable foreign keys as absent but diagnoses concrete missing refs', async () => {
    const source = fromObjectSource({
      teams,
      profiles: [
        { id: 'null-team', tenantId: 'acme', teamId: null, bio: null, age: 36, settings: {} },
        { id: 'missing-team', tenantId: 'acme', bio: null, age: 24, settings: {} },
        { id: 'undefined-team', tenantId: 'acme', teamId: undefined, bio: null, age: 31, settings: {} },
        { id: 'bad-team', tenantId: 'acme', teamId: 'missing', bio: null, age: 42, settings: {} }
      ]
    });

    await expect(validateConstraints(source, constrain(
      fk(validationSchema.profiles, 'teamId', validationSchema.teams, 'id', { optional: true })
    ))).resolves.toEqual({
      kind: 'constraintValidation',
      valid: false,
      diagnostics: [
        expect.objectContaining({
          code: 'constraint_fk',
          relation: 'profiles',
          field: 'teamId',
          key: 'bad-team'
        })
      ]
    });
  });

  it('validates unique optional-null fields and composite foreign keys consistently', async () => {
    const source = fromObjectSource({
      teams,
      profiles: [
        { id: 'ada', tenantId: 'acme', email: 'ada@example.test', bio: null, age: 36, settings: {} },
        { id: 'ada-copy', tenantId: 'acme', email: 'ada@example.test', bio: null, age: 37, settings: {} },
        { id: 'null-email-a', tenantId: 'acme', email: null, bio: null, age: 24, settings: {} },
        { id: 'null-email-b', tenantId: 'acme', email: null, bio: null, age: 31, settings: {} }
      ],
      memberships: [
        { tenantId: 'acme', userId: 'ada', teamId: 'eng', role: 'owner' },
        { tenantId: 'acme', userId: 'ada-copy', teamId: null, role: 'reader' },
        { tenantId: 'acme', userId: 'null-email-a', role: 'reader' },
        { tenantId: 'acme', userId: 'null-email-b', teamId: 'missing', role: 'reader' }
      ]
    });

    await expect(validateConstraints(source, constrain(
      unique(validationSchema.profiles, 'email'),
      fk(validationSchema.memberships, ['tenantId', 'teamId'], validationSchema.teams, ['tenantId', 'id'], {
        optional: true
      })
    ))).resolves.toEqual({
      kind: 'constraintValidation',
      valid: false,
      diagnostics: [
        expect.objectContaining({
          code: 'constraint_unique',
          relation: 'profiles',
          field: 'email',
          key: 'ada@example.test'
        }),
        expect.objectContaining({
          code: 'constraint_fk',
          relation: 'memberships',
          field: 'tenantId,teamId',
          key: '["acme","missing"]'
        })
      ]
    });
  });
});
