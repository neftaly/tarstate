import type { ArtifactRef, ContentHash } from './artifacts.js';
import type { CapabilityRef, Issue } from './issues.js';
import type { SourceBasis } from './maintenance.js';
import type { SourceSnapshot } from './database.js';
import type { JsonValue } from './value.js';

export type Footprint = JsonValue;
export type FootprintRelation = 'disjoint' | 'equal' | 'contains' | 'contained_by' | 'overlaps' | 'unknown';

export type LogicalEditTarget = {
  readonly relationId: string;
  readonly key: JsonValue;
  readonly locator: JsonValue;
};

type LogicalFieldsEdit = LogicalEditTarget & {
  readonly fields: Readonly<Record<string, JsonValue>>;
};

export type LogicalReplaceFieldsEdit = LogicalFieldsEdit & { readonly kind: 'replace-fields' };
export type LogicalReplaceRowEdit = LogicalFieldsEdit & { readonly kind: 'replace-row' };

export type LogicalSemanticEdit =
  | LogicalReplaceFieldsEdit
  | LogicalReplaceRowEdit
  | {
      readonly kind: 'insert';
      readonly relationId: string;
      readonly key: JsonValue;
      readonly fields: Readonly<Record<string, JsonValue>>;
    }
  | (LogicalEditTarget & { readonly kind: 'delete' })
  | (LogicalEditTarget & { readonly kind: 'counter-increment'; readonly field: string; readonly by: number })
  | (LogicalEditTarget & { readonly kind: 'text-splice'; readonly field: string; readonly index: number; readonly deleteCount: number; readonly value: string })
  | (LogicalEditTarget & { readonly kind: 'list-splice'; readonly field: string; readonly index: number; readonly deleteCount: number; readonly values: readonly JsonValue[] })
  | (LogicalEditTarget & { readonly kind: 'conflict-resolve'; readonly field?: string; readonly observedChangeHashes: readonly string[]; readonly selectedChangeHash: string })
  | (LogicalEditTarget & { readonly kind: 'rekey'; readonly newKey: JsonValue })
  | (LogicalEditTarget & {
      readonly kind: 'move-relocate';
      readonly destination: { readonly relationId: string; readonly key: JsonValue; readonly locator?: JsonValue };
      readonly mode: 'identity-preserving' | 'copy-relocate';
    });

export type LogicalEdit = LogicalSemanticEdit;

export type StorageIntent<Command> = {
  readonly footprint: Footprint;
  readonly command: Command;
};

export type ProjectionResult<Row = unknown> = {
  readonly rows: readonly Row[];
  readonly completeness: 'exact' | 'unknown';
  readonly issues: readonly Issue[];
};

export type PlannedEditHandling = {
  readonly editIndex: number;
  /** Cooperative handling permits multiple bindings to contribute intents for one edit. */
  readonly mode: 'exclusive' | 'cooperative';
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

export type Attachment<Storage = unknown, Command = unknown> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: AtomicSource<Storage, Command>;
  readonly storageBindings: readonly StorageBinding<Storage, Command>[];
  readonly schemaViews: readonly ArtifactRef[];
  readonly authorityScope: string;
  readonly capabilities?: readonly CapabilityRef[];
};
