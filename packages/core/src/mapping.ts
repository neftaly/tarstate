import { normalizeArtifactRef, type ArtifactRef } from './artifacts.js';
import { isContentHash } from './canonical-json.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { samePortableJson } from './internal-json-equality.js';
import { ownedReadonlyMap } from './internal-owned-map.js';
import { assertCompiledStorageMapping, assertPreparedSchema, sealCompiledStorageMapping } from './internal-semantic-provenance.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { CapabilityRegistry } from './registry.js';
import { parseRelationCandidates, parseScalarValueForField, type FieldDeclaration, type ParsedCandidate, type PreparedRelation, type PreparedSchema, type RelationId, type RelationRow } from './schema.js';
import type { PortableValue } from './value.js';

export type StoragePath = readonly (string | number)[];
export type CollectionMapping =
  | { readonly kind: 'object-map'; readonly path: StoragePath; readonly absent: 'empty' | 'creatable' | 'invalid' }
  | { readonly kind: 'array'; readonly path: StoragePath; readonly absent: 'empty' | 'creatable' | 'invalid' }
  | { readonly kind: 'singleton'; readonly path: StoragePath; readonly absent: 'empty' | 'invalid' };
export type KeyMapping =
  | { readonly kind: 'map-key'; readonly mirrorPath?: StoragePath; readonly onMismatch: 'reject' }
  | { readonly kind: 'field'; readonly path: StoragePath }
  | { readonly kind: 'literal'; readonly value: PortableValue };
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
  readonly relations: ReadonlyMap<RelationId, {
    readonly relation: PreparedRelation;
    readonly mapping: RelationStorageMapping;
    readonly valuePaths: readonly StoragePath[];
  }>;
};

export type MappingLocator =
  | { readonly kind: 'object-map-key'; readonly key: string }
  | { readonly kind: 'array-position'; readonly index: number; readonly durable: false }
  | { readonly kind: 'singleton' };

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

export type StorageScalarCodecInput = {
  readonly value: unknown;
  readonly declaration: FieldDeclaration;
  readonly relationId: RelationId;
  readonly field: string;
  readonly path: StoragePath;
};

/** Read boundary from source-native scalar storage to canonical logical values. */
export type StorageScalarDecoder = (input: StorageScalarCodecInput) => ParseResult<unknown>;

export type ProjectStorageOptions = {
  readonly registry?: CapabilityRegistry;
  readonly sourceId?: string;
  readonly relationIds?: ReadonlySet<RelationId>;
  readonly scalarDecoder?: StorageScalarDecoder;
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
export type StorageIntentPlan = Omit<StorageEditPlan, 'nextSnapshot'>;

export const compileStorageMapping = (
  input: unknown,
  schemaRef: ArtifactRef,
  schema: PreparedSchema,
  registry?: CapabilityRegistry
): ParseResult<CompiledStorageMapping> => {
  assertPreparedSchema(schema);
  if (!isArtifactRef(schemaRef)) return mappingFailure('mapping.invalid', ['schema'], { reason: 'schema_ref' });
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success) return owned;
  if (!isRecord(owned.value) || !hasOnlyKeys(owned.value, ['schema', 'model', 'relations']) || owned.value.model !== 'json-tree-v1' || !isArtifactRef(owned.value.schema) || !sameRef(owned.value.schema, schemaRef) || !isRecord(owned.value.relations)) return mappingFailure('mapping.invalid', [], { reason: 'shape_or_schema' });
  const body = owned.value as unknown as StorageMappingBody;
  const issues: Issue[] = [];
  const relations = new Map<RelationId, {
    relation: PreparedRelation;
    mapping: RelationStorageMapping;
    valuePaths: readonly StoragePath[];
  }>();
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
      if (!isKeyMapping(keyMapping)
        || (keyMapping.kind === 'map-key' && mapping.collection.kind !== 'object-map')
        || (keyMapping.kind === 'literal' && mapping.collection.kind !== 'singleton')) {
        issues.push(mappingIssue('mapping.key_invalid', [...path, 'keys', field]));
      }
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
    relations.set(relationId, Object.freeze({ relation, mapping, valuePaths: mappedValuePaths(mapping) }));
  }
  return issues.length > 0 ? { success: false, issues } : {
    success: true,
    value: sealCompiledStorageMapping<CompiledStorageMapping>({ body, schema, relations: ownedReadonlyMap(relations) }),
    issues: []
  };
};

export const projectStorage = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  options: ProjectStorageOptions = {}
): BindingProjection => projectStorageRelations(binding, snapshot, options);

