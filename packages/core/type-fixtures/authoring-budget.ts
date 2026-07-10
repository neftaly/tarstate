import type { ArtifactRef } from '../src/artifacts.js';
import type { TaggedValue } from '../src/value.js';
import { pipe } from '../src/query-builder.js';
import {
  customScalar,
  relationAccess,
  relationDeclaration,
  relationLiteral,
  referenceTo,
  schemaLiteral,
  typedCompare,
  typedFrom,
  typedJoin,
  typedParameter,
  typedSelect,
  typedWhere,
  type QueryParametersOf,
  type QueryResultRowOf,
  type SchemaKey,
  type SchemaRow
} from '../src/type-authoring.js';

const hash = `sha256:${'a'.repeat(64)}` as const;
const schemaView: ArtifactRef = { id: 'urn:tarstate:type-budget:schema', contentHash: hash };
const replace = { id: 'urn:tarstate:capability:field/replace', version: '1', contractHash: hash } as const;
const move = { id: 'urn:tarstate:capability:entity/move', version: '1', contractHash: hash } as const;
const slugCodec = { id: 'urn:tarstate:type-budget:codec:slug', version: '1', contractHash: hash } as const;
type BudgetSlug = TaggedValue & { readonly type: 'budget-slug'; readonly value: string };

const teams = relationDeclaration({
  relationId: 'budget.team', key: ['region', 'id'], fields: {
    region: { type: { kind: 'string', values: ['north', 'south'] } },
    id: { type: { kind: 'string' } },
    name: { type: { kind: 'string' } }
  }
});

export const budgetSchema = schemaLiteral({
  relations: {
    people: {
      relationId: 'budget.person', key: ['id'], entityEditCapabilities: [move], fields: {
        id: { type: { kind: 'string' } },
        name: { type: { kind: 'string' }, editCapabilities: [replace] },
        score: { type: { kind: 'integer' } },
        nickname: { type: { kind: 'string' }, optional: true },
        biography: { type: { kind: 'string' }, nullable: true },
        team: { type: referenceTo(teams) },
        slug: { type: customScalar<BudgetSlug>(slugCodec) }
      }
    },
    teams
  }
});

const people = relationLiteral(schemaView, budgetSchema, 'people');
const left = typedFrom(people, 'leftPerson');
const right = typedFrom(people, 'rightPerson');
const joined = typedJoin(left, right, (aliases) => typedCompare('ne', aliases.leftPerson.row.id, aliases.rightPerson.row.id));
const filtered = pipe(joined, typedWhere(typedCompare('gte', joined.aliases.leftPerson.row.score, typedParameter('minimum', { kind: 'integer' }))));

export const budgetQuery = pipe(filtered, typedSelect('result', {
  leftId: filtered.aliases.leftPerson.row.id,
  leftName: filtered.aliases.leftPerson.row.name,
  rightId: filtered.aliases.rightPerson.row.id,
  rightName: filtered.aliases.rightPerson.row.name
}));

export const budgetAccess = relationAccess(budgetSchema, 'people');
export type BudgetPersonRow = SchemaRow<typeof budgetSchema, 'people'>;
export type BudgetTeamKey = SchemaKey<typeof budgetSchema, 'teams'>;
export type BudgetQueryParameters = QueryParametersOf<typeof budgetQuery>;
export type BudgetQueryResult = QueryResultRowOf<typeof budgetQuery>;
