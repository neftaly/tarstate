import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RelationKeyValue } from '@tarstate/core/db';
import { queryKey } from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import type {
  StoreCommitOptions,
  StoreCommitResult,
  StoreQueryResult,
  StoreView,
  StoreViewSnapshot
} from '@tarstate/core/store';
import { areViewSnapshotsEqual, diagnosticsEqual } from './equality.js';
import { useCommit, useTarstateStore } from './provider.js';
import { isRelationRef, relationKeyMatches, relationKeyQuery } from './relation.js';
import { selectedSnapshotReader, stableSnapshotReader } from './snapshot.js';
import type {
  QueryHookSnapshotState,
  QueryHookState,
  RelationRow,
  RowHookState,
  TarstateCommit,
  TarstateMutationSnapshot,
  TarstateMutationState,
  UseQueryOptions,
  UseQuerySelectedOptions,
  UseTarstateSubscriptionOptions,
  UseTarstateSubscriptionSelectedOptions,
  UseViewOptions,
  ViewHookState
} from './types.js';

const emptyMutationSnapshot: TarstateMutationSnapshot = {
  pending: false,
  error: undefined,
  result: undefined
};

export function useTarstateMutation(): TarstateMutationState {
  const storeCommit = useCommit();
  const mountedRef = useRef(true);
  const sequenceRef = useRef(0);
  const [state, setState] = useState<TarstateMutationSnapshot>(emptyMutationSnapshot);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commit = useCallback((async (inputOrInputs: unknown, options?: StoreCommitOptions) => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    if (mountedRef.current) {
      setState((current) => ({ ...current, pending: true, error: undefined }));
    }

    try {
      const result = await (storeCommit as (input: unknown, options?: StoreCommitOptions) => Promise<StoreCommitResult>)(inputOrInputs, options);
      if (mountedRef.current && sequenceRef.current === sequence) {
        setState({ pending: false, error: undefined, result });
      }
      return result;
    } catch (error) {
      if (mountedRef.current && sequenceRef.current === sequence) {
        setState((current) => ({ ...current, pending: false, error }));
      }
      throw error;
    }
  }) as TarstateCommit, [storeCommit]);

  const reset = useCallback(() => {
    sequenceRef.current += 1;
    if (mountedRef.current) setState(emptyMutationSnapshot);
  }, []);

  return useMemo(() => ({
    commit,
    pending: state.pending,
    error: state.error,
    result: state.result,
    reset
  }), [commit, reset, state.error, state.pending, state.result]);
}

export function useView<Row>(
  query: Query<Row>,
  options: UseViewOptions = {}
): ViewHookState<Row> {
  const view = useStoreView(query, options);
  const subscribe = useCallback((listener: () => void) => view.subscribe(listener), [view]);
  const getSnapshot = useMemo(
    () => stableSnapshotReader(() => view.getSnapshot(), areViewSnapshotsEqual),
    [view]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    void view.refresh();
  }, [view]);

  return useMemo(() => ({
    rows: snapshot.rows,
    diagnostics: snapshot.diagnostics,
    revision: snapshot.revision,
    queryKey: snapshot.queryKey,
    refresh
  }), [snapshot, refresh]);
}

export function useTarstateSubscription<Row>(
  query: Query<Row>,
  options: UseTarstateSubscriptionOptions<Row>
): void;
export function useTarstateSubscription<Row, Selected>(
  query: Query<Row>,
  options: UseTarstateSubscriptionSelectedOptions<Row, Selected>
): void;
export function useTarstateSubscription<Row, Selected>(
  query: Query<Row>,
  options: UseTarstateSubscriptionOptions<Row> | UseTarstateSubscriptionSelectedOptions<Row, Selected>
): void {
  const view = useStoreView(query, options);
  const onChangeRef = useRef(options.onChange);
  onChangeRef.current = options.onChange;
  const selectedOptions = hasSubscriptionSelect(options) ? options : undefined;
  const select = selectedOptions?.select;
  const equality = selectedOptions?.equality;
  const fireImmediately = options.fireImmediately;

  useEffect(() => {
    const read = selectedSnapshotReader(
      () => view.getSnapshot(),
      (snapshot): StoreViewSnapshot<Row> | Selected => select === undefined ? snapshot : select(snapshot),
      areViewSnapshotsEqual,
      (left, right) => equality === undefined ? Object.is(left, right) : equality(left as Selected, right as Selected)
    );
    const notify = (next: ReturnType<typeof read>): void => {
      if (select === undefined) {
        (onChangeRef.current as (snapshot: StoreViewSnapshot<Row>) => void)(next.selected as StoreViewSnapshot<Row>);
        return;
      }

      (onChangeRef.current as (selected: Selected, snapshot: StoreViewSnapshot<Row>) => void)(next.selected as Selected, next.source);
    };
    const initial = read();
    if (fireImmediately === true) notify(initial);

    return view.subscribe(() => {
      const next = read();
      if (next.changed) notify(next);
    });
  }, [equality, fireImmediately, select, view]);
}

