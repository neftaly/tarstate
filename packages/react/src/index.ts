import {
  canonicalizeJson,
  type CommitReceipt,
  type JsonValue,
  type ObserveRequest,
  type ObserverSnapshot,
  type PreparedPlan,
  type QueryObserver,
  type TransactionAttempt
} from '@tarstate/core';
import {
  createContext,
  createElement,
  useContext,
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react';

export type ObservableDatabase<Query = unknown, Row = unknown> = {
  readonly authorityScope: string;
  readonly authorityFingerprint: string;
  readonly registryFingerprint: string;
  observe(request: ObserveRequest<Query>): QueryObserver<Row>;
};

/** Optional phantom row type carried by generated/prepared query declarations. */
export type ReactPreparedPlan<Query, Row> = PreparedPlan<Query> & {
  readonly __tarstateRowType?: (row: Row) => Row;
};

export type ServerObservation<Query = unknown, Row = unknown> = {
  readonly request: ObserveRequest<Query>;
  readonly snapshot: ObserverSnapshot<Row>;
};

export type MutationEntry = {
  readonly mutationId: number;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly state: 'pending' | 'settled' | 'failed';
  readonly receipt?: CommitReceipt;
  readonly error?: { readonly name: string; readonly message: string };
};

export type MutationState = {
  readonly pendingCount: number;
  readonly mutations: readonly MutationEntry[];
};

export type TarstateProviderProps<Query = unknown, Row = unknown> = {
  readonly database: ObservableDatabase<Query, Row>;
  readonly commit?: (attempt: TransactionAttempt) => Promise<CommitReceipt>;
  readonly serverObservations?: readonly ServerObservation<Query, Row>[];
  readonly children?: ReactNode;
};

type Runtime = {
  readonly database: ErasedDatabase;
  readonly serverObservations: ReadonlyMap<string, ObserverSnapshot<unknown>>;
  readonly mutationStore: MutationStore;
};

const TarstateContext = createContext<Runtime | undefined>(undefined);

/** Borrows a database. Unmounting never closes the database or its sources. */
export const TarstateProvider = <Query, Row>({ database, commit, serverObservations = emptyServerObservations as readonly ServerObservation<Query, Row>[], children }: TarstateProviderProps<Query, Row>): ReactNode => {
  const runtime = useMemo<Runtime>(() => ({
    database: database as unknown as ErasedDatabase,
    serverObservations: normalizeServerObservations(database, serverObservations),
    mutationStore: new MutationStore(commit)
  }), [database, commit, serverObservations]);
  return createElement(TarstateContext.Provider, { value: runtime }, children);
};

export const useDatabase = <Query = unknown, Row = unknown>(): ObservableDatabase<Query, Row> =>
  useRuntime().database as unknown as ObservableDatabase<Query, Row>;

export type QueryHookOptions<Row, Selected = ObserverSnapshot<Row>> = {
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly allowPartial?: boolean;
  readonly select?: (snapshot: ObserverSnapshot<Row>) => Selected;
  readonly isEqual?: (left: Selected, right: Selected) => boolean;
};

export function useQuery<Query, Row, Selected>(
  plan: ReactPreparedPlan<Query, Row>,
  options: QueryHookOptions<Row, Selected> & { readonly select: (snapshot: ObserverSnapshot<Row>) => Selected }
): Selected;
export function useQuery<Query, Row>(
  plan: ReactPreparedPlan<Query, Row>,
  options?: Omit<QueryHookOptions<Row>, 'select'>
): ObserverSnapshot<Row>;
export function useQuery<Query, Row, Selected = ObserverSnapshot<Row>>(
  plan: ReactPreparedPlan<Query, Row>,
  options: QueryHookOptions<Row, Selected> = {}
): Selected {
  const runtime = useRuntime();
  const request = queryRequest(plan, options);
  const key = queryObservationKey(runtime.database, request);
  const store = queryStore<Query, Row>(runtime.database, request, key);
  const serverSnapshot = runtime.serverObservations.get(key) as ObserverSnapshot<Row> | undefined;
  const select = options.select ?? identitySnapshot<Row, Selected>;
  return useExternalStoreWithSelector(
    store.subscribe,
    store.getSnapshot,
    serverSnapshot === undefined ? undefined : () => serverSnapshot,
    select,
    options.isEqual ?? Object.is
  );
}

export type RowHookOptions<Row> = Omit<QueryHookOptions<Row, Row | undefined>, 'select'> & {
  /** Retained exact rows must be requested explicitly while current is unknown. */
  readonly evidence?: 'current' | 'last-exact';
};

export const useRow = <Query, Row>(
  plan: ReactPreparedPlan<Query, Row>,
  resultKey: string,
  options: RowHookOptions<Row> = {}
): Row | undefined => {
  const select = useMemo(() => (snapshot: ObserverSnapshot<Row>): Row | undefined => {
    if (snapshot.state === 'closed') return undefined;
    const result = options.evidence === 'last-exact' ? snapshot.lastExact : snapshot.current;
    if (result === undefined) return undefined;
    const index = result.resultKeys.indexOf(resultKey);
    return index < 0 ? undefined : result.rows[index];
  }, [options.evidence, resultKey]);
  return useQuery(plan, { ...options, select, isEqual: options.isEqual ?? Object.is });
};

export type Commit = (attempt: TransactionAttempt) => Promise<CommitReceipt>;

export const useCommit = (): Commit => useRuntime().mutationStore.commit;

export type MutationStateOptions<Selected> = {
  readonly select: (state: MutationState) => Selected;
  readonly isEqual?: (left: Selected, right: Selected) => boolean;
};

export function useMutationState(): MutationState;
export function useMutationState<Selected>(options: MutationStateOptions<Selected>): Selected;
export function useMutationState<Selected = MutationState>(options?: MutationStateOptions<Selected>): Selected {
  const store = useRuntime().mutationStore;
  const select = options?.select ?? identityMutationState<Selected>;
  return useExternalStoreWithSelector(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
    select,
    options?.isEqual ?? Object.is
  );
}

const queryObservationKey = <Query>(
  database: Pick<ObservableDatabase, 'authorityScope' | 'authorityFingerprint' | 'registryFingerprint'>,
  request: ObserveRequest<Query>
): string => [
  request.plan.planId,
  request.plan.rootNodeId,
  canonicalizeJson((request.parameters ?? {}) as JsonValue),
  database.authorityScope,
  database.authorityFingerprint,
  database.registryFingerprint,
  request.plan.datasetId,
  request.allowPartial === true ? 'partial' : 'exact'
].join('\u0000');

const emptyServerObservations: readonly ServerObservation[] = Object.freeze([]);

const queryRequest = <Query>(plan: PreparedPlan<Query>, options: Pick<QueryHookOptions<unknown, unknown>, 'parameters' | 'allowPartial'>): ObserveRequest<Query> => ({
  plan,
  ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
  ...(options.allowPartial === undefined ? {} : { allowPartial: options.allowPartial })
});

const useRuntime = (): Runtime => {
  const runtime = useContext(TarstateContext);
  if (runtime === undefined) throw new Error('Tarstate hooks require a TarstateProvider');
  return runtime;
};

const normalizeServerObservations = <Query, Row>(database: ObservableDatabase<Query, Row>, observations: readonly ServerObservation<Query, Row>[]): ReadonlyMap<string, ObserverSnapshot<unknown>> => {
  const output = new Map<string, ObserverSnapshot<unknown>>();
  for (const observation of observations) {
    const key = queryObservationKey(database, observation.request);
    if (output.has(key)) throw new Error('Duplicate server observation: ' + key);
    output.set(key, deepFreezeClone(observation.snapshot));
  }
  return output;
};

type ErasedDatabase = ObservableDatabase<unknown, unknown>;
const storesByDatabase = new WeakMap<object, Map<string, QueryStore<unknown>>>();

const queryStore = <Query, Row>(database: ErasedDatabase, request: ObserveRequest<Query>, key: string): QueryStore<Row> => {
  let stores = storesByDatabase.get(database);
  if (stores === undefined) {
    stores = new Map();
    storesByDatabase.set(database, stores);
  }
  const existing = stores.get(key);
  if (existing !== undefined) return existing as QueryStore<Row>;
  const store = new QueryStore<Row>(database, request as unknown as ObserveRequest<unknown>, () => {
    if (stores?.get(key) === store) stores.delete(key);
  });
  stores.set(key, store as QueryStore<unknown>);
  return store;
};

class QueryStore<Row> {
  readonly #database: ErasedDatabase;
  readonly #request: ObserveRequest<unknown>;
  readonly #collect: () => void;
  readonly #listeners = new Set<() => void>();
  #observer: QueryObserver<Row> | undefined;
  #unsubscribeObserver: (() => void) | undefined;
  #closeGeneration = 0;

  constructor(database: ErasedDatabase, request: ObserveRequest<unknown>, collect: () => void) {
    this.#database = database;
    this.#request = request;
    this.#collect = collect;
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
      for (const listener of Array.from(this.#listeners)) listener();
    });
    if (this.#listeners.size === 0) this.#scheduleClose();
  }

  #scheduleClose(): void {
    const generation = ++this.#closeGeneration;
    queueMicrotask(() => {
      if (generation !== this.#closeGeneration || this.#listeners.size !== 0) return;
      this.#unsubscribeObserver?.();
      this.#unsubscribeObserver = undefined;
      this.#observer?.close();
      this.#observer = undefined;
      this.#collect();
    });
  }
}

class MutationStore {
  readonly #commitImplementation: ((attempt: TransactionAttempt) => Promise<CommitReceipt>) | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: MutationState = emptyMutationState;
  #nextMutationId = 1;

  constructor(commit: ((attempt: TransactionAttempt) => Promise<CommitReceipt>) | undefined) {
    this.#commitImplementation = commit;
  }

  readonly getSnapshot = (): MutationState => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  readonly commit: Commit = async (attempt) => {
    if (this.#commitImplementation === undefined) throw new Error('TarstateProvider has no commit implementation');
    const mutationId = this.#nextMutationId++;
    this.#replace({
      mutationId,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      state: 'pending'
    });
    try {
      const receipt = await this.#commitImplementation(attempt);
      this.#replace({
        mutationId,
        operationEpoch: attempt.operationEpoch,
        operationId: attempt.operationId,
        attachmentId: attempt.attachmentId,
        state: 'settled',
        receipt
      });
      return receipt;
    } catch (error) {
      this.#replace({
        mutationId,
        operationEpoch: attempt.operationEpoch,
        operationId: attempt.operationId,
        attachmentId: attempt.attachmentId,
        state: 'failed',
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) }
      });
      throw error;
    }
  };

  #replace(entry: MutationEntry): void {
    const replaced = [...this.#snapshot.mutations.filter(({ mutationId }) => mutationId !== entry.mutationId), deepFreezeClone(entry)];
    const pending = replaced.filter(({ state }) => state === 'pending');
    const settled = replaced.filter(({ state }) => state !== 'pending').slice(-100);
    const mutations = [...settled, ...pending].sort((left, right) => left.mutationId - right.mutationId);
    this.#snapshot = Object.freeze({
      pendingCount: mutations.filter(({ state }) => state === 'pending').length,
      mutations: Object.freeze(mutations)
    });
    for (const listener of Array.from(this.#listeners)) listener();
  }
}

