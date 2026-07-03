import { describe, expect, it } from 'vitest';
import { createStore } from '@tarstate/core/store';
import { insert } from '@tarstate/core/write';
import { entriesById, makeDb, schema } from './behavior-fixtures.js';

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
