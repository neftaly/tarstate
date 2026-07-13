import type {
  CommitReceipt,
  JsonValue,
  ObserveRequest,
  ObserverDiagnosticReporter,
  ObserverSnapshot,
  QueryObserver,
  TransactionAttempt,
  TypedPreparedPlan
} from '@tarstate/core';
import type { ReactNode } from 'react';

/** Minimal borrowed database contract consumed by the React adapter. */
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

/** Request/snapshot pair used as the exact server-render snapshot for one query identity. */
export type ServerQueryObservation<Query = unknown, Row = unknown> = {
  readonly request: ObserveRequest<Query>;
  readonly snapshot: ObserverSnapshot<Row>;
};

type MutationIdentity = {
  readonly mutationId: number;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly optimisticError?: OptimisticUpdateError;
};

/** One attempted commit; `state` determines which terminal evidence is present. */
export type MutationEntry = MutationIdentity & (
  | { readonly state: 'pending' }
  | { readonly state: 'settled'; readonly receipt: CommitReceipt }
  | { readonly state: 'failed'; readonly error: { readonly name: string; readonly message: string } }
);

export type OptimisticUpdateError = {
  readonly phase: 'create-overlay' | 'source-basis' | 'applies-to-query' | 'project-rows' | 'projection-result';
  readonly name: string;
  readonly message: string;
};

/** Immutable bounded commit history exposed by `useMutationState`. */
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
  readonly authoritativeSnapshot: ObserverSnapshot<Row>;
  readonly currentRows: readonly Row[];
  readonly currentResultKeys: readonly string[];
  readonly sourceBasis: JsonValue;
  readonly observedBasis: JsonValue;
  readonly rebased: boolean;
};

/** Host-authored UI projection. It grants no write authority and is never a transaction guard. */
export type OptimisticOverlay<Query, Row> = {
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  appliesToQuery?(request: ObserveRequest<Query>): boolean;
  projectRows(input: OptimisticOverlayInput<Query, Row>): OptimisticProjection<Row>;
};

export type CreateOptimisticOverlay<Query, Row> = (attempt: TransactionAttempt) => OptimisticOverlay<Query, Row> | undefined;

export type OptimisticOperationEvidence = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  readonly observedBasis: JsonValue;
  readonly rebased: boolean;
};

/** Authoritative observer evidence plus optional display-only optimistic operations. */
export type ReactObserverSnapshot<Row> = ObserverSnapshot<Row> & {
  readonly optimistic?: { readonly operations: readonly OptimisticOperationEvidence[] };
};

/** Provider inputs; the database remains externally owned. */
export type TarstateProviderProps<Query = unknown, Row = unknown> = {
  readonly database: ObservableDatabase<Query, Row>;
  readonly executeCommit?: (attempt: TransactionAttempt) => Promise<CommitReceipt>;
  readonly createOptimisticOverlay?: CreateOptimisticOverlay<Query, Row>;
  readonly serverQueryObservations?: readonly ServerQueryObservation<Query, Row>[];
  /** Receives contained React subscription and teardown failures. */
  readonly onDiagnostic?: ObserverDiagnosticReporter;
  readonly children?: ReactNode;
};

export type CommitFunction = (attempt: TransactionAttempt) => Promise<CommitReceipt>;

/** Observation identity, selection, and partial-evidence policy for `useQuery`. */
export type QueryHookOptions<
  Row,
  Selected = ReactObserverSnapshot<Row>,
  Parameters extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>
> = {
  readonly parameters?: Parameters;
  /** Preserve a proven lower bound when incomplete inputs prevent an exact result. */
  readonly allowPartial?: boolean;
  readonly selectSnapshot?: (snapshot: ReactObserverSnapshot<Row>) => Selected;
  readonly areSelectionsEqual?: (left: Selected, right: Selected) => boolean;
};

export type RowHookOptions<Row, Parameters extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>> = Omit<QueryHookOptions<Row, Row | undefined, Parameters>, 'selectSnapshot'> & {
  /** Retained exact rows must be requested explicitly while current is unknown. */
  readonly readFrom?: 'current' | 'last-exact';
};

export type MutationStateOptions<Selected> = {
  readonly selectState: (state: MutationState) => Selected;
  readonly areSelectionsEqual?: (left: Selected, right: Selected) => boolean;
};

export type ErasedDatabase = ObservableDatabase<unknown, unknown>;
export type ErasedCreateOptimisticOverlay = CreateOptimisticOverlay<unknown, unknown>;
