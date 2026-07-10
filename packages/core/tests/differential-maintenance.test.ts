import { describe, expect, it } from 'vitest';
import {
  createDifferentialQueryMaintenanceStrategy,
  type DifferentialMaintainedQueryResult,
  type DifferentialFallbackReason,
  type QueryMaintenanceChange,
  type QueryMaintenanceSnapshot,
  type QueryRowOccurrence
} from '../src/differential-maintenance.js';
import type { PreparedPlan, RelationDelta } from '../src/maintenance.js';
import { evaluateQuery, type QueryNode, type RelationInput } from '../src/query.js';
import { logicalUnknown, type JsonValue } from '../src/value.js';
import type { ArtifactRef } from '../src/artifacts.js';

const schemaView: ArtifactRef = {
  id: 'urn:test:ivm-schema',
  contentHash: `sha256:${'d'.repeat(64)}`
};

const basePeople: readonly QueryRowOccurrence[] = [
  { occurrenceId: 'person:a', row: { id: 1, name: 'Ada', score: 10, group: 'x', active: true, tags: ['engineer', 'reader'] } },
  { occurrenceId: 'person:b', row: { id: 2, name: 'Bob', score: 5, group: 'y', active: false, tags: ['reader'] } }
];
const middlePeople: readonly QueryRowOccurrence[] = [
  basePeople[0] as QueryRowOccurrence,
  { occurrenceId: 'person:b', row: { id: 2, name: 'Bob', score: 8, group: 'y', active: true, tags: ['reader'] } },
  { occurrenceId: 'person:c', row: { id: 3, name: 'Cy', score: 5, group: 'x', active: true, tags: [] } }
];
const finalPeople: readonly QueryRowOccurrence[] = [
  middlePeople[1] as QueryRowOccurrence,
  { occurrenceId: 'person:c', row: { id: 3, name: 'Cy', score: 12, group: 'x', active: true, tags: ['runner'] } }
];

const relation = (
  relationId: string,
  occurrences: readonly QueryRowOccurrence[],
  basis: JsonValue,
  completeness: RelationInput['completeness'] = 'exact'
): RelationInput => ({
  relation: { schemaView, relationId },
  rows: occurrences.map(({ row }) => row),
  occurrenceIds: occurrences.map(({ occurrenceId }) => occurrenceId),
  completeness,
  sourceId: `source:${relationId}`,
  attachmentId: `attachment:${relationId}`,
  basis
});

const groups = relation('groups', [
  { occurrenceId: 'group:x', row: { id: 'x', label: 'X' } },
  { occurrenceId: 'group:y', row: { id: 'y', label: 'Y' } }
], 1);

const snapshot = (people: readonly QueryRowOccurrence[], revision: number): QueryMaintenanceSnapshot => ({
  relations: [relation('people', people, revision), groups],
  parameters: { minimum: 6 },
  basis: { dataset: 'stable-for-seek' },
  membershipRevision: 1
});

const delta = (
  before: number,
  after: number,
  changes: Pick<RelationDelta<QueryRowOccurrence>, 'added' | 'removed' | 'updated'>,
  overrides: Partial<RelationDelta<QueryRowOccurrence>> = {}
): QueryMaintenanceChange => ({
  relationDeltas: [{
    relationId: 'people',
    beforeBasis: before,
    afterBasis: after,
    invalidated: false,
    ...changes,
    ...overrides
  }]
});

const toMiddle = delta(1, 2, {
  added: [middlePeople[2] as QueryRowOccurrence],
  removed: [],
  updated: [{ before: basePeople[1] as QueryRowOccurrence, after: middlePeople[1] as QueryRowOccurrence }]
});
const toFinal = delta(2, 3, {
  added: [],
  removed: [middlePeople[0] as QueryRowOccurrence],
  updated: [{ before: middlePeople[2] as QueryRowOccurrence, after: finalPeople[1] as QueryRowOccurrence }]
});

const from = (relationId: 'people' | 'groups', alias: string): QueryNode => ({
  kind: 'from',
  relation: { schemaView, relationId },
  alias
});
const field = (alias: string, name: string) => ({ kind: 'field', alias, name } as const);
const people = from('people', 'p');
const groupRows = from('groups', 'g');
const groupJoin = (join: 'inner' | 'cross' | 'left' | 'semi' | 'anti'): QueryNode => ({
  kind: 'join',
  join,
  left: people,
  right: groupRows,
  ...(join === 'cross' ? {} : { on: { kind: 'compare', op: 'eq', left: field('p', 'group'), right: field('g', 'id') } })
});
const ids = (input: QueryNode): QueryNode => ({ kind: 'select', input, alias: 'result', fields: { id: field('p', 'id') } });

