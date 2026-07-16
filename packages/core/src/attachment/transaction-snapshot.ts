import type { ContentHash } from '../canonical-json.js';
import { createIssue, TarstateParseError, type Issue } from '../issues.js';
import type { CapabilityRegistry } from '../registry.js';
import {
  parseRelationCandidates,
  type PreparedSchema,
  type SchemaBody
} from '../schema.js';
import type { LiteralRelation, SchemaRow } from '../schema-authoring.js';
import type { DatabaseTransactionSnapshot } from '../database/transaction.js';
import type { JsonValue } from '../value.js';

type LogicalRows = readonly Readonly<Record<string, JsonValue>>[];

type TransactionSnapshotContext = {
  readonly owner: object;
  readonly schemaView: { readonly id: string; readonly contentHash: ContentHash };
  readonly schema: PreparedSchema;
  readonly availableRelations: ReadonlyMap<string, unknown>;
  readonly registry: CapabilityRegistry;
  readonly rowsByRelation: ReadonlyMap<string, LogicalRows>;
  readonly changedRelationIds: ReadonlySet<string>;
};

const emptyRows: LogicalRows = Object.freeze([]);

/** Immutable functional core value; lifecycle and replay stay in the service shell. */
export class ImmutableDatabaseTransactionSnapshot implements DatabaseTransactionSnapshot {
  readonly #context: TransactionSnapshotContext;

  constructor(context: TransactionSnapshotContext) {
    this.#context = context;
    Object.freeze(this);
  }

  rows<Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>
  ): readonly SchemaRow<Body, Name>[] {
    const relationId = this.#relationId(relation);
    return (this.#context.rowsByRelation.get(relationId) ?? emptyRows) as readonly SchemaRow<Body, Name>[];
  }

  withRows<Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    rows: readonly SchemaRow<Body, Name>[]
  ): DatabaseTransactionSnapshot {
    const relationId = this.#relationId(relation);
    const previous = this.#context.rowsByRelation.get(relationId) ?? emptyRows;
    if (rows === previous) return this;
    const parsed = parseRelationCandidates(
      this.#context.schema,
      relationId,
      rows.map((value) => ({ value })),
      this.#context.registry
    );
    if (parsed.completeness !== 'exact') throw new TarstateParseError(parsed.issues);
    const replacement = Object.freeze(parsed.rows.map(({ row }) => row as Readonly<Record<string, JsonValue>>));
    const rowsByRelation = new Map(this.#context.rowsByRelation);
    rowsByRelation.set(relationId, replacement);
    const changedRelationIds = this.#context.changedRelationIds.has(relationId)
      ? this.#context.changedRelationIds
      : new Set(this.#context.changedRelationIds).add(relationId);
    return new ImmutableDatabaseTransactionSnapshot({
      ...this.#context,
      rowsByRelation,
      changedRelationIds
    });
  }

  belongsTo(owner: object): boolean {
    return this.#context.owner === owner;
  }

  relationRows(): ReadonlyMap<string, LogicalRows> {
    return this.#context.rowsByRelation;
  }

  changedRelations(): ReadonlySet<string> {
    return this.#context.changedRelationIds;
  }

  #relationId(relation: {
    readonly schemaView: { readonly id: string; readonly contentHash: string };
    readonly relationId: string;
  }): string {
    if (relation.schemaView.id !== this.#context.schemaView.id
      || relation.schemaView.contentHash !== this.#context.schemaView.contentHash) {
      throw new TarstateParseError([snapshotIssue('schema_view_mismatch', relation.relationId)]);
    }
    if (!this.#context.availableRelations.has(relation.relationId)) {
      throw new TarstateParseError([snapshotIssue('relation_unavailable', relation.relationId)]);
    }
    return relation.relationId;
  }
}

const snapshotIssue = (reason: string, relationId: string): Issue => createIssue({
  code: 'transaction.delta_invalid',
  retry: 'after_input',
  relationId,
  details: { reason }
});
