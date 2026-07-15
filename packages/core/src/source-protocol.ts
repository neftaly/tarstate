import type { ContentHash } from './artifacts.js';
import type { Issue } from './issues.js';
import type {
  Footprint,
  FootprintRelation,
  LogicalEdit,
  PlannedEditHandling,
  ProjectionResult
} from './logical-edit.js';
import type { SourceBasis, SourceSnapshot } from './source-state.js';

export type {
  Footprint,
  FootprintRelation,
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

export type StorageBinding<Storage, Command, Row = unknown> = {
  readonly id: string;
  readonly declaredReadFootprint: Footprint;
  readonly declaredWriteFootprint: Footprint;
  readonly project: (snapshot: SourceSnapshot<Storage>) => ProjectionResult<Row>;
  readonly plan: (snapshot: SourceSnapshot<Storage>, edits: readonly LogicalEdit[]) => PlanResult<Command>;
};

export type SourceCommitInput<Command> = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly expectedBasis: SourceBasis;
  readonly commands: readonly Command[];
};

export type SourceCommitResult = {
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly beforeBasis?: SourceBasis;
  readonly afterBasis?: SourceBasis;
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
  readonly subscribe: (listener: (change?: { readonly beforeBasis?: SourceBasis; readonly afterBasis: SourceBasis }) => void) => () => void;
  readonly commit: (input: SourceCommitInput<Command>) => Promise<SourceCommitResult>;
  readonly relateFootprints: (left: Footprint, right: Footprint) => FootprintRelation;
  readonly mergeIntents: (plans: readonly PlanResult<Command>[]) => IntentMergeResult<Command>;
  readonly stage: (snapshot: SourceSnapshot<Storage>, commands: readonly Command[]) => { readonly storage: Storage; readonly issues: readonly Issue[] };
  /** Derives exact basis evidence for immutable staged storage without handoff. */
  readonly basisForStagedStorage?: (snapshot: SourceSnapshot<Storage>, stagedStorage: Storage) => SourceBasis;
  readonly queryOutcome?: (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }) => Promise<SourceOutcomeLookup<SourceCommitResult>>;
};

/** Atomic source capability required by prepared generic transaction execution. */
export type StagedBasisAtomicSource<Storage, Command> = AtomicSource<Storage, Command> & {
  readonly basisForStagedStorage: NonNullable<AtomicSource<Storage, Command>['basisForStagedStorage']>;
};
