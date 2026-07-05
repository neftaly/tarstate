# Tarstate Schema Manifest Specification

Status: v1 draft-final.

This document specifies the first serializable schema manifest for Tarstate. It
is intentionally narrower than the research note. The goal is a stable,
canonical, JSON-compatible description of base relations that can be exported,
validated, hashed, generated from, and hydrated back into Tarstate runtime
schema objects.

## 1. Scope

This specification defines:

- the `tarstate.schema` manifest document
- v1 relation manifests
- v1 field manifests
- canonicalization rules
- validation rules
- custom codec references
- hydration requirements
- forward-compatibility rules for later schema evolution work

This specification does not define:

- EDN or YAML authoring syntax
- JSON Schema generation
- serializable queries
- serializable constraints
- serializable indexes
- derived relation manifests
- runtime topology manifests
- Cambria-style schema lenses
- sidecar storage for unknown future data

Those are expected later layers. Their names and boundaries are reserved here
so v1 does not block them.

The v1 format is designed to be self-hostable: a schema manifest is
projectable into Tarstate relations so Tarstate itself can inspect, query,
compare, validate, document, and eventually evolve schemas. V1 does not require
an implementation of that projection, but it reserves stable relational meaning
for the manifest parts defined here.

## 2. Normative Language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

Unless otherwise stated, "JSON-compatible" means one of:

- string
- finite number
- boolean
- null
- array of JSON-compatible values
- object whose keys are strings and whose values are JSON-compatible

The following JavaScript values are not JSON-compatible manifest values:
`undefined`, functions, symbols, `NaN`, infinity, `BigInt`, `Date`,
`Uint8Array`, `Map`, and `Set`.

Manifest strings MUST NOT contain unpaired UTF-16 surrogate code units.

## 3. Document Model

A schema manifest is a JSON-compatible object with this TypeScript shape:

```ts
export type SchemaManifestV1 = {
  readonly kind: 'tarstate.schema';
  readonly formatVersion: 1;
  readonly schemaId: string;
  readonly description?: string;
  readonly relations: Record<string, RelationManifestV1>;
  readonly codecs?: Record<string, CodecDeclarationV1>;
  readonly metadata?: Record<string, JsonValue>;
};
```

`kind` identifies the document family. It MUST be exactly
`"tarstate.schema"`.

`formatVersion` identifies this manifest wire format. It MUST be exactly the
integer `1`.

`schemaId` identifies the application schema node. It MUST be a non-empty
string. It is not a content hash and it is not the manifest format version.
Within Tarstate schema tooling, `schemaId` is immutable: changing relation or
field meaning MUST mint a new `schemaId`. Changing only `description` or inert
`metadata` MAY keep the same `schemaId` when the application does not treat
those changes as generated-artifact changes.

Relation and field names are scoped to one schema node. The same relation or
field name in two different `schemaId` nodes MUST NOT be treated as compatible
without an explicit compatibility rule such as a future lens. Tools that catalog
multiple manifests SHOULD report an error when the same `schemaId` is associated
with incompatible semantic content. They MUST NOT silently merge different
relation or field meanings under one `schemaId`.

`description` is documentation. It MUST NOT affect validation, hydration, or
canonical identity except as data included in canonical output.

`relations` is the logical relation catalog. It MAY be empty so package
boundaries, generated artifacts, and tooling can represent an empty schema.

`codecs` declares custom field capabilities used by this manifest. It is
optional only when the manifest contains no `custom` fields. Every field with
`type: "custom"` MUST reference a codec declared in `codecs`. Hydration MUST
also receive a runtime implementation for that codec.

`metadata` is inert JSON-compatible data. Core MUST preserve it during
canonicalization, but MUST NOT interpret it.

Unknown top-level properties are invalid in v1 except inside `metadata`.

## 4. Relation Manifest

```ts
export type RelationManifestV1 = {
  readonly key: string | readonly [string, string, ...string[]];
  readonly fields: Record<string, FieldManifestV1>;
  readonly ephemeral?: boolean;
  readonly description?: string;
  readonly metadata?: Record<string, JsonValue>;
};
```

A relation name is the object key in `SchemaManifestV1.relations`. Relation
names MUST be non-empty strings. The v1 wire format permits any non-empty
string, but authoring tools MAY restrict names to TypeScript-safe identifiers.

`key` declares the logical row identity. A single-field key MUST be encoded as a
string. A composite key MUST be an array of at least two field names. Composite
key order is significant. A one-element key array is invalid in
`SchemaManifestV1`; authoring and export APIs MAY normalize a one-element key
array to the string form before producing a manifest.

A single-field row key is the value of that field. A composite row key is the
ordered tuple of key-field values in declared key order.

A hydrated runtime SHOULD model row identity as a logical row-key value:

- for a single-field key, the normalized key scalar
- for a composite key, an array of normalized key scalars in declared key order

