import type { SchemaBody } from '../schema.js';
import type { LiteralRelation, SchemaKey, SchemaRow } from '../schema-authoring.js';
import type { CommitReceipt, SimulationReceipt } from '../transaction.js';
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

/** Prepared logical write facts for one relation, independent of source readiness. */
export type DatabaseFieldWriteCapabilities = {
  readonly replace?: { readonly concurrency: 'replay-transform' };
  readonly textSplice?: {
    readonly indexUnit: 'utf16-code-unit';
    readonly concurrency: 'merge-captured-intent';
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
