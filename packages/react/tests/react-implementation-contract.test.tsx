import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createAdapterStore,
  createRuntimeStore,
  createSourceStore,
  TarstateProvider,
  useTarstateCommit,
  useTarstateQueries,
  useTarstateQuery,
  useTarstateSnapshot,
  type QueryHookState,
  type QueriesHookState,
  type TarstateCommitResult,
  type TarstateSnapshot,
  type TarstateStore
} from '@tarstate/react';
import type { AdapterSource, RelationAdapter, RelationApplyResult, RelationRuntime } from '@tarstate/core/adapter';
import { from, as, pipe, project, type Query } from '@tarstate/core/query';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';
import { write } from '@tarstate/core/write';

type ItemRow = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};

const contractSchema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField(),
      done: booleanField()
    }
  })
});
const item = as(contractSchema.items, 'item');
const itemQuery = pipe(
  from(item),
  project({
    id: item.id,
    label: item.label,
    done: item.done
  })
);
const itemWriter = write(contractSchema.items);

describe('@tarstate/react implementation contract gaps', () => {
  it('keeps query hooks loading from an async source until the first evaluation resolves', async () => {
    const rows = deferred<readonly ItemRow[]>();
    const store = createSourceStore({
      getSource: () => ({
        relationNames: [contractSchema.items.name],
        rows: (relationRef) => relationRef.name === contractSchema.items.name ? rows.promise : []
      })
    });
    const probe = await renderQueryProbe(store);

    expect(probe.query).toMatchObject({
      status: 'loading',
      rows: [],
      data: undefined,
      diagnostics: [],
      revision: 0
    });

    await act(async () => {
      rows.resolve([{ id: 'item-a', label: 'Alpha', done: false }]);
      await rows.promise;
    });

    expect(probe.query).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-a', label: 'Alpha', done: false }],
      data: ['Alpha'],
      diagnostics: [],
      revision: 0
    });
  });

  it('surfaces query selector errors without replacing the last ready rows and recovers on refresh', async () => {
    let rows: readonly ItemRow[] = [{ id: 'item-a', label: 'Alpha', done: false }];
    let failSelect = false;
    const store = createSourceStore({
      getSource: () => ({
        relationNames: [contractSchema.items.name],
        rows: (relationRef) => relationRef.name === contractSchema.items.name ? rows : []
      })
    });
    const probe = await renderQueryProbe(store, {
      select: (nextRows) => {
        if (failSelect) {
          throw new Error('query selector unavailable');
        }
        return nextRows.map((row) => row.label);
      }
    });

    expect(probe.query).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-a', label: 'Alpha', done: false }],
      data: ['Alpha'],
      diagnostics: []
    });

    failSelect = true;
    await act(async () => {
      await store.refresh();
    });

    expect(probe.query.status).toBe('error');
    expect(probe.query.rows).toEqual([{ id: 'item-a', label: 'Alpha', done: false }]);
    expect(probe.query.data).toEqual(['Alpha']);
    expect(probe.query.error).toBeInstanceOf(Error);

    rows = [{ id: 'item-b', label: 'Beta', done: true }];
    failSelect = false;
    await act(async () => {
      await store.refresh();
    });

    expect(probe.query).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-b', label: 'Beta', done: true }],
      data: ['Beta'],
      diagnostics: [],
      revision: 2
    });
    expect(probe.query.error).toBeUndefined();
  });

  it('rejects failed runtime refreshes without stale publishes and recovers on a later refresh', async () => {
    let rows: readonly ItemRow[] = [{ id: 'item-a', label: 'Alpha', done: false }];
    let version = 'v1';
    let failSnapshot = false;
    const runtime: RelationRuntime<string> = {
      source: adapterSourceFor(rows),
      snapshot: () => {
        if (failSnapshot) {
          throw new Error('runtime snapshot unavailable');
        }
        return { source: adapterSourceFor(rows), version };
      }
    };
    const store = createRuntimeStore(runtime);
    const initialSnapshot = store.getSnapshot();
    let publishes = 0;
    const unsubscribe = store.subscribe(() => {
      publishes += 1;
    });

    rows = [{ id: 'item-b', label: 'Beta', done: true }];
    version = 'v2';
    failSnapshot = true;

    await expect(store.refresh()).rejects.toThrow('runtime snapshot unavailable');
    expect(store.getSnapshot()).toBe(initialSnapshot);
    expect(publishes).toBe(0);

    failSnapshot = false;
    await store.refresh();

    expect(publishes).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ revision: 1, version: 'v2' });
    await expectRows(store.getSnapshot().source, [{ id: 'item-b', label: 'Beta', done: true }]);

    unsubscribe();
  });

  it('rejects failed adapter commits without stale publishes and recovers on a later accepted commit', async () => {
    let rows: readonly ItemRow[] = [{ id: 'item-a', label: 'Alpha', done: false }];
    let version = 'v1';
    let nextCommit: 'throw' | RelationApplyResult<string> = 'throw';
    const adapter: RelationAdapter<string> = {
      source: adapterSourceFor(rows),
      snapshot: () => ({ source: adapterSourceFor(rows), version }),
      commit: () => {
        if (nextCommit === 'throw') {
          throw new Error('adapter commit unavailable');
        }
        rows = [{ id: 'item-b', label: 'Beta', done: true }];
        version = nextCommit.version ?? version;
        return nextCommit;
      }
    };
    const store = createAdapterStore(adapter);
    const initialSnapshot = store.getSnapshot();
    let publishes = 0;
    const unsubscribe = store.subscribe(() => {
      publishes += 1;
    });

    const rejected = await store.commit(itemWriter.insert({ id: 'item-b', label: 'Beta', done: true }));

    expect(rejected.status).toBe('rejected');
    expect(rejected.snapshot).toBe(initialSnapshot);
    expect(rejected.diagnostics).toEqual([
      expect.objectContaining({ code: 'source_error', message: 'tarstate React source commit failed' })
    ]);
    expect(store.getSnapshot()).toBe(initialSnapshot);
    expect(publishes).toBe(0);

    nextCommit = {
      status: 'accepted',
      patches: 1,
      applied: 1,
      deltas: [],
      diagnostics: [],
      version: 'v2'
    };

    const accepted = await store.commit(itemWriter.insert({ id: 'item-b', label: 'Beta', done: true }));

    expect(accepted.status).toBe('accepted');
    expect(accepted.snapshot).toBe(store.getSnapshot());
    expect(publishes).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ revision: 1, version: 'v2' });
    await expectRows(store.getSnapshot().source, [{ id: 'item-b', label: 'Beta', done: true }]);

    unsubscribe();
  });

  it('notifies multiple subscribers with the same revision and stops after unsubscribe', async () => {
    let rows: readonly ItemRow[] = [{ id: 'item-a', label: 'Alpha', done: false }];
    const store = createSourceStore({
      getSource: () => adapterSourceFor(rows)
    });
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      firstRevisions.push(store.getSnapshot().revision);
    });
    const unsubscribeSecond = store.subscribe(() => {
      secondRevisions.push(store.getSnapshot().revision);
    });

    rows = [{ id: 'item-b', label: 'Beta', done: false }];
    await store.refresh();

    expect(firstRevisions).toEqual([1]);
    expect(secondRevisions).toEqual([1]);

    unsubscribeFirst();
    rows = [{ id: 'item-c', label: 'Gamma', done: true }];
    await store.refresh();

    expect(firstRevisions).toEqual([1]);
    expect(secondRevisions).toEqual([1, 2]);

    unsubscribeSecond();
  });

  it('refreshes snapshot consumers when the provider store instance is replaced', async () => {
    const firstStore = createSourceStore({
      getSource: () => adapterSourceFor([{ id: 'item-a', label: 'Alpha', done: false }])
    });
    const secondStore = createSourceStore({
      getSource: () => adapterSourceFor([{ id: 'item-b', label: 'Beta', done: true }])
    });
    const probe = await renderSnapshotProbe(firstStore);

    await expectRows(probe.snapshot.source, [{ id: 'item-a', label: 'Alpha', done: false }]);

    await act(async () => {
      probe.renderer.update(createElement(TarstateProvider, { store: secondStore }, createElement(probe.Component)));
    });

    expect(probe.snapshot).toBe(secondStore.getSnapshot());
    await expectRows(probe.snapshot.source, [{ id: 'item-b', label: 'Beta', done: true }]);
  });

  it('keeps batched query results keyed in caller order with independent diagnostics', async () => {
    const sourceDiagnostics = [{ code: 'source_error' as const, message: 'second query used a fallback index' }];
    const store = createSourceStore({
      getSource: () => ({
        relationNames: [contractSchema.items.name],
        rows: (relationRef) => relationRef.name === contractSchema.items.name
          ? [
              { id: 'item-a', label: 'Alpha', done: false },
              { id: 'item-b', label: 'Beta', done: true }
            ]
          : [],
        diagnostics: () => sourceDiagnostics
      })
    });
    const probe = await renderBatchProbe(store);

    expect(probe.queries.status).toBe('ready');
    expect(Object.keys(probe.queries.results ?? {})).toEqual(['first', 'second']);
    expect(probe.queries.results?.first.rows).toEqual([
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: true }
    ]);
    expect(probe.queries.results?.second.rows).toEqual([
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: true }
    ]);
    expect(probe.queries.diagnostics).toEqual(sourceDiagnostics);
  });

  it('keeps commit hook identity stable for one store and returns the exact commit result object', async () => {
    const firstStore = contractStore('v1');
    const secondStore = contractStore('v2');
    const probe = await renderCommitProbe(firstStore);
    const firstCommit = probe.commit;

    await act(async () => {
      await firstStore.refresh();
    });

    expect(probe.commit).toBe(firstCommit);

    const result = await probe.commit(itemWriter.insert({ id: 'item-a', label: 'Alpha', done: false }));

    expect(result).toBe(firstStore.commitResult);

    await act(async () => {
      probe.renderer.update(createElement(TarstateProvider, { store: secondStore }, createElement(probe.Component)));
    });

    expect(probe.commit).not.toBe(firstCommit);
  });
});

