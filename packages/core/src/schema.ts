export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type RefTarget = {
  readonly relation: string;
  readonly field: string;
};
type PrimitiveFieldKind = 'string' | 'number' | 'boolean' | 'id' | 'ref' | 'anchoredPath' | 'json' | 'custom';

export type CustomFieldSpec<Value = unknown> = {
  readonly codec: string;
  readonly description?: string;
  readonly validate?: (value: unknown) => boolean;
  readonly stableKey?: (value: unknown) => string;
  readonly compare?: (left: unknown, right: unknown) => number;
  readonly toScalar?: (value: unknown) => string | number | boolean | null;
  readonly fromScalar?: (value: unknown) => unknown;
  readonly __value?: Value;
};

export type FieldSpec<Value = unknown> = {
  readonly kind: 'field';
  readonly valueKind: PrimitiveFieldKind;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly idDomain?: string;
  readonly ref?: string | RefTarget;
  readonly custom?: CustomFieldSpec<Value>;
  readonly __value?: Value;
};

type RelationFields = Record<string, FieldSpec>;
type RelationKeySpec<Row extends object> = keyof Row & string | readonly (keyof Row & string)[];
type AnyRelationRef = {
  readonly kind: 'relation';
  readonly name: string;
  readonly key: string | readonly string[];
  readonly fields: RelationFields;
  readonly ephemeral: boolean;
  readonly __row?: unknown;
};

export type RelationRef<
  Row extends object = Record<string, unknown>,
  Key extends RelationKeySpec<Row> = RelationKeySpec<Row>
> = {
  readonly kind: 'relation';
  readonly name: string;
  readonly key: Key;
  readonly fields: RelationFields;
  readonly ephemeral: boolean;
  readonly __row?: Row;
};

export type SchemaManifestV1 = {
  readonly kind: 'tarstate.schema';
  readonly formatVersion: 1;
  readonly schemaId: string;
  readonly description?: string;
  readonly relations: Readonly<Record<string, RelationManifestV1>>;
  readonly codecs?: Readonly<Record<string, CodecDeclarationV1>>;
  readonly metadata?: JsonObject;
};

export type RelationManifestV1 = {
  readonly key: string | readonly [string, string, ...string[]];
  readonly fields: Readonly<Record<string, FieldManifestV1>>;
  readonly ephemeral?: boolean;
  readonly description?: string;
  readonly metadata?: JsonObject;
};

export type FieldBaseV1 = {
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly description?: string;
  readonly metadata?: JsonObject;
};

export type StringFieldManifestV1 = FieldBaseV1 & { readonly type: 'string' };
export type NumberFieldManifestV1 = FieldBaseV1 & { readonly type: 'number' };
export type BooleanFieldManifestV1 = FieldBaseV1 & { readonly type: 'boolean' };
export type IdFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'id';
  readonly domain: string;
};
export type RefFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'ref';
  readonly target: RefTarget;
};
export type AnchoredPathFieldManifestV1 = FieldBaseV1 & { readonly type: 'anchoredPath' };
export type JsonFieldManifestV1 = FieldBaseV1 & { readonly type: 'json' };
export type CustomFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'custom';
  readonly codec: string;
};

export type FieldManifestV1 =
  | StringFieldManifestV1
  | NumberFieldManifestV1
  | BooleanFieldManifestV1
  | IdFieldManifestV1
  | RefFieldManifestV1
  | AnchoredPathFieldManifestV1
  | JsonFieldManifestV1
  | CustomFieldManifestV1;

export type CodecDeclarationV1 = {
  readonly description?: string;
  readonly scalar?: 'string' | 'number' | 'boolean' | 'null';
  readonly keyable?: boolean;
  readonly metadata?: JsonObject;
};

export type RuntimeCodec = {
  readonly codec: string;
  readonly description?: string;
  readonly validate?: (value: unknown) => boolean;
  readonly stableKey?: (value: unknown) => string;
  readonly compare?: (left: unknown, right: unknown) => number;
  readonly toScalar?: (value: unknown) => string | number | boolean | null;
  readonly fromScalar?: (value: unknown) => unknown;
};

export type SchemaManifestDiagnosticCodeV1 =
  | 'schema_manifest.invalid'
  | 'schema_manifest.non_json_value'
  | 'schema_manifest.unknown_property'
  | 'schema_manifest.missing_required'
  | 'schema_manifest.invalid_name'
  | 'schema_manifest.invalid_key'
  | 'schema_manifest.invalid_field'
  | 'schema_manifest.invalid_ref'
  | 'schema_manifest.invalid_codec';

export type SchemaManifestDiagnosticV1 = {
  readonly code: SchemaManifestDiagnosticCodeV1;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly detail?: JsonValue;
};

export type ToSchemaManifestOptions = {
  readonly schemaId: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly codecs?: Readonly<Record<string, CodecDeclarationV1>>;
};

export type HydratedSchema = Readonly<Record<string, RelationRef>>;

export type HydrateSchemaManifestOptions = {
  readonly codecs?: Readonly<Record<string, RuntimeCodec>>;
  readonly diagnosticMode?: 'throw' | 'collect' | 'warn';
};

export type HydrateSchemaManifestResult = {
  readonly schema?: HydratedSchema;
  readonly diagnostics: readonly SchemaManifestDiagnosticV1[];
};

export type SchemaManifestCatalog = Readonly<Record<string, SchemaManifestV1>>;

export type SchemaManifestResolverOptions = Omit<HydrateSchemaManifestOptions, 'diagnosticMode'> & {
  readonly catalog?: SchemaManifestCatalog;
  readonly diagnosticMode?: 'throw' | 'warn';
};

