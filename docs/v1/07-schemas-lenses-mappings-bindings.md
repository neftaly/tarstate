# Schemas, schema lenses, storage mappings, and storage bindings

Status: normative.

## Schema artifact body

A schema artifact describes logical relation meaning only:

```ts
type SchemaBody = {
  relations: Readonly<Record<string, RelationDeclaration>>
  requiredCodecs?: readonly CapabilityRef[]
  description?: string
  metadata?: Readonly<Record<string, JsonValue>>
}

type RelationDeclaration = {
  relationId: RelationId
  key: readonly string[]
  fields: Readonly<Record<string, FieldDeclaration>>
  entityEditCapabilities?: readonly CapabilityRef[]
  description?: string
  metadata?: Readonly<Record<string, JsonValue>>
}

type FieldDeclaration = {
  type: ScalarDeclaration
  optional?: boolean
  nullable?: boolean
  editCapabilities?: readonly CapabilityRef[]
  description?: string
  metadata?: Readonly<Record<string, JsonValue>>
}
```

The object key in `relations` is the local authoring/view name. `relationId` is
stable logical identity. Renaming a relation changes the local name and schema
artifact, not necessarily the relation ID.

Field names are logical view names. V1 does not add a second stable field-ID
axis; explicit lenses describe rename/split/merge meaning. Reusing a field name
for different meaning requires a new schema artifact and an explicit lens.

Schema metadata is descriptive/namespaced extension data. It cannot alter core
parsing, authority, storage topology, indexing, lifecycle, or React semantics.
An extension that changes meaning is a declared artifact dependency/capability,
not an ignored metadata property.

## Scalar declarations

Core declarations are:

```ts
type ScalarDeclaration =
  | { kind: 'string'; values?: readonly string[] }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'integer' }
  | { kind: 'decimal' }
  | { kind: 'instant'; precision: 'millisecond' | 'microsecond' | 'nanosecond' }
  | { kind: 'bytes' }
  | { kind: 'json' }
  | { kind: 'ref'; target: { relationId: RelationId } }
  | { kind: 'custom'; codec: CapabilityRef }
```

Optional means the field may be missing. Nullable means explicit null is part of
the domain. The two flags are independent.

String `values` is a closed enum for that schema view. A newer value requires a
new schema artifact and an explicit compatibility lens; storage preservation
does not imply that an old closed enum can parse it directly.

Refs contain the target relation's complete logical-key tuple. A ref declares
logical meaning and equality only. Existence, cardinality, and delete behavior
belong to constraints/write policies.

JSON is canonical JSON data and is opaque to typed field access unless a query
explicitly uses JSON operations. Domain-rich URLs, resource refs, decimals with
application rounding policy, and host objects may use named codecs when core
semantics are insufficient.

## Keys

Every relation declares one non-empty key field list. Key fields are required,
non-null, canonically hashable, and may be binding-derived rather than physically
stored. Composite key order is semantic.

Schema key declaration does not make the key stable entity identity. Bindings
still provide row locators. Key uniqueness within one source projection is
intrinsic relation integrity; uniqueness across sources requires an explicit
audit constraint and cannot be hard-atomic.

## Edit semantics

`editCapabilities` declares semantic operations consumers may rely on for the
field, such as replace, counter increment, text splice, list edit, or a named
future CRDT operation. Replace is not implicitly available for a CRDT field when
replacement would destroy required semantics.

An attachment reports actual capabilities and may support a safe superset. A
missing edit capability disables that edit; it does not disable unrelated reads
or writes whose requirements are satisfied. Capability identity and version
participate in the registry fingerprint.

Move/rekey capabilities apply to relation entities and are declared in
`RelationDeclaration.entityEditCapabilities`, not faked as ordinary field edits.

## Parsing rows

A binding locates storage candidates. The schema parser converts each candidate
to either a trusted logical row or issues tied to source, locator, and path.

- Unparseable candidates are excluded from normal relation queries.
- All diagnostic evidence and locators remain available through authority-safe
  system relations.
- Duplicate keys make keyed access/write ambiguous; no winner is selected.
- Missing refs do not make a row unparseable; a constraint may report them.
- Unknown physical fields are untouched by unrelated field edits.
- Parsing is total and budgeted; expected malformed data never throws through a
  query subscription.

## Storage-mapping artifacts

A storage mapping is optional portable data describing candidate locations,
relation collection shape, field sources, and field-level write destinations
for a specific storage model. It may express direct object/map/list layouts and
named semantic edits, but contains no executable functions.

Storage paths, array/map representation, Automerge object lookup, source
lifecycle, and authority belong to mapping/binding/attachment layers, never the
schema.

An absent collection has an explicit mapping policy: empty, creatable, or
invalid. Map key versus row key precedence is explicit. Binding-derived keys and
read-only projections are explicit.

## Executable storage bindings

A storage binding is trusted pure code compiled from a storage mapping or
written by the host. It implements total projection and edit planning over an
immutable source snapshot.

Bindings declare conservative read and write footprint bounds, and each plan
returns exact-attempt footprints plus storage intents. They preserve unknown storage,
locate rows by stable source mechanisms, plan complete edits before mutation,
and emit structured issues rather than throw for expected data.

Bindings never subscribe or commit. The commit coordinator combines all binding
plans and performs the one atomic source commit.

Bindings are anti-corruption boundaries around host storage. Portable consumers
observe logical rows, semantic edit capabilities, normalized source facts, and
structured issues—not Automerge object layouts, Zustand action conventions,
TanStack events, or adapter-private metadata. A native source feature may
replace a fallback without changing schemas when it satisfies the same declared
contract.

Portable mappings cover JSON/Automerge-like object structures. Executable
bindings may parse `Map`, `Set`, typed arrays, classes, ECS storage, Redux,
signals, or other JavaScript objects into the same logical model. That does not
make those host values portable artifacts.

## Schema-lens artifacts

A schema-lens artifact contains exact `from` and `to` schema refs plus separately
declared read and write transformations.

The v1 declarative subset supports:

- relation and field rename;
- add field with deterministic default;
- hide/preserve field;
- value/enum mapping;
- key and ref translation through a source-local unique lookup;
- relation projection/split for reads;
- explicit read-only or lossy directions.

Arbitrary relation merge/split writes require a named inverse binding and are
otherwise read-only.

Lens resolution uses a host-selected exact path or a single unambiguous path.
Zero or multiple valid paths fail. Shortest path, version number, and filename
order never select compatibility implicitly.

Reads parse the storage schema first, then apply the selected lens to the view.
Writes target current row locators, translate field-level edits backward, and
run current source constraints after translation. A write that cannot preserve
unknown data or round-trip its touched meaning rejects.

For a value-map or lookup step whose policy is `reject`, failure rejects the
entire candidate projection. The lens never publishes a partial row with the
unmapped field omitted as exact data. Tuple-backed lookups require exact arity;
a scalar is accepted only for a one-field tuple.

Lenses translate views and write intent; they do not mutate stored documents or
serve as migrations.
