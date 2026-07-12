import { canonicalizeJson, normalizeArtifactRef, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { ownedReadonlyMap } from './internal-owned-map.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { CapabilityRegistry } from './registry.js';
import { parseRelationCandidates, parseScalarValueForField, type ParsedCandidate, type PreparedRelation, type PreparedSchema, type RelationId, type RelationRow } from './schema.js';
import type { JsonValue, PortableValue } from './value.js';

export type StoragePath = readonly (string | number)[];
export type CollectionMapping =
  | { readonly kind: 'object-map'; readonly path: StoragePath; readonly absent: 'empty' | 'creatable' | 'invalid' }
  | { readonly kind: 'array'; readonly path: StoragePath; readonly absent: 'empty' | 'creatable' | 'invalid' };
export type KeyMapping =
  | { readonly kind: 'map-key'; readonly mirrorPath?: StoragePath; readonly onMismatch: 'reject' }
  | { readonly kind: 'field'; readonly path: StoragePath };
export type FieldMapping = {
  readonly path: StoragePath;
  readonly write: { readonly kind: 'replace'; readonly capability: CapabilityRef } | { readonly kind: 'read-only' };
};
export type RelationStorageMapping = {
  readonly collection: CollectionMapping;
  readonly keys: Readonly<Record<string, KeyMapping>>;
  readonly fields: Readonly<Record<string, FieldMapping>>;
};
export type StorageMappingBody = {
  readonly schema: ArtifactRef;
  readonly model: 'json-tree-v1';
  readonly relations: Readonly<Record<RelationId, RelationStorageMapping>>;
};

/** Sealed portable storage-mapping artifact with its typed body preserved. */
export type StorageMappingArtifact = TypedArtifact<'storage-mapping', StorageMappingBody>;

/** Seals a typed storage mapping without a `JsonValue` assertion at the call site. */
export const sealStorageMapping = (input: TypedArtifactInput<StorageMappingBody>): Promise<StorageMappingArtifact> => sealTypedArtifact('storage-mapping', input);

declare const compiledStorageMappingBrand: unique symbol;

export type CompiledStorageMapping = {
  /** Compile-time evidence that this value passed through `compileStorageMapping`. */
  readonly [compiledStorageMappingBrand]: true;
  readonly body: StorageMappingBody;
  readonly schema: PreparedSchema;
  readonly relations: ReadonlyMap<RelationId, { readonly relation: PreparedRelation; readonly mapping: RelationStorageMapping }>;
};

export type MappingLocator =
  | { readonly kind: 'object-map-key'; readonly key: string }
  | { readonly kind: 'array-position'; readonly index: number; readonly durable: false };

export type BoundRow = ParsedCandidate & { readonly locator: MappingLocator };
export type BoundRelation = {
  readonly relationId: RelationId;
  readonly rows: readonly BoundRow[];
  readonly rejectedLocators: readonly MappingLocator[];
  readonly issues: readonly Issue[];
  readonly completeness: 'exact' | 'unknown';
};
export type BindingProjection = {
  readonly relations: ReadonlyMap<RelationId, BoundRelation>;
  readonly issues: readonly Issue[];
  readonly completeness: 'exact' | 'unknown';
};

export type MappedStorageIntent = {
  readonly kind: 'replace';
  readonly path: StoragePath;
  readonly value: PortableValue;
  readonly capability: CapabilityRef;
};
export type StorageEditPlan = {
  readonly relationId: RelationId;
  readonly locator: MappingLocator;
  readonly readFootprint: readonly StoragePath[];
  readonly writeFootprint: readonly StoragePath[];
  readonly intents: readonly MappedStorageIntent[];
  readonly nextSnapshot: unknown;
};

export const compileStorageMapping = (
  input: unknown,
  schemaRef: ArtifactRef,
  schema: PreparedSchema,
  registry?: CapabilityRegistry
): ParseResult<CompiledStorageMapping> => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success) return owned;
  if (!isRecord(owned.value) || owned.value.model !== 'json-tree-v1' || !sameRef(owned.value.schema, schemaRef) || !isRecord(owned.value.relations)) return mappingFailure('mapping.invalid', [], { reason: 'shape_or_schema' });
  const body = owned.value as unknown as StorageMappingBody;
  const issues: Issue[] = [];
  const relations = new Map<RelationId, { relation: PreparedRelation; mapping: RelationStorageMapping }>();
  for (const [relationId, mapping] of Object.entries(body.relations)) {
    const relation = schema.relationsById.get(relationId);
    const path = ['relations', relationId];
    if (relation === undefined) { issues.push(mappingIssue('mapping.relation_missing', path, { relationId })); continue; }
    if (!isRelationMapping(mapping)) { issues.push(mappingIssue('mapping.relation_invalid', path)); continue; }
    const declaredKeys = new Set(relation.declaration.key);
    if (Object.keys(mapping.keys).length !== declaredKeys.size || Object.keys(mapping.keys).some((field) => !declaredKeys.has(field))) {
      issues.push(mappingIssue('mapping.keys_invalid', [...path, 'keys'], { expected: relation.declaration.key }));
      continue;
    }
    for (const [field, keyMapping] of Object.entries(mapping.keys)) {
      if (!isKeyMapping(keyMapping) || (keyMapping.kind === 'map-key' && mapping.collection.kind !== 'object-map')) issues.push(mappingIssue('mapping.key_invalid', [...path, 'keys', field]));
    }
    for (const [field, fieldMapping] of Object.entries(mapping.fields)) {
      if (!(field in relation.declaration.fields) || !isFieldMapping(fieldMapping)) issues.push(mappingIssue('mapping.field_invalid', [...path, 'fields', field]));
      else if (fieldMapping.write.kind === 'replace' && registry !== undefined && !registry.satisfies(fieldMapping.write.capability)) {
        issues.push(mappingIssue('mapping.capability_unavailable', [...path, 'fields', field, 'write'], { field }, [fieldMapping.write.capability]));
      }
    }
    for (const field of Object.keys(relation.declaration.fields)) {
      if (!(field in mapping.fields) && !(field in mapping.keys)) issues.push(mappingIssue('mapping.field_unmapped', [...path, 'fields', field], { field }));
    }
    relations.set(relationId, Object.freeze({ relation, mapping }));
  }
  return issues.length > 0 ? { success: false, issues } : {
    success: true,
    value: Object.freeze({ body, schema, relations: ownedReadonlyMap(relations) }) as CompiledStorageMapping,
    issues: []
  };
};

