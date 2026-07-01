import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createDbStore,
  createAdapterStore,
  createRuntimeStore,
  TarstateProvider,
  useCommit,
  useQueries,
  useQuery,
  useTarstateCommit,
  useTarstateQueries,
  useTarstateQuery,
  useTarstateSnapshot,
  type QueryHookState,
  type QueriesHookState,
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

const testSchema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField(),
      done: booleanField()
    }
  })
});
const item = as(testSchema.items, 'item');
const itemQuery = pipe(
  from(item),
  project({
    id: item.id,
    label: item.label,
    done: item.done
  })
);
const itemWriter = write(testSchema.items);

describe('@tarstate/react contract', () => {
  it('publishes public hooks, providers, store factories, and hook aliases', () => {
    expect(createDbStore).toBeTypeOf('function');
    expect(createAdapterStore).toBeTypeOf('function');
    expect(createRuntimeStore).toBeTypeOf('function');
    expect(TarstateProvider).toBeTypeOf('function');
    expect(useTarstateQuery).toBeTypeOf('function');
    expect(useTarstateQueries).toBeTypeOf('function');
    expect(useTarstateCommit).toBeTypeOf('function');
    expect(useQuery).toBe(useTarstateQuery);
    expect(useQueries).toBe(useTarstateQueries);
    expect(useCommit).toBe(useTarstateCommit);
  });

  it('updates db snapshots and subscribers for accepted commits but not rejected commits', async () => {
    const store = createDbStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    let publishes = 0;
    const unsubscribe = store.subscribe(() => {
      publishes += 1;
    });

    const accepted = await store.commit(itemWriter.insert({ id: 'item-b', label: 'Beta', done: false }));

    expect(accepted.status).toBe('accepted');
    expect(accepted.effects).toMatchObject({ patches: 1, applied: 1 });
    expect(store.getSnapshot().revision).toBe(1);
    expect(publishes).toBe(1);
    await expectRows(store.getSnapshot().source, [
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: false }
    ]);

    const snapshotAfterAccept = store.getSnapshot();
    const rejected = await store.commit(itemWriter.insert({ id: 'item-b', label: 'Duplicate beta', done: true }));

    expect(rejected.status).toBe('rejected');
    expect(rejected.effects).toMatchObject({ patches: 1, applied: 0 });
    expect(store.getSnapshot()).toBe(snapshotAfterAccept);
    expect(publishes).toBe(1);

    unsubscribe();
  });

  it('renders provider hook results from the captured store snapshot', async () => {
    const store = createDbStore({
      items: [
        { id: 'item-a', label: 'Alpha', done: false },
        { id: 'item-b', label: 'Beta', done: true }
      ]
    });
    const renderState = await renderProbe(store);

    expect(renderState.query.status).toBe('ready');
    expect(renderState.query.rows).toEqual([
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: true }
    ]);
    expect(renderState.query.data).toEqual(['Alpha', 'Beta']);
    expect(renderState.queries.results?.items.rows).toEqual(renderState.query.rows);
    expect(renderState.snapshot.revision).toBe(0);
  });

  it('exposes commit through provider hooks and rerenders against the new snapshot', async () => {
    const store = createDbStore({
      items: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    const renderState = await renderProbe(store);

    let commitResult: Awaited<ReturnType<TarstateStore['commit']>> | undefined;
    await act(async () => {
      assertDefined(renderState.current);
      commitResult = await renderState.current.commit(itemWriter.insert({ id: 'item-b', label: 'Beta', done: false }));
    });

    assertDefined(commitResult);
    expect(commitResult.status).toBe('accepted');
    assertDefined(renderState.current);
    expect(renderState.current.snapshot.revision).toBe(1);
    expect(renderState.current.query.rows).toEqual([
      { id: 'item-a', label: 'Alpha', done: false },
      { id: 'item-b', label: 'Beta', done: false }
    ]);
  });

  it('refreshes runtime snapshots from host subscriptions and preserves host versions', async () => {
    let rows: readonly ItemRow[] = [{ id: 'item-a', label: 'Alpha', done: false }];
    let version = 'v1';
    let hostListener: (() => void) | undefined;
    const runtime: RelationRuntime<string> = {
      source: adapterSourceFor(rows),
      snapshot: () => ({ source: adapterSourceFor(rows), version }),
      subscribe: (listener) => {
        hostListener = listener;
        return () => {
          hostListener = undefined;
        };
      }
    };
    const store = createRuntimeStore(runtime);
    let publishes = 0;
    const unsubscribe = store.subscribe(() => {
      publishes += 1;
    });

    expect(store.getSnapshot()).toMatchObject({ revision: 0, version: 'v1' });

    rows = [{ id: 'item-b', label: 'Beta', done: true }];
    version = 'v2';
    await act(async () => {
      assertDefined(hostListener);
      hostListener();
      await Promise.resolve();
    });

    expect(publishes).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ revision: 1, version: 'v2' });
    await expectRows(store.getSnapshot().source, [{ id: 'item-b', label: 'Beta', done: true }]);

    unsubscribe();
  });

  it('surfaces adapter partial and rejected commits without losing the last accepted snapshot', async () => {
    let rows: readonly ItemRow[] = [{ id: 'item-a', label: 'Alpha', done: false }];
    let version = 'v1';
    let nextCommit: RelationApplyResult<string> = {
      status: 'partial',
      patches: 0,
      applied: 1,
      deltas: [],
      diagnostics: [{ code: 'source_error', message: 'one patch was deferred' }],
      version: 'v2',
      durability: 'ephemeral'
    };
    const adapter: RelationAdapter<string> = {
      source: adapterSourceFor(rows),
      snapshot: () => ({ source: adapterSourceFor(rows), version }),
      commit: async () => {
        if (nextCommit.status !== 'rejected') {
          rows = [{ id: 'item-b', label: 'Beta', done: true }];
          version = nextCommit.version ?? version;
        }
        return nextCommit;
      }
    };
    const store = createAdapterStore(adapter);

    const partial = await store.commit(itemWriter.insert({ id: 'item-b', label: 'Beta', done: true }));

    expect(partial.status).toBe('partial');
    expect(partial.effects).toMatchObject({ patches: 0, applied: 1, durability: 'ephemeral' });
    expect(partial.diagnostics).toEqual([{ code: 'source_error', message: 'one patch was deferred' }]);
    expect(store.getSnapshot()).toMatchObject({ revision: 1, version: 'v2' });
    await expectRows(store.getSnapshot().source, [{ id: 'item-b', label: 'Beta', done: true }]);

    const snapshotAfterPartial = store.getSnapshot();
    nextCommit = {
      status: 'rejected',
      patches: 0,
      applied: 0,
      deltas: [],
      diagnostics: [{ code: 'duplicate_key', message: 'duplicate item id' }],
      version: 'v3'
    };

    const rejected = await store.commit(itemWriter.insert({ id: 'item-b', label: 'Duplicate', done: false }));

    expect(rejected.status).toBe('rejected');
    expect(rejected.effects).toMatchObject({ patches: 0, applied: 0 });
    expect(rejected.diagnostics).toEqual([{ code: 'duplicate_key', message: 'duplicate item id' }]);
    expect(store.getSnapshot()).toBe(snapshotAfterPartial);
  });
});