const emptyMutationState: MutationState = Object.freeze({ pendingCount: 0, mutations: Object.freeze([]) });

const identitySnapshot = <Row, Selected>(snapshot: ObserverSnapshot<Row>): Selected => snapshot as Selected;
const identityMutationState = <Selected>(state: MutationState): Selected => state as Selected;

const useExternalStoreWithSelector = <Snapshot, Selected>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selected,
  isEqual: (left: Selected, right: Selected) => boolean
): Selected => {
  const selectedRef = useRef<{ hasValue: boolean; value: Selected }>({ hasValue: false, value: undefined as Selected });
  const [getSelectedSnapshot, getSelectedServerSnapshot] = useMemo(() => {
    let hasMemo = false;
    let memoSnapshot: Snapshot;
    let memoSelection: Selected;
    const selectSnapshot = (snapshot: Snapshot): Selected => {
      if (!hasMemo) {
        hasMemo = true;
        memoSnapshot = snapshot;
        const selected = selector(snapshot);
        if (selectedRef.current.hasValue && isEqual(selectedRef.current.value, selected)) {
          memoSelection = selectedRef.current.value;
          return memoSelection;
        }
        memoSelection = selected;
        return selected;
      }
      if (Object.is(memoSnapshot, snapshot)) return memoSelection;
      const selected = selector(snapshot);
      memoSnapshot = snapshot;
      if (isEqual(memoSelection, selected)) return memoSelection;
      memoSelection = selected;
      return selected;
    };
    return [
      () => selectSnapshot(getSnapshot()),
      getServerSnapshot === undefined ? undefined : () => selectSnapshot(getServerSnapshot())
    ] as const;
  }, [getSnapshot, getServerSnapshot, isEqual, selector]);
  const selected = useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedServerSnapshot);
  useEffect(() => {
    selectedRef.current = { hasValue: true, value: selected };
  }, [selected]);
  useDebugValue(selected);
  return selected;
};

const deepFreezeClone = <Value>(value: Value, seen = new WeakMap<object, object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as Value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(deepFreezeClone(item, seen));
    return Object.freeze(output) as Value;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) output[key] = deepFreezeClone(item, seen);
  return Object.freeze(output) as Value;
};
