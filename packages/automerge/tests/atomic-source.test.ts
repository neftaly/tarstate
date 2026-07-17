import * as Automerge from '@automerge/automerge';
import type { ContentHash, JsonValue } from '@tarstate/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomergeAtomicSource,
  automergePathFootprint,
  relateAutomergeFootprints
} from '../src/adapter/atomic-source.js';
import {
  AutomergeSourceRuntime,
  exactAutomergeBasisEqual,
  type AutomergeSourceDiagnostic
} from '../src/source/runtime.js';

type TaskDoc = { tasks: Record<string, { title: string }> };

const actor = (digit: string): string => digit.repeat(64);
const intentHash = (digit: string): ContentHash => `sha256:${digit.repeat(64)}`;
const baseDoc = (): Automerge.Doc<TaskDoc> => Automerge.from(
  { tasks: { first: { title: 'First' } } },
  { actor: actor('1') }
);

const fixture = () => {
  const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: baseDoc() });
  const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:one' });
  return { runtime, source };
};

const commitInput = (expectedBasis: JsonValue, operationId: string, digit: string) => ({
  operationEpoch: 'epoch:one',
  operationId,
  intentHash: intentHash(digit),
  expectedBasis
});

describe('Automerge core source protocol', () => {
  it('stages and commits against exact heads without mutating during validation', async () => {
    const { runtime, source } = fixture();
    const before = source.snapshot();
    const staged = source.stage(before, [{
      description: 'rename task',
      apply: (draft) => {
        draft.tasks.first!.title = 'Changed';
      }
    }]);

    expect(staged.storage.tasks.first?.title).toBe('Changed');
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('First');

    const result = await source.commit({
      ...commitInput(before.basis as JsonValue, 'operation:change', 'a'),
      commands: [{
        description: 'rename task',
        apply: (draft) => {
          draft.tasks.first!.title = 'Changed';
        }
      }]
    });

    expect(result).toMatchObject({ outcome: 'committed', issues: [] });
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('Changed');
    expect(exactAutomergeBasisEqual(
      before.basis as import('../src/source/runtime.js').AutomergeBasis,
      source.snapshot().basis as import('../src/source/runtime.js').AutomergeBasis
    )).toBe(false);
  });

  it('owns generated key evidence and preserves the staged identity on publish', async () => {
    type ListDocument = { items: { title: string }[] };
    const runtime = new AutomergeSourceRuntime<ListDocument>({
      sourceId: 'source:generated-keys',
      doc: Automerge.from<ListDocument>({ items: [] }, { actor: actor('2') })
    });
    const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:generated-keys' });
    const before = source.snapshot();
    const command = {
      generatesKeys: true as const,
      apply: (
        draft: Parameters<Automerge.ChangeFn<ListDocument>>[0],
        context: Parameters<import('../src/source/runtime.js').AutomergeSourceCommand<ListDocument>['apply']>[1]
      ) => {
        draft.items.push({ title: 'Generated' });
        const objectId = Automerge.getObjectId(draft.items[0]!);
        if (objectId === null) throw new Error('missing generated object identity');
        const key = [objectId];
        context.recordGeneratedKey('items', 'new-item', key);
        key[0] = 'caller mutation';
      }
    };
    const staged = source.stage(before, [command]);
    const stagedId = Automerge.getObjectId(staged.storage.items[0]!);

    const result = await source.commit({
      operationEpoch: 'epoch:generated-keys',
      operationId: 'operation:generated-keys',
      intentHash: intentHash('b'),
      expectedBasis: before.basis,
      commands: [command]
    });

    expect(result).toMatchObject({ outcome: 'committed' });
    expect(result.generatedKeys).toEqual([{
      relationId: 'items',
      token: 'new-item',
      key: [stagedId]
    }]);
    expect(Automerge.getObjectId(runtime.snapshot().storage.items[0]!)).toBe(stagedId);
    expect([result.generatedKeys, result.generatedKeys?.[0], result.generatedKeys?.[0]?.key].every(Object.isFrozen)).toBe(true);
  });

  it('returns deeply frozen commit and replay evidence', async () => {
    const { runtime, source } = fixture();
    const apply = vi.fn((draft: TaskDoc) => {
      draft.tasks.first!.title = 'Owned by handoff';
    });
    const replacementApply = vi.fn((draft: TaskDoc) => {
      draft.tasks.first!.title = 'Mutated after handoff';
    });
    const command = { apply };
    const commands = [command];
    const input = {
      ...commitInput(source.snapshot().basis as JsonValue, 'operation:frozen', '9'),
      commands
    };
    const pending = source.commit(input);
    command.apply = replacementApply;
    commands.push({ apply: replacementApply });

    const result = await pending;
    expect([result, result.issues, result.beforeBasis, result.afterBasis].every(Object.isFrozen)).toBe(true);
    expect(runtime.snapshot().storage.tasks.first?.title).toBe('Owned by handoff');
    expect(apply).toHaveBeenCalledOnce();
    expect(replacementApply).not.toHaveBeenCalled();

    const lookup = await source.queryOutcome(input);
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(lookup).toMatchObject({ status: 'known', result: { outcome: 'committed' } });
  });

  it('publishes freshness and lifecycle changes as source snapshots', () => {
    const { runtime, source } = fixture();
    const states: string[] = [];
    source.subscribe(() => {
      states.push(source.snapshot().state);
    });

    source.setFreshness('stale');
    source.setLifecycle('loading');
    runtime.replace(Automerge.change(runtime.snapshot().storage, { time: 0 }, (draft) => {
      draft.tasks.second = { title: 'Second' };
    }));
    source.markReady();
    source.close();

    expect(states).toEqual(['ready', 'loading', 'loading', 'ready', 'closed']);
    expect(source.snapshot()).toMatchObject({
      state: 'closed',
      freshness: 'none',
      issues: [{ code: 'source.closed' }]
    });
  });

  it('contains observer and owned-runtime teardown failures', () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc: baseDoc() });
    const unsubscribeFailure = new Error('unsubscribe failed');
    const runtimeCloseFailure = new Error('runtime close failed');
    vi.spyOn(runtime, 'subscribe').mockImplementation(() => () => {
      throw unsubscribeFailure;
    });
    vi.spyOn(runtime, 'close').mockImplementation(() => {
      throw runtimeCloseFailure;
    });
    const diagnostics = vi.fn((_diagnostic: AutomergeSourceDiagnostic) => {
      throw new Error('diagnostic sink failed');
    });
    const source = new AutomergeAtomicSource({
      runtime,
      operationEpoch: 'epoch:teardown',
      ownsRuntime: true,
      onDiagnostic: diagnostics
    });
    const observerFailure = new Error('observer failed');
    source.subscribe(() => {
      throw observerFailure;
    });

    expect(() => source.close()).not.toThrow();
    expect(diagnostics.mock.calls.map(([diagnostic]) => diagnostic)).toEqual([
      { kind: 'listener_error', component: 'atomic-source', operation: 'publish', error: observerFailure },
      { kind: 'cleanup_error', component: 'atomic-source', operation: 'close.unsubscribe-runtime', error: unsubscribeFailure },
      { kind: 'cleanup_error', component: 'atomic-source', operation: 'close.runtime', error: runtimeCloseFailure }
    ]);
  });

  it('relates exact and subtree footprints without accepting foreign formats', () => {
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