A normalized built-in key scalar is a string, boolean, or finite number with
`-0` normalized to `0`. `id`, `ref`, and `anchoredPath` keys use their string
row values. A custom key field uses the runtime codec's `stableKey` string when
present, otherwise its non-null scalar conversion. A custom `toScalar` result of
`null`, a non-finite number, or any non-scalar value is invalid for row keying.

Logical row-key equality is equality of normalized row-key values. Composite key
order is significant. When a layer needs a portable row-key text, it SHOULD use
the canonical JSON string of the logical row-key value. This text is a
cross-runtime identity convention for diagnostics, patches, and sidecars; it is
not a required physical storage encoding for adapters.

Every key field MUST:

- exist in `fields`
- be required
- be non-nullable
- be keyable

The key array MUST NOT contain duplicate field names.

`fields` maps field names to field manifests. Field names MUST be non-empty
strings. A relation MUST contain at least one field.

`ephemeral` marks a relation whose rows are not expected to be durable domain
facts. Examples include presence, connection state, runtime diagnostics, and
local UI observations. `ephemeral` defaults to `false`. It does not weaken field
validation, key requirements, ref meaning, or future evolution semantics.
Persistence and write routing are topology concerns, not relation-schema
concerns.

`description` and `metadata` have the same semantics as the top-level fields.

Unknown relation properties are invalid in v1 except inside `metadata`.

## 5. Field Manifest

```ts
export type FieldManifestV1 =
  | StringFieldManifestV1
  | NumberFieldManifestV1
  | BooleanFieldManifestV1
  | IdFieldManifestV1
  | RefFieldManifestV1
  | AnchoredPathFieldManifestV1
  | JsonFieldManifestV1
  | CustomFieldManifestV1;

type FieldBaseV1 = {
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly description?: string;
  readonly metadata?: Record<string, JsonValue>;
};
```

Field names are the object keys in `RelationManifestV1.fields`.

`optional` means a row MAY omit the field. It defaults to `false`.

`nullable` means a row MAY set the field to `null`. It defaults to `false`.

If both `optional` and `nullable` are true, both omission and `null` are valid.

Unknown field properties are invalid in v1 except inside `metadata`.

### 5.1 `string`

```ts
type StringFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'string';
};
```

Valid row values are JavaScript strings.

Strings MUST NOT be normalized, trimmed, case-folded, or otherwise rewritten by
schema validation.

String fields are keyable.

### 5.2 `number`

```ts
type NumberFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'number';
};
```

Valid row values are finite JavaScript numbers.

`NaN`, positive infinity, and negative infinity are invalid.

`number` is finite JavaScript numeric data. It is not an exact decimal,
arbitrary-precision integer, currency, or cross-runtime safe-integer guarantee.
Use string ids, integer minor units, or a domain-specific custom codec when
exactness matters.

Number fields are keyable.

### 5.3 `boolean`

```ts
type BooleanFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'boolean';
};
```

Valid row values are booleans.

Boolean fields are keyable.

### 5.4 `id`

```ts
type IdFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'id';
  readonly domain: string;
};
```

Valid row values are strings.

`domain` names the id namespace. It MUST be a non-empty string. Two `id` fields
with different domains SHOULD NOT be considered interchangeable even though
both are represented as strings.

Domain names SHOULD be package-qualified or otherwise globally namespaced.
Tarstate reserves the `tarstate.` prefix for core-defined domains.

Id fields are keyable.

### 5.5 `ref`

```ts
type RefFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'ref';
  readonly target: RefTargetV1;
};

type RefTargetV1 = {
  readonly relation: string;
  readonly field: string;
};
```

Valid row values are strings.

`target` names the relation field being referenced. The target relation MUST
exist in the same manifest. The target field MUST exist in the target relation.

The target relation MUST have a single-field key, and `target.field` MUST be
that key field. The target field MUST be string-valued in v1: `string`, `id`,
`anchoredPath`, or `ref`. Refs into composite-key relations, refs to non-key
unique fields, and refs to numeric, boolean, JSON, or custom keys are reserved
for a later format version or constraint layer.

V1 `ref` is a typed scalar reference. It is not a complete referential-integrity
constraint. Row-existence checks, cascading behavior, composite foreign keys,
and refs to non-key unique fields belong to future constraint layers.

Ref fields are keyable.

### 5.6 `anchoredPath`

```ts
type AnchoredPathFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'anchoredPath';
};
```

Valid row values are strings.

`anchoredPath` is a stable path-like scalar used by existing Tarstate runtime
features. The schema manifest treats it as an opaque string with path semantics
defined by the runtime. Core v1 validation does not parse or normalize it.
Schema-level equality and keying use exact string equality after ordinary string
validation.

Anchored path fields are keyable.

### 5.7 `json`

```ts
type JsonFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'json';
};
```

Valid row values are JSON-compatible values.

JSON fields are not keyable in v1.

### 5.8 `custom`

