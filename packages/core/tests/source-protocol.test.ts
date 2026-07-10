import { describe, expect, it, vi } from 'vitest';
import {
  coordinateSourceCommit,
  createIssue,
  type AtomicSource,
  type Footprint,
  type FootprintRelation,
  type PlanResult,
  type StorageBinding
} from '../src/index.js';

type Storage = Readonly<Record<string, number>>;
type Command = { readonly path: string; readonly value: number };

const paths = (footprint: Footprint): readonly string[] => Array.isArray(footprint) ? footprint.filter((value): value is string => typeof value === 'string') : [];
const relate = (left: Footprint, right: Footprint): FootprintRelation => {
  const l = new Set(paths(left));
  const r = new Set(paths(right));
  const leftInRight = [...l].every((path) => r.has(path));
  const rightInLeft = [...r].every((path) => l.has(path));
  if (leftInRight && rightInLeft) return 'equal';
  if (leftInRight) return 'contained_by';
  if (rightInLeft) return 'contains';
  return [...l].some((path) => r.has(path)) ? 'overlaps' : 'disjoint';
};

const defaultCommit: AtomicSource<Storage, Command>['commit'] = async () => ({ outcome: 'committed', beforeBasis: 0, afterBasis: 1, issues: [] });

const source = (
  commit: AtomicSource<Storage, Command>['commit'] = defaultCommit,
  relateFootprints: AtomicSource<Storage, Command>['relateFootprints'] = relate
): AtomicSource<Storage, Command> => ({
  sourceId: 'source:test',
  snapshot: () => ({ sourceId: 'source:test', operationEpoch: 'epoch', basis: 0, state: 'ready', freshness: 'current', storage: {}, issues: [] }),
  subscribe: () => () => undefined,
  commit,
  relateFootprints,
  mergeIntents: (plans) => ({ outcome: 'merged', commands: plans.flatMap((plan) => plan.intents.map(({ command }) => command)) }),
  stage: (_snapshot, commands) => ({ storage: Object.fromEntries(commands.map((command) => [command.path, command.value])), issues: [] })
});

const binding = (id: string, plan: PlanResult<Command>, declared: readonly string[] = ['a', 'b']): StorageBinding<Storage, Command> => ({
  id,
  declaredReadFootprint: declared,
  declaredWriteFootprint: declared,
  project: () => ({ rows: [], completeness: 'exact', issues: [] }),
  plan: () => plan
});

const commitInput = { operationEpoch: 'epoch', operationId: 'operation', intentHash: `sha256:${'a'.repeat(64)}` as const, expectedBasis: 0 };

describe('generic source commit coordinator', () => {
  it('checks all footprint bounds, merges deterministically, validates staged storage, then commits once', async () => {
    const commit = vi.fn(async () => ({ outcome: 'committed' as const, beforeBasis: 0, afterBasis: 1, issues: [] }));
    const observed: string[] = [];
    const result = await coordinateSourceCommit({
      source: source(commit),
      bindings: [
        binding('z', { readFootprint: ['a'], writeFootprint: ['a'], intents: [{ footprint: ['a'], command: { path: 'z', value: 2 } }], issues: [] }),
        binding('a', { readFootprint: ['b'], writeFootprint: ['b'], intents: [{ footprint: ['b'], command: { path: 'a', value: 1 } }], issues: [] })
      ],
      edits: [],
      commit: commitInput,
      validate: ({ snapshot, plans }) => { observed.push(...plans.map((_plan, index) => String(index)), ...Object.keys(snapshot.storage ?? {})); return []; }
    });
    expect(result.outcome).toBe('committed');
    expect(commit).toHaveBeenCalledWith({ ...commitInput, commands: [{ path: 'a', value: 1 }, { path: 'z', value: 2 }] });
    expect(observed).toEqual(['0', '1', 'a', 'z']);
  });

  it.each(['disjoint', 'contains', 'overlaps', 'unknown'] as const)('rejects %s where containment proof is required', async (relation) => {
    const commit = vi.fn(async () => ({ outcome: 'committed' as const, issues: [] }));
    const value = source(commit, () => relation);
    const result = await coordinateSourceCommit({ source: value, bindings: [binding('bad', { readFootprint: ['outside'], writeFootprint: [], intents: [], issues: [] })], edits: [], commit: commitInput });
    expect(result.outcome).toBe('rejected');
    expect(result.issues.some((issue) => issue.code === 'binding.footprint_out_of_bounds' && (issue.details as { relation?: string }).relation === relation)).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['equal', 'contained_by'] as const)('accepts the proven %s footprint relation', async (relation) => {
    const commit = vi.fn(async () => ({ outcome: 'committed' as const, beforeBasis: 0, afterBasis: 1, issues: [] }));
    const value = source(commit, () => relation);
    const result = await coordinateSourceCommit({
      source: value,
      bindings: [binding('bounded', { readFootprint: ['a'], writeFootprint: ['a'], intents: [{ footprint: ['a'], command: { path: 'a', value: 1 } }], issues: [] })],
      edits: [],
      commit: commitInput
    });
    expect(result.outcome).toBe('committed');
    expect(commit).toHaveBeenCalledOnce();
  });

  it('makes n-ary merge input independent of caller binding order', async () => {
    const orders = [
      ['c', 'a', 'b'],
      ['b', 'c', 'a'],
      ['a', 'b', 'c']
    ] as const;
    const committedCommands: Command[][] = [];
    for (const order of orders) {
      const commit = vi.fn(async (input: Parameters<AtomicSource<Storage, Command>['commit']>[0]) => {
        committedCommands.push([...input.commands]);
        return { outcome: 'committed' as const, beforeBasis: 0, afterBasis: 1, issues: [] };
      });
      const bindings = order.map((id, index) => binding(id, {
        readFootprint: [id],
        writeFootprint: [id],
        intents: [{ footprint: [id], command: { path: id, value: index } }],
        issues: []
      }, [id]));
      await coordinateSourceCommit({ source: source(commit), bindings, edits: [], commit: commitInput });
    }
    expect(committedCommands.map((commands) => commands.map(({ path }) => path))).toEqual([
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
      ['a', 'b', 'c']
    ]);
  });

  it('retains a durable source crash-after-handoff as unknown until exact outcome lookup resolves it', async () => {
    const unknownIssue = createIssue({ code: 'transaction.outcome_unavailable', retry: 'query_outcome', operationId: commitInput.operationId });
    const committed = { outcome: 'committed' as const, beforeBasis: 0, afterBasis: 1, issues: [] };
    const durable: AtomicSource<Storage, Command> = {
      ...source(async () => ({ outcome: 'unknown', beforeBasis: 0, issues: [unknownIssue] })),
      queryOutcome: async (identity) => identity.operationEpoch === commitInput.operationEpoch && identity.operationId === commitInput.operationId && identity.intentHash === commitInput.intentHash
        ? { status: 'known', result: committed }
        : { status: 'ambiguous' }
    };
    const handedOff = await coordinateSourceCommit({ source: durable, bindings: [], edits: [], commit: commitInput });
    expect(handedOff).toMatchObject({ outcome: 'unknown', beforeBasis: 0, issues: [{ code: 'transaction.outcome_unavailable', retry: 'query_outcome' }] });
    const lookup = durable.queryOutcome;
    if (lookup === undefined) throw new Error('durable test source must provide outcome lookup');
    await expect(lookup({ operationEpoch: commitInput.operationEpoch, operationId: commitInput.operationId, intentHash: commitInput.intentHash }))
      .resolves.toEqual({ status: 'known', result: committed });
  });
});
