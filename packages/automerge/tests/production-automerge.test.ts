import { createHash } from 'node:crypto';
import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeMapStorageBinding,
  AutomergeMoveError,
  AutomergeSourceRuntime,
  automergeBasis,
  copyRelocateAutomerge,
  exactAutomergeBasisEqual,
  initializeAutomergeMoveMetadata,
  projectAutomergeFacts,
  snapshotAutomergeDocument
} from '../src/index.js';

const actor = (digit: string): string => digit.repeat(64);
const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;

type Task = { title: string; count?: Automerge.Counter };
type TaskDoc = { tasks: Record<string, Task>; metadata: { schema: string }; __tarstateMovesV1?: Record<string, unknown> };

const taskBase = (): Automerge.Doc<TaskDoc> => Automerge.from(
  { tasks: { first: { title: 'First' } }, metadata: { schema: 'v1' } },
  { actor: actor('1') }
);

describe('production Automerge adapter', () => {
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
    expect(result).toMatchObject({ outcome: 'rejected', changed: false, issues: [{ code: 'transaction.stale_basis' }] });
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
    const binding = new AutomergeMapStorageBinding<TaskDoc, Readonly<Record<string, import('@tarstate/core').JsonValue>>>({
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

  it('normalizes object, conflict, and adapter-private move facts without leaking the reserved map as a normal property', async () => {
    const base = taskBase();
    let left = Automerge.clone(base, { actor: actor('4') });
    let right = Automerge.clone(base, { actor: actor('5') });
    left = Automerge.change(left, { time: 0 }, (draft) => { draft.metadata.schema = 'left'; });
    right = Automerge.change(right, { time: 0 }, (draft) => { draft.metadata.schema = 'right'; });
    const moved = await copyRelocateAutomerge(Automerge.merge(left, right), {
      operationEpoch: 'epoch:move', operationId: 'operation:move', statementIndex: 0, fromPath: ['tasks', 'first'], toPath: ['tasks', 'moved']
    });
    const facts = projectAutomergeFacts(moved.doc);
    expect(facts.basis).toEqual(automergeBasis(moved.doc));
    expect(facts.conflicts).toContainEqual(expect.objectContaining({ path: ['metadata', 'schema'] }));
    expect(facts.moves).toContainEqual(expect.objectContaining({ recordId: moved.recordId }));
    expect(facts.properties.some((fact) => fact.path[0] === '__tarstateMovesV1')).toBe(false);
  });

  it('records the frozen copyRelocate losses and golden bytes, and is idempotent for the same move identity', async () => {
    type MoveDoc = {
      active: { item?: { title: string; count: Automerge.Counter; text: string; nested: { flag: boolean }; list: string[] } };
      archive: { item?: { title: string; count: Automerge.Counter; text: string; nested: { flag: boolean }; list: string[] } };
      __tarstateMovesV1?: Record<string, unknown>;
    };
    let base = Automerge.init<MoveDoc>({ actor: actor('a') });
    base = Automerge.change(base, { time: 0, message: 'fixture' }, (draft) => {
      draft.active = { item: { title: 'Original', count: new Automerge.Counter(2), text: 'hello', nested: { flag: true }, list: ['a', 'b'] } };
      draft.archive = {};
    });
    const input = { operationEpoch: 'epoch:golden', operationId: 'operation:golden', statementIndex: 7, fromPath: ['active', 'item'] as const, toPath: ['archive', 'item'] as const };
    const first = await copyRelocateAutomerge(base, input);
    expect(first.record.preservationLosses).toEqual(expect.arrayContaining([
      'automerge.conflicts_not_copied',
      'automerge.concurrent_old_subtree_edits_not_forwarded',
      'automerge.counter_identity_changed',
      'automerge.descendant_mapping_incomplete',
      'automerge.descendant_object_identity_changed',
      'automerge.list_element_identity_changed',
      'automerge.root_object_identity_changed',
      'automerge.text_identity_changed'
    ]));
    expect(createHash('sha256').update(Automerge.save(first.doc)).digest('hex')).toBe('85776c89abd082ae4d29e4b72bc19732089931b348e0083b95abc3d99c4e93e6');
    const replay = await copyRelocateAutomerge(first.doc, input);
    expect(replay).toMatchObject({ changed: false, recordId: first.recordId, record: first.record });
    expect(replay.doc).toBe(first.doc);
  });

  it('converges concurrent relocation records in a preinitialized metadata map and exposes the fork history', async () => {
    type ForkDoc = {
      active: { item?: { title: string } };
      left: { item?: { title: string } };
      right: { item?: { title: string } };
      __tarstateMovesV1?: Record<string, unknown>;
    };
    let base = Automerge.from<ForkDoc>({ active: { item: { title: 'shared' } }, left: {}, right: {} }, { actor: actor('7') });
    base = initializeAutomergeMoveMetadata(base);
    const leftPeer = Automerge.clone(base, { actor: actor('8') });
    const rightPeer = Automerge.clone(base, { actor: actor('9') });
    const leftMove = await copyRelocateAutomerge(leftPeer, {
      operationEpoch: 'epoch:fork', operationId: 'operation:left', statementIndex: 0, fromPath: ['active', 'item'], toPath: ['left', 'item']
    });
    const rightMove = await copyRelocateAutomerge(rightPeer, {
      operationEpoch: 'epoch:fork', operationId: 'operation:right', statementIndex: 0, fromPath: ['active', 'item'], toPath: ['right', 'item']
    });
    const mergedLeftRight = Automerge.merge(leftMove.doc, rightMove.doc);
    const mergedRightLeft = Automerge.merge(rightMove.doc, leftMove.doc);
    expect(Automerge.equals(mergedLeftRight, mergedRightLeft)).toBe(true);
    expect(exactAutomergeBasisEqual(automergeBasis(mergedLeftRight), automergeBasis(mergedRightLeft))).toBe(true);
    expect(mergedLeftRight).toMatchObject({ active: {}, left: { item: { title: 'shared' } }, right: { item: { title: 'shared' } } });
    const facts = projectAutomergeFacts(mergedLeftRight);
    expect(facts.moves.map((move) => move.recordId).sort((left, right) => left.localeCompare(right))).toEqual(
      [leftMove.recordId, rightMove.recordId].sort((left, right) => left.localeCompare(right))
    );
    expect(facts.issues).toContainEqual(expect.objectContaining({ code: 'automerge.move_fork_history' }));
  });

  it('withholds copyRelocate on reserved metadata collision and invalid nested destinations', async () => {
    type CollisionDoc = { source: { value: string }; target: Record<string, unknown>; __tarstateMovesV1: string };
    const collision = Automerge.from<CollisionDoc>({ source: { value: 'x' }, target: {}, __tarstateMovesV1: 'application-data' }, { actor: actor('6') });
    await expect(copyRelocateAutomerge(collision, {
      operationEpoch: 'epoch', operationId: 'operation', statementIndex: 0, fromPath: ['source'], toPath: ['target', 'copy']
    })).rejects.toMatchObject({ code: 'automerge.move_metadata_collision' });
    await expect(copyRelocateAutomerge(collision, {
      operationEpoch: 'epoch', operationId: 'nested', statementIndex: 0, fromPath: ['source'], toPath: ['source', 'child']
    })).rejects.toBeInstanceOf(AutomergeMoveError);
  });
});
