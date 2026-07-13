import { describe, expect, it } from 'vitest';
import {
  capabilityUnavailable,
  evaluateExpression,
  evaluatePreparedQuery,
  evaluateQuery,
  logicalUnknown,
  preparePlan,
  prepareQuery,
  type ArtifactRef,
  type CapabilityRef,
  type JsonValue,
  type PreparedPlan,
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
  it('detaches and freezes pure query inputs and visible results', () => {
    const nested = { labels: ['original'] };
    const source = { id: 1, nested };
    const result = evaluateQuery({ root: from('people', 'person'), relations: [relation('people', [source])] });

    nested.labels[0] = 'source-mutated';
    expect(result.rows).toEqual([{ id: 1, nested: { labels: ['original'] } }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0]?.nested)).toBe(true);
    expect(() => ((result.rows[0]!.nested as { labels: string[] }).labels[0] = 'result-mutated')).toThrow();
    expect(source.nested.labels).toEqual(['source-mutated']);
  });

  it('isolates named function arguments and retained return values', () => {
    const capability: CapabilityRef = { id: 'urn:test:owned-function', version: '1', contractHash: `sha256:${'e'.repeat(64)}` };
    const key = capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;
    const source = { nested: { value: 1 } };
    const returned = { nested: { value: 2 } };
    let captured: readonly JsonValue[] | undefined;
    const functions = new Map([[key, (args: readonly JsonValue[]) => { captured = args; return returned; }]]);
    const result = evaluateQuery({
      root: { kind: 'select', input: { kind: 'values', alias: 'v', rows: [source] }, alias: 'out', fields: { value: { kind: 'call', capability, args: [{ kind: 'field', alias: 'v', name: 'nested' }] } } },
      relations: [], functions
    });

    expect(captured).toEqual([{ value: 1 }]);
    expect(captured?.[0]).not.toBe(source.nested);
    expect(Object.isFrozen(captured?.[0])).toBe(true);
    returned.nested.value = 9;
    source.nested.value = 8;
    expect(result.rows).toEqual([{ value: { nested: { value: 2 } } }]);
  });

  it('detaches and freezes a prepared query from its caller-owned AST', async () => {
    const row = { value: 1 };
    const root: QueryNode = { kind: 'values', alias: 'value', rows: [row] };
    const prepared = await prepareQuery({
      root,
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'dataset:test'
    });

    row.value = 2;
    expect(prepared.query).toEqual({ kind: 'values', alias: 'value', rows: [{ value: 1 }] });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.query)).toBe(true);
    expect(Object.isFrozen(prepared.query.kind === 'values' ? prepared.query.rows : [])).toBe(true);
  });

  it('reuses a prepared AST while continuing to own changing evaluation inputs', async () => {
    const root: QueryNode = from('people', 'person');
    const prepared = await prepareQuery({
      root,
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'dataset:test'
    });
    const nested = { label: 'original' };
    const result = evaluatePreparedQuery(prepared, { relations: [relation('people', [{ id: 1, nested }])] });

    nested.label = 'mutated';
    expect(result.rows).toEqual([{ id: 1, nested: { label: 'original' } }]);
    expect(Object.isFrozen(result.rows[0]?.nested)).toBe(true);
    expect(() => evaluatePreparedQuery({ ...prepared } as PreparedPlan<QueryNode>, { relations: [] }))
      .toThrow('not produced by a plan preparation API');
  });

  it('requires portable plan input and does not execute hostile accessors', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { getterCalls += 1; return 1; }
    });

    await expect(preparePlan({ query: hostile as JsonValue, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' })).rejects.toThrow('portable value');
    await expect(preparePlan({ query: { callback: () => undefined } as unknown as JsonValue, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' })).rejects.toThrow('portable value');
    expect(getterCalls).toBe(0);

    // @ts-expect-error prepared plans cannot be assembled structurally
    const forged: PreparedPlan<JsonValue> = { planId: 'forged', rootNodeId: 'forged:root', query: null, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' };
    void forged;
  });

  it('prepares deeply nested portable plans within the query AST budget', async () => {
    let query: JsonValue = null;
    for (let depth = 0; depth < 100; depth += 1) query = { child: query };
    await expect(preparePlan({ query, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' }))
      .resolves.toMatchObject({ query });
  });

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

  it('keeps projected identities stable and union-all branch identities unique', () => {
    const base = from('people', 'person');
    const projection: QueryNode = { kind: 'select', input: base, alias: 'result', fields: { id: { kind: 'field', alias: 'person', name: 'id' } } };
    const initial = evaluateQuery({ root: projection, relations: [{ ...relation('people', [{ id: 1 }, { id: 2 }]), occurrenceIds: ['person:1', 'person:2'] }] });
    const insertedBefore = evaluateQuery({ root: projection, relations: [{ ...relation('people', [{ id: 0 }, { id: 1 }, { id: 2 }]), occurrenceIds: ['person:0', 'person:1', 'person:2'] }] });
    expect(insertedBefore.resultKeys.slice(1)).toEqual(initial.resultKeys);

    const duplicated = evaluateQuery({ root: { kind: 'set', op: 'union-all', left: base, right: base }, relations: [{ ...relation('people', [{ id: 1 }]), occurrenceIds: ['person:1'] }] });
    expect(duplicated.rows).toEqual([{ id: 1 }, { id: 1 }]);
    expect(new Set(duplicated.resultKeys).size).toBe(2);

    const windowed: QueryNode = { kind: 'window', input: { kind: 'set', op: 'union-all', left: base, right: base }, alias: 'person', fields: { rowNumber: { kind: 'window', op: 'row-number', orderBy: [{ value: { kind: 'field', alias: 'person', name: 'id' }, direction: 'asc' }] } } };
    expect(evaluateQuery({ root: windowed, relations: [{ ...relation('people', [{ id: 1 }]), occurrenceIds: ['person:1'] }] }).rows).toEqual([{ id: 1, rowNumber: 1 }, { id: 1, rowNumber: 2 }]);
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
    expect(evaluateQuery({ root: join('left'), relations }).rows).toEqual([
      { l: { id: 1 }, r: { leftId: 1, value: 'x' } },
      { l: { id: 1 }, r: { leftId: 1, value: 'y' } },
      { l: { id: 2 }, r: {} }
    ]);
  });

  it('evaluates singleton-tuple reference joins in either operand order', () => {
    const reference = { kind: 'field', alias: 'pizza', name: 'base' } as const;
    const keyTuple = { kind: 'array', items: [{ kind: 'field', alias: 'base', name: 'name' } as const] } as const;
    const join = (reversed: boolean): QueryNode => ({
      kind: 'join', join: 'inner', left: from('pizzas', 'pizza'), right: from('bases', 'base'),
      on: { kind: 'compare', op: 'eq', left: reversed ? keyTuple : reference, right: reversed ? reference : keyTuple }
    });
    const relations = [
      relation('pizzas', [{ name: 'Margherita', base: ['thin'] }, { name: 'Deep dish', base: ['deep'] }]),
      relation('bases', [{ name: 'thin', style: 'crisp' }, { name: 'deep', style: 'soft' }])
    ];

    for (const reversed of [false, true]) expect(evaluateQuery({ root: join(reversed), relations }).rows).toEqual([
      { pizza: { name: 'Margherita', base: ['thin'] }, base: { name: 'thin', style: 'crisp' } },
      { pizza: { name: 'Deep dish', base: ['deep'] }, base: { name: 'deep', style: 'soft' } }
    ]);
  });

  it('defines empty aggregates and preserves deterministic ordered windows', () => {
    const aggregate: QueryNode = {
      kind: 'aggregate',
      input: from('empty', 'item'),
      alias: 'summary',
      groupBy: {},
      measures: {
        count: { kind: 'aggregate', op: 'count' },
        countDistinct: { kind: 'aggregate', op: 'count-distinct', value: { kind: 'field', alias: 'item', name: 'score' } },
        sum: { kind: 'aggregate', op: 'sum', value: { kind: 'field', alias: 'item', name: 'score' } },
        average: { kind: 'aggregate', op: 'average', value: { kind: 'field', alias: 'item', name: 'score' } },
        minimum: { kind: 'aggregate', op: 'minimum', value: { kind: 'field', alias: 'item', name: 'score' } },
        maximum: { kind: 'aggregate', op: 'maximum', value: { kind: 'field', alias: 'item', name: 'score' } },
        any: { kind: 'aggregate', op: 'any', value: { kind: 'field', alias: 'item', name: 'ok' } },
        every: { kind: 'aggregate', op: 'every', value: { kind: 'field', alias: 'item', name: 'ok' } },
        collect: { kind: 'aggregate', op: 'collect', value: { kind: 'field', alias: 'item', name: 'score' } },
        first: { kind: 'aggregate', op: 'first', value: { kind: 'field', alias: 'item', name: 'score' } },
        last: { kind: 'aggregate', op: 'last', value: { kind: 'field', alias: 'item', name: 'score' } }
      }
    };
    expect(evaluateQuery({ root: aggregate, relations: [relation('empty', [])] }).rows).toEqual([{ count: 0, countDistinct: 0, sum: null, average: null, minimum: null, maximum: null, any: false, every: true, collect: [], first: null, last: null }]);

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

  it('shares partitioning and ordering work across equivalent window fields', () => {
    const capability: CapabilityRef = { id: 'urn:test:window-value', version: '1', contractHash: `sha256:${'f'.repeat(64)}` };
    const capabilityKey = capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;
    let evaluations = 0;
    const call = (name: string) => ({ kind: 'call' as const, capability, args: [{ kind: 'field' as const, alias: 'score', name }] });
    const specification = {
      partitionBy: [call('group')],
      orderBy: [{ value: call('points'), direction: 'asc' as const }]
    };
    const window: QueryNode = {
      kind: 'window',
      input: from('scores', 'score'),
      alias: 'score',
      fields: {
        rowNumber: { kind: 'window', op: 'row-number', ...specification },
        rank: { kind: 'window', op: 'rank', ...specification },
        previous: { kind: 'window', op: 'lag', value: { kind: 'field', alias: 'score', name: 'points' }, ...specification }
      }
    };
    const rows = [
      { id: 'a', group: 'x', points: 2 },
      { id: 'b', group: 'x', points: 1 },
      { id: 'c', group: 'y', points: 1 },
      { id: 'd', group: 'y', points: null }
    ];
    const functions = new Map([[capabilityKey, (args: readonly JsonValue[]) => { evaluations += 1; return args[0] ?? null; }]]);

    expect(evaluateQuery({ root: window, relations: [relation('scores', rows)], functions }).rows).toEqual([
      { id: 'a', group: 'x', points: 2, rowNumber: 2, rank: 2, previous: 1 },
      { id: 'b', group: 'x', points: 1, rowNumber: 1, rank: 1, previous: null },
      { id: 'c', group: 'y', points: 1, rowNumber: 1, rank: 1, previous: null },
      { id: 'd', group: 'y', points: null, rowNumber: 2, rank: 2, previous: 1 }
    ]);
    expect(evaluations).toBe(rows.length * 2);
  });

  it('rebuilds a window layout when its specification reads an earlier window field', () => {
    const specification = {
      partitionBy: [{ kind: 'field' as const, alias: 'score', name: 'bucket' }],
      orderBy: [{ value: { kind: 'field' as const, alias: 'score', name: 'points' }, direction: 'asc' as const }]
    };
    const window: QueryNode = {
      kind: 'window',
      input: from('scores', 'score'),
      alias: 'score',
      fields: {
        bucket: { kind: 'window', op: 'row-number', ...specification },
        rank: { kind: 'window', op: 'rank', ...specification }
      }
    };

    expect(evaluateQuery({ root: window, relations: [relation('scores', [{ id: 'high', points: 2 }, { id: 'low', points: 1 }])] }).rows).toEqual([
      { id: 'high', points: 2, bucket: 2, rank: 1 },
      { id: 'low', points: 1, bucket: 1, rank: 1 }
    ]);
  });

  it('rejects non-monotone operators over lower-bound inputs', () => {
    const result = evaluateQuery({ root: { kind: 'slice', input: from('partial'), limit: 1 }, relations: [relation('partial', [{ id: 1 }], 'lower-bound')] });
    expect(result).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ details: { reason: 'incomplete_non_monotone', operator: 'slice' } }] });
  });

  it('keeps valid lower bounds for anti/left with an exact right side and for intersect/except', () => {
    const inputs = [relation('left', [{ id: 1 }, { id: 2 }], 'lower-bound'), relation('right', [{ id: 1 }])];
    const on = { kind: 'compare' as const, op: 'eq' as const, left: { kind: 'field' as const, alias: 'l', name: 'id' }, right: { kind: 'field' as const, alias: 'r', name: 'id' } };
    expect(evaluateQuery({ root: { kind: 'join', join: 'anti', left: from('left', 'l'), right: from('right', 'r'), on }, relations: inputs })).toMatchObject({ completeness: 'lower-bound', rows: [{ id: 2 }] });
    expect(evaluateQuery({ root: { kind: 'join', join: 'left', left: from('left', 'l'), right: from('right', 'r'), on }, relations: inputs }).completeness).toBe('lower-bound');
    expect(evaluateQuery({ root: { kind: 'set', op: 'intersect', left: from('left'), right: from('right') }, relations: inputs })).toMatchObject({ completeness: 'lower-bound', rows: [{ id: 1 }] });
    expect(evaluateQuery({ root: { kind: 'set', op: 'except', left: from('left'), right: from('right') }, relations: inputs })).toMatchObject({ completeness: 'lower-bound', rows: [{ id: 2 }] });
  });

  it('does not infer false/cardinality from an empty lower-bound subquery', () => {
    const lower = from('partial', 'p');
    expect(evaluateExpression({ kind: 'coalesce', args: [{ kind: 'compare', op: 'eq', left: { kind: 'literal', value: null }, right: { kind: 'literal', value: 1 } }, { kind: 'literal', value: 'fallback' }] }, {})).toBe(logicalUnknown);
    const existsResult = evaluateQuery({ root: { kind: 'where', input: { kind: 'values', alias: 'outer', rows: [{ id: 1 }] }, predicate: { kind: 'subquery', mode: 'exists', query: lower } }, relations: [relation('partial', [], 'lower-bound')] });
    expect(existsResult.rows).toEqual([]);
    expect(evaluateExpression({ kind: 'is-null', value: { kind: 'compare', op: 'eq', left: { kind: 'literal', value: null }, right: { kind: 'literal', value: 1 } } }, {})).toBe(logicalUnknown);
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
    const nonlinear: QueryNode = {
      kind: 'recursive',
      name: 'numbers',
      seed: { kind: 'values', alias: 'n', rows: [{ value: 1 }] },
      step: { kind: 'set', op: 'union-all', left: { kind: 'recursion-ref', name: 'numbers' }, right: { kind: 'recursion-ref', name: 'numbers' } },
      key: [{ kind: 'field', alias: 'n', name: 'value' }]
    };
    expect(evaluateQuery({ root: nonlinear, relations: [] })).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.recursion_non_monotone', details: { reason: 'recursion_must_be_linear_and_monotone' } }] });
  });

  it('evaluates an invariant recursive join side once as the frontier grows', () => {
    const capability: CapabilityRef = { id: 'urn:test:recursion-index-key', version: '1', contractHash: `sha256:${'d'.repeat(64)}` };
    const capabilityKey = capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;
    const edgeCount = 48;
    let invariantEvaluations = 0;
    const functions = new Map([[capabilityKey, (args: readonly JsonValue[]) => {
      invariantEvaluations += 1;
      return args[0] ?? null;
    }]]);
    const indexedEdges: QueryNode = {
      kind: 'select',
      alias: 'edge',
      input: from('edges', 'rawEdge'),
      fields: {
        parentId: { kind: 'call', capability, args: [{ kind: 'field', alias: 'rawEdge', name: 'parentId' }] },
        targetId: { kind: 'field', alias: 'rawEdge', name: 'targetId' }
      }
    };
    const recursive: QueryNode = {
      kind: 'recursive',
      name: 'nodes',
      seed: { kind: 'values', alias: 'node', rows: [{ id: 0 }] },
      step: {
        kind: 'select',
        alias: 'node',
        input: {
          kind: 'join',
          join: 'inner',
          left: { kind: 'recursion-ref', name: 'nodes' },
          right: indexedEdges,
          on: { kind: 'compare', op: 'eq', left: { kind: 'field', alias: 'node', name: 'id' }, right: { kind: 'field', alias: 'edge', name: 'parentId' } }
        },
        fields: { id: { kind: 'field', alias: 'edge', name: 'targetId' } }
      },
      key: [{ kind: 'field', alias: 'node', name: 'id' }],
      maxIterations: edgeCount + 1
    };
    const edges = Array.from({ length: edgeCount }, (_, parentId) => ({ parentId, targetId: parentId + 1 }));

    const result = evaluateQuery({ root: recursive, relations: [relation('edges', edges)], functions });

    expect(result).toMatchObject({ completeness: 'exact', issues: [] });
    expect(result.rows.map((row) => row.id)).toEqual(Array.from({ length: edgeCount + 1 }, (_, id) => id));
    // Without invariant-side memoization this is edgeCount work for each of
    // edgeCount frontiers. The semantic pipeline and its join index are built
    // once for this evaluation instead.
    expect(invariantEvaluations).toBe(edgeCount);
  });

  it('does not memoize a nested recursion that captures the outer frontier', () => {
    const capturedFrontier: QueryNode = {
      kind: 'recursive',
      name: 'captured',
      seed: {
        kind: 'select',
        alias: 'capturedNode',
        input: { kind: 'recursion-ref', name: 'nodes' },
        fields: { id: { kind: 'field', alias: 'node', name: 'id' } }
      },
      step: { kind: 'recursion-ref', name: 'captured' },
      key: [{ kind: 'field', alias: 'capturedNode', name: 'id' }]
    };
    const recursive: QueryNode = {
      kind: 'recursive',
      name: 'nodes',
      seed: { kind: 'values', alias: 'node', rows: [{ id: 0 }] },
      step: {
        kind: 'select',
        alias: 'node',
        input: {
          kind: 'where',
          input: { kind: 'join', join: 'cross', left: { kind: 'recursion-ref', name: 'nodes' }, right: capturedFrontier },
          predicate: { kind: 'compare', op: 'lt', left: { kind: 'field', alias: 'capturedNode', name: 'id' }, right: { kind: 'literal', value: 3 } }
        },
        fields: { id: { kind: 'arithmetic', op: 'add', left: { kind: 'field', alias: 'capturedNode', name: 'id' }, right: { kind: 'literal', value: 1 } } }
      },
      key: [{ kind: 'field', alias: 'node', name: 'id' }]
    };

    expect(evaluateQuery({ root: recursive, relations: [] })).toMatchObject({
      completeness: 'exact',
      rows: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
      issues: []
    });
  });

  it('binds keyset seek to basis and membership revision', () => {
    const by = [{ value: { kind: 'field', alias: 'item', name: 'id' } as const, direction: 'asc' as const }];
    const relations = [relation('items', [{ id: 1 }, { id: 2 }, { id: 3 }])];
    const ordered = evaluateQuery({ root: { kind: 'order', input: from('items', 'item'), by }, relations });
    const cursor = { order: [1], resultKey: ordered.resultKeys[0] as string, basis: { revision: 4 }, membershipRevision: 9, mode: 'live' as const };
    expect(evaluateQuery({ root: { kind: 'seek', input: from('items', 'item'), by, after: cursor }, relations, basis: { revision: 4 }, membershipRevision: 9 }).rows).toEqual([{ id: 2 }, { id: 3 }]);
    expect(evaluateQuery({ root: { kind: 'seek', input: from('items', 'item'), by, after: cursor }, relations, basis: { revision: 5 }, membershipRevision: 9 })).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.cursor_stale' }] });
    expect(evaluateQuery({ root: { kind: 'seek', input: from('items', 'item'), by, after: cursor }, relations, basis: { revision: 4 }, membershipRevision: 10 })).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.cursor_stale' }] });
  });

  it('orders arrays and objects structurally with numeric nested values', () => {
    const input: QueryNode = {
      kind: 'values', alias: 'item', rows: [
        { id: 'object-10', value: { a: [10] } },
        { id: 'array-10', value: [10] },
        { id: 'object-b', value: { b: 0 } },
        { id: 'array-9', value: [9] },
        { id: 'object-9', value: { a: [9] } }
      ]
    };
    const by = [{ value: { kind: 'field', alias: 'item', name: 'value' } as const, direction: 'asc' as const }];
    const ordered = evaluateQuery({ root: { kind: 'order', input, by }, relations: [] });
    expect(ordered.rows.map((row) => row.id)).toEqual(['array-9', 'array-10', 'object-9', 'object-10', 'object-b']);

    const belowTen = evaluateQuery({
      root: {
        kind: 'where',
        input: { kind: 'values', alias: 'tuple', rows: [{ id: 'nine', value: [9] }, { id: 'ten', value: [10] }] },
        predicate: {
          kind: 'compare', op: 'lt',
          left: { kind: 'field', alias: 'tuple', name: 'value' },
          right: { kind: 'literal', value: [10] }
        }
      },
      relations: []
    });
    expect(belowTen.rows).toEqual([{ id: 'nine', value: [9] }]);

    const aggregate: QueryNode = {
      kind: 'aggregate', input, alias: 'summary', groupBy: {}, measures: {
        minimum: { kind: 'aggregate', op: 'minimum', value: { kind: 'field', alias: 'item', name: 'value' } },
        maximum: { kind: 'aggregate', op: 'maximum', value: { kind: 'field', alias: 'item', name: 'value' } }
      }
    };
    expect(evaluateQuery({ root: aggregate, relations: [] }).rows).toEqual([{ minimum: [9], maximum: { b: 0 } }]);
  });

  it('seeks numerically through tuple-valued order keys', () => {
    const input: QueryNode = { kind: 'values', alias: 'item', rows: [{ id: 'nine', key: [9] }, { id: 'ten', key: [10] }] };
    const by = [{ value: { kind: 'field', alias: 'item', name: 'key' } as const, direction: 'asc' as const }];
    const ordered = evaluateQuery({ root: { kind: 'order', input, by }, relations: [] });
    const cursor = { order: [[9]], resultKey: ordered.resultKeys[0] as string, basis: { revision: 1 }, membershipRevision: 1, mode: 'live' as const };
    expect(ordered.rows.map((row) => row.id)).toEqual(['nine', 'ten']);
    expect(evaluateQuery({ root: { kind: 'seek', input, by, after: cursor }, relations: [], basis: { revision: 1 }, membershipRevision: 1 }).rows)
      .toEqual([{ id: 'ten', key: [10] }]);
  });

  it('orders ordinary values before null then missing regardless of direction', () => {
    const input: QueryNode = { kind: 'values', alias: 'v', rows: [{ id: 'missing' }, { id: 'null', value: null }, { id: 'ordinary', value: 1 }] };
    const result = evaluateQuery({ root: { kind: 'order', input, by: [{ value: { kind: 'field', alias: 'v', name: 'value' }, direction: 'desc' }] }, relations: [] });
    expect(result.rows.map((row) => row.id)).toEqual(['ordinary', 'null', 'missing']);
  });

  it('retains explicit nulls in value-preserving aggregates while excluding missing values', () => {
    const input: QueryNode = { kind: 'values', alias: 'item', rows: [{ score: null }, { score: 2 }, {}] };
    const root: QueryNode = {
      kind: 'aggregate', input, alias: 'summary', groupBy: {}, measures: {
        count: { kind: 'aggregate', op: 'count', value: { kind: 'field', alias: 'item', name: 'score' } },
        collect: { kind: 'aggregate', op: 'collect', value: { kind: 'field', alias: 'item', name: 'score' } },
        first: { kind: 'aggregate', op: 'first', value: { kind: 'field', alias: 'item', name: 'score' } },
        last: { kind: 'aggregate', op: 'last', value: { kind: 'field', alias: 'item', name: 'score' } }
      }
    };
    expect(evaluateQuery({ root, relations: [] }).rows).toEqual([{ count: 1, collect: [null, 2], first: null, last: 2 }]);
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

  it('keeps aliases and occurrence lineage distinct in a self join', () => {
    const root: QueryNode = {
      kind: 'join', join: 'inner', left: from('people', 'left'), right: from('people', 'right'),
      on: { kind: 'compare', op: 'lt', left: { kind: 'field', alias: 'left', name: 'id' }, right: { kind: 'field', alias: 'right', name: 'id' } }
    };
    const result = evaluateQuery({ root, relations: [{ ...relation('people', [{ id: 1 }, { id: 2 }]), occurrenceIds: ['person:1', 'person:2'] }] });
    expect(result.rows).toEqual([{ left: { id: 1 }, right: { id: 2 } }]);
    expect(result.resultKeys[0]).toBe('4:left24:11:source:test8:person:15:right24:11:source:test8:person:2');
  });

  it('encodes result lineage without delimiter collisions', () => {
    const root: QueryNode = {
      kind: 'join', join: 'inner', left: from('left-people', 'left'), right: from('right-people', 'right'),
      on: { kind: 'compare', op: 'eq', left: { kind: 'field', alias: 'left', name: 'pair' }, right: { kind: 'field', alias: 'right', name: 'pair' } }
    };
    const result = evaluateQuery({
      root,
      relations: [
        { ...relation('left-people', [{ pair: 1 }, { pair: 2 }]), occurrenceIds: ['x|right=y', 'x'] },
        { ...relation('right-people', [{ pair: 1 }, { pair: 2 }]), occurrenceIds: ['z', 'y|right=z'] }
      ]
    });
    expect(new Set(result.resultKeys).size).toBe(2);
  });

  it('rejects missing transformation aliases and recursion references instead of inventing empty inputs', () => {
    const missingAlias = evaluateQuery({
      root: { kind: 'with-fields', input: { kind: 'values', alias: 'actual', rows: [{ id: 1 }] }, alias: 'missing', fields: { added: { kind: 'literal', value: true } } },
      relations: []
    });
    expect(missingAlias).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.alias_missing', details: { alias: 'missing' } }] });

    const missingRecursion = evaluateQuery({ root: { kind: 'recursion-ref', name: 'outside-recursion' }, relations: [] });
    expect(missingRecursion).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.recursion_reference_missing' }] });
  });

  it('turns a throwing named function into unavailable completeness', () => {
    const capability: CapabilityRef = { id: 'urn:test:throwing', version: '1', contractHash: `sha256:${'c'.repeat(64)}` };
    const functions = new Map([[capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash, () => { throw new Error('boom'); }]]);
    const result = evaluateQuery({ root: { kind: 'select', input: { kind: 'values', alias: 'v', rows: [{}] }, alias: 'out', fields: { value: { kind: 'call', capability, args: [] } } }, relations: [], functions });
    expect(result).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.function_failed' }] });
  });
});
