import { describe, expect, it } from 'vitest';
import type { RelationRuntime } from '@tarstate/core/adapter';
import { createDb, tryTransact } from '@tarstate/core/db';
import { stableRowKey } from '@tarstate/core/diff';
import { as, call, eq, from, keyBy, pipe, project, queryKey, where } from '@tarstate/core/query';
import { trackTransact } from '@tarstate/core/runtime';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import { diffQuery, subscribeWatch, unwatch, watch, watchRuntime } from '@tarstate/core/watch';
import { write } from '@tarstate/core/write';

const schema = defineSchema({
  todos: relation<{
    id: string;
    title: string;
    done: boolean;
  }>({
    key: 'id',
    fields: {
      id: idField('todo'),
      title: stringField(),
      done: booleanField()
    }
  }),
  assignments: relation<{
    todoId: string;
    assignee: string;
    role: string;
  }>({
    key: ['todoId', 'assignee'],
    fields: {
      todoId: idField('todo'),
      assignee: stringField(),
      role: stringField()
    }
  })
});

const todo = as(schema.todos, 'todo');
const openTodos = pipe(
  from(todo),
  where(eq(todo.done, false)),
  project({
    id: todo.id,
    title: todo.title
  })
);
const keyedOpenTodos = pipe(openTodos, keyBy('id'));

function requireRuntimeNotify(notify: (() => void) | undefined): () => void {
  if (notify === undefined) {
    throw new Error('runtime watch was not subscribed');
  }

  return notify;
}

function countedSource(data: Readonly<Record<string, readonly unknown[]>>): {
  readonly source: RelationSource;
  readonly rowsCalls: (relationName: string) => number;
} {
  const calls = new Map<string, number>();

  return {
    source: {
      rows: (relationRef) => {
        calls.set(relationRef.name, (calls.get(relationRef.name) ?? 0) + 1);
        return data[relationRef.name] ?? [];
      },
      version: () => data
    },
    rowsCalls: (relationName) => calls.get(relationName) ?? 0
  };
}