export function useRow<Row>(
  query: Query<Row>,
  predicate: (row: Row) => boolean,
  options?: UseViewOptions
): RowHookState<Row>;
export function useRow<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyValue<Relation>,
  options?: UseViewOptions
): RowHookState<RelationRow<Relation>>;
export function useRow<Row>(
  queryOrRelation: Query<Row> | RelationRef,
  keyOrPredicate: unknown,
  options?: UseViewOptions
): RowHookState<Row> {
  const relation = isRelationRef(queryOrRelation) ? queryOrRelation : undefined;
  const query = useMemo(
    () => relation === undefined
      ? queryOrRelation
      : relationKeyQuery(relation, keyOrPredicate as RelationKeyValue<typeof relation>),
    [keyOrPredicate, queryOrRelation, relation]
  );
  const viewState = useView(query as Query<Row>, options);

  return useMemo(() => {
    const row = relation === undefined
      ? viewState.rows.find((item) => (keyOrPredicate as (row: Row) => boolean)(item))
      : viewState.rows.find((item) => relationKeyMatches(relation, item, keyOrPredicate));

    return {
      row,
      diagnostics: viewState.diagnostics,
      queryKey: viewState.queryKey,
      revision: viewState.revision,
      refresh: viewState.refresh
    };
  }, [keyOrPredicate, relation, viewState]);
}

export function useQuery<Row>(
  query: Query<Row>,
  options?: UseViewOptions
): QueryHookState<Row>;
export function useQuery<Row, Selected>(
  query: Query<Row>,
  options: UseQuerySelectedOptions<Row, Selected>
): QueryHookState<Row, Selected>;
export function useQuery<Row, Selected>(
  query: Query<Row>,
  options?: UseViewOptions | UseQuerySelectedOptions<Row, Selected>
): QueryHookState<Row, readonly Row[] | Selected> {
  const view = useStoreView(query, options);
  const select = hasSelect(options) ? options.select : undefined;
  const equality = hasEquality<Row, Selected>(options) ? options.equality : undefined;
  const subscribe = useCallback((listener: () => void) => view.subscribe(listener), [view]);
  const getSnapshot = useMemo(
    () => {
      const selectedEquality = equality as (
        (left: readonly Row[] | Selected, right: readonly Row[] | Selected) => boolean
      ) | undefined;
      const read = selectedSnapshotReader(
        () => view.getSnapshot(),
        (snapshot) => queryHookSnapshot(snapshot, select),
        areViewSnapshotsEqual,
        (left, right) => areQueryHookSnapshotsEqual(left, right, selectedEquality)
      );
      return () => read().selected;
    },
    [equality, select, view]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    void view.refresh();
  }, [view]);

  return useMemo(() => ({
    data: snapshot.data,
    diagnostics: snapshot.diagnostics,
    queryKey: snapshot.queryKey,
    revision: snapshot.revision,
    refresh
  }), [refresh, snapshot]);
}

function useStoreView<Row>(query: Query<Row>, options: UseViewOptions = {}): StoreView<Row> {
  const store = useTarstateStore();
  const resetKey = options.resetKey;
  const canonicalQueryKey = useMemo(() => queryKey(query), [query]);
  return useMemo(() => store.view(query), [store, resetKey, canonicalQueryKey]);
}

function queryHookSnapshot<Row, Selected>(
  snapshot: StoreViewSnapshot<Row>,
  select: ((rows: readonly Row[], result: StoreQueryResult<Row>) => Selected) | undefined
): QueryHookSnapshotState<Row, readonly Row[] | Selected> {
  const result: StoreQueryResult<Row> = {
    rows: snapshot.rows,
    diagnostics: snapshot.diagnostics,
    revision: snapshot.revision
  };
  return {
    data: select === undefined ? snapshot.rows : select(snapshot.rows, result),
    diagnostics: snapshot.diagnostics,
    queryKey: snapshot.queryKey,
    revision: snapshot.revision
  };
}

function areQueryHookSnapshotsEqual<Row, Selected>(
  left: QueryHookSnapshotState<Row, Selected>,
  right: QueryHookSnapshotState<Row, Selected>,
  equality: ((left: Selected, right: Selected) => boolean) | undefined
): boolean {
  return left.queryKey === right.queryKey
    && (equality === undefined ? Object.is(left.data, right.data) : equality(left.data, right.data))
    && diagnosticsEqual(left.diagnostics, right.diagnostics);
}

function hasSelect<Row, Selected>(
  options: UseViewOptions | UseQuerySelectedOptions<Row, Selected> | undefined
): options is UseQuerySelectedOptions<Row, Selected> {
  return options !== undefined && 'select' in options && typeof options.select === 'function';
}

function hasEquality<Row, Selected>(
  options: UseViewOptions | UseQuerySelectedOptions<Row, Selected> | undefined
): options is UseQueryOptions<Row, Selected> & { readonly equality: (left: Selected, right: Selected) => boolean } {
  return options !== undefined && 'equality' in options && typeof options.equality === 'function';
}

function hasSubscriptionSelect<Row, Selected>(
  options: UseTarstateSubscriptionOptions<Row> | UseTarstateSubscriptionSelectedOptions<Row, Selected>
): options is UseTarstateSubscriptionSelectedOptions<Row, Selected> {
  return 'select' in options && typeof options.select === 'function';
}
