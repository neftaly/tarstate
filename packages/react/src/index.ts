import {
  canonicalizeJson,
  type CommitReceipt,
  type JsonValue,
  type ObserveRequest,
  type ObserverSnapshot,
  type PreparedPlan,
  type QueryObserver,
  type TypedPreparedPlan,
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

/** Exact row and parameter types carried by a prepared typed query. */
export type ReactPreparedPlan<
  Query,
  Row,
  Parameters extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>
> = TypedPreparedPlan<Query, Row, Parameters>;

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
  readonly optimisticError?: { readonly phase: 'factory'; readonly name: string; readonly message: string };
};

export type MutationState = {
  readonly pendingCount: number;
  readonly mutations: readonly MutationEntry[];
};

export type OptimisticProjection<Row> = {
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
};

export type OptimisticOverlayInput<Query, Row> = {
  readonly request: ObserveRequest<Query>;
  readonly authoritative: ObserverSnapshot<Row>;
  readonly rows: readonly Row[];
  readonly resultKeys: readonly string[];
  readonly sourceBasis: JsonValue;
  readonly observedBasis: JsonValue;
  readonly rebased: boolean;
};

/** Host-authored UI projection. It grants no write authority and is never a transaction guard. */
export type OptimisticOverlay<Query, Row> = {
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  appliesTo?(request: ObserveRequest<Query>): boolean;
  project(input: OptimisticOverlayInput<Query, Row>): OptimisticProjection<Row>;
};

export type OptimisticOverlayFactory<Query, Row> = (attempt: TransactionAttempt) => OptimisticOverlay<Query, Row> | undefined;

export type OptimisticOperationEvidence = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  readonly observedBasis: JsonValue;
  readonly rebased: boolean;
};

export type ReactObserverSnapshot<Row> = ObserverSnapshot<Row> & {
  readonly optimistic?: { readonly operations: readonly OptimisticOperationEvidence[] };
};

export type TarstateProviderProps<Query = unknown, Row = unknown> = {
  readonly database: ObservableDatabase<Query, Row>;
  readonly commit?: (attempt: TransactionAttempt) => Promise<CommitReceipt>;
  readonly optimisticOverlay?: OptimisticOverlayFactory<Query, Row>;
  readonly serverObservations?: readonly ServerObservation<Query, Row>[];
  readonly children?: ReactNode;
};

type Runtime = {
  readonly database: ErasedDatabase;
  readonly serverObservations: ReadonlyMap<string, ObserverSnapshot<unknown>>;
  readonly mutationStore: MutationStore;
  readonly overlayStore: OptimisticOverlayStore;
  readonly acquire: () => () => void;
};

const TarstateContext = createContext<Runtime | undefined>(undefined);

/** Borrows a database. Unmounting never closes the database or its sources. */
export const TarstateProvider = <Query, Row>({ database, commit, optimisticOverlay, serverObservations = emptyServerObservations as readonly ServerObservation<Query, Row>[], children }: TarstateProviderProps<Query, Row>): ReactNode => {
  const runtime = useMemo<Runtime>(() => createRuntime(
    database as unknown as ErasedDatabase,
    normalizeServerObservations(database, serverObservations),
    commit,
    optimisticOverlay as unknown as ErasedOptimisticOverlayFactory | undefined
  ), [database, commit, optimisticOverlay, serverObservations]);
  useEffect(() => runtime.acquire(), [runtime]);
  return createElement(TarstateContext.Provider, { value: runtime }, children);
};

export const useDatabase = <Query = unknown, Row = unknown>(): ObservableDatabase<Query, Row> =>
  useRuntime().database as unknown as ObservableDatabase<Query, Row>;

export type QueryHookOptions<
  Row,
  Selected = ReactObserverSnapshot<Row>,
  Parameters extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>
> = {
  readonly parameters?: Parameters;
  readonly allowPartial?: boolean;
  readonly select?: (snapshot: ReactObserverSnapshot<Row>) => Selected;
  readonly isEqual?: (left: Selected, right: Selected) => boolean;
};