type QueryProbeState = {
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
};

type RenderQueryProbeOptions = {
  readonly select?: (rows: readonly ItemProjection[]) => readonly string[];
};

type RenderedQueryProbe = {
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
  readonly renderer: ReactTestRenderer;
};

async function renderQueryProbe(
  store: TarstateStore,
  options: RenderQueryProbeOptions = {}
): Promise<RenderedQueryProbe> {
  let current: QueryProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    const query = useTarstateQuery(itemQuery, {
      select: options.select ?? ((rows) => rows.map((row) => row.label))
    });
    current = { query };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(current);
  assertDefined(renderer);
  return {
    get query() {
      assertDefined(current);
      return current.query;
    },
    renderer
  };
}

type BatchQueries = {
  readonly first: Query<ItemProjection>;
  readonly second: Query<ItemProjection>;
};

type BatchProbeState = {
  readonly queries: QueriesHookState<BatchQueries>;
};

type RenderedBatchProbe = {
  readonly queries: QueriesHookState<BatchQueries>;
  readonly renderer: ReactTestRenderer;
};

async function renderBatchProbe(store: TarstateStore): Promise<RenderedBatchProbe> {
  let current: BatchProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    const queries = useTarstateQueries({
      first: itemQuery,
      second: itemQuery
    });
    current = { queries };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(current);
  assertDefined(renderer);
  return {
    get queries() {
      assertDefined(current);
      return current.queries;
    },
    renderer
  };
}

