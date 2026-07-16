import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TaggedValue } from '../src/value.js';
import type { CreateDatabaseQueryMaintenance, QueryMaintenanceDiagnostics, QueryMaintenanceReuseDiagnostics } from '../src/index.js';
import { pipe } from '../src/query/builder.js';
import { sealSchema } from '../src/schema.js';
import {
  customScalar,
  prepareTypedQuery,
  relationAccess,
  relationDeclaration,
  relationLiteral,
  referenceTo,
  typedAnd,
  typedCompare,
  typedFieldEdit,
  typedFrom,
  typedJoin,
  typedIsNull,
  typedOrderBy,
  typedMove,
  typedParameter,
  typedQueryBody,
  typedRekey,
  typedReturning,
  typedSelect,
  typedSourceOf,
  typedWhere,
  type PreparedPlanParameters,
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
const replace = { id: 'urn:tarstate:capability:field/replace', version: '1', contractHash: hash('b') } as const;
const move = { id: 'urn:tarstate:capability:entity/move', version: '1', contractHash: hash('c') } as const;
const rekey = { id: 'urn:tarstate:capability:entity/rekey', version: '1', contractHash: hash('d') } as const;
const customCodec = { id: 'urn:test:codec:slug', version: '1', contractHash: hash('e') } as const;
type SlugValue = TaggedValue & { readonly type: 'slug'; readonly value: string };

const schema = await sealSchema({
  id: 'urn:test:type-schema',
  body: {
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
          slug: { type: customScalar<SlugValue>(customCodec) }
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
  }
});

type PersonRow = SchemaRow<typeof schema, 'people'>;
type AuditRow = SchemaRow<typeof schema, 'audit'>;

const people = relationLiteral(schema, 'people');
const audit = relationLiteral(schema, 'audit');
const author = typedFrom(people, 'author');
const manager = typedFrom(people, 'manager');
const joined = typedJoin(author, manager, (aliases) => typedCompare('ne', aliases.author.row.id, aliases.manager.row.id));
const filtered = typedWhere(joined, (aliases) => typedCompare('gte', aliases.author.row.score, typedParameter('minimumScore', { kind: 'integer' })));
const projected = typedSelect(filtered, 'result', (aliases) => ({ author: aliases.author.row.name, manager: aliases.manager.row.name }));
const returning = typedReturning('matches', projected);

type IsAny<Value> = 0 extends (1 & Value) ? true : false;

describe('literal-schema and query type authoring', () => {
  it('preserves the portable runtime values while inferring rows, tuple keys, parameters, aliases, and results', () => {
    expect(schema.body.relations.people.relationId).toBe('example.person');
    expect(typedQueryBody(projected)).toMatchObject({
      schemaViews: [{ id: schema.id, contentHash: schema.contentHash }],
      parameters: { minimumScore: { kind: 'integer' } },
      root: { kind: 'select', alias: 'result' }
    });

    expectTypeOf<PersonRow>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
      readonly nickname?: string;
      readonly biography: string | null;
      readonly score: number;
      readonly slug: SlugValue;
    }>();
    expectTypeOf<AuditRow['event']>().toEqualTypeOf<'created' | 'deleted'>();
    expectTypeOf<SchemaKey<typeof schema, 'people'>>().toEqualTypeOf<readonly [string]>();
    expectTypeOf(joined.aliases.author.name).toEqualTypeOf<'author'>();
    expectTypeOf(joined.aliases.manager.name).toEqualTypeOf<'manager'>();
    expectTypeOf<QueryParametersOf<typeof projected>>().toEqualTypeOf<{ readonly minimumScore: number }>();
    expectTypeOf<QueryResultRowOf<typeof projected>>().toEqualTypeOf<{ readonly author: string; readonly manager: string }>();
    expectTypeOf<ReturningRowOf<typeof returning>>().toEqualTypeOf<{ readonly author: string; readonly manager: string }>();
  });

  it('prepares a detached query plan without losing inferred rows or parameters', async () => {
    const prepared = await prepareTypedQuery(projected, {
      registryFingerprint: 'registry:one',
      authorityFingerprint: 'authority:one',
      datasetId: 'dataset:one'
    });

    expect(prepared.query).not.toBe(projected.root);
    expect(prepared.query).toEqual(projected.root);
    expectTypeOf<PreparedPlanParameters<typeof prepared>>().toEqualTypeOf<{ readonly minimumScore: number }>();
    expectTypeOf(prepared).toMatchTypeOf<import('../src/type-authoring.js').TypedPreparedPlan<
      import('../src/query.js').QueryNode,
      { readonly author: string; readonly manager: string },
      { readonly minimumScore: number }
    >>();
  });

  it('ties reference values to target key tuples and keeps typed operators pipe-compatible', async () => {
    const accounts = relationDeclaration({
      relationId: 'example.account',
      key: ['tenant', 'accountId'],
      fields: {
        tenant: { type: { kind: 'string' } },
        accountId: { type: { kind: 'integer' } }
      }
    });
    const referenceSchema = await sealSchema({
      id: 'urn:test:reference-schema',
      body: {
        relations: {
          accounts: {
            relationId: 'example.account',
            key: ['tenant', 'accountId'],
            fields: {
              tenant: { type: { kind: 'string' } },
              accountId: { type: { kind: 'integer' } }
            }
          },
          events: {
            relationId: 'example.event',
            key: ['id'],
            fields: {
              id: { type: { kind: 'string' } },
              account: { type: { kind: 'ref', target: { relationId: 'example.account' } } }
            }
          }
        }
      }
    });
    const events = relationLiteral(referenceSchema, 'events');
    const base = typedFrom(events, 'event');
    const parameter = typedParameter('account', referenceTo(accounts));
    const query = pipe(
      base,
      typedWhere(typedCompare('eq', base.aliases.event.row.account, parameter)),
      typedSelect('result', { id: base.aliases.event.row.id, account: base.aliases.event.row.account })
    );
    const prepared = await prepareTypedQuery(query, {
      registryFingerprint: 'registry:one',
      authorityFingerprint: 'authority:one',
      datasetId: 'dataset:one'
    });

    expect(referenceTo(accounts)).toEqual({ kind: 'ref', target: { relationId: 'example.account' } });
    expectTypeOf<SchemaKey<typeof referenceSchema, 'accounts'>>().toEqualTypeOf<readonly [string, number]>();
    expectTypeOf<SchemaRow<typeof referenceSchema, 'events'>['account']>().toEqualTypeOf<readonly [string, number]>();
    expectTypeOf<QueryParametersOf<typeof query>>().toEqualTypeOf<{ readonly account: readonly [string, number] }>();
    expectTypeOf<QueryResultRowOf<typeof query>>().toEqualTypeOf<{ readonly id: string; readonly account: readonly [string, number] }>();
    expectTypeOf<PreparedPlanParameters<typeof prepared>>().toEqualTypeOf<{ readonly account: readonly [string, number] }>();
  });

  it('authors nullable filters, boolean composition, ordering, and source provenance without losing types', () => {
    const query = typedWhere(author, (aliases) => typedAnd(
      typedIsNull(aliases.author.row.biography),
      typedCompare('gte', aliases.author.row.score, typedParameter('minimum', { kind: 'integer' }))
    ));
    const ordered = typedOrderBy(query, (aliases) => [{ value: aliases.author.row.name, direction: 'asc' }]);
    const result = typedSelect(ordered, 'result', (aliases) => ({
      name: aliases.author.row.name,
      source: typedSourceOf(aliases.author)
    }));

    expect(result.root).toMatchObject({ kind: 'select', input: { kind: 'order', input: { kind: 'where' } } });
    expectTypeOf<QueryParametersOf<typeof result>>().toEqualTypeOf<{ readonly minimum: number }>();
    expectTypeOf<QueryResultRowOf<typeof result>>().toEqualTypeOf<{ readonly name: string; readonly source: string | undefined }>();
  });

  it('rejects conflicting declarations for a composed parameter name', () => {
    expect(() => typedAnd(
      typedCompare(
        'gte',
        author.aliases.author.row.score,
        typedParameter('shared', { kind: 'integer' })
      ),
      typedCompare(
        'eq',
        author.aliases.author.row.name,
        typedParameter('shared', { kind: 'string' })
      )
    )).toThrow('Conflicting declarations for query parameter "shared"');
  });

  it('preserves exact query evidence through more than ten pipeline operators', () => {
    const query = pipe(
      author,
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum0', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum1', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum2', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum3', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum4', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum5', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum6', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum7', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum8', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum9', { kind: 'integer' }))),
      typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum10', { kind: 'integer' }))),
      typedSelect('result', { name: author.aliases.author.row.name })
    );

    expectTypeOf(query.aliases.result.name).toEqualTypeOf<'result'>();
    expectTypeOf<QueryResultRowOf<typeof query>>().toEqualTypeOf<{ readonly name: string }>();
    expectTypeOf<QueryParametersOf<typeof query>>().toEqualTypeOf<{
      readonly minimum0: number;
      readonly minimum1: number;
      readonly minimum2: number;
      readonly minimum3: number;
      readonly minimum4: number;
      readonly minimum5: number;
      readonly minimum6: number;
      readonly minimum7: number;
      readonly minimum8: number;
      readonly minimum9: number;
      readonly minimum10: number;
    }>();
  });

  it('rejects typed query operators outside a typed query pipeline', () => {
    const filter = typedWhere(typedCompare('gte', author.aliases.author.row.score, typedParameter('minimum', { kind: 'integer' })));
    expect(() => {
      // @ts-expect-error typed query operators do not accept primitive pipeline values
      pipe(1, filter);
    }).toThrow('Typed query operator received an invalid query input');
  });

  it('keeps self-join aliases collision-safe at the responsible operator', () => {
    const duplicate = typedFrom(people, 'author');
    // @ts-expect-error duplicate aliases cannot be joined because field scope would be ambiguous
    typedJoin(author, duplicate, (aliases) => typedCompare('eq', aliases.author.row.id, aliases.author.row.id));
    // @ts-expect-error comparisons reject unrelated decoded value types
    typedCompare('eq', author.aliases.author.row.id, author.aliases.author.row.score);
  });

  it('distinguishes readable, writable, field-edit, rekey, and move evidence', () => {
    const peopleAccess = relationAccess(schema.body, 'people');
    const auditAccess = relationAccess(schema.body, 'audit');

    expectTypeOf<typeof peopleAccess>().toEqualTypeOf<RelationAccessOf<typeof schema.body, 'people'>>();
    expectTypeOf(peopleAccess.readable).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.writable).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.rekey).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.move).toEqualTypeOf<true>();
    expectTypeOf(peopleAccess.fields.name).toEqualTypeOf<readonly 'replace'[]>();
    expectTypeOf(peopleAccess.fields.score).toEqualTypeOf<readonly never[]>();
    expectTypeOf(auditAccess.readable).toEqualTypeOf<true>();
    expectTypeOf(auditAccess.writable).toEqualTypeOf<false>();
    expect(peopleAccess.fields.name).toEqual(['replace']);
    expect(peopleAccess.declaration).toBe(schema.body.relations.people);

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
    type MaintenanceInput = Parameters<CreateDatabaseQueryMaintenance<unknown, Readonly<Record<string, unknown>>, unknown>>[0];
    expectTypeOf<keyof MaintenanceInput>().toEqualTypeOf<'plan' | 'initialInput' | 'reuseScope'>();
    expectTypeOf<QueryMaintenanceDiagnostics['strategy']>().toEqualTypeOf<'pooled-differential-operator-dag'>();
    expectTypeOf<QueryMaintenanceReuseDiagnostics>().toEqualTypeOf<{
      readonly computedFrameDeltaCount: number;
      readonly reusedFrameDeltaCount: number;
    }>();
  });

  it('does not infer write authority from readable row shape', () => {
    expectTypeOf(audit.declaration.relationId).toEqualTypeOf<'example.audit'>();
    expectTypeOf<SchemaRow<typeof schema, 'audit'>>().toEqualTypeOf<{ readonly id: string; readonly event: 'created' | 'deleted' }>();
  });
});