```ts
type CustomFieldManifestV1 = FieldBaseV1 & {
  readonly type: 'custom';
  readonly codec: string;
};
```

Valid row values are defined by the named codec.

`codec` MUST be a non-empty string. It names a capability supplied by a runtime
codec registry. The manifest MUST NOT serialize validator, comparator,
stable-key, scalar-conversion, or hydration functions directly.

Codec names SHOULD be package-qualified or otherwise globally namespaced.
Tarstate reserves the `tarstate.` prefix for core-defined codecs and domains.

Custom fields are keyable only when their codec supplies at least one stable
key strategy to the hydration runtime:

- stable key function
- scalar conversion

`opaqueField(...)` in the TypeScript API serializes as `type: "custom"` with an
appropriate `codec` name. `opaque` is not a separate v1 wire type.

## 6. Codec Declarations

```ts
export type CodecDeclarationV1 = {
  readonly description?: string;
  readonly scalar?: 'string' | 'number' | 'boolean' | 'null';
  readonly keyable?: boolean;
  readonly metadata?: Record<string, JsonValue>;
};
```

A codec declaration describes the portable contract for a custom field. It does
not implement behavior.

`scalar` declares the JSON-compatible scalar representation when the codec has
one. It is documentation plus a hint for generated validators, storage
adapters, and code generators.

`keyable: true` declares that the codec is expected to support stable keying in
a runtime registry. If `keyable` is omitted or false, custom fields using that
codec are not keyable in v1.

Unknown codec declaration properties are invalid in v1 except inside
`metadata`.

## 7. Canonical Form

Canonicalization produces normalized JSON-compatible data. Byte stability is
defined by the canonical string, not by property enumeration order of an
in-memory object. Canonical strings are used for hashing, equality, cache keys,
generated artifacts, and cross-runtime exchange.

Canonicalization MUST:

- preserve array order
- emit `kind: "tarstate.schema"`
- emit `formatVersion: 1`
- require non-empty `schemaId`
- omit empty optional `codecs` objects
- omit empty optional `metadata` objects
- omit `optional: false`
- omit `nullable: false`
- omit `ephemeral: false`
- omit `keyable: false`
- preserve meaningful `false` and `null` values inside `metadata`
- preserve non-empty `metadata` objects
- preserve `description` exactly when provided
- normalize `-0` to `0`
- reject non-JSON-compatible values
- reject strings containing unpaired UTF-16 surrogates
- reject unknown properties outside `metadata`

Canonicalization MUST NOT:

- duplicate relation names inside relation entries
- duplicate field names inside field entries
- rewrite strings
- evaluate custom codecs
- hydrate host functions
- resolve remote references

The object returned by `canonicalSchemaManifest(...)` MAY contain object keys in
any host-language enumeration order. Implementations MUST NOT treat ordinary
object property order as the byte-stable canonical form.

The canonical ref target form is structured:

```json
{ "relation": "agents", "field": "id" }
```

Authoring APIs MAY accept string shorthand such as `"agents.id"`, but a
`SchemaManifestV1` document and canonical output MUST use structured ref
targets.

Canonical stringification for v1 is Tarstate sorted-key JSON:

- canonicalize the manifest object first
- recursively emit object keys sorted lexicographically by UTF-16 code unit
  order, matching ECMAScript string comparison
- preserve array order
- encode with JSON syntax and no insignificant whitespace
- escape strings with the same escaping used by ECMAScript `JSON.stringify` for
  primitive string values
- encode finite numbers with the ECMAScript `JSON.stringify` number algorithm
- reject non-finite numbers before stringification

Canonical stringification MUST sort keys at emission time. It MUST NOT rely on
`JSON.stringify` of a pre-sorted ordinary JavaScript object, because
integer-like property names can enumerate in numeric order instead of
lexicographic order.

When a content hash is computed, the hash input is the UTF-8 encoding of the
canonical string.

This profile is intentionally smaller than RFC 8785. If Tarstate later adopts
RFC 8785, that change must be a new `formatVersion` or an explicitly named
content-hash profile.

Golden canonical strings:

```json
{"formatVersion":1,"kind":"tarstate.schema","relations":{},"schemaId":"empty@1"}
```

