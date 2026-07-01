import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createSourceStore,
  TarstateProvider,
  useTarstateCommit,
  useTarstateQuery,
  useTarstateSnapshot,
  type QueryHookState,
  type TarstateCommitResult,
  type TarstateSnapshot,
  type TarstateStore
} from '@tarstate/react';
import type { AdapterSource } from '@tarstate/core/adapter';
import { from, as, pipe, project } from '@tarstate/core/query';
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

type VersionedSnapshot = TarstateSnapshot<string>;
type RowInput = readonly ItemRow[] | Promise<readonly ItemRow[]>;

const concurrencySchema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField(),
      done: booleanField()
    }
  })
});
const item = as(concurrencySchema.items, 'item');
const itemQuery = pipe(
  from(item),
  project({
    id: item.id,
    label: item.label,
    done: item.done
  })
);
const itemWriter = write(concurrencySchema.items);

describe('@tarstate/react async concurrency contract', () => {
  it('lets a later refresh/query evaluation win over a stale earlier resolution', async () => {
    const slowRows = deferred<readonly ItemRow[]>();
    const fastRows = deferred<readonly ItemRow[]>();
    let rows: RowInput = [{ id: 'item-a', label: 'Alpha', done: false }];
    const store = createSourceStore<string>({
      getSource: () => sourceFor(rows)
    });
    const probe = await renderQueryProbe(store);

    expect(probe.query).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-a', label: 'Alpha', done: false }],
      data: ['Alpha'],
      revision: 0
    });

    rows = slowRows.promise;
    await act(async () => {
      await store.refresh();
    });
    expect(probe.query).toMatchObject({ status: 'loading', revision: 1 });

    rows = fastRows.promise;
    await act(async () => {
      await store.refresh();
    });
    expect(probe.query).toMatchObject({ status: 'loading', revision: 2 });

    await act(async () => {
      fastRows.resolve([{ id: 'item-b', label: 'Beta', done: true }]);
      await fastRows.promise;
    });

    expect(probe.query).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-b', label: 'Beta', done: true }],
      data: ['Beta'],
      revision: 2
    });

    await act(async () => {
      slowRows.resolve([{ id: 'item-stale', label: 'Stale', done: false }]);
      await slowRows.promise;
    });

    expect(probe.query).toMatchObject({
      status: 'ready',
      rows: [{ id: 'item-b', label: 'Beta', done: true }],
      data: ['Beta'],
      revision: 2
    });
  });

  it('does not publish a pending query result after its React subscriber unmounts', async () => {
    const pendingRows = deferred<readonly ItemRow[]>();
    const renders: QueryHookState<ItemProjection, readonly string[]>[] = [];
    const store = createSourceStore<string>({
      getSource: () => sourceFor(pendingRows.promise)
    });
    const probe = await renderQueryProbe(store, {
      onRender: (query) => {
        renders.push(query);
      }
    });

    expect(probe.query).toMatchObject({
      status: 'loading',
      rows: [],
      data: undefined,
      revision: 0
    });
    expect(renders).toHaveLength(1);

    await act(async () => {
      probe.renderer.unmount();
    });
    await act(async () => {
      pendingRows.resolve([{ id: 'item-a', label: 'Alpha', done: false }]);
      await pendingRows.promise;
    });

    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ status: 'loading', revision: 0 });
  });

  it('surfaces an exact commit result while a refresh is pending and keeps deterministic revisions', async () => {
    const store = commitDuringRefreshStore();
    const probe = await renderCommitProbe(store);
    const seenRevisions: number[] = [probe.snapshot.revision];
    const unsubscribe = store.subscribe(() => {
      seenRevisions.push(store.getSnapshot().revision);
    });
    const pendingRefresh = store.refresh();

    let commitResult: TarstateCommitResult<VersionedSnapshot> | undefined;
    await act(async () => {
      commitResult = await probe.commit(itemWriter.insert({ id: 'item-b', label: 'Beta', done: true }));
    });

    expect(commitResult).toBe(store.commitResult);
    expect(probe.snapshot).toBe(store.commitResult.snapshot);
    expect(probe.snapshot).toMatchObject({ revision: 1, version: 'commit' });
    expect(seenRevisions).toEqual([0, 1]);

    await act(async () => {
      store.resolveRefresh();
      await pendingRefresh;
    });

    expect(probe.snapshot).toMatchObject({ revision: 2, version: 'refresh' });
    expect(seenRevisions).toEqual([0, 1, 2]);

    unsubscribe();
  });

  it('ignores an old provider store resolution after consumers switch to a new store', async () => {
    const oldVersion = deferred<string>();
    let oldRows: RowInput = [{ id: 'item-a', label: 'Alpha', done: false }];
    const oldStore = createSourceStore<string>({
      getSource: () => sourceFor(oldRows),
      getVersion: () => oldVersion.promise
    });
    const newStore = createSourceStore<string>({
      getSource: () => sourceFor([{ id: 'item-b', label: 'Beta', done: true }])
    });
    const probe = await renderSnapshotProbe(oldStore);
    const pendingOldRefresh = oldStore.refresh();

    oldRows = [{ id: 'item-stale', label: 'Stale', done: false }];
    await act(async () => {
      probe.renderer.update(createElement(TarstateProvider, { store: newStore }, createElement(probe.Component)));
    });
    await act(async () => {
      oldVersion.resolve('old-after-replace');
      await pendingOldRefresh;
    });

    expect(probe.snapshot).toBe(newStore.getSnapshot());
    expect(probe.snapshot).toMatchObject({ revision: 0 });
    await expectRows(probe.snapshot.source, [{ id: 'item-b', label: 'Beta', done: true }]);
  });

  it('notifies multiple subscribers once with the same async revision and stops after unsubscribe', async () => {
    const firstVersion = deferred<string>();
    const secondVersion = deferred<string>();
    const versionReads = [firstVersion, secondVersion];
    const store = createSourceStore<string>({
      getSource: () => sourceFor([{ id: 'item-a', label: 'Alpha', done: false }]),
      getVersion: () => {
        const next = versionReads.shift();
        assertDefined(next);
        return next.promise;
      }
    });
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      firstRevisions.push(store.getSnapshot().revision);
    });
    const unsubscribeSecond = store.subscribe(() => {
      secondRevisions.push(store.getSnapshot().revision);
    });
    const firstRefresh = store.refresh();

    expect(firstRevisions).toEqual([]);
    expect(secondRevisions).toEqual([]);

    firstVersion.resolve('v1');
    await firstRefresh;

    expect(firstRevisions).toEqual([1]);
    expect(secondRevisions).toEqual([1]);

    unsubscribeFirst();
    const secondRefresh = store.refresh();
    secondVersion.resolve('v2');
    await secondRefresh;

    expect(firstRevisions).toEqual([1]);
    expect(secondRevisions).toEqual([1, 2]);

    unsubscribeSecond();
  });
});

