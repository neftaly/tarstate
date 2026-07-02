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
});
