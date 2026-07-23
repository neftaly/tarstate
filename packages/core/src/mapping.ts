import { normalizeArtifactRef, type ArtifactRef } from './artifacts.js';
import { isContentHash } from './canonical-json.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { samePortableJson } from './internal-json-equality.js';
import { ownedReadonlyMap } from './internal-owned-map.js';
import {
  inspectDataArray,
  readDataPath,
  traverseRecursiveArray,
  type RecursiveArrayProblem
} from './internal-recursive-array.js';
import { assertCompiledStorageMapping, assertPreparedSchema, sealCompiledStorageMapping } from './internal-semantic-provenance.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { CapabilityRegistry } from './registry.js';
import { parseProjectedRelationCandidates, parseRelationCandidates, parseScalarValueForField, type FieldDeclaration, type ParsedCandidate, type PreparedRelation, type PreparedSchema, type RelationId, type RelationRow } from './schema.js';
import type { PortableValue } from './value.js';

export type StoragePath = readonly (string | number)[];
export type RecursiveArrayCollectionMapping = {
  readonly kind: 'recursive-array';
  readonly path: StoragePath;
  readonly descendants: StoragePath;
  readonly absent: 'empty' | 'invalid';
  /** Root elements have depth zero. */
  readonly maxDepth: number;
  readonly maxRows: number;
  readonly maxTraversalSteps: number;
};
export type CollectionMapping =
  | { readonly kind: 'object-map'; readonly path: StoragePath; readonly absent: 'empty' | 'creatable' | 'invalid' }
  | { readonly kind: 'array'; readonly path: StoragePath; readonly absent: 'empty' | 'creatable' | 'invalid' }
  | { readonly kind: 'singleton'; readonly path: StoragePath; readonly absent: 'empty' | 'invalid' }
  | RecursiveArrayCollectionMapping;
export type KeyMapping =
  | { readonly kind: 'map-key'; readonly mirrorPath?: StoragePath; readonly onMismatch: 'reject' }
  | { readonly kind: 'field'; readonly path: StoragePath }
  | SourceMetadataMapping
  | { readonly kind: 'literal'; readonly value: PortableValue };
export type SourceMetadataMapping = {
  readonly kind: 'source-metadata';
  readonly value:
    | 'collection-position'
    | 'collection-element-identity'
    | 'recursive-parent-element-identity';
};
export type StoredFieldWriteMapping = {
  readonly replace?: CapabilityRef;
  readonly textSplice?: CapabilityRef;
};
export type StoredFieldMapping = {
  readonly kind?: never;
  readonly path: StoragePath;
  /** Operations the physical field can represent. An empty object is read-only. */
  readonly write: StoredFieldWriteMapping;
};
export type AbsentFieldMapping = { readonly kind: 'absent' };
export type FieldMapping = StoredFieldMapping | AbsentFieldMapping | SourceMetadataMapping;
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
  | {
      readonly kind: 'recursive-array-position';
      readonly collectionPath: StoragePath;
      readonly index: number;
      readonly depth: number;
      readonly durable: false;
    }
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

export type SourceMetadataResolverInput = {
  readonly value:
    | 'collection-element-identity'
    | 'recursive-parent-element-identity';
  readonly candidate: unknown;
  readonly parentCandidate?: unknown;
  readonly locator: MappingLocator;
  readonly relationId: RelationId;
  readonly field: string;
  readonly path: StoragePath;
};

/** Adapter boundary for source facts that portable JSON storage cannot derive. */
export type SourceMetadataResolver = (
  input: SourceMetadataResolverInput
) => unknown;

