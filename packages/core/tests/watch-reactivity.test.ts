import { describe, expect, it } from 'vitest';
import {
  as,
  booleanField,
  createDb,
  defineSchema,
  eq,
  from,
  idField,
  insert,
  keyBy,
  pipe,
  project,
  qRows,
  relation,
  stringField,
  where
} from '@tarstate/core';
import { materializedRowsForQuery } from '@tarstate/core/materialization';
import type { Query } from '@tarstate/core/query';
import { trackTransact } from '@tarstate/core/runtime';
import { createStore } from '@tarstate/core/store';
import { subscribeWatch, watch, type WatchEvent } from '@tarstate/core/watch';

type User = {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
};

type ActiveUser = {
  readonly id: string;
  readonly name: string;
};

const schema = defineSchema({
  users: relation<User>({
    key: 'id',
    fields: {
      id: idField('user'),
      name: stringField(),
      active: booleanField()
    }
  })
});

const user = as(schema.users, 'user');
const activeUsers = pipe(
  from(user),
  where(eq(user.active, true)),
  project({
    id: user.id,
    name: user.name
  }),
  keyBy('id')
) as Query<ActiveUser>;

const baseUsers: readonly User[] = [
  { id: 'ada', name: 'Ada', active: true },
  { id: 'bea', name: 'Bea', active: true },
  { id: 'cy', name: 'Cy', active: false }
];

describe('watch reactivity', () => {
  it('backs DB-tracked query watches with maintained materialized rows', async () => {
    const watched = watch(createDb({ users: baseUsers }), activeUsers);

    expect(materializedRowsForQuery(watched, activeUsers)).toEqual([
      { id: 'ada', name: 'Ada' },
      { id: 'bea', name: 'Bea' }
    ]);

    const tracked = await trackTransact(
      watched,
      insert(schema.users, { id: 'dia', name: 'Dia', active: true })
    );
    const materializedChange = tracked.materializations?.changes.find((change) => change.query === activeUsers);
    const watchedChange = tracked.changes.find((change) => change.target === activeUsers);

    expect(materializedChange).toMatchObject({
      addedRows: [{ id: 'dia', name: 'Dia' }],
      removedRows: [],
      rowChanges: [expect.objectContaining({ kind: 'added', row: { id: 'dia', name: 'Dia' } })]
    });
    expect(watchedChange).toMatchObject({
      changed: true,
      addedRows: [{ id: 'dia', name: 'Dia' }],
      rowChanges: materializedChange?.rowChanges
    });
    expect(tracked.changes.filter((change) => change.target === activeUsers)).toHaveLength(1);
    expect(materializedRowsForQuery(tracked.db, activeUsers)).toEqual(await qRows(tracked.db, activeUsers));
  });

  it('adds and removes watch subscribers without leaking callbacks to old DB values', async () => {
    const db = createDb({ users: baseUsers });
    const primaryEvents: WatchEvent<ActiveUser>[] = [];
    const subscriberEvents: WatchEvent<ActiveUser>[] = [];
    const handle = watch(db, activeUsers, (event) => {
      primaryEvents.push(event);
    });
    const subscription = subscribeWatch(handle, (event) => {
      subscriberEvents.push(event);
    });

    const first = await trackTransact(
      db,
      insert(schema.users, { id: 'dia', name: 'Dia', active: true })
    );

    expect(subscription).toMatchObject({ active: true, diagnostics: [] });
    expect(primaryEvents).toHaveLength(1);
    expect(subscriberEvents).toHaveLength(1);
    expect(primaryEvents[0]?.rowChanges).toBe(first.materializations?.changes[0]?.rowChanges);

    expect(subscription.unsubscribe()).toMatchObject({ kind: 'watchUnsubscribe', unsubscribed: true });

    const oldDbResult = await trackTransact(
      db,
      insert(schema.users, { id: 'eli', name: 'Eli', active: true })
    );
    const second = await trackTransact(
      first.db,
      insert(schema.users, { id: 'fay', name: 'Fay', active: true })
    );

    expect(oldDbResult.changes).toEqual([]);
    expect(second.changes.find((change) => change.id === handle.id)).toMatchObject({
      addedRows: [{ id: 'fay', name: 'Fay' }]
    });
    expect(primaryEvents).toHaveLength(2);
    expect(subscriberEvents).toHaveLength(1);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });

    const afterUnwatch = await trackTransact(
      second.db,
      insert(schema.users, { id: 'gus', name: 'Gus', active: true })
    );
    expect(afterUnwatch.changes).toEqual([]);
    expect(primaryEvents).toHaveLength(2);
  });

  it('notifies watch callbacks from committed store transactions', async () => {
    const store = createStore(createDb({ users: baseUsers }));
    const events: WatchEvent<ActiveUser>[] = [];
    const handle = watch(store.getSnapshot().db, activeUsers, (event) => {
      events.push(event);
    });

    const committed = await store.commit(
      insert(schema.users, { id: 'dia', name: 'Dia', active: true })
    );

    expect(committed).toMatchObject({ status: 'accepted', reflected: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      addedRows: [{ id: 'dia', name: 'Dia' }]
    });
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
  });

  it('passes read options through store views', async () => {
    const store = createStore(createDb({ users: baseUsers }));
    const view = store.view(activeUsers);

    await expect(view.rows({ rsort: 'name' })).resolves.toEqual([
      { id: 'bea', name: 'Bea' },
      { id: 'ada', name: 'Ada' }
    ]);
    await expect(view.refresh({
      sort: 'name',
      mapRows: (rows) => rows.map((row) => row.id)
    })).resolves.toMatchObject({
      rows: ['ada', 'bea']
    });
  });
});
