import type {
  ObserveRequest,
  ObserverDiagnosticReporter,
  ObserverSnapshot,
  QueryObserver
} from '@tarstate/core/database/observer';
import type { ErasedDatabase } from './contracts.js';
import { notifyReactListener, runReactCleanups } from './shared.js';

const storesByDatabase = new WeakMap<object, Map<string, QueryStore<unknown>>>();

export const queryStore = <Query, Row>(database: ErasedDatabase, request: ObserveRequest<Query>, key: string): QueryStore<Row> => {
  let stores = storesByDatabase.get(database);
  if (stores === undefined) {
    stores = new Map();
    storesByDatabase.set(database, stores);
  }
  const existing = stores.get(key);
  if (existing !== undefined) return existing as QueryStore<Row>;
  const store = createQueryStore<Row>(database, request as unknown as ObserveRequest<unknown>, () => {
    if (stores?.get(key) === store) stores.delete(key);
  });
  stores.set(key, store as QueryStore<unknown>);
  return store;
};

export type QueryStore<Row> = {
  readonly getSnapshot: () => ObserverSnapshot<Row>;
  readonly subscribe: (
    listener: () => void,
    onDiagnostic?: ObserverDiagnosticReporter
  ) => () => void;
};

export const createQueryStore = <Row>(
  database: ErasedDatabase,
  request: ObserveRequest<unknown>,
  collect: () => void
): QueryStore<Row> => {
  const listeners = new Set<{
    readonly notify: () => void;
    readonly onDiagnostic: ObserverDiagnosticReporter | undefined;
  }>();
  let observer: QueryObserver<Row> | undefined;
  let unsubscribeObserver: (() => void) | undefined;
  let closeGeneration = 0;

  const scheduleClose = (onDiagnostic?: ObserverDiagnosticReporter): void => {
    const generation = ++closeGeneration;
    queueMicrotask(() => {
      if (generation !== closeGeneration || listeners.size !== 0) return;
      const activeObserver = observer;
      const cleanups = [unsubscribeObserver, activeObserver === undefined ? undefined : () => activeObserver.close(), collect]
        .filter((cleanup): cleanup is () => void => cleanup !== undefined);
      unsubscribeObserver = undefined;
      observer = undefined;
      runReactCleanups(cleanups, 'react-query', 'close-query-store', onDiagnostic);
    });
  };

  const ensureObserver = (): QueryObserver<Row> => {
    if (observer !== undefined) return observer;
    const openedObserver = database.observe(request) as QueryObserver<Row>;
    observer = openedObserver;
    unsubscribeObserver = openedObserver.subscribe(() => {
      for (const subscription of Array.from(listeners)) {
        notifyReactListener(
          subscription.notify,
          'react-query',
          'publish-query-store',
          subscription.onDiagnostic
        );
      }
    });
    if (listeners.size === 0) scheduleClose();
    return openedObserver;
  };

  const subscribe = (listener: () => void, onDiagnostic?: ObserverDiagnosticReporter): (() => void) => {
    const subscription = { notify: listener, onDiagnostic };
    listeners.add(subscription);
    closeGeneration += 1;
    ensureObserver();
    return () => {
      if (!listeners.delete(subscription)) return;
      if (listeners.size === 0) scheduleClose(onDiagnostic);
    };
  };

  scheduleClose();
  return {
    getSnapshot: (): ObserverSnapshot<Row> => ensureObserver().getSnapshot(),
    subscribe
  };
};
