import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TaggedValue } from '../src/value.js';
import {
  relationAccess,
  relationLiteral,
  schemaLiteral,
  typedCompare,
  typedFieldEdit,
  typedFrom,
  typedJoin,
  typedMove,
  typedParameter,
  typedQueryBody,
  typedRekey,
  typedReturning,
  typedSelect,
  typedWhere,
  type QueryParametersOf,
  type QueryResultRowOf,
  type RelationAccessOf,
  type ReturningRowOf,
  type RuntimeQueryParameters,
  type RuntimeQueryResultRow,
  type SchemaKey,
  type SchemaRow
} from '../src/type-authoring.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaRef = { id: 'urn:test:type-schema', contentHash: hash('a') } as const;
const replace = { id: 'urn:tarstate:capability:field/replace', version: '1', contractHash: hash('b') } as const;
const move = { id: 'urn:tarstate:capability:entity/move', version: '1', contractHash: hash('c') } as const;
const rekey = { id: 'urn:tarstate:capability:entity/rekey', version: '1', contractHash: hash('d') } as const;
const customCodec = { id: 'urn:test:codec:slug', version: '1', contractHash: hash('e') } as const;

const schema = schemaLiteral({
  relations: {
    people: {
      relationId: 'example.person',
      key: ['id'],
      entityEditCapabilities: [move, rekey],
      fields: {
        id: { type: { kind: 'string' } },
        name: { type: { kind: 'string' }, editCapabilities: [replace] },
        nickname: { type: { kind: 'string' }, optional: true },
        biography: { type: { kind: 'string' }, nullable: true },
        score: { type: { kind: 'integer' } },
        slug: { type: { kind: 'custom', codec: customCodec } }
      }
    },
    audit: {
      relationId: 'example.audit',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        event: { type: { kind: 'string', values: ['created', 'deleted'] } }
      }
    }
  }
});

type PersonRow = SchemaRow<typeof schema, 'people'>;
type AuditRow = SchemaRow<typeof schema, 'audit'>;

const people = relationLiteral(schemaRef, schema, 'people');
const audit = relationLiteral(schemaRef, schema, 'audit');
const author = typedFrom(people, 'author');
const manager = typedFrom(people, 'manager');
const joined = typedJoin(author, manager, (aliases) => typedCompare('ne', aliases.author.row.id, aliases.manager.row.id));
const filtered = typedWhere(joined, (aliases) => typedCompare('gte', aliases.author.row.score, typedParameter('minimumScore', { kind: 'integer' })));
const projected = typedSelect(filtered, 'result', (aliases) => ({ author: aliases.author.row.name, manager: aliases.manager.row.name }));
const returning = typedReturning('matches', projected);

type IsAny<Value> = 0 extends (1 & Value) ? true : false;

describe('literal-schema and query type authoring', () => {
  it('preserves the portable runtime values while inferring rows, tuple keys, parameters, aliases, and results', () => {
    expect(schema.relations.people.relationId).toBe('example.person');
    expect(typedQueryBody(projected)).toMatchObject({
      schemaViews: [schemaRef],
      parameters: { minimumScore: { kind: 'integer' } },
      root: { kind: 'select', alias: 'result' }
    });

    expectTypeOf<PersonRow>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
      readonly nickname?: string;
      readonly biography: string | null;
      readonly score: number;
      readonly slug: TaggedValue;
    }>();
    expectTypeOf<AuditRow['event']>().toEqualTypeOf<'created' | 'deleted'>();
    expectTypeOf<SchemaKey<typeof schema, 'people'>>().toEqualTypeOf<readonly [string]>();
    expectTypeOf(joined.aliases.author.name).toEqualTypeOf<'author'>();
    expectTypeOf(joined.aliases.manager.name).toEqualTypeOf<'manager'>();
    expectTypeOf<QueryParametersOf<typeof projected>>().toEqualTypeOf<{ readonly minimumScore: number }>();
    expectTypeOf<QueryResultRowOf<typeof projected>>().toEqualTypeOf<{ readonly author: string; readonly manager: string }>();
    expectTypeOf<ReturningRowOf<typeof returning>>().toEqualTypeOf<{ readonly author: string; readonly manager: string }>();
  });

  it('keeps self-join aliases collision-safe at the responsible operator', () => {
    const duplicate = typedFrom(people, 'author');
    // @ts-expect-error duplicate aliases cannot be joined because field scope would be ambiguous
    typedJoin(author, duplicate, (aliases) => typedCompare('eq', aliases.author.row.id, aliases.author.row.id));
  });

  it('distinguishes readable, writable, field-edit, rekey, and move evidence', () => {
    const peopleAccess = relationAccess(schema, 'people');
    const auditAccess = relationAccess(schema, 'audit');

    expectTypeOf<typeof peopleAccess>().toEqualTypeOf<RelationAccessOf<typeof schema, 'people'>>();
    expectTypeOf(peopleAccess.readable).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.writable).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.rekey).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.move).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.fields.name).toEqualTypeOf<'replace'>();
    expectTypeOf(peopleAccess.fields.score).toEqualTypeOf<never>();
    expectTypeOf(auditAccess.readable).toEqualTypeOf<true>();
    expectTypeOf(auditAccess.writable).toEqualTypeOf<false>();

    typedFieldEdit(peopleAccess, 'name', 'Renamed');
    typedRekey(peopleAccess, ['new-id'] as const);
    typedMove(peopleAccess, 'new-parent');
    // @ts-expect-error score declares no field edit capability
    typedFieldEdit(peopleAccess, 'score', 4);
    // @ts-expect-error editable fields still retain their declared value type
    typedFieldEdit(peopleAccess, 'name', 4);
    // @ts-expect-error rekeys use the schema's always-tuple logical key
    typedRekey(peopleAccess, ['one', 'two'] as const);
    // @ts-expect-error readable audit rows do not imply rekey support
    typedRekey(auditAccess, ['new-id'] as const);
    // @ts-expect-error readable audit rows do not imply move support
    typedMove(auditAccess, 'new-parent');
  });

  it('keeps dynamic artifacts runtime-typed and never any', () => {
    expectTypeOf<RuntimeQueryParameters>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expectTypeOf<RuntimeQueryResultRow>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expectTypeOf<IsAny<RuntimeQueryParameters>>().toEqualTypeOf<false>();
    expectTypeOf<IsAny<RuntimeQueryResultRow>>().toEqualTypeOf<false>();
  });

  it('does not infer write authority from readable row shape', () => {
    expectTypeOf(audit.declaration.relationId).toEqualTypeOf<'example.audit'>();
    expectTypeOf<SchemaRow<typeof schema, 'audit'>>().toEqualTypeOf<{ readonly id: string; readonly event: 'created' | 'deleted' }>();
  });
});
