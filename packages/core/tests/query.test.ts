import { describe, expect, it } from 'vitest';
import {
  capabilityUnavailable,
  evaluateExpression,
  evaluateQuery,
  logicalUnknown,
  type ArtifactRef,
  type CapabilityRef,
  type QueryNode,
  type RelationInput
} from '../src/index.js';

const schemaView: ArtifactRef = {
  id: 'urn:test:schema',
  contentHash: `sha256:${'a'.repeat(64)}`
};

const relation = (relationId: string, rows: RelationInput['rows'], completeness: RelationInput['completeness'] = 'exact'): RelationInput => ({
  relation: { schemaView, relationId },
  rows,
  completeness,
  sourceId: 'source:test',
  attachmentId: 'attachment:test'
});

const from = (relationId: string, alias = relationId): QueryNode => ({
  kind: 'from',
  relation: { schemaView, relationId },
  alias
});

describe('production query oracle', () => {
  it('keeps data string "unknown" disjoint from logical unknown through nested comparisons', () => {
    expect(evaluateExpression({ kind: 'literal', value: 'unknown' }, {})).toBe('unknown');
    expect(evaluateExpression({
      kind: 'compare',
      op: 'eq',
      left: { kind: 'compare', op: 'eq', left: { kind: 'literal', value: null }, right: { kind: 'literal', value: 1 } },
      right: { kind: 'literal', value: true }
    }, {})).toBe(logicalUnknown);
  });

  it('evaluates filtering and projection with bag multiplicity', () => {
    const root: QueryNode = {
      kind: 'select',
      alias: 'result',
      input: {
        kind: 'where',
        input: from('people', 'person'),
        predicate: { kind: 'compare', op: 'gte', left: { kind: 'field', alias: 'person', name: 'score' }, right: { kind: 'parameter', name: 'minimum' } }
      },
      fields: {
        id: { kind: 'field', alias: 'person', name: 'id' },
        label: { kind: 'string', op: 'upper', args: [{ kind: 'field', alias: 'person', name: 'name' }] }
      }
    };
    const result = evaluateQuery({
      root,
      relations: [relation('people', [{ id: 1, name: 'one', score: 2 }, { id: 1, name: 'one', score: 2 }, { id: 2, name: 'two', score: 1 }])],
      parameters: { minimum: 2 }
    });
    expect(result).toMatchObject({ completeness: 'exact', rows: [{ id: 1, label: 'ONE' }, { id: 1, label: 'ONE' }] });
    expect(new Set(result.resultKeys).size).toBe(2);
  });

  it('poisons completeness when a required named call is unavailable', () => {
    const capability: CapabilityRef = { id: 'urn:test:function', version: '1', contractHash: `sha256:${'b'.repeat(64)}` };
    const result = evaluateQuery({
      root: { kind: 'where', input: from('people'), predicate: { kind: 'call', capability, args: [{ kind: 'literal', value: true }] } },
      relations: [relation('people', [{ id: 1 }])]
    });
    expect(result.completeness).toBe('unknown');
    expect(result.rows).toEqual([]);
    expect(result.issues).toMatchObject([{ code: 'query.capability_unavailable' }]);
    expect(evaluateExpression({ kind: 'call', capability, args: [] }, {})).toBe(capabilityUnavailable);
  });

  it('implements inner, semi, anti, and left join membership', () => {
    const join = (kind: 'inner' | 'semi' | 'anti' | 'left'): QueryNode => ({
      kind: 'join',
      join: kind,
      left: from('left', 'l'),
      right: from('right', 'r'),
      on: { kind: 'compare', op: 'eq', left: { kind: 'field', alias: 'l', name: 'id' }, right: { kind: 'field', alias: 'r', name: 'leftId' } }
    });
    const relations = [relation('left', [{ id: 1 }, { id: 2 }]), relation('right', [{ leftId: 1, value: 'x' }, { leftId: 1, value: 'y' }])];
    expect(evaluateQuery({ root: join('inner'), relations }).rows).toHaveLength(2);
    expect(evaluateQuery({ root: join('semi'), relations }).rows).toEqual([{ id: 1 }]);
    expect(evaluateQuery({ root: join('anti'), relations }).rows).toEqual([{ id: 2 }]);
    expect(evaluateQuery({ root: join('left'), relations }).rows).toHaveLength(3);
  });

  it('defines empty aggregates and preserves deterministic ordered windows', () => {
    const aggregate: QueryNode = {
      kind: 'aggregate',
      input: from('empty', 'item'),
      alias: 'summary',
      groupBy: {},
      measures: {
        count: { kind: 'aggregate', op: 'count' },
        sum: { kind: 'aggregate', op: 'sum', value: { kind: 'field', alias: 'item', name: 'score' } },
        every: { kind: 'aggregate', op: 'every', value: { kind: 'field', alias: 'item', name: 'ok' } }
      }
    };
    expect(evaluateQuery({ root: aggregate, relations: [relation('empty', [])] }).rows).toEqual([{ count: 0, sum: null, every: true }]);

    const window: QueryNode = {
      kind: 'window',
      input: from('scores', 'score'),
      alias: 'score',
      fields: {
        rank: { kind: 'window', op: 'rank', orderBy: [{ value: { kind: 'field', alias: 'score', name: 'points' }, direction: 'desc' }] }
      }
    };
    expect(evaluateQuery({ root: { kind: 'order', input: window, by: [{ value: { kind: 'field', alias: 'score', name: 'points' }, direction: 'desc' }] }, relations: [relation('scores', [{ id: 'b', points: 5 }, { id: 'a', points: 10 }, { id: 'c', points: 5 }])] }).rows)
      .toEqual([{ id: 'a', points: 10, rank: 1 }, { id: 'b', points: 5, rank: 2 }, { id: 'c', points: 5, rank: 2 }]);
  });

  it('rejects non-monotone operators over lower-bound inputs', () => {
    const result = evaluateQuery({ root: { kind: 'slice', input: from('partial'), limit: 1 }, relations: [relation('partial', [{ id: 1 }], 'lower-bound')] });
    expect(result).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ details: { reason: 'incomplete_non_monotone', operator: 'slice' } }] });
  });
});
