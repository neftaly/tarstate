import { describe, expect, it } from 'vitest';
import {
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
      const session = openIncrementalQueryMaintenance(plan, snapshot());
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
        const maintained = session.updateSnapshot(next);
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