type QueryProbeState = {
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
};

type RenderQueryProbeOptions = {
  readonly onRender?: (query: QueryHookState<ItemProjection, readonly string[]>) => void;
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
      select: (rows) => rows.map((row) => row.label)
    });
    options.onRender?.(query);
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

type CommitRaceStore = TarstateStore<VersionedSnapshot> & {
  readonly commitResult: TarstateCommitResult<VersionedSnapshot>;
  readonly resolveRefresh: () => void;
};

type CommitProbeComponent = () => null;

type RenderedCommitProbe = {
  readonly Component: CommitProbeComponent;
  readonly commit: TarstateStore<VersionedSnapshot>['commit'];
  readonly snapshot: VersionedSnapshot;
  readonly renderer: ReactTestRenderer;
};

async function renderCommitProbe(store: TarstateStore<VersionedSnapshot>): Promise<RenderedCommitProbe> {
  let commit: TarstateStore<VersionedSnapshot>['commit'] | undefined;
  let snapshot: VersionedSnapshot | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    commit = useTarstateCommit<VersionedSnapshot>();
    snapshot = useTarstateSnapshot<VersionedSnapshot>();
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(commit);
  assertDefined(snapshot);
  assertDefined(renderer);
  return {
    Component: Probe,
    get commit() {
      assertDefined(commit);
      return commit;
    },
    get snapshot() {
      assertDefined(snapshot);
      return snapshot;
    },
    renderer
  };
}

type SnapshotProbeComponent = () => null;

type RenderedSnapshotProbe = {
  readonly Component: SnapshotProbeComponent;
  readonly snapshot: VersionedSnapshot;
  readonly renderer: ReactTestRenderer;
};

async function renderSnapshotProbe(store: TarstateStore<VersionedSnapshot>): Promise<RenderedSnapshotProbe> {
  let snapshot: VersionedSnapshot | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    snapshot = useTarstateSnapshot<VersionedSnapshot>();
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

function commitDuringRefreshStore(): CommitRaceStore {
  const refreshGate = deferred<void>();
  const initialSnapshot = snapshotFor([{ id: 'item-a', label: 'Alpha', done: false }], 0, 'initial');
  const commitSnapshot = snapshotFor([{ id: 'item-b', label: 'Beta', done: true }], 1, 'commit');
  const refreshSnapshot = snapshotFor([{ id: 'item-c', label: 'Gamma', done: false }], 2, 'refresh');
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const commitResult: TarstateCommitResult<VersionedSnapshot> = {
    kind: 'tarstateCommit',
    status: 'accepted',
    reflected: true,
    effects: { patches: 1, applied: 1, deltas: [] },
    diagnostics: [],
    snapshot: commitSnapshot
  };

  return {
    commitResult,
    resolveRefresh: () => {
      refreshGate.resolve(undefined);
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit: async () => {
      snapshot = commitSnapshot;
      notify();
      return commitResult;
    },
    refresh: async () => {
      await refreshGate.promise;
      snapshot = refreshSnapshot;
      notify();
    }
  };
}

function snapshotFor(rows: readonly ItemRow[], revision: number, version: string): VersionedSnapshot {
  return {
    source: sourceFor(rows),
    revision,
    diagnostics: [],
    version
  };
}

async function expectRows(source: RelationSource, rows: readonly ItemRow[]): Promise<void> {
  expect(await source.rows(concurrencySchema.items)).toEqual(rows);
}

function sourceFor(rows: RowInput): AdapterSource<string> {
  return {
    relationNames: [concurrencySchema.items.name],
    rows: (relationRef) => relationRef.name === concurrencySchema.items.name ? rows : []
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
