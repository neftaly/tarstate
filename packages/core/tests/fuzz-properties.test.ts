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

  it('keeps a two-relation pooled state machine oracle-equivalent and relation-local', () => {
    const stateRandom = seededRandom(initialSeed ^ 0x51A7_EF01);
    const stateInteger = (limit: number): number => Math.floor(stateRandom() * limit);
    const stateRuns = Math.min(runs, 48);
    const stateSteps = 24;
    const relationA = { schemaView, relationId: 'fuzz.pool.a' } as const;
    const relationB = { schemaView, relationId: 'fuzz.pool.b' } as const;
    const field = (alias: string, name: string) => ({ kind: 'field', alias, name } as const);
    const prefixA = (): QueryNode => ({
      kind: 'where',
      input: { kind: 'from', relation: relationA, alias: 'a' },
      predicate: { kind: 'compare', op: 'gte', left: field('a', 'score'), right: { kind: 'literal', value: 0 } }
    });
    const prefixB = (): QueryNode => ({
      kind: 'where',
      input: { kind: 'from', relation: relationB, alias: 'b' },
      predicate: { kind: 'compare', op: 'gte', left: field('b', 'score'), right: { kind: 'literal', value: 0 } }
    });
    const queryVariant = (variant: number): QueryNode => {
      if (variant === 0) return {
        kind: 'select', input: prefixA(), alias: 'result',
        fields: { id: field('a', 'id'), value: field('a', 'value') }
      };
      if (variant === 1) return {
        kind: 'select', input: prefixB(), alias: 'result',
        fields: { id: field('b', 'id'), value: field('b', 'value') }
      };
      if (variant === 2) return {
        kind: 'aggregate', input: prefixA(), alias: 'summary', groupBy: {},
        measures: {
          count: { kind: 'aggregate', op: 'count' },
          total: { kind: 'aggregate', op: 'sum', value: field('a', 'score') }
        }
      };
      if (variant === 3) return {
        kind: 'join', join: 'inner', left: prefixA(), right: prefixB(),
        on: { kind: 'compare', op: 'eq', left: field('a', 'joinId'), right: field('b', 'joinId') }
      };
      return {
        kind: 'set', op: 'union-all',
        left: { kind: 'select', input: prefixA(), alias: 'entry', fields: { id: field('a', 'id'), value: field('a', 'value') } },
        right: { kind: 'select', input: prefixB(), alias: 'entry', fields: { id: field('b', 'id'), value: field('b', 'value') } }
      };
    };
    type LiveRoot = { readonly root: PooledIncrementalQueryRoot; readonly query: QueryNode; readonly variant: number };

    for (let run = 0; run < stateRuns; run += 1) {
      let revisionA = 0;
      let revisionB = 0;
      let nextA = 3;
      let nextB = 3;
      let rowsA: FuzzRow[] = Array.from({ length: 3 }, (_, id) => ({
        occurrenceId: 'a:' + id,
        row: { id: 'a' + id, joinId: id % 2, value: 'a:' + id, score: stateInteger(100) }
      }));
      let rowsB: FuzzRow[] = Array.from({ length: 3 }, (_, id) => ({
        occurrenceId: 'b:' + id,
        row: { id: 'b' + id, joinId: id % 2, value: 'b:' + id, score: stateInteger(100) }
      }));
      const relationSnapshot = (use: typeof relationA | typeof relationB, items: readonly FuzzRow[], revision: number): RelationInput => ({
        relation: use,
        rows: items.map(({ row }) => row),
        occurrenceIds: items.map(({ occurrenceId }) => occurrenceId),
        completeness: 'exact',
        sourceId: 'source:' + use.relationId,
        attachmentId: 'attachment:' + use.relationId,
        basis: revision
      });
      const snapshot = (
        nextRowsA: readonly FuzzRow[] = rowsA,
        nextRowsB: readonly FuzzRow[] = rowsB,
        nextRevisionA = revisionA,
        nextRevisionB = revisionB
      ): QueryMaintenanceSnapshot => ({
        relations: [
          relationSnapshot(relationA, nextRowsA, nextRevisionA),
          relationSnapshot(relationB, nextRowsB, nextRevisionB)
        ],
        basis: { revisionA: nextRevisionA, revisionB: nextRevisionB },
        membershipRevision: 0
      });
      let accepted = snapshot();
      const runtime = createPooledIncrementalQueryRuntime({
        environment: { runtimeIdentity: 'fuzz:pool:' + run, registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' },
        initialSnapshot: accepted
      });
      const live: LiveRoot[] = [];
      let nextRootId = 0;
      const attach = (variant = stateInteger(5)): void => {
        const rootQuery = queryVariant(variant);
        const rootId = nextRootId++;
        live.push({
          root: runtime.attach({ ...plan, planId: 'pooled:' + run + ':' + rootId + ':' + variant, rootNodeId: 'pooled:root:' + rootId, query: rootQuery }),
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
      };
      const assertLocalWork = (changed: 'a' | 'b' | 'none', label: string): void => {
        const diagnostics = runtime.getDiagnostics();
        if (changed === 'none') {
          expect(diagnostics.lastUpdatedPhysicalNodeCount, label).toBe(0);
          return;
        }
        const unrelatedVariant = changed === 'a'
          ? live.some(({ variant }) => variant === 1)
          : live.some(({ variant }) => variant === 0 || variant === 2);
        if (unrelatedVariant) {
          expect(diagnostics.lastUpdatedPhysicalNodeCount, label).toBeLessThan(diagnostics.physicalNodeCount);
        }
      };
      const mutate = (target: 'a' | 'b', mode = stateInteger(3)): void => {
        const current = target === 'a' ? rowsA : rowsB;
        const nextRows = current.map((item) => ({ ...item, row: { ...item.row } }));
        if (mode === 0 && nextRows.length > 0) {
          const index = stateInteger(nextRows.length);
          const item = nextRows[index] as FuzzRow;
          nextRows[index] = { ...item, row: { ...item.row, value: target + ':changed:' + stateInteger(1_000), score: stateInteger(1_000) } };
        } else if (mode === 1 && nextRows.length > 1) {
          nextRows.splice(stateInteger(nextRows.length), 1);
        } else {
          const id = target === 'a' ? nextA++ : nextB++;
          nextRows.push({
            occurrenceId: target + ':' + id,
            row: { id: target + id, joinId: stateInteger(3), value: target + ':inserted:' + id, score: stateInteger(1_000) }
          });
        }
        if (target === 'a') {
          const next = snapshot(nextRows, rowsB, revisionA + 1, revisionB);
          runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
          rowsA = nextRows;
          revisionA += 1;
          accepted = next;
        } else {
          const next = snapshot(rowsA, nextRows, revisionA, revisionB + 1);
          runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
          rowsB = nextRows;
          revisionB += 1;
          accepted = next;
        }
      };
      const reorder = (target: 'a' | 'b'): void => {
        const current = target === 'a' ? rowsA : rowsB;
        const nextRows = [...current];
        if (nextRows.length > 1) {
          const first = stateInteger(nextRows.length);
          let second = stateInteger(nextRows.length - 1);
          if (second >= first) second += 1;
          [nextRows[first], nextRows[second]] = [nextRows[second] as FuzzRow, nextRows[first] as FuzzRow];
        }
        if (target === 'a') {
          const next = snapshot(nextRows, rowsB, revisionA + 1, revisionB);
          runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
          rowsA = nextRows;
          revisionA += 1;
          accepted = next;
        } else {
          const next = snapshot(rowsA, nextRows, revisionA, revisionB + 1);
          runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, next));
          rowsB = nextRows;
          revisionB += 1;
          accepted = next;
        }
      };
      const rejectAndRecover = (target: 'a' | 'b'): void => {
        const nextRowsA = rowsA.map((item) => ({ ...item, row: { ...item.row } }));
        const nextRowsB = rowsB.map((item) => ({ ...item, row: { ...item.row } }));
        const targetRows = target === 'a' ? nextRowsA : nextRowsB;
        if (targetRows.length === 0) {
          const id = target === 'a' ? nextA++ : nextB++;
          targetRows.push({ occurrenceId: target + ':' + id, row: { id: target + id, joinId: 0, value: 'recovery:' + id, score: 1 } });
        } else {
          const index = stateInteger(targetRows.length);
          const item = targetRows[index] as FuzzRow;
          targetRows[index] = { ...item, row: { ...item.row, score: stateInteger(1_000) } };
        }
        const nextRevisionA = revisionA + (target === 'a' ? 1 : 0);
        const nextRevisionB = revisionB + (target === 'b' ? 1 : 0);
        const recovery = snapshot(nextRowsA, nextRowsB, nextRevisionA, nextRevisionB);
        const valid = diffQueryMaintenanceSnapshots(accepted, recovery);
        const changedRelationId = target === 'a' ? relationA.relationId : relationB.relationId;
        const changed = valid.relations.find(({ relation: use }) => use.relationId === changedRelationId);
        expect(changed, 'malformed update requires the targeted relation change').toBeDefined();
        runtime.applyUpdate({
          ...valid,
          relations: [{
            ...(changed as NonNullable<typeof changed>),
            rows: [{ occurrenceId: target + ':missing', after: { index: 0, row: { id: 'malformed', joinId: -1, value: 'malformed', score: -1 } } }]
          }]
        });
        for (const candidate of live) expect(candidate.root.getCurrentResult()).toMatchObject({ rows: [], completeness: 'unknown' });
        runtime.applyUpdate(valid);
        rowsA = nextRowsA;
        rowsB = nextRowsB;
        revisionA = nextRevisionA;
        revisionB = nextRevisionB;
        accepted = recovery;
      };

      // Always cover every dependency shape before random lifecycle churn.
      for (let variant = 0; variant < 5; variant += 1) attach(variant);
      assertState('pool run ' + run + ', initial');
      for (let step = 0; step < stateSteps; step += 1) {
        const action = stateInteger(7);
        const label = 'pool run ' + run + ', step ' + step + ', action ' + action;
        let changed: 'a' | 'b' | 'none' | undefined;
        if (action === 0 || action === 1) {
          changed = action === 0 ? 'a' : 'b';
          mutate(changed);
        } else if (action === 2) {
          changed = stateInteger(2) === 0 ? 'a' : 'b';
          reorder(changed);
        } else if (action === 3) attach();
        else if (action === 4 && live.length > 1) {
          const [removed] = live.splice(stateInteger(live.length), 1);
          removed?.root.close();
        } else if (action === 5) {
          changed = stateInteger(2) === 0 ? 'a' : 'b';
          rejectAndRecover(changed);
        } else {
          runtime.applyUpdate(diffQueryMaintenanceSnapshots(accepted, accepted));
          changed = 'none';
        }
        assertState(label);
        if (changed !== undefined) assertLocalWork(changed, label);
      }
      while (live.length > 0) live.splice(stateInteger(live.length), 1)[0]?.root.close();
      expect(runtime.getDiagnostics()).toMatchObject({ activeRootCount: 0, physicalNodeCount: 0, sharedPhysicalNodeCount: 0 });
      runtime.close();
    }
  });

  it('orders nested JSON structurally with deterministic, transitive seek boundaries', () => {
    const orderingRelation = { schemaView, relationId: 'fuzz.structural-order' } as const;
    const input: QueryNode = { kind: 'from', relation: orderingRelation, alias: 'item' };
    const by = [{ value: { kind: 'field', alias: 'item', name: 'value' } as const, direction: 'asc' as const }];
    const ordered: QueryNode = { kind: 'order', input, by };
    const fixtures: readonly JsonValue[] = [
      [9], [10], [1], [1, 0],
      { a: 9 }, { a: 10 }, { a: [9] }, { a: [10] },
      { a: 1 }, { a: 1, b: 0 }, { b: 0 },
      [[9]], [[10]], { nested: { values: [9, { edge: 10 }] } }
    ];
    const orderInput = (values: readonly JsonValue[]): RelationInput => ({
      relation: orderingRelation,
      rows: values.map((value, index) => ({ id: 'value:' + index, value })),
      occurrenceIds: values.map((_value, index) => 'value:' + index),
      completeness: 'exact',
      sourceId: 'source:structural-order',
      attachmentId: 'attachment:structural-order'
    });
    const observedCompare = (left: JsonValue, right: JsonValue): -1 | 1 => {
      const relationInput = orderInput([left, right]);
      const result = evaluateQuery({ root: ordered, relations: [relationInput] });
      expect(result.completeness).toBe('exact');
      return result.rows[0]?.id === 'value:0' ? -1 : 1;
    };

    for (let run = 0; run < Math.min(runs, 48); run += 1) {
      const unique = new Map(fixtures.map((value) => [referenceCanonicalJson(value), value]));
      for (let attempt = 0; attempt < 32 && unique.size < fixtures.length + 12; attempt += 1) {
        const value = randomJson(0);
        // Top-level null placement is controlled by OrderTerm.nulls rather
        // than the structural JSON comparator; nested nulls remain covered.
        if (value !== null) unique.set(referenceCanonicalJson(value), value);
      }
      const values = [...unique.values()];
      const expected = [...values].sort(referenceJsonCompare);
      const shuffled = [...values];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = integer(index + 1);
        [shuffled[index], shuffled[swap]] = [shuffled[swap] as JsonValue, shuffled[index] as JsonValue];
      }
      const relationInput = orderInput(shuffled);
      const basis = { revision: run };
      const membershipRevision = run;
      const result = evaluateQuery({ root: ordered, relations: [relationInput], basis, membershipRevision });
      expect(result, 'structural order run ' + run).toMatchObject({ completeness: 'exact', issues: [] });
      expect(result.rows.map(({ value }) => value), 'structural oracle run ' + run).toEqual(expected);

      const reversedInput = orderInput([...shuffled].reverse());
      const reversedResult = evaluateQuery({ root: ordered, relations: [reversedInput], basis, membershipRevision });
      expect(reversedResult.rows.map(({ value }) => value), 'deterministic order run ' + run).toEqual(expected);

      for (let index = 0; index + 2 < Math.min(expected.length, 8); index += 1) {
        const first = expected[index] as JsonValue;
        const second = expected[index + 1] as JsonValue;
        const third = expected[index + 2] as JsonValue;
        expect(observedCompare(first, second), 'forward pair run ' + run + ', index ' + index).toBe(-1);
        expect(observedCompare(second, first), 'reverse pair run ' + run + ', index ' + index).toBe(1);
        expect(observedCompare(second, third), 'second pair run ' + run + ', index ' + index).toBe(-1);
        expect(observedCompare(first, third), 'transitive pair run ' + run + ', index ' + index).toBe(-1);
      }

      const cursorIndex = integer(result.rows.length - 1);
      const cursorRow = result.rows[cursorIndex] as QueryRecord;
      const seek: QueryNode = {
        kind: 'seek', input, by,
        after: {
          order: [cursorRow.value as JsonValue],
          resultKey: result.resultKeys[cursorIndex] as string,
          basis,
          membershipRevision,
          mode: 'live'
        }
      };
      const sought = evaluateQuery({ root: seek, relations: [relationInput], basis, membershipRevision });
      expect(sought, 'seek run ' + run).toMatchObject({ completeness: 'exact', issues: [] });
      expect(sought.rows, 'seek suffix run ' + run).toEqual(result.rows.slice(cursorIndex + 1));
      expect(sought.resultKeys, 'seek keys run ' + run).toEqual(result.resultKeys.slice(cursorIndex + 1));
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

const referenceJsonCompare = (left: JsonValue, right: JsonValue): number => {
  const leftRank = referenceJsonRank(left);
  const rightRank = referenceJsonRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left === null || right === null) return 0;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right ? 0 : left ? 1 : -1;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const comparison = referenceJsonCompare(left[index] as JsonValue, right[index] as JsonValue);
      if (comparison !== 0) return comparison;
    }
    return left.length - right.length;
  }
  const leftRecord = left as Readonly<Record<string, JsonValue>>;
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  for (let index = 0; index < Math.min(leftKeys.length, rightKeys.length); index += 1) {
    const leftKey = leftKeys[index] as string;
    const rightKey = rightKeys[index] as string;
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    const comparison = referenceJsonCompare(leftRecord[leftKey] as JsonValue, rightRecord[rightKey] as JsonValue);
    if (comparison !== 0) return comparison;
  }
  return leftKeys.length - rightKeys.length;
};

const referenceJsonRank = (value: JsonValue): number => value === null
  ? 0
  : typeof value === 'string'
    ? 1
    : typeof value === 'number'
      ? 2
      : typeof value === 'boolean'
        ? 3
        : Array.isArray(value)
          ? 4
          : 5;

const referenceCanonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(referenceCanonicalJson).join(',') + ']';
  const record = value as Readonly<Record<string, JsonValue>>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + referenceCanonicalJson(record[key] as JsonValue)).join(',') + '}';
};
