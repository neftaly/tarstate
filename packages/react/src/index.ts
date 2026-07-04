import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode
} from 'react';
import type { TarstateDiagnostic } from '@tarstate/core';
import type { Db, RelationKeyValue } from '@tarstate/core/db';
import { from, lookup as lookupQuery, queryKey } from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import { createStore } from '@tarstate/core/store';
import type {
  Store,
  StoreCommitOptions,
  StoreCommitResult,
  StoreQueryResult,
  StoreSeedInput,
  StoreSnapshot,
  StoreView,
  StoreViewSnapshot
} from '@tarstate/core/store';

export type TarstateReactDiagnostic = TarstateDiagnostic;

export type TarstateDbInput = StoreSeedInput;
export type TarstateDbSnapshot = StoreSnapshot;
export type TarstateCommit = Store['commit'];

export type TarstateProviderProps = {
  readonly store?: Store;
  readonly initialDb?: TarstateDbInput;
  readonly resetKey?: string | number;
  readonly children?: ReactNode;
};

export type UseViewOptions = {
  readonly resetKey?: string | number;
};

export type UseQueryOptions<Row, Selected = readonly Row[]> = UseViewOptions & {
  readonly select?: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
  readonly equality?: (left: Selected, right: Selected) => boolean;
};

export type UseQuerySelectedOptions<Row, Selected> = UseQueryOptions<Row, Selected> & {
  readonly select: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

type ViewHookSnapshotState<Row> = Pick<StoreViewSnapshot<Row>, 'rows' | 'diagnostics' | 'revision' | 'queryKey'>;

export type ViewHookState<Row> = ViewHookSnapshotState<Row> & {
  readonly refresh: () => void;
};

export type QueryHookState<Row, Selected = readonly Row[]> = {
  readonly data: Selected;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
};

export type RowHookState<Row> = {
  readonly row: Row | undefined;
  readonly diagnostics: readonly TarstateReactDiagnostic[];
  readonly queryKey: string;
  readonly revision: number;
  readonly refresh: () => void;
};

export type TarstateMutationState = {
  readonly commit: TarstateCommit;
  readonly pending: boolean;
  readonly error: unknown;
  readonly result: StoreCommitResult | undefined;
  readonly reset: () => void;
};

type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;
type QueryHookSnapshotState<Row, Selected> = Omit<QueryHookState<Row, Selected>, 'refresh'>;
type TarstateMutationSnapshot = Pick<TarstateMutationState, 'pending' | 'error' | 'result'>;
type ResetKey = string | number | undefined;
type OwnedStoreState = {
  readonly store: Store;
  readonly resetKey: ResetKey;
};

const TarstateContext = createContext<Store | undefined>(undefined);

export function TarstateProvider({ store, initialDb, resetKey, children }: TarstateProviderProps): ReactElement {
  const initialDbRef = useRef<TarstateDbInput | undefined>(initialDb);
  initialDbRef.current = initialDb;

  const ownedStoreRef = useRef<OwnedStoreState | undefined>(undefined);
  const [ownedStoreState, setOwnedStoreState] = useState<OwnedStoreState | undefined>(() => {
    if (store !== undefined) return undefined;
    const ownedStore = createOwnedStore(initialDb, resetKey);
    ownedStoreRef.current = ownedStore;
    return ownedStore;
  });

  useEffect(() => {
    if (store !== undefined) {
      closeOwnedStore(ownedStoreRef.current);
      ownedStoreRef.current = undefined;
      setOwnedStoreState(undefined);
      return undefined;
    }

    const current = ownedStoreRef.current;
    if (current === undefined || current.resetKey !== resetKey) {
      const next = createOwnedStore(initialDbRef.current, resetKey);
      closeOwnedStore(current);
      ownedStoreRef.current = next;
      setOwnedStoreState(next);
    }

    return () => {
      closeOwnedStore(ownedStoreRef.current);
      ownedStoreRef.current = undefined;
    };
  }, [store, resetKey]);

  const activeStore = store ?? ownedStoreState?.store;
  if (activeStore === undefined) return createElement(Fragment);

  return createElement(TarstateContext.Provider, { value: activeStore }, children);
}

export function useTarstateStore(): Store {
  const store = useContext(TarstateContext);
  if (store === undefined) {
    throw new Error('@tarstate/react hooks must be used within a TarstateProvider');
  }
  return store;
}

export function useTarstateSnapshot(): TarstateDbSnapshot {
  const store = useTarstateStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useMemo(
    () => stableSnapshotReader(() => store.getSnapshot(), areStoreSnapshotsEqual),
    [store]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDb(): Db {
  return useTarstateSnapshot().db;
}

export function useCommit(): TarstateCommit {
  return useTarstateStore().commit;
}

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
      : relationKeyQuery(relation, keyOrPredicate),
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
    () => queryHookSnapshotReader(view, select, equality),
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

const emptyMutationSnapshot: TarstateMutationSnapshot = {
  pending: false,
  error: undefined,
  result: undefined
};

function createOwnedStore(initialDb: TarstateDbInput | undefined, resetKey: ResetKey): OwnedStoreState {
  return {
    store: initialDb === undefined ? createStore() : createStore(initialDb),
    resetKey
  };
}

function closeOwnedStore(ownedStore: OwnedStoreState | undefined): void {
  ownedStore?.store.close();
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

function queryHookSnapshotReader<Row, Selected>(
  view: StoreView<Row>,
  select: ((rows: readonly Row[], result: StoreQueryResult<Row>) => Selected) | undefined,
  equality: ((left: Selected, right: Selected) => boolean) | undefined
): () => QueryHookSnapshotState<Row, readonly Row[] | Selected> {
  let currentViewSnapshot: StoreViewSnapshot<Row> | undefined;
  let current: QueryHookSnapshotState<Row, readonly Row[] | Selected> | undefined;
  const selectedEquality = equality as ((left: readonly Row[] | Selected, right: readonly Row[] | Selected) => boolean) | undefined;

  return () => {
    const viewSnapshot = view.getSnapshot();
    if (current !== undefined && currentViewSnapshot === viewSnapshot) return current;
    if (
      current !== undefined
      && currentViewSnapshot !== undefined
      && areViewSnapshotsEqual(currentViewSnapshot, viewSnapshot)
    ) {
      currentViewSnapshot = viewSnapshot;
      return current;
    }

    const next = queryHookSnapshot(viewSnapshot, select);
    if (current !== undefined && areQueryHookSnapshotsEqual(current, next, selectedEquality)) {
      currentViewSnapshot = viewSnapshot;
      return current;
    }

    currentViewSnapshot = viewSnapshot;
    current = next;
    return current;
  };
}

function areQueryHookSnapshotsEqual<Row, Selected>(
  left: QueryHookSnapshotState<Row, Selected>,
  right: QueryHookSnapshotState<Row, Selected>,
  equality: ((left: Selected, right: Selected) => boolean) | undefined
): boolean {
  return left.queryKey === right.queryKey
    && selectedDataEqual(left.data, right.data, equality)
    && diagnosticsEqual(left.diagnostics, right.diagnostics);
}

function selectedDataEqual<Selected>(
  left: Selected,
  right: Selected,
  equality: ((left: Selected, right: Selected) => boolean) | undefined
): boolean {
  return equality === undefined ? Object.is(left, right) : equality(left, right);
}

function stableSnapshotReader<Snapshot>(
  readSnapshot: () => Snapshot,
  areEqual: (left: Snapshot, right: Snapshot) => boolean
): () => Snapshot {
  let current: Snapshot;
  let hasCurrent = false;

  return () => {
    const next = readSnapshot();
    if (hasCurrent && areEqual(current, next)) return current;
    current = next;
    hasCurrent = true;
    return current;
  };
}

function areStoreSnapshotsEqual(left: StoreSnapshot, right: StoreSnapshot): boolean {
  return left.revision === right.revision
    && Object.is(left.db, right.db)
    && Object.is(left.version, right.version)
    && diagnosticsEqual(left.diagnostics, right.diagnostics);
}

function areViewSnapshotsEqual<Row>(left: StoreViewSnapshot<Row>, right: StoreViewSnapshot<Row>): boolean {
  return left.revision === right.revision
    && left.queryKey === right.queryKey
    && Object.is(left.version, right.version)
    && readonlyArraysEqual(left.rows, right.rows, Object.is)
    && diagnosticsEqual(left.diagnostics, right.diagnostics);
}

function diagnosticsEqual(
  left: readonly TarstateReactDiagnostic[],
  right: readonly TarstateReactDiagnostic[]
): boolean {
  return readonlyArraysEqual(left, right, diagnosticEqual);
}

function diagnosticEqual(left: TarstateReactDiagnostic, right: TarstateReactDiagnostic): boolean {
  return left.code === right.code
    && left.severity === right.severity
    && left.message === right.message
    && left.relation === right.relation
    && left.field === right.field
    && left.surface === right.surface
    && Object.is(left.detail, right.detail);
}

function readonlyArraysEqual<Item>(
  left: readonly Item[],
  right: readonly Item[],
  itemEqual: (left: Item, right: Item) => boolean
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (!itemEqual(left[index] as Item, right[index] as Item)) return false;
  }

  return true;
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

function isRelationRef(input: unknown): input is RelationRef {
  return typeof input === 'object'
    && input !== null
    && 'kind' in input
    && input.kind === 'relation';
}

function relationKeyQuery<Relation extends RelationRef>(
  relation: Relation,
  key: unknown
): Query<RelationRow<Relation>> {
  return typeof relation.key === 'string' && isQueryKeyValue(key)
    ? lookupQuery(
      relation as RelationRef<Record<string, unknown>, string>,
      relation.key,
      key
    ) as Query<RelationRow<Relation>>
    : from(relation) as Query<RelationRow<Relation>>;
}

function isQueryKeyValue(input: unknown): boolean {
  if (input === undefined || input === null || typeof input === 'string' || typeof input === 'boolean') return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (typeof input === 'function' || typeof input === 'bigint' || typeof input === 'symbol') return false;
  if (Array.isArray(input)) return input.every(isQueryKeyValue);
  if (!isPlainRecord(input)) return false;
  return Object.values(input).every(isQueryKeyValue);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function relationKeyMatches<Row>(relation: RelationRef, row: Row, key: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const rowRecord = row as Record<string, unknown>;
  const relationKey = relation.key;

  if (typeof relationKey !== 'string') {
    return Array.isArray(key)
      && relationKey.length === key.length
      && relationKey.every((fieldName, index) => Object.is(rowRecord[fieldName], key[index]));
  }

  return Object.is(rowRecord[relationKey], key);
}
