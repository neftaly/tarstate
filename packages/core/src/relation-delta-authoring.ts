import { canonicalizeJson, isContentHash } from './artifacts.js';
import { createIssue, type Issue, type ParseResult } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { comparePortableStrings } from './portable-order.js';
import type { WriteExpression, WriteRelation, WriteStatement } from './transaction.js';
import type { JsonValue } from './value.js';

export type ExactKeyedRelationRows = {
  readonly completeness: 'exact';
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
};

export type ExactKeyedRelationDeltaInput = {
  readonly relation: WriteRelation;
  readonly keyFields: readonly string[];
  /** Fields whose declared write mechanism permits complete replacement. */
  readonly replaceableFields: readonly string[];
  readonly before: ExactKeyedRelationRows;
  readonly after: ExactKeyedRelationRows;
  readonly alias?: string;
};

type IndexedRow = {
  readonly fields: Readonly<Record<string, JsonValue>>;
};

/**
 * Purely authors canonical targeted statements from two exact keyed states.
 * It never infers preservation-sensitive edits, performs I/O, or commits.
 */
export const authorExactKeyedRelationDelta = (
  input: ExactKeyedRelationDeltaInput
): ParseResult<readonly WriteStatement[]> => {
  const adopted = detachAndFreezeJsonValue(input as unknown);
  if (!adopted.success) return adopted;
  if (!isDeltaInput(adopted.value)) {
    return deltaFailure({ reason: 'input_shape' });
  }

  const owned = adopted.value as unknown as ExactKeyedRelationDeltaInput;
  const alias = owned.alias ?? 'row';
  const keyFields = [...owned.keyFields];
  const replaceableFields = new Set(owned.replaceableFields);
  const issues = validateDeltaContract(owned, alias);
  if (issues.length > 0) return { success: false, issues: Object.freeze(issues) };
  const before = indexRows('before', owned.before.rows, keyFields, issues);
  const after = indexRows('after', owned.after.rows, keyFields, issues);
  if (issues.length > 0) return { success: false, issues: Object.freeze(issues) };

  const statements: WriteStatement[] = [];
  const orderedBeforeKeys = [...before.keys()].sort(comparePortableStrings);
  const orderedAfterKeys = [...after.keys()].sort(comparePortableStrings);

  for (const fingerprint of orderedBeforeKeys) {
    const previous = before.get(fingerprint) as IndexedRow;
    if (after.has(fingerprint)) continue;
    statements.push({
      kind: 'statement.delete',
      target: keyedTarget(owned.relation, alias, keyFields, previous.fields)
    });
  }

  for (const fingerprint of orderedBeforeKeys) {
    const previous = before.get(fingerprint) as IndexedRow;
    const next = after.get(fingerprint);
    if (next === undefined) continue;
    const edits = replacementEdits(previous.fields, next.fields, replaceableFields, fingerprint, issues);
    if (Object.keys(edits).length === 0) continue;
    statements.push({
      kind: 'statement.update',
      target: keyedTarget(owned.relation, alias, keyFields, previous.fields),
      edits
    });
  }

  const insertedRows = orderedAfterKeys
    .filter((fingerprint) => !before.has(fingerprint))
    .map((fingerprint) => literalFields((after.get(fingerprint) as IndexedRow).fields));
  if (insertedRows.length > 0) {
    statements.push({ kind: 'statement.insert', relation: owned.relation, rows: insertedRows });
  }

  if (issues.length > 0) return { success: false, issues: Object.freeze(issues) };
  const detached = detachAndFreezeJsonValue(statements as unknown);
  return detached.success
    ? { success: true, value: detached.value as unknown as readonly WriteStatement[], issues: Object.freeze([]) }
    : detached;
};

const validateDeltaContract = (
  input: ExactKeyedRelationDeltaInput,
  alias: string
): Issue[] => {
  const issues: Issue[] = [];
  if (input.keyFields.length === 0) issues.push(deltaIssue({ reason: 'key_fields_empty' }, ['keyFields']));
  if (new Set(input.keyFields).size !== input.keyFields.length) issues.push(deltaIssue({ reason: 'key_fields_duplicate' }, ['keyFields']));
  if (new Set(input.replaceableFields).size !== input.replaceableFields.length) issues.push(deltaIssue({ reason: 'replaceable_fields_duplicate' }, ['replaceableFields']));
  if (alias.length === 0) issues.push(deltaIssue({ reason: 'alias_empty' }, ['alias']));
  return issues;
};