export type SchemaManifestResolver = {
  hydrate(input: SchemaManifestV1 | string): HydratedSchema;
  relation<
    Row extends object = Record<string, unknown>,
    Key extends RelationKeySpec<Row> = RelationKeySpec<Row>
  >(
    schema: SchemaManifestV1 | string,
    relationName: string
  ): RelationRef<Row, Key>;
};

export class SchemaManifestValidationError extends Error {
  readonly diagnostics: readonly SchemaManifestDiagnosticV1[];

  constructor(diagnostics: readonly SchemaManifestDiagnosticV1[]) {
    super(schemaManifestErrorMessage(diagnostics));
    this.name = 'SchemaManifestValidationError';
    this.diagnostics = diagnostics;
  }
}

type RelationRowFromFields<Fields extends RelationFields> = {
  readonly [Field in keyof Fields & string]: Fields[Field] extends FieldSpec<infer Value> ? Value : unknown;
};
type JsonValueValidationContext = {
  readonly active: WeakSet<object>;
  readonly valid: WeakSet<object>;
};
type JsonValueCanonicalizationContext = {
  readonly active: WeakSet<object>;
  readonly values: WeakMap<object, JsonValue>;
};
type NonNullish<Value> = Exclude<Value, null | undefined>;
type RelationInputField<Value> =
  NonNullish<Value> extends string ? FieldSpec<string | Extract<Value, null | undefined>>
    : NonNullish<Value> extends number ? FieldSpec<number | Extract<Value, null | undefined>>
      : NonNullish<Value> extends boolean ? FieldSpec<boolean | Extract<Value, null | undefined>>
        : FieldSpec<Value>;
type RelationInput<Row extends object, Key extends RelationKeySpec<Row> = RelationKeySpec<Row>> = {
  readonly key: Key;
  readonly fields: { readonly [Field in keyof Row & string]: RelationInputField<Row[Field]> };
  readonly ephemeral?: boolean;
};

export function relation<Row extends object, const Key extends RelationKeySpec<Row> = RelationKeySpec<Row>>(input: RelationInput<Row, Key>): RelationRef<Row, Key>;
export function relation<const Fields extends RelationFields, const Key extends RelationKeySpec<RelationRowFromFields<Fields>>>(input: {
  readonly key: Key;
  readonly fields: Fields;
  readonly ephemeral?: boolean;
}): RelationRef<RelationRowFromFields<Fields>, Key>;
export function relation<Row extends object, Key extends RelationKeySpec<Row> = RelationKeySpec<Row>>(input: RelationInput<Row, Key>): RelationRef<Row, Key> {
  return { kind: 'relation', name: '', key: input.key, fields: input.fields, ephemeral: input.ephemeral ?? false };
}

export function defineSchema<const Schema extends Record<string, AnyRelationRef>>(
  schema: Schema
): { readonly [Key in keyof Schema]: Schema[Key] & { readonly name: Key & string } } {
  return Object.fromEntries(Object.entries(schema).map(([name, ref]) => [name, { ...ref, name }])) as never;
}

function fieldSpec<Value>(valueKind: PrimitiveFieldKind): FieldSpec<Value> {
  return { kind: 'field', valueKind, optional: false, nullable: false };
}

export const stringField = (): FieldSpec<string> => fieldSpec('string');
export const numberField = (): FieldSpec<number> => fieldSpec('number');
export const booleanField = (): FieldSpec<boolean> => fieldSpec('boolean');
export const anchoredPathField = (): FieldSpec<string> => fieldSpec('anchoredPath');
export const jsonField = (): FieldSpec<JsonValue> => fieldSpec('json');
export const idField = (domain: string): FieldSpec<string> => ({ ...fieldSpec<string>('id'), idDomain: domain });
export const refField = (target: string | RefTarget): FieldSpec<string> => ({ ...fieldSpec<string>('ref'), ref: target });
export const customField = <Value = unknown>(spec: CustomFieldSpec<Value> | string): FieldSpec<Value> => ({
  ...fieldSpec<Value>('custom'),
  custom: normalizeCustomFieldSpec(spec)
});
export const opaqueField = <Value = unknown>(spec: CustomFieldSpec<Value> | string = 'opaque'): FieldSpec<Value> =>
  customField<Value>(spec);
export const nullable = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | null> => ({ ...spec, nullable: true });
export const optional = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | undefined> => ({ ...spec, optional: true });

function normalizeCustomFieldSpec<Value>(spec: CustomFieldSpec<Value> | string): CustomFieldSpec<Value> {
  return typeof spec === 'string' ? { codec: spec } : spec;
}

