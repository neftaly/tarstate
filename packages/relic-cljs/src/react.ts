import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  createRelicCljsRuntime,
  type RelicCljsDb,
  type RelicCljsModule,
  type RelicCljsRuntime,
  type RelicCljsTrackResult
} from './index';

export type RelicCljsStoreSnapshot<Db extends RelicCljsDb = RelicCljsDb> = {
  readonly revision: number;
  readonly db: Db;
};

export type RelicCljsStore<Db extends RelicCljsDb = RelicCljsDb> = {
  readonly runtime: RelicCljsRuntime<Db>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => RelicCljsStoreSnapshot<Db>;
  readonly snapshot: () => unknown;
  readonly q: <Row = unknown>(query: unknown) => readonly Row[];
  readonly transact: (transaction: unknown) => Db;
  readonly trackTransact: <Row = unknown>(transaction: unknown) => RelicCljsTrackResult<Db, Row>;
  readonly mat: (query: unknown) => Db;
  readonly watch: (query: unknown) => Db;
  readonly unwatch: (query: unknown) => Db;
};

export function createRelicCljsStore<Db extends RelicCljsDb>(
  api: RelicCljsModule<Db>,
  seed?: unknown
): RelicCljsStore<Db> {
  const runtime = createRelicCljsRuntime(api, seed);
  const listeners = new Set<() => void>();
  let revision = 0;
  let snapshot = { revision, db: runtime.db() } satisfies RelicCljsStoreSnapshot<Db>;

  const emit = (): void => {
    revision += 1;
    snapshot = { revision, db: runtime.db() };
    for (const listener of listeners) listener();
  };

  const mutate = <Result>(run: () => Result): Result => {
    const result = run();
    emit();
    return result;
  };

  return {
    runtime,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    snapshot: () => runtime.snapshot(),
    q: <Row = unknown>(query: unknown) => runtime.q<Row>(query),
    transact: (transaction) => mutate(() => runtime.transact(transaction)),
    trackTransact: <Row = unknown>(transaction: unknown) => mutate(() => runtime.trackTransact<Row>(transaction)),
    mat: (query) => mutate(() => runtime.mat(query)),
    watch: (query) => mutate(() => runtime.watch(query)),
    unwatch: (query) => mutate(() => runtime.unwatch(query))
  };
}

export function useRelicCljsSnapshot<Db extends RelicCljsDb>(
  store: RelicCljsStore<Db>
): RelicCljsStoreSnapshot<Db> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useRelicCljsQuery<Row = unknown>(
  store: RelicCljsStore,
  query: unknown
): readonly Row[] {
  const state = useRelicCljsSnapshot(store);
  return useMemo(() => store.q<Row>(query), [query, state.revision, store]);
}

export function useRelicCljsTransact<Db extends RelicCljsDb>(
  store: RelicCljsStore<Db>
): RelicCljsStore<Db>['transact'] {
  return useCallback((transaction: unknown) => store.transact(transaction), [store]);
}

export function useRelicCljsWatch<Row = unknown>(
  store: RelicCljsStore,
  query: unknown
): readonly Row[] {
  useEffect(() => {
    store.watch(query);
    return () => {
      store.unwatch(query);
    };
  }, [query, store]);

  return useRelicCljsQuery<Row>(store, query);
}