/** Projects only selected relations while preserving the same validation and ownership boundary. */
const projectStorageRelations = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  options: ProjectStorageOptions
): BindingProjection => {
  assertCompiledStorageMapping(binding);
  const relations = new Map<RelationId, BoundRelation>();
  const allIssues: Issue[] = [];
  for (const [relationId, compiled] of binding.relations) {
    if (options.relationIds !== undefined && !options.relationIds.has(relationId)) continue;
    const extracted = extractCandidates(snapshot, compiled.mapping.collection, relationId, options.sourceId);
    const rawCandidates: { value: RelationRow; locator: MappingLocator }[] = [];
    const rejectedLocators: MappingLocator[] = [];
    const relationIssues = [...extracted.issues];
    for (const candidate of extracted.candidates) {
      const projected = projectCandidate(candidate, compiled, relationId, options);
      if (projected.success) rawCandidates.push({ value: projected.value, locator: candidate.locator });
      else { rejectedLocators.push(candidate.locator); relationIssues.push(...projected.issues); }
    }
    const parsed = parseRelationCandidates(binding.schema, compiled.relation, rawCandidates, options.registry, options.sourceId === undefined ? {} : { sourceId: options.sourceId });
    relationIssues.push(...parsed.issues);
    rejectedLocators.push(...parsed.rejected.flatMap((candidate) => candidate.locator === undefined ? [] : [candidate.locator as MappingLocator]));
    const rows = parsed.rows.map((row) => ({ row: row.row, key: row.key, locator: row.locator as MappingLocator }));
    const result: BoundRelation = Object.freeze({
      relationId,
      rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, locator: Object.freeze({ ...row.locator }) }))),
      rejectedLocators: Object.freeze(rejectedLocators.map((locator) => Object.freeze({ ...locator }))),
      issues: Object.freeze(relationIssues),
      completeness: extracted.complete && parsed.completeness === 'exact' && rejectedLocators.length === 0 ? 'exact' : 'unknown'
    });
    relations.set(relationId, result);
    allIssues.push(...relationIssues);
  }
  return Object.freeze({ relations: ownedReadonlyMap(relations), issues: Object.freeze(allIssues), completeness: [...relations.values()].every((relation) => relation.completeness === 'exact') ? 'exact' : 'unknown' });
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
  const planned = planStorageIntentDetails(binding, snapshot, relationId, locator, edits, registry, sourceId);
  if (!planned.success) return planned;
  const nextSnapshot = setPath(snapshot, planned.value.absolutePath, planned.value.nextCandidate);
  if (!nextSnapshot.success) return nextSnapshot;
  const ownedNextSnapshot = detachAndFreezeJsonValue(nextSnapshot.value);
  if (!ownedNextSnapshot.success) return mappingFailure('mapping.path_invalid', [], { reason: 'non_portable_snapshot' });
  return {
    success: true,
    value: Object.freeze({ ...planned.value.plan, nextSnapshot: ownedNextSnapshot.value }),
    issues: []
  };
};

/**
 * Plans portable path intents without materializing and owning a complete next
 * storage snapshot. Sources should prefer this form and stage the intents in
 * their own immutable representation.
 */
export const planStorageIntents = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  relationId: RelationId,
  locator: MappingLocator,
  edits: Readonly<Record<string, unknown>>,
  registry?: CapabilityRegistry,
  sourceId?: string
): ParseResult<StorageIntentPlan> => {
  const planned = planStorageIntentDetails(binding, snapshot, relationId, locator, edits, registry, sourceId);
  return planned.success
    ? { success: true, value: planned.value.plan, issues: [] }
    : planned;
};