export function useQuery<Query, Row, Parameters extends Readonly<Record<string, JsonValue>>, Selected>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  options: QueryHookOptions<Row, Selected, NoInfer<Parameters>> & { readonly select: (snapshot: ReactObserverSnapshot<Row>) => Selected }
): Selected;
export function useQuery<Query, Row, Parameters extends Readonly<Record<string, JsonValue>>>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  options?: Omit<QueryHookOptions<Row, ReactObserverSnapshot<Row>, NoInfer<Parameters>>, 'select'>
): ReactObserverSnapshot<Row>;
export function useQuery<Query, Row, Parameters extends Readonly<Record<string, JsonValue>>, Selected = ReactObserverSnapshot<Row>>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  options: QueryHookOptions<Row, Selected, Parameters> = {}
): Selected {
  const runtime = useRuntime();
  const request = queryRequest(plan, options);
  const key = queryObservationKey(runtime.database, request);
  const baseStore = queryStore<Query, Row>(runtime.database, request, key);
  const store = runtime.overlayStore.view<Query, Row>(baseStore, request, key);
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

export type RowHookOptions<Row, Parameters extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>> = Omit<QueryHookOptions<Row, Row | undefined, Parameters>, 'select'> & {
  /** Retained exact rows must be requested explicitly while current is unknown. */
  readonly evidence?: 'current' | 'last-exact';
};

export const useRow = <Query, Row, Parameters extends Readonly<Record<string, JsonValue>>>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  resultKey: string,
  options: RowHookOptions<Row, NoInfer<Parameters>> = {}
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
): string => canonicalizeJson([
  request.plan.planId,
  request.plan.rootNodeId,
  request.parameters ?? {},
  database.authorityScope,
  database.authorityFingerprint,
  database.registryFingerprint,
  request.plan.datasetId,
  request.allowPartial === true
]);

const emptyServerObservations: readonly ServerObservation[] = Object.freeze([]);

const queryRequest = <Query, Parameters extends Readonly<Record<string, JsonValue>>>(
  plan: PreparedPlan<Query>,
  options: { readonly parameters?: Parameters; readonly allowPartial?: boolean }
): ObserveRequest<Query> => ({
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
type ErasedOptimisticOverlayFactory = OptimisticOverlayFactory<unknown, unknown>;
type ActiveOptimisticOverlay = {
  readonly mutationId: number;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  readonly definition: OptimisticOverlay<unknown, unknown>;
};

const optimisticOverlayError = (
  phase: 'appliesTo' | 'project' | 'result',
  overlay: ActiveOptimisticOverlay,
  cause: unknown
): Error => new Error('Optimistic overlay ' + phase + ' failed for operation ' + overlay.operationId, { cause });

const errorDetails = (error: unknown): { readonly name: string; readonly message: string } =>
  error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };

const receiptIdentityMatches = (attempt: TransactionAttempt, receipt: CommitReceipt): boolean =>
  receipt.kind === 'commit'
  && receipt.receiptVersion === 1
  && receipt.operationEpoch === attempt.operationEpoch
  && receipt.operationId === attempt.operationId
  && receipt.attachmentId === attempt.attachmentId
  && receipt.transactionHash === attempt.transaction.contentHash;

const storesByDatabase = new WeakMap<object, Map<string, QueryStore<unknown>>>();

const createRuntime = (
  database: ErasedDatabase,
  serverObservations: ReadonlyMap<string, ObserverSnapshot<unknown>>,
  commit: ((attempt: TransactionAttempt) => Promise<CommitReceipt>) | undefined,
  optimisticOverlay: ErasedOptimisticOverlayFactory | undefined
): Runtime => {
  const overlayStore = new OptimisticOverlayStore();
  const mutationStore = new MutationStore(commit, overlayStore, optimisticOverlay);
  let acquisitions = 0;
  let closeGeneration = 0;
  let closed = false;
  return {
    database,
    serverObservations,
    mutationStore,
    overlayStore,
    acquire: () => {
      if (closed) throw new Error('Tarstate provider runtime is closed');
      acquisitions += 1;
      closeGeneration += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        acquisitions -= 1;
        const generation = ++closeGeneration;
        queueMicrotask(() => {
          if (closed || acquisitions !== 0 || generation !== closeGeneration) return;
          closed = true;
          mutationStore.close();
          overlayStore.close();
        });
      };
    }
  };
};

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

class OptimisticOverlayStore {
  readonly #overlays = new Map<number, ActiveOptimisticOverlay>();
  readonly #views = new Map<string, OptimisticQueryView<unknown, unknown>>();
  #revision = 0;
  #closed = false;

