import {
  canonicalSchemaManifest,
  type FieldManifestV1,
  type JsonObject,
  type JsonValue,
  type RefTarget,
  type RelationManifestV1,
  type SchemaManifestV1
} from '@tarstate/core/schema';
import { recordFromEntries, sortedEntries } from './names.js';

export type RelationExampleMap = Readonly<Record<string, JsonObject>>;

export function emitRelationExamples(input: SchemaManifestV1): RelationExampleMap {
  return emitRelationExamplesForCanonicalManifest(canonicalSchemaManifest(input));
}

export function emitRelationExamplesForCanonicalManifest(manifest: SchemaManifestV1): RelationExampleMap {
  return recordFromEntries(
    sortedEntries(manifest.relations).map(([relationName, relation]) => [
      relationName,
      relationExample(manifest, relationName, relation)
    ])
  );
}

function relationExample(
  manifest: SchemaManifestV1,
  relationName: string,
  relation: RelationManifestV1
): JsonObject {
  return recordFromEntries(
    sortedEntries(relation.fields)
      .filter(([, field]) => field.optional !== true)
      .map(([fieldName, field]) => [
        fieldName,
        exampleValueForField(manifest, relationName, fieldName, field, new Set<string>())
      ])
  );
}

function exampleValueForField(
  manifest: SchemaManifestV1,
  relationName: string,
  fieldName: string,
  field: FieldManifestV1,
  activeRefs: ReadonlySet<string>
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

function exampleRefValue(manifest: SchemaManifestV1, target: RefTarget, activeRefs: ReadonlySet<string>): string {
  const targetId = `${target.relation}.${target.field}`;
  if (activeRefs.has(targetId)) return `${targetId}:example`;
  const targetField = manifest.relations[target.relation]?.fields[target.field];
  if (targetField === undefined) return `${targetId}:example`;
  const value = exampleValueForField(
    manifest,
    target.relation,
    target.field,
    targetField,
    new Set([...activeRefs, targetId])
  );
  return typeof value === 'string' ? value : `${targetId}:example`;
}

function exampleCustomValue(
  manifest: SchemaManifestV1,
  field: Extract<FieldManifestV1, { readonly type: 'custom' }>
): JsonValue {
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
