import { canonicalizeJson } from './artifacts.js';
import { parseScalarValue, type ScalarDeclaration } from './codec.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { CapabilityRegistry } from './registry.js';
import type { JsonValue, PortableValue } from './value.js';

export type RelationId = string;
export type LogicalKey = readonly [PortableValue, ...PortableValue[]];
export type RelationRow = Readonly<Record<string, PortableValue>>;

export type SchemaBody = {
  readonly relations: Readonly<Record<string, RelationDeclaration>>;
  readonly requiredCodecs?: readonly CapabilityRef[];
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

/** Sealed portable schema artifact with its typed body preserved. */
export type SchemaArtifact = TypedArtifact<'schema', SchemaBody>;

/** Seals a typed schema body without requiring a `JsonValue` assertion at the call site. */
export const sealSchema = (input: TypedArtifactInput<SchemaBody>): Promise<SchemaArtifact> => sealTypedArtifact('schema', input);

export type RelationDeclaration = {
  readonly relationId: RelationId;
  readonly key: readonly string[];
  readonly fields: Readonly<Record<string, FieldDeclaration>>;
  readonly entityEditCapabilities?: readonly CapabilityRef[];
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type FieldDeclaration = {
  readonly type: ScalarDeclaration;
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly editCapabilities?: readonly CapabilityRef[];
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type PreparedRelation = {
  readonly name: string;
  readonly declaration: RelationDeclaration;
  readonly keyFields: readonly FieldDeclaration[];
};

export type PreparedSchema = {
  readonly body: SchemaBody;
  readonly relationsByName: ReadonlyMap<string, PreparedRelation>;
  readonly relationsById: ReadonlyMap<RelationId, PreparedRelation>;
};

export type CandidateContext = {
  readonly sourceId?: string;
  readonly relationId?: RelationId;
  readonly locator?: unknown;
  readonly path?: readonly unknown[];
};

export type ParsedCandidate = {
  readonly row: RelationRow;
  readonly key: LogicalKey;
};

export type RelationCandidate = {
  readonly value: unknown;
  readonly locator?: unknown;
};

export type ParsedRelation = {
  readonly rows: readonly (ParsedCandidate & { readonly locator?: unknown })[];
  readonly rejected: readonly RelationCandidate[];
  readonly issues: readonly Issue[];
  readonly completeness: 'exact' | 'unknown';
};

export const prepareSchema = (input: unknown, registry?: CapabilityRegistry): ParseResult<PreparedSchema> => {
  if (!isRecord(input) || !isRecord(input.relations)) return schemaFailure('schema.invalid', [], { reason: 'shape' });
  const body = input as unknown as SchemaBody;
  const issues: Issue[] = [];
  const relationsByName = new Map<string, PreparedRelation>();
  const relationsById = new Map<RelationId, PreparedRelation>();

  for (const [name, declaration] of Object.entries(body.relations)) {
    const path = ['relations', name];
    if (name.length === 0 || !isRelationDeclaration(declaration)) {
      issues.push(schemaIssue('schema.relation_invalid', path));
      continue;
    }
    if (relationsById.has(declaration.relationId)) {
      issues.push(schemaIssue('schema.relation_id_duplicate', [...path, 'relationId'], { relationId: declaration.relationId }));
      continue;
    }
    if (declaration.key.length === 0 || new Set(declaration.key).size !== declaration.key.length) {
      issues.push(schemaIssue('schema.key_invalid', [...path, 'key'], { reason: declaration.key.length === 0 ? 'empty' : 'duplicate_field' }));
      continue;
    }
    const keyFields: FieldDeclaration[] = [];
    for (const fieldName of declaration.key) {
      const field = declaration.fields[fieldName];
      if (field === undefined || field.optional === true || field.nullable === true) {
        issues.push(schemaIssue('schema.key_invalid', [...path, 'key', fieldName], { reason: field === undefined ? 'unknown_field' : field.optional === true ? 'optional' : 'nullable' }));
      } else keyFields.push(field);
    }
    for (const [fieldName, field] of Object.entries(declaration.fields)) {
      if (!isFieldDeclaration(field)) {
        issues.push(schemaIssue('schema.field_invalid', [...path, 'fields', fieldName]));
        continue;
      }
      if (field.type.kind === 'string' && field.type.values !== undefined && (field.type.values.length === 0 || new Set(field.type.values).size !== field.type.values.length)) {
        issues.push(schemaIssue('schema.field_invalid', [...path, 'fields', fieldName, 'type', 'values'], { reason: field.type.values.length === 0 ? 'empty_enum' : 'duplicate_enum_value' }));
      }
    }
    const prepared = { name, declaration, keyFields } satisfies PreparedRelation;
    relationsByName.set(name, prepared);
    relationsById.set(declaration.relationId, prepared);
  }

  for (const relation of relationsById.values()) {
    for (const [fieldName, field] of Object.entries(relation.declaration.fields)) {
      if (field.type.kind === 'ref' && !relationsById.has(field.type.target.relationId)) {
        issues.push(schemaIssue('schema.ref_target_missing', ['relations', relation.name, 'fields', fieldName, 'type', 'target'], { relationId: field.type.target.relationId }));
      }
    }
  }

  const required = body.requiredCodecs ?? [];
  if (!Array.isArray(required) || required.some((ref) => !isCapabilityRef(ref))) issues.push(schemaIssue('schema.required_codecs_invalid', ['requiredCodecs']));
  else if (registry !== undefined) issues.push(...registry.missing(required));
  if (issues.length > 0) return { success: false, issues };
  return { success: true, value: { body, relationsByName, relationsById }, issues: [] };
};

/** Projects declared logical fields; undeclared storage fields remain outside the row so preserving writers can round-trip them. */
export const parseRelationCandidate = (
  schema: PreparedSchema,
  relation: RelationId | PreparedRelation,
  input: unknown,
  registry?: CapabilityRegistry,
  context: CandidateContext = {}
): ParseResult<ParsedCandidate> => {
  const prepared = typeof relation === 'string' ? schema.relationsById.get(relation) ?? schema.relationsByName.get(relation) : relation;
  if (prepared === undefined) return schemaFailure('schema.relation_missing', context.path ?? [], { relation });
  const basePath = context.path ?? [];
  if (!isSafeCandidateRecord(input)) return contextualFailure('schema.candidate_invalid', prepared.declaration.relationId, context, basePath, { reason: 'record_required' });
  const row: Record<string, PortableValue> = {};
  const issues: Issue[] = [];
  for (const [name, field] of Object.entries(prepared.declaration.fields)) {
    const fieldPath = [...basePath, name];
    if (!Object.hasOwn(input, name)) {
      if (field.optional !== true) issues.push(contextualIssue('schema.field_missing', prepared.declaration.relationId, context, fieldPath, { field: name }));
      continue;
    }
    const value = input[name];
    if (value === null) {
      if (field.nullable === true) row[name] = null;
      else issues.push(contextualIssue('schema.null_not_allowed', prepared.declaration.relationId, context, fieldPath, { field: name }));
      continue;
    }
    const parsed = parseScalarValue(field.type, value, {
      ...(registry === undefined ? {} : { registry }),
      path: fieldPath,
      refFields: (relationId) => schema.relationsById.get(relationId)?.keyFields.map((keyField) => keyField.type)
    });
    if (parsed.success) row[name] = parsed.value;
    else issues.push(...parsed.issues.map((issue) => addCandidateContext(issue, prepared.declaration.relationId, context)));
  }
  if (issues.length > 0) return { success: false, issues };
  const key = prepared.declaration.key.map((field) => row[field]) as unknown as LogicalKey;
  return { success: true, value: { row, key }, issues: [] };
};

export const parseRelationCandidates = (
  schema: PreparedSchema,
  relation: RelationId | PreparedRelation,
  candidates: readonly RelationCandidate[],
  registry?: CapabilityRegistry,
  context: Omit<CandidateContext, 'locator' | 'path'> = {}
): ParsedRelation => {
  const prepared = typeof relation === 'string' ? schema.relationsById.get(relation) ?? schema.relationsByName.get(relation) : relation;
  if (prepared === undefined) return { rows: [], rejected: candidates, completeness: 'unknown', issues: [schemaIssue('schema.relation_missing', [], { relation })] };
  const rows: (ParsedCandidate & { readonly locator?: unknown })[] = [];
  const rejected: RelationCandidate[] = [];
  const issues: Issue[] = [];
  candidates.forEach((candidate, index) => {
    const parsed = parseRelationCandidate(schema, prepared, candidate.value, registry, { ...context, relationId: prepared.declaration.relationId, locator: candidate.locator, path: [index] });
    if (parsed.success) rows.push({ ...parsed.value, ...(candidate.locator === undefined ? {} : { locator: candidate.locator }) });
    else { rejected.push(candidate); issues.push(...parsed.issues); }
  });
  const byKey = new Map<string, typeof rows>();
  for (const row of rows) {
    const fingerprint = canonicalizeJson(row.key as unknown as JsonValue);
    const group = byKey.get(fingerprint) ?? [];
    group.push(row);
    byKey.set(fingerprint, group);
  }
  let duplicateKeys = false;
  for (const duplicates of byKey.values()) {
    if (duplicates.length < 2) continue;
    duplicateKeys = true;
    for (const duplicate of duplicates) {
      issues.push(contextualIssue('schema.duplicate_key', prepared.declaration.relationId, { ...context, locator: duplicate.locator }, [], { count: duplicates.length }, duplicate.key));
    }
  }
  return { rows, rejected, issues, completeness: rejected.length === 0 && !duplicateKeys ? 'exact' : 'unknown' };
};

export const parseLogicalKey = (
  schema: PreparedSchema,
  relationId: RelationId,
  input: unknown,
  registry?: CapabilityRegistry
): ParseResult<LogicalKey> => {
  const relation = schema.relationsById.get(relationId);
  if (relation === undefined) return schemaFailure('schema.relation_missing', [], { relationId });
  if (!Array.isArray(input) || input.length !== relation.keyFields.length) return schemaFailure('schema.key_arity', [], { expected: relation.keyFields.length, actual: Array.isArray(input) ? input.length : 'non_tuple' });
  const values: PortableValue[] = [];
  const issues: Issue[] = [];
  relation.keyFields.forEach((field, index) => {
    const parsed = parseScalarValue(field.type, input[index], { ...(registry === undefined ? {} : { registry }), path: [index], refFields: (target) => schema.relationsById.get(target)?.keyFields.map((candidate) => candidate.type) });
    if (parsed.success) values.push(parsed.value);
    else issues.push(...parsed.issues);
  });
  return issues.length === 0 ? { success: true, value: values as unknown as LogicalKey, issues: [] } : { success: false, issues };
};

export const parseScalarValueForField = (
  schema: PreparedSchema,
  field: FieldDeclaration,
  input: unknown,
  registry?: CapabilityRegistry,
  path: readonly unknown[] = []
): ParseResult<PortableValue> => {
  if (input === null) return field.nullable === true
    ? { success: true, value: null, issues: [] }
    : schemaFailure('schema.null_not_allowed', path);
  return parseScalarValue(field.type, input, {
    ...(registry === undefined ? {} : { registry }),
    path,
    refFields: (relationId) => schema.relationsById.get(relationId)?.keyFields.map((keyField) => keyField.type)
  });
};

const isRelationDeclaration = (value: unknown): value is RelationDeclaration => isRecord(value) && typeof value.relationId === 'string' && value.relationId.length > 0 && Array.isArray(value.key) && value.key.every((field) => typeof field === 'string') && isRecord(value.fields);
const isFieldDeclaration = (value: unknown): value is FieldDeclaration => isRecord(value) && isScalarDeclaration(value.type) && (value.optional === undefined || typeof value.optional === 'boolean') && (value.nullable === undefined || typeof value.nullable === 'boolean');
const isScalarDeclaration = (value: unknown): value is ScalarDeclaration => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'string') return value.values === undefined || (Array.isArray(value.values) && value.values.every((member) => typeof member === 'string'));
  if (['boolean', 'number', 'integer', 'decimal', 'bytes', 'json'].includes(value.kind)) return true;
  if (value.kind === 'instant') return value.precision === 'millisecond' || value.precision === 'microsecond' || value.precision === 'nanosecond';
  if (value.kind === 'ref') return isRecord(value.target) && typeof value.target.relationId === 'string';
  return value.kind === 'custom' && isCapabilityRef(value.codec);
};
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string' && typeof value.contractHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.contractHash);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSafeCandidateRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && descriptors[key]?.enumerable === true && 'value' in (descriptors[key] as PropertyDescriptor));
  } catch { return false; }
};

