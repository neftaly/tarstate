import type { ContentHash } from '../canonical-json.js';
import { createIssue, type Issue } from '../issues.js';
import type { CapabilityRegistry } from '../registry.js';
import {
  parseRelationCandidates,
  parseScalarValueForField,
  type PreparedSchema,
  type SchemaBody
} from '../schema.js';
import type { LiteralRelation, SchemaRow } from '../schema-authoring.js';
import type {
  DatabaseTransactionSnapshot,
  GeneratedKeyInsertFields
} from '../database/transaction.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { JsonValue } from '../value.js';

type LogicalRows = readonly Readonly<Record<string, JsonValue>>[];

export type GeneratedKeyInsert = {
  readonly relationId: string;
  readonly token: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
};

type AvailableRelation = {
  readonly relationId: string;
  readonly keyFields: readonly string[];
  readonly sourceGeneratedFields: readonly string[];
  readonly supportsGeneratedKeyInsert: boolean;
};

type TransactionSnapshotContext = {
  readonly owner: object;
  readonly schemaView: { readonly id: string; readonly contentHash: ContentHash };
  readonly schema: PreparedSchema;
  readonly availableRelations: ReadonlyMap<string, AvailableRelation>;
  readonly registry: CapabilityRegistry;
  readonly rowsByRelation: ReadonlyMap<string, LogicalRows>;
  readonly changedRelationIds: ReadonlySet<string>;
  readonly generatedKeyInserts: readonly GeneratedKeyInsert[];
  readonly authoringIssues: readonly Issue[];
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
    const relationId = this.#relation(relation).relationId;
    return (this.#context.rowsByRelation.get(relationId) ?? emptyRows) as readonly SchemaRow<Body, Name>[];
  }

  withRows<Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    rows: readonly SchemaRow<Body, Name>[]
  ): DatabaseTransactionSnapshot {
    const relationId = this.#relation(relation).relationId;
    const previous = this.#context.rowsByRelation.get(relationId) ?? emptyRows;
    if (rows === previous) return this;
    const parsed = parseRelationCandidates(
      this.#context.schema,
      relationId,
      rows.map((value) => ({ value })),
      this.#context.registry
    );
    if (parsed.completeness !== 'exact') {
      return rejectedSnapshot(this.#context, parsed.issues);
    }
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

  insertWithGeneratedKey<Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    token: string,
    fields: GeneratedKeyInsertFields<Body, Name>
  ): DatabaseTransactionSnapshot {
    const available = this.#relation(relation);
    const issues: Issue[] = [];
    if (!available.supportsGeneratedKeyInsert) {
      issues.push(snapshotIssue('source_generated_key_unavailable', available.relationId));
    }
    const ownedToken = detachAndFreezeJsonValue(token);
    const tokenValue = ownedToken.success && typeof ownedToken.value === 'string'
      ? ownedToken.value
      : undefined;
    if (tokenValue === undefined || tokenValue.length === 0) {
      issues.push(...(ownedToken.success
        ? [snapshotIssue('insertion_token_invalid', available.relationId)]
        : ownedToken.issues));
    } else if (this.#context.generatedKeyInserts.some((insert) => insert.token === tokenValue)) {
      issues.push(snapshotIssue('insertion_token_duplicate', available.relationId));
    }
    const parsedFields = parseGeneratedFields(this.#context, available, fields);
    issues.push(...parsedFields.issues);
    if (issues.length > 0) return rejectedSnapshot(this.#context, issues);
    const insert = Object.freeze({
      relationId: available.relationId,
      token: tokenValue as string,
      fields: parsedFields.fields as Readonly<Record<string, JsonValue>>
    });
    return new ImmutableDatabaseTransactionSnapshot({
      ...this.#context,
      generatedKeyInserts: Object.freeze([...this.#context.generatedKeyInserts, insert])
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

  generatedInserts(): readonly GeneratedKeyInsert[] {
    return this.#context.generatedKeyInserts;
  }

  rejectionIssues(): readonly Issue[] {
    return this.#context.authoringIssues;
  }

  #relation(relation: {
    readonly schemaView: { readonly id: string; readonly contentHash: string };
    readonly relationId: string;
  }): AvailableRelation {
    if (relation.schemaView.id !== this.#context.schemaView.id
      || relation.schemaView.contentHash !== this.#context.schemaView.contentHash) {
      throw new TypeError('Transaction relation belongs to a different schema view');
    }
    const available = this.#context.availableRelations.get(relation.relationId);
    if (available === undefined) {
      throw new TypeError(`Transaction relation ${JSON.stringify(relation.relationId)} is unavailable`);
    }
    return available;
  }

}

const parseGeneratedFields = (
  context: TransactionSnapshotContext,
  available: AvailableRelation,
  input: unknown
): { readonly fields?: Readonly<Record<string, JsonValue>>; readonly issues: readonly Issue[] } => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success) return { issues: owned.issues };
  if (!isRecord(owned.value)) {
    return { issues: [snapshotIssue('generated_fields_invalid', available.relationId)] };
  }
  const relation = context.schema.relationsById.get(available.relationId);
  if (relation === undefined) {
    return { issues: [snapshotIssue('relation_unavailable', available.relationId)] };
  }
  const generated = new Set([...available.keyFields, ...available.sourceGeneratedFields]);
  const fields: Record<string, JsonValue> = {};
  const issues: Issue[] = [];
  for (const [field, value] of Object.entries(owned.value)) {
    const declaration = relation.declaration.fields[field];
    if (declaration === undefined) {
      issues.push(snapshotIssue('field_unknown', available.relationId, field));
    } else if (generated.has(field)) {
      issues.push(snapshotIssue('source_generated_field_supplied', available.relationId, field));
    } else {
      const parsed = parseScalarValueForField(
        context.schema,
        declaration,
        value,
        context.registry,
        [field]
      );
      if (parsed.success) fields[field] = parsed.value as JsonValue;
      else issues.push(...parsed.issues);
    }
  }
  for (const [field, declaration] of Object.entries(relation.declaration.fields)) {
    if (!generated.has(field) && declaration.optional !== true && !Object.hasOwn(fields, field)) {
      issues.push(snapshotIssue('required_field_missing', available.relationId, field));
    }
  }
  return issues.length === 0
    ? { fields: Object.freeze(fields), issues }
    : { issues };
};

const rejectedSnapshot = (
  context: TransactionSnapshotContext,
  issues: readonly Issue[]
): ImmutableDatabaseTransactionSnapshot => new ImmutableDatabaseTransactionSnapshot({
  ...context,
  authoringIssues: Object.freeze([...context.authoringIssues, ...issues])
});

const snapshotIssue = (reason: string, relationId: string, field?: string): Issue => createIssue({
  code: 'transaction.delta_invalid',
  retry: 'after_input',
  relationId,
  ...(field === undefined ? {} : { path: [field] }),
  details: { reason, ...(field === undefined ? {} : { field }) }
});

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