export function toSchemaManifest(
  schema: Readonly<Record<string, AnyRelationRef>>,
  options: ToSchemaManifestOptions
): SchemaManifestV1 {
  const diagnostics: SchemaManifestDiagnosticV1[] = [];
  const codecs: Record<string, CodecDeclarationV1> = { ...options.codecs };
  const relations: Record<string, RelationManifestV1> = {};

  for (const [schemaKey, relationRef] of Object.entries(schema)) {
    const relationName = relationRef.name === '' ? schemaKey : relationRef.name;
    const relationPath = ['relations', relationName];
    const fields: Record<string, FieldManifestV1> = {};
    for (const [fieldName, field] of Object.entries(relationRef.fields)) {
      const manifestField = manifestFieldFromSpec(field, [...relationPath, 'fields', fieldName], codecs, diagnostics);
      if (manifestField !== undefined) fields[fieldName] = manifestField;
    }
    relations[relationName] = {
      key: manifestKeyFromRelation(relationRef.key),
      fields,
      ...(relationRef.ephemeral ? { ephemeral: true } : {})
    };
  }

  const manifest = {
    kind: 'tarstate.schema',
    formatVersion: 1,
    schemaId: options.schemaId,
    ...(options.description === undefined ? {} : { description: options.description }),
    relations,
    ...(Object.keys(codecs).length === 0 ? {} : { codecs }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  } satisfies SchemaManifestV1;

  if (diagnostics.length > 0) throw new SchemaManifestValidationError(diagnostics);
  return canonicalSchemaManifest(manifest);
}

export function validateSchemaManifest(manifest: unknown): readonly SchemaManifestDiagnosticV1[] {
  return normalizeSchemaManifest(manifest).diagnostics;
}

export function canonicalSchemaManifest(manifest: unknown): SchemaManifestV1 {
  const normalized = normalizeSchemaManifest(manifest);
  if (normalized.diagnostics.some((diagnosticValue) => diagnosticValue.severity === 'error')) {
    throw new SchemaManifestValidationError(normalized.diagnostics);
  }
  if (normalized.manifest === undefined) {
    throw new SchemaManifestValidationError([schemaManifestDiagnostic(
      'schema_manifest.invalid',
      [],
      'Expected a schema manifest.'
    )]);
  }
  return normalized.manifest;
}

export function stringifyCanonicalSchemaManifest(manifest: unknown): string {
  return stringifyCanonicalJson(canonicalSchemaManifest(manifest) as unknown as JsonObject);
}

export function hydrateSchemaManifest(
  manifest: unknown,
  options: HydrateSchemaManifestOptions & { readonly diagnosticMode: 'collect' }
): HydrateSchemaManifestResult;
export function hydrateSchemaManifest(
  manifest: unknown,
  options?: HydrateSchemaManifestOptions & { readonly diagnosticMode?: 'throw' | 'warn' }
): HydratedSchema;
export function hydrateSchemaManifest(
  manifest: unknown,
  options: HydrateSchemaManifestOptions
): HydratedSchema | HydrateSchemaManifestResult;
export function hydrateSchemaManifest(
  manifest: unknown,
  options: HydrateSchemaManifestOptions = {}
): HydratedSchema | HydrateSchemaManifestResult {
  const normalized = normalizeSchemaManifest(manifest);
  const diagnostics = [...normalized.diagnostics];
  const canonical = normalized.manifest;
  if (canonical !== undefined) {
    validateRuntimeCodecs(canonical, options.codecs ?? {}, diagnostics);
  }
  const errors = diagnostics.filter((diagnosticValue) => diagnosticValue.severity === 'error');
  if (errors.length > 0 || canonical === undefined) {
    if (options.diagnosticMode === 'collect') return { diagnostics };
    throw new SchemaManifestValidationError(diagnostics);
  }

  const runtimeSchema: Record<string, AnyRelationRef> = {};
  for (const [relationName, relationManifest] of Object.entries(canonical.relations)) {
    const fields: Record<string, FieldSpec> = {};
    for (const [fieldName, fieldManifest] of Object.entries(relationManifest.fields)) {
      fields[fieldName] = fieldSpecFromManifest(fieldManifest, options.codecs ?? {});
    }
    runtimeSchema[relationName] = {
      ...relation({ key: relationManifest.key, fields, ephemeral: relationManifest.ephemeral ?? false }),
      name: relationName
    };
  }
  const schema = defineSchema(runtimeSchema) as HydratedSchema;
  if (options.diagnosticMode === 'collect') return { schema, diagnostics };
  return schema;
}

export function createSchemaManifestResolver(
  options: SchemaManifestResolverOptions = {}
): SchemaManifestResolver {
  const cacheById = new Map<string, HydratedSchema>();
  const cacheByManifest = new WeakMap<SchemaManifestV1, HydratedSchema>();

  const hydrateManifest = (input: SchemaManifestV1 | string): HydratedSchema => {
    if (typeof input === 'string') {
      const cached = cacheById.get(input);
      if (cached !== undefined) return cached;

      const manifest = options.catalog?.[input];
      if (manifest === undefined) {
        throw new Error(`Schema manifest "${input}" was not found in the resolver catalog.`);
      }
      const schema = hydrateSchemaManifest(manifest, options);
      cacheById.set(input, schema);
      cacheByManifest.set(manifest, schema);
      return schema;
    }

    const cached = cacheByManifest.get(input);
    if (cached !== undefined) return cached;

    const schema = hydrateSchemaManifest(input, options);
    cacheByManifest.set(input, schema);
    cacheById.set(input.schemaId, schema);
    return schema;
  };

  return {
    hydrate: hydrateManifest,
    relation<
      Row extends object = Record<string, unknown>,
      Key extends RelationKeySpec<Row> = RelationKeySpec<Row>
    >(schema: SchemaManifestV1 | string, relationName: string): RelationRef<Row, Key> {
      const hydrated = hydrateManifest(schema);
      const relationRef = hydrated[relationName];
      if (relationRef === undefined) {
        const schemaId = typeof schema === 'string' ? schema : schema.schemaId;
        throw new Error(`Relation "${relationName}" was not found in schema manifest "${schemaId}".`);
      }
      return relationRef as RelationRef<Row, Key>;
    }
  };
}

export function isJsonValue(input: unknown): input is JsonValue {
  return isJsonValueInternal(input, {
    active: new WeakSet<object>(),
    valid: new WeakSet<object>()
  });
}

function isJsonValueInternal(input: unknown, context: JsonValueValidationContext): input is JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (Array.isArray(input)) return isJsonArray(input, context);
  return isPlainJsonObject(input, context);
}

function isJsonArray(input: readonly unknown[], context: JsonValueValidationContext): input is readonly JsonValue[] {
  if (context.valid.has(input)) return true;
  if (context.active.has(input)) return false;
  context.active.add(input);
  try {
    const length = input.length;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isJsonValueInternal(descriptor.value, context)) return false;
    }

    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= length) return false;
    }
    context.valid.add(input);
    return true;
  } catch {
    return false;
  } finally {
    context.active.delete(input);
  }
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && String(index) === key;
}