export const projectStorage = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  registry?: CapabilityRegistry,
  sourceId?: string
): BindingProjection => {
  const relations = new Map<RelationId, BoundRelation>();
  const allIssues: Issue[] = [];
  for (const [relationId, compiled] of binding.relations) {
    const extracted = extractCandidates(snapshot, compiled.mapping.collection, relationId, sourceId);
    const rawCandidates: { value: RelationRow; locator: MappingLocator }[] = [];
    const rejectedLocators: MappingLocator[] = [];
    const relationIssues = [...extracted.issues];
    for (const candidate of extracted.candidates) {
      const projected = projectCandidate(candidate, compiled.mapping, relationId, sourceId);
      if (projected.success) rawCandidates.push({ value: projected.value, locator: candidate.locator });
      else { rejectedLocators.push(candidate.locator); relationIssues.push(...projected.issues); }
    }
    const parsed = parseRelationCandidates(binding.schema, compiled.relation, rawCandidates, registry, sourceId === undefined ? {} : { sourceId });
    relationIssues.push(...parsed.issues);
    rejectedLocators.push(...parsed.rejected.flatMap((candidate) => candidate.locator === undefined ? [] : [candidate.locator as MappingLocator]));
    const rows = parsed.rows.map((row) => ({ row: row.row, key: row.key, locator: row.locator as MappingLocator }));
    const result: BoundRelation = {
      relationId,
      rows,
      rejectedLocators,
      issues: relationIssues,
      completeness: extracted.complete && parsed.completeness === 'exact' && rejectedLocators.length === 0 ? 'exact' : 'unknown'
    };
    relations.set(relationId, result);
    allIssues.push(...relationIssues);
  }
  return { relations, issues: allIssues, completeness: [...relations.values()].every((relation) => relation.completeness === 'exact') ? 'exact' : 'unknown' };
};