export type ProjectStorageOptions = {
  readonly registry?: CapabilityRegistry;
  readonly sourceId?: string;
  readonly relationIds?: ReadonlySet<RelationId>;
  readonly fieldsByRelation?: ReadonlyMap<RelationId, ReadonlySet<string>>;
  readonly scalarDecoder?: StorageScalarDecoder;
  readonly sourceMetadata?: SourceMetadataResolver;
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
        || (keyMapping.kind === 'literal' && mapping.collection.kind !== 'singleton')
        || (keyMapping.kind === 'source-metadata'
          && keyMapping.value !== 'collection-element-identity')) {
        issues.push(mappingIssue('mapping.key_invalid', [...path, 'keys', field]));
      }
    }
    for (const [field, fieldMapping] of Object.entries(mapping.fields)) {
      const declaration = relation.declaration.fields[field];
      if (declaration === undefined || !isFieldMapping(fieldMapping)) {
        issues.push(mappingIssue('mapping.field_invalid', [...path, 'fields', field]));
      } else if (fieldMapping.kind === 'absent' && declaration.optional !== true) {
        issues.push(mappingIssue('mapping.field_invalid', [...path, 'fields', field], {
          field,
          reason: 'required_field_absent'
        }));
      } else if (fieldMapping.kind === 'source-metadata'
        && fieldMapping.value === 'collection-position'
        && mapping.collection.kind !== 'array'
        && mapping.collection.kind !== 'recursive-array') {
        issues.push(mappingIssue('mapping.field_invalid', [...path, 'fields', field], {
          field,
          reason: 'collection_position_requires_array'
        }));
      } else if (fieldMapping.kind === 'source-metadata'
        && fieldMapping.value === 'recursive-parent-element-identity'
        && (mapping.collection.kind !== 'recursive-array'
          || declaration.nullable !== true)) {
        issues.push(mappingIssue('mapping.field_invalid', [...path, 'fields', field], {
          field,
          reason: mapping.collection.kind !== 'recursive-array'
            ? 'recursive_parent_requires_recursive_array'
            : 'recursive_parent_requires_nullable_field'
        }));
      } else if (fieldMapping.kind !== 'absent'
        && fieldMapping.kind !== 'source-metadata'
        && registry !== undefined) {
        for (const [operation, capability] of Object.entries(fieldMapping.write)) {
          if (!registry.satisfies(capability)) {
            issues.push(mappingIssue(
              'mapping.capability_unavailable',
              [...path, 'fields', field, 'write', operation],
              { field, operation },
              [capability]
            ));
          }
        }
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
  let completeness: BindingProjection['completeness'] = 'exact';
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
    const selectedFields = options.fieldsByRelation?.get(relationId);
    const parsed = selectedFields === undefined
      ? parseRelationCandidates(binding.schema, compiled.relation, rawCandidates, options.registry, options.sourceId === undefined ? {} : { sourceId: options.sourceId })
      : parseProjectedRelationCandidates(
          binding.schema,
          compiled.relation,
          rawCandidates,
          selectedFields,
          options.registry,
          options.sourceId === undefined ? {} : { sourceId: options.sourceId }
        );
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
    if (result.completeness !== 'exact') completeness = 'unknown';
    allIssues.push(...relationIssues);
  }
  return Object.freeze({ relations: ownedReadonlyMap(relations), issues: Object.freeze(allIssues), completeness });
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
    if (fieldMapping === undefined || declaration === undefined
      || fieldMapping.kind === 'absent'
      || fieldMapping.kind === 'source-metadata'
      || fieldMapping.write.replace === undefined) {
      issues.push(mappingIssue('mapping.field_read_only', [field], { field, relationId }, undefined, sourceId, relationId));
      continue;
    }
    const replaceCapability = fieldMapping.write.replace;
    if (registry !== undefined && !registry.satisfies(replaceCapability)) {
      issues.push(mappingIssue('mapping.capability_unavailable', [field], { field, operation: 'replace' }, [replaceCapability], sourceId, relationId));
      continue;
    }
    const parsed = parseScalarValueForField(binding.schema, declaration, input, registry, [field]);
    if (!parsed.success) { issues.push(...parsed.issues); continue; }
    const set = setPath(nextCandidate, fieldMapping.path, parsed.value);
    if (!set.success) { issues.push(...set.issues); continue; }
    nextCandidate = set.value;
    intents.push({ kind: 'replace', path: [...located.value.absolutePath, ...fieldMapping.path], value: parsed.value, capability: replaceCapability });
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

type ExtractedCandidate = {
  readonly candidate: unknown;
  readonly parentCandidate?: unknown;
  readonly locator: MappingLocator;
  readonly storageKey?: string;
  readonly absolutePath: StoragePath;
};

const extractCandidates = (snapshot: unknown, collection: CollectionMapping, relationId: RelationId, sourceId?: string): { candidates: readonly ExtractedCandidate[]; issues: readonly Issue[]; complete: boolean } => {
  const resolved = readDataPath(snapshot, collection.path);
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
    const inspected = inspectDataArray(resolved.value, collection.path);
    if (!inspected.success) {
      return {
        candidates: [],
        issues: [mappingIssue(
          'mapping.collection_invalid',
          inspected.path,
          inspected.details,
          undefined,
          sourceId,
          relationId
        )],
        complete: false
      };
    }
    return {
      candidates: inspected.values.map((candidate, index) => ({
        candidate,
        locator: { kind: 'array-position', index, durable: false },
        absolutePath: [...collection.path, index]
      })),
      issues: [],
      complete: true
    };
  }
  if (collection.kind === 'recursive-array') {
    if (!Array.isArray(resolved.value)) {
      return {
        candidates: [],
        issues: [mappingIssue(
          'mapping.collection_invalid',
          collection.path,
          { expected: 'array' },
          undefined,
          sourceId,
          relationId
        )],
        complete: false
      };
    }
    return extractRecursiveArrayCandidates(
      resolved.value,
      collection,
      relationId,
      sourceId
    );
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

const extractRecursiveArrayCandidates = (
  root: readonly unknown[],
  collection: RecursiveArrayCollectionMapping,
  relationId: RelationId,
  sourceId?: string
): {
  readonly candidates: readonly ExtractedCandidate[];
  readonly issues: readonly Issue[];
  readonly complete: boolean;
} => {
  const traversed = traverseRecursiveArray(root, collection);
  return {
    candidates: traversed.occurrences,
    issues: traversed.problems.map((problem) => mappingIssue(
      recursiveProblemCode(problem),
      problem.path,
      problem.code === 'collection-absent'
        ? { ...problem.details, relationId }
        : problem.details,
      undefined,
      sourceId,
      relationId
    )),
    complete: traversed.complete
  };
};

const recursiveProblemCode = (problem: RecursiveArrayProblem): string => {
  switch (problem.code) {
    case 'collection-absent':
      return 'mapping.collection_absent';
    case 'collection-invalid':
      return 'mapping.collection_invalid';
    case 'recursive-limit-exceeded':
      return 'mapping.recursive_limit_exceeded';
    case 'recursive-not-tree':
      return 'mapping.recursive_not_tree';
  }
};

const isRecursiveLocatorFor = (
  collection: RecursiveArrayCollectionMapping,
  locator: Extract<MappingLocator, {
    readonly kind: 'recursive-array-position';
  }>
): boolean => {
  if (!isStoragePath(locator.collectionPath)
    || !Number.isSafeInteger(locator.index)
    || locator.index < 0
    || !Number.isSafeInteger(locator.depth)
    || locator.depth < 0
    || locator.depth > collection.maxDepth
    || locator.collectionPath.length
      !== collection.path.length
        + locator.depth * (collection.descendants.length + 1)) {
    return false;
  }
  for (let index = 0; index < collection.path.length; index += 1) {
    if (locator.collectionPath[index] !== collection.path[index]) return false;
  }
  let offset = collection.path.length;
  for (let depth = 0; depth < locator.depth; depth += 1) {
    const parentIndex = locator.collectionPath[offset];
    if (typeof parentIndex !== 'number') return false;
    offset += 1;
    for (const part of collection.descendants) {
      if (locator.collectionPath[offset] !== part) return false;
      offset += 1;
    }
  }
  return true;
};

const projectCandidate = (
  candidate: ExtractedCandidate,
  compiled: { readonly relation: PreparedRelation; readonly mapping: RelationStorageMapping },
  relationId: RelationId,
  options: ProjectStorageOptions
): ParseResult<RelationRow> => {
  if (!isRecord(candidate.candidate)) return mappingFailure('mapping.candidate_invalid', candidate.absolutePath, { relationId, locator: candidate.locator }, options.sourceId, relationId);
  const { mapping } = compiled;
  const selectedFields = options.fieldsByRelation?.get(relationId);
  const output: Record<string, PortableValue> = {};
  for (const [field, keyMapping] of Object.entries(mapping.keys)) {
    if (keyMapping.kind === 'map-key') {
      const storageKey = candidate.storageKey as string;
      if (keyMapping.mirrorPath !== undefined) {
        const mirror = readDataPath(candidate.candidate, keyMapping.mirrorPath);
        if (!mirror.present && mirror.reason === 'inspection_failed') return mappingFailure('mapping.candidate_invalid', [...candidate.absolutePath, ...keyMapping.mirrorPath], { reason: mirror.reason, error: mirror.error, locator: candidate.locator }, options.sourceId, relationId);
        if (!mirror.present || !samePortableJson(mirror.value, storageKey)) return mappingFailure('mapping.map_key_mismatch', [...candidate.absolutePath, ...keyMapping.mirrorPath], { field, mapKey: storageKey, mirror: mirror.present ? mirror.value : 'missing', locator: candidate.locator }, options.sourceId, relationId, 'manual_repair');
      }
      output[field] = storageKey;
    } else if (keyMapping.kind === 'literal') {
      output[field] = keyMapping.value;
    } else if (keyMapping.kind === 'source-metadata') {
      const projected = projectSourceMetadata(candidate, keyMapping, compiled, relationId, field, options);
      if (!projected.success) return projected;
      output[field] = projected.value as PortableValue;
    } else {
      const value = readDataPath(candidate.candidate, keyMapping.path);
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
    if (selectedFields !== undefined && !selectedFields.has(field)) continue;
    if (fieldMapping.kind === 'absent') continue;
    if (fieldMapping.kind === 'source-metadata') {
      const projected = projectSourceMetadata(candidate, fieldMapping, compiled, relationId, field, options);
      if (!projected.success) return projected;
      output[field] = projected.value as PortableValue;
      continue;
    }
    const value = readDataPath(candidate.candidate, fieldMapping.path);
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

const projectSourceMetadata = (
  candidate: ExtractedCandidate,
  mapping: SourceMetadataMapping,
  compiled: { readonly relation: PreparedRelation },
  relationId: RelationId,
  field: string,
  options: ProjectStorageOptions
): ParseResult<unknown> => {
  let value: unknown;
  if (mapping.value === 'collection-position') {
    if (candidate.locator.kind !== 'array-position'
      && candidate.locator.kind !== 'recursive-array-position') {
      return mappingFailure('mapping.source_metadata_unavailable', candidate.absolutePath, {
        field,
        value: mapping.value
      }, options.sourceId, relationId);
    }
    value = candidate.locator.index;
  } else if (mapping.value === 'recursive-parent-element-identity'
    && candidate.parentCandidate === undefined) {
    value = null;
  } else {
    if (options.sourceMetadata === undefined) {
      return mappingFailure('mapping.source_metadata_unavailable', candidate.absolutePath, {
        field,
        value: mapping.value
      }, options.sourceId, relationId);
    }
    try {
      value = options.sourceMetadata({
        value: mapping.value,
        candidate: candidate.candidate,
        ...(candidate.parentCandidate === undefined
          ? {}
          : { parentCandidate: candidate.parentCandidate }),
        locator: candidate.locator,
        relationId,
        field,
        path: candidate.absolutePath
      });
      if (value === undefined) {
        return mappingFailure('mapping.source_metadata_unavailable', candidate.absolutePath, {
          field,
          value: mapping.value
        }, options.sourceId, relationId);
      }
    } catch (error) {
      return mappingFailure('mapping.source_metadata_unavailable', candidate.absolutePath, {
        field,
        value: mapping.value,
        reason: 'resolver_threw',
        error: error instanceof Error ? error.name : typeof error
      }, options.sourceId, relationId);
    }
  }
  return decodeMappedValue(
    value,
    compiled.relation.declaration.fields[field],
    relationId,
    field,
    candidate.absolutePath,
    options
  );
};

const locateCandidate = (snapshot: unknown, collection: CollectionMapping, locator: MappingLocator): ParseResult<{ candidate: unknown; absolutePath: StoragePath }> => {
  if (collection.kind === 'singleton') {
    if (locator.kind !== 'singleton') return mappingFailure('mapping.locator_invalid', collection.path);
    const found = readDataPath(snapshot, collection.path);
    if (found.present) return { success: true, value: { candidate: found.value, absolutePath: collection.path }, issues: [] };
    return found.reason === 'inspection_failed'
      ? mappingFailure('mapping.locator_invalid', collection.path, { reason: found.reason, error: found.error })
      : mappingFailure('mapping.locator_stale', collection.path);
  }
  if (collection.kind === 'recursive-array') {
    if (locator.kind !== 'recursive-array-position'
      || !isRecursiveLocatorFor(collection, locator)) {
      return mappingFailure('mapping.locator_invalid', collection.path);
    }
    const absolutePath = [...locator.collectionPath, locator.index];
    const found = readDataPath(snapshot, absolutePath);
    if (found.present) {
      return {
        success: true,
        value: { candidate: found.value, absolutePath },
        issues: []
      };
    }
    return found.reason === 'inspection_failed'
      ? mappingFailure('mapping.locator_invalid', absolutePath, {
          reason: found.reason,
          error: found.error
        })
      : mappingFailure('mapping.locator_stale', absolutePath);
  }
  if ((collection.kind === 'object-map' && locator.kind !== 'object-map-key')
    || (collection.kind === 'array' && locator.kind !== 'array-position')) {
    return mappingFailure('mapping.locator_invalid', collection.path);
  }
  if (locator.kind === 'singleton'
    || locator.kind === 'recursive-array-position') {
    return mappingFailure('mapping.locator_invalid', collection.path);
  }
  const member = locator.kind === 'object-map-key' ? locator.key : locator.index;
  const absolutePath = [...collection.path, member];
  const found = readDataPath(snapshot, absolutePath);
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
    if (isFieldMapping(field) && field.kind !== 'absent' && field.kind !== 'source-metadata') paths.push(field.path);
  }
  return Object.freeze(paths);
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
  && isStoragePath(value.path)
  && (value.kind === 'recursive-array'
    ? hasOnlyKeys(value, [
        'kind',
        'path',
        'descendants',
        'absent',
        'maxDepth',
        'maxRows',
        'maxTraversalSteps'
      ])
      && isStoragePath(value.descendants)
      && value.descendants.length > 0
      && (value.absent === 'empty' || value.absent === 'invalid')
      && isNonNegativeSafeInteger(value.maxDepth)
      && isPositiveSafeInteger(value.maxRows)
      && isPositiveSafeInteger(value.maxTraversalSteps)
    : hasOnlyKeys(value, ['kind', 'path', 'absent'])
      && (value.kind === 'singleton'
        ? value.absent === 'empty' || value.absent === 'invalid'
        : (value.kind === 'object-map' || value.kind === 'array')
          && (value.absent === 'empty'
            || value.absent === 'creatable'
            || value.absent === 'invalid')));
const isKeyMapping = (value: unknown): value is KeyMapping => isRecord(value) && (
  (value.kind === 'map-key' && hasOnlyKeys(value, ['kind', 'mirrorPath', 'onMismatch']) && (value.mirrorPath === undefined || isStoragePath(value.mirrorPath)) && value.onMismatch === 'reject')
  || (value.kind === 'field' && hasOnlyKeys(value, ['kind', 'path']) && isStoragePath(value.path))
  || isSourceMetadataMapping(value)
  || (value.kind === 'literal' && hasOnlyKeys(value, ['kind', 'value']) && Object.hasOwn(value, 'value'))
);
const isFieldMapping = (value: unknown): value is FieldMapping => isRecord(value) && (
  (value.kind === 'absent' && hasOnlyKeys(value, ['kind']))
  || isSourceMetadataMapping(value)
  || (value.kind === undefined
    && hasOnlyKeys(value, ['path', 'write'])
    && isStoragePath(value.path)
    && isRecord(value.write)
    && hasOnlyKeys(value.write, ['replace', 'textSplice'])
    && (value.write.replace === undefined || isCapabilityRef(value.write.replace))
    && (value.write.textSplice === undefined || isCapabilityRef(value.write.textSplice)))
);
const isSourceMetadataMapping = (value: Readonly<Record<string, unknown>>): value is SourceMetadataMapping =>
  value.kind === 'source-metadata'
  && hasOnlyKeys(value, ['kind', 'value'])
  && (value.value === 'collection-position'
    || value.value === 'collection-element-identity'
    || value.value === 'recursive-parent-element-identity');
const isStoragePath = (value: unknown): value is StoragePath => Array.isArray(value) && value.every((member) => (typeof member === 'string' && member.length > 0) || (typeof member === 'number' && Number.isSafeInteger(member) && member >= 0));
const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && hasOnlyKeys(value, ['id', 'version', 'contractHash']) && typeof value.id === 'string' && value.id.length > 0 && typeof value.version === 'string' && value.version.length > 0 && isContentHash(value.contractHash);
const hasOnlyKeys = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const mappingIssue = (code: string, path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], sourceId?: string, relationId?: string, retry: 'after_input' | 'after_capability' | 'manual_repair' = requiredCapabilities === undefined ? 'after_input' : 'after_capability'): Issue => createIssue({
  code, phase: code.startsWith('mapping.capability') ? 'resolve' : 'parse', severity: 'error', retry, path,
  ...(details === undefined ? {} : { details }), ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }), ...(sourceId === undefined ? {} : { sourceId }), ...(relationId === undefined ? {} : { relationId })
});
const mappingFailure = (code: string, path: readonly unknown[], details?: unknown, sourceId?: string, relationId?: string, retry?: 'after_input' | 'after_capability' | 'manual_repair'): ParseResult<never> => ({ success: false, issues: [mappingIssue(code, path, details, undefined, sourceId, relationId, retry)] });