function isPlainJsonObject(input: unknown, context: JsonValueValidationContext): input is { readonly [key: string]: JsonValue } {
  if (typeof input !== 'object' || input === null) return false;

  if (context.valid.has(input)) return true;
  if (context.active.has(input)) return false;

  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;

    context.active.add(input);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') return false;

      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isJsonValueInternal(descriptor.value, context)) return false;
    }
    context.valid.add(input);
    return true;
  } catch {
    return false;
  } finally {
    context.active.delete(input);
  }
}

type SchemaManifestRecord = Record<string, unknown>;

function normalizeSchemaManifest(input: unknown): {
  readonly manifest?: SchemaManifestV1;
  readonly diagnostics: readonly SchemaManifestDiagnosticV1[];
} {
  const diagnostics: SchemaManifestDiagnosticV1[] = [];
  const record = plainRecord(input, [], diagnostics, 'schema_manifest.invalid');
  if (record === undefined) return { diagnostics };

  knownProperties(record, ['kind', 'formatVersion', 'schemaId', 'description', 'relations', 'codecs', 'metadata'], [], diagnostics);
  requireProperty(record, 'kind', [], diagnostics);
  requireProperty(record, 'formatVersion', [], diagnostics);
  requireProperty(record, 'schemaId', [], diagnostics);
  requireProperty(record, 'relations', [], diagnostics);
  if (record.kind !== 'tarstate.schema') {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid', ['kind'], 'Expected kind "tarstate.schema".'));
  }
  if (record.formatVersion !== 1) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid', ['formatVersion'], 'Expected formatVersion 1.'));
  }
  const schemaId = nonEmptyString(record.schemaId, ['schemaId'], diagnostics, 'schema_manifest.invalid_name');
  const description = optionalString(record, 'description', [], diagnostics);
  const metadata = optionalMetadata(record, 'metadata', [], diagnostics);
  const codecs = normalizeCodecDeclarations(record.codecs, ['codecs'], diagnostics);
  const relations = normalizeRelations(record.relations, codecs, diagnostics);

  const manifest = {
    kind: 'tarstate.schema',
    formatVersion: 1,
    schemaId: schemaId ?? '',
    ...(description === undefined ? {} : { description }),
    relations,
    ...(Object.keys(codecs).length === 0 ? {} : { codecs }),
    ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata })
  } satisfies SchemaManifestV1;
  validateRefTargets(manifest, diagnostics);
  return { manifest, diagnostics };
}

function normalizeCodecDeclarations(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): Record<string, CodecDeclarationV1> {
  if (input === undefined) return {};
  const codecs = plainRecord(input, path, diagnostics, 'schema_manifest.invalid_codec');
  if (codecs === undefined) return {};
  const result: Record<string, CodecDeclarationV1> = {};
  for (const [codecName, codec] of sortedEntries(codecs)) {
    const codecPath = [...path, codecName];
    if (!validName(codecName, codecPath, diagnostics, 'schema_manifest.invalid_name')) continue;
    const declaration = plainRecord(codec, codecPath, diagnostics, 'schema_manifest.invalid_codec');
    if (declaration === undefined) continue;
    knownProperties(declaration, ['description', 'scalar', 'keyable', 'metadata'], codecPath, diagnostics);
    const description = optionalString(declaration, 'description', codecPath, diagnostics);
    const scalar = optionalScalar(declaration, 'scalar', codecPath, diagnostics);
    const keyable = optionalBoolean(declaration, 'keyable', codecPath, diagnostics, 'schema_manifest.invalid_codec');
    const metadata = optionalMetadata(declaration, 'metadata', codecPath, diagnostics);
    result[codecName] = {
      ...(description === undefined ? {} : { description }),
      ...(scalar === undefined ? {} : { scalar }),
      ...(keyable === true ? { keyable } : {}),
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata })
    };
  }
  return result;
}

function normalizeRelations(
  input: unknown,
  codecs: Readonly<Record<string, CodecDeclarationV1>>,
  diagnostics: SchemaManifestDiagnosticV1[]
): Record<string, RelationManifestV1> {
  const relations = plainRecord(input, ['relations'], diagnostics, 'schema_manifest.invalid');
  if (relations === undefined) return {};
  const result: Record<string, RelationManifestV1> = {};
  for (const [relationName, relationInput] of sortedEntries(relations)) {
    const relationPath = ['relations', relationName];
    if (!validName(relationName, relationPath, diagnostics, 'schema_manifest.invalid_name')) continue;
    const relationRecord = plainRecord(relationInput, relationPath, diagnostics, 'schema_manifest.invalid');
    if (relationRecord === undefined) continue;
    knownProperties(relationRecord, ['key', 'fields', 'ephemeral', 'description', 'metadata'], relationPath, diagnostics);
    requireProperty(relationRecord, 'key', relationPath, diagnostics);
    requireProperty(relationRecord, 'fields', relationPath, diagnostics);
    const fields = normalizeFields(relationRecord.fields, relationPath, codecs, diagnostics);
    const keyFields = normalizeKey(relationRecord.key, [...relationPath, 'key'], diagnostics);
    validateKeyFields(keyFields, fields, relationPath, codecs, diagnostics);
    const description = optionalString(relationRecord, 'description', relationPath, diagnostics);
    const ephemeral = optionalBoolean(relationRecord, 'ephemeral', relationPath, diagnostics, 'schema_manifest.invalid');
    const metadata = optionalMetadata(relationRecord, 'metadata', relationPath, diagnostics);
    result[relationName] = {
      key: keyManifest(keyFields),
      fields,
      ...(ephemeral === true ? { ephemeral } : {}),
      ...(description === undefined ? {} : { description }),
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata })
    };
  }
  return result;
}

