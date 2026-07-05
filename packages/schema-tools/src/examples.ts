import { canonicalSchemaManifest, type FieldManifestV1, type JsonObject, type JsonValue, type RefTarget, type SchemaManifestV1 } from '@tarstate/core/schema';
import { sortedEntries } from './names.js';

export type RelationExampleMap = Readonly<Record<string, JsonObject>>;

export function emitRelationExamples(input: SchemaManifestV1): RelationExampleMap {
  return emitRelationExamplesForCanonicalManifest(canonicalSchemaManifest(input));
}

export function emitRelationExamplesForCanonicalManifest(manifest: SchemaManifestV1): RelationExampleMap {
  const examples: Record<string, JsonObject> = {};
  for (const [relationName, relation] of sortedEntries(manifest.relations)) {
    const row: Record<string, JsonValue> = {};
    for (const [fieldName, field] of sortedEntries(relation.fields)) {
      if (field.optional === true) continue;
      row[fieldName] = exampleValueForField(manifest, relationName, fieldName, field, new Set<string>());
    }
    examples[relationName] = row;
  }
  return examples;
}

function exampleValueForField(
  manifest: SchemaManifestV1,
  relationName: string,
  fieldName: string,
  field: FieldManifestV1,
  activeRefs: Set<string>
): JsonValue {
  if (field.nullable === true) return null;
  switch (field.type) {
    case 'string':
      return `${fieldName}-example`;
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'id':
      return `${field.domain}:example`;
    case 'ref':
      return exampleRefValue(manifest, field.target, activeRefs);
    case 'anchoredPath':
      return `/${relationName}/${fieldName}`;
    case 'json':
      return {};
    case 'custom':
      return exampleCustomValue(manifest, field);
  }
}

function exampleRefValue(manifest: SchemaManifestV1, target: RefTarget, activeRefs: Set<string>): string {
  const targetId = `${target.relation}.${target.field}`;
  if (activeRefs.has(targetId)) return `${targetId}:example`;
  const targetField = manifest.relations[target.relation]?.fields[target.field];
  if (targetField === undefined) return `${targetId}:example`;
  activeRefs.add(targetId);
  const value = exampleValueForField(manifest, target.relation, target.field, targetField, activeRefs);
  activeRefs.delete(targetId);
  return typeof value === 'string' ? value : `${targetId}:example`;
}

function exampleCustomValue(manifest: SchemaManifestV1, field: Extract<FieldManifestV1, { readonly type: 'custom' }>): JsonValue {
  const scalar = manifest.codecs?.[field.codec]?.scalar;
  switch (scalar) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'string':
    case undefined:
      return `${field.codec}:example`;
  }
}
