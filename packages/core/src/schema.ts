type PrimitiveFieldKind = 'string' | 'number' | 'boolean' | 'id' | 'ref' | 'anchoredPath' | 'json';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Field metadata used for validation and future planning. */
export type FieldSpec = {
  readonly kind: 'field';
  readonly valueKind: PrimitiveFieldKind;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly idDomain?: string;
  readonly ref?: string;
};

/** Named relation metadata plus the row type carried by that relation. */
export type RelationRef<Row extends Record<string, unknown> = Record<string, unknown>> = {
  readonly kind: 'relation';
  readonly name: string;
  readonly key: keyof Row & string | readonly (keyof Row & string)[];
  readonly fields: Record<keyof Row & string, FieldSpec>;
  readonly ephemeral: boolean;
};

type RelationInput<Row extends Record<string, unknown>> = {
  readonly key: keyof Row & string | readonly (keyof Row & string)[];
  readonly fields: Record<keyof Row & string, FieldSpec>;
  readonly ephemeral?: boolean;
};

/** String-valued field. */
export function stringField(): FieldSpec {
  return field('string');
}

/** Number-valued field. */
export function numberField(): FieldSpec {
  return field('number');
}

/** Boolean-valued field. */
export function booleanField(): FieldSpec {
  return field('boolean');
}

/** String id field, tagged with an application-level domain. */
export function idField(domain: string): FieldSpec {
  return { ...field('id'), idDomain: domain };
}

/** String foreign-key field targeting another relation field. */
export function refField(target: string): FieldSpec {
  return { ...field('ref'), ref: target };
}

/** Path anchored in a durable object or document. */
export function anchoredPathField(): FieldSpec {
  return field('anchoredPath');
}

/** JSON-compatible value field for opaque application payloads. */
export function jsonField(): FieldSpec {
  return field('json');
}

/** Allow null for a field while still requiring the key to exist. */
export function nullable(spec: FieldSpec): FieldSpec {
  return { ...spec, nullable: true };
}

/** Allow a field key to be absent or undefined. */
export function optional(spec: FieldSpec): FieldSpec {
  return { ...spec, optional: true };
}

/**
 * Declare a relation before `defineSchema` assigns its final name.
 *
 * @remarks Invalid ephemeral rows are reported and omitted by the evaluator.
 */
export function relation<Row extends Record<string, unknown>>(input: RelationInput<Row>): RelationRef<Row> {
  return {
    kind: 'relation',
    name: '',
    key: input.key,
    fields: input.fields,
    ephemeral: input.ephemeral ?? false
  };
}

/**
 * Name relations from object keys and return the typed schema.
 *
 * @example `const schema = defineSchema({ objects: relation(...) })`
 */
export function defineSchema<const Schema extends Record<string, RelationRef>>(schema: Schema): Schema {
  // Relations are declared name-less so object keys remain the single name source.
  for (const [name, relationRef] of Object.entries(schema)) {
    (relationRef as { name: string }).name = name;
  }

  return schema;
}

function field(valueKind: PrimitiveFieldKind): FieldSpec {
  return { kind: 'field', valueKind, optional: false, nullable: false };
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set());
}

function isJsonValueInternal(value: unknown, seen: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    const valid = value.every((item) => isJsonValueInternal(item, seen));
    seen.delete(value);
    return valid;
  }

  if (typeof value !== 'object' || Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }

  seen.add(value);
  const valid = Object.values(value as Record<string, unknown>).every((item) => isJsonValueInternal(item, seen));
  seen.delete(value);
  return valid;
}
