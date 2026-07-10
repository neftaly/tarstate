import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeMapProjectionPlanner,
  AutomergeSourceRuntime,
  automergeBasis,
  exactAutomergeBasisEqual,
  projectAutomergeFacts,
  snapshotAutomergeDocument
} from '../src/index.js';

const actor = (digit: string): string => digit.repeat(64);
const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;

type Task = { title: string; count?: Automerge.Counter };
type TaskDoc = { tasks: Record<string, Task>; metadata: { schema: string } };

const taskBase = (): Automerge.Doc<TaskDoc> => Automerge.from(
  { tasks: { first: { title: 'First' } }, metadata: { schema: 'v1' } },
  { actor: actor('1') }
);

describe('production Automerge adapter', () => {
  it('rejects reentrant document replacement without losing either document', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: taskBase() });
    const before = runtime.snapshot();
    const remote = Automerge.change(before.storage, { time: 0 }, (draft) => { draft.metadata.schema = 'remote'; });
    const result = await runtime.commit({
      operationEpoch: 'epoch:1',
      operationId: 'reentrant-replace',
      intentHash: hash('f'),
      expectedBasis: before.basis,
      commands: [{ apply: (draft) => {
        runtime.replace(remote);
        draft.metadata.schema = 'local';
      } }]
    });
    expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'automerge.command_failed' }] });
    expect(runtime.snapshot().storage).toEqual(before.storage);
  });

  it('uses sorted exact heads as basis and retains exact historical views', () => {
    const base = taskBase();
    const changed = Automerge.change(base, { time: 0 }, (draft) => { draft.metadata.schema = 'v2'; });
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: changed });
    const changedBasis = automergeBasis(changed);
    expect(exactAutomergeBasisEqual(changedBasis, { kind: 'automerge-heads', heads: [...changedBasis.heads].reverse() })).toBe(true);
    expect(exactAutomergeBasisEqual(automergeBasis(base), changedBasis)).toBe(false);
    expect(runtime.view(automergeBasis(base)).storage.metadata.schema).toBe('v1');
  });

  it('serializes atomic commands, deduplicates handed-off operations, and does not notify for no-op', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: taskBase() });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const before = runtime.snapshot().basis;
    const committed = await runtime.commit({
      operationEpoch: 'epoch:1',
      operationId: 'operation:1',
      intentHash: hash('a'),
      expectedBasis: before,
      commands: [
        { apply: (draft) => {
          if (draft.tasks.first === undefined) throw new Error('fixture task missing');
          draft.tasks.first.title = 'Changed';
        } },
        { apply: (draft) => { draft.tasks.second = { title: 'Second' }; } }
      ]
    });
    expect(committed).toMatchObject({ outcome: 'committed', changed: true, durability: 'local' });
    expect(runtime.snapshot().storage.tasks).toMatchObject({ first: { title: 'Changed' }, second: { title: 'Second' } });
    expect(listener).toHaveBeenCalledTimes(1);

    const replay = await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:1', intentHash: hash('a'), expectedBasis: before, commands: []
    });
    expect(replay).toBe(committed);
    const noOp = await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:noop', intentHash: hash('b'), expectedBasis: runtime.snapshot().basis, commands: []
    });
    expect(noOp).toMatchObject({ outcome: 'committed', changed: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.queryOutcome({ operationEpoch: 'epoch:1', operationId: 'operation:1', intentHash: hash('c') })).toEqual({ status: 'ambiguous' });
  });

  it('rejects an exact stale basis without running commands and retains the outcome', async () => {
    const base = taskBase();
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: Automerge.change(base, (draft) => { draft.metadata.schema = 'v2'; }) });
    const command = vi.fn();
    const result = await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:stale', intentHash: hash('d'), expectedBasis: automergeBasis(base), commands: [{ apply: command }]
    });
    expect(result).toMatchObject({ outcome: 'rejected', changed: false, issues: [{ code: 'transaction.expected_basis_stale' }] });
    expect(command).not.toHaveBeenCalled();
    expect(runtime.queryOutcome({ operationEpoch: 'epoch:1', operationId: 'operation:stale', intentHash: hash('d') })).toMatchObject({ status: 'known' });
  });

  it('projects every concurrent map candidate and requires explicit observed conflict resolution', async () => {
    const base = taskBase();
    let left = Automerge.clone(base, { actor: actor('2') });
    let right = Automerge.clone(base, { actor: actor('3') });
    left = Automerge.change(left, { time: 0 }, (draft) => { draft.tasks.same = { title: 'Left' }; });
    right = Automerge.change(right, { time: 0 }, (draft) => { draft.tasks.same = { title: 'Right' }; });
    const merged = Automerge.merge(left, right);
    const snapshot = snapshotAutomergeDocument('source:tasks', merged);
    const binding = new AutomergeMapProjectionPlanner<TaskDoc, Readonly<Record<string, import('@tarstate/core').JsonValue>>>({
      relationId: 'relation:tasks', collectionPath: ['tasks'], missingCollection: 'invalid', keySource: 'map-key'
    });
    const projection = binding.project(snapshot);
    const sameRows = projection.rows.filter((row) => row.key[0] === 'same');
    const titles = sameRows.map((row) => row.fields.title).filter((title): title is string => typeof title === 'string');
    expect(titles.sort((leftTitle, rightTitle) => leftTitle.localeCompare(rightTitle))).toEqual(['Left', 'Right']);
    expect(new Set(sameRows.map((row) => row.locator.rowIncarnation)).size).toBe(2);
    expect(projection.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['automerge.map_key_conflict', 'automerge.logical_key_ambiguous']));

    const ordinary = binding.plan(snapshot, [{ kind: 'replace', path: ['tasks', 'same', 'title'], value: 'Nope' }]);
    expect(ordinary.commands).toHaveLength(0);
    expect(ordinary.issues).toContainEqual(expect.objectContaining({ code: 'transaction.conflict_requires_resolution' }));

    const alternatives = Object.entries(Automerge.getConflicts(merged.tasks, 'same') ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const selected = alternatives.find(([, candidate]) => (candidate as Task).title === 'Left');
    expect(selected).toBeDefined();
    const resolution = binding.plan(snapshot, [{
      kind: 'conflict-resolve',
      path: ['tasks', 'same'],
      observedChangeHashes: alternatives.map(([changeHash]) => changeHash),
      selectedChangeHash: selected?.[0] ?? ''
    }]);
    expect(resolution.issues).toEqual([]);
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: merged });
    const receipt = await runtime.commit({
      operationEpoch: 'epoch:resolve', operationId: 'operation:resolve', intentHash: hash('e'), expectedBasis: snapshot.basis, commands: resolution.commands
    });
    expect(receipt.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks.same?.title).toBe('Left');
    expect(Automerge.getConflicts(runtime.snapshot().storage.tasks, 'same')).toBeUndefined();
  });

  it('normalizes object and conflict facts while hiding reserved metadata', () => {
    const base = taskBase();
    let left = Automerge.clone(base, { actor: actor('4') });
    let right = Automerge.clone(base, { actor: actor('5') });
    left = Automerge.change(left, { time: 0 }, (draft) => { draft.metadata.schema = 'left'; });
    right = Automerge.change(right, { time: 0 }, (draft) => { draft.metadata.schema = 'right'; });
    const merged = Automerge.merge(left, right);
    const facts = projectAutomergeFacts(merged);
    expect(facts.basis).toEqual(automergeBasis(merged));
    expect(facts.conflicts).toContainEqual(expect.objectContaining({ path: ['metadata', 'schema'] }));
    expect(facts.properties.some((fact) => fact.path[0] === '__tarstateMetaV1')).toBe(false);
  });

  it('treats application move-looking records as ordinary uninterpreted data', () => {
    const doc = Automerge.from({
      __automergeMoves: { old: { from: ['a'], to: ['b'] } },
      __tarstateMovesV1: { proposed: { mechanism: 'application-owned' } }
    });
    const paths = projectAutomergeFacts(doc).properties.map(({ path }) => path);
    expect(paths).toContainEqual(['__automergeMoves']);
    expect(paths).toContainEqual(['__tarstateMovesV1']);
  });
});
