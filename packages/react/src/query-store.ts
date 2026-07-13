import type {
  ObserveRequest,
  ObserverDiagnosticReporter,
  ObserverSnapshot,
  QueryObserver
} from '@tarstate/core';
import type { ErasedDatabase } from './contracts.js';
import { notifyReactListeners, runReactCleanups } from './shared.js';

const storesByDatabase = new WeakMap<object, Map<string, QueryStore<unknown>>>();

export const queryStore = <Query, Row>(database: ErasedDatabase, request: ObserveRequest<Query>, key: string, onDiagnostic?: ObserverDiagnosticReporter): QueryStore<Row> => {
  let stores = storesByDatabase.get(database);
  if (stores === undefined) {
    stores = new Map();
    storesByDatabase.set(database, stores);
  }
  const existing = stores.get(key);
  if (existing !== undefined) return existing as QueryStore<Row>;
  const store = new QueryStore<Row>(database, request as unknown as ObserveRequest<unknown>, () => {
    if (stores?.get(key) === store) stores.delete(key);
  }, onDiagnostic);
  stores.set(key, store as QueryStore<unknown>);
  return store;
};

export class QueryStore<Row> {
  readonly #database: ErasedDatabase;
  readonly #request: ObserveRequest<unknown>;
  readonly #collect: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  #observer: QueryObserver<Row> | undefined;
  #unsubscribeObserver: (() => void) | undefined;
  #closeGeneration = 0;

  constructor(database: ErasedDatabase, request: ObserveRequest<unknown>, collect: () => void, onDiagnostic?: ObserverDiagnosticReporter) {
    this.#database = database;
    this.#request = request;
    this.#collect = collect;
    this.#onDiagnostic = onDiagnostic;
    // Server-only or abandoned renders may create a cache entry without ever
    // acquiring a live observer subscription.
    this.#scheduleClose();
  }

  readonly getSnapshot = (): ObserverSnapshot<Row> => {
    this.#ensureObserver();
    return this.#observer!.getSnapshot();
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#closeGeneration += 1;
    this.#ensureObserver();
    return () => {
      if (!this.#listeners.delete(listener)) return;
      if (this.#listeners.size === 0) this.#scheduleClose();
    };
  };

  #ensureObserver(): void {
    if (this.#observer !== undefined) return;
    this.#observer = this.#database.observe(this.#request) as QueryObserver<Row>;
    this.#unsubscribeObserver = this.#observer.subscribe(() => {
      notifyReactListeners(this.#listeners, 'react-query', 'publish-query-store', this.#onDiagnostic);
    });
    if (this.#listeners.size === 0) this.#scheduleClose();
  }

  #scheduleClose(): void {
    const generation = ++this.#closeGeneration;
    queueMicrotask(() => {
      if (generation !== this.#closeGeneration || this.#listeners.size !== 0) return;
      const observer = this.#observer;
      const cleanups = [this.#unsubscribeObserver, observer === undefined ? undefined : () => observer.close(), this.#collect]
        .filter((cleanup): cleanup is () => void => cleanup !== undefined);
      this.#unsubscribeObserver = undefined;
      this.#observer = undefined;
      runReactCleanups(cleanups, 'react-query', 'close-query-store', this.#onDiagnostic);
    });
  }
}
