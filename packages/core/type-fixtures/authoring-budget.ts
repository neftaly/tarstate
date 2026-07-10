import type { ArtifactRef } from '../src/artifacts.js';
import {
  relationAccess,
  relationLiteral,
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

export const budgetSchema = schemaLiteral({
  relations: {
    people: {
      relationId: 'budget.person', key: ['id'], entityEditCapabilities: [move], fields: {
        id: { type: { kind: 'string' } },
        name: { type: { kind: 'string' }, editCapabilities: [replace] },
        score: { type: { kind: 'integer' } },
        nickname: { type: { kind: 'string' }, optional: true },
        biography: { type: { kind: 'string' }, nullable: true }
      }
    },
    teams: {
      relationId: 'budget.team', key: ['region', 'id'], fields: {
        region: { type: { kind: 'string', values: ['north', 'south'] } },
        id: { type: { kind: 'string' } },
        name: { type: { kind: 'string' } }
      }
    }
  }
});

const people = relationLiteral(schemaView, budgetSchema, 'people');
const left = typedFrom(people, 'leftPerson');
const right = typedFrom(people, 'rightPerson');
const joined = typedJoin(left, right, (aliases) => typedCompare('ne', aliases.leftPerson.row.id, aliases.rightPerson.row.id));
const filtered = typedWhere(joined, (aliases) => typedCompare('gte', aliases.leftPerson.row.score, typedParameter('minimum', { kind: 'integer' })));

export const budgetQuery = typedSelect(filtered, 'result', (aliases) => ({
  leftId: aliases.leftPerson.row.id,
  leftName: aliases.leftPerson.row.name,
  rightId: aliases.rightPerson.row.id,
  rightName: aliases.rightPerson.row.name
}));

export const budgetAccess = relationAccess(budgetSchema, 'people');
export type BudgetPersonRow = SchemaRow<typeof budgetSchema, 'people'>;
export type BudgetTeamKey = SchemaKey<typeof budgetSchema, 'teams'>;
export type BudgetQueryParameters = QueryParametersOf<typeof budgetQuery>;
export type BudgetQueryResult = QueryResultRowOf<typeof budgetQuery>;
