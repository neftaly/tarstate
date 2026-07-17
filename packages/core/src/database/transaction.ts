import type { SchemaBody } from '../schema.js';
import type { LiteralRelation, SchemaRow } from '../schema-authoring.js';
import type { CommitReceipt, SimulationReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';

type RelationKeyField<
  Body extends SchemaBody,
  Name extends Extract<keyof Body['relations'], string>
> = Body['relations'][Name]['key'][number];

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
};

export type DatabaseTransactionTransform = (
  snapshot: DatabaseTransactionSnapshot
) => DatabaseTransactionSnapshot | Promise<DatabaseTransactionSnapshot>;

export type DatabaseTransactionOptions = {
  readonly signal?: AbortSignal;
};

export type DatabaseTransactionService = {
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
