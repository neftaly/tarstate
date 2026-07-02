import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  as,
  eq,
  from,
  pipe,
  project,
  sort,
  where,
  type Query
} from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { createRuntimeStore, type Store, type StoreCommitResult, type StoreRuntimeInput } from '@tarstate/core/store';
import { write } from '@tarstate/core/write';
import { watch, type WatchEvent } from '@tarstate/core/watch';
import type { RelationDelta, RelationRuntime } from '@tarstate/core/adapter';

type ItemRow = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};

type OpenItemRow = {
  readonly id: string;
  readonly label: string;
};

const schema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField(),
      done: booleanField()
    }
  })
});

const items = write(schema.items);

function openItemsQuery(): Query<OpenItemRow> {
  const item = as(schema.items, 'item');
  return pipe(
    from(item),
    where(eq(item.done, false)),
    project({ id: item.id, label: item.label }),
    sort(item.id)
  );
}

describe('runtime-backed Store', () => {
  it('queries and commits through a declared RelationRuntime', async () => {
    const runtime = createMemoryRelationRuntime({
      items: [
        { id: 'item-a', label: 'Alpha', done: false },
        { id: 'item-b', label: 'Beta', done: true }
      ]
    });
    const storeInput = {
      runtime,
      relations: [schema.items]
    } satisfies StoreRuntimeInput<number>;
    const store = await createRuntimeStore(storeInput);
    const openItems = openItemsQuery();
    const events: number[] = [];
    const unsubscribe = store.subscribe(() => {
      events.push(store.getSnapshot().revision);
    });

    expectTypeOf(store).toEqualTypeOf<Store>();
    await expect(store.query(schema.items)).resolves.toMatchObject({
      rows: [
        { id: 'item-a', label: 'Alpha', done: false },
        { id: 'item-b', label: 'Beta', done: true }
      ],
      diagnostics: []
    });
    await expect(store.query(openItems)).resolves.toMatchObject({
      rows: [{ id: 'item-a', label: 'Alpha' }],
      diagnostics: []
    });
    await expect(store.query('items', {
      mapRows: (rows) => rows.map((row) => (row as ItemRow).id)
    })).resolves.toMatchObject({
      rows: ['item-a', 'item-b'],
      diagnostics: []
    });
    await expect(store.queries({
      open: openItems,
      all: schema.items,
      named: 'items'
    })).resolves.toMatchObject({
      open: { rows: [{ id: 'item-a', label: 'Alpha' }] },
      all: {
        rows: [
          { id: 'item-a', label: 'Alpha', done: false },
          { id: 'item-b', label: 'Beta', done: true }
        ]
      },
      named: {
        rows: [
          { id: 'item-a', label: 'Alpha', done: false },
          { id: 'item-b', label: 'Beta', done: true }
        ]
      }
    });
    await expect(store.view(openItems).rows()).resolves.toEqual([{ id: 'item-a', label: 'Alpha' }]);

    const initialSnapshot = store.getSnapshot();
    expect(initialSnapshot).toMatchObject({
      revision: 0,
      version: 0,
      diagnostics: [],
      db: {
        data: {
          items: [
            { id: 'item-a', label: 'Alpha', done: false },
            { id: 'item-b', label: 'Beta', done: true }
          ]
        }
      }
    });

    const result = await store.commit([
      items.updateByKey('item-a', { done: true }),
      items.insert({ id: 'item-c', label: 'Gamma', done: false })
    ]);

    expectTypeOf(result).toEqualTypeOf<StoreCommitResult>();
    expect(result).toMatchObject({
      kind: 'tarstateCommit',
      status: 'accepted',
      reflected: true,
      effects: {
        patches: 2,
        applied: 2,
        durability: 'memory',
        version: 1
      },
      diagnostics: [],
      snapshot: {
        revision: 1,
        version: 1
      }
    });
    expect(result.effects.deltas.map((delta) => delta.relation.name)).toEqual(['items']);
    await expect(store.query(openItems)).resolves.toMatchObject({
      rows: [{ id: 'item-c', label: 'Gamma' }],
      diagnostics: []
    });
    expect(events).toEqual([1]);

    unsubscribe();
  });

  it('keeps watched query callbacks attached across runtime store commits', async () => {
    const runtime = createMemoryRelationRuntime({ items: [] });
    const store = await createRuntimeStore({ runtime, relations: [schema.items] });
    const openItems = openItemsQuery();
    const events: WatchEvent<OpenItemRow>[] = [];
    const handle = watch(store.getSnapshot().db, openItems, (event) => {
      events.push(event);
    });

    await store.commit(items.insert({ id: 'item-a', label: 'Alpha', done: false }));
    await store.commit(items.updateByKey('item-a', { done: true }));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      addedRows: [{ id: 'item-a', label: 'Alpha' }],
      removedRows: []
    });
    expect(events[1]).toMatchObject({
      addedRows: [],
      removedRows: [{ id: 'item-a', label: 'Alpha' }]
    });
    expect(handle.db).toBe(store.getSnapshot().db);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
  });

  it('keeps partial runtime commits visible in store results', async () => {
    let rows: readonly ItemRow[] = [];
    let version = 0;
    const source = {
      relationNames: ['items'],
      rows: () => rows,
      version: () => version
    };
    const runtime = {
      source: {
        ...source
      },
      target: {
        relationNames: ['items'],
        ownsRelation: (relationName) => relationName === 'items',
        apply: (patches) => {
          const [first] = patches;
          const added = first?.op === 'insert' && isItemRow(first.row) ? [first.row] : [];
          rows = [...rows, ...added];
          version += 1;
          return {
            status: 'partial' as const,
            patches: patches.length,
            applied: added.length,
            deltas: [{
              relation: schema.items,
              added,
              removed: []
            }] satisfies readonly RelationDelta[],
            diagnostics: [{
              code: 'partial_commit',
              message: 'only the first patch was applied'
            }],
            durability: 'memory' as const,
            version
          };
        }
      },
      snapshot: () => ({ source, version })
    } satisfies RelationRuntime<number>;
    const store = await createRuntimeStore({ runtime, relations: [schema.items] });
    const notified: number[] = [];
    const unsubscribe = store.subscribe(() => {
      notified.push(store.getSnapshot().revision);
    });

    const result = await store.commit([
      items.insert({ id: 'item-a', label: 'Alpha', done: false }),
      items.insert({ id: 'item-b', label: 'Beta', done: false })
    ]);

    expect(result).toMatchObject({
      status: 'partial',
      reflected: true,
      effects: {
        patches: 2,
        applied: 1,
        durability: 'memory',
        version: 1
      },
      diagnostics: [expect.objectContaining({ code: 'partial_commit' })],
      snapshot: {
        revision: 1,
        version: 1
      }
    });
    await expect(store.query(schema.items)).resolves.toMatchObject({
      rows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    expect(notified).toEqual([1]);
    unsubscribe();
  });

  it('refreshes from runtime subscriptions without coupling Store to a backend package', async () => {
    const runtime = createMemoryRelationRuntime({ items: [] });
    const store = await createRuntimeStore({ runtime, relations: [schema.items] });
    const notified = new Promise<number>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        unsubscribe();
        resolve(store.getSnapshot().revision);
      });
    });

    await runtime.target?.apply([items.insert({ id: 'item-a', label: 'Alpha', done: false })]);

    await expect(notified).resolves.toBe(1);
    await expect(store.query(schema.items)).resolves.toMatchObject({
      rows: [{ id: 'item-a', label: 'Alpha', done: false }]
    });
    expect(store.getSnapshot().db.data.items).toEqual([
      { id: 'item-a', label: 'Alpha', done: false }
    ]);
  });

  it('reports rejected commits from read-only runtimes without publishing a snapshot', async () => {
    const writableRuntime = createMemoryRelationRuntime({ items: [] });
    const readOnlyRuntime = {
      source: writableRuntime.source,
      ...(writableRuntime.snapshot === undefined ? {} : { snapshot: writableRuntime.snapshot })
    } satisfies RelationRuntime<number>;
    const store = await createRuntimeStore({ runtime: readOnlyRuntime, relations: [schema.items] });

    const result = await store.commit(items.insert({ id: 'item-a', label: 'Alpha', done: false }));

    expect(result).toMatchObject({
      status: 'rejected',
      reflected: false,
      effects: {
        patches: 1,
        applied: 0,
        deltas: []
      },
      snapshot: {
        revision: 0
      }
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'source_error',
        message: 'relation runtime does not support applying patches'
      })
    ]);
    await expect(store.query(schema.items)).resolves.toMatchObject({ rows: [] });
    expect(store.getSnapshot().revision).toBe(0);
  });
});

function isItemRow(input: unknown): input is ItemRow {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as Partial<ItemRow>).id === 'string' &&
    typeof (input as Partial<ItemRow>).label === 'string' &&
    typeof (input as Partial<ItemRow>).done === 'boolean';
}
