import { describe, expect, it } from 'vitest';
import type { RelationRuntime } from '@tarstate/core/adapter';
import { createDb, tryTransact } from '@tarstate/core/db';
import { as, eq, from, keyBy, pipe, project, where } from '@tarstate/core/query';
import { trackTransact } from '@tarstate/core/experimental/runtime';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { fromObjectSource } from '@tarstate/core/source';
import {
  subscribeWatch,
  unwatch,
  unwatchTarget,
  watch,
  watchChangeMap,
  watchRuntime,
  watchTarget
} from '@tarstate/core/experimental/watch';
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

describe('tarstate watch/change helpers', () => {
  it('refreshes manual query watches over object-backed snapshots', async () => {
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
      supported: true,
      mode: 'manual',
      label: 'open todos',
      diagnostics: []
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
    await expect(handle.refresh(db1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-c', title: 'Gamma' }]
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      changed: true,
      rows: [{ id: 'todo-c', title: 'Gamma' }]
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: false,
      rows: [{ id: 'todo-c', title: 'Gamma' }]
    });
    expect(events).toHaveLength(3);

    expect(unwatch(handle)).toMatchObject({ closed: true, diagnostics: [] });
    const closedRefresh = await handle.refresh(db1);
    expect(closedRefresh).toMatchObject({ delivered: false, changed: false });
    expect(closedRefresh.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'watch_already_closed' })])
    );
  });

  it('does not deliver manual watch events until refresh is called', async () => {
    const db0 = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const db1 = createDb({
      todos: [{ id: 'todo-b', title: 'Beta', done: false }]
    });
    const events: unknown[] = [];
    const handle = watch(db0, openTodos, (event) => {
      events.push(event);
    });

    expect(events).toEqual([]);

    await expect(handle.refresh(db1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(events).toHaveLength(1);
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('refreshes runtime watches when the host notifies', async () => {
    let notifyRuntime: (() => void) | undefined;
    let snapshotRows = [{ id: 'todo-a', title: 'Alpha', done: false }];
    const runtime: RelationRuntime = {
      source: fromObjectSource({ todos: [] }),
      snapshot: () => ({
        source: fromObjectSource({ todos: snapshotRows }),
        version: snapshotRows
      }),
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

    snapshotRows = [{ id: 'todo-b', title: 'Beta', done: false }];
    requireRuntimeNotify(notifyRuntime)();

    await expect(nextEvent).resolves.toMatchObject({
      changed: true,
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('subscribes additional callbacks and stops delivering after unsubscribe', async () => {
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

    await expect(handle.refresh(db1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-b', title: 'Beta' }]
    });
    expect(primaryEvents).toHaveLength(1);
    expect(subscriberEvents).toHaveLength(1);

    expect(subscription.unsubscribe()).toMatchObject({ unsubscribed: true, diagnostics: [] });
    await expect(handle.refresh(db2)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [{ id: 'todo-c', title: 'Gamma' }]
    });
    expect(primaryEvents).toHaveLength(2);
    expect(subscriberEvents).toHaveLength(1);
  });

  it('delivers tracked transaction changes to query watches', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const todos = write(schema.todos);
    const events: unknown[] = [];
    const handle = watch(db, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [
        todos.updateByKey('todo-a', { done: true }),
        todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
      ])
    );

    expect(result).toMatchObject({
      kind: 'trackTransact',
      supported: true,
      changes: [
        {
          id: handle.id,
          changed: true,
          rows: [
            { id: 'todo-b', title: 'Beta' },
            { id: 'todo-c', title: 'Gamma' }
          ]
        }
      ]
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: true,
      rows: [
        { id: 'todo-b', title: 'Beta' },
        { id: 'todo-c', title: 'Gamma' }
      ]
    });
  });

  it('maps Relic-style watch targets to tracked changes', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const todos = write(schema.todos);
    const registration = watchTarget(db, keyedOpenTodos, { label: 'open todos' });

    expect(registration).toMatchObject({
      kind: 'watchTarget',
      supported: true,
      label: 'open todos',
      diagnostics: []
    });

    const result = await trackTransact(registration.db, (current) =>
      tryTransact(current, [
        todos.updateByKey('todo-a', { done: true }),
        todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
      ])
    );
    const changes = watchChangeMap(result.changes);

    expect(changes.get(keyedOpenTodos)).toMatchObject({
      id: registration.handle.id,
      changed: true
    });
    expect(unwatchTarget(registration)).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('refreshes direct relation watches over relation sources', async () => {
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
      ]
    });
    await expect(handle.refresh(source1)).resolves.toMatchObject({
      delivered: true,
      changed: true,
      rows: [
        { id: 'todo-b', title: 'Beta', done: true },
        { id: 'todo-c', title: 'Gamma', done: false }
      ]
    });
    expect(events).toHaveLength(2);
  });

  it('reports watch listener errors without rewinding the latest rows', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    let fail = true;
    const handle = watch(db, openTodos, () => {
      if (fail) {
        throw new Error('listener failed');
      }
    });

    const failed = await handle.refresh();
    expect(failed).toMatchObject({
      delivered: false,
      changed: true,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
    expect(failed.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'watch_listener_error' })])
    );

    fail = false;
    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      changed: false,
      rows: [{ id: 'todo-a', title: 'Alpha' }],
      diagnostics: []
    });
  });

  it('reports unsupported watch targets and idempotent unwatch diagnostics', async () => {
    const unsupported = watch({}, openTodos, () => undefined);

    expect(unsupported).toMatchObject({
      supported: false,
      mode: 'unsupported'
    });
    expect(unsupported.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'watch_unsupported' })])
    );
    expect(unsupported.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
    const repeated = unsupported.unwatch();
    expect(repeated.closed).toBe(false);
    expect(repeated.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'watch_already_closed' })])
    );
  });
});
