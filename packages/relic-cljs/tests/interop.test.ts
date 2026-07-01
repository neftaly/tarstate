import { describe, expect, it } from 'vitest';
import {
  createRelicCljsRuntime,
  defaultRelicCljsModuleSpecifier,
  loadRelicCljsModule,
  type RelicCljsDb,
  type RelicCljsModule
} from '../src/index';
import { createRelicCljsStore } from '../src/react';

type FakeDb = RelicCljsDb & {
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
  readonly watched: readonly unknown[];
};

function fakeDb(rows: Readonly<Record<string, readonly unknown[]>>, watched: readonly unknown[] = []): FakeDb {
  return { kind: 'relicCljsDb', rows, watched };
}

const fakeApi: RelicCljsModule<FakeDb> = {
  createDb: (seed) => fakeDb(seed as Readonly<Record<string, readonly unknown[]>>),
  snapshot: (db) => db.rows,
  q: <Row = unknown>(db: FakeDb, query: unknown) => (db.rows[String(query)] ?? []) as readonly Row[],
  transact: (db, transaction) => {
    const input = transaction as { readonly relation: string; readonly row: unknown };
    return fakeDb({
      ...db.rows,
      [input.relation]: [...(db.rows[input.relation] ?? []), input.row]
    }, db.watched);
  },
  trackTransact: <Row = unknown>(db: FakeDb, transaction: unknown) => {
    const input = transaction as { readonly relation: string; readonly row: Row };
    const nextDb = fakeApi.transact(db, transaction);
    return {
      db: nextDb,
      changes: [{ query: input.relation, added: [input.row], deleted: [] }]
    };
  },
  mat: (db) => db,
  watch: (db, query) => fakeDb(db.rows, [...db.watched, query]),
  unwatch: (db, query) => fakeDb(db.rows, db.watched.filter((item) => item !== query))
};

describe('@tarstate/relic-cljs interop facade', () => {
  it('keeps the CLJS database opaque while exposing JS rows and transactions', () => {
    const runtime = createRelicCljsRuntime(fakeApi, {
      items: [{ id: 'a', label: 'Alpha' }]
    });

    expect(runtime.snapshot()).toEqual({ items: [{ id: 'a', label: 'Alpha' }] });
    expect(runtime.q('items')).toEqual([{ id: 'a', label: 'Alpha' }]);

    const result = runtime.trackTransact<{ readonly id: string; readonly label: string }>({
      relation: 'items',
      row: { id: 'b', label: 'Beta' }
    });

    expect(result.changes).toEqual([
      {
        query: 'items',
        added: [{ id: 'b', label: 'Beta' }],
        deleted: []
      }
    ]);
    expect(runtime.q('items')).toEqual([
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' }
    ]);
  });

  it('lets React stores subscribe to revisioned Relic CLJS facade changes', () => {
    const store = createRelicCljsStore(fakeApi, { items: [] });
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => {
      revisions.push(store.getSnapshot().revision);
    });

    store.watch('items');
    store.transact({ relation: 'items', row: { id: 'a' } });
    store.unwatch('items');
    unsubscribe();
    store.transact({ relation: 'items', row: { id: 'b' } });

    expect(revisions).toEqual([1, 2, 3]);
    expect(store.q('items')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('loads a generated CLJS module through an injectable importer', async () => {
    const seen: string[] = [];
    const module = await loadRelicCljsModule(async (specifier) => {
      seen.push(specifier);
      return fakeApi;
    });

    expect(seen).toEqual([defaultRelicCljsModuleSpecifier]);
    expect(module).toBe(fakeApi);
  });
});
