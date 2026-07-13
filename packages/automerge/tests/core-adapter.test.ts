import * as Automerge from '@automerge/automerge';
import {
  coordinateSourceCommit,
  type ContentHash,
  type JsonValue,
  type LogicalEdit
} from '@tarstate/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeAtomicSource,
  AutomergeMapStorageBinding,
  AutomergeSourceRuntime,
  type AutomergeSourceDiagnostic,
  automergePathFootprint,
  exactAutomergeBasisEqual,
  relateAutomergeFootprints
} from '../src/index.js';

type Task = { title: string; priority?: number; count?: Automerge.Counter; tags?: string[] };
type TaskDoc = { tasks: Record<string, Task> };

const actor = (digit: string): string => digit.repeat(64);
const intentHash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}`;
const baseDoc = (): Automerge.Doc<TaskDoc> => Automerge.from({ tasks: { first: { title: 'First', priority: 1 } } }, { actor: actor('1') });

const fixture = (doc = baseDoc()) => {
  const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:one' });
  const binding = new AutomergeMapStorageBinding<TaskDoc, Readonly<Record<string, JsonValue>>>({
    id: 'binding:tasks',
    relationId: 'relation:tasks',
    collectionPath: ['tasks'],
    missingCollection: 'invalid',
    keySource: 'map-key'
  });
  return { runtime, source, binding };
};

const selectedEdit = (
  source: AutomergeAtomicSource<TaskDoc>,
  binding: AutomergeMapStorageBinding<TaskDoc, Readonly<Record<string, JsonValue>>>,
  fields: Readonly<Record<string, JsonValue>>
): LogicalEdit => {
  const projection = binding.project(source.snapshot());
  const row = projection.rows.find((candidate) => candidate.key[0] === 'first');
  if (row === undefined) throw new Error('fixture row missing');
  return { kind: 'replace-fields', relationId: 'relation:tasks', key: row.key as JsonValue, locator: row.locator as unknown as JsonValue, fields };
};

const selectedTarget = (
  source: AutomergeAtomicSource<TaskDoc>,
  binding: AutomergeMapStorageBinding<TaskDoc, Readonly<Record<string, JsonValue>>>,
  key = 'first'
) => {
  const projection = binding.project(source.snapshot());
  const row = projection.rows.find((candidate) => candidate.key[0] === key);
  if (row === undefined) throw new Error('fixture row missing: ' + key);
  return { relationId: 'relation:tasks', key: row.key as JsonValue, locator: row.locator as unknown as JsonValue };
};

const commitInput = (expectedBasis: JsonValue, operationId: string, hashDigit: string) => ({
  operationEpoch: 'epoch:one',
  operationId,
  intentHash: intentHash(hashDigit),
  expectedBasis
});

describe('Automerge core source protocols', () => {
  it('coordinates staged map edits through one exact-head atomic runtime commit', async () => {
    const { runtime, source, binding } = fixture();
    const before = source.snapshot();
    expect(before).toMatchObject({ operationEpoch: 'epoch:one', state: 'ready', freshness: 'current' });
    const edit = selectedEdit(source, binding, { title: 'Changed', priority: 2 });
    const listener = vi.fn();
    source.subscribe(listener);
    const runtimeCommit = vi.spyOn(runtime, 'commit');
    let stagedTitle: unknown;
    let liveTitleDuringValidation: unknown;

    const result = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [edit],
      commit: commitInput(before.basis as JsonValue, 'operation:change', 'a'),
      validate: ({ snapshot }) => {
        stagedTitle = snapshot.storage?.tasks.first?.title;
        liveTitleDuringValidation = runtime.snapshot().storage.tasks.first?.title;
        return [];
      }
    });

    expect(result).toMatchObject({ outcome: 'committed', issues: [] });
    expect(stagedTitle).toBe('Changed');
    expect(liveTitleDuringValidation).toBe('First');
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('Changed');
    expect(runtime.snapshot().storage.tasks.first?.priority).toBe(2);
    expect(runtimeCommit).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const after = source.snapshot();
    expect(exactAutomergeBasisEqual(before.basis as import('../src/index.js').AutomergeBasis, after.basis as import('../src/index.js').AutomergeBasis)).toBe(false);
    expect((after.basis as import('../src/index.js').AutomergeBasis).heads).toEqual([...(after.basis as import('../src/index.js').AutomergeBasis).heads].sort());
  });

  it('rejects overlapping binding plans deterministically before the runtime commit', async () => {
    const { runtime, source, binding } = fixture();
    const overlapping = new AutomergeMapStorageBinding<TaskDoc, Readonly<Record<string, JsonValue>>>({
      id: 'binding:overlapping', relationId: 'relation:tasks', collectionPath: ['tasks'], missingCollection: 'invalid', keySource: 'map-key'
    });
    const runtimeCommit = vi.spyOn(runtime, 'commit');
    const before = source.snapshot();
    const result = await coordinateSourceCommit({
      source,
      bindings: [overlapping, binding],
      edits: [selectedEdit(source, binding, { title: 'Nope' })],
      commit: commitInput(before.basis as JsonValue, 'operation:overlap', 'b')
    });
    expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'binding.write_footprint_overlap', phase: 'plan' }] });
    expect(runtimeCommit).not.toHaveBeenCalled();
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('First');
  });

  it('rejects a stale exact-head basis after planning and retains the structured outcome', async () => {
    const { runtime, source, binding } = fixture();
    const stale = source.snapshot().basis as JsonValue;
    runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => { draft.tasks.first!.priority = 2; }));
    const edit = selectedEdit(source, binding, { title: 'After external change' });
    const result = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [edit],
      commit: commitInput(stale, 'operation:stale', 'c')
    });
    expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale', phase: 'commit', retry: 'after_refresh' }] });
    expect(runtime.snapshot().storage.tasks.first).toEqual({ title: 'First', priority: 2 });
    await expect(source.queryOutcome({ operationEpoch: 'epoch:one', operationId: 'operation:stale', intentHash: intentHash('c') })).resolves.toMatchObject({
      status: 'known', result: { outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] }
    });
  });

  it('commits a semantic no-op without changing heads or notifying subscribers', async () => {
    const { runtime, source, binding } = fixture();
    const before = source.snapshot();
    const listener = vi.fn();
    source.subscribe(listener);
    const result = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [selectedEdit(source, binding, { title: 'First', priority: 1 })],
      commit: commitInput(before.basis as JsonValue, 'operation:noop', 'd')
    });
    expect(result.outcome).toBe('committed');
    expect(listener).not.toHaveBeenCalled();
    expect(exactAutomergeBasisEqual(before.basis as import('../src/index.js').AutomergeBasis, source.snapshot().basis as import('../src/index.js').AutomergeBasis)).toBe(true);
    expect(runtime.snapshot().storage.tasks.first).toEqual({ title: 'First', priority: 1 });
  });

  it('returns deeply frozen commit and outcome evidence from the core facade', async () => {
    const { runtime, source } = fixture();
    const apply = vi.fn((draft: TaskDoc) => { draft.tasks.first!.title = 'Owned by handoff'; });
    const replacementApply = vi.fn((draft: TaskDoc) => { draft.tasks.first!.title = 'Mutated after handoff'; });
    const command = { apply };
    const commands = [command];
    const input = {
      ...commitInput(source.snapshot().basis as JsonValue, 'operation:frozen-facade', '9'),
      commands
    };
    const pending = source.commit(input);
    command.apply = replacementApply;
    commands.push({ apply: replacementApply });
    const result = await pending;
    expect([result, result.issues, result.beforeBasis, result.afterBasis].every(Object.isFrozen)).toBe(true);
    expect(() => { (result.issues as unknown[]).push({ code: 'mutated' }); }).toThrow(TypeError);
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('Owned by handoff');
    expect(apply).toHaveBeenCalledOnce();
    expect(replacementApply).not.toHaveBeenCalled();

    const lookup = await source.queryOutcome(input);
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(lookup.status).toBe('known');
    if (lookup.status === 'known') {
      expect([lookup.result, lookup.result.issues, lookup.result.beforeBasis, lookup.result.afterBasis].every(Object.isFrozen)).toBe(true);
    }
  });

  it('lowers counter, text, and list edits to their exact Automerge operations', async () => {
    const doc = Automerge.from<TaskDoc>({
      tasks: { first: { title: 'First', count: new Automerge.Counter(2), tags: ['a', 'b'] } }
    }, { actor: actor('4') });
    const { runtime, source, binding } = fixture(doc);
    const target = selectedTarget(source, binding);
    const before = source.snapshot();
    const result = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [
        { ...target, kind: 'counter-increment', field: 'count', by: 3 },
        { ...target, kind: 'text-splice', field: 'title', index: 0, deleteCount: 5, value: 'Changed' },
        { ...target, kind: 'list-splice', field: 'tags', index: 1, deleteCount: 1, values: ['x', 'y'] }
      ],
      commit: commitInput(before.basis as JsonValue, 'operation:semantic-fields', 'f')
    });
    expect(result.outcome).toBe('committed');
    const row = runtime.snapshot().storage.tasks.first;
    expect(Number(row?.count)).toBe(5);
    expect(Automerge.isCounter(row?.count)).toBe(true);
    expect(row?.title).toBe('Changed');
    expect(row?.tags).toEqual(['a', 'x', 'y']);
  });

  it('inserts and deletes map rows through coordinated semantic edits', async () => {
    const { runtime, source, binding } = fixture();
    const inserted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ kind: 'insert', relationId: 'relation:tasks', key: ['second'], fields: { title: 'Second', priority: 2 } }],
      commit: commitInput(source.snapshot().basis as JsonValue, 'operation:insert', '6')
    });
    expect(inserted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks.second).toEqual({ title: 'Second', priority: 2 });

    const target = selectedTarget(source, binding, 'second');
    const deleted = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ ...target, kind: 'delete' }],
      commit: commitInput(source.snapshot().basis as JsonValue, 'operation:delete', '7')
    });
    expect(deleted.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks.second).toBeUndefined();
  });

  it('publishes basis, freshness, lifecycle, merge, and close changes as core snapshots', () => {
    const { runtime, source } = fixture();
    const snapshots: ReturnType<typeof source.snapshot>[] = [];
    source.subscribe(() => { snapshots.push(source.snapshot()); });
    source.setFreshness('stale');
    source.setLifecycle('loading');
    expect(source.snapshot()).toMatchObject({ state: 'loading', freshness: 'stale' });
    expect(source.snapshot()).not.toHaveProperty('storage');
    runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => { draft.tasks.second = { title: 'Second' }; }));
    expect(source.snapshot()).toMatchObject({ state: 'loading', freshness: 'stale' });
    expect(() => source.stage(source.snapshot(), [])).toThrow(/non-ready/);
    source.markReady();
    source.close();
    expect(snapshots.map(({ state }) => state)).toEqual(['ready', 'loading', 'loading', 'ready', 'closed']);
    expect(source.snapshot()).toMatchObject({ state: 'closed', freshness: 'none', issues: [{ code: 'source.closed' }] });
    expect(() => runtime.snapshot()).not.toThrow();
  });

  it('does not let an observer make an applied runtime commit appear rejected', async () => {
    const diagnostics = vi.fn();
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: baseDoc(), onDiagnostic: diagnostics });
    const observerFailure = new Error('observer failed');
    runtime.subscribe(() => { throw observerFailure; });
    const before = runtime.snapshot();
    const result = await runtime.commit({
      ...commitInput(before.basis as JsonValue, 'operation:throwing-observer', '5'),
      expectedBasis: before.basis,
      commands: [{ apply: (draft) => { draft.tasks.first!.title = 'Committed'; } }]
    });
    expect(result).toMatchObject({ outcome: 'committed', changed: true });
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('Committed');
    expect(diagnostics).toHaveBeenCalledWith({
      kind: 'listener_error', component: 'source-runtime', operation: 'publish', error: observerFailure
    });
  });

  it('finalizes an owned atomic source and attempts every teardown after contained failures', () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: baseDoc() });
    const unsubscribeFailure = new Error('unsubscribe failed');
    const runtimeCloseFailure = new Error('runtime close failed');
    vi.spyOn(runtime, 'subscribe').mockImplementation(() => () => { throw unsubscribeFailure; });
    vi.spyOn(runtime, 'close').mockImplementation(() => { throw runtimeCloseFailure; });
    const diagnostics = vi.fn((_diagnostic: AutomergeSourceDiagnostic) => { throw new Error('diagnostic sink failed'); });
    const source = new AutomergeAtomicSource({
      runtime,
      operationEpoch: 'epoch:teardown',
      ownsRuntime: true,
      onDiagnostic: diagnostics
    });
    const observerFailure = new Error('observer failed');
    const listener = vi.fn(() => { throw observerFailure; });
    source.subscribe(listener);

    expect(() => source.close()).not.toThrow();

    expect(source.snapshot()).toMatchObject({ state: 'closed', freshness: 'none' });
    expect(listener).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls.map(([diagnostic]) => diagnostic)).toEqual([
      { kind: 'listener_error', component: 'atomic-source', operation: 'publish', error: observerFailure },
      { kind: 'cleanup_error', component: 'atomic-source', operation: 'close.unsubscribe-runtime', error: unsubscribeFailure },
      { kind: 'cleanup_error', component: 'atomic-source', operation: 'close.runtime', error: runtimeCloseFailure }
    ]);
    expect(() => source.close()).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledTimes(3);
  });

  it('resolves an exactly observed concurrent map conflict through the coordinator', async () => {
    const base = baseDoc();
    let left = Automerge.clone(base, { actor: actor('2') });
    let right = Automerge.clone(base, { actor: actor('3') });
    left = Automerge.change(left, { time: 0 }, (draft) => { draft.tasks.same = { title: 'Left' }; });
    right = Automerge.change(right, { time: 0 }, (draft) => { draft.tasks.same = { title: 'Right' }; });
    const { runtime, source, binding } = fixture(Automerge.merge(left, right));
    const projection = binding.project(source.snapshot());
    expect(projection.issues.map(({ code }) => code).sort()).toEqual(expect.arrayContaining(['automerge.logical_key_ambiguous', 'automerge.map_key_conflict']));
    const alternatives = Object.entries(Automerge.getConflicts(runtime.snapshot().storage.tasks, 'same') ?? {}).sort(([leftHash], [rightHash]) => leftHash.localeCompare(rightHash));
    const selected = alternatives.find(([, value]) => (value as Task).title === 'Left');
    const candidate = projection.rows.find((row) => row.key[0] === 'same' && row.conflictChangeHash === selected?.[0]);
    if (candidate === undefined) throw new Error('conflict candidate missing');
    const result = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{
        kind: 'conflict-resolve',
        relationId: 'relation:tasks',
        key: candidate.key as JsonValue,
        locator: candidate.locator as unknown as JsonValue,
        observedChangeHashes: alternatives.map(([changeHash]) => changeHash),
        selectedChangeHash: selected?.[0] ?? ''
      }],
      commit: commitInput(source.snapshot().basis as JsonValue, 'operation:conflict', 'e')
    });
    expect(result.outcome).toBe('committed');
    expect(runtime.snapshot().storage.tasks.same?.title).toBe('Left');
    expect(Automerge.getConflicts(runtime.snapshot().storage.tasks, 'same')).toBeUndefined();
  });

  it('rejects generic rekey lowering with exact capability evidence instead of approximating replacement', async () => {
    const { runtime, source, binding } = fixture();
    const target = selectedTarget(source, binding);
    const before = source.snapshot();
    const rekeyed = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ ...target, kind: 'rekey', newKey: ['renamed'] }],
      commit: commitInput(before.basis as JsonValue, 'operation:rekey', '9')
    });
    expect(rekeyed).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.capability_unavailable', requiredCapabilities: [{ id: 'urn:tarstate:capability:entity/rekey' }] }] });
    expect(runtime.snapshot().storage.tasks).toEqual({ first: { title: 'First', priority: 1 } });
    expect(exactAutomergeBasisEqual(before.basis as import('../src/index.js').AutomergeBasis, source.snapshot().basis as import('../src/index.js').AutomergeBasis)).toBe(true);
  });

  it('rejects generic move intent without writing or interpreting move metadata', async () => {
    const { runtime, source, binding } = fixture();
    const target = selectedTarget(source, binding);
    const before = source.snapshot();
    const moved = await coordinateSourceCommit({
      source,
      bindings: [binding],
      edits: [{ ...target, kind: 'move-relocate', destination: { relationId: 'relation:tasks', key: ['elsewhere'] }, mode: 'copy-relocate' }],
      commit: commitInput(before.basis as JsonValue, 'operation:move', '8')
    });
    expect(moved).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.capability_unavailable', requiredCapabilities: [{ id: 'urn:tarstate:capability:entity/copy-relocate' }] }] });
    expect(runtime.snapshot().storage.tasks).toEqual({ first: { title: 'First', priority: 1 } });
    expect(Object.hasOwn(runtime.snapshot().storage, '__tarstateMovesV1')).toBe(false);
  });

  it('relates exact and subtree footprints without accepting foreign footprint formats', () => {
    const collection = automergePathFootprint([{ scope: 'subtree', path: ['tasks'] }]);
    const title = automergePathFootprint([{ scope: 'exact', path: ['tasks', 'first', 'title'] }]);
    const other = automergePathFootprint([{ scope: 'exact', path: ['metadata', 'schema'] }]);
    expect(relateAutomergeFootprints(title, collection)).toBe('contained_by');
    expect(relateAutomergeFootprints(collection, title)).toBe('contains');
    expect(relateAutomergeFootprints(title, title)).toBe('equal');
    expect(relateAutomergeFootprints(title, other)).toBe('disjoint');
    expect(relateAutomergeFootprints(title, { kind: 'foreign' })).toBe('unknown');
  });
});
