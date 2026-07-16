import * as Automerge from '@automerge/automerge';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeMapStorageBinding
} from '../src/core-adapter.js';
import {
  AutomergeSourceRuntime,
  automergeBasis,
  exactAutomergeBasisEqual
} from '../src/source.js';
import { projectAutomergeFacts } from '../src/projection.js';
import {
  AutomergeMapProjectionPlanner,
  snapshotAutomergeDocument
} from '../src/storage-binding.js';

const actor = (digit: string): string => digit.repeat(64);
const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;

type Task = { title: string; count?: Automerge.Counter };
type TaskDoc = { tasks: Record<string, Task>; metadata: { schema: string } };

const taskBase = (): Automerge.Doc<TaskDoc> => Automerge.from(
  { tasks: { first: { title: 'First' } }, metadata: { schema: 'v1' } },
  { actor: actor('1') }
);

describe('production Automerge adapter', () => {
  it('returns rejection evidence when a queued commit reaches a closed source', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:closed', doc: taskBase() });
    const before = runtime.snapshot().basis;
    runtime.close();
    await expect(runtime.commit({ operationEpoch: 'epoch:1', operationId: 'closed', intentHash: hash('0'), expectedBasis: before, commands: [] }))
      .resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'source.closed' }] });
  });

  it('retires operation epochs without evicting live epoch evidence', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:epochs', doc: taskBase() });
    const basis = runtime.snapshot().basis;
    const first = { operationEpoch: 'epoch:old', operationId: 'one', intentHash: hash('1'), expectedBasis: basis, commands: [] };
    const current = { operationEpoch: 'epoch:current', operationId: 'two', intentHash: hash('2'), expectedBasis: basis, commands: [] };
    await runtime.commit(first);
    await runtime.commit(current);
    await runtime.retireOperationEpoch('epoch:old');
    expect(runtime.queryOutcome(first)).toEqual({ status: 'expired' });
    expect(runtime.queryOutcome(current)).toMatchObject({ status: 'known' });
    await expect(runtime.commit(first)).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_epoch_expired' }] });
  });

  it('keeps delimiter-containing operation identities distinct in the ledger', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:collision-safe-ledger', doc: taskBase() });
    const basis = runtime.snapshot().basis;
    const first = {
      operationEpoch: 'epoch:left',
      operationId: 'operation:right\u0000tail',
      intentHash: hash('1'),
      expectedBasis: basis,
      commands: []
    };
    const second = {
      operationEpoch: 'epoch:left\u0000operation:right',
      operationId: 'tail',
      intentHash: hash('2'),
      expectedBasis: basis,
      commands: []
    };

    const firstResult = await runtime.commit(first);
    const secondResult = await runtime.commit(second);

    expect(firstResult).toMatchObject({ outcome: 'committed', operationEpoch: first.operationEpoch, operationId: first.operationId });
    expect(secondResult).toMatchObject({ outcome: 'committed', operationEpoch: second.operationEpoch, operationId: second.operationId });
    expect(secondResult).not.toBe(firstResult);
    expect(runtime.queryOutcome(first)).toEqual({ status: 'known', result: firstResult });
    expect(runtime.queryOutcome(second)).toEqual({ status: 'known', result: secondResult });

    await runtime.retireOperationEpoch(first.operationEpoch);
    expect(runtime.queryOutcome(first)).toEqual({ status: 'expired' });
    expect(runtime.queryOutcome(second)).toEqual({ status: 'known', result: secondResult });
  });

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
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.issues)).toBe(true);
    expect(() => { (committed as { outcome: string }).outcome = 'rejected'; }).toThrow(TypeError);
    const known = runtime.queryOutcome({ operationEpoch: 'epoch:1', operationId: 'operation:1', intentHash: hash('a') });
    expect(Object.isFrozen(known)).toBe(true);
    expect(known.status === 'known' ? known.result : undefined).toBe(committed);
    const noOp = await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:noop', intentHash: hash('b'), expectedBasis: runtime.snapshot().basis, commands: []
    });
    expect(noOp).toMatchObject({ outcome: 'committed', changed: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.queryOutcome({ operationEpoch: 'epoch:1', operationId: 'operation:1', intentHash: hash('c') })).toEqual({ status: 'ambiguous' });
  });

  it('owns commit input synchronously before queued execution', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:queued-input', doc: taskBase() });
    const expectedBasis = { kind: 'automerge-heads' as const, heads: [...runtime.snapshot().basis.heads] };
    const apply = vi.fn((draft: TaskDoc) => { draft.tasks.first!.title = 'Owned'; });
    const replacementApply = vi.fn((draft: TaskDoc) => { draft.tasks.first!.title = 'Mutated'; });
    const command = { description: 'owned description', apply };
    const commands = [command];
    const input = {
      operationEpoch: 'epoch:owned', operationId: 'operation:owned', intentHash: hash('7'),
      expectedBasis, commands, message: 'owned message'
    };

    const pending = runtime.commit(input);
    input.operationId = 'operation:mutated';
    input.message = 'mutated message';
    expectedBasis.heads.splice(0, expectedBasis.heads.length, 'mutated-head');
    command.description = 'mutated description';
    command.apply = replacementApply;
    commands.push({ description: 'late command', apply: replacementApply });

    const result = await pending;
    expect(result).toMatchObject({ outcome: 'committed', operationId: 'operation:owned' });
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('Owned');
    expect(apply).toHaveBeenCalledOnce();
    expect(replacementApply).not.toHaveBeenCalled();
    expect(runtime.queryOutcome({ operationEpoch: 'epoch:owned', operationId: 'operation:owned', intentHash: hash('7') })).toMatchObject({ status: 'known' });
    expect(runtime.queryOutcome({ operationEpoch: 'epoch:owned', operationId: 'operation:mutated', intentHash: hash('7') })).toEqual({ status: 'not_seen' });
  });

  it('rejects hostile known commit accessors without invoking them', () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:hostile-commit', doc: taskBase() });
    let calls = 0;
    const input: Record<string, unknown> = {
      operationEpoch: 'epoch:hostile', operationId: 'operation:hostile', intentHash: hash('6'), commands: []
    };
    Object.defineProperty(input, 'expectedBasis', {
      enumerable: true,
      get: () => { calls += 1; return runtime.snapshot().basis; }
    });

    expect(() => runtime.commit(input as never)).toThrow(/hostile property descriptor/);
    expect(calls).toBe(0);
  });

  it('rejects malformed public commit input before queue or ledger handoff', () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:malformed-commit', doc: taskBase() });
    const valid = {
      operationEpoch: 'epoch:valid',
      operationId: 'operation:valid',
      intentHash: hash('6'),
      expectedBasis: runtime.snapshot().basis,
      commands: [{ description: 'valid', apply: () => undefined }],
      message: 'valid'
    };
    const invalid: readonly (readonly [unknown, RegExp])[] = [
      [{ ...valid, operationEpoch: 1 }, /operationEpoch.*non-empty string/],
      [{ ...valid, operationEpoch: '' }, /operationEpoch.*non-empty string/],
      [{ ...valid, operationId: null }, /operationId.*non-empty string/],
      [{ ...valid, operationId: '' }, /operationId.*non-empty string/],
      [{ ...valid, intentHash: 'sha256:not-a-hash' }, /canonical SHA-256/],
      [{ ...valid, expectedBasis: { ...valid.expectedBasis, kind: 'other' } }, /kind must be automerge-heads/],
      [{ ...valid, expectedBasis: { kind: 'automerge-heads', heads: [1] } }, /canonical Automerge hashes/],
      [{ ...valid, expectedBasis: { kind: 'automerge-heads', heads: ['not-a-head'] } }, /canonical Automerge hashes/],
      [{ ...valid, expectedBasis: { kind: 'automerge-heads', heads: [valid.expectedBasis.heads[0], valid.expectedBasis.heads[0]] } }, /heads must be unique/],
      [{ ...valid, commands: [{ description: 1, apply: () => undefined }] }, /description must be a string/],
      [{ ...valid, commands: [{ description: 'invalid', apply: 'not-a-function' }] }, /apply must be a function/],
      [{ ...valid, message: 1 }, /message must be a string/]
    ];

    for (const [input, message] of invalid) expect(() => runtime.commit(input as never)).toThrow(message);
    expect(runtime.queryOutcome(valid)).toEqual({ status: 'not_seen' });
  });

  it('rejects malformed outcome and retirement identities without ledger coercion', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:malformed-lookup', doc: taskBase() });
    const identity = { operationEpoch: 'epoch:valid', operationId: 'operation:valid', intentHash: hash('6') };
    let accessorCalls = 0;
    const accessorIdentity: Record<string, unknown> = { operationId: identity.operationId, intentHash: identity.intentHash };
    Object.defineProperty(accessorIdentity, 'operationEpoch', {
      enumerable: true,
      get: () => { accessorCalls += 1; return identity.operationEpoch; }
    });

    expect(() => runtime.queryOutcome({ ...identity, operationEpoch: 1 } as never)).toThrow(/operationEpoch.*non-empty string/);
    expect(() => runtime.queryOutcome({ ...identity, operationId: null } as never)).toThrow(/operationId.*non-empty string/);
    expect(() => runtime.queryOutcome({ ...identity, intentHash: 'bad' } as never)).toThrow(/canonical SHA-256/);
    expect(() => runtime.queryOutcome(accessorIdentity as never)).toThrow(/hostile property descriptor/);
    expect(accessorCalls).toBe(0);
    await expect(runtime.retireOperationEpoch(1 as never)).rejects.toThrow(/non-empty string/);
    await expect(runtime.retireOperationEpoch('')).rejects.toThrow(/non-empty string/);

    expect(runtime.queryOutcome(identity)).toEqual({ status: 'not_seen' });
  });

  it('keeps snapshot identity stable and publishes each changed snapshot before notifying', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: taskBase() });
    const initial = runtime.snapshot();
    expect(runtime.snapshot()).toBe(initial);
    expect([initial, initial.basis, initial.basis.heads].every(Object.isFrozen)).toBe(true);
    expect(() => { (initial.basis.heads as string[]).push('mutated'); }).toThrow(TypeError);
    expect(runtime.snapshot()).toBe(initial);
    await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:noop', intentHash: hash('0'), expectedBasis: initial.basis, commands: []
    });
    expect(runtime.snapshot()).toBe(initial);
    const redundant = Automerge.clone(initial.storage, { actor: actor('2') });
    expect(runtime.merge(redundant)).toBe(initial);
    const sameHeadsDifferentActor = Automerge.clone(initial.storage, { actor: actor('3') });
    expect(Automerge.getActorId(sameHeadsDifferentActor)).not.toBe(Automerge.getActorId(initial.storage));
    expect(runtime.replace(sameHeadsDifferentActor)).toBe(initial);
    expect(Automerge.getActorId(runtime.snapshot().storage)).toBe(Automerge.getActorId(initial.storage));

    let previous = initial;
    const listener = vi.fn(() => {
      const current = runtime.snapshot();
      expect(current).not.toBe(previous);
      expect(runtime.snapshot()).toBe(current);
      previous = current;
    });
    runtime.subscribe(listener);
    await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:change', intentHash: hash('1'), expectedBasis: initial.basis,
      commands: [{ apply: (draft) => { draft.tasks.first!.title = 'Committed'; } }]
    });

    const beforeMerge = runtime.snapshot();
    const beforeMergeActor = Automerge.getActorId(beforeMerge.storage);
    const remote = Automerge.change(Automerge.clone(beforeMerge.storage, { actor: actor('2') }), { time: 0 }, (draft) => {
      draft.tasks.second = { title: 'Merged' };
    });
    const merged = runtime.merge(remote);
    expect(Automerge.getActorId(merged.storage)).toBe(beforeMergeActor);
    expect(beforeMerge.storage.tasks.second).toBeUndefined();
    expect(runtime.view(beforeMerge.basis).storage.tasks.second).toBeUndefined();
    expect([merged, merged.basis, merged.basis.heads].every(Object.isFrozen)).toBe(true);
    runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => { draft.metadata.schema = 'v2'; }));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('rejects an exact stale basis without running commands or completing the operation', async () => {
    const base = taskBase();
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: Automerge.change(base, (draft) => { draft.metadata.schema = 'v2'; }) });
    const command = vi.fn();
    let ignoredCalls = 0;
    const expectedBasis = Object.assign(Object.create(null) as Record<PropertyKey, unknown>, automergeBasis(base));
    Object.defineProperty(expectedBasis, Symbol('metadata'), {
      get: () => { ignoredCalls += 1; return 'ignored'; }
    });
    Object.defineProperty(expectedBasis, 'metadata', {
      get: () => { ignoredCalls += 1; return 'ignored'; }
    });
    const result = await runtime.commit({
      operationEpoch: 'epoch:1', operationId: 'operation:stale', intentHash: hash('d'),
      expectedBasis: expectedBasis as unknown as import('../src/source.js').AutomergeBasis,
      commands: [{ apply: command }]
    });
    expect(result).toMatchObject({ outcome: 'rejected', changed: false, issues: [{ code: 'transaction.expected_basis_stale' }] });
    expect(command).not.toHaveBeenCalled();
    expect([result, result.issues, result.issues[0], result.issues[0]?.details].every(Object.isFrozen)).toBe(true);
    expect(() => { (result.issues as unknown[]).push({ code: 'mutated' }); }).toThrow(TypeError);
    const lookup = runtime.queryOutcome({ operationEpoch: 'epoch:1', operationId: 'operation:stale', intentHash: hash('d') });
    expect(lookup).toEqual({ status: 'not_seen' });
    expect(ignoredCalls).toBe(0);
  });

  it('rejects an invalid Automerge basis kind before commit handoff', () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:invalid-basis-kind', doc: taskBase() });
    const command = vi.fn();
    expect(() => runtime.commit({
        operationEpoch: 'epoch:1', operationId: 'operation:invalid-kind', intentHash: hash('8'),
        expectedBasis: { ...runtime.snapshot().basis, kind: 'invalid-kind' } as never,
        commands: [{ apply: command }]
      }))
      .toThrow(/kind must be automerge-heads/);
    expect(command).not.toHaveBeenCalled();
  });

  it('owns map binding structure while preserving the parser callback identity', () => {
    const collectionPath: (string | number)[] = ['tasks'];
    const keySource = { field: 'title' };
    const parser = vi.fn((candidate: unknown) => ({
      success: true as const,
      row: { title: (candidate as Task).title }
    }));
    const replacementParser = vi.fn((_candidate: unknown) => ({ success: true as const, row: { title: 'Replacement' } }));
    const options = {
      id: 'binding:owned',
      relationId: 'relation:tasks',
      collectionPath,
      missingCollection: 'invalid' as const,
      keySource,
      locatorNamespace: 'owned-locator',
      parse: parser
    };
    const planner = new AutomergeMapProjectionPlanner<TaskDoc, Readonly<Record<string, import('@tarstate/core').JsonValue>>>(options);
    const binding = new AutomergeMapStorageBinding<TaskDoc, Readonly<Record<string, import('@tarstate/core').JsonValue>>>(options);

    collectionPath[0] = 'metadata';
    keySource.field = 'missing';
    options.id = 'binding:mutated';
    options.relationId = 'relation:mutated';
    options.locatorNamespace = 'mutated-locator';
    options.parse = replacementParser;

    const snapshot = snapshotAutomergeDocument('source:tasks', taskBase());
    expect(planner.project(snapshot).rows).toMatchObject([{ relationId: 'relation:tasks', key: ['First'], locator: { namespace: 'owned-locator' } }]);
    expect(binding.project({ ...snapshot, operationEpoch: 'epoch:one', state: 'ready', freshness: 'current', issues: [] }).rows)
      .toMatchObject([{ relationId: 'relation:tasks', key: ['First'], locator: { namespace: 'owned-locator' } }]);
    expect(binding.id).toBe('binding:owned');
    expect(binding.declaredReadFootprint).toMatchObject({ entries: [{ path: ['tasks'] }] });
    expect(parser).toHaveBeenCalled();
    expect(replacementParser).not.toHaveBeenCalled();
  });

  it('rejects hostile map option descriptors without invoking them', () => {
    let calls = 0;
    const options: Record<string, unknown> = {
      relationId: 'relation:tasks',
      missingCollection: 'invalid',
      keySource: 'map-key'
    };
    Object.defineProperty(options, 'collectionPath', {
      enumerable: true,
      get: () => { calls += 1; return ['tasks']; }
    });

    expect(() => new AutomergeMapProjectionPlanner(options as never)).toThrow(/hostile property descriptor/);
    expect(() => new AutomergeMapStorageBinding(options as never)).toThrow(/hostile property descriptor/);
    expect(calls).toBe(0);
  });

  it('ignores unrelated option metadata and accepts class and null-prototype records', () => {
    let ignoredCalls = 0;
    const keySource = Object.assign(Object.create(null) as Record<string, unknown>, { field: 'title', extra: 'ignored' });
    Object.defineProperty(keySource, 'ignored', { get: () => { ignoredCalls += 1; return 'ignored'; } });
    class Options {
      relationId = 'relation:tasks';
      collectionPath = ['tasks'];
      missingCollection = 'invalid' as const;
      keySource = keySource;
    }
    const options = new Options();
    Object.defineProperty(options, 'ignored', { get: () => { ignoredCalls += 1; return 'ignored'; } });
    Object.defineProperty(options, Symbol('metadata'), { get: () => { ignoredCalls += 1; return 'ignored'; } });
    const planner = new AutomergeMapProjectionPlanner<TaskDoc, Readonly<Record<string, import('@tarstate/core').JsonValue>>>(options as never);
    expect(planner.project(snapshotAutomergeDocument('source:tasks', taskBase())).rows[0]?.key).toEqual(['First']);

    const nullPrototypeOptions = Object.assign(Object.create(null) as Record<string, unknown>, {
      relationId: 'relation:tasks', collectionPath: ['tasks'], missingCollection: 'invalid', keySource: 'map-key'
    });
    expect(() => new AutomergeMapStorageBinding(nullPrototypeOptions as never)).not.toThrow();
    expect(ignoredCalls).toBe(0);
  });

  it('rejects non-index numeric collection path components', () => {
    for (const part of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new AutomergeMapProjectionPlanner({
        relationId: 'relation:tasks', collectionPath: ['tasks', part], missingCollection: 'invalid', keySource: 'map-key'
      })).toThrow(/collectionPath entries/);
    }
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

  it('bounds traversal and value normalization depth before projecting hostile nesting', () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 24; depth += 1) nested = { child: nested };
    const facts = projectAutomergeFacts(Automerge.from(nested), {
      maxObjects: 100,
      maxProperties: 100,
      maxDepth: 4,
      maxNormalizedValues: 100
    });

    expect(facts.completeness).toBe('unknown');
    expect(facts.objects).toHaveLength(5);
    expect(facts.issues).toContainEqual(expect.objectContaining({
      code: 'automerge.projection_budget_exceeded',
      details: { budget: 'maxDepth', limit: 4 }
    }));
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
