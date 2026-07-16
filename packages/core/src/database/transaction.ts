import type { SchemaBody } from '../schema.js';
import type { LiteralRelation, SchemaRow } from '../schema-authoring.js';
import type { CommitReceipt, SimulationReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';

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