An authoring input with unsorted fields and explicit default flags:

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "people@1",
  "relations": {
    "people": {
      "key": "id",
      "fields": {
        "name": { "type": "string" },
        "id": { "type": "id", "domain": "person" },
        "age": { "type": "number", "optional": false }
      }
    }
  }
}
```

MUST canonicalize to:

```json
{"formatVersion":1,"kind":"tarstate.schema","relations":{"people":{"fields":{"age":{"type":"number"},"id":{"domain":"person","type":"id"},"name":{"type":"string"}},"key":"id"}},"schemaId":"people@1"}
```

## 8. Validation

Manifest validation MUST check document structure before hydration.

Validation MUST reject any manifest value whose shape does not match sections
3-6, even if the specific shape error is not named in the following list.

Validation MUST reject:

- non-object manifest values
- missing or wrong `kind`
- missing or wrong `formatVersion`
- missing, empty, or non-string `schemaId`
- missing or non-object `relations`
- non-string `description`
- non-object `codecs`
- non-object `metadata`
- empty relation names
- empty field names
- empty codec names
- strings containing unpaired UTF-16 surrogates
- non-object relation entries
- non-object field entries
- relation entries with missing or non-object `fields`
- relation entries with missing `key`
- relation entries with non-boolean `ephemeral`
- relation entries with non-string `description`
- relation entries with non-object `metadata`
- key values that are neither a string nor an array of strings
- empty key arrays
- one-element key arrays
- key fields that do not exist
- duplicate composite-key fields
- optional or nullable key fields
- non-keyable key fields
- field entries with unknown `type`
- field entries with type-specific fields missing
- field entries with type-specific fields that do not belong to their type
- field entries with non-boolean `optional` or `nullable`
- field entries with non-string `description`
- field entries with non-object `metadata`
- `id` fields without a non-empty `domain`
- `ref` fields without a valid `target`
- ref targets whose relation or field does not exist
- ref targets whose target relation has a composite key
- ref targets that do not point at the target relation key
- ref targets that point at a non-string-valued key field
- `custom` fields without a non-empty `codec`
- `custom` fields whose codec is not declared in `codecs`
- custom key fields whose codec declaration does not set `keyable: true`
- codec declarations with non-string `description`
- codec declarations with invalid `scalar`
- codec declarations with non-boolean `keyable`
- codec declarations with non-object `metadata`
- non-JSON-compatible `metadata`
- unknown properties outside `metadata`

Validation MUST produce structured diagnostics with paths. A diagnostic path
MUST identify the manifest location, for example:

```json
["relations", "listings", "fields", "agentId", "target"]
```

Schema diagnostics have this minimum shape:

```ts
export type SchemaManifestDiagnosticV1 = {
  readonly code: SchemaManifestDiagnosticCodeV1;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly detail?: JsonValue;
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
```

`severity` MUST be `"error"` for diagnostics that make the manifest invalid.
`warning` is reserved for accepted but suspicious input, such as a declared
codec that is not used by any field.

`detail` MUST be JSON-compatible. It MUST contain only small machine-readable
facts, not host objects or error instances.

Implementations MAY adapt these diagnostics into Tarstate's general
`TarstateDiagnostic` shape, but the schema path MUST remain available to
authoring tools. When adapting to a diagnostic shape without a top-level `path`
field, implementations MUST preserve the path in JSON-compatible `detail`, for
example as `detail.path`.

Validation fixture matrix:

| Case | Example shape | Required code |
| --- | --- | --- |
| Not an object | `null` | `schema_manifest.invalid` |
| Wrong kind | `{ "kind": "other" }` | `schema_manifest.invalid` |
| Wrong format version | `{ "kind": "tarstate.schema", "formatVersion": 2, "schemaId": "x", "relations": {} }` | `schema_manifest.invalid` |
| Missing schema id | `{ "kind": "tarstate.schema", "formatVersion": 1, "relations": {} }` | `schema_manifest.missing_required` |
| Empty schema id | `{ "schemaId": "" }` | `schema_manifest.invalid_name` |
| Unknown property | `{ "extra": true }` | `schema_manifest.unknown_property` |
| Missing relation key | relation has `fields` but no `key` | `schema_manifest.missing_required` |
| One-field key array | `key: ["id"]` | `schema_manifest.invalid_key` |
| Missing key field | `key: "id"` with no `fields.id` | `schema_manifest.invalid_key` |
| Duplicate composite key | `key: ["a", "a"]` | `schema_manifest.invalid_key` |
| Optional key field | key field has `optional: true` | `schema_manifest.invalid_key` |
| Nullable key field | key field has `nullable: true` | `schema_manifest.invalid_key` |
| JSON key field | key field has `type: "json"` | `schema_manifest.invalid_key` |
| Missing id domain | `{ "type": "id" }` | `schema_manifest.invalid_field` |
| Missing ref target | `{ "type": "ref" }` | `schema_manifest.invalid_ref` |
| Ref missing relation | target relation does not exist | `schema_manifest.invalid_ref` |
| Ref missing field | target field does not exist | `schema_manifest.invalid_ref` |
| Ref targets composite-key relation | target relation key has more than one field | `schema_manifest.invalid_ref` |
| Ref targets non-key field | target field exists but is not the target relation key | `schema_manifest.invalid_ref` |
| Ref targets non-string key | target key field is not string-valued in v1 | `schema_manifest.invalid_ref` |
| Missing custom codec | `{ "type": "custom" }` | `schema_manifest.invalid_codec` |
| Undeclared custom codec | custom field references absent `codecs` key | `schema_manifest.invalid_codec` |
| Non-keyable custom key | key field codec lacks `keyable: true` | `schema_manifest.invalid_key` |
| Non-JSON metadata | metadata contains `undefined`, function, or `NaN` | `schema_manifest.non_json_value` |

Examples in this matrix are illustrative. A validator MAY emit additional
diagnostics for a malformed manifest, but it MUST include the required code for
the named case. The diagnostic path and detail MUST point to the precise
offending location.

## 9. Hydration

Hydration turns a validated manifest into runtime Tarstate schema objects.

Hydration input:

```ts
type HydrateSchemaManifestOptions = {
  readonly codecs?: Record<string, RuntimeCodec>;
  readonly diagnosticMode?: 'throw' | 'collect' | 'warn';
};
```

If `diagnosticMode` is omitted, hydration SHOULD use the same default behavior
as the surrounding Tarstate API.

The runtime codec contract is:

```ts
export type RuntimeCodec = {
  readonly codec: string;
  readonly description?: string;
  readonly validate?: (value: unknown) => boolean;
  readonly stableKey?: (value: unknown) => string;
  readonly compare?: (left: unknown, right: unknown) => number;
  readonly toScalar?: (value: unknown) => string | number | boolean | null;
  readonly fromScalar?: (value: unknown) => unknown;
};
```

`codec` MUST match the manifest codec key it is registered under. This catches
accidental registry wiring mistakes.

The minimum runtime codec is `{ codec: string }`. That is sufficient for
non-key custom fields whose validation is entirely host-defined or deferred.
Custom key fields require `stableKey` or `toScalar`.

A runtime codec is keyable when it provides `stableKey` or `toScalar`.
`compare` can define ordering or equality behavior for runtime operations, but
it is not sufficient for row keying in v1. If a codec declaration says
`keyable: true`, hydration MUST still verify that the runtime codec is actually
keyable before using the field as a relation key.

When a runtime codec provides both `stableKey` and `toScalar`, keying MUST use
`stableKey`. When it provides only `toScalar`, keying MUST use the scalar value.

For custom key fields, a `toScalar` result used for row keying MUST be a string,
finite number, or boolean. `null`, non-finite numbers, arrays, objects, and
other non-scalar values are invalid key scalars.

`toScalar` and `fromScalar` are not required to be perfect inverses for every
host value, but any lossiness SHOULD be documented in the codec declaration
metadata or avoided for key fields.

For custom key fields, the runtime key behavior MUST be stable and non-lossy for
the key domain. Two distinct key values MUST NOT produce the same stable key or
scalar representation unless the codec defines them as equal.

Hydration MUST:

- validate the manifest first
- reject manifest documents that contain authoring-only shorthand, such as
  string ref targets
- resolve every `custom` field codec referenced by custom fields
- fail if a required codec is missing
- fail if a key field uses a custom codec whose runtime implementation cannot
  key rows
- preserve `optional`, `nullable`, `domain`, `target`, `ephemeral`, and
  description data

Hydration MUST NOT:

- execute functions from the manifest
- accept executable source text as a codec implementation
- infer a missing custom codec from its name alone
- silently degrade a custom key field to unstable object identity

Authoring APIs that accept shorthand MUST expand it to a valid
`SchemaManifestV1` before calling `validateSchemaManifest` or
`hydrateSchemaManifest`.

## 10. Row Validation Semantics

Given a hydrated relation and row value, row validation MUST apply these rules:

- required non-nullable fields must be present and non-null
- optional fields may be absent
- nullable fields may be null
- `null` is invalid whenever `nullable` is false, even when `optional` is true
- field presence is based on own row properties, not inherited properties
- a present value of `undefined` is invalid even when the field is optional
- present non-null fields must match their field type
- `json` fields must contain JSON-compatible values; sparse arrays, `Date`,
  `BigInt`, `Uint8Array`, `Map`, `Set`, `NaN`, infinity, functions, symbols,
  and `undefined` are invalid
- custom fields must pass their codec validator when one is supplied
- extra row fields are invalid in strict row validation

The schema manifest is closed-world for declared fields. A missing required
declared field is invalid. Open-world linking to external data is a later layer.

Runtime row validation MUST reject extra row fields in strict validation mode.
Storage adapters MAY preserve extra fields for forward compatibility outside
the declared relation view, but preserved undeclared fields MUST NOT become
queryable as declared relation fields. An adapter that claims to round-trip
unknown storage data SHOULD either preserve undeclared fields out of band or
reject writes that would drop them; it SHOULD NOT silently erase data outside
the declared view.

Strict row validation is new behavior for schema-manifest validation. Existing
builder-defined relations that do not opt into this manifest validation may
continue to ignore undeclared extra fields until their runtime APIs converge on
the manifest rules.

## 11. Extension Reserve

The following names are reserved for later manifest layers and MUST NOT be used
as arbitrary v1 extension properties:

- `constraints`
- `indexes`
- `queries`
- `derivedRelations`
- `topology`
- `dataSpaces`
- `relationBindings`
- `extensions`
- `requires`
- `capabilities`
- `evolution`
- `schemaNodes`
- `lenses`
- `contentHash`
- `relationId`
- `fieldId`
- `aliases`
- `reservedNames`
- `defaults`
- `fieldTypes`
- `rowKeyEncoding`

Tools MAY preserve those names inside `metadata`, but core v1 MUST NOT interpret
them there.

Because v1 rejects unknown top-level semantic properties and does not yet define
`extensions` or `requires`, any additive semantic layer outside `metadata`
requires a new `formatVersion` until the extension layer exists.

## 12. Evolution Reserve

V1 does not define schema evolution. It still reserves these rules so later
Cambria-style lenses can compose with v1 manifests:

- `schemaId` identifies an immutable schema node and MAY be any non-empty
  string.
- Renaming a relation or field MUST mint a new `schemaId`.
- Changing a field's meaning MUST mint a new `schemaId`.
- Changing only descriptions or inert metadata MAY keep the same `schemaId` if
  the application considers generated artifacts unchanged.
- Future evolution manifests SHOULD connect schema nodes with bidirectional
  lens operations rather than one-way migrations.
- Future write compatibility SHOULD translate deltas or patches when possible,
  not only full snapshots.

## 13. Robustness Requirements

Manifest consumers MUST treat manifests as untrusted data.

Implementations MUST:

- validate before hydration
- enumerate only own enumerable string keys
- inspect manifest values without invoking getters, setters, `toJSON`,
  `valueOf`, or other user-defined conversion hooks
- reject accessor properties when accepting arbitrary JavaScript objects instead
  of already-parsed JSON data
- reject cycles and sparse arrays
- avoid prototype-chain reads when inspecting manifest objects
- treat relation, field, codec, and schema ids as data, not object paths
- reject executable values and source text as behavior
- reject unknown semantic properties outside `metadata`
- avoid mutating caller-owned manifest objects during canonicalization

Implementations SHOULD use null-prototype maps, `Map`, or equivalent internal
data structures when materializing manifest records in JavaScript.

## 14. Examples

### 14.1 Minimal Domain Schema

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "real-estate@1",
  "relations": {
    "agents": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "agent" },
        "name": { "type": "string" }
      }
    },
    "listings": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "listing" },
        "agentId": {
          "type": "ref",
          "target": { "relation": "agents", "field": "id" }
        },
        "address": { "type": "string" },
        "price": { "type": "number", "nullable": true }
      }
    }
  }
}
```

### 14.2 Collaborative Runtime Values

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "notes@2",
  "codecs": {
    "collab.richText": {
      "description": "Collaborative text value",
      "scalar": "string",
      "keyable": true
    },
    "collab.objectReference": {
      "description": "Collaborative object reference",
      "keyable": true
    }
  },
  "relations": {
    "notes": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "note" },
        "body": { "type": "custom", "codec": "collab.richText" }
      }
    },
    "peerSelections": {
      "key": ["peerId", "selectionId"],
      "ephemeral": true,
      "fields": {
        "peerId": { "type": "string" },
        "selectionId": { "type": "string" },
        "target": {
          "type": "custom",
          "codec": "collab.objectReference"
        }
      }
    }
  }
}
```

### 14.3 Runtime Detail As Opaque Custom Data

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "runtime-diagnostics@1",
  "codecs": {
    "runtime.diagnostic.detail": {
      "description": "Host-owned diagnostic detail object",
      "keyable": false
    }
  },
  "relations": {
    "diagnostics": {
      "key": "id",
      "ephemeral": true,
      "fields": {
        "id": { "type": "string" },
        "message": { "type": "string" },
        "detail": {
          "type": "custom",
          "codec": "runtime.diagnostic.detail",
          "optional": true
        }
      }
    }
  }
}
```