const recursive: QueryNode = {
  kind: 'recursive',
  name: 'numbers',
  seed: { kind: 'values', alias: 'n', rows: [{ value: 1 }] },
  step: {
    kind: 'select',
    alias: 'n',
    input: {
      kind: 'where',
      input: { kind: 'recursion-ref', name: 'numbers' },
      predicate: { kind: 'compare', op: 'lt', left: field('n', 'value'), right: { kind: 'literal', value: 3 } }
    },
    fields: { value: { kind: 'arithmetic', op: 'add', left: field('n', 'value'), right: { kind: 'literal', value: 1 } } }
  },
  key: [field('n', 'value')]
};

const operatorQueries: Readonly<Record<string, QueryNode>> = {
  from: people,
  values: { kind: 'values', alias: 'constant', rows: [{ value: 'constant' }] },
  where: { kind: 'where', input: people, predicate: { kind: 'compare', op: 'gte', left: field('p', 'score'), right: { kind: 'parameter', name: 'minimum' } } },
  select: { kind: 'select', input: people, alias: 'result', fields: { id: field('p', 'id'), upper: { kind: 'string', op: 'upper', args: [field('p', 'name')] } } },
  'with-fields': { kind: 'with-fields', input: people, alias: 'p', fields: { doubled: { kind: 'arithmetic', op: 'multiply', left: field('p', 'score'), right: { kind: 'literal', value: 2 } } } },
  rename: { kind: 'rename', input: people, alias: 'p', fields: { score: 'points' } },
  omit: { kind: 'omit', input: people, alias: 'p', fields: ['tags'] },
  unnest: { kind: 'unnest', input: people, expression: field('p', 'tags'), alias: 'tag', field: 'value' },
  'join-inner': groupJoin('inner'),
  'join-cross': groupJoin('cross'),
  'join-left': groupJoin('left'),
  'join-semi': groupJoin('semi'),
  'join-anti': groupJoin('anti'),
  aggregate: {
    kind: 'aggregate',
    input: people,
    alias: 'summary',
    groupBy: { group: field('p', 'group') },
    measures: {
      count: { kind: 'aggregate', op: 'count' },
      distinct: { kind: 'aggregate', op: 'count-distinct', value: field('p', 'score') },
      sum: { kind: 'aggregate', op: 'sum', value: field('p', 'score') },
      average: { kind: 'aggregate', op: 'average', value: field('p', 'score') },
      minimum: { kind: 'aggregate', op: 'minimum', value: field('p', 'score') },
      maximum: { kind: 'aggregate', op: 'maximum', value: field('p', 'score') },
      any: { kind: 'aggregate', op: 'any', value: field('p', 'active') },
      every: { kind: 'aggregate', op: 'every', value: field('p', 'active') },
      collect: { kind: 'aggregate', op: 'collect', value: field('p', 'name') },
      first: { kind: 'aggregate', op: 'first', value: field('p', 'name'), orderBy: [{ value: field('p', 'score'), direction: 'desc' }] },
      last: { kind: 'aggregate', op: 'last', value: field('p', 'name'), orderBy: [{ value: field('p', 'score'), direction: 'desc' }] }
    }
  },
  distinct: { kind: 'distinct', input: { kind: 'select', input: people, alias: 'result', fields: { group: field('p', 'group') } } },
  'set-union': { kind: 'set', op: 'union', left: ids(people), right: { kind: 'values', alias: 'result', rows: [{ id: 2 }, { id: 4 }] } },
  'set-union-all': { kind: 'set', op: 'union-all', left: ids(people), right: { kind: 'values', alias: 'result', rows: [{ id: 2 }, { id: 4 }] } },
  'set-intersect': { kind: 'set', op: 'intersect', left: ids(people), right: { kind: 'values', alias: 'result', rows: [{ id: 2 }, { id: 4 }] } },
  'set-except': { kind: 'set', op: 'except', left: ids(people), right: { kind: 'values', alias: 'result', rows: [{ id: 2 }, { id: 4 }] } },
  order: { kind: 'order', input: people, by: [{ value: field('p', 'score'), direction: 'desc' }] },
  slice: { kind: 'slice', input: { kind: 'order', input: people, by: [{ value: field('p', 'score'), direction: 'desc' }] }, offset: 1, limit: 1 },
  window: {
    kind: 'window',
    input: people,
    alias: 'p',
    fields: {
      rowNumber: { kind: 'window', op: 'row-number', partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'score'), direction: 'desc' }] },
      rank: { kind: 'window', op: 'rank', partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'score'), direction: 'desc' }] },
      previous: { kind: 'window', op: 'lag', value: field('p', 'score'), partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'score'), direction: 'desc' }] }
    }
  },
  seek: {
    kind: 'seek',
    input: people,
    by: [{ value: field('p', 'id'), direction: 'asc' }],
    after: { order: [1], resultKey: 'p=person:a', basis: { dataset: 'stable-for-seek' }, membershipRevision: 1, mode: 'live' }
  },
  subquery: {
    kind: 'where',
    input: people,
    predicate: {
      kind: 'subquery',
      mode: 'exists',
      query: { kind: 'where', input: groupRows, predicate: { kind: 'compare', op: 'eq', left: field('g', 'id'), right: field('p', 'group') } }
    }
  },
  recursive
};