function normalizeFields(
  input: unknown,
  relationPath: readonly (string | number)[],
  codecs: Readonly<Record<string, CodecDeclarationV1>>,
  diagnostics: SchemaManifestDiagnosticV1[]
): Record<string, FieldManifestV1> {
  const fields = plainRecord(input, [...relationPath, 'fields'], diagnostics, 'schema_manifest.invalid');
  if (fields === undefined) return {};
  if (Object.keys(fields).length === 0) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_field', [...relationPath, 'fields'], 'A relation must contain at least one field.'));
  }
  const result: Record<string, FieldManifestV1> = {};
  for (const [fieldName, fieldInput] of sortedEntries(fields)) {
    const fieldPath = [...relationPath, 'fields', fieldName];
    if (!validName(fieldName, fieldPath, diagnostics, 'schema_manifest.invalid_name')) continue;
    const field = normalizeField(fieldInput, fieldPath, codecs, diagnostics);
    if (field !== undefined) result[fieldName] = field;
  }
  return result;
}

function normalizeField(
  input: unknown,
  path: readonly (string | number)[],
  codecs: Readonly<Record<string, CodecDeclarationV1>>,
  diagnostics: SchemaManifestDiagnosticV1[]
): FieldManifestV1 | undefined {
  const record = plainRecord(input, path, diagnostics, 'schema_manifest.invalid_field');
  if (record === undefined) return undefined;
  requireProperty(record, 'type', path, diagnostics);
  const type = record.type;
  const allowed = ['type', 'optional', 'nullable', 'description', 'metadata'];
  if (type === 'id') allowed.push('domain');
  if (type === 'ref') allowed.push('target');
  if (type === 'custom') allowed.push('codec');
  knownProperties(record, allowed, path, diagnostics);
  const base = normalizeFieldBase(record, path, diagnostics);

  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'anchoredPath':
    case 'json':
      return { ...base, type };
    case 'id': {
      requireProperty(record, 'domain', path, diagnostics);
      const domain = nonEmptyString(record.domain, [...path, 'domain'], diagnostics, 'schema_manifest.invalid_field');
      return { ...base, type: 'id', domain: domain ?? '' };
    }
    case 'ref': {
      requireProperty(record, 'target', path, diagnostics);
      const target = structuredRefTarget(record.target, [...path, 'target'], diagnostics);
      return { ...base, type: 'ref', target: target ?? { relation: '', field: '' } };
    }
    case 'custom': {
      requireProperty(record, 'codec', path, diagnostics);
      const codec = nonEmptyString(record.codec, [...path, 'codec'], diagnostics, 'schema_manifest.invalid_codec');
      if (codec !== undefined && codecs[codec] === undefined) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_codec', [...path, 'codec'], `Codec "${codec}" is not declared.`));
      }
      return { ...base, type: 'custom', codec: codec ?? '' };
    }
    default:
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_field', [...path, 'type'], 'Expected a supported field type.'));
      return undefined;
  }
}

function normalizeFieldBase(
  record: SchemaManifestRecord,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): FieldBaseV1 {
  const optionalValue = optionalBoolean(record, 'optional', path, diagnostics, 'schema_manifest.invalid_field');
  const nullableValue = optionalBoolean(record, 'nullable', path, diagnostics, 'schema_manifest.invalid_field');
  const description = optionalString(record, 'description', path, diagnostics);
  const metadata = optionalMetadata(record, 'metadata', path, diagnostics);
  return {
    ...(optionalValue === true ? { optional: true } : {}),
    ...(nullableValue === true ? { nullable: true } : {}),
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata })
  };
}

function normalizeKey(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): readonly string[] {
  if (typeof input === 'string') {
    return validName(input, path, diagnostics, 'schema_manifest.invalid_key') ? [input] : [];
  }
  if (!Array.isArray(input)) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', path, 'Expected a key field name or composite key array.'));
    return [];
  }
  const fields: string[] = [];
  try {
    const length = input.length;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value === '') {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', [...path, index], 'Composite key fields must be non-empty strings.'));
        continue;
      }
      fields.push(descriptor.value);
    }
    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= length) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', path, 'Composite key arrays must not contain extra properties.'));
        break;
      }
    }
  } catch {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', path, 'Unable to inspect composite key array.'));
    return [];
  }
  if (fields.length < 2) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', path, 'Composite keys must contain at least two fields.'));
  }
  const seen = new Set<string>();
  for (const fieldName of fields) {
    if (seen.has(fieldName)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', path, `Duplicate key field "${fieldName}".`));
    }
    seen.add(fieldName);
  }
  return fields;
}

function validateKeyFields(
  keyFields: readonly string[],
  fields: Readonly<Record<string, FieldManifestV1>>,
  relationPath: readonly (string | number)[],
  codecs: Readonly<Record<string, CodecDeclarationV1>>,
  diagnostics: SchemaManifestDiagnosticV1[]
): void {
  for (const keyField of keyFields) {
    const field = fields[keyField];
    if (field === undefined) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', [...relationPath, 'key'], `Key field "${keyField}" does not exist.`));
      continue;
    }
    if (field.optional === true) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', [...relationPath, 'fields', keyField, 'optional'], 'Key fields cannot be optional.'));
    }
    if (field.nullable === true) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', [...relationPath, 'fields', keyField, 'nullable'], 'Key fields cannot be nullable.'));
    }
    if (!fieldManifestKeyable(field, codecs)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', [...relationPath, 'fields', keyField], 'Key field is not keyable in schema manifests.'));
    }
  }
}

