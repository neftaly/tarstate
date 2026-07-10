import type { ArtifactRef, ContentHash } from './artifacts.js';
import type { CapabilityRef, Issue } from './issues.js';
import type { SourceBasis } from './maintenance.js';
import type { SourceSnapshot } from './database.js';
import type { JsonValue } from './value.js';

export type Footprint = JsonValue;
export type FootprintRelation = 'disjoint' | 'equal' | 'contains' | 'contained_by' | 'overlaps' | 'unknown';

export type LogicalEdit = {
  readonly relationId: string;
  readonly key: JsonValue;
  readonly locator: JsonValue;
  readonly fields: Readonly<Record<string, JsonValue>>;
};

export type StorageIntent<Command> = {
  readonly footprint: Footprint;
  readonly command: Command;
};

export type ProjectionResult<Row = unknown> = {
  readonly rows: readonly Row[];
  readonly completeness: 'exact' | 'unknown';
  readonly issues: readonly Issue[];
};

export type PlanResult<Command> = {
  readonly readFootprint: Footprint;
  readonly writeFootprint: Footprint;
  readonly intents: readonly StorageIntent<Command>[];
  readonly issues: readonly Issue[];
};

export type IntentMergeResult<Command> =
  | { readonly outcome: 'merged'; readonly commands: readonly Command[] }
  | { readonly outcome: 'conflict' | 'unknown'; readonly issues: readonly Issue[] };

export type StorageBinding<Storage, Command, Delta = never, Row = unknown> = {
  readonly id: string;
  readonly declaredReadFootprint: Footprint;
  readonly declaredWriteFootprint: Footprint;
  readonly project: (snapshot: SourceSnapshot<Storage>) => ProjectionResult<Row>;
  readonly plan: (snapshot: SourceSnapshot<Storage>, edits: readonly LogicalEdit[]) => PlanResult<Command>;
  readonly updateProjection?: (previous: ProjectionResult<Row>, snapshot: SourceSnapshot<Storage>, delta: Delta) => ProjectionResult<Row>;
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

export type AtomicSource<Storage, Command, Delta = never> = {
  readonly sourceId: string;
  readonly snapshot: () => SourceSnapshot<Storage>;
  readonly subscribe: (listener: (change?: { readonly beforeBasis?: SourceBasis; readonly afterBasis: SourceBasis; readonly delta?: Delta }) => void) => () => void;
  readonly commit: (input: SourceCommitInput<Command>) => Promise<SourceCommitResult>;
  readonly relateFootprints: (left: Footprint, right: Footprint) => FootprintRelation;
  readonly mergeIntents: (plans: readonly PlanResult<Command>[]) => IntentMergeResult<Command>;
  readonly stage: (snapshot: SourceSnapshot<Storage>, commands: readonly Command[]) => { readonly storage: Storage; readonly issues: readonly Issue[] };
  readonly queryOutcome?: (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }) => Promise<SourceOutcomeLookup<SourceCommitResult>>;
};

export type Attachment<Storage = unknown, Command = unknown, Delta = never> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: AtomicSource<Storage, Command, Delta>;
  readonly storageBindings: readonly StorageBinding<Storage, Command, Delta>[];
  readonly schemaViews: readonly ArtifactRef[];
  readonly authorityScope: string;
  readonly capabilities?: readonly CapabilityRef[];
};
