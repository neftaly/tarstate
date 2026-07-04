import type { ReactNode } from 'react';
import type { TarstateDiagnostic } from '@tarstate/core';
import type { RelationRef } from '@tarstate/core/schema';
import type {
  Store,
  StoreCommitResult,
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
  readonly equality?: (left: Selected, right: Selected) => boolean;
};

export type UseQuerySelectedOptions<Row, Selected> = UseQueryOptions<Row, Selected> & {
  readonly select: (rows: readonly Row[], result: StoreQueryResult<Row>) => Selected;
};

export type UseTarstateSubscriptionOptions<Row> = UseViewOptions & {
  readonly onChange: (snapshot: StoreViewSnapshot<Row>) => void;
  readonly fireImmediately?: boolean;
};

export type UseTarstateSubscriptionSelectedOptions<Row, Selected> = UseViewOptions & {
  readonly select: (snapshot: StoreViewSnapshot<Row>) => Selected;
  readonly onChange: (selected: Selected, snapshot: StoreViewSnapshot<Row>) => void;
  readonly equality?: (left: Selected, right: Selected) => boolean;
  readonly fireImmediately?: boolean;
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

export type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;
export type QueryHookSnapshotState<Row, Selected> = Omit<QueryHookState<Row, Selected>, 'refresh'>;
export type TarstateMutationSnapshot = Pick<TarstateMutationState, 'pending' | 'error' | 'result'>;
export type ResetKey = string | number | undefined;
export type OwnedStoreState = {
  readonly store: Store;
  readonly resetKey: ResetKey;
};