## 15. Self-Hosting Projection

A conforming v1 manifest can be projected into ordinary Tarstate relations. The
projection is not the canonical wire format; it is a relational view of the
canonical manifest.

The minimum self-hosting projection is:

```ts
const schemaCatalog = defineSchema({
  schemaManifests: relation({
    key: 'schemaId',
    fields: {
      schemaId: idField('schema'),
      kind: stringField(),
      formatVersion: numberField(),
      description: optional(stringField()),
      metadata: optional(jsonField())
    }
  }),
  schemaCodecs: relation({
    key: ['schemaId', 'codec'],
    fields: {
      schemaId: refField('schemaManifests.schemaId'),
      codec: stringField(),
      description: optional(stringField()),
      scalar: optional(stringField()),
      keyable: optional(booleanField()),
      metadata: optional(jsonField())
    }
  }),
  schemaRelations: relation({
    key: ['schemaId', 'relation'],
    fields: {
      schemaId: refField('schemaManifests.schemaId'),
      relation: stringField(),
      key: jsonField(),
      ephemeral: optional(booleanField()),
      description: optional(stringField()),
      metadata: optional(jsonField())
    }
  }),
  schemaFields: relation({
    key: ['schemaId', 'relation', 'field'],
    fields: {
      schemaId: refField('schemaManifests.schemaId'),
      relation: stringField(),
      field: stringField(),
      type: stringField(),
      optional: optional(booleanField()),
      nullable: optional(booleanField()),
      domain: optional(stringField()),
      target: optional(jsonField()),
      codec: optional(stringField()),
      description: optional(stringField()),
      metadata: optional(jsonField())
    }
  })
});
```

