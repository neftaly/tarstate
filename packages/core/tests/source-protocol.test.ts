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
import { RestartableReferenceSource, SerializedRestartableStateStore } from './support/restartable-source.js';

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

  it('preserves planner warnings without blocking and converts planner exceptions to rejection evidence', async () => {
    const commit = vi.fn(defaultCommit);
    const warning = createIssue({ code: 'lens.lossy_value', details: { field: 'title' } });
    const warned = await coordinateSourceCommit({
      source: source(commit),
      bindings: [binding('warning', { readFootprint: [], writeFootprint: [], intents: [], issues: [warning] })],
      edits: [],
      commit: commitInput
    });
    expect(warned).toMatchObject({ outcome: 'committed', issues: [{ code: 'lens.lossy_value', severity: 'warning' }] });
    expect(commit).toHaveBeenCalledOnce();

    const failed = await coordinateSourceCommit({
      source: source(commit),
      bindings: [{ ...binding('throwing', { readFootprint: [], writeFootprint: [], intents: [], issues: [] }), plan: () => { throw new TypeError('planner failed'); } }],
      edits: [],
      commit: { ...commitInput, operationId: 'planner-failed' }
    });
    expect(failed).toMatchObject({ outcome: 'rejected', issues: [{ code: 'binding.plan_failed' }] });
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

  it('recovers the exact durable result after mutation, lost return, and source/coordinator recreation', async () => {
    const store = new SerializedRestartableStateStore<Storage>({
      sourceId: 'source:restartable',
      incarnation: 'incarnation:one',
      operationEpoch: 'epoch',
      revision: 0,
      storage: {},
      ledger: []
    });
    const apply = (storage: Storage, commands: readonly Command[]) => {
      const next = { ...storage, ...Object.fromEntries(commands.map((command) => [command.path, command.value])) };
      return { storage: next, changed: JSON.stringify(next) !== JSON.stringify(storage) };
    };
    const firstRuntime = new RestartableReferenceSource({ store, apply, relateFootprints: relate, loseNextCommitResult: true });
    const write = binding('restartable', {
      readFootprint: ['a'],
      writeFootprint: ['a'],
      intents: [{ footprint: ['a'], command: { path: 'a', value: 1 } }],
      issues: []
    }, ['a']);
    const identity = {
      operationEpoch: 'epoch',
      operationId: 'operation:restartable',
      intentHash: `sha256:${'d'.repeat(64)}` as const,
      expectedBasis: { incarnation: 'incarnation:one', revision: 0 }
    };

    const handedOff = await coordinateSourceCommit({ source: firstRuntime, bindings: [write], edits: [], commit: identity });
    expect(handedOff).toMatchObject({ outcome: 'unknown', beforeBasis: identity.expectedBasis, issues: [{ code: 'transaction.outcome_unavailable', retry: 'query_outcome' }] });
    expect(store.read()).toMatchObject({
      revision: 1,
      storage: { a: 1 },
      ledger: [{ operationEpoch: identity.operationEpoch, operationId: identity.operationId, intentHash: identity.intentHash, result: { outcome: 'committed' } }]
    });

    // Recreate both the persistence and source objects from the serialized
    // durable record. The commit coordinator itself is stateless shell code.
    const recoveredStore = new SerializedRestartableStateStore(store.read());
    const recoveredRuntime = new RestartableReferenceSource({ store: recoveredStore, apply, relateFootprints: relate });
    const lookup = await recoveredRuntime.queryOutcome(identity);
    expect(lookup).toMatchObject({
      status: 'known',
      result: { outcome: 'committed', beforeBasis: identity.expectedBasis, afterBasis: { incarnation: 'incarnation:one', revision: 1 }, issues: [] }
    });
    if (lookup.status !== 'known') throw new Error('restartable result must be recoverable');

    // An exact retry returns the persisted result before stale-basis checking
    // and does not apply the command again.
    const retried = await coordinateSourceCommit({ source: recoveredRuntime, bindings: [write], edits: [], commit: identity });
    expect(retried).toEqual(lookup.result);
    expect(recoveredStore.read().storage).toEqual({ a: 1 });
    expect(recoveredStore.read().revision).toBe(1);

    const differentIntent = { ...identity, intentHash: `sha256:${'e'.repeat(64)}` as const, expectedBasis: { incarnation: 'incarnation:one', revision: 1 } };
    await expect(recoveredRuntime.queryOutcome(differentIntent)).resolves.toEqual({ status: 'ambiguous' });
    const ambiguous = await coordinateSourceCommit({ source: recoveredRuntime, bindings: [write], edits: [], commit: differentIntent });
    expect(ambiguous).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_id_ambiguous', retry: 'never' }] });
    expect(recoveredStore.read()).toMatchObject({ revision: 1, storage: { a: 1 } });
  });
});