const indexRows = (
  side: 'before' | 'after',
  rows: readonly Readonly<Record<string, JsonValue>>[],
  keyFields: readonly string[],
  issues: Issue[]
): Map<string, IndexedRow> => {
  const indexed = new Map<string, IndexedRow>();
  rows.forEach((fields, rowIndex) => {
    const missingField = keyFields.find((field) => !Object.hasOwn(fields, field));
    if (missingField !== undefined) {
      issues.push(deltaIssue({ reason: 'key_missing', side, rowIndex, field: missingField }, [side, 'rows', rowIndex, missingField]));
      return;
    }
    const fingerprint = canonicalizeJson(keyFields.map((field) => fields[field] as JsonValue));
    if (indexed.has(fingerprint)) {
      issues.push(deltaIssue({ reason: 'key_ambiguous', side, rowIndex, key: fingerprint }, [side, 'rows', rowIndex]));
      return;
    }
    indexed.set(fingerprint, { fields });
  });
  return indexed;
};

const replacementEdits = (
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>,
  replaceableFields: ReadonlySet<string>,
  key: string,
  issues: Issue[]
): Readonly<Record<string, { readonly kind: 'edit.replace'; readonly value: WriteExpression }>> => {
  const edits: Record<string, { readonly kind: 'edit.replace'; readonly value: WriteExpression }> = {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(comparePortableStrings);
  for (const field of fields) {
    const hadField = Object.hasOwn(before, field);
    const hasField = Object.hasOwn(after, field);
    if (hadField && hasField && canonicalizeJson(before[field] as JsonValue) === canonicalizeJson(after[field] as JsonValue)) continue;
    if (!hasField) {
      issues.push(deltaIssue({ reason: 'field_removal_unsupported', field, key }, ['after', 'rows', key, field]));
      continue;
    }
    if (!replaceableFields.has(field)) {
      issues.push(deltaIssue({ reason: 'field_replacement_unavailable', field, key }, ['after', 'rows', key, field]));
      continue;
    }
    edits[field] = { kind: 'edit.replace', value: literal(after[field] as JsonValue) };
  }
  return edits;
};

const keyedTarget = (
  relation: WriteRelation,
  alias: string,
  keyFields: readonly string[],
  fields: Readonly<Record<string, JsonValue>>
): Extract<WriteStatement, { readonly kind: 'statement.update' }>['target'] => {
  const terms = keyFields.map((field): WriteExpression => ({
    kind: 'compare',
    op: 'eq',
    left: { kind: 'field', alias, name: field },
    right: literal(fields[field] as JsonValue)
  }));
  return {
    relation,
    alias,
    where: terms.length === 1
      ? terms[0] as WriteExpression
      : { kind: 'boolean', op: 'and', args: terms }
  };
};

const literalFields = (
  fields: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, WriteExpression>> => Object.fromEntries(
  Object.keys(fields).sort(comparePortableStrings).map((field) => [field, literal(fields[field] as JsonValue)])
);

const literal = (value: JsonValue): WriteExpression => ({ kind: 'literal', value });

const deltaFailure = (details: JsonValue): ParseResult<never> => ({
  success: false,
  issues: Object.freeze([deltaIssue(details)])
});

const deltaIssue = (details: JsonValue, path?: readonly unknown[]) => createIssue({
  code: 'transaction.delta_invalid',
  retry: 'after_input',
  ...(path === undefined ? {} : { path }),
  details
});

const isDeltaInput = (value: JsonValue): boolean => isRecord(value)
  && isWriteRelation(value.relation)
  && stringArray(value.keyFields)
  && stringArray(value.replaceableFields)
  && isExactRows(value.before)
  && isExactRows(value.after)
  && (value.alias === undefined || typeof value.alias === 'string');

const isExactRows = (value: JsonValue | undefined): boolean => isRecord(value)
  && value.completeness === 'exact'
  && Array.isArray(value.rows)
  && value.rows.every(isRecord);

const isWriteRelation = (value: JsonValue | undefined): boolean => isRecord(value)
  && typeof value.relationId === 'string'
  && value.relationId.length > 0
  && isRecord(value.schemaView)
  && typeof value.schemaView.id === 'string'
  && value.schemaView.id.length > 0
  && isContentHash(value.schemaView.contentHash)
  && (value.schemaView.locations === undefined || stringArray(value.schemaView.locations));

const stringArray = (value: JsonValue | undefined): boolean => Array.isArray(value)
  && value.every((member) => typeof member === 'string' && member.length > 0);

const isRecord = (value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> => value !== null
  && typeof value === 'object'
  && !Array.isArray(value);
