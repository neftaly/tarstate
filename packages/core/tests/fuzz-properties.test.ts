import { describe, expect, it } from 'vitest';
import {
  diffQueryMaintenanceSnapshots,
  evaluateQuery,
  openIncrementalQueryMaintenance,
  resolveLensPath,
  safeParseReceipt,
  type ArtifactRef,
  type IncrementalQueryResult,
  type JsonValue,
  type LensArtifact,
  type QueryMaintenanceSnapshot,
  type QueryNode,
  type QueryRecord,
  type RelationInput
} from '../src/index.js';
import { createPooledIncrementalQueryRuntime, type PooledIncrementalQueryRoot } from '../src/query.js';

const configuredRuns = Number.parseInt(process.env.TARSTATE_FUZZ_RUNS ?? '64', 10);
const runs = Number.isSafeInteger(configuredRuns) && configuredRuns > 0 ? configuredRuns : 64;
const configuredSeed = Number.parseInt(process.env.TARSTATE_FUZZ_SEED ?? '1597463007', 10);
const initialSeed = Number.isSafeInteger(configuredSeed) ? configuredSeed >>> 0 : 1_597_463_007;
const random = seededRandom(initialSeed);
const integer = (limit: number): number => Math.floor(random() * limit);
const hash = (value: number): `sha256:${string}` => `sha256:${(value % 16).toString(16).repeat(64)}`;
const schemaView: ArtifactRef = { id: 'urn:test:fuzz-schema', contentHash: hash(10) };
const relation = { schemaView, relationId: 'fuzz.rows' } as const;
const query: QueryNode = {
  kind: 'select',
  alias: 'result',
  input: { kind: 'from', relation, alias: 'row' },
  fields: {
    id: { kind: 'field', alias: 'row', name: 'id' },
    value: { kind: 'field', alias: 'row', name: 'value' },
    source: { kind: 'source-of', alias: 'row' }
  }
};
const plan = { planId: 'fuzz', rootNodeId: 'fuzz:root', query, registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' };

type FuzzRow = { readonly occurrenceId: string; readonly row: QueryRecord };
type FuzzSource = { readonly sourceId: string; readonly attachmentId?: string; revision: number; nextId: number; rows: FuzzRow[] };

describe('deterministic fuzz properties (seed ' + initialSeed + ')', () => {
  it('keeps multi-source bag identity unique and incremental results oracle-equivalent', () => {
    for (let run = 0; run < runs; run += 1) {
      const sources = Array.from({ length: 1 + integer(4) }, (_, sourceIndex): FuzzSource => {
        const rowCount = integer(6);
        return {
          sourceId: 'source:' + sourceIndex,
          ...(sourceIndex % 2 === 0 ? { attachmentId: 'attachment:' + sourceIndex } : {}),
          revision: 0,
          nextId: rowCount,
          rows: Array.from({ length: rowCount }, (_, rowIndex) => ({ occurrenceId: 'local:' + rowIndex, row: { id: rowIndex, value: integer(100) } }))
        };
      });
      const snapshot = (): QueryMaintenanceSnapshot => ({
        relations: sources.map(relationInput),
        basis: { revisions: sources.map(({ revision }) => revision) },
        membershipRevision: 0
      });
      let accepted = snapshot();
      const session = openIncrementalQueryMaintenance(plan, accepted);
      let previous = identityMap(session.getCurrentResult());
      for (let step = 0; step < 16; step += 1) {
        const source = sources[integer(sources.length)] as FuzzSource;
        const operation = integer(3);
        if (operation === 0 && source.rows.length > 0) {
          const index = integer(source.rows.length);
          const current = source.rows[index] as FuzzRow;
          source.rows[index] = { ...current, row: { ...current.row, value: integer(1_000) } };
        } else if (operation === 1 && source.rows.length > 0) {
          source.rows.splice(integer(source.rows.length), 1);
        } else {
          const id = source.nextId++;
          source.rows.push({ occurrenceId: 'local:' + id, row: { id, value: integer(1_000) } });
        }
        source.revision += 1;
        const next = snapshot();
        const maintained = session.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
        accepted = next;
        expect(withoutState(maintained), 'run ' + run + ', step ' + step).toEqual(evaluateQuery({
          root: query,
          relations: next.relations,
          ...(next.basis === undefined ? {} : { basis: next.basis }),
          ...(next.membershipRevision === undefined ? {} : { membershipRevision: next.membershipRevision })
        }));
        expect(new Set(maintained.resultKeys).size, 'run ' + run + ', step ' + step).toBe(maintained.resultKeys.length);
        const current = identityMap(maintained);
        for (const [identity, key] of previous) if (current.has(identity)) expect(current.get(identity), identity).toBe(key);
        previous = current;
      }
      session.close();
    }
  });

  it('keeps every maintained operator oracle-equivalent across two-sided row changes and reordering', () => {
    const itemUse = { schemaView, relationId: 'fuzz.items' } as const;
    const groupUse = { schemaView, relationId: 'fuzz.groups' } as const;
    const from = (relation: typeof itemUse | typeof groupUse, alias: string): QueryNode => ({ kind: 'from', relation, alias });
    const field = (alias: string, name: string) => ({ kind: 'field', alias, name } as const);
    const items = from(itemUse, 'item');
    const groups = from(groupUse, 'group');
    const equality = { kind: 'compare', op: 'eq', left: field('item', 'groupId'), right: field('group', 'id') } as const;
    const joined = (join: 'inner' | 'left'): QueryNode => ({ kind: 'join', join, left: items, right: groups, on: equality });
    const queries: readonly QueryNode[] = [
      { kind: 'select', alias: 'result', input: { kind: 'where', input: items, predicate: field('item', 'active') }, fields: { id: field('item', 'id'), score: field('item', 'score') } },
      joined('inner'),
      joined('left'),
      { kind: 'aggregate', input: items, alias: 'summary', groupBy: { groupId: field('item', 'groupId') }, measures: { count: { kind: 'aggregate', op: 'count' }, sum: { kind: 'aggregate', op: 'sum', value: field('item', 'score') } } },
      { kind: 'distinct', input: { kind: 'select', alias: 'result', input: items, fields: { groupId: field('item', 'groupId') } } },
      { kind: 'set', op: 'union-all', left: items, right: { kind: 'values', alias: 'item', rows: [{ id: 'constant', groupId: 'g0', score: 0, active: true }] } },
      { kind: 'order', input: items, by: [{ value: field('item', 'score'), direction: 'desc' }] },
      { kind: 'window', input: items, alias: 'item', fields: { rank: { kind: 'window', op: 'rank', partitionBy: [field('item', 'groupId')], orderBy: [{ value: field('item', 'score'), direction: 'desc' }] } } }
    ];
    const makeInput = (relation: typeof itemUse | typeof groupUse, rows: readonly FuzzRow[], revision: number): RelationInput => ({
      relation,
      rows: rows.map(({ row }) => row),
      occurrenceIds: rows.map(({ occurrenceId }) => occurrenceId),
      completeness: 'exact',
      sourceId: 'source:' + relation.relationId,
      attachmentId: 'attachment:' + relation.relationId,
      basis: revision
    });
    for (let run = 0; run < runs; run += 1) {
      let itemRevision = 0;
      let groupRevision = 0;
      let nextItem = 4;
      let itemRows: FuzzRow[] = Array.from({ length: 4 }, (_, id) => ({ occurrenceId: 'item:' + id, row: { id, groupId: 'g' + id % 2, score: integer(100), active: id % 2 === 0 } }));
      let groupRows: FuzzRow[] = [
        { occurrenceId: 'group:0', row: { id: 'g0', label: 'zero' } },
        { occurrenceId: 'group:1', row: { id: 'g1', label: 'one' } }
      ];
      const snapshot = (): QueryMaintenanceSnapshot => ({ relations: [makeInput(itemUse, itemRows, itemRevision), makeInput(groupUse, groupRows, groupRevision)], basis: { itemRevision, groupRevision } });
      const selectedQuery = queries[run % queries.length] as QueryNode;
      let accepted = snapshot();
      const session = openIncrementalQueryMaintenance({ ...plan, planId: 'operator:' + run, query: selectedQuery }, accepted);
      for (let step = 0; step < 12; step += 1) {
        const mutateItems = integer(3) !== 0;
        const target = mutateItems ? itemRows : groupRows;
        const operation = integer(4);
        if (operation === 0 && target.length > 1) {
          const first = integer(target.length);
          const second = integer(target.length);
          [target[first], target[second]] = [target[second] as FuzzRow, target[first] as FuzzRow];
        } else if (operation === 1 && target.length > 0) {
          const index = integer(target.length);
          const current = target[index] as FuzzRow;
          target[index] = { ...current, row: mutateItems ? { ...current.row, score: integer(1_000), active: random() < 0.5 } : { ...current.row, label: 'label:' + integer(1_000) } };
        } else if (operation === 2 && mutateItems) {
          const id = nextItem++;
          target.push({ occurrenceId: 'item:' + id, row: { id, groupId: 'g' + integer(2), score: integer(1_000), active: random() < 0.5 } });
        } else if (target.length > 1) target.splice(integer(target.length), 1);
        if (mutateItems) itemRevision += 1;
        else groupRevision += 1;
        const next = snapshot();
        const maintained = session.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
        expect(withoutState(maintained), 'operator run ' + run + ', step ' + step).toEqual(evaluateQuery({ root: selectedQuery, relations: next.relations, ...(next.basis === undefined ? {} : { basis: next.basis }) }));
        accepted = next;
      }
      session.close();
    }
  });

  it('keeps pooled multi-root lifecycle and rejection recovery oracle-equivalent', () => {
    const stateRandom = seededRandom(initialSeed ^ 0x51A7_EF01);
    const stateInteger = (limit: number): number => Math.floor(stateRandom() * limit);
    const stateRuns = Math.min(runs, 48);
    const stateSteps = 24;
    const fromRows = (): QueryNode => ({ kind: 'from', relation, alias: 'row' });
    const field = (name: string) => ({ kind: 'field', alias: 'row', name } as const);
    const sharedPrefix = (): QueryNode => ({
      kind: 'where',
      input: fromRows(),
      predicate: { kind: 'compare', op: 'gte', left: field('score'), right: { kind: 'literal', value: 0 } }
    });
    const queryVariant = (variant: number): QueryNode => {
      if (variant === 0) return {
        kind: 'select', input: sharedPrefix(), alias: 'result',
        fields: { id: field('id'), value: field('value') }
      };
      if (variant === 1) return {
        kind: 'aggregate', input: sharedPrefix(), alias: 'summary', groupBy: {},
        measures: {
          count: { kind: 'aggregate', op: 'count' },
          total: { kind: 'aggregate', op: 'sum', value: field('score') }
        }
      };
      return { kind: 'order', input: sharedPrefix(), by: [{ value: field('score'), direction: 'desc' }] };
    };
    type LiveRoot = { readonly root: PooledIncrementalQueryRoot; readonly query: QueryNode; readonly variant: number };

    for (let run = 0; run < stateRuns; run += 1) {
      let revision = 0;
      let nextId = 3;
      let rows: FuzzRow[] = Array.from({ length: 3 }, (_, id) => ({
        occurrenceId: 'pooled:' + id,
        row: { id, value: 'value:' + id, score: stateInteger(100) }
      }));
      const snapshot = (items: readonly FuzzRow[] = rows, basis = revision): QueryMaintenanceSnapshot => ({
        relations: [{
          relation,
          rows: items.map(({ row }) => row),
          occurrenceIds: items.map(({ occurrenceId }) => occurrenceId),
          completeness: 'exact',
          sourceId: 'source:pooled',
          attachmentId: 'attachment:pooled',
          basis
        }],
        basis: { revision: basis },
        membershipRevision: 0
      });
      let accepted = snapshot();
      const runtime = createPooledIncrementalQueryRuntime({
        environment: { runtimeIdentity: 'fuzz:pool:' + run, registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' },
        initialSnapshot: accepted
      });
      const live: LiveRoot[] = [];
      const attach = (variant = stateInteger(3)): void => {
        const rootQuery = queryVariant(variant);
        live.push({
          root: runtime.attach({ ...plan, planId: 'pooled:' + run + ':' + live.length + ':' + variant, rootNodeId: 'pooled:root', query: rootQuery }),
          query: rootQuery,
          variant
        });
      };
      const assertState = (label: string): void => {
        for (const candidate of live) {
          expect(withoutState(candidate.root.getCurrentResult()), label).toEqual(evaluateQuery({
            root: candidate.query,
            relations: accepted.relations,
            ...(accepted.basis === undefined ? {} : { basis: accepted.basis }),
            ...(accepted.membershipRevision === undefined ? {} : { membershipRevision: accepted.membershipRevision })
          }));
        }
        const diagnostics = runtime.getDiagnostics();
        expect(diagnostics.activeRootCount, label).toBe(live.length);
        expect(diagnostics.sharedPhysicalNodeCount, label).toBeLessThanOrEqual(diagnostics.physicalNodeCount);
        if (live.length === 0) expect(diagnostics.physicalNodeCount, label).toBe(0);
        else expect(diagnostics.physicalNodeCount, label).toBeGreaterThan(0);
        if (live.length > 1) expect(diagnostics.sharedPhysicalNodeCount, label).toBeGreaterThanOrEqual(2);
      };
      const applyRows = (nextRows: FuzzRow[]): void => {
        revision += 1;
        const next = snapshot(nextRows, revision);
        runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
        rows = nextRows;
        accepted = next;
      };

      attach(run % 3);
      assertState('pool run ' + run + ', initial');
      for (let step = 0; step < stateSteps; step += 1) {
        const action = stateInteger(6);
        if (action === 0) {
          const nextRows = rows.map((item) => ({ ...item, row: { ...item.row } }));
          const mutation = stateInteger(4);
          if (mutation === 0 && nextRows.length > 0) {
            const index = stateInteger(nextRows.length);
            const current = nextRows[index] as FuzzRow;
            nextRows[index] = { ...current, row: { ...current.row, value: 'changed:' + stateInteger(1_000), score: stateInteger(1_000) } };
          } else if (mutation === 1) {
            const id = nextId++;
            nextRows.push({ occurrenceId: 'pooled:' + id, row: { id, value: 'inserted:' + id, score: stateInteger(1_000) } });
          } else if (mutation === 2 && nextRows.length > 1) nextRows.splice(stateInteger(nextRows.length), 1);
          else if (nextRows.length > 1) {
            const first = stateInteger(nextRows.length);
            const second = stateInteger(nextRows.length);
            [nextRows[first], nextRows[second]] = [nextRows[second] as FuzzRow, nextRows[first] as FuzzRow];
          }
          applyRows(nextRows);
        } else if (action === 1) attach();
        else if (action === 2 && live.length > 1) {
          const index = stateInteger(live.length);
          const [removed] = live.splice(index, 1);
          removed?.root.close();
        } else if (action === 3) {
          const recoveryRows = rows.map((item) => ({ ...item, row: { ...item.row } }));
          const index = recoveryRows.length === 0 ? -1 : stateInteger(recoveryRows.length);
          if (index >= 0) {
            const current = recoveryRows[index] as FuzzRow;
            recoveryRows[index] = { ...current, row: { ...current.row, score: stateInteger(1_000) } };
          } else {
            const id = nextId++;
            recoveryRows.push({ occurrenceId: 'pooled:' + id, row: { id, value: 'recovery:' + id, score: stateInteger(1_000) } });
          }
          const recovery = snapshot(recoveryRows, revision + 1);
          const valid = diffQueryMaintenanceSnapshots(accepted, recovery);
          const changed = valid.relations[0];
          expect(changed, 'malformed update requires one relation change').toBeDefined();
          runtime.applyUpdate({
            ...valid,
            relations: [{
              ...(changed as NonNullable<typeof changed>),
              rows: [{ occurrenceId: 'pooled:missing', after: { index: 0, row: { id: -1, value: 'malformed', score: -1 } } }]
            }]
          });
          for (const candidate of live) expect(candidate.root.getCurrentResult()).toMatchObject({ rows: [], completeness: 'unknown' });
          expect(runtime.getDiagnostics().activeRootCount).toBe(live.length);
          runtime.applyUpdate(valid);
          revision += 1;
          rows = recoveryRows;
          accepted = recovery;
        } else {
          runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, accepted));
        }
        assertState('pool run ' + run + ', step ' + step + ', action ' + action);
      }
      while (live.length > 0) live.splice(stateInteger(live.length), 1)[0]?.root.close();
      expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0, sharedPhysicalNodeCount: 0 });
      runtime.close();
    }
  });

  it('is total over generated portable receipt inputs', () => {
    for (let run = 0; run < runs * 8; run += 1) {
      const input = randomJson(0);
      expect(() => safeParseReceipt(input), 'receipt run ' + run).not.toThrow();
      const parsed = safeParseReceipt(input);
      if (parsed.success) expect(() => JSON.stringify(parsed.value)).not.toThrow();
    }
  });

  it('terminates bounded lens traversal and returns only connected paths', () => {
    for (let run = 0; run < runs; run += 1) {
      const nodeCount = 2 + integer(10);
      const nodes = Array.from({ length: nodeCount }, (_, index): ArtifactRef => ({ id: 'urn:fuzz:schema:' + index, contentHash: hash(index) }));
      const candidates: LensArtifact[] = [];
      for (let edge = 0; edge < nodeCount * 3; edge += 1) {
        const from = nodes[integer(nodes.length)] as ArtifactRef;
        const to = nodes[integer(nodes.length)] as ArtifactRef;
        candidates.push({ ref: { id: 'urn:fuzz:lens:' + edge, contentHash: hash(edge + 3) }, body: { from, to, relations: [] } });
      }
      const from = nodes[0] as ArtifactRef;
      const to = nodes.at(-1) as ArtifactRef;
      const resolution = resolveLensPath(from, to, candidates, undefined, { maxVisitedNodes: 100, maxDepth: 12 });
      if (resolution.outcome !== 'resolved') continue;
      let cursor = from;
      for (const lens of resolution.path) {
        expect(lens.body.from).toEqual(cursor);
        cursor = lens.body.to;
      }
      expect(cursor).toEqual(to);
      expect(resolution.path.length).toBeLessThanOrEqual(12);
    }
  });
});