type ProbeState = {
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
  readonly queries: QueriesHookState<{ readonly items: Query<ItemProjection> }>;
  readonly commit: TarstateStore['commit'];
  readonly snapshot: ReturnType<TarstateStore['getSnapshot']>;
};

type RenderedProbe = {
  readonly current: ProbeState | undefined;
  readonly query: QueryHookState<ItemProjection, readonly string[]>;
  readonly queries: QueriesHookState<{ readonly items: Query<ItemProjection> }>;
  readonly commit: TarstateStore['commit'];
  readonly snapshot: ReturnType<TarstateStore['getSnapshot']>;
  readonly renderer: ReactTestRenderer;
};

async function renderProbe(store: TarstateStore): Promise<RenderedProbe> {
  let current: ProbeState | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    const query = useTarstateQuery(itemQuery, {
      select: (rows) => rows.map((row) => row.label)
    });
    const queries = useTarstateQueries({ items: itemQuery });
    const commit = useTarstateCommit();
    const snapshot = useTarstateSnapshot();
    current = { query, queries, commit, snapshot };
    return null;
  }

  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, createElement(Probe)));
  });

  assertDefined(current);
  assertDefined(renderer);
  return {
    get current() {
      return current;
    },
    get query() {
      assertDefined(current);
      return current.query;
    },
    get queries() {
      assertDefined(current);
      return current.queries;
    },
    get commit() {
      assertDefined(current);
      return current.commit;
    },
    get snapshot() {
      assertDefined(current);
      return current.snapshot;
    },
    renderer
  };
}

async function expectRows(source: RelationSource, rows: readonly ItemRow[]): Promise<void> {
  expect(await source.rows(testSchema.items)).toEqual(rows);
}

function adapterSourceFor<Version>(rows: readonly ItemRow[]): AdapterSource<Version> {
  return {
    relationNames: [testSchema.items.name],
    rows: (relationRef) => relationRef.name === testSchema.items.name ? rows : []
  };
}

function assertDefined<Value>(value: Value | undefined): asserts value is Value {
  expect(value).toBeDefined();
}