function validateRefTargets(manifest: SchemaManifestV1, diagnostics: SchemaManifestDiagnosticV1[]): void {
  for (const [relationName, relationManifest] of Object.entries(manifest.relations)) {
    for (const [fieldName, field] of Object.entries(relationManifest.fields)) {
      if (field.type !== 'ref') continue;
      const path = ['relations', relationName, 'fields', fieldName, 'target'];
      const targetRelation = manifest.relations[field.target.relation];
      if (targetRelation === undefined) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, `Target relation "${field.target.relation}" does not exist.`));
        continue;
      }
      if (typeof targetRelation.key !== 'string') {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, 'Ref targets must use single-field relation keys.'));
        continue;
      }
      if (field.target.field !== targetRelation.key) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, 'Ref targets must point at the target relation key field.'));
        continue;
      }
      const targetField = targetRelation.fields[field.target.field];
      if (targetField === undefined) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, `Target field "${field.target.field}" does not exist.`));
        continue;
      }
      if (!fieldManifestStringValued(targetField)) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, 'Ref targets must point at a string-valued key field.'));
      }
    }
  }
}

function validateRuntimeCodecs(
  manifest: SchemaManifestV1,
  codecs: Readonly<Record<string, RuntimeCodec>>,
  diagnostics: SchemaManifestDiagnosticV1[]
): void {
  for (const [relationName, relationManifest] of Object.entries(manifest.relations)) {
    const keyFields = Array.isArray(relationManifest.key) ? relationManifest.key : [relationManifest.key];
    for (const [fieldName, field] of Object.entries(relationManifest.fields)) {
      if (field.type !== 'custom') continue;
      const runtimeCodec = codecs[field.codec];
      const path = ['relations', relationName, 'fields', fieldName, 'codec'];
      if (runtimeCodec === undefined) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_codec', path, `Missing runtime codec "${field.codec}".`));
        continue;
      }
      if (runtimeCodec.codec !== field.codec) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_codec', path, `Runtime codec "${runtimeCodec.codec}" does not match manifest codec "${field.codec}".`));
      }
      if (keyFields.includes(fieldName) && runtimeCodec.stableKey === undefined && runtimeCodec.toScalar === undefined) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_key', path, `Runtime codec "${field.codec}" cannot key rows.`));
      }
    }
  }
}

function manifestFieldFromSpec(
  spec: FieldSpec,
  path: readonly (string | number)[],
  codecs: Record<string, CodecDeclarationV1>,
  diagnostics: SchemaManifestDiagnosticV1[]
): FieldManifestV1 | undefined {
  const base = {
    ...(spec.optional ? { optional: true } : {}),
    ...(spec.nullable ? { nullable: true } : {})
  };
  switch (spec.valueKind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'anchoredPath':
    case 'json':
      return { ...base, type: spec.valueKind };
    case 'id':
      if (spec.idDomain === undefined || spec.idDomain === '') {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_field', [...path, 'domain'], 'ID fields must declare a non-empty domain.'));
      }
      return { ...base, type: 'id', domain: spec.idDomain ?? '' };
    case 'ref': {
      const target = refTargetFromBuilder(spec.ref, [...path, 'target'], diagnostics);
      return { ...base, type: 'ref', target: target ?? { relation: '', field: '' } };
    }
    case 'custom': {
      const codec = customFieldCodec(spec.custom, [...path, 'codec'], diagnostics);
      if (codec === undefined || codec === '') {
        return { ...base, type: 'custom', codec: '' };
      }
      if (codecs[codec] === undefined) {
        codecs[codec] = {
          ...(spec.custom?.description === undefined ? {} : { description: spec.custom.description }),
          ...(spec.custom?.stableKey !== undefined || spec.custom?.toScalar !== undefined ? { keyable: true } : {})
        };
      }
      return { ...base, type: 'custom', codec };
    }
    default:
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_field', [...path, 'type'], 'Expected a supported field type.'));
      return undefined;
  }
}

function fieldSpecFromManifest(
  field: FieldManifestV1,
  codecs: Readonly<Record<string, RuntimeCodec>>
): FieldSpec {
  let spec: FieldSpec;
  switch (field.type) {
    case 'string':
      spec = stringField();
      break;
    case 'number':
      spec = numberField();
      break;
    case 'boolean':
      spec = booleanField();
      break;
    case 'id':
      spec = idField(field.domain);
      break;
    case 'ref':
      spec = refField(field.target);
      break;
    case 'anchoredPath':
      spec = anchoredPathField();
      break;
    case 'json':
      spec = jsonField();
      break;
    case 'custom': {
      const runtimeCodec = codecs[field.codec] ?? { codec: field.codec };
      spec = customField({
        codec: runtimeCodec.codec,
        ...(runtimeCodec.description === undefined ? {} : { description: runtimeCodec.description }),
        ...(runtimeCodec.validate === undefined ? {} : { validate: runtimeCodec.validate }),
        ...(runtimeCodec.stableKey === undefined ? {} : { stableKey: runtimeCodec.stableKey }),
        ...(runtimeCodec.compare === undefined ? {} : { compare: runtimeCodec.compare }),
        ...(runtimeCodec.toScalar === undefined ? {} : { toScalar: runtimeCodec.toScalar }),
        ...(runtimeCodec.fromScalar === undefined ? {} : { fromScalar: runtimeCodec.fromScalar })
      });
      break;
    }
  }
  if (field.nullable === true) spec = nullable(spec);
  if (field.optional === true) spec = optional(spec);
  return spec;
}

function customFieldCodec(
  spec: CustomFieldSpec | undefined,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): string | undefined {
  if (spec === undefined) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_codec', path, 'Custom fields must declare a non-empty codec.'));
    return undefined;
  }
  const codec = spec.codec;
  if (codec === undefined || codec === '') {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_codec', path, 'Custom fields must declare a non-empty codec.'));
    return undefined;
  }
  return codec;
}

function manifestKeyFromRelation(input: string | readonly string[]): string | readonly [string, string, ...string[]] {
  if (typeof input === 'string') return input;
  if (input.length === 1) return input[0] ?? '';
  return input as readonly [string, string, ...string[]];
}