export const planStoragePatch = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  relationId: RelationId,
  locator: MappingLocator,
  edits: Readonly<Record<string, unknown>>,
  registry?: CapabilityRegistry,
  sourceId?: string
): ParseResult<StorageEditPlan> => {
  const compiled = binding.relations.get(relationId);
  if (compiled === undefined) return mappingFailure('mapping.relation_missing', [], { relationId });
  const located = locateCandidate(snapshot, compiled.mapping.collection, locator);
  if (!located.success) return located;
  const intents: MappedStorageIntent[] = [];
  const issues: Issue[] = [];
  let nextCandidate = located.value.candidate;
  for (const [field, input] of Object.entries(edits)) {
    if (field in compiled.mapping.keys) {
      issues.push(mappingIssue('mapping.rekey_required', [field], { field, relationId }, undefined, sourceId, relationId));
      continue;
    }
    const fieldMapping = compiled.mapping.fields[field];
    const declaration = compiled.relation.declaration.fields[field];
    if (fieldMapping === undefined || declaration === undefined || fieldMapping.write.kind === 'read-only') {
      issues.push(mappingIssue('mapping.field_read_only', [field], { field, relationId }, undefined, sourceId, relationId));
      continue;
    }
    if (registry !== undefined && !registry.satisfies(fieldMapping.write.capability)) {
      issues.push(mappingIssue('mapping.capability_unavailable', [field], { field }, [fieldMapping.write.capability], sourceId, relationId));
      continue;
    }
    const parsed = parseScalarValueForField(binding.schema, declaration, input, registry, [field]);
    if (!parsed.success) { issues.push(...parsed.issues); continue; }
    const set = setPath(nextCandidate, fieldMapping.path, parsed.value);
    if (!set.success) { issues.push(...set.issues); continue; }
    nextCandidate = set.value;
    intents.push({ kind: 'replace', path: [...located.value.absolutePath, ...fieldMapping.path], value: parsed.value, capability: fieldMapping.write.capability });
  }
  if (issues.length > 0) return { success: false, issues };
  const nextSnapshot = setPath(snapshot, located.value.absolutePath, nextCandidate);
  if (!nextSnapshot.success) return nextSnapshot;
  const readFootprint = [compiled.mapping.collection.path, ...Object.values(compiled.mapping.fields).map((field) => [...located.value.absolutePath, ...field.path])];
  return {
    success: true,
    value: { relationId, locator, readFootprint, writeFootprint: intents.map((intent) => intent.path), intents, nextSnapshot: nextSnapshot.value },
    issues: []
  };
};

type ExtractedCandidate = { readonly candidate: unknown; readonly locator: MappingLocator; readonly storageKey?: string; readonly absolutePath: StoragePath };

const extractCandidates = (snapshot: unknown, collection: CollectionMapping, relationId: RelationId, sourceId?: string): { candidates: readonly ExtractedCandidate[]; issues: readonly Issue[]; complete: boolean } => {
  const resolved = readPath(snapshot, collection.path);
  if (!resolved.present) {
    if (resolved.reason === 'inspection_failed') return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', collection.path, { reason: resolved.reason, error: resolved.error }, undefined, sourceId, relationId)], complete: false };
    if (collection.absent === 'empty' || collection.absent === 'creatable') return { candidates: [], issues: [], complete: true };
    return { candidates: [], issues: [mappingIssue('mapping.collection_absent', collection.path, { relationId }, undefined, sourceId, relationId)], complete: false };
  }
  if (collection.kind === 'array') {
    if (!Array.isArray(resolved.value)) return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', collection.path, { expected: 'array' }, undefined, sourceId, relationId)], complete: false };
    try {
      const descriptors = Object.getOwnPropertyDescriptors(resolved.value);
      const candidates: ExtractedCandidate[] = [];
      for (let index = 0; index < resolved.value.length; index += 1) {
        const descriptor = descriptors[index];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', [...collection.path, index], { reason: 'descriptor' }, undefined, sourceId, relationId)], complete: false };
        candidates.push({ candidate: descriptor.value, locator: { kind: 'array-position', index, durable: false }, absolutePath: [...collection.path, index] });
      }
      return { candidates, issues: [], complete: true };
    } catch (error) {
      return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', collection.path, { reason: 'inspection_threw', error: error instanceof Error ? error.name : typeof error }, undefined, sourceId, relationId)], complete: false };
    }
  }
  if (!isRecord(resolved.value)) return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', collection.path, { expected: 'object-map' }, undefined, sourceId, relationId)], complete: false };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(resolved.value);
    const candidates: ExtractedCandidate[] = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', [...collection.path, key], { reason: 'descriptor' }, undefined, sourceId, relationId)], complete: false };
      candidates.push({ candidate: descriptor.value, storageKey: key, locator: { kind: 'object-map-key', key }, absolutePath: [...collection.path, key] });
    }
    return { candidates, issues: [], complete: true };
  } catch (error) {
    return { candidates: [], issues: [mappingIssue('mapping.collection_invalid', collection.path, { reason: 'inspection_threw', error: error instanceof Error ? error.name : typeof error }, undefined, sourceId, relationId)], complete: false };
  }
};

