import { describe, expect, it } from 'vitest';
import {
  evaluateQuery,
  openIncrementalQueryMaintenance,
  type IncrementalQueryResult,
  type QueryNode,
  type RelationInput,
  type QueryMaintenanceSnapshot,
} from '../src/query.js';
import type { PreparedPlan } from '../src/maintenance.js';
import { logicalUnknown, type JsonValue } from '../src/value.js';
import type { ArtifactRef } from '../src/artifacts.js';

type QueryRowOccurrence = { readonly occurrenceId: string; readonly row: Readonly<Record<string, import('../src/query.js').QueryLogicalValue>> };

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

const semanticResult = ({ state: _state, ...result }: IncrementalQueryResult) => result;

describe('incremental query maintenance', () => {
  it('matches the independent pure oracle for every query node across insert, update, and delete sequences', () => {
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const final = snapshot(finalPeople, 3);

    for (const [operator, query] of Object.entries(operatorQueries)) {
      const session = openIncrementalQueryMaintenance(plan(query), initial);
      expect(semanticResult(session.getCurrentResult()), `${operator}: initial`).toEqual(oracle(query, initial));

      const middleResult = session.updateSnapshot(middle);
      expect(semanticResult(middleResult), `${operator}: insert/update`).toEqual(oracle(query, middle));
      expect(middleResult.state).toMatchObject({ strategy: 'incremental-operator-graph', revision: 1, rejectedUpdateCount: 0 });

      const finalResult = session.updateSnapshot(final);
      expect(semanticResult(finalResult), `${operator}: delete/update`).toEqual(oracle(query, final));
      expect(finalResult.state).toMatchObject({ strategy: 'incremental-operator-graph', revision: 2, rejectedUpdateCount: 0 });
      session.close();
    }
  });

  it('maintains every expression family with the same semantics as the oracle', () => {
    const callable = { id: 'urn:test:query-function', version: '1', contractHash: `sha256:${'e'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => typeof args[0] === 'string' ? args[0] + '!' : null]]);
    const query: QueryNode = {
      kind: 'select',
      input: people,
      alias: 'result',
      fields: {
        literal: { kind: 'literal', value: 'fixed' },
        parameter: { kind: 'parameter', name: 'minimum' },
        comparison: { kind: 'compare', op: 'gte', left: field('p', 'score'), right: { kind: 'literal', value: 6 } },
        conjunction: { kind: 'boolean', op: 'and', args: [field('p', 'active'), { kind: 'literal', value: true }] },
        negation: { kind: 'boolean', op: 'not', arg: field('p', 'active') },
        arithmetic: { kind: 'arithmetic', op: 'subtract', left: field('p', 'score'), right: { kind: 'literal', value: 1 } },
        concatenated: { kind: 'string', op: 'concat', args: [field('p', 'name'), { kind: 'literal', value: '!' }] },
        lower: { kind: 'string', op: 'lower', args: [field('p', 'name')] },
        upper: { kind: 'string', op: 'upper', args: [field('p', 'name')] },
        length: { kind: 'string', op: 'length', args: [field('p', 'name')] },
        array: { kind: 'array', items: [field('p', 'id'), field('p', 'name')] },
        record: { kind: 'record', fields: { id: field('p', 'id'), name: field('p', 'name') } },
        // Query case branches intentionally use the portable `then` field.
        // oxlint-disable-next-line unicorn/no-thenable
        conditional: { kind: 'case', branches: [{ when: field('p', 'active'), then: { kind: 'literal', value: 'active' } }], otherwise: { kind: 'literal', value: 'inactive' } },
        coalesced: { kind: 'coalesce', args: [{ kind: 'literal', value: null }, field('p', 'name')] },
        called: { kind: 'call', capability: callable, args: [field('p', 'name')] },
        nullCheck: { kind: 'is-null', value: { kind: 'literal', value: null } },
        missingCheck: { kind: 'is-missing', value: field('p', 'absent') },
        logicalKey: { kind: 'key-of', alias: 'p' },
        sourceId: { kind: 'source-of', alias: 'p' }
      }
    };
    const initial = { ...snapshot(basePeople, 1), functions };
    const next = { ...snapshot(middlePeople, 2), functions };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    expect(semanticResult(session.getCurrentResult())).toEqual(oracle(query, initial));
    expect(semanticResult(session.updateSnapshot(next))).toEqual(oracle(query, next));
  });

  it('preserves bag occurrences and reports reincarnation as removal plus insertion', () => {
    const duplicates: readonly QueryRowOccurrence[] = [
      { occurrenceId: 'person:first', row: { id: 1, name: 'same' } },
      { occurrenceId: 'person:second', row: { id: 1, name: 'same' } }
    ];
    const oneRemaining: readonly QueryRowOccurrence[] = [duplicates[1] as QueryRowOccurrence];
    const session = openIncrementalQueryMaintenance(plan(people), snapshot(duplicates, 1));
    expect(session.getCurrentResult().resultKeys).toEqual(['p=person:first', 'p=person:second']);
    const removed = session.updateSnapshot(snapshot(oneRemaining, 2));
    expect(semanticResult(removed)).toEqual(oracle(people, snapshot(oneRemaining, 2)));
    expect(removed.state.resultDelta).toEqual({ addedResultKeys: [], removedResultKeys: ['p=person:first'], updatedResultKeys: [] });

    const reincarnated: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:third', row: { id: 1, name: 'same' } }];
    const replacement = session.updateSnapshot(snapshot(reincarnated, 3));
    expect(semanticResult(replacement)).toEqual(oracle(people, snapshot(reincarnated, 3)));
    expect(replacement.state.resultDelta).toEqual({ addedResultKeys: ['p=person:third'], removedResultKeys: ['p=person:second'], updatedResultKeys: [] });
  });

  it('maintains exact, lower-bound, unknown, basis, membership, and recovery transitions', () => {
    const query = operatorQueries.where as QueryNode;
    const initial = snapshot(basePeople, 1);
    const withPeopleCompleteness = (input: QueryMaintenanceSnapshot, completeness: RelationInput['completeness']): QueryMaintenanceSnapshot => ({
      ...input,
      relations: input.relations.map((candidate) => candidate.relation.relationId === 'people' ? { ...candidate, completeness } : candidate)
    });
    const lower = withPeopleCompleteness(snapshot(middlePeople, 2), 'lower-bound');
    const unknown = {
      ...snapshot(middlePeople, 3),
      relations: snapshot(middlePeople, 3).relations.map((candidate) => candidate.relation.relationId === 'people'
        ? { ...candidate, rows: [], occurrenceIds: [], completeness: 'unknown' as const }
        : candidate)
    };
    const recovered = { ...snapshot(finalPeople, 4), basis: { dataset: 'new-basis' }, membershipRevision: 2 };
    const basisOnly = { ...recovered, basis: { dataset: 'newer-basis' } };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    for (const transition of [lower, unknown, recovered, basisOnly]) {
      const result = session.updateSnapshot(transition);
      expect(semanticResult(result)).toEqual(oracle(query, transition));
    }
    expect(session.getCurrentResult()).toMatchObject({ completeness: 'exact', state: { revision: 4, rejectedUpdateCount: 0 } });
  });

  it('rejects insufficient occurrence identity without invoking a full-query fallback and can recover', () => {
    const query = operatorQueries.where as QueryNode;
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const invalid: QueryMaintenanceSnapshot = {
      ...middle,
      relations: middle.relations.map((input) => input.relation.relationId === 'people'
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'occurrenceIds')) as RelationInput
        : input)
    };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    expect(session.updateSnapshot(invalid)).toMatchObject({ completeness: 'unknown', issues: [{ code: 'query.incremental_identity_invalid' }], state: { recomputedNodeCount: 0, rejectedUpdateCount: 1, resultDelta: { addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] } } });
    const recovered = session.updateSnapshot(snapshot(finalPeople, 3));
    expect(semanticResult(recovered)).toEqual(oracle(query, snapshot(finalPeople, 3)));
    expect(recovered.state).toMatchObject({ rejectedUpdateCount: 1 });
  });

  it('rejects ambiguous relation identity without mutating accepted maintenance state', () => {
    const initial = snapshot(basePeople, 1);
    const duplicate = { ...initial, relations: [...initial.relations, initial.relations[0] as RelationInput] };
    const session = openIncrementalQueryMaintenance(plan(people), initial);
    expect(session.updateSnapshot(duplicate)).toMatchObject({ completeness: 'unknown', issues: [{ code: 'query.incremental_relation_ambiguous' }], state: { recomputedNodeCount: 0, rejectedUpdateCount: 1 } });
    const recovered = snapshot(middlePeople, 2);
    expect(semanticResult(session.updateSnapshot(recovered))).toEqual(oracle(people, recovered));
  });

  it('compares logical unknown without JSON coercion', () => {
    const unknownBase: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:unknown', row: { id: 1, state: logicalUnknown } }];
    const unknownNext: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:unknown', row: { id: 1, state: 'unknown' } }];
    const first: QueryMaintenanceSnapshot = { relations: [relation('people', unknownBase, 1)] };
    const second: QueryMaintenanceSnapshot = { relations: [relation('people', unknownNext, 2)] };
    const session = openIncrementalQueryMaintenance(plan(people), first);
    const maintained = session.updateSnapshot(second);
    expect(semanticResult(maintained)).toEqual(oracle(people, second));
    expect(maintained.state.resultDelta.updatedResultKeys).toEqual(['p=person:unknown']);
  });

  it('does not recompute a graph whose relation dependencies did not change', () => {
    const initial = snapshot(basePeople, 1);
    const unrelated = relation('unrelated', [{ occurrenceId: 'unrelated:1', row: { id: 1 } }], 1);
    const first = { ...initial, relations: [...initial.relations, unrelated] };
    const second = { ...first, relations: [...initial.relations, relation('unrelated', [{ occurrenceId: 'unrelated:1', row: { id: 2 } }], 2)] };
    const session = openIncrementalQueryMaintenance(plan(operatorQueries.where as QueryNode), first);
    const result = session.updateSnapshot(second);
    expect(result.state).toMatchObject({ changedRelationIds: ['unrelated'], recomputedNodeCount: 0 });
    expect(semanticResult(result)).toEqual(oracle(operatorQueries.where as QueryNode, second));
  });

  it('stops delta propagation when an operator materialization does not change', () => {
    const filtered: QueryNode = {
      kind: 'select',
      alias: 'result',
      input: { kind: 'where', input: people, predicate: { kind: 'compare', op: 'gte', left: field('p', 'id'), right: { kind: 'literal', value: 2 } } },
      fields: { id: field('p', 'id') }
    };
    const initial = snapshot(basePeople, 1);
    const changedFilteredOutRow: readonly QueryRowOccurrence[] = [
      { occurrenceId: 'person:a', row: { ...basePeople[0]!.row, name: 'Ada changed outside the result' } },
      basePeople[1] as QueryRowOccurrence
    ];
    const next = snapshot(changedFilteredOutRow, 2);
    const session = openIncrementalQueryMaintenance(plan(filtered), initial);
    const result = session.updateSnapshot(next);
    expect(result.state).toMatchObject({ materializedNodeCount: 3, recomputedNodeCount: 2, changedNodeCount: 1, resultDelta: { addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] } });
    expect(semanticResult(result)).toEqual(oracle(filtered, next));
  });

  it('rejects updates after close', () => {
    const initial = snapshot(basePeople, 1);
    const session = openIncrementalQueryMaintenance(plan(people), initial);
    session.close();
    session.close();
    expect(() => session.updateSnapshot(initial)).toThrow('Incremental query maintenance session is closed');
  });
});
