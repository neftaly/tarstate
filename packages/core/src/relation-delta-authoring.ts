import { isContentHash } from './canonical-json.js';
import { createIssue, type Issue, type ParseResult } from './issues.js';
import { canonicalizeJsonWithCache, type CanonicalJsonCache } from './internal-canonical-json.js';
import { detachAndFreezeJsonValue, freezeOwnedJsonValue } from './internal-owned-json.js';
import { stringTupleKey } from './internal-string-key.js';
import { comparePortableStrings } from './portable-order.js';
import type { KeyedDeltaChange, WriteExpression, WriteRelation, WriteStatement } from './transaction.js';
import type { JsonValue } from './value.js';

export type ExactKeyedRelationRows = {
  readonly completeness: 'exact';
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
};

declare const preparedExactKeyedRelationRowsBrand: unique symbol;
export type PreparedExactKeyedRelationRows = ExactKeyedRelationRows & {
  readonly [preparedExactKeyedRelationRowsBrand]: true;
};

const preparedExactRows = new WeakSet<object>();
const preparedRowIndexes = new WeakMap<object, Map<string, Map<string, IndexedRow>>>();
const maxPreparedIndexesPerRowSet = 16;

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
  const adopted = adoptDeltaInput(input);
  if (!adopted.success) return adopted;
  const owned = adopted.value;
  const alias = owned.alias ?? 'row';
  const keyFields = [...owned.keyFields];
  const replaceableFields = new Set(owned.replaceableFields);
  const canonicalization: CanonicalJsonCache = new WeakMap();
  const issues = validateDeltaContract(owned, alias);
  if (issues.length > 0) return { success: false, issues: Object.freeze(issues) };
  const before = indexRows('before', owned.before.rows, keyFields, issues, canonicalization);
  const after = owned.before === owned.after
    ? before
    : indexRows('after', owned.after.rows, keyFields, issues, canonicalization);
  if (issues.length > 0) return { success: false, issues: Object.freeze(issues) };
  if (before === after) return { success: true, value: Object.freeze([]), issues: Object.freeze([]) };

  const changes: KeyedDeltaChange[] = [];
  const orderedBeforeKeys = [...before.keys()].sort(comparePortableStrings);
  const orderedAfterKeys = [...after.keys()].sort(comparePortableStrings);

  for (const fingerprint of orderedBeforeKeys) {
    const previous = before.get(fingerprint) as IndexedRow;
    if (after.has(fingerprint)) continue;
    changes.push({ kind: 'delta.delete', key: literalKey(keyFields, previous.fields) });
  }

  for (const fingerprint of orderedBeforeKeys) {
    const previous = before.get(fingerprint) as IndexedRow;
    const next = after.get(fingerprint);
    if (next === undefined) continue;
    if (previous.fields === next.fields) continue;
    const edits = replacementEdits(previous.fields, next.fields, replaceableFields, fingerprint, issues, canonicalization);
    if (Object.keys(edits).length === 0) continue;
    changes.push({ kind: 'delta.update', key: literalKey(keyFields, previous.fields), edits });
  }

  const insertedRows = orderedAfterKeys
    .filter((fingerprint) => !before.has(fingerprint))
    .map((fingerprint) => literalFields((after.get(fingerprint) as IndexedRow).fields));
  changes.push(...insertedRows.map((fields): KeyedDeltaChange => ({ kind: 'delta.insert', fields })));

  if (issues.length > 0) return { success: false, issues: Object.freeze(issues) };
  const statements: WriteStatement[] = changes.length === 0
    ? []
    : [{ kind: 'statement.keyed-delta', relation: owned.relation, alias, changes }];
  return {
    success: true,
    value: freezeOwnedJsonValue(statements as unknown as JsonValue) as unknown as readonly WriteStatement[],
    issues: Object.freeze([])
  };
};

/** Owns one exact relation state for reuse across multiple delta comparisons. */
export const prepareExactKeyedRelationRows = (
  input: unknown
): ParseResult<PreparedExactKeyedRelationRows> => {
  if (input !== null && typeof input === 'object' && preparedExactRows.has(input)) {
    return { success: true, value: input as PreparedExactKeyedRelationRows, issues: Object.freeze([]) };
  }
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success) return owned;
  if (!isExactRows(owned.value)) return deltaFailure({ reason: 'exact_rows_shape' });
  const prepared = owned.value as unknown as PreparedExactKeyedRelationRows;
  preparedExactRows.add(prepared);
  return { success: true, value: prepared, issues: Object.freeze([]) };
};