function keyManifest(input: readonly string[]): string | readonly [string, string, ...string[]] {
  if (input.length === 1) return input[0] ?? '';
  return input as readonly [string, string, ...string[]];
}

function fieldManifestKeyable(field: FieldManifestV1, codecs: Readonly<Record<string, CodecDeclarationV1>>): boolean {
  if (field.type === 'json') return false;
  if (field.type === 'custom') return codecs[field.codec]?.keyable === true;
  return true;
}

function fieldManifestStringValued(field: FieldManifestV1): boolean {
  return field.type === 'string' || field.type === 'id' || field.type === 'ref' || field.type === 'anchoredPath';
}

function refTargetFromBuilder(
  input: string | RefTarget | undefined,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): RefTarget | undefined {
  if (input === undefined) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, 'Ref fields must declare a target.'));
    return undefined;
  }
  if (typeof input !== 'string') return structuredRefTarget(input, path, diagnostics);
  const parts = input.split('.');
  const relationName = parts[0];
  const fieldName = parts[1];
  if (parts.length !== 2 || relationName === undefined || relationName === '' || fieldName === undefined || fieldName === '') {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_ref', path, 'String ref targets must use unambiguous "relation.field" form.'));
    return undefined;
  }
  return { relation: relationName, field: fieldName };
}

function structuredRefTarget(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): RefTarget | undefined {
  const record = plainRecord(input, path, diagnostics, 'schema_manifest.invalid_ref');
  if (record === undefined) return undefined;
  knownProperties(record, ['relation', 'field'], path, diagnostics);
  requireProperty(record, 'relation', path, diagnostics);
  requireProperty(record, 'field', path, diagnostics);
  const relationValue = nonEmptyString(record.relation, [...path, 'relation'], diagnostics, 'schema_manifest.invalid_ref');
  const fieldValue = nonEmptyString(record.field, [...path, 'field'], diagnostics, 'schema_manifest.invalid_ref');
  if (relationValue === undefined || fieldValue === undefined) return undefined;
  return { relation: relationValue, field: fieldValue };
}

function optionalString(
  record: SchemaManifestRecord,
  fieldName: string,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): string | undefined {
  if (!(fieldName in record)) return undefined;
  return stringValue(record[fieldName], [...path, fieldName], diagnostics, 'schema_manifest.invalid');
}

function optionalBoolean(
  record: SchemaManifestRecord,
  fieldName: string,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[],
  code: SchemaManifestDiagnosticCodeV1
): boolean | undefined {
  if (!(fieldName in record)) return undefined;
  if (typeof record[fieldName] !== 'boolean') {
    diagnostics.push(schemaManifestDiagnostic(code, [...path, fieldName], 'Expected a boolean.'));
    return undefined;
  }
  return record[fieldName];
}

function optionalScalar(
  record: SchemaManifestRecord,
  fieldName: string,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): 'string' | 'number' | 'boolean' | 'null' | undefined {
  if (!(fieldName in record)) return undefined;
  const value = record[fieldName];
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'null') return value;
  diagnostics.push(schemaManifestDiagnostic('schema_manifest.invalid_codec', [...path, fieldName], 'Expected string, number, boolean, or null.'));
  return undefined;
}

function optionalMetadata(
  record: SchemaManifestRecord,
  fieldName: string,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): JsonObject | undefined {
  if (!(fieldName in record)) return undefined;
  const metadata = plainRecord(record[fieldName], [...path, fieldName], diagnostics, 'schema_manifest.non_json_value');
  if (metadata === undefined) return undefined;
  const result: Record<string, JsonValue> = {};
  const context: JsonValueCanonicalizationContext = {
    active: new WeakSet<object>(),
    values: new WeakMap<object, JsonValue>()
  };
  for (const [key, value] of sortedEntries(metadata)) {
    const jsonValue = canonicalJsonValue(value, [...path, fieldName, key], diagnostics, context);
    if (jsonValue !== undefined) result[key] = jsonValue;
  }
  return result;
}

function canonicalJsonValue(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[],
  context: JsonValueCanonicalizationContext
): JsonValue | undefined {
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    if (hasUnpairedSurrogate(input)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Strings must not contain unpaired UTF-16 surrogates.'));
      return undefined;
    }
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Numbers must be finite.'));
      return undefined;
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (Array.isArray(input)) {
    const cached = context.values.get(input);
    if (cached !== undefined) return cached;
    if (context.active.has(input)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'JSON values must not contain cycles.'));
      return undefined;
    }
    context.active.add(input);
    const result: JsonValue[] = [];
    try {
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', [...path, index], 'Arrays must not be sparse.'));
          continue;
        }
        const value = canonicalJsonValue(descriptor.value, [...path, index], diagnostics, context);
        if (value !== undefined) result.push(value);
      }
      for (const key of Reflect.ownKeys(input)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= input.length) {
          diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Arrays must not contain extra properties.'));
          break;
        }
      }
      context.values.set(input, result);
      return result;
    } catch {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Unable to inspect JSON array.'));
      return undefined;
    } finally {
      context.active.delete(input);
    }
  }
  if (typeof input === 'object' && input !== null) {
    const cached = context.values.get(input);
    if (cached !== undefined) return cached;
    if (context.active.has(input)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'JSON values must not contain cycles.'));
      return undefined;
    }
  }
  if (typeof input !== 'object' || input === null) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Expected an object.'));
    return undefined;
  }
  context.active.add(input);
  const result: Record<string, JsonValue> = {};
  try {
    const record = plainRecord(input, path, diagnostics, 'schema_manifest.non_json_value');
    if (record === undefined) return undefined;
    for (const [key, value] of sortedEntries(record)) {
      const jsonValue = canonicalJsonValue(value, [...path, key], diagnostics, context);
      if (jsonValue !== undefined) result[key] = jsonValue;
    }
    context.values.set(input, result);
    return result;
  } finally {
    context.active.delete(input);
  }
}

