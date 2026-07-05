export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type RefTarget = {
  readonly relation: string;
  readonly field: string;
};
type PrimitiveFieldKind = 'string' | 'number' | 'boolean' | 'id' | 'ref' | 'anchoredPath' | 'json' | 'custom';

export type CustomFieldSpec<Value = unknown> = {
  readonly kind: string;
  readonly description?: string;
  readonly validate?: (value: unknown) => boolean;
  readonly stableKey?: (value: unknown) => string;
  readonly compare?: (left: unknown, right: unknown) => number;
  readonly toScalar?: (value: unknown) => string | number | boolean | null;
  readonly fromScalar?: (value: unknown) => unknown;
  readonly valueType?: Value;
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
  custom: typeof spec === 'string' ? { kind: spec } : spec
});
export const opaqueField = <Value = unknown>(spec: CustomFieldSpec<Value> | string = 'opaque'): FieldSpec<Value> =>
  customField<Value>(typeof spec === 'string' ? { kind: spec } : spec);
export const nullable = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | null> => ({ ...spec, nullable: true });
export const optional = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | undefined> => ({ ...spec, optional: true });

export function toSchemaManifest(
  schema: Readonly<Record<string, AnyRelationRef>>,
  options: ToSchemaManifestOptions
): SchemaManifestV1 {
  const diagnostics: SchemaManifestDiagnosticV1[] = [];
  const codecs: Record<string, CodecDeclarationV1> = { ...(options.codecs ?? {}) };
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
export function hydrateSchemaManifest(manifest: unknown, options?: HydrateSchemaManifestOptions): HydratedSchema;
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
  return defineSchema(runtimeSchema);
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
