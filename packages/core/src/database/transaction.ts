import type { SchemaBody } from '../schema.js';
import type { LiteralRelation, SchemaKey, SchemaRow } from '../schema-authoring.js';
import type { CommitReceipt, SimulationReceipt } from '../transaction.js';
import type { Issue } from '../issues.js';
import type { JsonValue } from '../value.js';
import type { SourceBasis } from '../source-state.js';

type RelationKeyField<
  Body extends SchemaBody,
  Name extends Extract<keyof Body['relations'], string>
> = Body['relations'][Name]['key'][number];

type StringField<
  Body extends SchemaBody,
  Name extends Extract<keyof Body['relations'], string>
> = {
  [Field in Extract<keyof SchemaRow<Body, Name>, string>]:
    Exclude<SchemaRow<Body, Name>[Field], undefined> extends string ? Field : never
}[Extract<keyof SchemaRow<Body, Name>, string>];

export type RelationKey<
  Body extends SchemaBody,
  Name extends Extract<keyof Body['relations'], string>
> = SchemaKey<Body, Name>;

export type GeneratedKeyInsertFields<
  Body extends SchemaBody,
  Name extends Extract<keyof Body['relations'], string>
> = Partial<Omit<SchemaRow<Body, Name>, RelationKeyField<Body, Name>>>;

export type LogicalRelationRow = {
  readonly relationId: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
};

/** Immutable relation state supplied to a pure, replayable database operation. */
export type DatabaseTransactionSnapshot = {
  readonly rows: <Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>
  ) => readonly SchemaRow<Body, Name>[];
  readonly withRows: <Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    rows: readonly SchemaRow<Body, Name>[]
  ) => DatabaseTransactionSnapshot;
  /**
   * Queues one insert whose durable logical key is allocated by the attached source.
   * The pending row appears in staged validation, but not in `rows()` before commit.
   */
  readonly insertWithGeneratedKey: <Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    token: string,
    fields: GeneratedKeyInsertFields<Body, Name>
  ) => DatabaseTransactionSnapshot;
  /** Queues one exact-key semantic splice using JavaScript UTF-16 code-unit offsets. */
  readonly spliceText: <Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    key: RelationKey<Body, Name>,
    field: StringField<Body, Name>,
    edit: {
      readonly index: number;
      readonly deleteCount: number;
      readonly insert: string;
    }
  ) => DatabaseTransactionSnapshot;
};

export type DatabaseTransactionTransform = (
  snapshot: DatabaseTransactionSnapshot
) => DatabaseTransactionSnapshot | Promise<DatabaseTransactionSnapshot>;

export type DatabaseTransactionOptions = {
  readonly signal?: AbortSignal;
  /** Contributing source basis of a user-observed position-sensitive intent. */
  readonly observedBasis?: SourceBasis;
};

export type DatabaseTextIntentTransform = (
  snapshot: DatabaseTransactionSnapshot
) => DatabaseTransactionSnapshot;

export type DatabaseTextPositionAffinity = 'before' | 'after';

declare const databaseTextPositionRequestBrand: unique symbol;

export type DatabaseTextPositionRequest = {
  /** Opaque evidence that this request was captured by its owning session. */
  readonly [databaseTextPositionRequestBrand]: true;
  readonly name: string;
  readonly relation: {
    readonly schemaView: { readonly id: string; readonly contentHash: string };
    readonly relationId: string;
  };
  readonly key: readonly [JsonValue, ...JsonValue[]];
  readonly field: string;
  readonly index: number;
  readonly affinity: DatabaseTextPositionAffinity;
};

export type DatabaseTextPositionResult =
  | {
      readonly name: string;
      readonly state: 'resolved';
      readonly index: number;
      readonly basis: SourceBasis;
      readonly issues: readonly Issue[];
    }
  | {
      readonly name: string;
      readonly state: 'deleted';
      readonly basis: SourceBasis;
      readonly issues: readonly Issue[];
    }
  | {
      readonly name: string;
      readonly state: 'rejected' | 'unknown' | 'cancelled' | 'unsupported' | 'budget-exhausted';
      readonly issues: readonly Issue[];
    };

export type DatabaseTextIntentReceipt = CommitReceipt & {
  readonly textPositions: readonly DatabaseTextPositionResult[];
};

