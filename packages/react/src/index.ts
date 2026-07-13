import {
  queryObservationKey,
  type JsonValue,
  type ObserveRequest,
  type ObserverSnapshot,
  type PreparedPlan
} from '@tarstate/core';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode
} from 'react';
import type {
  CommitFunction,
  ErasedCreateOptimisticOverlay,
  ErasedDatabase,
  MutationState,
  MutationStateOptions,
  ObservableDatabase,
  QueryHookOptions,
  ReactObserverSnapshot,
  ReactPreparedPlan,
  RowHookOptions,
  ServerQueryObservation,
  TarstateProviderProps
} from './contracts.js';
import { queryStore } from './query-store.js';
import {
  createRuntime,
  normalizeServerQueryObservations,
  type Runtime
} from './runtime.js';
import { useExternalStoreWithSelector } from './use-external-store-with-selector.js';

export type {
  CommitFunction,
  CreateOptimisticOverlay,
  MutationEntry,
  MutationState,
  MutationStateOptions,
  ObservableDatabase,
  OptimisticOperationEvidence,
  OptimisticOverlay,
  OptimisticOverlayInput,
  OptimisticProjection,
  OptimisticUpdateError,
  QueryHookOptions,
  ReactObserverSnapshot,
  ReactPreparedPlan,
  RowHookOptions,
  ServerQueryObservation,
  TarstateProviderProps
} from './contracts.js';

const TarstateContext = createContext<Runtime | undefined>(undefined);
type CommitActions = {
  readonly executeCommit: CommitFunction | undefined;
  readonly createOptimisticOverlay: ErasedCreateOptimisticOverlay | undefined;
};
const CommitActionsContext = createContext<CommitActions | undefined>(undefined);
const emptyServerQueryObservations: readonly ServerQueryObservation[] = Object.freeze([]);

/** Borrows a database. Unmounting never closes the database or its sources. */
export const TarstateProvider = <Query, Row>({ database, executeCommit, createOptimisticOverlay, serverQueryObservations = emptyServerQueryObservations as readonly ServerQueryObservation<Query, Row>[], onDiagnostic, children }: TarstateProviderProps<Query, Row>): ReactNode => {
  const runtime = useMemo<Runtime>(() => createRuntime(
    database as unknown as ErasedDatabase,
    normalizeServerQueryObservations(database, serverQueryObservations),
    onDiagnostic
  ), [database, onDiagnostic, serverQueryObservations]);
  const actions = useMemo(() => ({ executeCommit, createOptimisticOverlay: createOptimisticOverlay as ErasedCreateOptimisticOverlay | undefined }), [executeCommit, createOptimisticOverlay]);
  useEffect(() => runtime.acquire(), [runtime]);
  return createElement(TarstateContext.Provider, { value: runtime }, createElement(CommitActionsContext.Provider, { value: actions }, children));
};

/** Returns the borrowed database without asserting an application-selected query or row type. */
export const useDatabase = (): ObservableDatabase => useRuntime().database;

/** Observes a prepared plan and infers its exact parameter, row, and selected-result types. */
export function useQuery<Query, Row, Parameters extends Readonly<Record<string, JsonValue>>, Selected>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  options: QueryHookOptions<Row, Selected, NoInfer<Parameters>> & { readonly selectSnapshot: (snapshot: ReactObserverSnapshot<Row>) => Selected }
): Selected;
export function useQuery<Query, Row, Parameters extends Readonly<Record<string, JsonValue>>>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  options?: Omit<QueryHookOptions<Row, ReactObserverSnapshot<Row>, NoInfer<Parameters>>, 'selectSnapshot'>
): ReactObserverSnapshot<Row>;
export function useQuery<Query, Row, Parameters extends Readonly<Record<string, JsonValue>>, Selected = ReactObserverSnapshot<Row>>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  options: QueryHookOptions<Row, Selected, Parameters> = {}
): Selected {
  const runtime = useRuntime();
  const request = useMemo(() => queryRequest(plan, options), [plan, options.parameters, options.allowPartial]);
  const key = useMemo(() => queryObservationKey(runtime.database, request), [runtime.database, request]);
  const baseStore = queryStore<Query, Row>(runtime.database, request, key, runtime.onDiagnostic);
  const store = runtime.overlayStore.view<Query, Row>(baseStore, request, key);
  const serverSnapshot = runtime.serverQuerySnapshots.get(key) as ObserverSnapshot<Row> | undefined;
  const getServerSnapshot = useMemo(() => serverSnapshot === undefined ? undefined : () => serverSnapshot, [serverSnapshot]);
  const selectSnapshot = options.selectSnapshot ?? identitySnapshot<Row, Selected>;
  return useExternalStoreWithSelector(
    store.subscribe,
    store.getSnapshot,
    getServerSnapshot,
    selectSnapshot,
    options.areSelectionsEqual ?? Object.is
  );
}

/** Selects one occurrence by opaque result key without subscribing to unrelated row changes. */
export const useRow = <Query, Row, Parameters extends Readonly<Record<string, JsonValue>>>(
  plan: ReactPreparedPlan<Query, Row, Parameters>,
  resultKey: string,
  options: RowHookOptions<Row, NoInfer<Parameters>> = {}
): Row | undefined => {
  const selectSnapshot = useMemo(() => (snapshot: ObserverSnapshot<Row>): Row | undefined => {
    if (snapshot.state === 'closed') return undefined;
    const result = options.readFrom === 'last-exact' ? snapshot.lastExact : snapshot.current;
    if (result === undefined) return undefined;
    const index = resultKeyIndex(result.resultKeys).get(resultKey) ?? -1;
    return index < 0 ? undefined : result.rows[index];
  }, [options.readFrom, resultKey]);
  return useQuery(plan, { ...options, selectSnapshot, areSelectionsEqual: options.areSelectionsEqual ?? Object.is });
};

const resultKeyIndexes = new WeakMap<readonly string[], ReadonlyMap<string, number>>();
const resultKeyIndex = (keys: readonly string[]): ReadonlyMap<string, number> => {
  const cached = resultKeyIndexes.get(keys);
  if (cached !== undefined) return cached;
  const index = new Map(keys.map((key, position) => [key, position]));
  resultKeyIndexes.set(keys, index);
  return index;
};

/** Returns the current provider commit action without replacing the query runtime. */
export const useCommit = (): CommitFunction => {
  const store = useRuntime().mutationStore;
  const actions = useContext(CommitActionsContext);
  const commit = useCallback((attempt: Parameters<CommitFunction>[0]) => store.commit(attempt, actions?.executeCommit, actions?.createOptimisticOverlay), [actions?.createOptimisticOverlay, actions?.executeCommit, store]);
  if (actions === undefined) throw new Error('Tarstate hooks require a TarstateProvider');
  return commit;
};

/** Observes immutable bounded mutation history, optionally through a render-suppressing selector. */
export function useMutationState(): MutationState;
export function useMutationState<Selected>(options: MutationStateOptions<Selected>): Selected;
export function useMutationState<Selected = MutationState>(options?: MutationStateOptions<Selected>): Selected {
  const store = useRuntime().mutationStore;
  const selectState = options?.selectState ?? identityMutationState<Selected>;
  return useExternalStoreWithSelector(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
    selectState,
    options?.areSelectionsEqual ?? Object.is
  );
}

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

const identitySnapshot = <Row, Selected>(snapshot: ReactObserverSnapshot<Row>): Selected => snapshot as Selected;
const identityMutationState = <Selected>(state: MutationState): Selected => state as Selected;
