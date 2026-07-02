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
import { from } from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import { createStore } from '@tarstate/core/store';
import type {
  Store,
  StoreQueryResult,
  StoreSeedInput,
  StoreSnapshot,
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

type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;
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

export function useView<Row>(
  query: Query<Row>,
  options: UseViewOptions = {}
): ViewHookState<Row> {
  const store = useTarstateStore();
  const resetKey = options.resetKey;
  const view = useMemo(() => store.view(query), [store, resetKey]);
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
  const query = relation === undefined
    ? queryOrRelation
    : from(relation);
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
  const viewState = useView(query, options);
  const select = hasSelect(options) ? options.select : undefined;
  const result = useMemo<StoreQueryResult<Row>>(() => ({
    rows: viewState.rows,
    diagnostics: viewState.diagnostics,
    revision: viewState.revision
  }), [viewState.diagnostics, viewState.revision, viewState.rows]);
  const data = useMemo(() => (
    select === undefined ? viewState.rows : select(viewState.rows, result)
  ), [result, select, viewState.rows]);

  return useMemo(() => ({
    data,
    diagnostics: viewState.diagnostics,
    queryKey: viewState.queryKey,
    revision: viewState.revision,
    refresh: viewState.refresh
  }), [data, viewState.diagnostics, viewState.queryKey, viewState.refresh, viewState.revision]);
}

function createOwnedStore(initialDb: TarstateDbInput | undefined, resetKey: ResetKey): OwnedStoreState {
  return {
    store: initialDb === undefined ? createStore() : createStore(initialDb),
    resetKey
  };
}

function closeOwnedStore(ownedStore: OwnedStoreState | undefined): void {
  ownedStore?.store.close();
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

function isRelationRef(input: unknown): input is RelationRef {
  return typeof input === 'object'
    && input !== null
    && 'kind' in input
    && input.kind === 'relation';
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
