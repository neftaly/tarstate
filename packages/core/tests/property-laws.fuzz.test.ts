import fc from 'fast-check';
import { describe, expect } from 'vitest';
import {
  artifactSemanticValue,
  canonicalizeJson,
  diffQueryMaintenanceSnapshots,
  evaluateQuery,
  openIncrementalQueryMaintenance,
  parseArtifactText,
  safeParseJsonValue,
  sealArtifact,
  sha256Json,
  type ArtifactRef,
  type JsonValue,
  type QueryMaintenanceSnapshot,
  type QueryNode,
  type QueryRecord,
  type RelationInput
} from '../src/index.js';
import { sealPreparedPlan } from '../src/internal-prepared-plan.js';
import { propertyTest } from './support/property-test.js';

const portableJson = fc.jsonValue({ maxDepth: 5 }).filter((value) => safeParseJsonValue(value).success);
const hash = (digit: number): `sha256:${string}` => `sha256:${(digit & 15).toString(16).repeat(64)}`;
const schemaView: ArtifactRef = { id: 'urn:test:property-schema', contentHash: hash(10) };
const relation = { schemaView, relationId: 'property.rows' } as const;
const query: QueryNode = {
  kind: 'unnest', alias: 'item', field: 'value', expression: { kind: 'field', alias: 'result', name: 'tags' },
  input: {
    kind: 'omit', alias: 'result', fields: ['temporary'],
    input: {
      kind: 'rename', alias: 'result', fields: { copied: 'temporary' },
      input: {
        kind: 'with-fields', alias: 'result', fields: { copied: { kind: 'field', alias: 'result', name: 'value' } },
        input: {
          kind: 'select', alias: 'result',
          input: { kind: 'where', input: { kind: 'from', relation, alias: 'row' }, predicate: { kind: 'field', alias: 'row', name: 'active' } },
          fields: {
            id: { kind: 'field', alias: 'row', name: 'id' },
            value: { kind: 'field', alias: 'row', name: 'value' },
            active: { kind: 'field', alias: 'row', name: 'active' },
            tags: { kind: 'field', alias: 'row', name: 'tags' },
            source: { kind: 'source-of', alias: 'row' }
          }
        }
      }
    }
  }
};
const plan = sealPreparedPlan({ planId: 'property-laws', rootNodeId: 'property-laws:root', query, registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' });
const globalQueries: readonly QueryNode[] = [
  {
    kind: 'order', input: { kind: 'from', relation, alias: 'row' },
    by: [{ value: { kind: 'field', alias: 'row', name: 'value' }, direction: 'asc' }]
  },
  {
    kind: 'aggregate', input: { kind: 'from', relation, alias: 'row' }, alias: 'summary',
    groupBy: { group: { kind: 'field', alias: 'row', name: 'group' } },
    measures: {
      count: { kind: 'aggregate', op: 'count' },
      distinct: { kind: 'aggregate', op: 'count-distinct', value: { kind: 'field', alias: 'row', name: 'value' } },
      sum: { kind: 'aggregate', op: 'sum', value: { kind: 'field', alias: 'row', name: 'score' } },
      average: { kind: 'aggregate', op: 'average', value: { kind: 'field', alias: 'row', name: 'score' } },
      minimum: { kind: 'aggregate', op: 'minimum', value: { kind: 'field', alias: 'row', name: 'value' } },
      maximum: { kind: 'aggregate', op: 'maximum', value: { kind: 'field', alias: 'row', name: 'value' } },
      any: { kind: 'aggregate', op: 'any', value: { kind: 'field', alias: 'row', name: 'active' } },
      every: { kind: 'aggregate', op: 'every', value: { kind: 'field', alias: 'row', name: 'active' } },
      first: { kind: 'aggregate', op: 'first', value: { kind: 'field', alias: 'row', name: 'id' }, orderBy: [{ value: { kind: 'field', alias: 'row', name: 'value' }, direction: 'asc' }] },
      last: { kind: 'aggregate', op: 'last', value: { kind: 'field', alias: 'row', name: 'id' }, orderBy: [{ value: { kind: 'field', alias: 'row', name: 'value' }, direction: 'asc' }] },
      values: { kind: 'aggregate', op: 'collect', value: { kind: 'field', alias: 'row', name: 'value' } }
    }
  }
];

describe('shrinking property laws', () => {
  propertyTest('execution-budgeted-products-never-publish-partial-results', fc.property(
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 2_000 }),
    (leftCount, rightCount, maxWorkUnits) => {
      const values = (alias: string, count: number): QueryNode => ({ kind: 'values', alias, rows: Array.from({ length: count }, (_, id) => ({ id })) });
      const root: QueryNode = { kind: 'join', join: 'cross', left: values('left', leftCount), right: values('right', rightCount) };
      const result = evaluateQuery({ root, relations: [], executionBudget: { maxWorkUnits } });
      if (result.completeness === 'exact') {
        expect(result.rows).toHaveLength(leftCount * rightCount);
        expect(result.issues).toEqual([]);
      } else {
        expect(result.rows).toEqual([]);
        expect(result.resultKeys).toEqual([]);
        expect(result.issues).toMatchObject([{ code: 'query.execution_budget_exceeded' }]);
      }
    }
  ));

  propertyTest('canonical-json-round-trip', fc.property(portableJson, (value) => {
    const canonical = canonicalizeJson(value as JsonValue);
    expect(canonicalizeJson(JSON.parse(canonical) as JsonValue)).toBe(canonical);
  }));

  propertyTest('canonical-json-object-order-invariance', fc.property(
    fc.dictionary(fc.string({ maxLength: 12 }), portableJson, { maxKeys: 12 }),
    (record) => {
      const reversed = Object.fromEntries(Object.entries(record).reverse()) as JsonValue;
      expect(canonicalizeJson(record as JsonValue)).toBe(canonicalizeJson(reversed));
    }
  ));

  propertyTest('artifact-seal-parse-and-dependency-normalization', fc.asyncProperty(
    portableJson,
    fc.uniqueArray(fc.record({
      id: fc.string({ minLength: 1, maxLength: 24 }).map((id) => 'urn:test:dependency:' + id),
      digit: fc.integer({ min: 0, max: 15 }),
      locations: fc.array(fc.webUrl(), { maxLength: 3 })
    }), { maxLength: 8, selector: ({ id }) => id }),
    async (body, generatedDependencies) => {
      const dependencies = generatedDependencies.map(({ id, digit, locations }) => ({ id, contentHash: hash(digit), locations }));
      const artifact = await sealArtifact({ kind: 'query', id: 'urn:test:property-query', dependencies, body: body as JsonValue });
      const resealed = await sealArtifact({ kind: 'query', id: 'urn:test:property-query', dependencies: [...dependencies].reverse(), body: body as JsonValue });
      expect(resealed).toEqual(artifact);
      expect(artifact.contentHash).toBe(await sha256Json(artifactSemanticValue(artifact)));
      expect(await parseArtifactText(JSON.stringify(artifact))).toEqual(artifact);
    }
  ));

  propertyTest('query-snapshot-diffs-compose-to-oracle-equivalent-results', fc.property(
    fc.array(rowSetArbitrary(), { minLength: 1, maxLength: 10 }),
    (rowSets) => {
      const snapshots = rowSets.map(snapshot);
      const incremental = openIncrementalQueryMaintenance(plan, snapshots[0] as QueryMaintenanceSnapshot);
      for (let index = 1; index < snapshots.length; index += 1) {
        const previous = snapshots[index - 1] as QueryMaintenanceSnapshot;
        const next = snapshots[index] as QueryMaintenanceSnapshot;
        const result = incremental.applyUpdate(diffQueryMaintenanceSnapshots(previous, next));
        expect(withoutMaintenanceState(result)).toEqual(evaluateQuery({ root: query, relations: next.relations, ...(next.basis === undefined ? {} : { basis: next.basis }) }));
      }
      const finalSnapshot = snapshots.at(-1) as QueryMaintenanceSnapshot;
      const direct = openIncrementalQueryMaintenance(plan, snapshots[0] as QueryMaintenanceSnapshot);
      const directResult = direct.applyUpdate(diffQueryMaintenanceSnapshots(snapshots[0] as QueryMaintenanceSnapshot, finalSnapshot));
      expect(withoutMaintenanceState(directResult)).toEqual(withoutMaintenanceState(incremental.getCurrentResult()));
      direct.close();
      incremental.close();
    }
  ));

  propertyTest('local-filter-membership-and-unnest-width-transitions-remain-oracle-equivalent', fc.property(
    propertyRowArbitrary(),
    (generated) => {
      const states = [
        [{ ...generated, active: false, tags: [1] }],
        [{ ...generated, active: true, tags: [1] }],
        [{ ...generated, active: true, tags: [1, 2] }],
        [{ ...generated, active: true, tags: [] }],
        [{ ...generated, active: false, tags: [3] }]
      ].map(snapshot);
      const incremental = openIncrementalQueryMaintenance(plan, states[0] as QueryMaintenanceSnapshot);
      for (let index = 1; index < states.length; index += 1) {
        const previous = states[index - 1] as QueryMaintenanceSnapshot;
        const next = states[index] as QueryMaintenanceSnapshot;
        const maintained = incremental.applyUpdate(diffQueryMaintenanceSnapshots(previous, next));
        expect(withoutMaintenanceState(maintained)).toEqual(evaluateQuery({ root: query, relations: next.relations, ...(next.basis === undefined ? {} : { basis: next.basis }) }));
      }
      incremental.close();
    }
  ));

  propertyTest('global-operator-updates-remain-pure-oracle-equivalent', fc.property(
    fc.array(rowSetArbitrary(), { minLength: 1, maxLength: 8 }),
    (rowSets) => {
      const snapshots = rowSets.map(snapshot);
      for (const [queryIndex, globalQuery] of globalQueries.entries()) {
        const globalPlan = sealPreparedPlan({ planId: `property-global:${queryIndex}`, rootNodeId: `property-global:${queryIndex}:root`, query: globalQuery, registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' });
        const incremental = openIncrementalQueryMaintenance(globalPlan, snapshots[0] as QueryMaintenanceSnapshot);
        for (let index = 1; index < snapshots.length; index += 1) {
          const previous = snapshots[index - 1] as QueryMaintenanceSnapshot;
          const next = snapshots[index] as QueryMaintenanceSnapshot;
          const maintained = incremental.applyUpdate(diffQueryMaintenanceSnapshots(previous, next));
          const basis = next.basis;
          expect(withoutMaintenanceState(maintained)).toEqual(evaluateQuery({ root: globalQuery, relations: next.relations, ...(basis === undefined ? {} : { basis }) }));
        }
        incremental.close();
      }
    }
  ));

  propertyTest('skewed-join-command-sequences-remain-oracle-equivalent', fc.property(
    fc.array(joinCommandArbitrary, { maxLength: 12 }),
    (commands) => {
      let model = initialJoinModel();
      let accepted = joinSnapshot(model, 0);
      const incremental = openIncrementalQueryMaintenance(propertyPlan('join-commands', joinCommandQuery), accepted);
      commands.forEach((command, index) => {
        model = applyJoinCommand(model, command);
        const next = joinSnapshot(model, index + 1);
        const maintained = incremental.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
        expect(withoutMaintenanceState(maintained)).toEqual(evaluateQuery({ root: joinCommandQuery, relations: next.relations, ...(next.basis === undefined ? {} : { basis: next.basis }) }));
        accepted = next;
      });
      incremental.close();
    }
  ));

  propertyTest('partitioned-window-command-sequences-remain-oracle-equivalent', fc.property(
    fc.array(windowCommandArbitrary, { maxLength: 10 }),
    (commands) => {
      let model = initialWindowModel();
      let accepted = windowSnapshot(model, 0);
      const queries = [partitionedWindowQuery, externalWindowQuery];
      const sessions = queries.map((candidate, index) => openIncrementalQueryMaintenance(propertyPlan('window-commands:' + index, candidate), accepted));
      commands.forEach((command, index) => {
        model = applyWindowCommand(model, command);
        const next = windowSnapshot(model, index + 1);
        sessions.forEach((session, queryIndex) => {
          const maintained = session.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
          expect(withoutMaintenanceState(maintained)).toEqual(evaluateQuery({ root: queries[queryIndex] as QueryNode, relations: next.relations, ...(next.basis === undefined ? {} : { basis: next.basis }) }));
        });
        accepted = next;
      });
      sessions.forEach((session) => session.close());
    }
  ));

  propertyTest('recursive-equijoin-directions-match-bounded-graph-bfs', fc.property(
    fc.uniqueArray(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })), { maxLength: 20, selector: ([from, to]) => from + ':' + to }),
    fc.integer({ min: 0, max: 7 }),
    (generatedEdges, start) => {
      const edges = generatedEdges.map(([from, to], index) => ({ id: index, from, to }));
      const expected = graphReachability(edges, start);
      const relations: readonly RelationInput[] = [{ relation: graphRelation, rows: edges, completeness: 'exact' }];
      for (const reversed of [false, true]) {
        const recursive = graphQuery(start, reversed);
        const result = evaluateQuery({ root: recursive, relations });
        expect(result.completeness).toBe('exact');
        expect(result.rows.map((row) => row.id as number).sort((left, right) => left - right)).toEqual(expected);
        expect(new Set(result.resultKeys).size).toBe(expected.length);
      }
    }
  ));
});

