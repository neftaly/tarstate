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
  type QueryRecord
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
});

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