const plan = (query: QueryNode): PreparedPlan<QueryNode> => ({
  planId: 'plan:test',
  rootNodeId: 'plan:test:root',
  query,
  registryFingerprint: 'registry:test',
  authorityFingerprint: 'authority:test',
  datasetId: 'dataset:test'
});

const oracle = (query: QueryNode, input: QueryMaintenanceSnapshot) => evaluateQuery({
  root: query,
  relations: input.relations,
  ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
  ...(input.functions === undefined ? {} : { functions: input.functions }),
  ...(input.basis === undefined ? {} : { basis: input.basis }),
  ...(input.membershipRevision === undefined ? {} : { membershipRevision: input.membershipRevision })
});

const semanticResult = ({ state: _state, ...result }: DifferentialMaintainedQueryResult) => result;

describe('differential query maintenance', () => {
  it('matches the pure oracle for every query node across insert, update, and delete sequences', () => {
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const final = snapshot(finalPeople, 3);

    for (const [operator, query] of Object.entries(operatorQueries)) {
      const session = createDifferentialQueryMaintenanceStrategy().open(plan(query), { snapshot: initial });
      expect(semanticResult(session.current()), `${operator}: initial`).toEqual(oracle(query, initial));

      const middleResult = session.update({ snapshot: middle, change: toMiddle });
      expect(semanticResult(middleResult), `${operator}: insert/update`).toEqual(oracle(query, middle));
      expect(middleResult.state).toMatchObject({ mode: 'validated-delta-recompute', acceptedHints: 1, fallbackCount: 0 });

      const finalResult = session.update({ snapshot: final, change: toFinal });
      expect(semanticResult(finalResult), `${operator}: delete/update`).toEqual(oracle(query, final));
      expect(finalResult.state).toMatchObject({ mode: 'validated-delta-recompute', acceptedHints: 2, fallbackCount: 0 });
      session.close();
    }
  });

  it('falls back to the fresh oracle for absent, stale, invalidated, and rejected hints', () => {
    const query = operatorQueries.aggregate as QueryNode;
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const cases: readonly [DifferentialFallbackReason, QueryMaintenanceChange | undefined][] = [
      ['missing_change_hint', undefined],
      ['stale_before_basis', delta(0, 2, { added: [middlePeople[2] as QueryRowOccurrence], removed: [], updated: [{ before: basePeople[1] as QueryRowOccurrence, after: middlePeople[1] as QueryRowOccurrence }] })],
      ['invalidated_hint', delta(1, 2, { added: [], removed: [], updated: [] }, { invalidated: true })],
      ['delta_snapshot_mismatch', delta(1, 2, { added: [{ occurrenceId: 'person:wrong', row: { id: 99 } }], removed: [], updated: [{ before: basePeople[1] as QueryRowOccurrence, after: middlePeople[1] as QueryRowOccurrence }] })]
    ];

    for (const [reason, change] of cases) {
      const session = createDifferentialQueryMaintenanceStrategy().open(plan(query), { snapshot: initial });
      const result = session.update({ snapshot: middle, ...(change === undefined ? {} : { change }) });
      expect(semanticResult(result), reason).toEqual(oracle(query, middle));
      expect(result.state).toMatchObject({ mode: 'full-recompute', fallbackCount: 1, fallbackReason: reason });
    }
  });

  it('recovers from fallback on the next trustworthy hint and compares logical unknown without JSON coercion', () => {
    const unknownBase: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:unknown', row: { id: 1, state: logicalUnknown } }];
    const unknownNext: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:unknown', row: { id: 1, state: 'unknown' } }];
    const first: QueryMaintenanceSnapshot = { relations: [relation('people', unknownBase, 1)] };
    const second: QueryMaintenanceSnapshot = { relations: [relation('people', unknownNext, 2)] };
    const change = delta(1, 2, {
      added: [],
      removed: [],
      updated: [{ before: unknownBase[0] as QueryRowOccurrence, after: unknownNext[0] as QueryRowOccurrence }]
    });
    const session = createDifferentialQueryMaintenanceStrategy().open(plan(people), { snapshot: first });
    const fallback = session.update({ snapshot: first });
    expect(fallback.state.fallbackReason).toBe('missing_change_hint');
    const recovered = session.update({ snapshot: second, change });
    expect(semanticResult(recovered)).toEqual(oracle(people, second));
    expect(recovered.state).toMatchObject({ mode: 'validated-delta-recompute', acceptedHints: 1, fallbackCount: 1 });
  });

  it('rejects updates after close', () => {
    const initial = snapshot(basePeople, 1);
    const session = createDifferentialQueryMaintenanceStrategy().open(plan(people), { snapshot: initial });
    session.close();
    session.close();
    expect(() => session.update({ snapshot: initial })).toThrow('Maintenance session is closed');
  });
});