This projection MUST obey these rules:

- `schemaManifests` has one row per manifest.
- `schemaCodecs` has one row per `codecs` entry.
- `schemaRelations` has one row per relation entry.
- `schemaFields` has one row per field entry.
- Relation and field names remain data values in the projection even though
  they are object keys in the canonical manifest.
- The projection MUST preserve enough information to reconstruct the canonical
  manifest exactly.
- The projection SHOULD make validation expressible as Tarstate queries where
  practical, such as missing key fields, missing ref targets, unused codecs, and
  custom fields without declarations.
- The projection does not require current `refField(...)` to express every
  integrity rule. Composite relationships such as `(schemaId, relation)` and
  `(schemaId, relation, field)` can be checked by validation queries until
  composite refs are part of the core schema API.
- `schemaRelations.key` is stored as JSON because v1 relation keys may be either
  a string or an ordered array of strings. Validation queries SHOULD normalize
  it into derived key-field rows when checking key existence and keyability.

The following derived relations are useful for self-hosted validation and
documentation, but are not required storage rows:

- `schemaRelationKeyFields(schemaId, relation, field, position)`
- `schemaRefTargets(schemaId, relation, field, targetRelation, targetField,
  position)`
- `schemaUsedCodecs(schemaId, codec)`
- `schemaUnusedCodecs(schemaId, codec)`
- `schemaInvalidRefs(schemaId, relation, field, reason)`
- `schemaInvalidKeys(schemaId, relation, field, reason)`

