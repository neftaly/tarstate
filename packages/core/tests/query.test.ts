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
    const projected = evaluateQuery({
      root: { kind: 'select', input: { kind: 'values', alias: 'v', rows: [{ value: null }] }, alias: 'out', fields: { comparison: { kind: 'compare', op: 'eq', left: { kind: 'field', alias: 'v', name: 'value' }, right: { kind: 'literal', value: 1 } } } },
      relations: []
    });
    expect(projected.rows[0]?.comparison).toBe(logicalUnknown);
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

  it('evaluates correlated exists and scalar subqueries', () => {
    const petsForPerson: QueryNode = {
      kind: 'where',
      input: from('pets', 'pet'),
      predicate: { kind: 'compare', op: 'eq', left: { kind: 'field', alias: 'pet', name: 'ownerId' }, right: { kind: 'field', alias: 'person', name: 'id' } }
    };
    const countPets: QueryNode = {
      kind: 'aggregate',
      input: petsForPerson,
      alias: 'summary',
      groupBy: {},
      measures: { count: { kind: 'aggregate', op: 'count' } }
    };
    const root: QueryNode = {
      kind: 'select',
      alias: 'result',
      input: { kind: 'where', input: from('people', 'person'), predicate: { kind: 'subquery', mode: 'exists', query: petsForPerson } },
      fields: {
        id: { kind: 'field', alias: 'person', name: 'id' },
        pets: { kind: 'subquery', mode: 'scalar', query: countPets }
      }
    };
    const result = evaluateQuery({ root, relations: [relation('people', [{ id: 1 }, { id: 2 }]), relation('pets', [{ id: 'a', ownerId: 1 }, { id: 'b', ownerId: 1 }])] });
    expect(result.rows).toEqual([{ id: 1, pets: 2 }]);
  });

  it('computes a keyed least fixpoint and enforces recursion budgets', () => {
    const step: QueryNode = {
      kind: 'select',
      alias: 'n',
      input: {
        kind: 'where',
        input: { kind: 'recursion-ref', name: 'numbers' },
        predicate: { kind: 'compare', op: 'lt', left: { kind: 'field', alias: 'n', name: 'value' }, right: { kind: 'literal', value: 3 } }
      },
      fields: { value: { kind: 'arithmetic', op: 'add', left: { kind: 'field', alias: 'n', name: 'value' }, right: { kind: 'literal', value: 1 } } }
    };
    const recursive = (maxIterations?: number): QueryNode => ({
      kind: 'recursive',
      name: 'numbers',
      seed: { kind: 'values', alias: 'n', rows: [{ value: 1 }] },
      step,
      key: [{ kind: 'field', alias: 'n', name: 'value' }],
      ...(maxIterations === undefined ? {} : { maxIterations })
    });
    expect(evaluateQuery({ root: recursive(), relations: [] }).rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(evaluateQuery({ root: recursive(1), relations: [] })).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.recursion_budget_exceeded' }] });
  });

  it('binds keyset seek to basis and membership revision', () => {
    const by = [{ value: { kind: 'field', alias: 'item', name: 'id' } as const, direction: 'asc' as const }];
    const relations = [relation('items', [{ id: 1 }, { id: 2 }, { id: 3 }])];
    const ordered = evaluateQuery({ root: { kind: 'order', input: from('items', 'item'), by }, relations });
    const cursor = { order: [1], resultKey: ordered.resultKeys[0] as string, basis: { revision: 4 }, membershipRevision: 9, mode: 'live' as const };
    expect(evaluateQuery({ root: { kind: 'seek', input: from('items', 'item'), by, after: cursor }, relations, basis: { revision: 4 }, membershipRevision: 9 }).rows).toEqual([{ id: 2 }, { id: 3 }]);
    expect(evaluateQuery({ root: { kind: 'seek', input: from('items', 'item'), by, after: cursor }, relations, basis: { revision: 5 }, membershipRevision: 9 })).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.cursor_stale' }] });
  });

  it('orders ordinary values before null then missing regardless of direction', () => {
    const input: QueryNode = { kind: 'values', alias: 'v', rows: [{ id: 'missing' }, { id: 'null', value: null }, { id: 'ordinary', value: 1 }] };
    const result = evaluateQuery({ root: { kind: 'order', input, by: [{ value: { kind: 'field', alias: 'v', name: 'value' }, direction: 'desc' }] }, relations: [] });
    expect(result.rows.map((row) => row.id)).toEqual(['ordinary', 'null', 'missing']);
  });

  it('keeps result identity across attachment replacement and changes it on proven reincarnation', () => {
    const root = from('items', 'item');
    const base = relation('items', [{ id: 1 }]);
    const first = evaluateQuery({ root, relations: [{ ...base, attachmentId: 'attachment:old', occurrenceIds: ['source:row:incarnation:1'] }] });
    const replacement = evaluateQuery({ root, relations: [{ ...base, attachmentId: 'attachment:new', occurrenceIds: ['source:row:incarnation:1'] }] });
    const reincarnated = evaluateQuery({ root, relations: [{ ...base, attachmentId: 'attachment:new', occurrenceIds: ['source:row:incarnation:2'] }] });
    expect(replacement.resultKeys).toEqual(first.resultKeys);
    expect(reincarnated.resultKeys).not.toEqual(first.resultKeys);
  });
});
