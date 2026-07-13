import { describe, expect, it } from 'vitest';
import {
  createPooledIncrementalQueryRuntime,
  diffQueryMaintenanceSnapshots,
  evaluatePreparedQuery,
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
import { sealPreparedPlan } from '../src/internal-prepared-plan.js';
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

const plan = (query: QueryNode): PreparedPlan<QueryNode> => sealPreparedPlan({
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
  it('keeps semantic budget boundaries identical across pure, prepared, private, and pooled initial materialization', () => {
    const queries: readonly QueryNode[] = [
      {
        kind: 'join', join: 'inner', left: people, right: groupRows,
        on: { kind: 'compare', op: 'eq', left: field('p', 'group'), right: field('g', 'id') }
      },
      {
        kind: 'window', input: people, alias: 'p', fields: {
          rank: { kind: 'window', op: 'rank', partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'score'), direction: 'asc' }] }
        }
      },
      {
        kind: 'aggregate', input: people, alias: 'summary', groupBy: { group: field('p', 'group') },
        measures: {
          count: { kind: 'aggregate', op: 'count' },
          distinct: { kind: 'aggregate', op: 'count-distinct', value: field('p', 'score') },
          any: { kind: 'aggregate', op: 'any', value: field('p', 'active') }
        }
      }
    ];
    for (const [index, query] of queries.entries()) {
      const relations = snapshot(basePeople, 1).relations;
      const budget = Array.from({ length: 200 }, (_, offset) => offset + 1).find((maxWorkUnits) =>
        evaluateQuery({ root: query, relations, executionBudget: { maxWorkUnits } }).completeness === 'exact');
      expect(budget).toBeDefined();
      const executionBudget = { maxWorkUnits: budget as number };
      const prepared = plan(query);
      const pure = evaluateQuery({ root: query, relations, executionBudget });
      expect(evaluatePreparedQuery(prepared, { relations, executionBudget })).toEqual(pure);

      const initial: QueryMaintenanceSnapshot = { relations, executionBudget };
      const session = openIncrementalQueryMaintenance(prepared, initial);
      expect(semanticResult(session.getCurrentResult())).toEqual(pure);
      session.close();

      const runtime = createPooledIncrementalQueryRuntime({
        environment: { runtimeIdentity: `budget:decorator:${index}`, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test', executionBudget },
        initialSnapshot: initial
      });
      const root = runtime.attach(prepared);
      expect(semanticResult(root.getCurrentResult())).toEqual(pure);
      root.close();
      runtime.close();
    }
  });

  it('fails closed and recovers atomically when a fixed update budget is exceeded', () => {
    const query: QueryNode = {
      kind: 'join', join: 'inner', left: from('left', 'left'), right: from('right', 'right'),
      on: { kind: 'compare', op: 'eq', left: field('left', 'id'), right: field('right', 'id') }
    };
    const relationRows = (relationId: string, count: number, basis: number) => relation(relationId, Array.from({ length: count }, (_, index) => ({ occurrenceId: `${relationId}:${index}`, row: { id: index } })), basis);
    const initial: QueryMaintenanceSnapshot = { relations: [relationRows('left', 1, 1), relationRows('right', 1, 1)], executionBudget: { maxWorkUnits: 20 } };
    const expanded: QueryMaintenanceSnapshot = { relations: [relationRows('left', 1, 2), relationRows('right', 30, 2)], executionBudget: { maxWorkUnits: 20 } };
    const session = openIncrementalQueryMaintenance(plan(query), initial);

    const exhausted = applySnapshot(session, initial, expanded);
    expect(exhausted).toMatchObject({ rows: [], resultKeys: [], completeness: 'unknown', issues: [{ code: 'query.execution_budget_exceeded' }] });
    expect(exhausted.state.operatorDiagnostics.join).toMatchObject({ fallbackNodeCount: 1, fallbackReasons: { input_unavailable: 1 } });
    const recovered = applySnapshot(session, expanded, initial);
    expect(semanticResult(recovered)).toEqual(oracle(query, initial));
    expect(() => diffQueryMaintenanceSnapshots(initial, { ...initial, executionBudget: { maxWorkUnits: 21 } })).toThrow(/execution budget/);
    session.close();

    const runtime = createPooledIncrementalQueryRuntime({
      environment: { runtimeIdentity: 'budget:pooled', registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test', executionBudget: { maxWorkUnits: 20 } },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(query));
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, expanded));
    expect(root.getCurrentResult()).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.execution_budget_exceeded' }] });
    expect(runtime.getDiagnostics().operatorDiagnostics.join).toMatchObject({ fallbackNodeCount: 1, fallbackReasons: { input_unavailable: 1 } });
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(expanded, initial));
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, initial));
    root.close();
    runtime.close();
    expect(() => createPooledIncrementalQueryRuntime({
      environment: { runtimeIdentity: 'budget:mismatch', registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test', executionBudget: { maxWorkUnits: 21 } },
      initialSnapshot: initial
    })).toThrow(/execution budget/);
  });

  it('rejects structurally forged and spread-cloned plans at execution boundaries', () => {
    const legitimate = plan(people);
    const snapshot: QueryMaintenanceSnapshot = { relations: [] };

    expect(() => openIncrementalQueryMaintenance({ ...legitimate }, snapshot)).toThrow('not produced by a plan preparation API');
    expect(() => openIncrementalQueryMaintenance({
      planId: 'forged', rootNodeId: 'forged:root', query: people,
      registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test'
    } as unknown as PreparedPlan<QueryNode>, snapshot)).toThrow('not produced by a plan preparation API');
  });

  it('detaches the private-session query plan from later caller mutation', () => {
    const predicate = { kind: 'literal' as const, value: true };
    const query: QueryNode = { kind: 'where', input: from('owned-plan', 'row'), predicate };
    const initial: QueryMaintenanceSnapshot = { relations: [relation('owned-plan', [
      { occurrenceId: 'owned-plan:1', row: { id: 1 } }
    ], 1)] };
    const session = openIncrementalQueryMaintenance(plan(query), initial);

    predicate.value = false;

    expect(session.getCurrentResult().rows).toEqual([{ id: 1 }]);
    session.close();
  });

  it('detaches function registry membership while retaining implementation identity', () => {
    const capability = { id: 'urn:test:owned-registry', version: '1', contractHash: `sha256:${'e'.repeat(64)}` } as const;
    const key = capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;
    const original = (args: readonly JsonValue[]) => typeof args[0] === 'string' ? args[0] + '!' : 'unexpected';
    const functions = new Map([[key, original]]);
    const query: QueryNode = {
      kind: 'select', input: people, alias: 'result',
      fields: { value: { kind: 'call', capability, args: [field('p', 'name')] } }
    };
    const initial = { ...snapshot(basePeople, 1), functions };
    const next = { ...snapshot(middlePeople, 2), functions };
    const session = openIncrementalQueryMaintenance(plan(query), initial);

    functions.set(key, () => 'replaced');

    expect(session.getCurrentResult().rows).toEqual([{ value: 'Ada!' }, { value: 'Bob!' }]);
    expect(applySnapshot(session, initial, next).rows).toEqual([{ value: 'Ada!' }, { value: 'Bob!' }, { value: 'Cy!' }]);
    session.close();
  });

  it('owns private-session inputs, changed rows, and cached public row views', () => {
    const firstRow = { id: 1, nested: { label: 'one' } };
    const secondRow = { id: 2, nested: { label: 'two' } };
    const initial: QueryMaintenanceSnapshot = { relations: [relation('owned', [
      { occurrenceId: 'owned:1', row: firstRow }, { occurrenceId: 'owned:2', row: secondRow }
    ], 1)] };
    const changedSecond = { id: 2, nested: { label: 'changed' } };
    const next: QueryMaintenanceSnapshot = { relations: [relation('owned', [
      { occurrenceId: 'owned:1', row: firstRow }, { occurrenceId: 'owned:2', row: changedSecond }
    ], 2)] };
    const update = diffQueryMaintenanceSnapshots(initial, next);
    const session = openIncrementalQueryMaintenance(plan(from('owned', 'owned')), initial);
    const before = session.getCurrentResult();

    firstRow.nested.label = 'caller mutation';
    expect(before.rows[0]).toEqual({ id: 1, nested: { label: 'one' } });
    expect(Object.isFrozen(before.rows[0]?.nested)).toBe(true);
    const after = session.applyUpdate(update);
    changedSecond.nested.label = 'late mutation';
    expect(after.rows).toEqual([{ id: 1, nested: { label: 'one' } }, { id: 2, nested: { label: 'changed' } }]);
    expect(after.rows[0]).toBe(before.rows[0]);
    session.close();
  });

  it('retains unchanged public row identity through every one-to-one local operator', () => {
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    for (const name of ['select', 'with-fields', 'rename', 'omit'] as const) {
      const session = openIncrementalQueryMaintenance(plan(operatorQueries[name] as QueryNode), initial);
      const before = session.getCurrentResult();
      const after = applySnapshot(session, initial, next);

      expect(after.rows).not.toBe(before.rows);
      expect(after.rows[0], name).toBe(before.rows[0]);
      expect(after.rows[1], name).not.toBe(before.rows[1]);
      expect(semanticResult(after)).toEqual(oracle(operatorQueries[name] as QueryNode, next));
      session.close();
    }
  });

  it('incrementally preserves stable order ties across insert, update, delete, and group movement', () => {
    const orderQuery: QueryNode = {
      kind: 'order', input: people, by: [{ value: field('p', 'score'), direction: 'desc' }]
    };
    const aggregateQuery = operatorQueries.aggregate as QueryNode;
    const states: readonly QueryMaintenanceSnapshot[] = [
      snapshot(basePeople, 1),
      snapshot(middlePeople, 2),
      snapshot([
        { occurrenceId: 'person:d', row: { id: 4, name: 'Dee', score: 8, group: 'x', active: false, tags: [] } },
        ...(middlePeople as readonly QueryRowOccurrence[])
      ], 3),
      snapshot([
        { occurrenceId: 'person:d', row: { id: 4, name: 'Dee', score: 8, group: 'x', active: false, tags: [] } },
        { occurrenceId: 'person:b', row: { id: 2, name: 'Bob', score: 8, group: 'x', active: true, tags: ['reader'] } },
        { occurrenceId: 'person:c', row: { id: 3, name: 'Cy', score: 5, group: 'x', active: true, tags: [] } }
      ], 4),
      snapshot(finalPeople, 5)
    ];
    const orderSession = openIncrementalQueryMaintenance(plan(orderQuery), states[0] as QueryMaintenanceSnapshot);
    const aggregateSession = openIncrementalQueryMaintenance(plan(aggregateQuery), states[0] as QueryMaintenanceSnapshot);
    for (let index = 1; index < states.length; index += 1) {
      const before = states[index - 1] as QueryMaintenanceSnapshot;
      const after = states[index] as QueryMaintenanceSnapshot;
      expect(semanticResult(applySnapshot(orderSession, before, after)), `order transition ${index}`).toEqual(oracle(orderQuery, after));
      expect(semanticResult(applySnapshot(aggregateSession, before, after)), `aggregate transition ${index}`).toEqual(oracle(aggregateQuery, after));
    }
    orderSession.close();
    aggregateSession.close();
  });

  it('reuses aggregate output rows for groups whose membership is unchanged', () => {
    const query = operatorQueries.aggregate as QueryNode;
    const initial = snapshot(basePeople, 1);
    const next = snapshot([
      basePeople[0] as QueryRowOccurrence,
      { occurrenceId: 'person:b', row: { ...(basePeople[1] as QueryRowOccurrence).row, score: 9 } }
    ], 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();
    const after = applySnapshot(session, initial, next);

    expect(after.rows[0]).toBe(before.rows[0]);
    expect(after.rows[1]).not.toBe(before.rows[1]);
    expect(semanticResult(after)).toEqual(oracle(query, next));
    session.close();
  });

  it('incrementally maintains first-occurrence distinct representatives and compacts sparse keys', () => {
    const query: QueryNode = {
      kind: 'distinct',
      input: { kind: 'select', input: people, alias: 'value', fields: { value: field('p', 'score') } }
    };
    const rowsAt = (revision: number): readonly QueryRowOccurrence[] => [
      { occurrenceId: 'distinct:a', row: { id: 1, score: revision % 2 === 0 ? 2 : 1 } },
      { occurrenceId: 'distinct:b', row: { id: 2, score: 1 } },
      { occurrenceId: 'distinct:c', row: { id: 3, score: null } },
      { occurrenceId: 'distinct:d', row: { id: 4, score: logicalUnknown } },
      { occurrenceId: 'distinct:e', row: { id: 5, score: [1, { nested: true }] } }
    ];
    let accepted = snapshot(rowsAt(1), 1);
    const session = openIncrementalQueryMaintenance(plan(query), accepted);
    const initialRows = session.getCurrentResult().rows;
    let observedCompaction = false;
    for (let revision = 2; revision <= 70; revision += 1) {
      const next = snapshot(rowsAt(revision), revision);
      const maintained = applySnapshot(session, accepted, next);
      expect(semanticResult(maintained)).toEqual(oracle(query, next));
      expect(maintained.state.operatorDiagnostics.distinct.selectiveNodeCount).toBe(1);
      if (revision === 2) {
        expect(maintained.rows[2]).toBe(initialRows[1]);
        expect(maintained.rows[3]).toBe(initialRows[2]);
        expect(maintained.rows[4]).toBe(initialRows[3]);
      }
      observedCompaction ||= maintained.state.operatorDiagnostics.distinct.compactionCount > 0;
      accepted = next;
    }
    expect(observedCompaction).toBe(true);
    session.close();

    const runtime = createPooledIncrementalQueryRuntime({
      environment: { runtimeIdentity: 'distinct:pooled', registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 } },
      initialSnapshot: snapshot(rowsAt(1), 1)
    });
    const root = runtime.attach(plan(query));
    const next = snapshot(rowsAt(2), 2);
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(snapshot(rowsAt(1), 1), next));
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, next));
    expect(root.getCurrentResult().state.operatorDiagnostics.distinct.selectiveNodeCount).toBe(1);
    root.close();
    runtime.close();
  });

  it('maintains a sparse key substitution without disturbing high-cardinality distinct representatives', () => {
    const query: QueryNode = {
      kind: 'distinct',
      input: { kind: 'select', input: people, alias: 'value', fields: { value: field('p', 'score') } }
    };
    const rows = Array.from({ length: 10_000 }, (_, index): QueryRowOccurrence => ({
      occurrenceId: `distinct:unique:${index}`,
      row: { id: index, score: index }
    }));
    const initial = snapshot(rows, 1);
    const next = snapshot(rows.map((row, index) => index === 5_000
      ? { ...row, row: { ...row.row, score: 20_000 } }
      : row), 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();
    const maintained = applySnapshot(session, initial, next);

    expect(semanticResult(maintained)).toEqual(oracle(query, next));
    expect(maintained.state.operatorDiagnostics.distinct.selectiveNodeCount).toBe(1);
    expect(maintained.rows[4_999]).toBe(before.rows[4_999]);
    expect(maintained.rows[5_000]).not.toBe(before.rows[5_000]);
    expect(maintained.rows[5_001]).toBe(before.rows[5_001]);
    session.close();
  });

  it('does not reuse distinct result identities when a balanced substitution changes representatives', () => {
    const distinct: QueryNode = {
      kind: 'distinct',
      input: { kind: 'select', input: people, alias: 'value', fields: { value: field('p', 'group') } }
    };
    const initial = snapshot([
      { occurrenceId: 'balanced:a:first', row: { id: 1, group: 'a' } },
      { occurrenceId: 'balanced:b:first', row: { id: 2, group: 'b' } },
      { occurrenceId: 'balanced:b:second', row: { id: 3, group: 'b' } },
      { occurrenceId: 'balanced:c:first', row: { id: 4, group: 'c' } }
    ], 1);
    const next = snapshot([
      { occurrenceId: 'balanced:a:first', row: { id: 1, group: 'a' } },
      { occurrenceId: 'balanced:b:first', row: { id: 2, group: 'a' } },
      { occurrenceId: 'balanced:b:second', row: { id: 3, group: 'd' } },
      { occurrenceId: 'balanced:c:first', row: { id: 4, group: 'c' } }
    ], 2);
    const session = openIncrementalQueryMaintenance(plan(distinct), initial);
    const maintained = applySnapshot(session, initial, next);
    const reopened = openIncrementalQueryMaintenance(plan(distinct), next);

    expect(semanticResult(maintained)).toEqual(oracle(distinct, next));
    expect(maintained.resultKeys).toEqual(reopened.getCurrentResult().resultKeys);
    expect(maintained.state.operatorDiagnostics.distinct.selectiveNodeCount).toBe(1);
    session.close();
    reopened.close();
  });

  it('propagates stable distinct replacements safely through slice and union-all', () => {
    const distinct: QueryNode = { kind: 'distinct', input: { kind: 'select', input: people, alias: 'value', fields: { value: field('p', 'score') } } };
    const queries: readonly QueryNode[] = [
      { kind: 'slice', input: distinct, offset: 0, limit: 2 },
      { kind: 'set', op: 'union-all', left: distinct, right: { kind: 'values', alias: 'value', rows: [{ value: 'constant' }] } }
    ];
    const initial = snapshot([
      { occurrenceId: 'downstream:a', row: { id: 1, score: 1 } },
      { occurrenceId: 'downstream:b', row: { id: 2, score: 2 } },
      { occurrenceId: 'downstream:c', row: { id: 3, score: 3 } }
    ], 1);
    const next = snapshot([
      { occurrenceId: 'downstream:a', row: { id: 1, score: 4 } },
      { occurrenceId: 'downstream:b', row: { id: 2, score: 2 } },
      { occurrenceId: 'downstream:c', row: { id: 3, score: 3 } }
    ], 2);
    for (const query of queries) {
      const session = openIncrementalQueryMaintenance(plan(query), initial);
      const maintained = applySnapshot(session, initial, next);
      expect(semanticResult(maintained)).toEqual(oracle(query, next));
      expect(maintained.state.operatorDiagnostics.distinct.selectiveNodeCount).toBe(1);
      if (query.kind === 'slice') expect(maintained.state.operatorDiagnostics.slice.selectiveNodeCount).toBe(1);
      else expect(maintained.state.operatorDiagnostics.set.selectiveNodeCount).toBe(1);
      session.close();
    }
  });

  it('propagates unchanged-row completeness transitions from distinct into slice', () => {
    const query: QueryNode = { kind: 'slice', input: { kind: 'distinct', input: people }, offset: 0, limit: 1 };
    const rows: readonly QueryRowOccurrence[] = [
      { occurrenceId: 'distinct-completeness:a', row: { id: 1, value: 'a' } },
      { occurrenceId: 'distinct-completeness:b', row: { id: 2, value: 'b' } }
    ];
    const exact: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 1, 'exact')] };
    const lower: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 2, 'lower-bound')] };
    const session = openIncrementalQueryMaintenance(plan(query), exact);
    const maintained = applySnapshot(session, exact, lower);
    expect(semanticResult(maintained)).toEqual(oracle(query, lower));
    expect(maintained).toMatchObject({ rows: [], completeness: 'unknown' });
    expect(maintained.state.operatorDiagnostics.distinct).toMatchObject({ selectiveNodeCount: 1, affectedUnitCount: 0 });
    expect(maintained.state.operatorDiagnostics.slice).toMatchObject({ fallbackNodeCount: 1, fallbackReasons: { input_unavailable: 1 } });
    session.close();
  });

  it('keeps sparse aggregate overlays bounded and preserves the empty ungrouped row', () => {
    const query: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: {},
      measures: {
        count: { kind: 'aggregate', op: 'count' },
        sum: { kind: 'aggregate', op: 'sum', value: field('p', 'score') },
        values: { kind: 'aggregate', op: 'collect', value: field('p', 'name') },
        first: { kind: 'aggregate', op: 'first', value: field('p', 'name'), orderBy: [{ value: field('p', 'score'), direction: 'desc' }] }
      }
    };
    const first = snapshot(basePeople, 1);
    const second = snapshot([
      { ...(basePeople[0] as QueryRowOccurrence), row: { ...(basePeople[0] as QueryRowOccurrence).row, score: 11 } },
      basePeople[1] as QueryRowOccurrence
    ], 2);
    const session = openIncrementalQueryMaintenance(plan(query), first);
    let accepted = first;
    for (let revision = 0; revision < 70; revision += 1) {
      const next = revision % 2 === 0 ? second : first;
      const maintained = applySnapshot(session, accepted, next);
      expect(semanticResult(maintained)).toEqual(oracle(query, next));
      accepted = next;
    }
    const empty = snapshot([], 3);
    expect(semanticResult(applySnapshot(session, accepted, empty))).toEqual(oracle(query, empty));
    expect(session.getCurrentResult().rows).toEqual([{ count: 0, sum: null, values: [], first: null }]);
    session.close();
  });

  it('maintains reducer-only aggregates through same-group replacement, group movement, and compaction', () => {
    const query: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: { group: field('p', 'group') },
      measures: {
        rows: { kind: 'aggregate', op: 'count' },
        present: { kind: 'aggregate', op: 'count', value: field('p', 'score') },
        distinct: { kind: 'aggregate', op: 'count-distinct', value: field('p', 'score') },
        minimum: { kind: 'aggregate', op: 'minimum', value: field('p', 'score') },
        maximum: { kind: 'aggregate', op: 'maximum', value: field('p', 'score') },
        any: { kind: 'aggregate', op: 'any', value: field('p', 'active') },
        every: { kind: 'aggregate', op: 'every', value: field('p', 'active') }
      }
    };
    const initialRows: readonly QueryRowOccurrence[] = [
      { occurrenceId: 'reducer:a', row: { id: 1, group: 'x', score: 1, active: true } },
      { occurrenceId: 'reducer:b', row: { id: 2, group: 'x', score: 1, active: false } },
      { occurrenceId: 'reducer:c', row: { id: 3, group: 'y', score: null, active: logicalUnknown } },
      { occurrenceId: 'reducer:d', row: { id: 4, group: 'y', active: 'not-a-boolean' } }
    ];
    const initial = snapshot(initialRows, 1);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    let accepted = initial;
    let observedReducerCompaction = false;

    for (let revision = 2; revision <= 132; revision += 1) {
      const toggled = revision % 2 === 0;
      const nextRows: readonly QueryRowOccurrence[] = [
        initialRows[0] as QueryRowOccurrence,
        { occurrenceId: 'reducer:b', row: { id: 2, group: toggled ? 'x' : 'y', score: toggled ? 2 : 1, active: toggled } },
        initialRows[2] as QueryRowOccurrence,
        initialRows[3] as QueryRowOccurrence
      ];
      const next = snapshot(nextRows, revision);
      const maintained = applySnapshot(session, accepted, next);
      expect(semanticResult(maintained), `reducer transition ${revision}`).toEqual(oracle(query, next));
      observedReducerCompaction ||= maintained.state.operatorDiagnostics.aggregate.compactionCount > 0;
      accepted = next;
    }
    expect(observedReducerCompaction).toBe(true);
    session.close();
  });

  it('reports count-distinct reducer compaction before the group-key index boundary', () => {
    const query: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: {},
      measures: { distinct: { kind: 'aggregate', op: 'count-distinct', value: field('p', 'score') } }
    };
    const state = (revision: number): QueryMaintenanceSnapshot => snapshot([
      { occurrenceId: 'distinct:one', row: { id: 1, score: revision, active: true } }
    ], revision);
    let accepted = state(1);
    const session = openIncrementalQueryMaintenance(plan(query), accepted);

    for (let revision = 2; revision <= 35; revision += 1) {
      const next = state(revision);
      const maintained = applySnapshot(session, accepted, next);
      expect(semanticResult(maintained)).toEqual(oracle(query, next));
      expect(maintained.state.operatorDiagnostics.aggregate.compactionCount).toBe(revision === 33 ? 1 : 0);
      accepted = next;
    }
    session.close();
  });

  it('preserves left-to-right IEEE-754 sum and average semantics on sparse replacement', () => {
    const query: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: {},
      measures: {
        sum: { kind: 'aggregate', op: 'sum', value: field('p', 'score') },
        average: { kind: 'aggregate', op: 'average', value: field('p', 'score') }
      }
    };
    const initial = snapshot([
      { occurrenceId: 'floating:a', row: { id: 1, score: 1e16 } },
      { occurrenceId: 'floating:b', row: { id: 2, score: 1 } },
      { occurrenceId: 'floating:c', row: { id: 3, score: -1e16 } }
    ], 1);
    const next = snapshot([
      { occurrenceId: 'floating:a', row: { id: 1, score: 1e16 } },
      { occurrenceId: 'floating:b', row: { id: 2, score: 2 } },
      { occurrenceId: 'floating:c', row: { id: 3, score: -1e16 } }
    ], 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const maintained = applySnapshot(session, initial, next);
    expect(semanticResult(maintained)).toEqual(oracle(query, next));
    expect(maintained.rows).toEqual([{ sum: 2, average: 2 / 3 }]);
    // A sum-only delta would produce 0 - 1 + 2 = 1 here, so these measures
    // must retain the ordered fold unless the public numeric semantics change.
    session.close();
  });

  it('normalizes comparator-equal signed zero extrema before incremental maintenance', () => {
    const query: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: {},
      measures: {
        minimum: { kind: 'aggregate', op: 'minimum', value: field('p', 'score') },
        maximum: { kind: 'aggregate', op: 'maximum', value: field('p', 'score') }
      }
    };
    const states = [
      [
        { occurrenceId: 'zero:a', row: { id: 1, score: -0 } },
        { occurrenceId: 'zero:b', row: { id: 2, score: 0 } }
      ],
      [
        { occurrenceId: 'zero:a', row: { id: 1, score: 1 } },
        { occurrenceId: 'zero:b', row: { id: 2, score: 0 } }
      ],
      [
        { occurrenceId: 'zero:a', row: { id: 1, score: -0 } },
        { occurrenceId: 'zero:b', row: { id: 2, score: 0 } }
      ],
      [
        { occurrenceId: 'zero:a', row: { id: 1, score: 0 } },
        { occurrenceId: 'zero:b', row: { id: 2, score: -0 } }
      ]
    ].map((rows, index) => snapshot(rows, index + 1));
    const session = openIncrementalQueryMaintenance(plan(query), states[0] as QueryMaintenanceSnapshot);
    expect(Object.is(session.getCurrentResult().rows[0]?.minimum, -0)).toBe(false);
    expect(session.getCurrentResult().rows[0]?.minimum).toBe(0);
    for (let index = 1; index < states.length; index += 1) {
      const maintained = applySnapshot(session, states[index - 1] as QueryMaintenanceSnapshot, states[index] as QueryMaintenanceSnapshot);
      expect(semanticResult(maintained)).toEqual(oracle(query, states[index] as QueryMaintenanceSnapshot));
    }
    expect(Object.is(session.getCurrentResult().rows[0]?.minimum, 0)).toBe(true);
    expect(Object.is(session.getCurrentResult().rows[0]?.minimum, -0)).toBe(false);
    session.close();
  });

  it('refreshes reducer-only member references at the bounded group-index compaction boundary', () => {
    const query: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: {},
      measures: {
        rows: { kind: 'aggregate', op: 'count' },
        present: { kind: 'aggregate', op: 'count', value: field('p', 'score') },
        any: { kind: 'aggregate', op: 'any', value: field('p', 'active') }
      }
    };
    const rowsAt = (revision: number): readonly QueryRowOccurrence[] => [
      { occurrenceId: 'retention:a', row: { id: 1, score: revision, active: revision % 2 === 0, payload: `${revision}:` + 'x'.repeat(1_024) } },
      { occurrenceId: 'retention:b', row: { id: 2, score: 2, active: false, payload: 'stable' } }
    ];
    let accepted = snapshot(rowsAt(1), 1);
    const session = openIncrementalQueryMaintenance(plan(query), accepted);
    const initialOutput = session.getCurrentResult().rows[0];
    let boundaryOutput: QueryRecord | undefined;
    for (let revision = 2; revision <= 65; revision += 1) {
      const next = snapshot(rowsAt(revision), revision);
      const maintained = applySnapshot(session, accepted, next);
      expect(semanticResult(maintained)).toEqual(oracle(query, next));
      expect(maintained.state.operatorDiagnostics.aggregate.compactionCount).toBe(revision === 65 ? 1 : 0);
      if (revision === 65) boundaryOutput = maintained.rows[0];
      accepted = next;
    }
    expect(boundaryOutput).toBeDefined();
    expect(boundaryOutput).not.toBe(initialOutput);

    // Force full state recovery after compaction; it must rebuild from current
    // inputs rather than any member row retained from the initial snapshot.
    const recovered = snapshot([
      ...rowsAt(66),
      { occurrenceId: 'retention:c', row: { id: 3, score: null, active: true, payload: 'inserted' } }
    ], 66);
    expect(semanticResult(applySnapshot(session, accepted, recovered))).toEqual(oracle(query, recovered));
    session.close();
  });

  it('rematerializes order and aggregate outputs when only an expression subquery dependency changes', () => {
    const rankForPerson = {
      kind: 'subquery', mode: 'scalar',
      query: {
        kind: 'select', alias: 'rank',
        input: {
          kind: 'where', input: groupRows,
          predicate: { kind: 'compare', op: 'eq', left: field('g', 'id'), right: field('p', 'group') }
        },
        fields: { value: field('g', 'rank') }
      }
    } as const;
    const orderQuery: QueryNode = { kind: 'order', input: people, by: [{ value: rankForPerson, direction: 'asc' }] };
    const aggregateQuery: QueryNode = {
      kind: 'aggregate', input: people, alias: 'summary', groupBy: { group: field('p', 'group') },
      measures: { rank: { kind: 'aggregate', op: 'first', value: rankForPerson } }
    };
    const rankedGroups = (x: number, y: number, revision: number): RelationInput => relation('groups', [
      { occurrenceId: 'group:x', row: { id: 'x', rank: x } },
      { occurrenceId: 'group:y', row: { id: 'y', rank: y } }
    ], revision);
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', basePeople, 1), rankedGroups(2, 1, 1)] };
    const next: QueryMaintenanceSnapshot = { relations: [relation('people', basePeople, 1), rankedGroups(0, 3, 2)] };

    for (const query of [orderQuery, aggregateQuery]) {
      const session = openIncrementalQueryMaintenance(plan(query), initial);
      const result = applySnapshot(session, initial, next);
      expect(semanticResult(result)).toEqual(oracle(query, next));
      session.close();
    }
    const orderSession = openIncrementalQueryMaintenance(plan(orderQuery), initial);
    expect(applySnapshot(orderSession, initial, next).rows.map(({ id }) => id)).toEqual([1, 2]);
    orderSession.close();
    const aggregateSession = openIncrementalQueryMaintenance(plan(aggregateQuery), initial);
    expect(applySnapshot(aggregateSession, initial, next).rows).toEqual([
      { group: 'x', rank: 0 }, { group: 'y', rank: 3 }
    ]);
    aggregateSession.close();
  });

  it('rematerializes local operators when a call argument contains a subquery dependency', () => {
    const identity = { id: 'urn:test:nested-subquery-call', version: '1', contractHash: `sha256:${'6'.repeat(64)}` } as const;
    const identityKey = identity.id + '\u0000' + identity.version + '\u0000' + identity.contractHash;
    const functions = new Map([[identityKey, (args: readonly JsonValue[]) => args[0] ?? false]]);
    const enabled = {
      kind: 'subquery', mode: 'scalar',
      query: {
        kind: 'select', input: groupRows, alias: 'enabled',
        fields: { value: field('g', 'enabled') }
      }
    } as const;
    const query: QueryNode = {
      kind: 'where',
      input: people,
      predicate: { kind: 'call', capability: identity, args: [enabled] }
    };
    const state = (value: boolean, revision: number): QueryMaintenanceSnapshot => ({
      relations: [
        relation('people', [basePeople[0] as QueryRowOccurrence], 1),
        relation('groups', [{ occurrenceId: 'group:only', row: { enabled: value } }], revision)
      ],
      functions
    });
    const initial = state(true, 1);
    const next = state(false, 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);

    const maintained = applySnapshot(session, initial, next);
    expect(semanticResult(maintained)).toEqual(oracle(query, next));
    expect(maintained.rows).toEqual([]);
    session.close();
  });

  it('maintains a skewed right join index across payload and key replacements', () => {
    const query: QueryNode = {
      kind: 'join', join: 'inner', left: from('left', 'l'), right: from('right', 'r'),
      on: { kind: 'compare', op: 'eq', left: field('l', 'joinId'), right: field('r', 'id') }
    };
    const leftRows = Array.from({ length: 300 }, (_, index): QueryRowOccurrence => ({ occurrenceId: `left:${index}`, row: { id: index, joinId: index % 10 } }));
    const rightRows = Array.from({ length: 100 }, (_, index): QueryRowOccurrence => ({ occurrenceId: `right:${index}`, row: { id: index % 10, label: `r${index}` } }));
    const state = (right: readonly QueryRowOccurrence[], revision: number): QueryMaintenanceSnapshot => ({
      relations: [relation('left', leftRows, revision), relation('right', right, revision)]
    });
    const initial = state(rightRows, 1);
    const payloadRows = rightRows.map((entry, index) => index === 55 ? { ...entry, row: { ...entry.row, label: 'changed' } } : entry);
    const session = openIncrementalQueryMaintenance(plan(query), initial);

    let accepted = initial;
    for (let revision = 0; revision < 101; revision += 1) {
      const next = state(revision % 2 === 0 ? payloadRows : rightRows, revision + 2);
      session.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
      accepted = next;
    }
    expect(semanticResult(session.getCurrentResult())).toEqual(oracle(query, accepted));
    const acceptedRight = (accepted.relations[1] as RelationInput).rows.map((row, index): QueryRowOccurrence => ({ occurrenceId: `right:${index}`, row }));
    const swappedRight = acceptedRight.map((entry, index) => index === 55
      ? { ...entry, row: { ...entry.row, id: 6 } }
      : index === 56
        ? { ...entry, row: { ...entry.row, id: 5 } }
        : entry);
    const swapped = state(swappedRight, 103);
    const beforeSwap = session.getCurrentResult();
    const swappedResult = applySnapshot(session, accepted, swapped);
    expect(semanticResult(swappedResult)).toEqual(oracle(query, swapped));
    expect(swappedResult.resultKeys).not.toBe(beforeSwap.resultKeys);
    const moved = state(swappedRight.map((entry, index) => index === 55 ? { ...entry, row: { ...entry.row, id: 20 } } : entry), 104);
    expect(semanticResult(applySnapshot(session, swapped, moved))).toEqual(oracle(query, moved));
    const bulk = state((moved.relations[1] as RelationInput).rows.map((row, index) => ({ occurrenceId: `right:${index}`, row: index < 40 ? { ...row, label: `bulk:${index}` } : row })), 105);
    expect(semanticResult(applySnapshot(session, moved, bulk))).toEqual(oracle(query, bulk));
    session.close();
  });

  it('retains sparse join layout and invalidates only outputs for affected right keys', () => {
    const query: QueryNode = {
      kind: 'join', join: 'inner', left: from('selective-left', 'l'), right: from('selective-right', 'r'),
      on: { kind: 'compare', op: 'eq', left: field('l', 'joinId'), right: field('r', 'id') }
    };
    const leftRows = Array.from({ length: 300 }, (_, id): QueryRowOccurrence => ({ occurrenceId: `selective-left:${id}`, row: { id, joinId: id } }));
    const rightRows = Array.from({ length: 300 }, (_, id): QueryRowOccurrence => ({ occurrenceId: `selective-right:${id}`, row: { id, label: `right:${id}` } }));
    const state = (right: readonly QueryRowOccurrence[], revision: number): QueryMaintenanceSnapshot => ({ relations: [
      relation('selective-left', leftRows, revision), relation('selective-right', right, revision)
    ] });
    const initial = state(rightRows, 1);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();
    expect(before.state.operatorDiagnostics.join).toEqual({ selectiveNodeCount: 0, fullNodeCount: 0, fallbackNodeCount: 0, affectedUnitCount: 0, compactionCount: 0, fallbackReasons: {} });
    const changedRows = rightRows.map((entry, index) => index === 155
      ? { ...entry, row: { ...entry.row, label: 'changed' } }
      : entry);
    const changed = state(changedRows, 2);
    const maintained = applySnapshot(session, initial, changed);

    expect(semanticResult(maintained)).toEqual(oracle(query, changed));
    expect(maintained.state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, fullNodeCount: 0, fallbackNodeCount: 0, affectedUnitCount: 1 });
    expect(maintained.resultKeys).toBe(before.resultKeys);
    expect(maintained.rows[0]).toBe(before.rows[0]);
    expect(maintained.rows[155]).not.toBe(before.rows[155]);

    const movedRows = changedRows.map((entry, index) => index === 155
      ? { ...entry, row: { ...entry.row, id: 1_000 } }
      : entry);
    const moved = state(movedRows, 3);
    expect(semanticResult(applySnapshot(session, changed, moved))).toEqual(oracle(query, moved));
    expect(session.getCurrentResult().rows).toHaveLength(299);

    const returned = state(rightRows, 4);
    expect(semanticResult(applySnapshot(session, moved, returned))).toEqual(oracle(query, returned));
    expect(session.getCurrentResult().rows).toHaveLength(300);
    let accepted = returned;
    for (let revision = 5; revision <= 325; revision += 1) {
      const nextRows = rightRows.map((entry, index) => index === 155
        ? { ...entry, row: { ...entry.row, id: revision % 4 === 0 ? 155 : 1_000 + revision, label: `revision:${revision}` } }
        : entry);
      const next = state(nextRows, revision);
      const result = applySnapshot(session, accepted, next);
      if (revision % 64 === 0) expect(semanticResult(result)).toEqual(oracle(query, next));
      accepted = next;
    }
    const restored = state(rightRows, 326);
    expect(semanticResult(applySnapshot(session, accepted, restored))).toEqual(oracle(query, restored));
    expect(session.getCurrentResult().rows).toHaveLength(300);
    session.close();
  });

  it('selectively maintains sparse left payload and key moves with duplicate join buckets', () => {
    const query: QueryNode = {
      kind: 'join', join: 'inner', left: from('left-selective', 'l'), right: from('right-stable', 'r'),
      on: { kind: 'compare', op: 'eq', left: field('l', 'joinId'), right: field('r', 'id') }
    };
    const baseLeft = Array.from({ length: 300 }, (_, id): QueryRowOccurrence => ({ occurrenceId: `left-selective:${id}`, row: { id, joinId: id % 10, payload: 0 } }));
    const stableRight = Array.from({ length: 100 }, (_, id): QueryRowOccurrence => ({ occurrenceId: `right-stable:${id}`, row: { id: id % 10, label: `right:${id}` } }));
    const state = (left: readonly QueryRowOccurrence[], right: readonly QueryRowOccurrence[], revision: number): QueryMaintenanceSnapshot => ({ relations: [
      relation('left-selective', left, revision), relation('right-stable', right, revision)
    ] });
    const initial = state(baseLeft, stableRight, 1);
    const payloadLeft = baseLeft.map((entry, index) => index === 155 ? { ...entry, row: { ...entry.row, payload: 1 } } : entry);
    const payload = state(payloadLeft, stableRight, 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();
    const payloadResult = applySnapshot(session, initial, payload);
    expect(semanticResult(payloadResult)).toEqual(oracle(query, payload));
    expect(payloadResult.state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, fullNodeCount: 0, affectedUnitCount: 1 });
    expect(payloadResult.resultKeys).toBe(before.resultKeys);

    const swappedLeft = payloadLeft.map((entry, index) => index === 155 ? { ...entry, row: { ...entry.row, joinId: 6, payload: 2 } } : entry);
    const swapped = state(swappedLeft, stableRight, 3);
    const swappedResult = applySnapshot(session, payload, swapped);
    expect(semanticResult(swappedResult)).toEqual(oracle(query, swapped));
    expect(swappedResult.state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, fullNodeCount: 0, affectedUnitCount: 1 });
    expect(swappedResult.resultKeys).not.toBe(payloadResult.resultKeys);

    let accepted = swapped;
    let observedCompaction = false;
    let checkedCompactionReset = false;
    for (let revision = 4; revision <= 324; revision += 1) {
      const nextLeft = baseLeft.map((entry, index) => index === 155
        ? { ...entry, row: { ...entry.row, joinId: 1_000 + revision, payload: revision } }
        : entry);
      const next = state(nextLeft, stableRight, revision);
      const maintained = applySnapshot(session, accepted, next);
      expect(maintained.state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, fullNodeCount: 0, affectedUnitCount: 1 });
      observedCompaction ||= maintained.state.operatorDiagnostics.join.compactionCount > 0;
      if (revision % 64 === 0) expect(semanticResult(maintained)).toEqual(oracle(query, next));
      accepted = next;
      if (!checkedCompactionReset && maintained.state.operatorDiagnostics.join.compactionCount > 0) {
        const payloadOnlyLeft = nextLeft.map((entry, index) => index === 155 ? { ...entry, row: { ...entry.row, payload: revision + 0.5 } } : entry);
        const payloadOnly = state(payloadOnlyLeft, stableRight, revision + 0.5);
        const payloadOnlyResult = applySnapshot(session, accepted, payloadOnly);
        expect(payloadOnlyResult.state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, compactionCount: 0 });
        accepted = payloadOnly;
        checkedCompactionReset = true;
      }
    }
    expect(observedCompaction).toBe(true);
    expect(checkedCompactionReset).toBe(true);

    const changedRight = stableRight.map((entry, index) => index === 6 ? { ...entry, row: { ...entry.row, label: 'both-sides' } } : entry);
    const both = state(payloadLeft, changedRight, 325);
    const bothResult = applySnapshot(session, accepted, both);
    expect(semanticResult(bothResult)).toEqual(oracle(query, both));
    expect(bothResult.state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 0, fullNodeCount: 1 });
    session.close();

    const runtime = createPooledIncrementalQueryRuntime({
      environment: { runtimeIdentity: 'join:left-selective', registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(query));
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, payload));
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, payload));
    expect(root.getCurrentResult().state.operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, affectedUnitCount: 1 });
    expect(runtime.getDiagnostics().operatorDiagnostics.join).toMatchObject({ selectiveNodeCount: 1, affectedUnitCount: 1 });
    root.close();
    runtime.close();
  });

  it('compacts historical join-key overlays and remains correct after hundreds of unique moves', () => {
    const query: QueryNode = {
      kind: 'join', join: 'inner', left: from('compact-left', 'l'), right: from('compact-right', 'r'),
      on: { kind: 'compare', op: 'eq', left: field('l', 'joinId'), right: field('r', 'joinId') }
    };
    const leftRows = Array.from({ length: 10 }, (_, id): QueryRowOccurrence => ({ occurrenceId: `compact-left:${id}`, row: { id, joinId: id } }));
    const state = (joinId: number, revision: number): QueryMaintenanceSnapshot => ({ relations: [
      relation('compact-left', leftRows, revision),
      relation('compact-right', [{ occurrenceId: 'compact-right:one', row: { id: 'right', joinId, payload: { revision } } }], revision)
    ] });
    let accepted = state(0, 0);
    const session = openIncrementalQueryMaintenance(plan(query), accepted);
    let observedCompaction = false;
    for (let revision = 1; revision <= 320; revision += 1) {
      const next = state(revision, revision);
      const maintained = applySnapshot(session, accepted, next);
      observedCompaction ||= maintained.state.operatorDiagnostics.join.compactionCount > 0;
      if (revision % 40 === 0) expect(semanticResult(maintained)).toEqual(oracle(query, next));
      accepted = next;
    }
    const returned = state(5, 321);

    expect(semanticResult(applySnapshot(session, accepted, returned))).toEqual(oracle(query, returned));
    expect(observedCompaction).toBe(true);
    expect(session.getCurrentResult().rows).toHaveLength(1);
    session.close();
  });

  it('owns pooled inputs and shares immutable public views for retained physical rows', () => {
    const firstRow = { id: 1, nested: { label: 'one' } };
    const initial: QueryMaintenanceSnapshot = { relations: [relation('pooled-owned', [{ occurrenceId: 'owned:1', row: firstRow }], 1)] };
    const runtime = createPooledIncrementalQueryRuntime({
      environment: { runtimeIdentity: 'database:test/owned', registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(from('pooled-owned', 'owned')));
    const result = root.getCurrentResult();
    firstRow.nested.label = 'caller mutation';
    expect(result.rows).toEqual([{ id: 1, nested: { label: 'one' } }]);
    expect(Object.isFrozen(result.rows[0])).toBe(true);
    root.close();
    runtime.close();
  });

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
      const diagnosticOperator = query.kind === 'where' || query.kind === 'select' || query.kind === 'with-fields' || query.kind === 'rename' || query.kind === 'omit' || query.kind === 'unnest'
        ? 'local'
        : query.kind === 'join' || query.kind === 'order' || query.kind === 'aggregate' || query.kind === 'window'
          ? query.kind
          : undefined;
      if (diagnosticOperator !== undefined) {
        const diagnostic = middleResult.state.operatorDiagnostics[diagnosticOperator];
        expect(diagnostic.selectiveNodeCount + diagnostic.fullNodeCount + diagnostic.fallbackNodeCount, `${operator}: diagnostic decision`).toBeGreaterThan(0);
      }

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
    expect(session.applyUpdate(invalid)).toMatchObject({ completeness: 'unknown', issues: [{ code: 'query.incremental_identity_invalid' }], state: { updatedNodeCount: 0, rejectedUpdateCount: 1, resultDelta: { addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] }, operatorDiagnostics: { local: { selectiveNodeCount: 0, fullNodeCount: 0, fallbackNodeCount: 0 } } } });
    const final = snapshot(finalPeople, 3);
    const recovered = applySnapshot(session, initial, final);
    expect(semanticResult(recovered)).toEqual(oracle(query, final));
    expect(recovered.state).toMatchObject({ rejectedUpdateCount: 1 });
  });

  it('atomically adopts update identity before private and pooled invalidation', () => {
    const initial = snapshot(basePeople, 1);
    const next = snapshot(middlePeople, 2);
    const valid = diffQueryMaintenanceSnapshots(initial, next);
    const peopleChange = valid.relations.find(({ relation }) => relation.relationId === 'people') as NonNullable<typeof valid.relations[number]>;
    let relationIdReads = 0;
    const accessorRelation = { schemaView } as Record<string, unknown>;
    Object.defineProperty(accessorRelation, 'relationId', {
      enumerable: true,
      get: () => {
        relationIdReads += 1;
        return relationIdReads === 1 ? 'people' : 'groups';
      }
    });
    const hostile = {
      ...valid,
      relations: valid.relations.map((change) => change === peopleChange
        ? { ...change, relation: accessorRelation as RelationInput['relation'] }
        : change)
    };

    const privateSession = openIncrementalQueryMaintenance(plan(people), initial);
    const privateBefore = privateSession.getCurrentResult();
    expect(() => privateSession.applyUpdate(hostile)).toThrow('Changed query relation must be a portable value');
    expect(privateSession.getCurrentResult()).toBe(privateBefore);

    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/atomic-update-adoption', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(people));
    const pooledBefore = root.getCurrentResult();
    const diagnosticsBefore = runtime.getDiagnostics();
    expect(() => runtime.applyUpdate(hostile)).toThrow('Changed query relation must be a portable value');
    expect(root.getCurrentResult()).toBe(pooledBefore);
    expect(runtime.getDiagnostics()).toBe(diagnosticsBefore);
    expect(relationIdReads).toBe(0);

    expect(semanticResult(privateSession.applyUpdate(valid))).toEqual(oracle(people, next));
    runtime.applyUpdate(valid);
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(people, next));
    privateSession.close();
    root.close();
    runtime.close();
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

  it('propagates stable one-row replacements through a deep local pipeline without rescanning expressions', () => {
    const identity = { id: 'urn:test:local-identity', version: '1', contractHash: `sha256:${'7'.repeat(64)}` } as const;
    const identityKey = identity.id + '\u0000' + identity.version + '\u0000' + identity.contractHash;
    let calls = 0;
    const functions = new Map([[identityKey, (args: readonly JsonValue[]) => { calls += 1; return args[0] ?? null; }]]);
    const call = (value: ReturnType<typeof field>) => ({ kind: 'call', capability: identity, args: [value] } as const);
    const query: QueryNode = {
      kind: 'omit', alias: 'p', fields: ['tags'],
      input: {
        kind: 'unnest', alias: 'tag', field: 'value', expression: call(field('p', 'tags')),
        input: {
          kind: 'rename', alias: 'p', fields: { score: 'points' },
          input: {
            kind: 'with-fields', alias: 'p', fields: { copiedScore: call(field('p', 'score')) },
            input: {
              kind: 'select', alias: 'p', fields: {
                id: field('p', 'id'), active: field('p', 'active'), score: call(field('p', 'score')), tags: field('p', 'tags')
              },
              input: { kind: 'where', input: people, predicate: call(field('p', 'active')) }
            }
          }
        }
      }
    };
    const rows = Array.from({ length: 128 }, (_, index): QueryRowOccurrence => ({
      occurrenceId: `person:${index}`,
      row: { id: index, active: true, score: index, tags: [`tag:${index}`] }
    }));
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 1)], functions };
    const changed = rows.map((entry, index) => index === 64 ? { ...entry, row: { ...entry.row, score: 999 } } : entry);
    const next: QueryMaintenanceSnapshot = { relations: [relation('people', changed, 2)], functions };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    calls = 0;

    const result = session.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(calls).toBe(4);
    expect(result.rows[64]).toEqual({
      p: { id: 64, active: true, points: 999, copiedScore: 999 },
      tag: { value: 'tag:64' }
    });
    expect(result.state).toMatchObject({ updatedNodeCount: 7, changedNodeCount: 7 });
    expect(semanticResult(result)).toEqual(oracle(query, next));
    session.close();
  });

  it('retains one immutable public view through long-running locally invisible updates', () => {
    const query: QueryNode = {
      kind: 'omit', alias: 'p', fields: ['points', 'copiedScore'],
      input: {
        kind: 'rename', alias: 'p', fields: { score: 'points' },
        input: {
          kind: 'with-fields', alias: 'p', fields: { copiedScore: field('p', 'score') },
          input: people
        }
      }
    };
    const rows = Array.from({ length: 256 }, (_, index): QueryRowOccurrence => ({
      occurrenceId: `person:${index}`,
      row: { id: index, name: `person:${index}`, score: index, active: true, group: 'x', tags: [] }
    }));
    const changedRows = rows.map((entry, index) => index === 128 ? { ...entry, row: { ...entry.row, score: 999 } } : entry);
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 1)] };
    const changed: QueryMaintenanceSnapshot = { relations: [relation('people', changedRows, 2)] };
    const forward = diffQueryMaintenanceSnapshots(initial, changed);
    const backward = diffQueryMaintenanceSnapshots(changed, initial);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const publicRows = session.getCurrentResult().rows;

    for (let index = 0; index < 1_000; index += 1) {
      const result = session.applyUpdate(index % 2 === 0 ? forward : backward);
      expect(result.rows).toBe(publicRows);
      expect(result.state.resultDelta).toEqual({ addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] });
    }
    expect(semanticResult(session.getCurrentResult())).toEqual(oracle(query, initial));
    session.close();
  });

  it('rebuilds change-local source state after unknown input recovers', () => {
    const query = operatorQueries.select as QueryNode;
    const unknown: QueryMaintenanceSnapshot = {
      relations: [relation('people', basePeople, 1, 'unknown')], parameters: { minimum: 6 }
    };
    const exact: QueryMaintenanceSnapshot = {
      relations: [relation('people', basePeople, 2, 'exact')], parameters: { minimum: 6 }
    };
    const replacedRows: readonly QueryRowOccurrence[] = [
      basePeople[0] as QueryRowOccurrence,
      { occurrenceId: 'person:b', row: { ...(basePeople[1] as QueryRowOccurrence).row, name: 'Bobby' } }
    ];
    const replaced: QueryMaintenanceSnapshot = {
      relations: [relation('people', replacedRows, 3, 'exact')], parameters: { minimum: 6 }
    };
    const session = openIncrementalQueryMaintenance(plan(query), unknown);
    expect(session.getCurrentResult()).toMatchObject({ rows: [], completeness: 'unknown' });

    const recovered = applySnapshot(session, unknown, exact);
    const updated = applySnapshot(session, exact, replaced);

    expect(semanticResult(recovered)).toEqual(oracle(query, exact));
    expect(semanticResult(updated)).toEqual(oracle(query, replaced));
    expect(updated.rows[0]).toBe(recovered.rows[0]);
    expect(updated.rows[1]).not.toBe(recovered.rows[1]);
    session.close();
  });

  it('recomputes only the affected partition for compatible windows', () => {
    const specification = {
      partitionBy: [field('p', 'group')],
      orderBy: [{ value: field('p', 'score'), direction: 'asc' as const }]
    };
    const query: QueryNode = {
      kind: 'window', input: people, alias: 'p', fields: {
        rowNumber: { kind: 'window', op: 'row-number', ...specification },
        rank: { kind: 'window', op: 'rank', ...specification },
        previous: { kind: 'window', op: 'lag', value: field('p', 'score'), ...specification }
      }
    };
    const rows = Array.from({ length: 1_000 }, (_, index): QueryRowOccurrence => ({
      occurrenceId: `window:${index}`,
      row: { id: index, group: index % 100, score: index, active: true, tags: [] }
    }));
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 1)] };
    const changed = rows.map((entry, index) => index === 550 ? { ...entry, row: { ...entry.row, score: -1 } } : entry);
    const next: QueryMaintenanceSnapshot = { relations: [relation('people', changed, 2)] };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();

    const maintained = session.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(maintained.rows[0]).toBe(before.rows[0]);
    expect(semanticResult(maintained)).toEqual(oracle(query, next));
    session.close();
  });

  it('micro-maintains stable window keys across ties, nulls, distinct layouts, and lag offsets', () => {
    const ascending = { partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'score'), direction: 'asc' as const, nulls: 'first' as const }] };
    const descending = { partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'id'), direction: 'desc' as const }] };
    const query: QueryNode = {
      kind: 'window', input: people, alias: 'p', fields: {
        rowNumber: { kind: 'window', op: 'row-number', ...ascending },
        rank: { kind: 'window', op: 'rank', ...ascending },
        prior: { kind: 'window', op: 'lag', value: field('p', 'value'), offset: 1, ...ascending },
        reversePrior: { kind: 'window', op: 'lag', value: field('p', 'value'), offset: 2, ...descending }
      }
    };
    const rows = Array.from({ length: 8 }, (_, index): QueryRowOccurrence => ({
      occurrenceId: `window-micro:${index}`,
      row: { id: index, group: index < 4 ? 'a' : 'b', score: index % 4 === 0 ? null : index % 4 < 3 ? 1 : 3, value: `v${index}`, payload: 0 }
    }));
    const state = (entries: readonly QueryRowOccurrence[], revision: number): QueryMaintenanceSnapshot => ({ relations: [relation('people', entries, revision)] });
    const initial = state(rows, 1);
    const changedRows = rows.map((entry, index) => index === 2 ? { ...entry, row: { ...entry.row, value: 'changed', payload: 1 } } : entry);
    const changed = state(changedRows, 2);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();

    const maintained = applySnapshot(session, initial, changed);
    expect(semanticResult(maintained)).toEqual(oracle(query, changed));
    expect(maintained.state.operatorDiagnostics.window).toMatchObject({ selectiveNodeCount: 1, fallbackNodeCount: 0, affectedUnitCount: 3 });
    expect(maintained.rows[1]).toBe(before.rows[1]);
    expect(maintained.rows[2]).not.toBe(before.rows[2]);
    expect(maintained.rows[3]).not.toBe(before.rows[3]);
    expect(maintained.rows[0]).not.toBe(before.rows[0]);

    const partitionMovedRows = changedRows.map((entry, index) => index === 2 ? { ...entry, row: { ...entry.row, group: 'b' } } : entry);
    const partitionMoved = state(partitionMovedRows, 3);
    expect(semanticResult(applySnapshot(session, changed, partitionMoved))).toEqual(oracle(query, partitionMoved));
    const orderMovedRows = partitionMovedRows.map((entry, index) => index === 2 ? { ...entry, row: { ...entry.row, score: -10 } } : entry);
    const orderMoved = state(orderMovedRows, 4);
    expect(semanticResult(applySnapshot(session, partitionMoved, orderMoved))).toEqual(oracle(query, orderMoved));
    session.close();
  });

  it('maps stable slice replacements and retains public views for changes outside the range', () => {
    const query: QueryNode = { kind: 'slice', input: people, offset: 20, limit: 10 };
    const rows = Array.from({ length: 100 }, (_, index): QueryRowOccurrence => ({ occurrenceId: `slice:${index}`, row: { id: index, value: index } }));
    const state = (entries: readonly QueryRowOccurrence[], revision: number): QueryMaintenanceSnapshot => ({ relations: [relation('people', entries, revision)] });
    const initial = state(rows, 1);
    const outsideRows = rows.map((entry, index) => index === 5 ? { ...entry, row: { ...entry.row, value: -5 } } : entry);
    const outside = state(outsideRows, 2);
    const insideRows = outsideRows.map((entry, index) => index === 25 ? { ...entry, row: { ...entry.row, value: -25 } } : entry);
    const inside = state(insideRows, 3);
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const before = session.getCurrentResult();

    const outsideResult = applySnapshot(session, initial, outside);
    expect(semanticResult(outsideResult)).toEqual(oracle(query, outside));
    expect(outsideResult.rows).toBe(before.rows);
    expect(outsideResult.state.operatorDiagnostics.slice).toMatchObject({ selectiveNodeCount: 1, fallbackNodeCount: 0, affectedUnitCount: 0 });

    const insideResult = applySnapshot(session, outside, inside);
    expect(semanticResult(insideResult)).toEqual(oracle(query, inside));
    expect(insideResult.rows[0]).toBe(outsideResult.rows[0]);
    expect(insideResult.rows[5]).not.toBe(outsideResult.rows[5]);
    expect(insideResult.state.operatorDiagnostics.slice).toMatchObject({ selectiveNodeCount: 1, affectedUnitCount: 1 });

    const insertedRows = [...insideRows.slice(0, 10), { occurrenceId: 'slice:inserted', row: { id: 1000, value: 1000 } }, ...insideRows.slice(10)];
    const inserted = state(insertedRows, 4);
    const insertedResult = applySnapshot(session, inside, inserted);
    expect(semanticResult(insertedResult)).toEqual(oracle(query, inserted));
    expect(insertedResult.state.operatorDiagnostics.slice).toMatchObject({ fallbackNodeCount: 1, fallbackReasons: { unstable_layout: 1 } });
    session.close();
  });

  it('maps stable union-all replacements in both branches privately and through pooled roots', () => {
    const leftNode = from('union-left', 'item');
    const rightNode = from('union-right', 'item');
    const query: QueryNode = { kind: 'set', op: 'union-all', left: leftNode, right: rightNode };
    const branch = (name: string, count: number, revision: number, changed = new Map<number, number>()): RelationInput => relation(name, Array.from({ length: count }, (_, index) => ({ occurrenceId: `${name}:${index}`, row: { id: index, value: changed.get(index) ?? index } })), revision);
    const state = (left: RelationInput, right: RelationInput): QueryMaintenanceSnapshot => ({ relations: [left, right] });
    const initial = state(branch('union-left', 5, 1), branch('union-right', 4, 1));
    const changed = state(branch('union-left', 5, 2, new Map([[2, 20]])), branch('union-right', 4, 2, new Map([[1, 10]])));
    const prepared = plan(query);
    const session = openIncrementalQueryMaintenance(prepared, initial);
    const before = session.getCurrentResult();
    const maintained = applySnapshot(session, initial, changed);
    expect(semanticResult(maintained)).toEqual(oracle(query, changed));
    expect(maintained.rows[0]).toBe(before.rows[0]);
    expect(maintained.rows[2]).not.toBe(before.rows[2]);
    expect(maintained.rows[6]).not.toBe(before.rows[6]);
    expect(maintained.resultKeys[2]).toBe(before.resultKeys[2]);
    expect(maintained.resultKeys[6]).toBe(before.resultKeys[6]);
    expect(maintained.state.operatorDiagnostics.set).toMatchObject({ selectiveNodeCount: 1, fallbackNodeCount: 0, affectedUnitCount: 2 });
    session.close();

    const runtime = createPooledIncrementalQueryRuntime({
      environment: { runtimeIdentity: 'union-all:pooled', registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' },
      initialSnapshot: initial
    });
    const root = runtime.attach(prepared);
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, changed));
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, changed));
    expect(root.getCurrentResult().state.operatorDiagnostics.set).toMatchObject({ selectiveNodeCount: 1, affectedUnitCount: 2 });
    expect(runtime.getDiagnostics().operatorDiagnostics.set).toMatchObject({ selectiveNodeCount: 1, affectedUnitCount: 2 });

    const inserted = state(branch('union-left', 6, 3, new Map([[2, 20]])), branch('union-right', 4, 3, new Map([[1, 10]])));
    runtime.applyUpdate(diffQueryMaintenanceSnapshots(changed, inserted));
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, inserted));
    expect(root.getCurrentResult().state.operatorDiagnostics.set).toMatchObject({ fallbackNodeCount: 1, fallbackReasons: { unstable_layout: 1 } });
    root.close();
    runtime.close();
  });

  it('limits downstream named-call work to slice and union-all output deltas', () => {
    const capability = { id: 'urn:test:delta-call', version: '1', contractHash: `sha256:${'8'.repeat(64)}` } as const;
    const key = capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;
    let calls = 0;
    const functions = new Map([[key, (args: readonly JsonValue[]) => { calls += 1; return args[0] ?? null; }]]);
    const called = (input: QueryNode): QueryNode => ({ kind: 'select', input, alias: 'result', fields: { value: { kind: 'call', capability, args: [field('item', 'value')] } } });
    const rows = (relationId: string, count: number, revision: number, changed = new Map<number, number>()): RelationInput => relation(relationId, Array.from({ length: count }, (_, index) => ({ occurrenceId: `${relationId}:${index}`, row: { id: index, value: changed.get(index) ?? index } })), revision);

    const slicedQuery = called({ kind: 'slice', input: from('called-slice', 'item'), offset: 20, limit: 10 });
    const sliceInitial: QueryMaintenanceSnapshot = { relations: [rows('called-slice', 100, 1)], functions };
    const sliceOutside: QueryMaintenanceSnapshot = { relations: [rows('called-slice', 100, 2, new Map([[5, -5]]))], functions };
    const sliceInside: QueryMaintenanceSnapshot = { relations: [rows('called-slice', 100, 3, new Map([[5, -5], [25, -25]]))], functions };
    const sliceSession = openIncrementalQueryMaintenance(plan(slicedQuery), sliceInitial);
    let beforeCalls = calls;
    applySnapshot(sliceSession, sliceInitial, sliceOutside);
    expect(calls - beforeCalls).toBe(0);
    beforeCalls = calls;
    applySnapshot(sliceSession, sliceOutside, sliceInside);
    expect(calls - beforeCalls).toBe(1);
    sliceSession.close();

    const unionQuery = called({ kind: 'set', op: 'union-all', left: from('called-left', 'item'), right: from('called-right', 'item') });
    const unionInitial: QueryMaintenanceSnapshot = { relations: [rows('called-left', 50, 1), rows('called-right', 50, 1)], functions };
    const unionChanged: QueryMaintenanceSnapshot = { relations: [rows('called-left', 50, 2, new Map([[2, -2]])), rows('called-right', 50, 2, new Map([[3, -3]]))], functions };
    const unionSession = openIncrementalQueryMaintenance(plan(unionQuery), unionInitial);
    beforeCalls = calls;
    applySnapshot(unionSession, unionInitial, unionChanged);
    expect(calls - beforeCalls).toBe(2);
    unionSession.close();
  });

  it('keeps named lag values on full evaluation instead of the stable-key micro path', () => {
    const capability = { id: 'urn:test:window-lag-call', version: '1', contractHash: `sha256:${'7'.repeat(64)}` } as const;
    const key = capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;
    let calls = 0;
    const functions = new Map([[key, (args: readonly JsonValue[]) => { calls += 1; return args[0] ?? null; }]]);
    const query: QueryNode = {
      kind: 'window', input: people, alias: 'p', fields: {
        prior: {
          kind: 'window', op: 'lag',
          value: { kind: 'call', capability, args: [field('p', 'value')] },
          partitionBy: [field('p', 'group')], orderBy: [{ value: field('p', 'id'), direction: 'asc' }]
        }
      }
    };
    const rows = Array.from({ length: 20 }, (_, index): QueryRowOccurrence => ({ occurrenceId: `window-lag-call:${index}`, row: { id: index, group: 0, value: index, payload: 0 } }));
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 1)], functions };
    const changedRows = rows.map((entry, index) => index === 10 ? { ...entry, row: { ...entry.row, payload: 1 } } : entry);
    const changed: QueryMaintenanceSnapshot = { relations: [relation('people', changedRows, 2)], functions };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    const callsAfterOpen = calls;
    const maintained = applySnapshot(session, initial, changed);
    expect(semanticResult(maintained)).toEqual(oracle(query, changed));
    expect(calls - callsAfterOpen).toBe(rows.length - 1 + rows.length - 1);
    expect(maintained.state.operatorDiagnostics.window).toMatchObject({ fallbackNodeCount: 1, fallbackReasons: { unsupported_expression: 1 } });
    session.close();
  });

  it('keeps named window calls on the conservative full-evaluation path', () => {
    const ordered = { id: 'urn:test:window-order-stateful', version: '1', contractHash: `sha256:${'6'.repeat(64)}` } as const;
    const orderedKey = ordered.id + '\u0000' + ordered.version + '\u0000' + ordered.contractHash;
    let failingId: number | undefined;
    const functions = new Map([[orderedKey, (args: readonly JsonValue[]) => {
      if (args[0] === failingId) throw new Error('stateful window failure');
      return args[1] ?? null;
    }]]);
    const query: QueryNode = {
      kind: 'window', input: people, alias: 'p', fields: {
        rank: {
          kind: 'window', op: 'rank', partitionBy: [field('p', 'group')],
          orderBy: [{ value: { kind: 'call', capability: ordered, args: [field('p', 'id'), field('p', 'score')] }, direction: 'asc' }]
        }
      }
    };
    const rows = Array.from({ length: 100 }, (_, index): QueryRowOccurrence => ({
      occurrenceId: `window-stateful:${index}`,
      row: { id: index, group: index % 10, score: index, active: true, tags: [] }
    }));
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', rows, 1)], functions };
    const changed = rows.map((entry, index) => index === 55 ? { ...entry, row: { ...entry.row, score: -1 } } : entry);
    const next: QueryMaintenanceSnapshot = { relations: [relation('people', changed, 2)], functions };
    const session = openIncrementalQueryMaintenance(plan(query), initial);
    failingId = 0; // Outside the changed row's partition.

    const maintained = session.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    expect(maintained).toMatchObject({ completeness: 'unknown', rows: [], issues: [expect.objectContaining({ code: 'query.function_failed' })] });
    expect(maintained.state.operatorDiagnostics.window).toMatchObject({ selectiveNodeCount: 0, fullNodeCount: 0, fallbackNodeCount: 1, fallbackReasons: { unsupported_expression: 1 } });
    session.close();
  });

  it('invalidates window values that depend on an external subquery', () => {
    const weights = (value: number, revision: number): RelationInput => relation('weights', [
      { occurrenceId: 'weight:1', row: { id: 1, value } },
      { occurrenceId: 'weight:2', row: { id: 2, value: value + 1 } }
    ], revision);
    const weightForPerson: QueryNode = {
      kind: 'select', alias: 'weight',
      input: {
        kind: 'where', input: from('weights', 'w'),
        predicate: { kind: 'compare', op: 'eq', left: field('w', 'id'), right: field('p', 'id') }
      },
      fields: { value: field('w', 'value') }
    };
    const query: QueryNode = {
      kind: 'window', input: people, alias: 'p', fields: {
        previousWeight: {
          kind: 'window', op: 'lag',
          value: { kind: 'subquery', mode: 'scalar', query: weightForPerson },
          orderBy: [{ value: field('p', 'id'), direction: 'asc' }]
        }
      }
    };
    const initial = snapshot(basePeople, 1);
    const first: QueryMaintenanceSnapshot = { ...initial, relations: [...initial.relations, weights(10, 1)] };
    const second: QueryMaintenanceSnapshot = { ...initial, relations: [...initial.relations, weights(20, 2)] };
    const session = openIncrementalQueryMaintenance(plan(query), first);

    expect(semanticResult(applySnapshot(session, first, second))).toEqual(oracle(query, second));
    session.close();
  });

  it('withdraws a private assertion after a named function returns a non-portable value and later recovers', () => {
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
    const failed = session.applyUpdate(diffQueryMaintenanceSnapshots(initial, failing));
    expect(failed).toMatchObject({ rows: [], completeness: 'unknown', issues: [{ code: 'query.function_failed' }] });
    expect(failed.state).toMatchObject({ revision: 1, rejectedUpdateCount: 0 });

    const result = session.applyUpdate(diffQueryMaintenanceSnapshots(failing, recovered));
    expect(result.rows).toEqual([{ source: 'alpha', value: 1 }, { source: 'beta', value: 3 }]);
    expect(semanticResult(result)).toEqual(oracle(query, recovered));
    expect(result.state).toMatchObject({ revision: 2, rejectedUpdateCount: 0 });
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
      sharedPhysicalNodeCount: 2,
      operatorDiagnostics: { local: { selectiveNodeCount: 0, fullNodeCount: 0, fallbackNodeCount: 0 } }
    });
    expect(Object.isFrozen(runtime.getDiagnostics())).toBe(true);
    expect(Object.isFrozen(runtime.getDiagnostics().operatorDiagnostics)).toBe(true);
    expect(Object.isFrozen(runtime.getDiagnostics().operatorDiagnostics.local.fallbackReasons)).toBe(true);

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
    const pooledLocal = runtime.getDiagnostics().operatorDiagnostics.local;
    expect(pooledLocal.selectiveNodeCount + pooledLocal.fullNodeCount + pooledLocal.fallbackNodeCount).toBe(3);
    for (const root of [idsRoot, namesRoot]) {
      const local = root.getCurrentResult().state.operatorDiagnostics.local;
      expect(local.selectiveNodeCount + local.fullNodeCount + local.fallbackNodeCount).toBe(2);
    }

    idsRoot.close();
    idsRoot.close();
    expect(runtime.getDiagnostics()).toMatchObject({
      activeRootCount: 1,
      physicalNodeCount: 3,
      sharedPhysicalNodeCount: 0,
      lastCollectedPhysicalNodeCount: 1,
      operatorDiagnostics: { local: { selectiveNodeCount: 0, fullNodeCount: 0, fallbackNodeCount: 0 } }
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
    const previousPeople = peopleRoot.getCurrentResult();
    const previousGroups = groupsRoot.getCurrentResult();

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, next));

    const nextPeople = peopleRoot.getCurrentResult();
    const nextGroups = groupsRoot.getCurrentResult();
    expect(nextPeople.state).toMatchObject({ revision: 1, updatedNodeCount: 2, changedNodeCount: 2 });
    expect(nextPeople.rows).not.toBe(previousPeople.rows);
    expect(nextPeople.resultKeys).not.toBe(previousPeople.resultKeys);
    expect(nextGroups).not.toBe(previousGroups);
    expect(nextGroups.state).not.toBe(previousGroups.state);
    expect(nextGroups.state).toMatchObject({ revision: 1, updatedNodeCount: 0, changedNodeCount: 0 });
    expect(nextGroups.rows).toBe(previousGroups.rows);
    expect(nextGroups.resultKeys).toBe(previousGroups.resultKeys);
    expect(nextGroups.issues).toBe(previousGroups.issues);
    expect(semanticResult(nextGroups)).toEqual(oracle(groupsQuery, next));
    expect(runtime.getDiagnostics()).toMatchObject({ lastUpdatedPhysicalNodeCount: 2, lastChangedPhysicalNodeCount: 2 });
    peopleRoot.close();
    groupsRoot.close();
    runtime.close();
  });

  it('reuses every immutable public view across an exact pooled no-op while advancing state', () => {
    const initial = snapshot(basePeople, 1);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/no-op-public-views', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan({ kind: 'select', input: from('people', 'p'), alias: 'result', fields: { id: field('p', 'id') } }));
    const before = root.getCurrentResult();

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, initial));

    const after = root.getCurrentResult();
    expect(after).not.toBe(before);
    expect(after.state).not.toBe(before.state);
    expect(after.state).toMatchObject({ revision: 1, updatedNodeCount: 0, changedNodeCount: 0 });
    expect(after.rows).toBe(before.rows);
    expect(after.resultKeys).toBe(before.resultKeys);
    expect(after.issues).toBe(before.issues);
    expect(after.state.resultDelta).toEqual({ addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] });
    root.close();
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

  it('applies sparse aggregate group movement through the pooled runtime', () => {
    const query = operatorQueries.aggregate as QueryNode;
    const initial = snapshot(basePeople, 1);
    const moved = snapshot([
      basePeople[0] as QueryRowOccurrence,
      { ...(basePeople[1] as QueryRowOccurrence), row: { ...(basePeople[1] as QueryRowOccurrence).row, group: 'x', score: 9, active: true } }
    ], 2);
    const runtime = createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/pooled-sparse-aggregate', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test', parameters: { minimum: 6 }
      },
      initialSnapshot: initial
    });
    const root = runtime.attach(plan(query));

    runtime.applyUpdate(diffQueryMaintenanceSnapshots(initial, moved));

    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, moved));
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
    const residents = residentQueries.map((query, index) => runtime.attach(sealPreparedPlan({ ...plan(query), planId: 'resident:' + index, rootNodeId: 'resident:' + index + ':root' })));

    for (let index = 0; index < 2_500; index += 1) {
      const query = suffix(10_000 + index);
      const root = runtime.attach(sealPreparedPlan({ ...plan(query), planId: 'churn:' + index, rootNodeId: 'churn:' + index + ':root' }));
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

  it('rejects accessor-backed rows at the pooled snapshot boundary', () => {
    const throwingRow: Record<string, import('../src/query.js').QueryLogicalValue> = { id: 1 };
    Object.defineProperty(throwingRow, 'name', { configurable: true, enumerable: true, get: () => { throw new Error('row getter failed'); } });
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', [{ occurrenceId: 'person:throwing', row: throwingRow }], 1)] };
    expect(() => createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/rollback', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test'
      },
      initialSnapshot: initial
    })).toThrow('hostile object descriptor');
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

  it('rolls back an update when changed-row adoption throws', () => {
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

    expect(() => runtime.applyUpdate(failingUpdate)).toThrow('hostile object descriptor');
    expect(root.getCurrentResult()).toBe(beforeResult);
    expect(runtime.getDiagnostics()).toBe(beforeDiagnostics);

    runtime.applyUpdate(validUpdate);
    expect(semanticResult(root.getCurrentResult())).toEqual(oracle(query, next));
    expect(runtime.getDiagnostics()).toMatchObject({ revision: 1, rejectedUpdateCount: 0 });
    root.close();
    runtime.close();
  });

  it('rejects accessor-backed initial rows before retaining incremental state', () => {
    const guardedRow: QueryRecord = { id: 1 };
    Object.defineProperty(guardedRow, 'value', {
      enumerable: true,
      get: () => 'one'
    });
    const initialPeople: readonly QueryRowOccurrence[] = [{ occurrenceId: 'person:guarded', row: guardedRow }];
    const initial: QueryMaintenanceSnapshot = { relations: [relation('people', initialPeople, 1)] };
    expect(() => createPooledIncrementalQueryRuntime({
      environment: {
        runtimeIdentity: 'database:test/update-delta-rollback', registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test', datasetId: 'dataset:test'
      },
      initialSnapshot: initial
    })).toThrow('hostile object descriptor');
  });

  it('rejects an accessor-backed initial snapshot without invoking the accessor', () => {
    let calls = 0;
    const initial: Record<string, unknown> = {};
    Object.defineProperty(initial, 'relations', {
      enumerable: true,
      get: () => { calls += 1; return []; }
    });

    expect(() => openIncrementalQueryMaintenance(
      plan({ kind: 'values', alias: 'constant', rows: [] }),
      initial as never
    )).toThrow(/Query maintenance snapshot contains a hostile object descriptor/);
    expect(calls).toBe(0);
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
