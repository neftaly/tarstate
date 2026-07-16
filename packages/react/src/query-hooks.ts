import type { JsonValue } from '@tarstate/core';
import {
  queryObservationKey,
  type ObserveRequest,
  type ObserverSnapshot
} from '@tarstate/core/database/observer';
import type { PreparedPlan } from '@tarstate/core/query/model';
import { useMemo } from 'react';
import type {
  QueryHookOptions,
  ReactObserverSnapshot,
  ReactPreparedPlan,
  RowHookOptions
} from './contracts.js';
import { useRuntime } from './context.js';
import { queryStore } from './query-store.js';
import { useExternalStoreWithSelector } from './use-external-store-with-selector.js';

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
  const request = useMemo(
    () => queryRequest(plan, options),
    [plan, options.parameters, options.allowPartial]
  );
  const key = useMemo(
    () => queryObservationKey(runtime.database, request),
    [runtime.database, request]
  );
  const baseStore = queryStore<Query, Row>(runtime.database, request, key, runtime.onDiagnostic);
  const store = runtime.overlayStore.view<Query, Row>(baseStore, request, key);
  const serverSnapshot = runtime.serverQuerySnapshots.get(key) as ObserverSnapshot<Row> | undefined;
  const getServerSnapshot = useMemo(
    () => serverSnapshot === undefined ? undefined : () => serverSnapshot,
    [serverSnapshot]
  );
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
  return useQuery(plan, {
    ...options,
    selectSnapshot,
    areSelectionsEqual: options.areSelectionsEqual ?? Object.is
  });
};

const resultKeyIndexes = new WeakMap<readonly string[], ReadonlyMap<string, number>>();

const resultKeyIndex = (keys: readonly string[]): ReadonlyMap<string, number> => {
  const cached = resultKeyIndexes.get(keys);
  if (cached !== undefined) return cached;
  const index = new Map<string, number>();
  for (let position = 0; position < keys.length; position += 1) {
    index.set(keys[position] as string, position);
  }
  resultKeyIndexes.set(keys, index);
  return index;
};

const queryRequest = <Query, Parameters extends Readonly<Record<string, JsonValue>>>(
  plan: PreparedPlan<Query>,
  options: { readonly parameters?: Parameters; readonly allowPartial?: boolean }
): ObserveRequest<Query> => ({
  plan,
  ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
  ...(options.allowPartial === undefined ? {} : { allowPartial: options.allowPartial })
});

const identitySnapshot = <Row, Selected>(snapshot: ReactObserverSnapshot<Row>): Selected =>
  snapshot as Selected;
