import { describe, expect, it } from 'vitest';
import { setEnvTx, withEnv } from '@tarstate/core/db';
import { asc, env, eq, from, pipe, sort, where } from '@tarstate/core/query';
import { createStore } from '@tarstate/core/store';
import { insert } from '@tarstate/core/write';
import { account, accountsById, entriesById, makeDb, schema } from './behavior-fixtures.js';

describe('store view snapshot caching', () => {
  it('reuses the snapshot and rows objects for repeated reads in one revision', async () => {
    const store = createStore(makeDb());
    const view = store.view(entriesById);

    const first = view.getSnapshot();
    const second = view.getSnapshot();

    expect(second).toBe(first);
    expect(second.rows).toBe(first.rows);
    expect(await view.refresh()).toBe(first);

    await store.commit(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }));

    const next = view.getSnapshot();
    const repeated = view.getSnapshot();

    expect(next).not.toBe(first);
    expect(next.rows).not.toBe(first.rows);
    expect(next.revision).toBe(1);
    expect(repeated).toBe(next);
    expect(repeated.rows).toBe(next.rows);
    expect(next.rows.map((row) => row.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);

    store.close();
  });

  it('shares cached snapshots across duplicate store views for the same query', async () => {
    const store = createStore(makeDb());
    const firstView = store.view(entriesById);
    const secondView = store.view(entriesById);

    const first = firstView.getSnapshot();
    const second = secondView.getSnapshot();

    expect(second).toBe(first);
    expect(second.rows).toBe(first.rows);
    expect(await secondView.refresh()).toBe(first);

    await store.commit(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }));

    const nextFirst = firstView.getSnapshot();
    const nextSecond = secondView.getSnapshot();

    expect(nextFirst).not.toBe(first);
    expect(nextSecond).toBe(nextFirst);
    expect(nextSecond.rows).toBe(nextFirst.rows);
    expect(nextSecond.rows.map((row) => row.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);

    store.close();
  });

  it('does not notify view subscribers for unrelated relation commits', async () => {
    const store = createStore(makeDb());
    const view = store.view(accountsById);
    const first = view.getSnapshot();
    let calls = 0;

    const unsubscribe = view.subscribe(() => {
      calls += 1;
    });

    await store.commit(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }));

    expect(store.getSnapshot().revision).toBe(1);
    expect(calls).toBe(0);
    expect(view.getSnapshot()).toBe(first);
    expect(view.getSnapshot().revision).toBe(0);

    unsubscribe();
    store.close();
  });

  it('checks env-dependent views when env changes alongside unrelated relation deltas', async () => {
    const accountByEnvId = pipe(
      from(account),
      where(eq(account.id, env<string>('accountId'))),
      sort(asc(account.id))
    );
    const store = createStore(withEnv(makeDb(), { accountId: 'cash' }));
    const view = store.view(accountByEnvId);
    const first = view.getSnapshot();
    let calls = 0;

    const unsubscribe = view.subscribe(() => {
      calls += 1;
    });

    await store.commit([
      setEnvTx({ accountId: 'fees' }),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    ]);

    const next = view.getSnapshot();
    expect(first.rows.map((row) => row.id)).toEqual(['cash']);
    expect(calls).toBe(1);
    expect(next.revision).toBe(1);
    expect(next.rows.map((row) => row.id)).toEqual(['fees']);

    unsubscribe();
    store.close();
  });

  it('keeps duplicate callback subscriptions independent', async () => {
    const store = createStore(makeDb());
    const view = store.view(entriesById);
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };

    const unsubscribeFirst = view.subscribe(listener);
    const unsubscribeSecond = view.subscribe(listener);

    await store.commit(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }));
    expect(calls).toBe(2);

    unsubscribeFirst();

    await store.commit(insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 40, memo: 'top-up', posted: true }));
    expect(calls).toBe(3);

    unsubscribeSecond();

    await store.commit(insert(schema.entries, { id: 'e7', accountId: 'cash', amount: 45, memo: 'top-up', posted: true }));
    expect(calls).toBe(3);

    store.close();
  });

  it('notifies view subscribers even when a store subscriber reads the view first', async () => {
    const store = createStore(makeDb());
    const view = store.view(entriesById);
    let viewCalls = 0;

    const unsubscribeStore = store.subscribe(() => {
      view.getSnapshot();
    });
    const unsubscribeView = view.subscribe(() => {
      viewCalls += 1;
    });

    await store.commit(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }));

    expect(viewCalls).toBe(1);
    expect(view.getSnapshot().revision).toBe(1);

    unsubscribeView();
    unsubscribeStore();
    store.close();
  });

  it('removes one duplicate view subscription without breaking the remaining subscriber', async () => {
    const store = createStore(makeDb());
    const firstView = store.view(entriesById);
    const secondView = store.view(entriesById);
    let firstCalls = 0;
    let secondCalls = 0;

    const unsubscribeFirst = firstView.subscribe(() => {
      firstCalls += 1;
      firstView.getSnapshot();
    });
    const unsubscribeSecond = secondView.subscribe(() => {
      secondCalls += 1;
      secondView.getSnapshot();
    });

    await store.commit(insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }));

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);

    unsubscribeFirst();

    await store.commit(insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 40, memo: 'top-up', posted: true }));

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(2);
    expect(secondView.getSnapshot().rows.map((row) => row.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);

    unsubscribeSecond();
    store.close();
  });
});