const field = (alias: string, name: string) => ({ kind: 'field', alias, name } as const);
const relationUse = (relationId: string) => ({ schemaView, relationId } as const);
const propertyPlan = (id: string, root: QueryNode) => sealPreparedPlan({ planId: id, rootNodeId: id + ':root', query: root, registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' });

type JoinSide = 'left' | 'right';
type JoinRow = { readonly id: number; readonly key: number; readonly payload: number };
type JoinModel = { readonly left: ReadonlyMap<number, JoinRow>; readonly right: ReadonlyMap<number, JoinRow> };
type JoinCommand =
  | { readonly kind: 'replace'; readonly side: JoinSide; readonly id: number; readonly payload: number }
  | { readonly kind: 'move'; readonly side: JoinSide; readonly id: number; readonly key: number }
  | { readonly kind: 'insert'; readonly side: JoinSide; readonly id: number; readonly key: number; readonly payload: number }
  | { readonly kind: 'delete'; readonly side: JoinSide; readonly id: number }
  | { readonly kind: 'bulk'; readonly side: JoinSide; readonly key: number; readonly payload: number };

const joinCommandArbitrary: fc.Arbitrary<JoinCommand> = fc.oneof(
  fc.record({ kind: fc.constant('replace' as const), side: fc.constantFrom('left' as const, 'right' as const), id: fc.integer({ min: 0, max: 9 }), payload: fc.integer({ min: -5, max: 5 }) }),
  fc.record({ kind: fc.constant('move' as const), side: fc.constantFrom('left' as const, 'right' as const), id: fc.integer({ min: 0, max: 9 }), key: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ kind: fc.constant('insert' as const), side: fc.constantFrom('left' as const, 'right' as const), id: fc.integer({ min: 0, max: 9 }), key: fc.integer({ min: 0, max: 3 }), payload: fc.integer({ min: -5, max: 5 }) }),
  fc.record({ kind: fc.constant('delete' as const), side: fc.constantFrom('left' as const, 'right' as const), id: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant('bulk' as const), side: fc.constantFrom('left' as const, 'right' as const), key: fc.integer({ min: 0, max: 3 }), payload: fc.integer({ min: -5, max: 5 }) })
);

const joinCommandQuery: QueryNode = {
  kind: 'join', join: 'inner',
  left: { kind: 'from', relation: relationUse('property.join.left'), alias: 'left' },
  right: { kind: 'from', relation: relationUse('property.join.right'), alias: 'right' },
  on: { kind: 'compare', op: 'eq', left: field('left', 'key'), right: field('right', 'key') }
};

const initialJoinModel = (): JoinModel => ({
  left: new Map(Array.from({ length: 6 }, (_, id) => [id, { id, key: id % 2, payload: id }])),
  right: new Map(Array.from({ length: 6 }, (_, id) => [id, { id, key: id % 2, payload: id }]))
});

const applyJoinCommand = (model: JoinModel, command: JoinCommand): JoinModel => {
  const rows = new Map(model[command.side]);
  const current = 'id' in command ? rows.get(command.id) : undefined;
  if (command.kind === 'replace' && current !== undefined) rows.set(command.id, { ...current, payload: command.payload });
  else if (command.kind === 'move' && current !== undefined) rows.set(command.id, { ...current, key: command.key });
  else if (command.kind === 'insert') rows.set(command.id, { id: command.id, key: command.key, payload: command.payload });
  else if (command.kind === 'delete') rows.delete(command.id);
  else if (command.kind === 'bulk') for (const [id, row] of rows) rows.set(id, { ...row, key: command.key, payload: command.payload });
  return { ...model, [command.side]: rows };
};

const joinSnapshot = (model: JoinModel, revision: number): QueryMaintenanceSnapshot => ({
  relations: (['left', 'right'] as const).map((side) => {
    const rows = [...model[side].values()];
    return { relation: relationUse('property.join.' + side), rows, occurrenceIds: rows.map(({ id }) => side + ':' + id), completeness: 'exact' as const, sourceId: 'source:' + side, attachmentId: 'attachment:' + side, basis: revision };
  }),
  basis: { revision }
});

type WindowRow = { readonly id: number; readonly group: number; readonly value: number };
type WindowModel = { readonly rows: readonly WindowRow[]; readonly weights: ReadonlyMap<number, number> };
type WindowCommand =
  | { readonly kind: 'value'; readonly id: number; readonly value: number }
  | { readonly kind: 'move'; readonly id: number; readonly group: number }
  | { readonly kind: 'insert'; readonly id: number; readonly group: number; readonly value: number }
  | { readonly kind: 'delete'; readonly id: number }
  | { readonly kind: 'reorder'; readonly offset: number }
  | { readonly kind: 'external'; readonly id: number; readonly value: number };

const windowCommandArbitrary: fc.Arbitrary<WindowCommand> = fc.oneof(
  fc.record({ kind: fc.constant('value' as const), id: fc.integer({ min: 0, max: 9 }), value: fc.integer({ min: -5, max: 5 }) }),
  fc.record({ kind: fc.constant('move' as const), id: fc.integer({ min: 0, max: 9 }), group: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ kind: fc.constant('insert' as const), id: fc.integer({ min: 0, max: 9 }), group: fc.integer({ min: 0, max: 2 }), value: fc.integer({ min: -5, max: 5 }) }),
  fc.record({ kind: fc.constant('delete' as const), id: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant('reorder' as const), offset: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant('external' as const), id: fc.integer({ min: 0, max: 9 }), value: fc.integer({ min: -5, max: 5 }) })
);

const windowInput: QueryNode = { kind: 'from', relation: relationUse('property.window.rows'), alias: 'row' };
const windowSpecification = { partitionBy: [field('row', 'group')], orderBy: [{ value: field('row', 'value'), direction: 'asc' as const }] };
const partitionedWindowQuery: QueryNode = { kind: 'window', input: windowInput, alias: 'row', fields: {
  rowNumber: { kind: 'window', op: 'row-number', ...windowSpecification },
  rank: { kind: 'window', op: 'rank', ...windowSpecification },
  previous: { kind: 'window', op: 'lag', value: field('row', 'value'), ...windowSpecification }
} };
const externalWeight: QueryNode = {
  kind: 'select', alias: 'weight',
  input: { kind: 'where', input: { kind: 'from', relation: relationUse('property.window.weights'), alias: 'weightRow' }, predicate: { kind: 'compare', op: 'eq', left: field('weightRow', 'id'), right: field('row', 'id') } },
  fields: { value: field('weightRow', 'value') }
};
const externalWindowQuery: QueryNode = { kind: 'window', input: windowInput, alias: 'row', fields: {
  previousWeight: { kind: 'window', op: 'lag', value: { kind: 'subquery', mode: 'scalar', query: externalWeight }, ...windowSpecification }
} };

const initialWindowModel = (): WindowModel => ({
  rows: Array.from({ length: 6 }, (_, id) => ({ id, group: id % 3, value: id })),
  weights: new Map(Array.from({ length: 10 }, (_, id) => [id, id * 10]))
});

const applyWindowCommand = (model: WindowModel, command: WindowCommand): WindowModel => {
  if (command.kind === 'external') return { ...model, weights: new Map(model.weights).set(command.id, command.value) };
  if (command.kind === 'reorder') {
    if (model.rows.length === 0) return model;
    const offset = command.offset % model.rows.length;
    return { ...model, rows: [...model.rows.slice(offset), ...model.rows.slice(0, offset)] };
  }
  const rows = [...model.rows];
  const index = rows.findIndex(({ id }) => id === command.id);
  if (command.kind === 'insert') {
    const next = { id: command.id, group: command.group, value: command.value };
    if (index < 0) rows.push(next); else rows[index] = next;
  } else if (command.kind === 'delete') {
    if (index >= 0) rows.splice(index, 1);
  } else if (index >= 0) {
    const current = rows[index] as WindowRow;
    rows[index] = command.kind === 'value' ? { ...current, value: command.value } : { ...current, group: command.group };
  }
  return { ...model, rows };
};

const windowSnapshot = (model: WindowModel, revision: number): QueryMaintenanceSnapshot => ({
  relations: [
    { relation: relationUse('property.window.rows'), rows: model.rows, occurrenceIds: model.rows.map(({ id }) => 'row:' + id), completeness: 'exact', sourceId: 'source:window', attachmentId: 'attachment:window', basis: revision },
    { relation: relationUse('property.window.weights'), rows: [...model.weights].map(([id, value]) => ({ id, value })), occurrenceIds: [...model.weights.keys()].map((id) => 'weight:' + id), completeness: 'exact', sourceId: 'source:weights', attachmentId: 'attachment:weights', basis: revision }
  ],
  basis: { revision }
});

const graphRelation = relationUse('property.graph.edges');
const graphQuery = (start: number, reversed: boolean): QueryNode => ({
  kind: 'recursive', name: 'reachable', seed: { kind: 'values', alias: 'node', rows: [{ id: start }] },
  step: {
    kind: 'select', alias: 'node',
    input: reversed
      ? { kind: 'join', join: 'inner', left: { kind: 'from', relation: graphRelation, alias: 'edge' }, right: { kind: 'recursion-ref', name: 'reachable' }, on: { kind: 'compare', op: 'eq', left: field('edge', 'from'), right: field('node', 'id') } }
      : { kind: 'join', join: 'inner', left: { kind: 'recursion-ref', name: 'reachable' }, right: { kind: 'from', relation: graphRelation, alias: 'edge' }, on: { kind: 'compare', op: 'eq', left: field('node', 'id'), right: field('edge', 'from') } },
    fields: { id: field('edge', 'to') }
  },
  key: [field('node', 'id')], maxIterations: 9, maxRows: 8
});

const graphReachability = (edges: readonly { readonly from: number; readonly to: number }[], start: number): readonly number[] => {
  const reached = new Set([start]);
  const frontier = [start];
  while (frontier.length > 0) {
    const current = frontier.shift() as number;
    for (const edge of edges) if (edge.from === current && !reached.has(edge.to)) { reached.add(edge.to); frontier.push(edge.to); }
  }
  return [...reached].sort((left, right) => left - right);
};

function propertyRowArbitrary() {
  return fc.record({
  id: fc.integer({ min: 0, max: 30 }),
  value: fc.oneof(fc.integer({ min: -100, max: 100 }), fc.string({ maxLength: 12 }), fc.boolean()),
  group: fc.integer({ min: -2, max: 2 }),
  score: fc.integer({ min: -100, max: 100 }),
  active: fc.boolean(),
  tags: fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 3 })
  });
}

const rowSetArbitrary = () => fc.uniqueArray(propertyRowArbitrary(), { maxLength: 12, selector: ({ id }) => id });

type PropertyRow = {
  readonly id: number;
  readonly value: number | string | boolean;
  readonly group: number;
  readonly score: number;
  readonly active: boolean;
  readonly tags: readonly number[];
};

const snapshot = (rows: readonly PropertyRow[], revision: number): QueryMaintenanceSnapshot => ({
  relations: [{ relation, rows: rows.map(({ id, value, group, score, active, tags }): QueryRecord => ({ id, value, group, score, active, tags })), occurrenceIds: rows.map(({ id }) => 'row:' + id), completeness: 'exact', sourceId: 'source:property', attachmentId: 'attachment:property', basis: revision }],
  basis: { revision },
  membershipRevision: 0
});

const withoutMaintenanceState = <T extends { readonly state?: unknown }>(result: T): Omit<T, 'state'> => {
  const { state: _state, ...publicResult } = result;
  return publicResult;
};