const schemaIssue = (code: string, path: readonly unknown[], details?: unknown): Issue => createIssue({ code, phase: 'parse', severity: 'error', retry: 'after_input', path, ...(details === undefined ? {} : { details }) });
const schemaFailure = (code: string, path: readonly unknown[], details?: unknown): ParseResult<never> => ({ success: false, issues: [schemaIssue(code, path, details)] });
const contextualIssue = (code: string, relationId: RelationId, context: CandidateContext, path: readonly unknown[], details?: unknown, key?: unknown): Issue => createIssue({
  code,
  phase: 'parse',
  severity: 'error',
  retry: code === 'schema.duplicate_key' ? 'manual_repair' : 'after_input',
  path,
  relationId,
  ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
  ...(key === undefined ? {} : { key }),
  ...(details === undefined && context.locator === undefined ? {} : { details: { ...(isRecord(details) ? details : details === undefined ? {} : { value: details }), ...(context.locator === undefined ? {} : { locator: context.locator }) } })
});
const contextualFailure = (code: string, relationId: RelationId, context: CandidateContext, path: readonly unknown[], details?: unknown): ParseResult<never> => ({ success: false, issues: [contextualIssue(code, relationId, context, path, details)] });
const addCandidateContext = (issue: Issue, relationId: RelationId, context: CandidateContext): Issue => ({
  ...issue,
  relationId,
  ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
  ...(context.locator === undefined ? {} : { details: { ...(isRecord(issue.details) ? issue.details : issue.details === undefined ? {} : { value: issue.details }), locator: context.locator } })
});
