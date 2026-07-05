import { canonicalSchemaManifest, type CodecDeclarationV1, type FieldManifestV1, type JsonObject, type JsonValue, type SchemaManifestV1 } from '@tarstate/core/schema';
import { keyFields, sortedEntries } from './names.js';

export type JsonSchemaMap = Readonly<Record<string, JsonObject>>;

export function emitJsonSchemas(input: SchemaManifestV1): JsonSchemaMap {
  return emitJsonSchemasForCanonicalManifest(canonicalSchemaManifest(input));
}

export function emitJsonSchemasForCanonicalManifest(manifest: SchemaManifestV1): JsonSchemaMap {
  const schemas: Record<string, JsonObject> = {};
  for (const [relationName, relation] of sortedEntries(manifest.relations)) {
    const properties: Record<string, JsonValue> = {};
    const required: string[] = [];
    for (const [fieldName, field] of sortedEntries(relation.fields)) {
      properties[fieldName] = jsonSchemaForField(field, manifest.codecs ?? {});
      if (field.optional !== true) required.push(fieldName);
    }

    schemas[relationName] = compactObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `tarstate:${encodeURIComponent(manifest.schemaId)}/${encodeURIComponent(relationName)}`,
      title: `${relationName} row`,
      type: 'object',
      additionalProperties: false,
      required,
      properties,
      'x-tarstate-schema-id': manifest.schemaId,
      'x-tarstate-relation': relationName,
      'x-tarstate-key': keyFields(relation.key),
      ...(relation.description === undefined ? {} : { description: relation.description }),
      ...(relation.metadata === undefined ? {} : { 'x-tarstate-metadata': relation.metadata })
    });
  }
  return schemas;
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
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
