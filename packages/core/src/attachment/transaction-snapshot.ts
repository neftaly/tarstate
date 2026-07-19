import { canonicalizeJson, type ContentHash } from '../canonical-json.js';
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
  DatabaseRelationCapabilities,
  DatabaseTransactionSnapshot,
  GeneratedKeyInsertFields,
  RelationKey
} from '../database/transaction.js';
import { isValidUtf16TextSplice } from '../internal-text-splice.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { JsonValue } from '../value.js';

type LogicalRows = readonly Readonly<Record<string, JsonValue>>[];

export type GeneratedKeyInsert = {
  readonly relationId: string;
  readonly token: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
};

export type AuthoredTextSplice = {
  readonly relationId: string;
  readonly key: readonly [JsonValue, ...JsonValue[]];
  readonly field: string;
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
};

type AvailableRelation = DatabaseRelationCapabilities;

type TransactionSnapshotContext = {
  readonly owner: object;
  readonly lineage: object;
  readonly schemaView: { readonly id: string; readonly contentHash: ContentHash };
  readonly schema: PreparedSchema;
  readonly availableRelations: ReadonlyMap<string, AvailableRelation>;
  readonly registry: CapabilityRegistry;
  readonly rowsByRelation: ReadonlyMap<string, LogicalRows>;
  readonly changedRelationIds: ReadonlySet<string>;
  readonly generatedKeyInserts: readonly GeneratedKeyInsert[];
  readonly textSplices: readonly AuthoredTextSplice[];
  readonly authoringIssues: readonly Issue[];
};

const emptyRows: LogicalRows = Object.freeze([]);
const emptyChangedRelationIds: ReadonlySet<string> = new Set<string>();
const emptyGeneratedKeyInserts: readonly GeneratedKeyInsert[] = Object.freeze([]);
const emptyTextSplices: readonly AuthoredTextSplice[] = Object.freeze([]);
const emptyAuthoringIssues: readonly Issue[] = Object.freeze([]);
const snapshotLineages = new WeakMap<object, object>();
// Owned non-empty row arrays are relation-local; the shared empty array always has an empty index.
const textTargetIndexes = new WeakMap<LogicalRows, ReadonlyMap<string, number>>();

/** Immutable functional core value; lifecycle and replay stay in the service shell. */
export class ImmutableDatabaseTransactionSnapshot implements DatabaseTransactionSnapshot {
  readonly #context: TransactionSnapshotContext;