const relationInput = (source: FuzzSource): RelationInput => ({
  relation,
  rows: source.rows.map(({ row }) => row),
  occurrenceIds: source.rows.map(({ occurrenceId }) => occurrenceId),
  completeness: 'exact',
  sourceId: source.sourceId,
  ...(source.attachmentId === undefined ? {} : { attachmentId: source.attachmentId }),
  basis: source.revision
});

const withoutState = ({ state: _state, ...result }: IncrementalQueryResult) => result;
const identityMap = (result: Pick<IncrementalQueryResult, 'rows' | 'resultKeys'>): ReadonlyMap<string, string> => new Map(result.rows.map((row, index) => {
  if (typeof row.source !== 'string' || (typeof row.id !== 'number' && typeof row.id !== 'string')) throw new TypeError('Fuzz query lost source/id fields');
  return [row.source + '\u0000' + row.id, result.resultKeys[index] as string];
}));

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function randomJson(depth: number): JsonValue {
  if (depth >= 4) return [null, random() < 0.5, integer(1_000), 'value:' + integer(100)][integer(4)] as JsonValue;
  const kind = integer(6);
  if (kind < 4) return [null, random() < 0.5, integer(1_000), 'value:' + integer(100)][kind] as JsonValue;
  if (kind === 4) return Array.from({ length: integer(5) }, () => randomJson(depth + 1));
  return Object.fromEntries(Array.from({ length: integer(5) }, (_, index) => ['key:' + index, randomJson(depth + 1)]));
}
