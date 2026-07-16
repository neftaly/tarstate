import { Repo } from '@automerge/automerge-repo';
import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AutomergeAtomicSource } from '../src/adapter/atomic-source.js';
import {
  AutomergeSourceRuntime,
  automergeRepoSourceRuntime,
  exactAutomergeBasisEqual,
  type AutomergeRepoHandle,
  type AutomergeSourceRuntimeApi,
} from '../src/source/runtime.js';

type CounterDoc = { count: number };
const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;
const input = (runtime: AutomergeSourceRuntimeApi<CounterDoc>, operationId: string, digit = '1') => ({
  operationEpoch: 'epoch:test',
  operationId,
  intentHash: hash(digit),
  expectedBasis: runtime.snapshot().basis,
});

describe('Automerge Repo source owner', () => {
  it('exposes only capabilities supported by each owner', async () => {
    const repo = new Repo();
    const handle = repo.create<CounterDoc>({ count: 0 });
    const repoRuntime = automergeRepoSourceRuntime({ handle });
    const memoryRuntime = new AutomergeSourceRuntime({ sourceId: 'memory:counter', doc: handle.doc()! });

    expectTypeOf<'merge' extends keyof typeof repoRuntime ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'replace' extends keyof typeof repoRuntime ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'merge' extends keyof typeof memoryRuntime ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<'replace' extends keyof typeof memoryRuntime ? true : false>().toEqualTypeOf<true>();

    const source = new AutomergeAtomicSource({ runtime: repoRuntime, operationEpoch: 'epoch:adapter' });
    expect(source.snapshot()).toMatchObject({ sourceId: handle.url, state: 'ready' });
    source.close();
    memoryRuntime.close();
    await repo.shutdown();
  });

  it('keeps the handle canonical across exact-head commits and external changes', async () => {
    const repo = new Repo();
    const handle = repo.create<CounterDoc>({ count: 0 });
    const runtime = automergeRepoSourceRuntime({ handle });
    const initial = runtime.snapshot();
    const changeAt = vi.spyOn(handle, 'changeAt');
    const changes = vi.fn();
    const apply = vi.fn((draft: CounterDoc) => { draft.count = 1; });
    runtime.subscribe(changes);

    const committed = await runtime.commit({
      ...input(runtime, 'commit'),
      commands: [{ apply }],
    });
    expect(committed).toMatchObject({ outcome: 'committed', changed: true });
    expect(apply).toHaveBeenCalledOnce();
    expect(changeAt).toHaveBeenCalledWith(expect.any(Array), expect.any(Function), expect.any(Object));
    expect(runtime.snapshot().storage).toBe(handle.doc()!);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ origin: 'commit' }));

    handle.change((draft) => { draft.count = 2; });
    expect(runtime.snapshot().storage).toBe(handle.doc()!);
    expect(runtime.snapshot().storage.count).toBe(2);
    expect(exactAutomergeBasisEqual(initial.basis, runtime.snapshot().basis)).toBe(false);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ origin: 'handle' }));

    const staleCommand = vi.fn();
    const rejected = await runtime.commit({
      operationEpoch: 'epoch:test',
      operationId: 'stale',
      intentHash: hash('3'),
      expectedBasis: initial.basis,
      commands: [{ apply: staleCommand }],
    });
    expect(rejected).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] });
    expect(staleCommand).not.toHaveBeenCalled();
    expect(changeAt).toHaveBeenCalledTimes(1);

    runtime.close();
    handle.change((draft) => { draft.count = 3; });
    expect(handle.doc()!.count).toBe(3);
    await repo.shutdown();
  });

  it('does not emit phantom changes and shares idempotency, ambiguity, and epoch retirement', async () => {
    const repo = new Repo();
    const handle = repo.create<CounterDoc>({ count: 0 });
    const runtime = automergeRepoSourceRuntime({ handle });
    const listener = vi.fn();
    const changeAt = vi.spyOn(handle, 'changeAt');
    runtime.subscribe(listener);
    const operation = input(runtime, 'same');

    const noOp = await runtime.commit({ ...operation, commands: [] });
    expect(noOp).toMatchObject({ outcome: 'committed', changed: false });
    expect(listener).not.toHaveBeenCalled();
    expect(await runtime.commit({ ...operation, commands: [] })).toBe(noOp);
    expect(changeAt).not.toHaveBeenCalled();
    expect(runtime.queryOutcome({ ...operation, intentHash: hash('2') })).toEqual({ status: 'ambiguous' });

    await runtime.retireOperationEpoch(operation.operationEpoch);
    expect(runtime.queryOutcome(operation)).toEqual({ status: 'expired' });
    await expect(runtime.commit({ ...operation, commands: [] })).resolves.toMatchObject({
      outcome: 'rejected', issues: [{ code: 'transaction.operation_epoch_expired' }],
    });
    await repo.shutdown();
  });

  it('keeps a Repo changeAt refusal transient instead of recording a phantom commit', async () => {
    const repo = new Repo();
    const handle = repo.create<CounterDoc>({ count: 0 });
    const runtime = automergeRepoSourceRuntime({ handle });
    const operation = input(runtime, 'change-at-refused');
    const apply = vi.fn((draft: CounterDoc) => { draft.count = 1; });
    vi.spyOn(handle, 'changeAt').mockReturnValueOnce(undefined);

    const rejected = await runtime.commit({ ...operation, commands: [{ apply }] });

    expect(rejected).toMatchObject({
      outcome: 'rejected',
      changed: false,
      issues: [{ code: 'transaction.expected_basis_stale' }],
    });
    expect(apply).not.toHaveBeenCalled();
    expect(handle.doc()!.count).toBe(0);
    expect(runtime.queryOutcome(operation)).toEqual({ status: 'not_seen' });
    runtime.close();
    await repo.shutdown();
  });

  it('removes the Repo listener when runtime construction fails', () => {
    const on = vi.fn();
    const off = vi.fn();
    const constructionFailure = new Error('doc unavailable');
    const handle: AutomergeRepoHandle<CounterDoc, readonly string[]> = {
      url: 'automerge:test-construction-failure',
      isReady: () => true,
      isReadOnly: () => false,
      doc: () => { throw constructionFailure; },
      heads: () => [],
      changeAt: () => undefined,
      on,
      off,
    };

    expect(() => automergeRepoSourceRuntime({ handle })).toThrow(constructionFailure);
    expect(on).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('heads-changed', on.mock.calls[0]?.[1]);
  });

  it('rejects a ready Repo handle whose document is unavailable', () => {
    const on = vi.fn();
    const off = vi.fn();
    const handle: AutomergeRepoHandle<CounterDoc, readonly string[]> = {
      url: 'automerge:test-missing-document',
      isReady: () => true,
      isReadOnly: () => false,
      doc: () => undefined,
      heads: () => [],
      changeAt: () => undefined,
      on,
      off,
    };

    expect(() => automergeRepoSourceRuntime({ handle })).toThrow(/document is unavailable/);
    expect(on).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('heads-changed', on.mock.calls[0]?.[1]);
  });

  it('records receipts before isolated listeners observe canonical changes', async () => {
    const repo = new Repo();
    const handle = repo.create<CounterDoc>({ count: 0 });
    const runtime = automergeRepoSourceRuntime({ handle });
    const operation = input(runtime, 'listener');
    const observed = vi.fn(() => {
      expect(runtime.queryOutcome(operation).status).toBe('known');
      throw new Error('observer failed');
    });
    runtime.subscribe(observed);

    await expect(runtime.commit({
      ...operation,
      commands: [{ apply: (draft) => { draft.count = 1; } }],
    })).resolves.toMatchObject({ outcome: 'committed' });
    expect(observed).toHaveBeenCalledOnce();
    expect(handle.doc()!.count).toBe(1);
    await repo.shutdown();
  });

  it('rejects close during apply and rejects queued work closed before execution', async () => {
    const repo = new Repo();
    const handle = repo.create<CounterDoc>({ count: 0 });
    const runtime = automergeRepoSourceRuntime({ handle });
    const duringApply = await runtime.commit({
      ...input(runtime, 'close-during-apply'),
      commands: [{ apply: () => { runtime.close(); } }],
    });
    expect(duringApply).toMatchObject({ outcome: 'rejected', issues: [{ code: 'automerge.command_failed' }] });
    expect(runtime.snapshot().storage.count).toBe(0);

    const queued = runtime.commit({
      ...input(runtime, 'queued-close'),
      commands: [{ apply: (draft) => { draft.count = 1; } }],
    });
    runtime.close();
    await expect(queued).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'source.closed' }] });
    expect(handle.doc()!.count).toBe(0);
    expect(handle.isReady()).toBe(true);
    await repo.shutdown();
  });

  it('finalizes a Repo runtime when owner teardown throws and reports the failure once', () => {
    const doc = Automerge.from<CounterDoc>({ count: 0 }, { actor: '7'.repeat(64) });
    const closeFailure = new Error('handle off failed');
    const diagnostics = vi.fn();
    const handle: AutomergeRepoHandle<CounterDoc, readonly string[]> = {
      url: 'automerge:test-close-failure',
      isReady: () => true,
      isReadOnly: () => false,
      doc: () => doc,
      heads: () => Automerge.getHeads(doc),
      changeAt: () => Automerge.getHeads(doc),
      on: vi.fn(),
      off: vi.fn(() => { throw closeFailure; })
    };
    const runtime = automergeRepoSourceRuntime({ handle, onDiagnostic: diagnostics });
    const listener = vi.fn();
    runtime.subscribe(listener);

    expect(() => runtime.close()).not.toThrow();
    expect(() => runtime.snapshot()).toThrow(/closed/);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith({
      kind: 'cleanup_error', component: 'source-runtime', operation: 'close.owner', error: closeFailure
    });
    expect(() => runtime.close()).not.toThrow();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });
});