Self-hosting matters because schema work is relational work:

- documentation views are projections over schema rows
- generated TypeScript types are derived artifacts
- compatibility checks compare two schema graphs
- future lenses transform relation and field rows between schema nodes
- tooling can query which relations use a codec, ref a target, or contain
  runtime-only metadata

The canonical manifest remains the interchange format. The relational
projection is the way Tarstate can reason about that interchange format using
its own paradigm.

## 16. Implementation Surface

The initial implementation should expose these functions:

```ts
toSchemaManifest(schema, options): SchemaManifestV1
canonicalSchemaManifest(manifest): SchemaManifestV1
stringifyCanonicalSchemaManifest(manifest): string
validateSchemaManifest(manifest): SchemaManifestDiagnosticV1[]
hydrateSchemaManifest(manifest, options): HydratedSchema | HydrateSchemaManifestResult

type HydrateSchemaManifestResult = {
  readonly schema?: HydratedSchema;
  readonly diagnostics: readonly SchemaManifestDiagnosticV1[];
};
```

`toSchemaManifest` exports existing TypeScript builder schemas.

```ts
type ToSchemaManifestOptions = {
  readonly schemaId: string;
  readonly description?: string;
  readonly metadata?: Record<string, JsonValue>;
  readonly codecs?: Record<string, CodecDeclarationV1>;
};
```

`toSchemaManifest` MUST require `schemaId`; the existing builder schema does not
carry a durable application schema node id.

If an exported relation key is an array with one field, `toSchemaManifest` MUST
normalize it to the string key form. If an exported relation key is empty,
contains duplicate fields, references a missing field, references an optional or
nullable field, or references a field that is not keyable in v1, export MUST
fail with `schema_manifest.invalid_key`.

When exporting built-in fields, `toSchemaManifest` maps current field specs as
follows:

| Builder field | Manifest field |
| --- | --- |
| `stringField()` | `{ "type": "string" }` |
| `numberField()` | `{ "type": "number" }` |
| `booleanField()` | `{ "type": "boolean" }` |
| `idField(domain)` | `{ "type": "id", "domain": domain }` |
| `refField("relation.field")` | `{ "type": "ref", "target": { "relation": relation, "field": field } }` |
| `anchoredPathField()` | `{ "type": "anchoredPath" }` |
| `jsonField()` | `{ "type": "json" }` |
| `customField(spec)` / `customField("codec")` | `{ "type": "custom", "codec": spec.kind }` |
| `opaqueField(spec)` / `opaqueField("codec")` | `{ "type": "custom", "codec": spec.kind }` |

Current `refField(...)` stores its target as a string. Export MUST parse
`"relation.field"` only when it contains exactly one dot and both sides are
non-empty. If a target string is ambiguous, export MUST fail with
`schema_manifest.invalid_ref`. The canonical manifest itself does not have this
ambiguity because it uses structured targets.