function plainRecord(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[],
  code: SchemaManifestDiagnosticCodeV1
): SchemaManifestRecord | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      diagnostics.push(schemaManifestDiagnostic(code, path, 'Expected an object.'));
      return undefined;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      diagnostics.push(schemaManifestDiagnostic(code, path, 'Expected a plain object.'));
      return undefined;
    }
    const result = Object.create(null) as SchemaManifestRecord;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Object keys must be strings.'));
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', [...path, key], 'Object fields must be enumerable data properties.'));
        return undefined;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    diagnostics.push(schemaManifestDiagnostic(code, path, 'Unable to inspect object.'));
    return undefined;
  }
}

function knownProperties(
  record: SchemaManifestRecord,
  allowed: readonly string[],
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      diagnostics.push(schemaManifestDiagnostic('schema_manifest.unknown_property', [...path, key], `Unknown property "${key}".`));
    }
  }
}

function requireProperty(
  record: SchemaManifestRecord,
  fieldName: string,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[]
): void {
  if (!(fieldName in record)) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.missing_required', [...path, fieldName], `Missing required property "${fieldName}".`));
  }
}

function stringValue(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[],
  code: SchemaManifestDiagnosticCodeV1
): string | undefined {
  if (typeof input !== 'string') {
    diagnostics.push(schemaManifestDiagnostic(code, path, 'Expected a string.'));
    return undefined;
  }
  if (hasUnpairedSurrogate(input)) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Strings must not contain unpaired UTF-16 surrogates.'));
    return undefined;
  }
  return input;
}

function nonEmptyString(
  input: unknown,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[],
  code: SchemaManifestDiagnosticCodeV1
): string | undefined {
  const value = stringValue(input, path, diagnostics, code);
  if (value === undefined) return undefined;
  if (value === '') {
    diagnostics.push(schemaManifestDiagnostic(code, path, 'Expected a non-empty string.'));
    return undefined;
  }
  return value;
}

function validName(
  input: string,
  path: readonly (string | number)[],
  diagnostics: SchemaManifestDiagnosticV1[],
  code: SchemaManifestDiagnosticCodeV1
): boolean {
  if (input === '') {
    diagnostics.push(schemaManifestDiagnostic(code, path, 'Expected a non-empty name.'));
    return false;
  }
  if (hasUnpairedSurrogate(input)) {
    diagnostics.push(schemaManifestDiagnostic('schema_manifest.non_json_value', path, 'Names must not contain unpaired UTF-16 surrogates.'));
    return false;
  }
  return true;
}

function schemaManifestDiagnostic(
  code: SchemaManifestDiagnosticCodeV1,
  path: readonly (string | number)[],
  message: string,
  detail?: JsonValue
): SchemaManifestDiagnosticV1 {
  return {
    code,
    severity: 'error',
    message,
    path,
    ...(detail === undefined ? {} : { detail })
  };
}

function schemaManifestErrorMessage(diagnostics: readonly SchemaManifestDiagnosticV1[]): string {
  const first = diagnostics[0];
  if (first === undefined) return 'Invalid schema manifest.';
  return `Invalid schema manifest at ${schemaManifestPath(first.path)}: ${first.message}`;
}

function schemaManifestPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? '<root>' : path.map((item) => typeof item === 'number' ? `[${item}]` : `.${item}`).join('');
}

function sortedEntries<T>(record: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  return Object.entries(record).sort(([left], [right]) => compareCodeUnits(left, right));
}

function stringifyCanonicalJson(input: JsonValue): string {
  const nativeStringifyValue = canonicalValueForNativeJsonStringify(input);
  if (nativeStringifyValue !== undefined) return JSON.stringify(nativeStringifyValue);
  const jsonChunks: string[] = [];
  appendManualCanonicalJson(input, jsonChunks, new Map<string, string>());
  return jsonChunks.join('');
}

function canonicalValueForNativeJsonStringify(input: JsonValue): JsonValue | undefined {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    const canonicalArray: JsonValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const value = canonicalValueForNativeJsonStringify(input[index] as JsonValue);
      if (value === undefined) return undefined;
      canonicalArray.push(value);
    }
    return canonicalArray;
  }
  const record = input as JsonObject;
  const canonicalObject: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    if (isArrayIndexKey(key)) return undefined;
    const value = canonicalValueForNativeJsonStringify(record[key] as JsonValue);
    if (value === undefined) return undefined;
    canonicalObject[key] = value;
  }
  return canonicalObject;
}

function appendManualCanonicalJson(input: JsonValue, jsonChunks: string[], encodedObjectKeys: Map<string, string>): void {
  if (input === null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string') {
    jsonChunks.push(JSON.stringify(input));
    return;
  }
  if (Array.isArray(input)) {
    jsonChunks.push('[');
    for (let index = 0; index < input.length; index += 1) {
      if (index > 0) jsonChunks.push(',');
      appendManualCanonicalJson(input[index] as JsonValue, jsonChunks, encodedObjectKeys);
    }
    jsonChunks.push(']');
    return;
  }
  const record = input as JsonObject;
  const keys = Object.keys(record).sort(compareCodeUnits);
  jsonChunks.push('{');
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) jsonChunks.push(',');
    const key = keys[index] as string;
    jsonChunks.push(cachedJsonStringKey(key, encodedObjectKeys), ':');
    appendManualCanonicalJson(record[key] as JsonValue, jsonChunks, encodedObjectKeys);
  }
  jsonChunks.push('}');
}

function cachedJsonStringKey(key: string, encodedObjectKeys: Map<string, string>): string {
  const existing = encodedObjectKeys.get(key);
  if (existing !== undefined) return existing;
  const encoded = JSON.stringify(key);
  encodedObjectKeys.set(key, encoded);
  return encoded;
}

function hasUnpairedSurrogate(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
