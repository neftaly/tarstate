import type { ContentHash } from './artifacts.js';
import type { Issue } from './issues.js';
import type {
  Footprint,
  FootprintRelation,
  GeneratedLogicalKey,
  LogicalEdit,
  PlannedEditHandling,
  ProjectionResult
} from './logical-edit.js';
import type { SourceBasis, SourceSnapshot } from './source-state.js';

export type {
  Footprint,
  FootprintRelation,
  GeneratedLogicalKey,
  LogicalEdit,
  LogicalEditTarget,
  LogicalReplaceFieldsEdit,
  LogicalReplaceRowEdit,
  LogicalSemanticEdit,
  PlannedEditHandling,
  ProjectionResult,
  WritableLogicalRow,
  WritableLogicalState
} from './logical-edit.js';
export type { SourceBasis, SourceSnapshot } from './source-state.js';

export type StorageIntent<Command> = {
  readonly footprint: Footprint;
  readonly command: Command;
};

export type PlanResult<Command> = {
  /** Explicit evidence that this binding handled specific indexes in the supplied edit array. */
  readonly handledEdits: readonly PlannedEditHandling[];
  readonly readFootprint: Footprint;
  readonly writeFootprint: Footprint;
  readonly intents: readonly StorageIntent<Command>[];
  readonly issues: readonly Issue[];
};

export type IntentMergeResult<Command> =
  | { readonly outcome: 'merged'; readonly commands: readonly Command[] }
  | { readonly outcome: 'conflict' | 'unknown'; readonly issues: readonly Issue[] };

export type BindingFieldWriteCapabilities = {
  readonly replace?: true;
  readonly textSplice?: {
    readonly indexUnit: 'utf16-code-unit';
    readonly reconciliation: 'captured-basis';
  };
};

/** Concrete operations one binding can preserve and lower for a relation. */
export type BindingRelationWriteCapabilities = {
  readonly relationId: string;
  readonly insert?: true;
  readonly delete?: true;
  readonly generatedKeyInsert?: true;
  readonly fields: Readonly<Record<string, BindingFieldWriteCapabilities>>;
};

export type StorageBinding<Storage, Command, Row = unknown> = {
  readonly id: string;
  /** Relations this binding can project and handle. Omission preserves compatibility but disables relation routing. */
  readonly relationIds?: readonly string[];
  readonly declaredReadFootprint: Footprint;
  readonly declaredWriteFootprint: Footprint;
  /** Stable implementation evidence used by attachment-scoped authoring. */
  readonly writeCapabilities: ReadonlyMap<string, BindingRelationWriteCapabilities>;
  /** A relation filter permits callers to refresh only affected logical projections. */
  readonly project: (
    snapshot: SourceSnapshot<Storage>,
    relationIds?: ReadonlySet<string>,
    fieldsByRelation?: ReadonlyMap<string, ReadonlySet<string>>
  ) => ProjectionResult<Row>;
  readonly plan: (snapshot: SourceSnapshot<Storage>, edits: readonly LogicalEdit[]) => PlanResult<Command>;
};

export type SourceCommitInput<Command> = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly expectedBasis: SourceBasis;
  readonly commands: readonly Command[];
};

export type ReconciledSourceCommitInput<Storage> = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly expectedBasis: SourceBasis;
  /** Exact source-native candidate already reconciled and validated by core. */
  readonly candidate: Storage;
};

export type SourceCommitResult = {
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly beforeBasis?: SourceBasis;
  readonly afterBasis?: SourceBasis;
  readonly generatedKeys?: readonly GeneratedLogicalKey[];
  readonly issues: readonly Issue[];
};

export type SourceOutcomeLookup<Result> =
  | { readonly status: 'known'; readonly result: Result }
  | { readonly status: 'not_seen' }
  | { readonly status: 'ambiguous' | 'expired' }
  | { readonly status: 'unavailable'; readonly issues: readonly Issue[] };

export type AtomicSource<Storage, Command> = {
  readonly sourceId: string;
  readonly snapshot: () => SourceSnapshot<Storage>;
  /** Retains one source-local historical view when the source can prove it. */
  readonly snapshotAt?: (basis: SourceBasis) => SourceSnapshot<Storage>;
  readonly subscribe: (listener: (change?: { readonly beforeBasis?: SourceBasis; readonly afterBasis: SourceBasis }) => void) => () => void;
  readonly commit: (input: SourceCommitInput<Command>) => Promise<SourceCommitResult>;
  readonly relateFootprints: (left: Footprint, right: Footprint) => FootprintRelation;
  readonly mergeIntents: (plans: readonly PlanResult<Command>[]) => IntentMergeResult<Command>;
  readonly stage: (snapshot: SourceSnapshot<Storage>, commands: readonly Command[]) => { readonly storage: Storage; readonly issues: readonly Issue[] };
  /** Creates an unpublished causal branch when the source can preserve one across commits. */
  readonly createPrivateBranch?: (snapshot: SourceSnapshot<Storage>) => Storage;
  /** Builds a non-published candidate by applying captured commands at commandBasis to snapshot. */
  readonly reconcile?: (
    snapshot: SourceSnapshot<Storage>,
    commandBasis: SourceBasis,
    commands: readonly Command[],
    /** Prior unpublished candidate from the same intent after a publication race. */
    priorCandidate?: Storage
  ) => { readonly storage: Storage; readonly issues: readonly Issue[] };
  /** Conditionally publishes the exact candidate returned by reconcile. */
  readonly commitReconciled?: (input: ReconciledSourceCommitInput<Storage>) => Promise<SourceCommitResult>;
  /** Derives exact basis evidence for immutable staged storage without handoff. */
  readonly basisForStagedStorage?: (snapshot: SourceSnapshot<Storage>, stagedStorage: Storage) => SourceBasis;
  readonly queryOutcome?: (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }) => Promise<SourceOutcomeLookup<SourceCommitResult>>;
};

/** Atomic source capability required by prepared generic transaction execution. */
export type StagedBasisAtomicSource<Storage, Command> = AtomicSource<Storage, Command> & {
  readonly basisForStagedStorage: NonNullable<AtomicSource<Storage, Command>['basisForStagedStorage']>;
};