Authoring APIs SHOULD provide a structured ref-target form such as
`refField({ relation, field })` before manifest export is considered complete.
String shorthand is authoring sugar only and cannot represent every valid v1
relation or field name.

Export MUST fail with `schema_manifest.invalid_field` if an `idField(...)` has
an empty domain.

Export MUST fail with `schema_manifest.invalid_key` if a key field is `json` or
is a custom field without `stableKey` or `toScalar`.

When exporting `customField` or `opaqueField`, the codec name MUST come from the
custom spec `kind`. Export MUST fail with `schema_manifest.invalid_codec` if the
kind is empty. Export MUST synthesize a codec declaration when `options.codecs`
does not provide one:

- `description` from `spec.description`
- `keyable: true` when `spec.stableKey` or `spec.toScalar` is present
- no synthesized `scalar`, because the current `CustomFieldSpec` does not
  declare scalar type without executing user code

Bare `opaqueField()` exports as codec `"opaque"`. Authors SHOULD prefer
domain-specific codec names for portable manifests, but `"opaque"` is valid when
the hydration registry provides that codec. Portable tooling SHOULD warn when
`"opaque"` appears in a manifest intended to cross runtime boundaries.

Export MUST NOT execute custom field functions to infer schema data.

The current builder API has no relation-level or field-level `description` or
`metadata`; `toSchemaManifest` therefore exports only top-level
`description`/`metadata` supplied through `ToSchemaManifestOptions`.

`canonicalSchemaManifest` validates and normalizes an input manifest. It MUST
fail on validation errors and expose `SchemaManifestDiagnosticV1` diagnostics to
the caller.

`stringifyCanonicalSchemaManifest` serializes canonical output with stable key
ordering. It MUST canonicalize first or require already-canonical input; invalid
input MUST fail with diagnostics.

`validateSchemaManifest` returns diagnostics without hydrating runtime refs.

`hydrateSchemaManifest` validates, canonicalizes, resolves codecs, and returns
runtime relation refs.

For `diagnosticMode: "throw"`, hydration MUST throw or otherwise fail on errors
with diagnostics available to callers. For `diagnosticMode: "collect"`,
hydration MUST return `HydrateSchemaManifestResult`; `schema` is omitted when
errors prevent hydration. For `diagnosticMode: "warn"`, warnings MAY be emitted
through the surrounding Tarstate diagnostic channel, but errors still fail
hydration.

`HydratedSchema` means relation refs compatible with the output of
`defineSchema`.

## 17. V1 Decisions

- Empty `relations` is allowed.
- `schemaId` is any non-empty string.
- Single-field keys use string form; key arrays are only for composite keys with
  at least two fields.
- Canonical stringification uses a Tarstate-defined sorted-key JSON profile with
  UTF-16 code-unit key order and emit-time sorting, not full RFC 8785.
- Every custom field codec must be declared in `codecs`.
- V1 refs target string-valued single-field relation keys only.
- Custom key fields require runtime `stableKey` or `toScalar`; `compare` is not
  keyable.
- Hydration still requires runtime codec implementations; declarations are not
  executable behavior.
- Runtime row validation rejects extra row fields in strict validation mode,
  while storage adapters may preserve them outside the declared relation view.
- The manifest must be projectable into ordinary Tarstate relations for
  self-hosted inspection and tooling.

## 18. Conformance Checklist

A v1 implementation conforms to this spec when it can:

- accept and canonicalize all examples in section 14
- reject unknown properties outside `metadata`
- reject non-JSON-compatible manifest data
- reject strings containing unpaired UTF-16 surrogates
- reject missing `kind`, `formatVersion`, `schemaId`, `relations`, `key`, or
  `fields`
- reject one-element key arrays and optional, nullable, missing, duplicate, or
  non-keyable key fields
- reject refs to missing relations, missing fields, non-key fields, or
  non-string-valued key fields
- reject custom fields without declared codecs
- reject custom key fields unless the codec declaration and runtime codec are
  keyable
- reject manifests that would require executable behavior from manifest data
- produce stable canonical strings for semantically identical manifests with
  different object key order
- sort integer-like object keys lexicographically in canonical strings
- omit `keyable: false` from canonical codec declarations
- compute logical row-key values and portable row-key text for single and
  composite keys without confusing `"1"`, `1`, and `true`
- reject custom key scalar conversions that return `null`, non-finite numbers,
  arrays, or objects
- hydrate built-in field types into the current Tarstate schema API
- hydrate custom fields only through a supplied runtime codec registry
- serialize `opaqueField(...)` as `type: "custom"` with a codec name
- reject present row values of `undefined` even for optional fields
- reject sparse arrays, cycles, accessors, and non-JSON host objects during
  manifest or JSON-field validation
- preserve non-empty inert `metadata` as JSON-compatible data, modulo object key
  order in canonical output
- produce diagnostics with paths precise enough for authoring tools to point at
  the offending manifest location
- project a manifest into the self-hosting relations in section 15 without
  losing information required to reconstruct the canonical manifest