describe('tarstate watch/change helpers', () => {
  it('diffs added and removed query result rows without registering a watch', async () => {
    const beforeData = {
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false },
        { id: 'todo-c', title: 'Closed', done: true }
      ]
    };
    const afterData = {
      todos: [
        { id: 'todo-b', title: 'Beta', done: true },
        { id: 'todo-d', title: 'Delta', done: false },
        { id: 'todo-a', title: 'Alpha', done: false }
      ]
    };
    const diff = await diffQuery(
      fromObjectSource(beforeData),
      fromObjectSource(afterData),
      openTodos
    );

    expect(diff).toMatchObject({
      kind: 'queryDiff',
      target: openTodos,
      queryKey: queryKey(openTodos),
      beforeRows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ],
      afterRows: [
        { id: 'todo-d', title: 'Delta' },
        { id: 'todo-a', title: 'Alpha' }
      ],
      addedRows: [{ id: 'todo-d', title: 'Delta' }],
      removedRows: [{ id: 'todo-b', title: 'Beta' }],
      unchangedRows: [{ id: 'todo-a', title: 'Alpha' }],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey({ id: 'todo-d', title: 'Delta' }),
          after: { id: 'todo-d', title: 'Delta' }
        },
        {
          op: 'delete',
          key: stableRowKey({ id: 'todo-b', title: 'Beta' }),
          before: { id: 'todo-b', title: 'Beta' }
        }
      ],
      diagnostics: []
    });
    expect(diff.beforeVersion).toBe(beforeData);
    expect(diff.afterVersion).toBe(afterData);
  });

  it('passes evaluator options through query diffs', async () => {
    const projected = pipe(
      from(todo),
      project({
        id: todo.id,
        label: call('label', todo.title)
      })
    );
    const diff = await diffQuery(
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Alpha', done: false }] }),
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Beta', done: false }] }),
      projected,
      {
        functions: {
          label: (value) => `todo:${String(value)}`
        }
      }
    );

    expect(diff.addedRows).toEqual([{ id: 'todo-a', label: 'todo:Beta' }]);
    expect(diff.removedRows).toEqual([{ id: 'todo-a', label: 'todo:Alpha' }]);
    expect(diff.diagnostics).toEqual([]);
  });

  it('uses structural row changes for query diffs by default', async () => {
    const diff = await diffQuery(
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Alpha', done: false }] }),
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Beta', done: false }] }),
      openTodos
    );

    expect(diff.addedRows).toEqual([{ id: 'todo-a', title: 'Beta' }]);
    expect(diff.removedRows).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(diff.rowChanges).toEqual([
      {
        op: 'insert',
        key: stableRowKey({ id: 'todo-a', title: 'Beta' }),
        after: { id: 'todo-a', title: 'Beta' }
      },
      {
        op: 'delete',
        key: stableRowKey({ id: 'todo-a', title: 'Alpha' }),
        before: { id: 'todo-a', title: 'Alpha' }
      }
    ]);
  });

  it('uses query-owned row keys for projected query diffs', async () => {
    const diff = await diffQuery(
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Alpha', done: false }] }),
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Beta', done: false }] }),
      keyedOpenTodos
    );

    expect(diff.addedRows).toEqual([{ id: 'todo-a', title: 'Beta' }]);
    expect(diff.removedRows).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
    expect(diff.rowChanges).toEqual([
      {
        op: 'update',
        key: stableRowKey('todo-a'),
        before: { id: 'todo-a', title: 'Alpha' },
        after: { id: 'todo-a', title: 'Beta' }
      }
    ]);
    expect(diff.diagnostics).toEqual([]);
  });

  it('falls back with diagnostics when a query-owned row key cannot be evaluated', async () => {
    const unstableKeyTodos = pipe(
      from(todo),
      project({
        id: call('missingId', todo.id),
        title: todo.title
      }),
      keyBy('id')
    );
    const diff = await diffQuery(
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Alpha', done: false }] }),
      fromObjectSource({ todos: [{ id: 'todo-a', title: 'Beta', done: false }] }),
      unstableKeyTodos,
      {
        functions: {
          missingId: () => undefined
        }
      }
    );

    expect(diff.rowChanges).toEqual([
      {
        op: 'insert',
        key: stableRowKey({ id: undefined, title: 'Beta' }),
        after: { id: undefined, title: 'Beta' }
      },
      {
        op: 'delete',
        key: stableRowKey({ id: undefined, title: 'Alpha' }),
        before: { id: undefined, title: 'Alpha' }
      }
    ]);
    expect(diff.diagnostics).toMatchObject([
      {
        code: 'row_key_missing',
        surface: 'diff',
        side: 'before',
        field: 'id',
        detail: {
          reason: 'undefined',
          keyFields: ['id']
        }
      },
      {
        code: 'row_key_missing',
        surface: 'diff',
        side: 'after',
        field: 'id',
        detail: {
          reason: 'undefined',
          keyFields: ['id']
        }
      }
    ]);
  });

  it('reports source version failures as diff diagnostics', async () => {
    const sourceBefore = fromObjectSource({ todos: [] });
    const sourceAfter: RelationSource = {
      rows: () => [],
      version: async () => {
        throw new Error('version unavailable');
      }
    };

    const diff = await diffQuery(sourceBefore, sourceAfter, openTodos);

    expect(diff.afterVersion).toBeUndefined();
    expect(diff.diagnostics).toMatchObject([
      {
        code: 'source_error',
        message: 'after source version failed'
      }
    ]);
  });


  it('refreshes a manual query watch over object-backed db snapshots', async () => {
    const db0 = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });
    const db1 = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: true },
        { id: 'todo-c', title: 'Gamma', done: false }
      ]
    });
    const events: unknown[] = [];

    const handle = watch(db0, openTodos, (event) => {
      events.push(event);
    }, { label: 'open todos' });

    expect(handle).toMatchObject({
      kind: 'watch',
      db: db0,
      target: openTodos,
      supported: true,
      mode: 'manual',
      label: 'open todos',
      diagnostics: []
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      kind: 'watchRefresh',
      id: handle.id,
      delivered: true,
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      addedRows: [{ id: 'todo-a', title: 'Alpha' }],
      removedRows: [],
      unchangedRows: [],
      diagnostics: []
    });
    await expect(handle.refresh(db1)).resolves.toMatchObject({
      kind: 'watchRefresh',
      id: handle.id,
      delivered: true,
      changed: true,
      previousRows: [{ id: 'todo-a', title: 'Alpha' }],
      rows: [{ id: 'todo-c', title: 'Gamma' }],
      addedRows: [{ id: 'todo-c', title: 'Gamma' }],
      removedRows: [{ id: 'todo-a', title: 'Alpha' }],
      unchangedRows: [],
      diagnostics: []
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: 'watchEvent',
      id: handle.id,
      target: openTodos,
      changed: true,
      previousRows: [{ id: 'todo-a', title: 'Alpha' }],
      rows: [{ id: 'todo-c', title: 'Gamma' }],
      addedRows: [{ id: 'todo-c', title: 'Gamma' }],
      removedRows: [{ id: 'todo-a', title: 'Alpha' }]
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      kind: 'watchRefresh',
      id: handle.id,
      delivered: true,
      changed: false,
      previousRows: [{ id: 'todo-c', title: 'Gamma' }],
      rows: [{ id: 'todo-c', title: 'Gamma' }],
      addedRows: [],
      removedRows: [],
      unchangedRows: [{ id: 'todo-c', title: 'Gamma' }],
      diagnostics: []
    });
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      changed: false,
      addedRows: [],
      removedRows: [],
      rowChanges: []
    });

    expect(unwatch(handle)).toMatchObject({ kind: 'unwatch', id: handle.id, closed: true, diagnostics: [] });
    await expect(handle.refresh(db1)).resolves.toMatchObject({
      kind: 'watchRefresh',
      id: handle.id,
      delivered: false,
      changed: false,
      diagnostics: [{ code: 'watch_already_closed', surface: 'watch' }]
    });
  });

  it('does not deliver manual watch events until refresh is called', async () => {
    const db0 = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const events: unknown[] = [];
    const handle = watch(db0, openTodos, (event) => {
      events.push(event);
    });

    const db1 = createDb({
      todos: [{ id: 'todo-b', title: 'Beta', done: false }]
    });

    expect(handle.mode).toBe('manual');
    expect(events).toEqual([]);

    await expect(handle.refresh(db1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-b', title: 'Beta' }],
      addedRows: [{ id: 'todo-b', title: 'Beta' }],
      removedRows: [],
      unchangedRows: []
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('does not deliver runtime watch events before host notification', async () => {
    let notifyRuntime: (() => void) | undefined;
    const runtime: RelationRuntime = {
      source: fromObjectSource({
        todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
      }),
      subscribe: (listener) => {
        notifyRuntime = listener;
        return () => {
          notifyRuntime = undefined;
        };
      }
    };
    const events: unknown[] = [];
    let resolveNextEvent: (event: unknown) => void = () => undefined;
    const nextEvent = new Promise<unknown>((resolve) => {
      resolveNextEvent = resolve;
    });
    const handle = watchRuntime(runtime, openTodos, (event) => {
      events.push(event);
      resolveNextEvent(event);
    });

    expect(events).toEqual([]);

    requireRuntimeNotify(notifyRuntime)();

    await expect(nextEvent).resolves.toMatchObject({
      kind: 'watchEvent',
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      addedRows: [{ id: 'todo-a', title: 'Alpha' }]
    });
    expect(events).toHaveLength(1);
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('refreshes runtime watches with a fresh snapshot source when the host notifies', async () => {
    let notifyRuntime: (() => void) | undefined;
    let snapshotCalls = 0;
    let snapshotRows = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const runtime: RelationRuntime = {
      source: fromObjectSource({
        todos: [{ id: 'todo-source', title: 'Runtime source', done: false }]
      }),
      snapshot: () => {
        snapshotCalls += 1;
        return {
          source: fromObjectSource({ todos: snapshotRows }),
          version: snapshotCalls
        };
      },
      subscribe: (listener) => {
        notifyRuntime = listener;
        return () => {
          notifyRuntime = undefined;
        };
      }
    };
    let resolveNextEvent: (event: unknown) => void = () => undefined;
    const nextEvent = new Promise<unknown>((resolve) => {
      resolveNextEvent = resolve;
    });
    const handle = watchRuntime(runtime, openTodos, resolveNextEvent);

    expect(snapshotCalls).toBe(1);

    snapshotRows = [{ id: 'todo-b', title: 'Beta', done: false }];
    requireRuntimeNotify(notifyRuntime)();

    await expect(nextEvent).resolves.toMatchObject({
      changed: true,
      rows: [{ id: 'todo-b', title: 'Beta' }],
      addedRows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(snapshotCalls).toBe(2);
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('stops runtime host refreshes when the watch is unwatched', async () => {
    const hostListeners = new Set<() => void>();
    let snapshotCalls = 0;
    let snapshotRows = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const runtime: RelationRuntime = {
      source: fromObjectSource({ todos: [] }),
      snapshot: () => {
        snapshotCalls += 1;
        return {
          source: fromObjectSource({ todos: snapshotRows }),
          version: snapshotCalls
        };
      },
      subscribe: (listener) => {
        hostListeners.add(listener);
        return () => {
          hostListeners.delete(listener);
        };
      }
    };
    const events: unknown[] = [];
    const handle = watchRuntime(runtime, openTodos, (event) => {
      events.push(event);
    });

    expect(hostListeners.size).toBe(1);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', id: handle.id, closed: true, diagnostics: [] });
    expect(hostListeners.size).toBe(0);

    snapshotRows = [{ id: 'todo-b', title: 'Beta', done: false }];
    for (const listener of hostListeners) {
      listener();
    }
    await Promise.resolve();

    expect(events).toEqual([]);
    expect(snapshotCalls).toBe(1);
    await expect(handle.refresh()).resolves.toMatchObject({
      kind: 'watchRefresh',
      id: handle.id,
      delivered: false,
      changed: false,
      diagnostics: [{ code: 'watch_already_closed', surface: 'watch' }]
    });
  });

  it('keeps runtime watches without host subscribe as manual watches', async () => {
    let sourceRows = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const runtime: RelationRuntime = {
      source: {
        rows: (relationRef) => relationRef.name === 'todos' ? sourceRows : [],
        version: () => sourceRows
      }
    };
    const events: unknown[] = [];
    const handle = watchRuntime(runtime, openTodos, (event) => {
      events.push(event);
    }, { label: 'runtime open todos' });

    expect(handle).toMatchObject({
      kind: 'watch',
      target: openTodos,
      supported: true,
      mode: 'manual',
      label: 'runtime open todos',
      diagnostics: []
    });
    expect(events).toEqual([]);

    sourceRows = [{ id: 'todo-b', title: 'Beta', done: false }];
    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-b', title: 'Beta' }],
      addedRows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(events).toHaveLength(1);
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('reports runtime watch listener errors through awaited refresh diagnostics', async () => {
    const runtime: RelationRuntime = {
      source: fromObjectSource({
        todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
      })
    };
    const handle = watchRuntime(runtime, openTodos, () => {
      throw new Error('runtime listener failed');
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: false,
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      addedRows: [{ id: 'todo-a', title: 'Alpha' }],
      diagnostics: [{ code: 'watch_listener_error', surface: 'watch' }]
    });
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('subscribes additional callbacks to manual refresh events and stops after unsubscribe', async () => {
    const db0 = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const db1 = createDb({
      todos: [{ id: 'todo-b', title: 'Beta', done: false }]
    });
    const db2 = createDb({
      todos: [{ id: 'todo-c', title: 'Gamma', done: false }]
    });
    const primaryEvents: unknown[] = [];
    const subscriberEvents: unknown[] = [];
    const handle = watch(db0, openTodos, (event) => {
      primaryEvents.push(event);
    });
    const subscription = subscribeWatch(handle, (event) => {
      subscriberEvents.push(event);
    });

    expect(subscription).toMatchObject({
      kind: 'watchSubscription',
      id: handle.id,
      active: true,
      diagnostics: []
    });
    expect(subscriberEvents).toEqual([]);

    await expect(handle.refresh(db1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-b', title: 'Beta' }],
      addedRows: [{ id: 'todo-b', title: 'Beta' }],
      removedRows: []
    });
    expect(primaryEvents).toHaveLength(1);
    expect(subscriberEvents).toHaveLength(1);
    expect(subscriberEvents[0]).toMatchObject({
      id: handle.id,
      changed: true,
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });

    expect(subscription.unsubscribe()).toMatchObject({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: true,
      diagnostics: []
    });
    await expect(handle.refresh(db2)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      previousRows: [{ id: 'todo-b', title: 'Beta' }],
      rows: [{ id: 'todo-c', title: 'Gamma' }],
      addedRows: [{ id: 'todo-c', title: 'Gamma' }],
      removedRows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(primaryEvents).toHaveLength(2);
    expect(subscriberEvents).toHaveLength(1);
  });

  it('does not fake subscription delivery or duplicate the primary listener', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const events: unknown[] = [];
    const listener = (event: unknown): void => {
      events.push(event);
    };
    const handle = watch(db, openTodos, listener);
    const subscription = subscribeWatch(handle, listener);

    expect(events).toEqual([]);

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: true,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });

    expect(subscription.unsubscribe()).toMatchObject({ unsubscribed: true, diagnostics: [] });
    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: false,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
    expect(events).toHaveLength(2);
  });

  it('delivers duplicate non-primary subscriptions once and keeps them until all unsubscribe', async () => {
    const db0 = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const db1 = createDb({
      todos: [{ id: 'todo-b', title: 'Beta', done: false }]
    });
    const db2 = createDb({
      todos: [{ id: 'todo-c', title: 'Gamma', done: false }]
    });
    const db3 = createDb({
      todos: [{ id: 'todo-d', title: 'Delta', done: false }]
    });
    const primaryEvents: unknown[] = [];
    const subscriberEvents: unknown[] = [];
    const subscriber = (event: unknown): void => {
      subscriberEvents.push(event);
    };
    const handle = watch(db0, openTodos, (event) => {
      primaryEvents.push(event);
    });
    const firstSubscription = subscribeWatch(handle, subscriber);
    const secondSubscription = subscribeWatch(handle, subscriber);

    await expect(handle.refresh(db1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(primaryEvents).toHaveLength(1);
    expect(subscriberEvents).toHaveLength(1);
    expect(subscriberEvents[0]).toMatchObject({
      id: handle.id,
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });

    expect(firstSubscription.unsubscribe()).toMatchObject({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: true,
      diagnostics: []
    });
    await expect(handle.refresh(db2)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-c', title: 'Gamma' }]
    });
    expect(primaryEvents).toHaveLength(2);
    expect(subscriberEvents).toHaveLength(2);
    expect(subscriberEvents[1]).toMatchObject({
      id: handle.id,
      rows: [{ id: 'todo-c', title: 'Gamma' }]
    });

    expect(secondSubscription.unsubscribe()).toMatchObject({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: true,
      diagnostics: []
    });
    await expect(handle.refresh(db3)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-d', title: 'Delta' }]
    });
    expect(primaryEvents).toHaveLength(3);
    expect(subscriberEvents).toHaveLength(2);
  });

  it('delivers subscribed listeners through tracked change events', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const todos = write(schema.todos);
    const primaryEvents: unknown[] = [];
    const subscriberEvents: unknown[] = [];
    const handle = watch(db, openTodos, (event) => {
      primaryEvents.push(event);
    });

    subscribeWatch(handle, (event) => {
      subscriberEvents.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [
        todos.update('todo-a', { done: true }),
        todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
      ])
    );

    expect(result).toMatchObject({
      kind: 'trackTransact',
      supported: true,
      changes: [
        {
          kind: 'trackedChange',
          id: handle.id,
          changed: true,
          previousRows: [
            { id: 'todo-a', title: 'Alpha' },
            { id: 'todo-b', title: 'Beta' }
          ],
          rows: [
            { id: 'todo-b', title: 'Beta' },
            { id: 'todo-c', title: 'Gamma' }
          ],
          addedRows: [{ id: 'todo-c', title: 'Gamma' }],
          removedRows: [{ id: 'todo-a', title: 'Alpha' }]
        }
      ]
    });
    expect(primaryEvents).toHaveLength(1);
    expect(subscriberEvents).toHaveLength(1);
    expect(subscriberEvents[0]).toMatchObject({
      id: handle.id,
      changed: true,
      rows: [
        { id: 'todo-b', title: 'Beta' },
        { id: 'todo-c', title: 'Gamma' }
      ],
      changes: { deltas: result.deltas }
    });
  });

  it('derives direct relation watch row changes from transaction deltas', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    const closed = { id: 'todo-c', title: 'Closed', done: true };
    const alphaUpdated = { id: 'todo-a', title: 'Alpha updated', done: false };
    const delta = { id: 'todo-d', title: 'Delta', done: false };
    const db = createDb({
      todos: [alpha, beta, closed]
    });
    const todos = write(schema.todos);
    const events: unknown[] = [];
    const handle = watch(db, schema.todos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [
        todos.update('todo-a', { title: 'Alpha updated' }),
        todos.delete('todo-b'),
        todos.insert(delta)
      ])
    );

    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [alphaUpdated, delta],
        removed: [alpha, beta]
      }
    ]);
    expect(result.changes).toMatchObject([
      {
        kind: 'trackedChange',
        id: handle.id,
        target: schema.todos,
        changed: true,
        previousRows: [alpha, beta, closed],
        rows: [alphaUpdated, closed, delta],
        addedRows: [alphaUpdated, delta],
        removedRows: [alpha, beta],
        unchangedRows: [closed],
        rowChanges: [
          {
            op: 'update',
            key: stableRowKey('todo-a'),
            before: alpha,
            after: alphaUpdated
          },
          {
            op: 'insert',
            key: stableRowKey('todo-d'),
            after: delta
          },
          {
            op: 'delete',
            key: stableRowKey('todo-b'),
            before: beta
          }
        ],
        diagnostics: []
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      target: schema.todos,
      changes: { deltas: result.deltas },
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before: alpha,
          after: alphaUpdated
        },
        {
          op: 'insert',
          key: stableRowKey('todo-d'),
          after: delta
        },
        {
          op: 'delete',
          key: stableRowKey('todo-b'),
          before: beta
        }
      ],
      diagnostics: []
    });
  });

  it('does not read the after relation snapshot for order-safe direct relation deltas', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    const closed = { id: 'todo-c', title: 'Closed', done: true };
    const alphaUpdated = { id: 'todo-a', title: 'Alpha updated', done: false };
    const beforeDb = createDb({
      todos: [alpha, beta, closed]
    });
    const todos = write(schema.todos);
    const transaction = tryTransact(beforeDb, [
      todos.update('todo-a', { title: 'Alpha updated' }),
      todos.delete('todo-b')
    ]);
    const before = countedSource(beforeDb.data);
    const after = countedSource(transaction.db.data);
    const handle = watch(before.source, schema.todos, () => undefined);

    const result = await trackTransact(before.source, () => ({
      db: after.source,
      deltas: transaction.deltas
    }));

    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        previousRows: [alpha, beta, closed],
        rows: [alphaUpdated, closed],
        addedRows: [alphaUpdated],
        removedRows: [alpha, beta],
        unchangedRows: [closed],
        rowChanges: [
          {
            op: 'update',
            key: stableRowKey('todo-a'),
            before: alpha,
            after: alphaUpdated
          },
          {
            op: 'delete',
            key: stableRowKey('todo-b'),
            before: beta
          }
        ],
        diagnostics: []
      }
    ]);
    expect(before.rowsCalls('todos')).toBe(1);
    expect(after.rowsCalls('todos')).toBe(0);
  });

  it('does not deliver direct relation watches for unrelated relation deltas', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }],
      assignments: []
    });
    const assignments = write(schema.assignments);
    const events: unknown[] = [];

    watch(db, schema.todos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [
        assignments.insert({ todoId: 'todo-a', assignee: 'ada', role: 'owner' })
      ])
    );

    expect(result.deltas).toEqual([
      {
        relation: schema.assignments,
        added: [{ todoId: 'todo-a', assignee: 'ada', role: 'owner' }],
        removed: []
      }
    ]);
    expect(result.changes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('falls back to recomputing direct relation watches when transaction deltas are missing', async () => {
    const beforeRow = { id: 'todo-a', title: 'Alpha', done: false };
    const afterRow = { id: 'todo-a', title: 'Beta', done: false };
    const before = countedSource({
      todos: [beforeRow]
    });
    const after = countedSource({
      todos: [afterRow]
    });
    const events: unknown[] = [];
    const handle = watch(before.source, schema.todos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(before.source, () => after.source);

    expect(result.deltas).toEqual([]);
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        previousRows: [beforeRow],
        rows: [afterRow],
        addedRows: [afterRow],
        removedRows: [beforeRow],
        unchangedRows: [],
        rowChanges: [
          {
            op: 'update',
            key: stableRowKey('todo-a'),
            before: beforeRow,
            after: afterRow
          }
        ],
        diagnostics: []
      }
    ]);
    expect(before.rowsCalls('todos')).toBe(1);
    expect(after.rowsCalls('todos')).toBe(1);
    expect(events).toHaveLength(1);
    expect(Object.hasOwn((events[0] as { readonly changes: object }).changes, 'deltas')).toBe(false);
  });

  it('uses explicit query watch key options for row changes', async () => {
    const before = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const after = createDb({
      todos: [{ id: 'todo-a', title: 'Beta', done: false }]
    });
    const handle = watch(before, openTodos, () => undefined, { keyFields: ['id'] });

    await handle.refresh();

    await expect(handle.refresh(after)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [{ id: 'todo-a', title: 'Beta' }],
      removedRows: [{ id: 'todo-a', title: 'Alpha' }],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before: { id: 'todo-a', title: 'Alpha' },
          after: { id: 'todo-a', title: 'Beta' }
        }
      ]
    });
  });

  it('uses query-owned row keys for manual watch refresh row changes', async () => {
    const before = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const after = createDb({
      todos: [{ id: 'todo-a', title: 'Beta', done: false }]
    });
    const handle = watch(before, keyedOpenTodos, () => undefined);

    await handle.refresh();

    await expect(handle.refresh(after)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [{ id: 'todo-a', title: 'Beta' }],
      removedRows: [{ id: 'todo-a', title: 'Alpha' }],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before: { id: 'todo-a', title: 'Alpha' },
          after: { id: 'todo-a', title: 'Beta' }
        }
      ],
      diagnostics: []
    });
  });

  it('marks keyed row update refreshes as changed without added or removed rows', async () => {
    const before = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const after = createDb({
      todos: [
        { id: 'todo-b', title: 'Beta', done: false },
        { id: 'todo-a', title: 'Alpha', done: false }
      ]
    });
    let rowKeyCalls = 0;
    const handle = watch(before, openTodos, () => undefined, {
      rowKey: () => rowKeyCalls++ % 2
    });

    await handle.refresh();

    await expect(handle.refresh(after)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [],
      removedRows: [],
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey(0),
          before: { id: 'todo-a', title: 'Alpha' },
          after: { id: 'todo-b', title: 'Beta' }
        },
        {
          op: 'update',
          key: stableRowKey(1),
          before: { id: 'todo-b', title: 'Beta' },
          after: { id: 'todo-a', title: 'Alpha' }
        }
      ]
    });
  });

  it('reports manual watch listener errors as refresh diagnostics without rewinding rows', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const events: unknown[] = [];
    let fail = true;
    const handle = watch(db, openTodos, (event) => {
      events.push(event);

      if (fail) {
        throw new Error('listener failed');
      }
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: false,
      changed: true,
      previousRows: [],
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      addedRows: [{ id: 'todo-a', title: 'Alpha' }],
      removedRows: [],
      unchangedRows: [],
      diagnostics: [{ code: 'watch_listener_error', surface: 'watch' }]
    });

    fail = false;
    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: false,
      previousRows: [{ id: 'todo-a', title: 'Alpha' }],
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      addedRows: [],
      removedRows: [],
      unchangedRows: [{ id: 'todo-a', title: 'Alpha' }],
      diagnostics: []
    });
    expect(events).toHaveLength(2);
  });

  it('refreshes relation targets over relation sources', async () => {
    const source0 = fromObjectSource({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ]
    });
    const source1 = fromObjectSource({
      todos: [
        { id: 'todo-b', title: 'Beta', done: true },
        { id: 'todo-c', title: 'Gamma', done: false }
      ]
    });
    const events: unknown[] = [];
    const handle = watch(source0, schema.todos, (event) => {
      events.push(event);
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ],
      addedRows: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: true }
      ],
      removedRows: []
    });
    await expect(handle.refresh(source1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [
        { id: 'todo-b', title: 'Beta', done: true },
        { id: 'todo-c', title: 'Gamma', done: false }
      ],
      addedRows: [{ id: 'todo-c', title: 'Gamma', done: false }],
      removedRows: [{ id: 'todo-a', title: 'Alpha', done: false }],
      unchangedRows: [{ id: 'todo-b', title: 'Beta', done: true }]
    });
    expect(events).toHaveLength(2);
  });

  it('collapses relation key changes into updates for relation targets', async () => {
    const before = { id: 'todo-a', title: 'Alpha', done: false };
    const after = { id: 'todo-a', title: 'Alpha updated', done: false };
    const events: unknown[] = [];
    const handle = watch(
      fromObjectSource({ todos: [before] }),
      schema.todos,
      (event) => {
        events.push(event);
      }
    );

    await handle.refresh();

    await expect(handle.refresh(fromObjectSource({ todos: [after] }))).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [after],
      removedRows: [before],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before,
          after
        }
      ]
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before,
          after
        }
      ]
    });
  });

  it('derives composite row change keys from relation metadata', async () => {
    const before = { todoId: 'todo-a', assignee: 'ada', role: 'owner' };
    const after = { todoId: 'todo-a', assignee: 'ada', role: 'reviewer' };
    const added = { todoId: 'todo-a', assignee: 'ben', role: 'reader' };
    const handle = watch(
      fromObjectSource({ assignments: [before] }),
      schema.assignments,
      () => undefined
    );

    await handle.refresh();

    await expect(handle.refresh(fromObjectSource({ assignments: [after, added] }))).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [after, added],
      removedRows: [before],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey({ todoId: 'todo-a', assignee: 'ada' }),
          before,
          after
        },
        {
          op: 'insert',
          key: stableRowKey({ todoId: 'todo-a', assignee: 'ben' }),
          after: added
        }
      ]
    });
  });

  it('does not pair relation watch rows with missing key fields', async () => {
    const before = { title: 'Missing id', done: false };
    const after = { title: 'Still missing id', done: false };
    const events: unknown[] = [];
    const handle = watch(
      fromObjectSource({ todos: [before] }),
      schema.todos,
      (event) => {
        events.push(event);
      }
    );

    await handle.refresh();

    await expect(handle.refresh(fromObjectSource({ todos: [after] }))).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [after],
      removedRows: [before],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(after),
          after
        },
        {
          op: 'delete',
          key: stableRowKey(before),
          before
        }
      ],
      diagnostics: [
        {
          code: 'row_key_missing',
          surface: 'diff',
          side: 'before',
          field: 'id',
          detail: {
            reason: 'missing',
            keyFields: ['id']
          }
        },
        {
          code: 'row_key_missing',
          surface: 'diff',
          side: 'after',
          field: 'id',
          detail: {
            reason: 'missing',
            keyFields: ['id']
          }
        }
      ]
    });
    expect(events[1]).toMatchObject({
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(after),
          after
        },
        {
          op: 'delete',
          key: stableRowKey(before),
          before
        }
      ],
      diagnostics: [
        { code: 'row_key_missing', surface: 'diff', side: 'before', field: 'id' },
        { code: 'row_key_missing', surface: 'diff', side: 'after', field: 'id' }
      ]
    });
  });

  it('does not pair duplicate relation watch keys and preserves unique key updates', async () => {
    const beforeDuplicateA = { id: 'todo-dupe', title: 'First', done: false };
    const beforeDuplicateB = { id: 'todo-dupe', title: 'Second', done: false };
    const afterDuplicate = { id: 'todo-dupe', title: 'Replacement', done: false };
    const beforeUnique = { id: 'todo-a', title: 'Alpha', done: false };
    const afterUnique = { id: 'todo-a', title: 'Alpha updated', done: false };
    const events: unknown[] = [];
    const handle = watch(
      fromObjectSource({ todos: [beforeDuplicateA, beforeDuplicateB, beforeUnique] }),
      schema.todos,
      (event) => {
        events.push(event);
      }
    );

    await handle.refresh();

    await expect(handle.refresh(fromObjectSource({ todos: [afterDuplicate, afterUnique] }))).resolves.toMatchObject({
      delivered: true,
      changed: true,
      addedRows: [afterDuplicate, afterUnique],
      removedRows: [beforeDuplicateA, beforeDuplicateB, beforeUnique],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(afterDuplicate),
          after: afterDuplicate
        },
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before: beforeUnique,
          after: afterUnique
        },
        {
          op: 'delete',
          key: stableRowKey(beforeDuplicateA),
          before: beforeDuplicateA
        },
        {
          op: 'delete',
          key: stableRowKey(beforeDuplicateB),
          before: beforeDuplicateB
        }
      ],
      diagnostics: [
        {
          code: 'row_key_duplicate',
          surface: 'diff',
          side: 'before',
          key: stableRowKey('todo-dupe'),
          detail: {
            count: 2,
            keyFields: ['id']
          }
        }
      ]
    });
    expect(events[1]).toMatchObject({
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(afterDuplicate),
          after: afterDuplicate
        },
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before: beforeUnique,
          after: afterUnique
        },
        {
          op: 'delete',
          key: stableRowKey(beforeDuplicateA),
          before: beforeDuplicateA
        },
        {
          op: 'delete',
          key: stableRowKey(beforeDuplicateB),
          before: beforeDuplicateB
        }
      ],
      diagnostics: [{ code: 'row_key_duplicate', surface: 'diff', side: 'before', key: stableRowKey('todo-dupe') }]
    });
  });

  it('keeps unsupported watch handles explicit and inert', async () => {
    let calls = 0;
    const db = {};
    const handle = watch(
      db,
      openTodos,
      () => {
        calls += 1;
      },
      { immediate: true, label: 'open todos' }
    );

    expect(calls).toBe(0);
    expect(handle).toMatchObject({
      kind: 'watch',
      db,
      target: openTodos,
      supported: false,
      mode: 'unsupported',
      label: 'open todos',
      diagnostics: [{ code: 'watch_unsupported', surface: 'watch' }]
    });
    await expect(handle.refresh()).resolves.toMatchObject({
      kind: 'watchRefresh',
      id: handle.id,
      delivered: false,
      changed: false,
      diagnostics: [{ code: 'watch_unsupported', surface: 'watch' }]
    });
    expect(calls).toBe(0);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', id: handle.id, closed: true, diagnostics: [] });
    expect(unwatch(handle)).toMatchObject({
      kind: 'unwatch',
      id: handle.id,
      closed: false,
      diagnostics: [{ code: 'watch_already_closed', surface: 'watch' }]
    });
  });
});
