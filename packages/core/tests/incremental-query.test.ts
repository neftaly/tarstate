import { describe, expect, it } from 'vitest';
import {
  createPooledIncrementalQueryRuntime,
  diffQueryMaintenanceSnapshots,
  evaluateQuery,
  openIncrementalQueryMaintenance,
  isNonPoolableQueryError,
  isPooledQueryRuntimeBusyError,
  type IncrementalQueryResult,
  type QueryNode,
  type QueryRecord,
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

const from = (relationId: string, alias: string): QueryNode => ({
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
    after: { order: [1], resultKey: '1:p8:person:a', basis: { dataset: 'stable-for-seek' }, membershipRevision: 1, mode: 'live' }
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
const applySnapshot = (session: ReturnType<typeof openIncrementalQueryMaintenance>, before: QueryMaintenanceSnapshot, after: QueryMaintenanceSnapshot): IncrementalQueryResult =>
  session.applyUpdate(diffQueryMaintenanceSnapshots(before, after));

describe('incremental query maintenance', () => {
  it('matches the independent pure oracle for every query node across insert, update, and delete sequences', () => {
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const final = snapshot(finalPeople, 3);

    for (const [operator, query] of Object.entries(operatorQueries)) {
      const session = openIncrementalQueryMaintenance(plan(query), initial);
      expect(semanticResult(session.getCurrentResult()), `${operator}: initial`).toEqual(oracle(query, initial));

      const middleResult = applySnapshot(session, initial, middle);
      expect(semanticResult(middleResult), `${operator}: insert/update`).toEqual(oracle(query, middle));
      expect(middleResult.state).toMatchObject({ strategy: 'differential-operator-graph', revision: 1, rejectedUpdateCount: 0 });

      const finalResult = applySnapshot(session, middle, final);
      expect(semanticResult(finalResult), `${operator}: delete/update`).toEqual(oracle(query, final));
      expect(finalResult.state).toMatchObject({ strategy: 'differential-operator-graph', revision: 2, rejectedUpdateCount: 0 });
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
    expect(semanticResult(applySnapshot(session, initial, next))).toEqual(oracle(query, next));
  });

  it('preserves bag occurrences and reports reincarnation as removal plus insertion', () => {
    const duplicates: readonly QueryRowOccurrence[] = [
      { occurrenceId: 'person:first', row: { id: 1, name: 'same' } },
      { occurrenceId: 'person:second', row: { id: 1, name: 'same' } }
    ];
    const oneRemaining: readonly QueryRowOccurrence[] = [duplicates[1] as QueryRowOccurrence];
    const initial = snapshot(duplicates, 1);
    const session = openIncrementalQueryMaintenance(plan(people), initial);
    const [firstKey, secondKey] = session.getCurrentResult().resultKeys;
    expect(new Set([firstKey, secondKey]).size).toBe(2);
    const remaining = snapshot(oneRemaining, 2);
    const removed = applySnapshot(session, initial, remaining);
    expect(semanticResult(removed)).toEqual(oracle(people, remaining));
    expect(removed.state.resultDelta).toEqual({ addedResultKeys: [], removedResultKeys: [firstKey], updatedResultKeys: [] });

    const reincarnated: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:third', row: { id: 1, name: 'same' } }];
    const replaced = snapshot(reincarnated, 3);
    const replacement = applySnapshot(session, remaining, replaced);
    expect(semanticResult(replacement)).toEqual(oracle(people, replaced));
    expect(replacement.state.resultDelta).toMatchObject({ removedResultKeys: [secondKey], updatedResultKeys: [] });
    expect(replacement.state.resultDelta.addedResultKeys).toHaveLength(1);
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
    let accepted = initial;
    for (const transition of [lower, unknown, recovered, basisOnly]) {
      const result = applySnapshot(session, accepted, transition);
      expect(semanticResult(result)).toEqual(oracle(query, transition));
      accepted = transition;
    }
    expect(session.getCurrentResult()).toMatchObject({ completeness: 'exact', state: { revision: 4, rejectedUpdateCount: 0 } });
  });

  it('rejects malformed occurrence deltas without invoking rematerialization and can recover', () => {
    const query = operatorQueries.where as QueryNode;
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const valid = diffQueryMaintenanceSnapshots(initial, middle);
    const peopleChange = valid.relations.find(({ relation }) => relation.relationId === 'people') as NonNullable<typeof valid.relations[number]>;
    const invalid = { ...valid, relations: [{ ...peopleChange, rows: [{ occurrenceId: 'person:missing', after: { index: 0, row: { id: 9 } } }] }] };
    expect(session.applyUpdate(invalid)).toMatchObject({ completeness: 'unknown', issues: [{ code: 'query.incremental_identity_invalid' }], state: { updatedNodeCount: 0, rejectedUpdateCount: 1, resultDelta: { addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] } } });
    const final = snapshot(finalPeople, 3);
    const recovered = applySnapshot(session, initial, final);
    expect(semanticResult(recovered)).toEqual(oracle(query, final));
    expect(recovered.state).toMatchObject({ rejectedUpdateCount: 1 });
  });

  it('requires occurrence identity when opening maintenance over non-empty relations', () => {
    const input = relation('people', basePeople, 1);
    const { occurrenceIds: _occurrenceIds, ...unidentified } = input;
    expect(openIncrementalQueryMaintenance(plan(people), { relations: [unidentified] }).getCurrentResult()).toMatchObject({
      rows: [],
      completeness: 'unknown',
      issues: [{ code: 'query.incremental_identity_invalid' }]
    });
  });

  it('rejects duplicate relation changes without mutating accepted maintenance state', () => {
    const initial = snapshot(basePeople, 1);
    const recovered = snapshot(middlePeople, 2);
    const valid = diffQueryMaintenanceSnapshots(initial, recovered);
    const duplicate = { ...valid, relations: [valid.relations[0] as NonNullable<typeof valid.relations[number]>, valid.relations[0] as NonNullable<typeof valid.relations[number]>] };
    const session = openIncrementalQueryMaintenance(plan(people), initial);
    expect(session.applyUpdate(duplicate)).toMatchObject({ completeness: 'unknown', issues: [{ code: 'query.incremental_identity_invalid' }], state: { updatedNodeCount: 0, rejectedUpdateCount: 1 } });
    expect(semanticResult(applySnapshot(session, initial, recovered))).toEqual(oracle(people, recovered));
  });

  it('compares logical unknown without JSON coercion', () => {
    const unknownBase: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:unknown', row: { id: 1, state: logicalUnknown } }];
    const unknownNext: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:unknown', row: { id: 1, state: 'unknown' } }];
    const first: QueryMaintenanceSnapshot = { relations: [relation('people', unknownBase, 1)] };
    const second: QueryMaintenanceSnapshot = { relations: [relation('people', unknownNext, 2)] };
    const session = openIncrementalQueryMaintenance(plan(people), first);
    const [resultKey] = session.getCurrentResult().resultKeys;
    const maintained = applySnapshot(session, first, second);
    expect(semanticResult(maintained)).toEqual(oracle(people, second));
    expect(maintained.state.resultDelta.updatedResultKeys).toEqual([resultKey]);
  });

  it('unions distinct attachment inputs with bag semantics and stable source provenance', () => {
    const personal = { ...relation('people', [{ occurrenceId: 'entry:1', row: { id: 1, name: 'personal' } }], 1), sourceId: 'source:personal', attachmentId: 'attachment:personal' };
    const shared = { ...relation('people', [{ occurrenceId: 'entry:1', row: { id: 1, name: 'shared' } }], 1), sourceId: 'source:shared', attachmentId: 'attachment:shared' };
    const query: QueryNode = {
      kind: 'select',
      alias: 'result',
      input: people,
      fields: { name: field('p', 'name'), source: { kind: 'source-of', alias: 'p' } }
    };
    const initial: QueryMaintenanceSnapshot = { relations: [personal, shared], basis: { dataset: 1 }, membershipRevision: 1 };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const first = session.getCurrentResult();
    expect(first.rows).toEqual([{ name: 'personal', source: 'source:personal' }, { name: 'shared', source: 'source:shared' }]);
    expect(new Set(first.resultKeys).size).toBe(2);

    const changedShared = { ...shared, rows: [{ id: 1, name: 'shared updated' }], basis: 2 };
    const changed: QueryMaintenanceSnapshot = { ...initial, relations: [personal, changedShared], basis: { dataset: 2 } };
    const updated = applySnapshot(session, initial, changed);
    expect(updated.rows).toEqual([{ name: 'personal', source: 'source:personal' }, { name: 'shared updated', source: 'source:shared' }]);
    expect(updated.resultKeys).toEqual(first.resultKeys);
    expect(updated.state.resultDelta.updatedResultKeys).toHaveLength(1);

    const personalOnly: QueryMaintenanceSnapshot = { ...initial, relations: [personal], basis: { dataset: 3 }, membershipRevision: 2 };
    const removed = applySnapshot(session, changed, personalOnly);
    expect(removed.rows).toEqual([{ name: 'personal', source: 'source:personal' }]);
    expect(removed.resultKeys).toEqual([first.resultKeys[0]]);
    expect(removed.state.resultDelta.removedResultKeys).toEqual([first.resultKeys[1]]);

    expect(evaluateQuery({ root: query, relations: [personal, personal] })).toMatchObject({
      completeness: 'unknown',
      issues: [{ code: 'query.input_identity_invalid', details: { reason: 'duplicate_attachment_input' } }]
    });
    const { attachmentId: _personalAttachment, ...sourceOnlyPersonal } = personal;
    const { attachmentId: _sharedAttachment, ...sourceOnlyShared } = shared;
    expect(evaluateQuery({ root: query, relations: [sourceOnlyPersonal, sourceOnlyShared] })).toMatchObject({
      completeness: 'exact',
      rows: [{ source: 'source:personal' }, { source: 'source:shared' }]
    });
  });

  it('updates and reorders right-side equijoin matches without stale indexed segments', () => {
    const left = relation('people', [{ occurrenceId: 'person:a', row: { id: 1, group: 'x' } }], 1);
    const firstRight = relation('groups', [
      { occurrenceId: 'group:x:first', row: { id: 'x', label: 'first' } },
      { occurrenceId: 'group:x:second', row: { id: 'x', label: 'second' } }
    ], 1);
    const query: QueryNode = {
      kind: 'select',
      alias: 'result',
      input: groupJoin('inner'),
      fields: { label: field('g', 'label') }
    };
    const initial: QueryMaintenanceSnapshot = { relations: [left, firstRight] };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    expect(session.getCurrentResult().rows).toEqual([{ label: 'first' }, { label: 'second' }]);

    const updatedRight = { ...firstRight, rows: [{ id: 'x', label: 'updated' }, firstRight.rows[1] as QueryRecord], basis: 2 };
    const updated: QueryMaintenanceSnapshot = { relations: [left, updatedRight] };
    expect(semanticResult(applySnapshot(session, initial, updated))).toEqual(oracle(query, updated));

    const reorderedRight = {
      ...updatedRight,
      rows: [updatedRight.rows[1] as QueryRecord, updatedRight.rows[0] as QueryRecord],
      occurrenceIds: [updatedRight.occurrenceIds?.[1] as string, updatedRight.occurrenceIds?.[0] as string],
      basis: 3
    };
    const reordered: QueryMaintenanceSnapshot = { relations: [left, reorderedRight] };
    const result = applySnapshot(session, updated, reordered);
    expect(result.rows).toEqual([{ label: 'second' }, { label: 'updated' }]);
    expect(semanticResult(result)).toEqual(oracle(query, reordered));
  });

  it('incrementally maintains singleton-tuple reference joins in either operand order', () => {
    const pizzas = relation('pizzas', [
      { occurrenceId: 'pizza:one', row: { name: 'Margherita', base: ['thin'] } },
      { occurrenceId: 'pizza:two', row: { name: 'Deep dish', base: ['deep'] } }
    ], 1);
    const bases = relation('bases', [
      { occurrenceId: 'base:thin', row: { name: 'thin', style: 'crisp' } },
      { occurrenceId: 'base:deep', row: { name: 'deep', style: 'soft' } }
    ], 1);
    const updatedBases = { ...bases, rows: [{ name: 'thin', style: 'cracker' }, bases.rows[1] as QueryRecord], basis: 2 };
    const initial: QueryMaintenanceSnapshot = { relations: [pizzas, bases] };
    const next: QueryMaintenanceSnapshot = { relations: [pizzas, updatedBases] };
    const reference = field('pizza', 'base');
    const keyTuple = { kind: 'array', items: [field('base', 'name')] } as const;
    const query = (reversed: boolean): QueryNode => ({
      kind: 'select', alias: 'result',
      input: {
        kind: 'join', join: 'inner', left: from('pizzas', 'pizza'), right: from('bases', 'base'),
        on: { kind: 'compare', op: 'eq', left: reversed ? keyTuple : reference, right: reversed ? reference : keyTuple }
      },
      fields: { pizza: field('pizza', 'name'), style: field('base', 'style') }
    });

    for (const reversed of [false, true]) {
      const root = query(reversed);
      const session = openIncrementalQueryMaintenance(plan(root), initial);
      const result = applySnapshot(session, initial, next);
      expect(result.rows).toEqual([{ pizza: 'Margherita', style: 'cracker' }, { pizza: 'Deep dish', style: 'soft' }]);
      expect(semanticResult(result)).toEqual(oracle(root, next));
      expect(result.state).toMatchObject({ updatedNodeCount: 3, changedNodeCount: 3 });
      session.close();
    }
  });

  it('reuses one local overlay across multiple changed rows without cross-row leakage', () => {
    const query: QueryNode = { kind: 'select', input: from('people', 'p'), alias: 'result', fields: { id: field('p', 'id'), name: field('p', 'name') } };
    const initial = snapshot(basePeople, 1);
    const changedRows: readonly QueryRowOccurrence[] = basePeople.map(({ occurrenceId, row }, index) => ({
      occurrenceId,
      row: { ...row, name: index === 0 ? 'Ada changed' : 'Bob changed' }
    }));
    const next = snapshot(changedRows, 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);

    const result = applySnapshot(session, initial, next);

    expect(result.rows).toEqual([{ id: 1, name: 'Ada changed' }, { id: 2, name: 'Bob changed' }]);
    expect(semanticResult(result)).toEqual(oracle(query, next));
    session.close();
  });

  it('rolls back a private session after a later branch throws and accepts a retry from the prior snapshot', () => {
    const callable = { id: 'urn:test:private-rollback', version: '1', contractHash: `sha256:${'9'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => args[0] === 2 ? cyclic as unknown as JsonValue : args[0] ?? null]]);
    const branch = (relationId: string, alias: string, transform: boolean): QueryNode => ({
      kind: 'select', input: from(relationId, alias), alias: 'result', fields: {
        source: { kind: 'literal', value: relationId },
        value: transform ? { kind: 'call', capability: callable, args: [field(alias, 'value')] } : field(alias, 'value')
      }
    });
    const query: QueryNode = { kind: 'set', op: 'union-all', left: branch('alpha', 'a', false), right: branch('beta', 'b', true) };
    const input = (alpha: number, beta: number): QueryMaintenanceSnapshot => ({
      relations: [
        relation('alpha', [{ occurrenceId: 'alpha:one', row: { value: alpha } }], alpha),
        relation('beta', [{ occurrenceId: 'beta:one', row: { value: beta } }], beta)
      ],
      functions
    });
    const initial = input(1, 1);
    const failing = input(2, 2);
    const recovered = input(1, 3);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();

    expect(() => session.applyUpdate(diffQueryMaintenanceSnapshots(initial, failing))).toThrow();
    expect(session.getCurrentResult()).toBe(before);
    expect(session.getCurrentResult().state).toMatchObject({ revision: 0, rejectedUpdateCount: 0 });

    const result = session.applyUpdate(diffQueryMaintenanceSnapshots(initial, recovered));
    expect(result.rows).toEqual([{ source: 'alpha', value: 1 }, { source: 'beta', value: 3 }]);
    expect(semanticResult(result)).toEqual(oracle(query, recovered));
    expect(result.state).toMatchObject({ revision: 1, rejectedUpdateCount: 0 });
    session.close();
  });

  it('rejects recursive private updates and defers closure until the active update finishes', () => {
    const callable = { id: 'urn:test:private-reentrant', version: '1', contractHash: `sha256:${'8'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    let session: ReturnType<typeof openIncrementalQueryMaintenance>;
    let action: 'none' | 'reenter' | 'close' = 'none';
    let recursiveError: unknown;
    let initial: QueryMaintenanceSnapshot;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      const currentAction = action;
      action = 'none';
      if (currentAction === 'reenter') {
        try { session.applyUpdate(diffQueryMaintenanceSnapshots(initial, initial)); } catch (error) { recursiveError = error; }
      }
      if (currentAction === 'close') session.close();
      return args[0] ?? null;
    }]]);
    const query: QueryNode = {
      kind: 'select', input: people, alias: 'result',
      fields: { name: { kind: 'call', capability: callable, args: [field('p', 'name')] } }
    };
    initial = { ...snapshot(basePeople, 1), functions };
    const middle = { ...snapshot(middlePeople, 2), functions };
    const final = { ...snapshot(finalPeople, 3), functions };
    session = openIncrementalQueryMaintenance(plan(query), initial);

    action = 'reenter';
    const middleResult = session.applyUpdate(diffQueryMaintenanceSnapshots(initial, middle));
    expect(recursiveError).toMatchObject({ message: 'Recursive incremental query updates are not supported' });
    expect(semanticResult(middleResult)).toEqual(oracle(query, middle));

    action = 'close';
    const finalResult = session.applyUpdate(diffQueryMaintenanceSnapshots(middle, final));
    expect(semanticResult(finalResult)).toEqual(oracle(query, final));
    expect(session.getCurrentResult()).toBe(finalResult);
    expect(() => session.applyUpdate(diffQueryMaintenanceSnapshots(final, final))).toThrow('Incremental query maintenance session is closed');
    session.close();
  });

  it('does not recompute a graph whose relation dependencies did not change', () => {
    const initial = snapshot(basePeople, 1);
    const unrelated = relation('unrelated', [{ occurrenceId: 'unrelated:1', row: { id: 1 } }], 1);
    const first = { ...initial, relations: [...initial.relations, unrelated] };
    const second = { ...first, relations: [...initial.relations, relation('unrelated', [{ occurrenceId: 'unrelated:1', row: { id: 2 } }], 2)] };
    const session = openIncrementalQueryMaintenance(plan(operatorQueries.where as QueryNode), first);
    const result = applySnapshot(session, first, second);
    expect(result.state).toMatchObject({ changedRelationIds: ['unrelated'], updatedNodeCount: 0 });
    expect(semanticResult(result)).toEqual(oracle(operatorQueries.where as QueryNode, second));
  });

  it('does not recompute non-seek operators for basis evidence alone', () => {
    const initial = snapshot(basePeople, 1);
    const next = { ...initial, basis: { dataset: 'new-evidence' } };
    const session = openIncrementalQueryMaintenance(plan(operatorQueries.where as QueryNode), initial);
    const result = applySnapshot(session, initial, next);
    expect(result.state).toMatchObject({ updatedNodeCount: 0, changedNodeCount: 0 });
    expect(semanticResult(result)).toEqual(oracle(operatorQueries.where as QueryNode, next));
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
    const next = { ...snapshot(changedFilteredOutRow, 2), basis: { dataset: 'changed-source-basis' } };
    const session = openIncrementalQueryMaintenance(plan(filtered), initial);
    const result = applySnapshot(session, initial, next);
    expect(result.state).toMatchObject({ materializedNodeCount: 3, updatedNodeCount: 2, changedNodeCount: 1, resultDelta: { addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] } });
    expect(semanticResult(result)).toEqual(oracle(filtered, next));
  });

  it('rejects updates after close', () => {
    const initial = snapshot(basePeople, 1);
    const session = openIncrementalQueryMaintenance(plan(people), initial);
    session.close();
    session.close();
    expect(() => session.applyUpdate(diffQueryMaintenanceSnapshots(initial, initial))).toThrow('Incremental query maintenance session is closed');
  });

  it('shares exact physical prefixes across independently authored roots and collects them by reference', () => {
    const activePeople = (): QueryNode => ({
      kind: 'where',
      input: from('people', 'p'),
      predicate: { kind: 'compare', op: 'eq', left: field('p', 'active'), right: { kind: 'literal', value: true } }
    });
    const idQuery: QueryNode = { kind: 'select', input: activePeople(), alias: 'ids', fields: { id: field('p', 'id') } };
    const nameQuery: QueryNode = { kind: 'select', input: activePeople(), alias: 'names', fields: { name: field('p', 'name') } };
    const initial = snapshot(basePeople, 1);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/dataset:test/parameters:minimum-6',
        registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test',
        datasetId: 'dataset:test',
        parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });

    const idsRoot = runtime.attach(plan(idQuery));
    const namesRoot = runtime.attach(plan(nameQuery));
    expect(semanticResult(idsRoot.getCurrentResult())).toEqual(oracle(idQuery, initial));
    expect(semanticResult(namesRoot.getCurrentResult())).toEqual(oracle(nameQuery, initial));
    expect(runtime.getDiagnostics()).toMatchObject({
      strategy: 'pooled-differential-operator-dag',
      activeRootCount: 2,
      physicalNodeCount: 4,
      sharedPhysicalNodeCount: 2
    });
    expect(Object.isFrozen(runtime.getDiagnostics())).toBe(true);

    const next = snapshot(middlePeople, 2);
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));
    expect(semanticResult(idsRoot.getCurrentResult())).toEqual(oracle(idQuery, next));
    expect(semanticResult(namesRoot.getCurrentResult())).toEqual(oracle(nameQuery, next));
    expect(idsRoot.getCurrentResult().state).toMatchObject({ materializedNodeCount: 3, updatedNodeCount: 3 });
    expect(namesRoot.getCurrentResult().state).toMatchObject({ materializedNodeCount: 3, updatedNodeCount: 3 });
    expect(runtime.getDiagnostics()).toMatchObject({
      revision: 1,
      lastUpdatedPhysicalNodeCount: 4,
      lastChangedPhysicalNodeCount: 4
    });

    idsRoot.close();
    idsRoot.close();
    expect(runtime.getDiagnostics()).toMatchObject({
      activeRootCount: 1,
      physicalNodeCount: 3,
      sharedPhysicalNodeCount: 0,
      lastCollectedPhysicalNodeCount: 1
    });
    namesRoot.close();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0, lastCollectedPhysicalNodeCount: 3 });
    runtime.close();
  });

  it('visits only roots owned by the changed relation while every root advances revision', () => {
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    const peopleQuery: QueryNode = { kind: 'select', input: from('people', 'p'), alias: 'result', fields: { id: field('p', 'id') } };
    const groupsQuery: QueryNode = { kind: 'select', input: from('groups', 'g'), alias: 'result', fields: { id: field('g', 'id') } };
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/selective-worklist', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const peopleRoot = runtime.attach(plan(peopleQuery));
    const groupsRoot = runtime.attach(plan(groupsQuery));

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(peopleRoot.getCurrentResult().state).toMatchObject({ revision: 1, updatedNodeCount: 2, changedNodeCount: 2 });
    expect(groupsRoot.getCurrentResult().state).toMatchObject({ revision: 1, updatedNodeCount: 0, changedNodeCount: 0 });
    expect(semanticResult(groupsRoot.getCurrentResult())).toEqual(oracle(groupsQuery, next));
    expect(runtime.getDiagnostics()).toMatchObject({ lastUpdatedPhysicalNodeCount: 2, lastChangedPhysicalNodeCount: 2 });
    peopleRoot.close();
    groupsRoot.close();
    runtime.close();
  });

  it('removes dependency consumers when an unrelated root closes', () => {
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/closed-consumer', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const removed = runtime.attach(plan({ kind: 'select', input: from('people', 'p'), alias: 'result', fields: { id: field('p', 'id') } }));
    const remaining = runtime.attach(plan({ kind: 'select', input: from('groups', 'g'), alias: 'result', fields: { id: field('g', 'id') } }));
    removed.close();

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(remaining.getCurrentResult().state).toMatchObject({ revision: 1, updatedNodeCount: 0, changedNodeCount: 0 });
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 1, physicalNodeCount: 2, lastUpdatedPhysicalNodeCount: 0 });
    remaining.close();
    runtime.close();
  });

  it('evaluates a diamond parent once after both changed branches in topological order', () => {
    const sharedInput = (): QueryNode => from('people', 'p');
    const query: QueryNode = {
      kind: 'set', op: 'union-all',
      left: {
        kind: 'where', input: sharedInput(),
        predicate: { kind: 'compare', op: 'gte', left: field('p', 'id'), right: { kind: 'literal', value: 1 } }
      },
      right: {
        kind: 'where', input: sharedInput(),
        predicate: { kind: 'compare', op: 'lte', left: field('p', 'id'), right: { kind: 'literal', value: 3 } }
      }
    };
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/diamond-worklist', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(query));
    expect(runtime.getDiagnostics()).toMatchObject({ physicalNodeCount: 4 });

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, next));
    expect(root.getCurrentResult().state).toMatchObject({ updatedNodeCount: 4, changedNodeCount: 4 });
    expect(runtime.getDiagnostics()).toMatchObject({ lastUpdatedPhysicalNodeCount: 4, lastChangedPhysicalNodeCount: 4 });
    root.close();
    runtime.close();
  });

  it('stops pooled parent propagation when a changed input is filtered out', () => {
    const query: QueryNode = {
      kind: 'select', alias: 'result',
      input: {
        kind: 'where', input: from('people', 'p'),
        predicate: { kind: 'compare', op: 'gte', left: field('p', 'id'), right: { kind: 'literal', value: 2 } }
      },
      fields: { id: field('p', 'id') }
    };
    const initial = snapshot(basePeople, 1);
    const changedFilteredOutRow: readonly QueryRowOccurrence[] = [
      { occurrenceId: 'person:a', row: { ...basePeople[0]!.row, name: 'not visible' } },
      basePeople[1] as QueryRowOccurrence
    ];
    const next = snapshot(changedFilteredOutRow, 2);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/pooled-propagation-stop', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(query));

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, next));
    expect(root.getCurrentResult().state).toMatchObject({ updatedNodeCount: 2, changedNodeCount: 1 });
    expect(runtime.getDiagnostics()).toMatchObject({ lastUpdatedPhysicalNodeCount: 2, lastChangedPhysicalNodeCount: 1 });
    root.close();
    runtime.close();
  });

  it('maintains shared-node diagnostics through arbitrary reference transitions', () => {
    const query = (): QueryNode => ({
      kind: 'where', input: from('people', 'p'),
      predicate: { kind: 'compare', op: 'gte', left: field('p', 'id'), right: { kind: 'literal', value: 1 } }
    });
    const initial = snapshot(basePeople, 1);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/reference-transitions', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const roots = Array.from({ length: 4 }, () => runtime.attach(plan(query())));
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 4, physicalNodeCount: 2, sharedPhysicalNodeCount: 2 });

    roots[2]?.close();
    roots[0]?.close();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 2, physicalNodeCount: 2, sharedPhysicalNodeCount: 2 });
    roots[3]?.close();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 1, physicalNodeCount: 2, sharedPhysicalNodeCount: 0 });
    roots[1]?.close();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0, sharedPhysicalNodeCount: 0 });
    runtime.close();
  });

  it('updates correctly after thousands of unique-suffix collections and order compactions', () => {
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    const prefix = (): QueryNode => ({
      kind: 'where', input: from('people', 'p'),
      predicate: { kind: 'compare', op: 'gte', left: field('p', 'id'), right: { kind: 'literal', value: 1 } }
    });
    const suffix = (marker: number): QueryNode => ({
      kind: 'select', input: prefix(), alias: 'result',
      fields: { id: field('p', 'id'), marker: { kind: 'literal', value: marker } }
    });
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/order-compaction', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const residentQueries = Array.from({ length: 8 }, (_, index) => suffix(index));
    const residents = residentQueries.map((query, index) => runtime.attach({ ...plan(query), planId: 'resident:' + index, rootNodeId: 'resident:' + index + ':root' }));

    for (let index = 0; index < 2_500; index += 1) {
      const query = suffix(10_000 + index);
      const root = runtime.attach({ ...plan(query), planId: 'churn:' + index, rootNodeId: 'churn:' + index + ':root' });
      root.close();
    }
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 8, physicalNodeCount: 10, sharedPhysicalNodeCount: 2 });

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));
    residentQueries.forEach((query, index) => {
      expect(semanticResult(residents[index]!.getCurrentResult()), 'resident ' + index).toEqual(oracle(query, next));
    });
    for (const index of [3, 0, 7, 2, 5, 1, 6, 4]) residents[index]?.close();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0, sharedPhysicalNodeCount: 0 });
    runtime.close();
  });

  it('shares a join prefix across projection and aggregate roots through insert, update, and delete', () => {
    const joinedPeople = (): QueryNode => ({
      kind: 'join',
      join: 'inner',
      left: from('people', 'p'),
      right: from('groups', 'g'),
      on: { kind: 'compare', op: 'eq', left: field('p', 'group'), right: field('g', 'id') }
    });
    const projected: QueryNode = {
      kind: 'select', input: joinedPeople(), alias: 'result',
      fields: { name: field('p', 'name'), group: field('g', 'label') }
    };
    const summarized: QueryNode = {
      kind: 'aggregate', input: joinedPeople(), alias: 'summary', groupBy: {},
      measures: {
        count: { kind: 'aggregate', op: 'count' },
        averageScore: { kind: 'aggregate', op: 'average', value: field('p', 'score') }
      }
    };
    const initial = snapshot(basePeople, 1);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/shared-join', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const projectionRoot = runtime.attach(plan(projected));
    const summaryRoot = runtime.attach(plan(summarized));
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 2, physicalNodeCount: 5, sharedPhysicalNodeCount: 3 });

    let before = initial;
    for (const after of [snapshot(middlePeople, 2), snapshot(finalPeople, 3)]) {
      runtime.applyUpdate(diffQueryMaintenanceSnapshots(before, after));
      expect(semanticResult(projectionRoot.getCurrentResult())).toEqual(oracle(projected, after));
      expect(semanticResult(summaryRoot.getCurrentResult())).toEqual(oracle(summarized, after));
      // The unchanged groups branch is retained; people, join, projection, and
      // aggregate update once each across both roots.
      expect(runtime.getDiagnostics()).toMatchObject({ lastUpdatedPhysicalNodeCount: 4 });
      before = after;
    }

    projectionRoot.close();
    summaryRoot.close();
    runtime.close();
  });

  it('detaches and freezes canonical query payloads from caller mutation', () => {
    const row = { value: 'before', nested: { label: 'before' } };
    const query = { kind: 'values', alias: 'constant', rows: [row] } as QueryNode;
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/frozen-query', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: snapshot(basePeople, 1)
    });
    const root = runtime.attach(plan(query));
    row.value = 'after';
    row.nested.label = 'after';
    (query as { alias: string }).alias = 'mutated';

    expect(root.getCurrentResult().rows).toEqual([{ value: 'before', nested: { label: 'before' } }]);
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(snapshot(basePeople, 1), snapshot(basePeople, 1)));
    expect(root.getCurrentResult().rows).toEqual([{ value: 'before', nested: { label: 'before' } }]);
    root.close();
    runtime.close();
  });

  it('treats kind-like literal and values JSON as opaque poolable data', () => {
    const query: QueryNode = {
      kind: 'values', alias: 'data',
      rows: [{ kind: 'subquery', nested: { kind: 'recursive' }, literal: { kind: 'seek' } }]
    };
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/opaque-values', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: snapshot(basePeople, 1)
    });
    const root = runtime.attach(plan(query));
    expect(root.getCurrentResult()).toMatchObject({ completeness: 'exact', rows: query.rows });
    root.close();
    runtime.close();
  });

  it('rolls back interning and staged materialization when attachment fails unexpectedly', () => {
    const throwingRow: Record<string, import('../src/query.js').QueryLogicalValue> = { id: 1 };
    Object.defineProperty(throwingRow, 'name', { configurable: true, enumerable: true, get: () => { throw new Error('row getter failed'); } });
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', [{ occurrenceId: 'person:throwing', row: throwingRow }], 1)] };
    const query: QueryNode = { kind: 'select', input: from('people', 'p'), alias: 'result', fields: { name: field('p', 'name') } };
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/rollback', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test'
      },
      initialSnapshot: initial
    });

    expect(() => runtime.attach(plan(query))).toThrow('row getter failed');
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0 });
    Object.defineProperty(throwingRow, 'name', { configurable: true, enumerable: true, value: 'recovered' });
    const root = runtime.attach(plan(query));
    expect(root.getCurrentResult()).toMatchObject({ completeness: 'exact', rows: [{ name: 'recovered' }] });
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 1, physicalNodeCount: 2 });
    root.close();
    runtime.close();
  });

  it('interns deep cloned pipelines exactly without retaining full-subtree keys', () => {
    const pipeline = (): QueryNode => {
      let query = from('people', 'p');
      for (let index = 0; index < 256; index += 1) query = { kind: 'where', input: query, predicate: { kind: 'literal', value: true } };
      return query;
    };
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/deep-pipeline', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: snapshot(basePeople, 1)
    });
    const first = runtime.attach(plan(pipeline()));
    const second = runtime.attach(plan(pipeline()));
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 2, physicalNodeCount: 257, sharedPhysicalNodeCount: 257 });
    first.close();
    second.close();
    runtime.close();
  });

  it('conservatively excludes stateful and nested query graph forms from pooling', () => {
    const initial = snapshot(basePeople, 1);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/exclusions',
        registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test',
        datasetId: 'dataset:test',
        parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    let excluded: unknown;
    try { runtime.attach(plan(operatorQueries.seek as QueryNode)); } catch (error) { excluded = error; }
    expect(isNonPoolableQueryError(excluded)).toBe(true);
    expect(excluded).toMatchObject({ code: 'query.pool.nonpoolable' });
    expect(() => runtime.attach(plan(operatorQueries.subquery as QueryNode))).toThrow(/do not support subquery/);
    expect(() => runtime.attach(plan(operatorQueries.recursive as QueryNode))).toThrow(/do not support recursive/);
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0 });
    runtime.close();
  });

  it('materializes roots attached while rejected and recovers every root on an exact no-op transition', () => {
    const initial = snapshot(basePeople, 1);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/recovery', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const filteredQuery = operatorQueries.where as QueryNode;
    const filtered = runtime.attach(plan(filteredQuery));
    const valid = diffQueryMaintenanceSnapshots(initial, snapshot(middlePeople, 2));
    const peopleChange = valid.relations.find(({ relation }) => relation.relationId === 'people') as NonNullable<typeof valid.relations[number]>;
    runtime.applyUpdate({
      ...valid,
      relations: [{ ...peopleChange, rows: [{ occurrenceId: 'person:missing', after: { index: 0, row: { id: 9 } } }] }]
    });
    expect(filtered.getCurrentResult()).toMatchObject({ completeness: 'unknown', state: { rejectedUpdateCount: 1 } });

    const constantQuery: QueryNode = { kind: 'values', alias: 'constant', rows: [{ value: 'available-after-recovery' }] };
    const constant = runtime.attach(plan(constantQuery));
    expect(constant.getCurrentResult()).toMatchObject({ completeness: 'unknown', state: { rejectedUpdateCount: 1 } });
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, initial));

    expect(semanticResult(filtered.getCurrentResult())).toEqual(oracle(filteredQuery, initial));
    expect(semanticResult(constant.getCurrentResult())).toEqual(oracle(constantQuery, initial));
    expect(runtime.getDiagnostics()).toMatchObject({
      revision: 2,
      rejectedUpdateCount: 1,
      lastUpdatedPhysicalNodeCount: 1,
      lastChangedPhysicalNodeCount: 1
    });
    filtered.close();
    constant.close();
    runtime.close();
  });

  it('rolls back an update when materialization throws unexpectedly', () => {
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/update-materialization-rollback', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const query = operatorQueries.where as QueryNode;
    const root = runtime.attach(plan(query));
    const beforeResult = root.getCurrentResult();
    const beforeDiagnostics = runtime.getDiagnostics();
    const validUpdate = diffQueryMaintenanceSnapshots(initial, next);
    const peopleChange = validUpdate.relations.find(({ relation }) => relation.relationId === 'people') as NonNullable<typeof validUpdate.relations[number]>;
    const throwingRow: Record<string, unknown> = { id: 2, name: 'Bob', group: 'y', active: true, tags: ['reader'] };
    Object.defineProperty(throwingRow, 'score', { enumerable: true, get: () => { throw new Error('materialization getter failed'); } });
    const failingUpdate = {
      ...validUpdate,
      relations: validUpdate.relations.map((change) => change !== peopleChange ? change : {
        ...change,
        rows: change.rows.map((row) => row.occurrenceId !== 'person:b' || row.after === undefined
          ? row
          : { ...row, after: { ...row.after, row: throwingRow as QueryRecord } })
      })
    };

    expect(() => runtime.applyUpdate(failingUpdate)).toThrow('materialization getter failed');
    expect(root.getCurrentResult()).toBe(beforeResult);
    expect(runtime.getDiagnostics()).toBe(beforeDiagnostics);

    runtime.applyUpdate(validUpdate);
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, next));
    expect(runtime.getDiagnostics()).toMatchObject({ revision: 1, rejectedUpdateCount: 0 });
    root.close();
    runtime.close();
  });

  it('rolls back accepted state and root assertions when result-delta calculation throws', () => {
    let throwOnRead = false;
    let victim: ReturnType<ReturnType<typeof createPooledIncrementalQueryRuntime>['attach']> | undefined;
    const guardedRow: QueryRecord = { id: 1 };
    Object.defineProperty(guardedRow, 'value', {
      enumerable: true,
      get: () => {
        if (throwOnRead) {
          victim?.close();
          throw new Error('delta getter failed');
        }
        return 'one';
      }
    });
    const initialPeople: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:guarded', row: guardedRow }];
    const nextPeople: readonly QueryRowOccurrence[] = [
      initialPeople[0] as QueryRowOccurrence,
      { occurrenceId: 'person:second', row: { id: 2, value: 'two' } }
    ];
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', initialPeople, 1)] };
    const next: QueryMaintenanceSnapshot = { relations: [relation('people', nextPeople, 2)] };
    const update = diffQueryMaintenanceSnapshots(initial, next);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/update-delta-rollback', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test'
      },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(people));
    victim = runtime.attach(plan({ kind: 'values', alias: 'victim', rows: [{ value: 'close-after-rollback' }] }));
    const beforeResult = root.getCurrentResult();
    const beforeRevision = runtime.getDiagnostics().revision;

    throwOnRead = true;
    expect(() => runtime.applyUpdate(update)).toThrow('delta getter failed');
    throwOnRead = false;
    expect(root.getCurrentResult()).toBe(beforeResult);
    expect(runtime.getDiagnostics()).toMatchObject({ revision: beforeRevision, activeRootCount: 1, rejectedUpdateCount: 0 });

    runtime.applyUpdate(update);
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(people, next));
    expect(runtime.getDiagnostics()).toMatchObject({ revision: beforeRevision + 1, activeRootCount: 1 });
    root.close();
    runtime.close();
  });

  it('defers root closure during updates and rejects recursive updates and attachment', () => {
    const callable = { id: 'urn:test:pooled-reentrant', version: '1', contractHash: `sha256:${'f'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    const initial = snapshot(basePeople, 1);
    const middle = snapshot(middlePeople, 2);
    const final = snapshot(finalPeople, 3);
    let runtime: ReturnType<typeof createPooledIncrementalQueryRuntime>;
    let victim: ReturnType<typeof runtime.attach> | undefined;
    let active: ReturnType<typeof runtime.attach> | undefined;
    let action: 'none' | 'close-victim' | 'close-self' | 'reenter' = 'none';
    let recursiveError: unknown;
    let attachError: unknown;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      const currentAction = action;
      action = 'none';
      if (currentAction === 'close-victim') victim?.close();
      if (currentAction === 'close-self') active?.close();
      if (currentAction === 'reenter') {
        try { runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, initial)); } catch (error) { recursiveError = error; }
        try { runtime.attach(plan({ kind: 'values', alias: 'late', rows: [{ value: 1 }] })); } catch (error) { attachError = error; }
      }
      return args[0] ?? null;
    }]]);
    const query: QueryNode = {
      kind: 'select', input: people, alias: 'result',
      fields: { value: { kind: 'call', capability: callable, args: [field('p', 'name')] } }
    };
    runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/reentrant', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }, functions
      },
      initialSnapshot: { ...initial, functions }
    });
    victim = runtime.attach(plan({ kind: 'values', alias: 'victim', rows: [{ value: 'kept-until-update-finishes' }] }));
    active = runtime.attach(plan(query));

    action = 'close-victim';
    expect(() => runtime.applyUpdate(diffQueryMaintenanceSnapshots({ ...initial, functions }, { ...middle, functions }))).not.toThrow();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 1 });
    expect(active.getCurrentResult()).toMatchObject({ completeness: 'exact' });

    action = 'reenter';
    expect(() => runtime.applyUpdate(diffQueryMaintenanceSnapshots({ ...middle, functions }, { ...final, functions }))).not.toThrow();
    expect(recursiveError).toMatchObject({ message: 'Recursive pooled query updates are not supported' });
    expect(attachError).toMatchObject({ message: 'Cannot attach a pooled query root during an update' });
    expect(isPooledQueryRuntimeBusyError(attachError)).toBe(true);

    action = 'close-self';
    expect(() => runtime.applyUpdate(diffQueryMaintenanceSnapshots({ ...final, functions }, { ...middle, functions }))).not.toThrow();
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0 });
    runtime.close();
  });

  it('defers closure and rejects graph reentrancy while attaching a root', () => {
    const callable = { id: 'urn:test:pooled-attach-reentrant', version: '1', contractHash: `sha256:${'e'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    let runtime: ReturnType<typeof createPooledIncrementalQueryRuntime>;
    let victim: ReturnType<typeof runtime.attach>;
    let updateError: unknown;
    let attachError: unknown;
    let reentered = false;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      if (!reentered) {
        reentered = true;
        victim.close();
        try { runtime.applyUpdate(diffQueryMaintenanceSnapshots({ ...initial, functions }, { ...next, functions })); } catch (error) { updateError = error; }
        try { runtime.attach(plan({ kind: 'values', alias: 'nested', rows: [{ value: 1 }] })); } catch (error) { attachError = error; }
      }
      return args[0] ?? null;
    }]]);
    runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/attach-reentrant', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }, functions
      },
      initialSnapshot: { ...initial, functions }
    });
    victim = runtime.attach(plan(people));
    const attached = runtime.attach(plan({
      kind: 'select', input: people, alias: 'result',
      fields: { value: { kind: 'call', capability: callable, args: [field('p', 'name')] } }
    }));

    expect(updateError).toMatchObject({ message: 'Cannot update a pooled query runtime during root attachment' });
    expect(attachError).toMatchObject({ message: 'Cannot attach a pooled query root during another attachment' });
    expect(isPooledQueryRuntimeBusyError(attachError)).toBe(true);
    expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 1, physicalNodeCount: 2 });
    expect(attached.getCurrentResult()).toMatchObject({ completeness: 'exact' });
    expect(() => runtime.applyUpdate(diffQueryMaintenanceSnapshots({ ...initial, functions }, { ...next, functions }))).not.toThrow();
    expect(attached.getCurrentResult()).toMatchObject({ completeness: 'exact', state: { revision: 1 } });
    attached.close();
    runtime.close();
  });
});
