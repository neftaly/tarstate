import {
  checkSemanticNameBudget,
  isSemanticRecord,
  semanticEnumValue,
  semanticInvalid,
  semanticShape,
  validateSemanticArtifactRef,
  validateSemanticCapabilityRef,
  type SemanticValidationContext
} from './internal-semantic-artifact-validation.js';
import type { JsonValue } from './value.js';

export const validateStorageMappingArtifactBody = (
  context: SemanticValidationContext,
  body: JsonValue
): boolean => {
  if (!semanticShape(context, body, ['schema', 'model', 'relations'], [], ['body'])) {
    return false;
  }
  validateSemanticArtifactRef(context, body.schema, ['body', 'schema']);
  if (body.model !== 'json-tree-v1') {
    semanticInvalid(context, ['body', 'model'], 'unsupported_mapping_model');
  }
  if (!isSemanticRecord(body.relations)) {
    semanticInvalid(context, ['body', 'relations'], 'record_required');
    return false;
  }
  checkSemanticNameBudget(context, Object.keys(body.relations).length, ['body', 'relations']);
  for (const [relationId, mapping] of Object.entries(body.relations)) {
    validateRelationMapping(context, relationId, mapping, ['body', 'relations', relationId]);
  }
  return context.issues.length === 0;
};

const validateRelationMapping = (
  context: SemanticValidationContext,
  relationId: string,
  input: JsonValue,
  path: readonly unknown[]
): void => {
  if (relationId.length === 0) {
    semanticInvalid(context, path, 'empty_relation_id');
    return;
  }
  if (!semanticShape(context, input, ['collection', 'keys', 'fields'], [], path)) return;
  validateCollectionMapping(context, input.collection, [...path, 'collection']);
  if (!isSemanticRecord(input.keys)) {
    semanticInvalid(context, [...path, 'keys'], 'record_required');
  } else {
    for (const [name, key] of Object.entries(input.keys)) {
      validateKeyMapping(context, key, [...path, 'keys', name]);
    }
  }
  if (!isSemanticRecord(input.fields)) {
    semanticInvalid(context, [...path, 'fields'], 'record_required');
  } else {
    for (const [name, field] of Object.entries(input.fields)) {
      validateFieldMapping(context, field, [...path, 'fields', name]);
    }
  }
  if (isSemanticRecord(input.keys) && isSemanticRecord(input.fields)) {
    for (const name of Object.keys(input.keys)) {
      if (Object.hasOwn(input.fields, name)) {
        semanticInvalid(context, path, 'key_field_mapped_twice', { field: name });
      }
    }
  }
};

const validateCollectionMapping = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): void => {
  if (!isSemanticRecord(input)) {
    semanticInvalid(context, path, 'collection_mapping_shape');
    return;
  }
  if (input.kind === 'recursive-array') {
    if (!semanticShape(
      context,
      input,
      [
        'kind',
        'path',
        'descendants',
        'absent',
        'maxDepth',
        'maxRows',
        'maxTraversalSteps'
      ],
      [],
      path
    )) return;
    validateStoragePath(context, input.path, [...path, 'path']);
    validateStoragePath(context, input.descendants, [...path, 'descendants']);
    if (Array.isArray(input.descendants) && input.descendants.length === 0) {
      semanticInvalid(context, [...path, 'descendants'], 'empty_storage_path');
    }
    semanticEnumValue(context, input.absent, ['empty', 'invalid'], [
      ...path,
      'absent'
    ]);
    validateBound(context, input.maxDepth, [...path, 'maxDepth'], true);
    validateBound(context, input.maxRows, [...path, 'maxRows'], false);
    validateBound(
      context,
      input.maxTraversalSteps,
      [...path, 'maxTraversalSteps'],
      false
    );
    return;
  }
  if (!semanticShape(context, input, ['kind', 'path', 'absent'], [], path)) return;
  semanticEnumValue(context, input.kind, ['object-map', 'array', 'singleton'], [
    ...path,
    'kind'
  ]);
  validateStoragePath(context, input.path, [...path, 'path']);
  semanticEnumValue(
    context,
    input.absent,
    input.kind === 'singleton' ? ['empty', 'invalid'] : ['empty', 'creatable', 'invalid'],
    [...path, 'absent']
  );
};

const validateKeyMapping = (
  context: SemanticValidationContext,
  input: JsonValue,
  path: readonly unknown[]
): void => {
  if (!isSemanticRecord(input) || typeof input.kind !== 'string') {
    semanticInvalid(context, path, 'key_mapping_shape');
    return;
  }
  if (input.kind === 'map-key') {
    semanticShape(context, input, ['kind', 'onMismatch'], ['mirrorPath'], path);
    if (input.onMismatch !== 'reject') {
      semanticInvalid(context, [...path, 'onMismatch'], 'map_key_mismatch_policy');
    }
    if (input.mirrorPath !== undefined) {
      validateStoragePath(context, input.mirrorPath, [...path, 'mirrorPath']);
    }
    return;
  }
  if (input.kind === 'field') {
    semanticShape(context, input, ['kind', 'path'], [], path);
    validateStoragePath(context, input.path, [...path, 'path']);
    return;
  }
  if (input.kind === 'source-metadata') {
    validateSourceMetadataMapping(context, input, path);
    return;
  }
  if (input.kind === 'literal') {
    semanticShape(context, input, ['kind', 'value'], [], path);
    return;
  }
  semanticInvalid(context, [...path, 'kind'], 'unknown_key_mapping');
};

const validateFieldMapping = (
  context: SemanticValidationContext,
  input: JsonValue,
  path: readonly unknown[]
): void => {
  if (isSemanticRecord(input) && input.kind === 'absent') {
    semanticShape(context, input, ['kind'], [], path);
    return;
  }
  if (isSemanticRecord(input) && input.kind === 'source-metadata') {
    validateSourceMetadataMapping(context, input, path);
    return;
  }
  if (!semanticShape(context, input, ['path', 'write'], [], path)) return;
  validateStoragePath(context, input.path, [...path, 'path']);
  if (!isSemanticRecord(input.write)) {
    semanticInvalid(context, [...path, 'write'], 'write_mapping_shape');
    return;
  }
  if (!semanticShape(context, input.write, [], ['replace', 'textSplice'], [...path, 'write'])) return;
  if (input.write.replace !== undefined) {
    validateSemanticCapabilityRef(context, input.write.replace, [...path, 'write', 'replace']);
  }
  if (input.write.textSplice !== undefined) {
    validateSemanticCapabilityRef(context, input.write.textSplice, [...path, 'write', 'textSplice']);
  }
};

const validateSourceMetadataMapping = (
  context: SemanticValidationContext,
  input: Readonly<Record<string, JsonValue>>,
  path: readonly unknown[]
): void => {
  if (!semanticShape(context, input, ['kind', 'value'], [], path)) return;
  semanticEnumValue(
    context,
    input.value,
    [
      'collection-position',
      'collection-element-identity',
      'recursive-parent-element-identity'
    ],
    [...path, 'value']
  );
};

const validateBound = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  allowZero: boolean
): void => {
  if (!Number.isSafeInteger(input)
    || typeof input !== 'number'
    || (allowZero ? input < 0 : input <= 0)) {
    semanticInvalid(context, path, allowZero
      ? 'non_negative_safe_integer_required'
      : 'positive_safe_integer_required');
  }
};

const validateStoragePath = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): void => {
  if (!Array.isArray(input) || input.some((part) => !isStoragePathPart(part))) {
    semanticInvalid(context, path, 'storage_path_invalid');
  }
};

const isStoragePathPart = (value: JsonValue): boolean =>
  (typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
