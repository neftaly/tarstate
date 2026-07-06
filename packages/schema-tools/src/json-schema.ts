import {
  canonicalSchemaManifest,
  type CodecDeclarationV1,
  type FieldManifestV1,
  type JsonObject,
  type JsonValue,
  type RelationManifestV1,
  type SchemaManifestV1
} from '@tarstate/core/schema';
import { keyFields, recordFromEntries, sortedEntries } from './names.js';

export type JsonSchemaMap = Readonly<Record<string, JsonObject>>;

export function emitJsonSchemas(input: SchemaManifestV1): JsonSchemaMap {
  return emitJsonSchemasForCanonicalManifest(canonicalSchemaManifest(input));
}

export function emitJsonSchemasForCanonicalManifest(manifest: SchemaManifestV1): JsonSchemaMap {
  const codecs = manifest.codecs ?? {};
  return recordFromEntries(
    sortedEntries(manifest.relations).map(([relationName, relation]) => [
      relationName,
      jsonSchemaForRelation(manifest, relationName, relation, codecs)
    ])
  );
}

function jsonSchemaForRelation(
  manifest: SchemaManifestV1,
  relationName: string,
  relation: RelationManifestV1,
  codecs: Readonly<Record<string, CodecDeclarationV1>>
): JsonObject {
  return compactObject({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `tarstate:${encodeURIComponent(manifest.schemaId)}/${encodeURIComponent(relationName)}`,
    title: `${relationName} row`,
    type: 'object',
    additionalProperties: false,
    required: requiredFieldNames(relation),
    properties: relationProperties(relation, codecs),
    'x-tarstate-schema-id': manifest.schemaId,
    'x-tarstate-relation': relationName,
    'x-tarstate-key': keyFields(relation.key),
    ...(relation.description === undefined ? {} : { description: relation.description }),
    ...(relation.metadata === undefined ? {} : { 'x-tarstate-metadata': relation.metadata })
  });
}

function relationProperties(
  relation: RelationManifestV1,
  codecs: Readonly<Record<string, CodecDeclarationV1>>
): JsonObject {
  return recordFromEntries(
    sortedEntries(relation.fields).map(([fieldName, field]) => [
      fieldName,
      jsonSchemaForField(field, codecs)
    ])
  );
}

function requiredFieldNames(relation: RelationManifestV1): readonly string[] {
  return sortedEntries(relation.fields)
    .filter(([, field]) => field.optional !== true)
    .map(([fieldName]) => fieldName);
}

function jsonSchemaForField(field: FieldManifestV1, codecs: Readonly<Record<string, CodecDeclarationV1>>): JsonObject {
  const base = fieldBaseSchema(field, codecs);
  const withBase = compactObject({
    ...base,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.metadata === undefined ? {} : { 'x-tarstate-metadata': field.metadata })
  });
  return applyNullable(withBase, field.nullable === true);
}

function fieldBaseSchema(field: FieldManifestV1, codecs: Readonly<Record<string, CodecDeclarationV1>>): JsonObject {
  switch (field.type) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'id':
      return { type: 'string', 'x-tarstate-id-domain': field.domain };
    case 'ref':
      return {
        type: 'string',
        'x-tarstate-ref': `${field.target.relation}.${field.target.field}`,
        'x-tarstate-ref-target': { relation: field.target.relation, field: field.target.field }
      };
    case 'anchoredPath':
      return { type: 'string', 'x-tarstate-field-type': 'anchoredPath' };
    case 'json':
      return { type: ['array', 'object', 'string', 'number', 'boolean'] };
    case 'custom': {
      const codec = codecs[field.codec];
      const scalarSchema = jsonSchemaForCodecScalar(codec?.scalar);
      return compactObject({
        ...scalarSchema,
        ...(scalarSchema.type === undefined ? { not: { type: 'null' } } : {}),
        'x-tarstate-codec': field.codec,
        'x-tarstate-codec-scalar': codec?.scalar,
        'x-tarstate-codec-keyable': codec?.keyable === true ? true : undefined
      });
    }
  }
}

function jsonSchemaForCodecScalar(scalar: CodecDeclarationV1['scalar'] | undefined): JsonObject {
  switch (scalar) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case undefined:
      return {};
  }
}

function applyNullable(schema: JsonObject, nullable: boolean): JsonObject {
  if (!nullable) return schema;
  const type = schema.type;
  if (type === 'null') return schema;
  if (typeof type === 'string') return { ...schema, type: [type, 'null'] };
  if (Array.isArray(type)) return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] };
  const { not: _not, ...rest } = schema;
  return rest;
}

function compactObject(input: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  return recordFromEntries<JsonValue>(Object.entries(input).filter(isDefinedJsonEntry));
}

function isDefinedJsonEntry(entry: [string, JsonValue | undefined]): entry is [string, JsonValue] {
  return entry[1] !== undefined;
}
