import {
  Fragment,
  createElement,
  type ReactElement,
  type ReactNode
} from 'react';
import type { TarstateDiagnostic } from '@tarstate/core';
import type { Db, RelationKeyValue } from '@tarstate/core/db';
import type { Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
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

export function TarstateProvider({ children }: TarstateProviderProps): ReactElement {
  return createElement(Fragment, undefined, children);
}

export function useTarstateStore(): Store {
  return notImplemented();
}

export function useTarstateSnapshot(): TarstateDbSnapshot {
  return notImplemented();
}

export function useDb(): Db {
  return notImplemented();
}

export function useCommit(): TarstateCommit {
  return notImplemented();
}

export function useView<Row>(
  _query: Query<Row>,
  _options?: UseViewOptions
): ViewHookState<Row> {
  return notImplemented();
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
  _queryOrRelation: Query<Row> | RelationRef,
  _keyOrPredicate: unknown,
  _options?: UseViewOptions
): RowHookState<Row> {
  return notImplemented();
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
  _query: Query<Row>,
  _options?: UseViewOptions | UseQuerySelectedOptions<Row, Selected>
): QueryHookState<Row, readonly Row[] | Selected> {
  return notImplemented();
}

function notImplemented(): never {
  throw new Error('@tarstate/react runtime implementation is not available yet');
}