  get revision(): number { return this.#revision; }

  view<Query, Row>(base: QueryStore<Row>, request: ObserveRequest<Query>, key: string): OptimisticQueryView<Query, Row> {
    const existing = this.#views.get(key);
    if (existing !== undefined) return existing as OptimisticQueryView<Query, Row>;
    const view = new OptimisticQueryView(this, base, request, () => {
      if (this.#views.get(key) === view) this.#views.delete(key);
    });
    this.#views.set(key, view as OptimisticQueryView<unknown, unknown>);
    return view;
  }

  add(mutationId: number, attempt: TransactionAttempt, definition: OptimisticOverlay<unknown, unknown>): void {
    if (this.#closed) return;
    // Validate the opaque basis now so projection callbacks never receive a
    // host-only or non-canonical value disguised as source evidence.
    canonicalizeJson(definition.sourceBasis);
    const sourceBasis = deepFreezeClone(definition.sourceBasis);
    this.#overlays.set(mutationId, {
      mutationId,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      sourceId: definition.sourceId,
      sourceBasis,
      definition
    });
    try {
      this.#changed();
    } catch (error) {
      this.#overlays.delete(mutationId);
      this.#changed();
      throw error;
    }
  }

  discard(mutationId: number): void {
    if (!this.#overlays.delete(mutationId)) return;
    this.#changed();
  }

  project<Query, Row>(authoritative: ObserverSnapshot<Row>, request: ObserveRequest<Query>): ReactObserverSnapshot<Row> {
    if (authoritative.state === 'closed' || authoritative.current.completeness === 'unknown' || this.#overlays.size === 0) return authoritative;
    let rows = authoritative.current.rows;
    let resultKeys = authoritative.current.resultKeys;
    const operations: OptimisticOperationEvidence[] = [];
    for (const overlay of this.#overlays.values()) {
      const definition = overlay.definition as OptimisticOverlay<Query, Row>;
      if (definition.appliesTo !== undefined) {
        let applies: boolean;
        try {
          applies = definition.appliesTo(request);
        } catch (error) {
          throw optimisticOverlayError('appliesTo', overlay, error);
        }
        if (!applies) continue;
      }
      const source = authoritative.current.basis.attachments.find((candidate) => candidate.attachmentId === overlay.attachmentId && candidate.sourceId === overlay.sourceId);
      if (source === undefined) continue;
      const observedBasis = source.basis;
      const rebased = canonicalizeJson(observedBasis) !== canonicalizeJson(overlay.sourceBasis);
      let projection: OptimisticProjection<Row>;
      try {
        projection = definition.project({ request, authoritative, rows, resultKeys, sourceBasis: overlay.sourceBasis, observedBasis, rebased });
      } catch (error) {
        throw optimisticOverlayError('project', overlay, error);
      }
      if (projection === null || typeof projection !== 'object' || !Array.isArray(projection.rows) || !Array.isArray(projection.resultKeys) || projection.rows.length !== projection.resultKeys.length || projection.resultKeys.some((key) => typeof key !== 'string') || new Set(projection.resultKeys).size !== projection.resultKeys.length) {
        throw optimisticOverlayError('result', overlay, new TypeError('rows and unique string resultKeys must have equal lengths'));
      }
      rows = projection.rows;
      resultKeys = projection.resultKeys;
      operations.push({
        operationEpoch: overlay.operationEpoch,
        operationId: overlay.operationId,
        attachmentId: overlay.attachmentId,
        sourceId: overlay.sourceId,
        sourceBasis: overlay.sourceBasis,
        observedBasis,
        rebased
      });
    }
    if (operations.length === 0) return authoritative;
    return deepFreezeClone({
      ...authoritative,
      current: { ...authoritative.current, rows, resultKeys },
      optimistic: { operations }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#overlays.clear();
    for (const view of Array.from(this.#views.values())) view.close();
    this.#views.clear();
  }

  #changed(): void {
    this.#revision += 1;
    for (const view of this.#views.values()) view.overlayChanged();
  }
}

class OptimisticQueryView<Query, Row> {
  readonly #overlays: OptimisticOverlayStore;
  readonly #base: QueryStore<Row>;
  readonly #request: ObserveRequest<Query>;
  readonly #collect: () => void;
  readonly #listeners = new Set<() => void>();
  #unsubscribeBase: (() => void) | undefined;
  #baseSnapshot: ObserverSnapshot<Row> | undefined;
  #overlayRevision = -1;
  #snapshot: ReactObserverSnapshot<Row> | undefined;
  #closeGeneration = 0;
  #closed = false;

  constructor(overlays: OptimisticOverlayStore, base: QueryStore<Row>, request: ObserveRequest<Query>, collect: () => void) {
    this.#overlays = overlays;
    this.#base = base;
    this.#request = request;
    this.#collect = collect;
    this.#scheduleClose();
  }

  readonly getSnapshot = (): ReactObserverSnapshot<Row> => this.#recompute();

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    this.#closeGeneration += 1;
    if (this.#unsubscribeBase === undefined) this.#unsubscribeBase = this.#base.subscribe(() => this.#refresh());
    return () => {
      if (!this.#listeners.delete(listener)) return;
      if (this.#listeners.size === 0) this.#scheduleClose();
    };
  };

  overlayChanged(): void { this.#refresh(); }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeBase?.();
    this.#unsubscribeBase = undefined;
    this.#listeners.clear();
    this.#snapshot = undefined;
    this.#baseSnapshot = undefined;
    this.#collect();
  }

  #refresh(): void {
    if (this.#closed) return;
    const previous = this.#snapshot;
    const next = this.#recompute();
    if (previous === next) return;
    for (const listener of Array.from(this.#listeners)) listener();
  }

  #recompute(): ReactObserverSnapshot<Row> {
    const baseSnapshot = this.#base.getSnapshot();
    if (this.#snapshot !== undefined && this.#baseSnapshot === baseSnapshot && this.#overlayRevision === this.#overlays.revision) return this.#snapshot;
    this.#baseSnapshot = baseSnapshot;
    this.#overlayRevision = this.#overlays.revision;
    this.#snapshot = this.#overlays.project(baseSnapshot, this.#request);
    return this.#snapshot;
  }

  #scheduleClose(): void {
    const generation = ++this.#closeGeneration;
    queueMicrotask(() => {
      if (this.#closed || generation !== this.#closeGeneration || this.#listeners.size !== 0) return;
      this.close();
    });
  }
}

class MutationStore {
  readonly #commitImplementation: ((attempt: TransactionAttempt) => Promise<CommitReceipt>) | undefined;
  readonly #overlayStore: OptimisticOverlayStore;
  readonly #optimisticOverlay: ErasedOptimisticOverlayFactory | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: MutationState = emptyMutationState;
  #nextMutationId = 1;
  #closed = false;

  constructor(commit: ((attempt: TransactionAttempt) => Promise<CommitReceipt>) | undefined, overlayStore: OptimisticOverlayStore, optimisticOverlay: ErasedOptimisticOverlayFactory | undefined) {
    this.#commitImplementation = commit;
    this.#overlayStore = overlayStore;
    this.#optimisticOverlay = optimisticOverlay;
  }

  readonly getSnapshot = (): MutationState => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  readonly commit: Commit = async (attempt) => {
    if (this.#closed) throw new Error('Tarstate provider runtime is closed');
    if (this.#commitImplementation === undefined) throw new Error('TarstateProvider has no commit implementation');
    const mutationId = this.#nextMutationId++;
    let optimisticError: MutationEntry['optimisticError'];
    let overlay: OptimisticOverlay<unknown, unknown> | undefined;
    if (this.#optimisticOverlay !== undefined) {
      try {
        overlay = this.#optimisticOverlay(attempt);
      } catch (error) {
        optimisticError = { phase: 'factory', ...errorDetails(error) };
      }
    }
    if (overlay !== undefined) this.#overlayStore.add(mutationId, attempt, overlay);
    this.#replace({
      mutationId,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      state: 'pending',
      ...(optimisticError === undefined ? {} : { optimisticError })
    });
    try {
      const receipt = await this.#commitImplementation(attempt);
      if (!receiptIdentityMatches(attempt, receipt)) throw new Error('Commit receipt identity does not match its transaction attempt');
      this.#overlayStore.discard(mutationId);
      this.#replace({
        mutationId,
        operationEpoch: attempt.operationEpoch,
        operationId: attempt.operationId,
        attachmentId: attempt.attachmentId,
        state: 'settled',
        receipt,
        ...(optimisticError === undefined ? {} : { optimisticError })
      });
      return receipt;
    } catch (error) {
      this.#overlayStore.discard(mutationId);
      this.#replace({
        mutationId,
        operationEpoch: attempt.operationEpoch,
        operationId: attempt.operationId,
        attachmentId: attempt.attachmentId,
        state: 'failed',
        error: errorDetails(error),
        ...(optimisticError === undefined ? {} : { optimisticError })
      });
      throw error;
    }
  };

  #replace(entry: MutationEntry): void {
    if (this.#closed) return;
    const replaced = [...this.#snapshot.mutations.filter(({ mutationId }) => mutationId !== entry.mutationId), deepFreezeClone(entry)];
    const pending = replaced.filter(({ state }) => state === 'pending');
    const settled = replaced.filter(({ state }) => state !== 'pending').slice(-maxRetainedMutations);
    const mutations = [...settled, ...pending].sort((left, right) => left.mutationId - right.mutationId);
    this.#snapshot = Object.freeze({
      pendingCount: mutations.filter(({ state }) => state === 'pending').length,
      mutations: Object.freeze(mutations)
    });
    for (const listener of Array.from(this.#listeners)) listener();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#snapshot = emptyMutationState;
  }
}

const emptyMutationState: MutationState = Object.freeze({ pendingCount: 0, mutations: Object.freeze([]) });
const maxRetainedMutations = 100;

const identitySnapshot = <Row, Selected>(snapshot: ReactObserverSnapshot<Row>): Selected => snapshot as Selected;
const identityMutationState = <Selected>(state: MutationState): Selected => state as Selected;

const useExternalStoreWithSelector = <Snapshot, Selected>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selected,
  isEqual: (left: Selected, right: Selected) => boolean
): Selected => {
  const selectedRef = useRef<{ readonly hasValue: false } | { readonly hasValue: true; readonly value: Selected }>({ hasValue: false });
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
