import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  builtinCapabilitySuffixes,
  canonicalJson,
  capabilityDeclaration,
  capabilityRef,
  evaluateExpression,
  evaluateQuery,
  type ArtifactRef,
  type Expr,
  type LogicalTruth,
  type QueryNode,
  type RelationUse
} from '../src/v1-spike.js';

const schema: ArtifactRef = { id: 'urn:test:schema', contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
const users: RelationUse = { schemaView: schema, relationId: 'test.user' };
const teams: RelationUse = { schemaView: schema, relationId: 'test.team' };
const field = (alias: string, name: string): Expr => ({ kind: 'field', alias, name });
const literal = (value: string | number | boolean | null): Expr => ({ kind: 'literal', value });
const eq = (left: Expr, right: Expr): Expr => ({ kind: 'compare', op: 'eq', left, right });

describe('v1 pure semantic spike', () => {
  it('reconstructs every frozen built-in capability hash', () => {
    for (const suffix of builtinCapabilitySuffixes) {
      const digest = 'sha256:' + createHash('sha256').update(canonicalJson(capabilityDeclaration(suffix))).digest('hex');
      expect(digest).toBe(capabilityRef(suffix).contractHash);
    }
  });

  it('implements the complete strong Kleene truth tables', () => {
    const values: LogicalTruth[] = [true, false, 'unknown'];
    const expectedAnd: LogicalTruth[][] = [[true, false, 'unknown'], [false, false, false], ['unknown', false, 'unknown']];
    const expectedOr: LogicalTruth[][] = [[true, true, true], [true, false, 'unknown'], [true, 'unknown', 'unknown']];
    for (const [leftIndex, left] of values.entries()) {
      for (const [rightIndex, right] of values.entries()) {
        expect(evaluateExpression({ kind: 'boolean', op: 'and', args: [literal(left === 'unknown' ? null : left), literal(right === 'unknown' ? null : right)] }, {})).toBe(expectedAnd[leftIndex]?.[rightIndex]);
        expect(evaluateExpression({ kind: 'boolean', op: 'or', args: [literal(left === 'unknown' ? null : left), literal(right === 'unknown' ? null : right)] }, {})).toBe(expectedOr[leftIndex]?.[rightIndex]);
      }
    }
    expect(evaluateExpression({ kind: 'boolean', op: 'not', arg: literal(null) }, {})).toBe('unknown');
  });

  it('executes from/where/select and omits missing projected fields', () => {
    const root: QueryNode = {
      kind: 'select', alias: 'result',
      input: { kind: 'where', input: { kind: 'from', relation: users, alias: 'user' }, predicate: eq(field('user', 'active'), literal(true)) },
      fields: { id: field('user', 'id'), nickname: field('user', 'nickname'), explicitNull: field('user', 'explicitNull') }
    };
    const result = evaluateQuery({ root, relations: [{ relation: users, completeness: 'exact', rows: [
      { id: 'u1', active: true, explicitNull: null }, { id: 'u2', active: false, explicitNull: null }, { id: 'u3', active: null, explicitNull: null }
    ] }] });
    expect(result).toMatchObject({ completeness: 'exact', rows: [{ result: { id: 'u1', explicitNull: null } }] });
  });

  it('preserves bag multiplicity through an inner join', () => {
    const root: QueryNode = { kind: 'join', join: 'inner', left: { kind: 'from', relation: users, alias: 'user' }, right: { kind: 'from', relation: teams, alias: 'team' }, on: eq(field('user', 'team'), field('team', 'id')) };
    const result = evaluateQuery({ root, relations: [
      { relation: users, completeness: 'exact', rows: [{ id: 'u1', team: 't1' }, { id: 'u1-copy', team: 't1' }] },
      { relation: teams, completeness: 'exact', rows: [{ id: 't1' }, { id: 't1' }] }
    ] });
    expect(result.rows).toHaveLength(4);
    expect(result.completeness).toBe('exact');
  });

  it('returns lower bounds only for positive monotone operators', () => {
    const positive: QueryNode = { kind: 'where', input: { kind: 'from', relation: users, alias: 'user' }, predicate: eq(field('user', 'active'), literal(true)) };
    expect(evaluateQuery({ root: positive, relations: [{ relation: users, completeness: 'lower-bound', rows: [{ id: 'known', active: true }] }] })).toMatchObject({ completeness: 'lower-bound', rows: [{ user: { id: 'known', active: true } }] });

    const anti: QueryNode = { kind: 'join', join: 'anti', left: { kind: 'from', relation: users, alias: 'user' }, right: { kind: 'from', relation: teams, alias: 'team' }, on: eq(field('user', 'team'), field('team', 'id')) };
    const antiResult = evaluateQuery({ root: anti, relations: [
      { relation: users, completeness: 'exact', rows: [{ id: 'u1', team: 'missing-so-far' }] },
      { relation: teams, completeness: 'lower-bound', rows: [] }
    ] });
    expect(antiResult).toMatchObject({ completeness: 'unknown', rows: [], issues: [{ code: 'query.incomplete_non_monotone' }] });
  });

  it('supports grouped/global count and rejects aggregate conclusions over incomplete input', () => {
    const aggregate: QueryNode = { kind: 'aggregate', alias: 'counts', input: { kind: 'from', relation: users, alias: 'user' }, groupBy: { team: field('user', 'team') }, measures: { rows: { kind: 'aggregate.count' }, named: { kind: 'aggregate.count', value: field('user', 'nickname') }, distinctNames: { kind: 'aggregate.count', value: field('user', 'nickname'), distinct: true } } };
    const rows = [{ team: 't1', nickname: 'A' }, { team: 't1', nickname: 'A' }, { team: 't1', nickname: null }];
    expect(evaluateQuery({ root: aggregate, relations: [{ relation: users, completeness: 'exact', rows }] }).rows).toEqual([{ counts: { team: 't1', rows: 3, named: 2, distinctNames: 1 } }]);
    expect(evaluateQuery({ root: aggregate, relations: [{ relation: users, completeness: 'lower-bound', rows }] })).toMatchObject({ completeness: 'unknown', rows: [] });
  });
});