const projectCandidate = (candidate: ExtractedCandidate, mapping: RelationStorageMapping, relationId: RelationId, sourceId?: string): ParseResult<RelationRow> => {
  if (!isRecord(candidate.candidate)) return mappingFailure('mapping.candidate_invalid', candidate.absolutePath, { relationId, locator: candidate.locator }, sourceId, relationId);
  const output: Record<string, PortableValue> = {};
  for (const [field, keyMapping] of Object.entries(mapping.keys)) {
    if (keyMapping.kind === 'map-key') {
      const storageKey = candidate.storageKey as string;
      if (keyMapping.mirrorPath !== undefined) {
        const mirror = readPath(candidate.candidate, keyMapping.mirrorPath);
        if (!mirror.present && mirror.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', [...candidate.absolutePath, ...keyMapping.mirrorPath], { reason: mirror.reason, error: mirror.error, locator: candidate.locator }, sourceId, relationId);
        if (!mirror.present || !samePortableCandidate(mirror.value, storageKey)) return mappingFailure('mapping.map_key_mismatch', [...candidate.absolutePath, ...keyMapping.mirrorPath], { field, mapKey: storageKey, mirror: mirror.present ? mirror.value : 'missing', locator: candidate.locator }, sourceId, relationId, 'manual_repair');
      }
      output[field] = storageKey;
    } else {
      const value = readPath(candidate.candidate, keyMapping.path);
      if (!value.present && value.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', [...candidate.absolutePath, ...keyMapping.path], { reason: value.reason, error: value.error, locator: candidate.locator }, sourceId, relationId);
      if (value.present) output[field] = value.value as PortableValue;
    }
  }
  for (const [field, fieldMapping] of Object.entries(mapping.fields)) {
    const value = readPath(candidate.candidate, fieldMapping.path);
    if (!value.present && value.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', [...candidate.absolutePath, ...fieldMapping.path], { reason: value.reason, error: value.error, locator: candidate.locator }, sourceId, relationId);
    if (value.present) output[field] = value.value as PortableValue;
  }
  return { success: true, value: output, issues: [] };
};

const locateCandidate = (snapshot: unknown, collection: CollectionMapping, locator: MappingLocator): ParseResult<{ candidate: unknown; absolutePath: StoragePath }> => {
  if ((collection.kind === 'object-map' && locator.kind !== 'object-map-key') || (collection.kind === 'array' && locator.kind !== 'array-position')) return mappingFailure('mapping.locator_invalid', collection.path);
  const member = locator.kind === 'object-map-key' ? locator.key : locator.index;
  const absolutePath = [...collection.path, member];
  const found = readPath(snapshot, absolutePath);
  if (found.present) return { success: true, value: { candidate: found.value, absolutePath }, issues: [] };
  return found.reason === 'inspection_failed'
    ? mappingFailure('mapping.locator_invalid', absolutePath, { reason: found.reason, error: found.error })
    : mappingFailure('mapping.locator_stale', absolutePath);
};

type PathRead =
  | { readonly present: true; readonly value: unknown }
  | { readonly present: false; readonly reason: 'absent' }
  | { readonly present: false; readonly reason: 'inspection_failed'; readonly error: string };

const readPath = (root: unknown, path: StoragePath): PathRead => {
  let value = root;
  try {
    for (const member of path) {
      if ((typeof member === 'number' && !Array.isArray(value)) || (typeof member === 'string' && !isRecord(value)) || !Object.hasOwn(value as object, member)) return { present: false, reason: 'absent' };
      const descriptor = Object.getOwnPropertyDescriptor(value as object, member);
      if (descriptor === undefined || !('value' in descriptor)) return { present: false, reason: 'absent' };
      value = descriptor.value;
    }
    return { present: true, value };
  } catch (error) {
    return { present: false, reason: 'inspection_failed', error: error instanceof Error ? error.name : typeof error };
  }
};

const setPath = (root: unknown, path: StoragePath, value: unknown): ParseResult<unknown> => {
  if (path.length === 0) return { success: true, value, issues: [] };
  const [head, ...tail] = path;
  try {
    if (Array.isArray(root) && typeof head === 'number' && Number.isInteger(head) && head >= 0 && (head < root.length || (head === root.length && tail.length === 0))) {
      const copied = copyDataArray(root);
      if (copied === undefined) return mappingFailure('mapping.path_invalid', path, { reason: 'descriptor' });
      if (tail.length === 0) { copied[head] = value; return { success: true, value: copied, issues: [] }; }
      const descriptor = Object.getOwnPropertyDescriptor(root, head);
      if (descriptor === undefined || !('value' in descriptor)) return mappingFailure('mapping.path_invalid', path, { reason: 'descriptor' });
      const child = setPath(descriptor.value, tail, value);
      if (!child.success) return child;
      copied[head] = child.value;
      return { success: true, value: copied, issues: [] };
    }
    if (isRecord(root) && typeof head === 'string' && (Object.hasOwn(root, head) || tail.length === 0)) {
      const copied = copyDataRecord(root);
      if (copied === undefined) return mappingFailure('mapping.path_invalid', path, { reason: 'descriptor' });
      if (tail.length === 0) { copied[head] = value; return { success: true, value: copied, issues: [] }; }
      const descriptor = Object.getOwnPropertyDescriptor(root, head);
      if (descriptor === undefined || !('value' in descriptor)) return mappingFailure('mapping.path_invalid', path, { reason: 'descriptor' });
      const child = setPath(descriptor.value, tail, value);
      if (!child.success) return child;
      copied[head] = child.value;
      return { success: true, value: copied, issues: [] };
    }
    return mappingFailure('mapping.path_invalid', path);
  } catch (error) {
    return mappingFailure('mapping.path_invalid', path, { reason: 'inspection_threw', error: error instanceof Error ? error.name : typeof error });
  }
};

const copyDataArray = (value: readonly unknown[]): unknown[] | undefined => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
};

const copyDataRecord = (value: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable) continue;
    if (!('value' in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
};

const samePortableCandidate = (left: unknown, right: unknown): boolean => {
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};
const sameRef = (value: unknown, expected: ArtifactRef): boolean => isRecord(value) && typeof value.id === 'string' && typeof value.contentHash === 'string' && JSON.stringify(normalizeArtifactRef(value as ArtifactRef)) === JSON.stringify(normalizeArtifactRef(expected));
const isRelationMapping = (value: unknown): value is RelationStorageMapping => isRecord(value) && isCollectionMapping(value.collection) && isRecord(value.keys) && isRecord(value.fields);
const isCollectionMapping = (value: unknown): value is CollectionMapping => isRecord(value) && (value.kind === 'object-map' || value.kind === 'array') && isStoragePath(value.path) && (value.absent === 'empty' || value.absent === 'creatable' || value.absent === 'invalid');
const isKeyMapping = (value: unknown): value is KeyMapping => isRecord(value) && ((value.kind === 'map-key' && (value.mirrorPath === undefined || isStoragePath(value.mirrorPath)) && value.onMismatch === 'reject') || (value.kind === 'field' && isStoragePath(value.path)));
const isFieldMapping = (value: unknown): value is FieldMapping => isRecord(value) && isStoragePath(value.path) && isRecord(value.write) && (value.write.kind === 'read-only' || (value.write.kind === 'replace' && isCapabilityRef(value.write.capability)));
const isStoragePath = (value: unknown): value is StoragePath => Array.isArray(value) && value.every((member) => typeof member === 'string' || (typeof member === 'number' && Number.isInteger(member) && member >= 0));
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string' && typeof value.contractHash === 'string';
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const mappingIssue = (code: string, path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], sourceId?: string, relationId?: string, retry: 'after_input' | 'after_capability' | 'manual_repair' = requiredCapabilities === undefined ? 'after_input' : 'after_capability'): Issue => createIssue({
  code, phase: code.startsWith('mapping.capability') ? 'resolve' : 'parse', severity: 'error', retry, path,
  ...(details === undefined ? {} : { details }), ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }), ...(sourceId === undefined ? {} : { sourceId }), ...(relationId === undefined ? {} : { relationId })
});
const mappingFailure = (code: string, path: readonly unknown[], details?: unknown, sourceId?: string, relationId?: string, retry?: 'after_input' | 'after_capability' | 'manual_repair'): ParseResult<never> => ({ success: false, issues: [mappingIssue(code, path, details, undefined, sourceId, relationId, retry)] });