const planStorageIntentDetails = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  relationId: RelationId,
  locator: MappingLocator,
  edits: Readonly<Record<string, unknown>>,
  registry?: CapabilityRegistry,
  sourceId?: string
): ParseResult<{
  readonly plan: StorageIntentPlan;
  readonly absolutePath: StoragePath;
  readonly nextCandidate: unknown;
}> => {
  assertCompiledStorageMapping(binding);
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
  const readFootprint = [
    compiled.mapping.collection.path,
    ...compiled.valuePaths.map((path) => [...located.value.absolutePath, ...path])
  ];
  return {
    success: true,
    value: Object.freeze({
      plan: Object.freeze({
        relationId,
        locator: Object.freeze({ ...locator }),
        readFootprint: Object.freeze(readFootprint.map((path) => Object.freeze([...path]))),
        writeFootprint: Object.freeze(intents.map((intent) => intent.path)),
        intents: Object.freeze(intents.map((intent) => Object.freeze({ ...intent, path: Object.freeze([...intent.path]) })))
      }),
      absolutePath: Object.freeze([...located.value.absolutePath]),
      nextCandidate
    }),
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
  if (collection.kind === 'singleton') {
    return {
      candidates: [{ candidate: resolved.value, locator: { kind: 'singleton' }, absolutePath: collection.path }],
      issues: [],
      complete: true
    };
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

const projectCandidate = (
  candidate: ExtractedCandidate,
  compiled: { readonly relation: PreparedRelation; readonly mapping: RelationStorageMapping },
  relationId: RelationId,
  options: ProjectStorageOptions
): ParseResult<RelationRow> => {
  if (!isRecord(candidate.candidate)) return mappingFailure('mapping.candidate_invalid', candidate.absolutePath, { relationId, locator: candidate.locator }, options.sourceId, relationId);
  const { mapping } = compiled;
  const output: Record<string, PortableValue> = {};
  for (const [field, keyMapping] of Object.entries(mapping.keys)) {
    if (keyMapping.kind === 'map-key') {
      const storageKey = candidate.storageKey as string;
      if (keyMapping.mirrorPath !== undefined) {
        const mirror = readPath(candidate.candidate, keyMapping.mirrorPath);
        if (!mirror.present && mirror.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', [...candidate.absolutePath, ...keyMapping.mirrorPath], { reason: mirror.reason, error: mirror.error, locator: candidate.locator }, options.sourceId, relationId);
        if (!mirror.present || !samePortableJson(mirror.value, storageKey)) return mappingFailure('mapping.map_key_mismatch', [...candidate.absolutePath, ...keyMapping.mirrorPath], { field, mapKey: storageKey, mirror: mirror.present ? mirror.value : 'missing', locator: candidate.locator }, options.sourceId, relationId, 'manual_repair');
      }
      output[field] = storageKey;
    } else if (keyMapping.kind === 'literal') {
      output[field] = keyMapping.value;
    } else {
      const value = readPath(candidate.candidate, keyMapping.path);
      const path = [...candidate.absolutePath, ...keyMapping.path];
      if (!value.present && value.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', path, { reason: value.reason, error: value.error, locator: candidate.locator }, options.sourceId, relationId);
      if (value.present) {
        const decoded = decodeMappedValue(value.value, compiled.relation.declaration.fields[field], relationId, field, path, options);
        if (!decoded.success) return decoded;
        output[field] = decoded.value as PortableValue;
      }
    }
  }
  for (const [field, fieldMapping] of Object.entries(mapping.fields)) {
    const value = readPath(candidate.candidate, fieldMapping.path);
    const path = [...candidate.absolutePath, ...fieldMapping.path];
    if (!value.present && value.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', path, { reason: value.reason, error: value.error, locator: candidate.locator }, options.sourceId, relationId);
    if (value.present) {
      const decoded = decodeMappedValue(value.value, compiled.relation.declaration.fields[field], relationId, field, path, options);
      if (!decoded.success) return decoded;
      output[field] = decoded.value as PortableValue;
    }
  }
  return { success: true, value: output, issues: [] };
};

const locateCandidate = (snapshot: unknown, collection: CollectionMapping, locator: MappingLocator): ParseResult<{ candidate: unknown; absolutePath: StoragePath }> => {
  if (collection.kind === 'singleton') {
    if (locator.kind !== 'singleton') return mappingFailure('mapping.locator_invalid', collection.path);
    const found = readPath(snapshot, collection.path);
    if (found.present) return { success: true, value: { candidate: found.value, absolutePath: collection.path }, issues: [] };
    return found.reason === 'inspection_failed'
      ? mappingFailure('mapping.locator_invalid', collection.path, { reason: found.reason, error: found.error })
      : mappingFailure('mapping.locator_stale', collection.path);
  }
  if ((collection.kind === 'object-map' && locator.kind !== 'object-map-key')
    || (collection.kind === 'array' && locator.kind !== 'array-position')) {
    return mappingFailure('mapping.locator_invalid', collection.path);
  }
  if (locator.kind === 'singleton') return mappingFailure('mapping.locator_invalid', collection.path);
  const member = locator.kind === 'object-map-key' ? locator.key : locator.index;
  const absolutePath = [...collection.path, member];
  const found = readPath(snapshot, absolutePath);
  if (found.present) return { success: true, value: { candidate: found.value, absolutePath }, issues: [] };
  return found.reason === 'inspection_failed'
    ? mappingFailure('mapping.locator_invalid', absolutePath, { reason: found.reason, error: found.error })
    : mappingFailure('mapping.locator_stale', absolutePath);
};

const decodeMappedValue = (
  value: unknown,
  declaration: FieldDeclaration | undefined,
  relationId: RelationId,
  field: string,
  path: StoragePath,
  options: ProjectStorageOptions
): ParseResult<unknown> => {
  if (declaration === undefined || options.scalarDecoder === undefined) {
    return { success: true, value, issues: [] };
  }
  try {
    const decoded = options.scalarDecoder({ value, declaration, relationId, field, path });
    return decoded.success
      ? decoded
      : {
          success: false,
          issues: decoded.issues.map((issue) => createIssue({
            ...issue,
            path: [...path, ...(issue.path ?? [])],
            ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
            relationId
          }))
        };
  } catch (error) {
    return mappingFailure('mapping.candidate_invalid', path, {
      reason: 'decode_threw',
      error: error instanceof Error ? error.name : typeof error,
      field
    }, options.sourceId, relationId);
  }
};

const mappedValuePaths = (mapping: RelationStorageMapping): readonly StoragePath[] => {
  const paths: StoragePath[] = [];
  for (const key of Object.values(mapping.keys)) {
    if (!isKeyMapping(key)) continue;
    if (key.kind === 'field') paths.push(key.path);
    if (key.kind === 'map-key' && key.mirrorPath !== undefined) paths.push(key.mirrorPath);
  }
  for (const field of Object.values(mapping.fields)) {
    if (isFieldMapping(field)) paths.push(field.path);
  }
  return Object.freeze(paths);
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

const sameRef = (value: unknown, expected: ArtifactRef): boolean => isRecord(value) && typeof value.id === 'string' && typeof value.contentHash === 'string' && JSON.stringify(normalizeArtifactRef(value as ArtifactRef)) === JSON.stringify(normalizeArtifactRef(expected));
const isArtifactRef = (value: unknown): value is ArtifactRef => isRecord(value) && hasOnlyKeys(value, ['id', 'contentHash', 'locations']) && typeof value.id === 'string' && value.id.length > 0 && isContentHash(value.contentHash) && (value.locations === undefined || (Array.isArray(value.locations) && value.locations.every((location) => typeof location === 'string' && location.length > 0)));
const isRelationMapping = (value: unknown): value is RelationStorageMapping => isRecord(value) && hasOnlyKeys(value, ['collection', 'keys', 'fields']) && isCollectionMapping(value.collection) && isRecord(value.keys) && isRecord(value.fields);
const isCollectionMapping = (value: unknown): value is CollectionMapping => isRecord(value)
  && hasOnlyKeys(value, ['kind', 'path', 'absent'])
  && isStoragePath(value.path)
  && (value.kind === 'singleton'
    ? value.absent === 'empty' || value.absent === 'invalid'
    : (value.kind === 'object-map' || value.kind === 'array')
      && (value.absent === 'empty' || value.absent === 'creatable' || value.absent === 'invalid'));
const isKeyMapping = (value: unknown): value is KeyMapping => isRecord(value) && (
  (value.kind === 'map-key' && hasOnlyKeys(value, ['kind', 'mirrorPath', 'onMismatch']) && (value.mirrorPath === undefined || isStoragePath(value.mirrorPath)) && value.onMismatch === 'reject')
  || (value.kind === 'field' && hasOnlyKeys(value, ['kind', 'path']) && isStoragePath(value.path))
  || (value.kind === 'literal' && hasOnlyKeys(value, ['kind', 'value']) && Object.hasOwn(value, 'value'))
);
const isFieldMapping = (value: unknown): value is FieldMapping => isRecord(value) && hasOnlyKeys(value, ['path', 'write']) && isStoragePath(value.path) && isRecord(value.write) && ((value.write.kind === 'read-only' && hasOnlyKeys(value.write, ['kind'])) || (value.write.kind === 'replace' && hasOnlyKeys(value.write, ['kind', 'capability']) && isCapabilityRef(value.write.capability)));
const isStoragePath = (value: unknown): value is StoragePath => Array.isArray(value) && value.every((member) => (typeof member === 'string' && member.length > 0) || (typeof member === 'number' && Number.isSafeInteger(member) && member >= 0));
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && hasOnlyKeys(value, ['id', 'version', 'contractHash']) && typeof value.id === 'string' && value.id.length > 0 && typeof value.version === 'string' && value.version.length > 0 && isContentHash(value.contractHash);
const hasOnlyKeys = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const mappingIssue = (code: string, path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], sourceId?: string, relationId?: string, retry: 'after_input' | 'after_capability' | 'manual_repair' = requiredCapabilities === undefined ? 'after_input' : 'after_capability'): Issue => createIssue({
  code, phase: code.startsWith('mapping.capability') ? 'resolve' : 'parse', severity: 'error', retry, path,
  ...(details === undefined ? {} : { details }), ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }), ...(sourceId === undefined ? {} : { sourceId }), ...(relationId === undefined ? {} : { relationId })
});
const mappingFailure = (code: string, path: readonly unknown[], details?: unknown, sourceId?: string, relationId?: string, retry?: 'after_input' | 'after_capability' | 'manual_repair'): ParseResult<never> => ({ success: false, issues: [mappingIssue(code, path, details, undefined, sourceId, relationId, retry)] });