  constructor(context: TransactionSnapshotContext) {
    this.#context = context;
    snapshotLineages.set(this, context.lineage);
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
    if (this.#context.textSplices.some((splice) => splice.relationId === relationId)) {
      return rejectedSnapshot(this.#context, [snapshotIssue('mixed_relation_authoring', relationId)]);
    }
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
    if (available.generatedKeyInsert === undefined) {
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

  spliceText<Body extends SchemaBody, Name extends Extract<keyof Body['relations'], string>>(
    relation: LiteralRelation<Body, Name>,
    key: RelationKey<Body, Name>,
    field: Extract<keyof SchemaRow<Body, Name>, string>,
    edit: { readonly index: number; readonly deleteCount: number; readonly insert: string }
  ): DatabaseTransactionSnapshot {
    const available = this.#relation(relation);
    const relationId = available.relationId;
    const issues: Issue[] = [];
    if (this.#context.changedRelationIds.has(relationId)) {
      issues.push(snapshotIssue('mixed_relation_authoring', relationId, field));
    }
    if (available.fields[field]?.textSplice === undefined) {
      issues.push(snapshotIssue('text_splice_unavailable', relationId, field));
    }
    const ownedKey = detachAndFreezeJsonValue(key);
    const keyValue = ownedKey.success
      && Array.isArray(ownedKey.value)
      && ownedKey.value.length === available.keyFields.length
      && ownedKey.value.length > 0
      ? ownedKey.value as [JsonValue, ...JsonValue[]]
      : undefined;
    if (keyValue === undefined) {
      issues.push(...(ownedKey.success
        ? [snapshotIssue('key_invalid', relationId)]
        : ownedKey.issues));
    }
    const ownedEdit = detachAndFreezeJsonValue(edit);
    const editValue = ownedEdit.success && isRecord(ownedEdit.value)
      ? ownedEdit.value
      : undefined;
    if (editValue === undefined
      || !isNonNegativeSafeInteger(editValue.index)
      || !isNonNegativeSafeInteger(editValue.deleteCount)
      || typeof editValue.insert !== 'string') {
      issues.push(...(ownedEdit.success
        ? [snapshotIssue('text_splice_invalid', relationId, field)]
        : ownedEdit.issues));
    }
    const relationRows = this.#context.rowsByRelation.get(relationId) ?? emptyRows;
    const indexedMatch = keyValue === undefined
      ? undefined
      : textTargetIndex(relationRows, available).get(canonicalizeJson(keyValue));
    const matchIndex = indexedMatch === undefined || indexedMatch === ambiguousTextTarget
      ? -1
      : indexedMatch;
    const matchCount = indexedMatch === undefined
      ? 0
      : indexedMatch === ambiguousTextTarget ? 2 : 1;
    const matchedRow = matchCount === 1 ? relationRows[matchIndex] : undefined;
    const current = matchedRow?.[field];
    if (keyValue !== undefined && matchCount !== 1) {
      issues.push(snapshotIssue(matchCount === 0 ? 'key_missing' : 'key_ambiguous', relationId));
    } else if (matchCount === 1 && typeof current !== 'string') {
      issues.push(snapshotIssue('text_field_invalid', relationId, field));
    } else if (typeof current === 'string'
      && editValue !== undefined
      && isNonNegativeSafeInteger(editValue.index)
      && isNonNegativeSafeInteger(editValue.deleteCount)
      && typeof editValue.insert === 'string'
      && !isValidUtf16TextSplice(current, {
        index: editValue.index,
        deleteCount: editValue.deleteCount,
        insert: editValue.insert
      })) {
      issues.push(snapshotIssue('text_splice_range_invalid', relationId, field));
    }
    if (issues.length > 0) return rejectedSnapshot(this.#context, issues);
    const adoptedEdit = editValue as { readonly index: number; readonly deleteCount: number; readonly insert: string };
    if (adoptedEdit.deleteCount === 0 && adoptedEdit.insert.length === 0) return this;
    const splice: AuthoredTextSplice = Object.freeze({
      relationId,
      key: Object.freeze(keyValue as [JsonValue, ...JsonValue[]]),
      field,
      index: adoptedEdit.index,
      deleteCount: adoptedEdit.deleteCount,
      insert: adoptedEdit.insert
    });
    const nextRows = [...relationRows];
    nextRows[matchIndex] = Object.freeze({
      ...matchedRow,
      [field]: (current as string).slice(0, splice.index)
        + splice.insert
        + (current as string).slice(splice.index + splice.deleteCount)
    });
    const rowsByRelation = new Map(this.#context.rowsByRelation);
    rowsByRelation.set(relationId, Object.freeze(nextRows));
    if (!available.keyFields.includes(field)) {
      retainTextTargetIndex(relationRows, nextRows);
    }
    return new ImmutableDatabaseTransactionSnapshot({
      ...this.#context,
      rowsByRelation,
      textSplices: Object.freeze([...this.#context.textSplices, splice])
    });
  }

  reject(...issues: readonly [Issue, ...Issue[]]): DatabaseTransactionSnapshot {
    if (!issues.some(({ severity }) => severity === 'error')) {
      throw new TypeError('Expected transaction rejection requires at least one error issue');
    }
    return rejectedSnapshot(this.#context, issues.map(createIssue));
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

  authoredTextSplices(): readonly AuthoredTextSplice[] {
    return this.#context.textSplices;
  }

  rejectionIssues(): readonly Issue[] {
    return this.#context.authoringIssues;
  }

  continuationBase(): ImmutableDatabaseTransactionSnapshot {
    return new ImmutableDatabaseTransactionSnapshot({
      ...this.#context,
      lineage: Object.freeze({}),
      changedRelationIds: emptyChangedRelationIds,
      generatedKeyInserts: emptyGeneratedKeyInserts,
      textSplices: emptyTextSplices,
      authoringIssues: emptyAuthoringIssues
    });
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

export const sameTransactionSnapshotLineage = (
  left: ImmutableDatabaseTransactionSnapshot,
  right: ImmutableDatabaseTransactionSnapshot
): boolean => snapshotLineages.get(left) === snapshotLineages.get(right);

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

const isNonNegativeSafeInteger = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const ambiguousTextTarget = -1;

const textTargetIndex = (
  rows: LogicalRows,
  available: AvailableRelation
): ReadonlyMap<string, number> => {
  const cached = textTargetIndexes.get(rows);
  if (cached !== undefined) return cached;
  const index = new Map<string, number>();
  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position] as Readonly<Record<string, JsonValue>>;
    const key: JsonValue[] = [];
    let complete = true;
    for (const field of available.keyFields) {
      const value = row[field];
      if (value === undefined) {
        complete = false;
        break;
      }
      key.push(value);
    }
    if (!complete) continue;
    const canonical = canonicalizeJson(key);
    index.set(canonical, index.has(canonical) ? ambiguousTextTarget : position);
  }
  textTargetIndexes.set(rows, index);
  return index;
};

const retainTextTargetIndex = (
  before: LogicalRows,
  after: LogicalRows
): void => {
  const index = textTargetIndexes.get(before);
  if (index === undefined) return;
  textTargetIndexes.set(after, index);
};