type SnapshotProbeComponent = () => null;

type RenderedSnapshotProbe = {
  readonly Component: SnapshotProbeComponent;
  readonly snapshot: ReturnType<TarstateStore['getSnapshot']>;
  readonly renderer: ReactTestRenderer;
};

async function renderSnapshotProbe(store: TarstateStore): Promise<RenderedSnapshotProbe> {
  let snapshot: ReturnType<TarstateStore['getSnapshot']> | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    snapshot = useTarstateSnapshot();
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(snapshot);
  assertDefined(renderer);
  return {
    Component: Probe,
    get snapshot() {
      assertDefined(snapshot);
      return snapshot;
    },
    renderer
  };
}

type CommitProbeComponent = () => null;

type RenderedCommitProbe = {
  readonly Component: CommitProbeComponent;
  readonly commit: TarstateStore<TarstateSnapshot<string>>['commit'];
  readonly renderer: ReactTestRenderer;
};

async function renderCommitProbe(store: TarstateStore<TarstateSnapshot<string>>): Promise<RenderedCommitProbe> {
  let commit: TarstateStore<TarstateSnapshot<string>>['commit'] | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    commit = useTarstateCommit<TarstateSnapshot<string>>();
    useTarstateSnapshot<TarstateSnapshot<string>>();
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(commit);
  assertDefined(renderer);
  return {
    Component: Probe,
    get commit() {
      assertDefined(commit);
      return commit;
    },
    renderer
  };
}

type ContractStore = TarstateStore<TarstateSnapshot<string>> & {
  readonly commitResult: TarstateCommitResult<TarstateSnapshot<string>>;
};

function contractStore(version: string): ContractStore {
  let snapshot: TarstateSnapshot<string> = {
    source: adapterSourceFor([]),
    revision: 0,
    diagnostics: [],
    version
  };
  const listeners = new Set<() => void>();
  const commitResult: TarstateCommitResult<TarstateSnapshot<string>> = {
    kind: 'tarstateCommit',
    status: 'accepted',
    reflected: true,
    effects: { patches: 1, applied: 1, deltas: [] },
    diagnostics: [],
    snapshot
  };

  return {
    commitResult,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit: async () => commitResult,
    refresh: async () => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
    }
  };
}

async function expectRows(source: RelationSource, rows: readonly ItemRow[]): Promise<void> {
  expect(await source.rows(contractSchema.items)).toEqual(rows);
}

function adapterSourceFor<Version>(rows: readonly ItemRow[]): AdapterSource<Version> {
  return {
    relationNames: [contractSchema.items.name],
    rows: (relationRef) => relationRef.name === contractSchema.items.name ? rows : []
  };
}

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolveDeferred: ((value: Value) => void) | undefined;
  let rejectDeferred: ((reason: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  assertDefined(resolveDeferred);
  assertDefined(rejectDeferred);
  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred
  };
}

function assertDefined<Value>(value: Value | undefined): asserts value is Value {
  expect(value).toBeDefined();
}