export type DatabaseTextIntentPublishOptions = {
  readonly textPositions?: readonly DatabaseTextPositionRequest[];
};

export type DatabaseTextIntentSegmentStatus =
  | 'pending'
  | 'committed'
  | 'rejected'
  | 'unknown'
  | 'cancelled';

export type DatabaseTextIntentSegment = {
  readonly segmentId: string;
  readonly status: DatabaseTextIntentSegmentStatus;
  readonly issues: readonly Issue[];
};

export type DatabaseTextIntentSessionSnapshot = {
  readonly state:
    | 'ready'
    | 'publishing'
    | 'blocked'
    | 'rejected'
    | 'unknown'
    | 'cancelled'
    | 'closed';
  readonly freshness: 'current' | 'stale';
  readonly observedBasis: SourceBasis;
  readonly current: DatabaseTransactionSnapshot;
  readonly segments: readonly DatabaseTextIntentSegment[];
  readonly issues: readonly Issue[];
  readonly receipt?: DatabaseTextIntentReceipt;
};

/**
 * Causal composition of dependent text splices. Each publication is atomic;
 * later segments may be appended while an earlier prefix is publishing.
 */
export type DatabaseTextIntentSession = {
  readonly getSnapshot: () => DatabaseTextIntentSessionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly append: (
    intent: JsonValue,
    transform: DatabaseTextIntentTransform
  ) => DatabaseTextIntentSegment;
  /** Captures one typed logical position against the session's exact current snapshot. */
  readonly captureTextPosition: <
    Body extends SchemaBody,
    Name extends Extract<keyof Body['relations'], string>
  >(input: {
    readonly name: string;
    readonly relation: LiteralRelation<Body, Name>;
    readonly key: RelationKey<Body, Name>;
    readonly field: StringField<Body, Name>;
    readonly index: number;
    readonly affinity: DatabaseTextPositionAffinity;
  }) => DatabaseTextPositionRequest;
  readonly publish: (
    options?: DatabaseTextIntentPublishOptions
  ) => Promise<DatabaseTextIntentReceipt>;
  readonly cancel: () => void;
  readonly close: () => void;
};

export type OpenDatabaseTextIntentResult =
  | { readonly success: true; readonly value: DatabaseTextIntentSession; readonly issues: readonly Issue[] }
  | { readonly success: false; readonly issues: readonly Issue[] };

export type OpenDatabaseTextIntentOptions = {
  /** Exact source basis underlying the first locally observed splice. */
  readonly observedBasis: SourceBasis;
  readonly signal?: AbortSignal;
};

/** Prepared logical write facts for one relation, independent of source readiness. */
export type DatabaseFieldWriteCapabilities = {
  readonly replace?: { readonly concurrency: 'replay-transform' };
  readonly textSplice?: {
    readonly indexUnit: 'utf16-code-unit';
    readonly concurrency: 'merge-captured-intent';
    readonly dependentComposition?: 'retained-cross-publication';
  };
};

export type DatabaseRelationCapabilities = {
  readonly relationId: string;
  readonly keyFields: readonly string[];
  readonly sourceGeneratedFields: readonly string[];
  readonly insert?: { readonly concurrency: 'replay-transform' };
  readonly delete?: { readonly concurrency: 'replay-transform' };
  readonly generatedKeyInsert?: { readonly concurrency: 'replay-transform' };
  readonly fields: Readonly<Record<string, DatabaseFieldWriteCapabilities>>;
};

export type DatabaseTransactionService = {
  readonly capabilities: <
    Body extends SchemaBody,
    Name extends Extract<keyof Body['relations'], string>
  >(
    relation: LiteralRelation<Body, Name>
  ) => DatabaseRelationCapabilities;
  readonly transact: (
    intent: JsonValue,
    transform: DatabaseTransactionTransform,
    options?: DatabaseTransactionOptions
  ) => Promise<CommitReceipt>;
  readonly simulate: (
    intent: JsonValue,
    transform: DatabaseTransactionTransform,
    options?: DatabaseTransactionOptions
  ) => Promise<SimulationReceipt>;
};

export type DatabaseTextIntentService = {
  readonly openTextIntent: (
    options: OpenDatabaseTextIntentOptions
  ) => Promise<OpenDatabaseTextIntentResult>;
};