const adoptDeltaInput = (input: unknown): ParseResult<ExactKeyedRelationDeltaInput> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return deltaFailure({ reason: 'input_shape' });
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) return deltaFailure({ reason: 'input_shape' });
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return deltaFailure({ reason: 'input_shape' });
  }
  const data = (name: string): unknown => {
    const descriptor = descriptors[name];
    return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined;
  };
  const alias = data('alias');
  const header = detachAndFreezeJsonValue({
    relation: data('relation'),
    keyFields: data('keyFields'),
    replaceableFields: data('replaceableFields'),
    ...(alias === undefined ? {} : { alias })
  });
  if (!header.success || !isRecord(header.value)
    || !isWriteRelation(header.value.relation)
    || !stringArray(header.value.keyFields)
    || !stringArray(header.value.replaceableFields)
    || (header.value.alias !== undefined && typeof header.value.alias !== 'string')) {
    return deltaFailure({ reason: 'input_shape' });
  }
  const before = prepareExactKeyedRelationRows(data('before'));
  const after = prepareExactKeyedRelationRows(data('after'));
  if (!before.success || !after.success) return deltaFailure({ reason: 'input_shape' });
  return {
    success: true,
    value: Object.freeze({
      relation: header.value.relation as unknown as WriteRelation,
      keyFields: header.value.keyFields as readonly string[],
      replaceableFields: header.value.replaceableFields as readonly string[],
      before: before.value,
      after: after.value,
      ...(header.value.alias === undefined ? {} : { alias: header.value.alias })
    }),
    issues: Object.freeze([])
  };
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
  issues: Issue[],
  canonicalization: CanonicalJsonCache
): Map<string, IndexedRow> => {
  const keySignature = stringTupleKey(...keyFields);
  const cached = preparedRowIndexes.get(rows)?.get(keySignature);
  if (cached !== undefined) return cached;
  const issueCount = issues.length;
  const indexed = new Map<string, IndexedRow>();
  rows.forEach((fields, rowIndex) => {
    const missingField = keyFields.find((field) => !Object.hasOwn(fields, field));
    if (missingField !== undefined) {
      issues.push(deltaIssue({ reason: 'key_missing', side, rowIndex, field: missingField }, [side, 'rows', rowIndex, missingField]));
      return;
    }
    const fingerprint = stringTupleKey(...keyFields.map((field) => canonicalizeJsonWithCache(fields[field] as JsonValue, canonicalization)));
    if (indexed.has(fingerprint)) {
      issues.push(deltaIssue({ reason: 'key_ambiguous', side, rowIndex, key: fingerprint }, [side, 'rows', rowIndex]));
      return;
    }
    indexed.set(fingerprint, { fields });
  });
  if (issues.length === issueCount) {
    const indexes = preparedRowIndexes.get(rows) ?? new Map<string, Map<string, IndexedRow>>();
    if (!indexes.has(keySignature) && indexes.size >= maxPreparedIndexesPerRowSet) indexes.delete(indexes.keys().next().value as string);
    indexes.set(keySignature, indexed);
    preparedRowIndexes.set(rows, indexes);
  }
  return indexed;
};

const replacementEdits = (
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>,
  replaceableFields: ReadonlySet<string>,
  key: string,
  issues: Issue[],
  canonicalization: CanonicalJsonCache
): Readonly<Record<string, { readonly kind: 'edit.replace'; readonly value: WriteExpression }>> => {
  const edits: Record<string, { readonly kind: 'edit.replace'; readonly value: WriteExpression }> = {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(comparePortableStrings);
  for (const field of fields) {
    const hadField = Object.hasOwn(before, field);
    const hasField = Object.hasOwn(after, field);
    if (hadField && hasField && sameJson(before[field] as JsonValue, after[field] as JsonValue, canonicalization)) continue;
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

const sameJson = (left: JsonValue, right: JsonValue, canonicalization: CanonicalJsonCache): boolean =>
  Object.is(left, right)
  || canonicalizeJsonWithCache(left, canonicalization) === canonicalizeJsonWithCache(right, canonicalization);

const literalKey = (
  keyFields: readonly string[],
  fields: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, WriteExpression>> => Object.fromEntries(
  keyFields.map((field) => [field, literal(fields[field] as JsonValue)])
);

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
