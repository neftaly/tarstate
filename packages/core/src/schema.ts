export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
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
  readonly ref?: string;
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

type RelationRowFromFields<Fields extends RelationFields> = {
  readonly [Field in keyof Fields & string]: Fields[Field] extends FieldSpec<infer Value> ? Value : unknown;
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
export const refField = (target: string): FieldSpec<string> => ({ ...fieldSpec<string>('ref'), ref: target });
export const customField = <Value = unknown>(spec: CustomFieldSpec<Value> | string): FieldSpec<Value> => ({
  ...fieldSpec<Value>('custom'),
  custom: typeof spec === 'string' ? { kind: spec } : spec
});
export const opaqueField = <Value = unknown>(spec: CustomFieldSpec<Value> | string = 'opaque'): FieldSpec<Value> =>
  customField<Value>(typeof spec === 'string' ? { kind: spec } : spec);
export const nullable = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | null> => ({ ...spec, nullable: true });
export const optional = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | undefined> => ({ ...spec, optional: true });

export function isJsonValue(input: unknown): input is JsonValue {
  return isJsonValueInternal(input, new Set<object>());
}

function isJsonValueInternal(input: unknown, seen: Set<object>): input is JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (Array.isArray(input)) return isJsonArray(input, seen);
  return isPlainJsonObject(input, seen);
}

function isJsonArray(input: readonly unknown[], seen: Set<object>): input is readonly JsonValue[] {
  if (seen.has(input)) return false;
  seen.add(input);
  try {
    const length = input.length;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isJsonValueInternal(descriptor.value, seen)) return false;
    }

    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= length) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(input);
  }
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && String(index) === key;
}

function isPlainJsonObject(input: unknown, seen: Set<object>): input is { readonly [key: string]: JsonValue } {
  if (typeof input !== 'object' || input === null) return false;

  if (seen.has(input)) return false;

  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;

    seen.add(input);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') return false;

      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isJsonValueInternal(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(input);
  }
}
