import { describe, expect, it } from 'vitest';
import { createDb, q, setEnvTx, transact } from '@tarstate/core/db';
import {
  mat,
  materializedRowsForQuery,
  readMaterializedQuery
} from '@tarstate/core/materialization';
import { trackTransact } from '@tarstate/core/runtime';
import { createStore } from '@tarstate/core/store';
import { asc, env, eq, from, pipe, project, sort, value, where } from '@tarstate/core/query';
import {
  attachWatches,
  diffQuery,
  subscribeWatch,
  unwatch,
  watch,
  watchTargetKey
} from '@tarstate/core/watch';
import { deleteByKey, insert } from '@tarstate/core/write';
import { entry, makeDb, schema } from './behavior-fixtures.js';

const entryList = pipe(
  from(entry),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount
  })
);

const cashEntryList = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

describe('materialization, watch, and store behavior', () => {
  it('serves materialized query rows from a stable cache until dependencies change', () => {
    const db = mat(makeDb(), cashEntryList);
    const first = q(db, cashEntryList);
    const second = q(db, cashEntryList);

    expect(first).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
    expect(second).toBe(first);
    expect(materializedRowsForQuery(db, cashEntryList)).toBe(first);
    expect(readMaterializedQuery(db, cashEntryList)).toEqual({
      rows: first,
      diagnostics: [],
      materialized: true
    });

    const afterUnrelatedWrite = transact(
      db,
      insert(schema.accounts, { id: 'bank', name: 'Bank', kind: 'asset' })
    );
    expect(q(afterUnrelatedWrite, cashEntryList)).toBe(first);

    const afterEntryWrite = transact(
      afterUnrelatedWrite,
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const changed = q(afterEntryWrite, cashEntryList);

    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e1', amount: 120 },
      { id: 'e4', amount: 0 },
      { id: 'e5', amount: 35 }
    ]);
  });

  it('refreshes materialized query rows when dependent env values change', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.accountId, env<string>('accountId'))),
      sort(asc(entry.id)),
      project({
        id: entry.id,
        accountId: entry.accountId
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries);
    const first = q(db, envFilteredEntries);

    expect(first).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);

    const next = transact(db, setEnvTx({ accountId: 'sales' }));
    const changed = q(next, envFilteredEntries);

    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('watch refresh and query diffs report added, removed, and unchanged rows', async () => {
    const before = makeDb();
    const after = transact(
      before,
      [
        deleteByKey(schema.entries, 'e2'),
        insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
      ]
    );
    const events: unknown[] = [];
    const handle = watch(before, entryList, (event) => {
      events.push(event);
    }, { label: 'entries' });
    const refresh = await handle.refresh(after);
    const diff = await diffQuery(before, after, entryList);

    const expectedAdded = [{ id: 'e5', accountId: 'cash', amount: 35 }];
    const expectedRemoved = [{ id: 'e2', accountId: 'sales', amount: -120 }];
    const expectedUnchanged = [
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ];

    expect(refresh).toEqual(expect.objectContaining({
      id: 'entries',
      targetKey: watchTargetKey(entryList),
      delivered: true,
      changed: true,
      added: expectedAdded,
      removed: expectedRemoved,
      unchanged: expectedUnchanged,
      diagnostics: []
    }));
    expect(events).toEqual([
      expect.objectContaining({
        changed: true,
        added: expectedAdded,
        removed: expectedRemoved,
        unchanged: expectedUnchanged
      })
    ]);
    expect(diff).toEqual(expect.objectContaining({
      queryKey: watchTargetKey(entryList),
      changed: true,
      added: expectedAdded,
      removed: expectedRemoved,
      unchanged: expectedUnchanged,
      diagnostics: []
    }));

    const subscription = subscribeWatch(handle, (event) => {
      events.push(event);
    });
    expect(subscription.active).toBe(true);
    expect(subscription.unsubscribe()).toEqual({ id: 'entries', unsubscribed: true, diagnostics: [] });
    expect(unwatch(handle)).toEqual({ id: 'entries', closed: true, diagnostics: [] });
  });

  it('trackTransact returns watcher changes for attached targets', async () => {
    const watched = attachWatches(makeDb(), entryList);
    const result = await trackTransact(
      watched,
      deleteByKey(schema.entries, 'e2'),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const targetKey = watchTargetKey(entryList);
    const expectedAdded = [{ id: 'e5', accountId: 'cash', amount: 35 }];
    const expectedRemoved = [{ id: 'e2', accountId: 'sales', amount: -120 }];

    expect(result.supported).toBe(true);
    expect(result.result).toEqual(expect.objectContaining({ committed: true, applied: 2 }));
    expect(result.diagnostics).toEqual([]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        targetKey,
        changed: true,
        added: expectedAdded,
        removed: expectedRemoved,
        unchanged: [
          { id: 'e1', accountId: 'cash', amount: 120 },
          { id: 'e3', accountId: 'fees', amount: -5 },
          { id: 'e4', accountId: 'cash', amount: 0 }
        ]
      })
    ]);
    expect(result.changesByTargetKey.get(targetKey)).toEqual(result.changes[0]);
    expect(result.changesByQueryKey[targetKey]).toEqual(expect.objectContaining({
      targetKey,
      added: expectedAdded,
      removed: expectedRemoved
    }));
    expect(q(result.db, entryList)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 },
      { id: 'e5', accountId: 'cash', amount: 35 }
    ]);
  });

  it('store query, view, commit, and subscriptions reflect accepted commits', async () => {
    const store = createStore(makeDb());
    const view = store.view(entryList);
    const storeRevisions: number[] = [];
    const viewRevisions: number[] = [];
    const unsubscribeStore = store.subscribe(() => {
      storeRevisions.push(store.getSnapshot().revision);
    });
    const unsubscribeView = view.subscribe(() => {
      viewRevisions.push(view.getSnapshot().revision);
    });

    expect(store.getSnapshot()).toEqual(expect.objectContaining({ revision: 0, diagnostics: [] }));
    expect(store.query(entryList)).toEqual(expect.objectContaining({
      revision: 0,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 }
      ],
      diagnostics: []
    }));
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      revision: 0,
      queryKey: view.queryKey,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 }
      ],
      diagnostics: []
    }));

    const commit = await store.commit(
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );

    expect(commit).toEqual(expect.objectContaining({
      status: 'accepted',
      reflected: true,
      effects: expect.objectContaining({
        patches: 1,
        applied: 1,
        diagnostics: []
      }),
      diagnostics: []
    }));
    expect(commit.snapshot.revision).toBe(1);
    expect(storeRevisions).toEqual([1]);
    expect(viewRevisions).toEqual([1]);
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      revision: 1,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 },
        { id: 'e5', accountId: 'cash', amount: 35 }
      ],
      diagnostics: []
    }));

    unsubscribeView();
    unsubscribeStore();
    await store.commit(
      insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 10, memo: 'late', posted: true })
    );
    expect(storeRevisions).toEqual([1]);
    expect(viewRevisions).toEqual([1]);

    store.close();
    store.close();
  });
});
