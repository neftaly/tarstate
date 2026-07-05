# Tarstate Core Schema Pressure Test

Status: speculative pressure pass.

This note pressure-tests the core `tarstate.schema` manifest. It is deliberately
broader than schema evolution. The goal is to find places where the base spec is
carrying too many concerns, or where a later concern secretly requires a v1
change now.

## 1. Decomplecting The Problem

The core schema spec should describe relation meaning, not every thing that can
happen around relations.

Separate these concerns:

| Concern | Belongs In Core V1? | Reason |
| --- | --- | --- |
| Relation names, fields, keys, refs | Yes | These define base relational facts. |
| Field optionality and nullability | Yes | These affect row validity and generated types. |
| Custom codec names | Yes | Core needs a stable hook for non-built-in values. |
| Runtime codec functions | No | Executable behavior belongs in hydration registries. |
| Row validation semantics | Yes, narrowly | A schema without row meaning is not useful. |
| Storage preservation of unknown data | No, but acknowledged | Preservation is required by some runtimes, but storage policy is adapter/evolution work. |
| Constraints and indexes | No | They describe integrity and access intent, not base field shape. |
| Queries and derived relations | No | They are essential logic over relations, not base facts. |
| Runtime topology and write routing | No | Same logical schema can be backed by many stores. |
| Composite snapshot/version vectors | No | They select observations across runtimes; they do not change row meaning. |
| Schema evolution lenses | No | Evolution connects immutable schema nodes. |
| EDN/YAML authoring | No | Authoring syntax should compile to the canonical JSON-compatible manifest. |
| JSON Schema export | No | Generated artifact, not source of truth. |
| Generated TypeScript | No | Generated artifact, not source of truth. |
| Physical storage layout | No | Adapter concern. |

The recurring test: if a property changes the meaning of a base row, it may
belong in core. If it describes where the row lives, how it is derived, how it
is indexed, or how it changes across versions, it belongs in another layer.

## 2. Pressures That Could Force A Core Change

These are the cases that would justify changing `docs/schema-spec.md` before
implementation.

### 2.1 Stable Relation And Field Identity

Pressure:

- renames need stable anchors
- generated code may want stable identifiers even when display names change
- external tools may diff manifests and want to distinguish rename from
  remove-plus-add
- Protobuf and Avro both show the value of stable field identity

Current spec answer:

- v1 uses `schemaId` plus relation and field names
- renames mint a new `schemaId`
- future evolution lenses declare rename operations explicitly

Assessment:

Do not add `relationId` or `fieldId` to core v1 yet. They add another identity
axis before Tarstate has examples proving names-plus-lenses are insufficient.
If later needed, they can arrive in a new manifest version or extension layer.

Pressure scenarios:

- `users.name` becomes `users.displayName`
- `users.name` is deleted, then a different `users.name` appears later
- two teams independently rename the same field in different branches
- generated API wants stable symbols across a rename

The spec survives if lenses can express rename intent and diagnostics can flag
ambiguous remove-plus-add diffs.

### 2.2 Richer Built-In Types

Pressure:

- APIs often need arrays, objects, records, enums, unions, dates, bytes, money,
  decimals, integers, and literals
- `json` is too broad for good generated types and validation
- `custom` can become an escape hatch for everything

Current spec answer:

- v1 has only current Tarstate field shapes plus `custom`
- nested shapes can be normalized into relations, held in `json`, or modeled
  with custom codecs
- richer field types are reserved by research but not core v1

Assessment:

Do not add richer built-ins to core v1. The first manifest should prove
canonicalization, hydration, refs, codecs, and self-hosting. Richer shape
validation is a later layer.

Pressure scenarios:

- imported vendor JSON starts as `json`, then wants a typed nested object schema
- `status` wants enum validation and unknown-value preservation
- `amount` needs exact decimal semantics
- `imageBytes` wants bytes without forcing base64 strings into every consumer
- event payloads want tagged unions

The spec survives if `json` is honest about being broad, `number` is not sold as
exact decimal, and custom codecs are explicit capabilities.

### 2.3 Ref Limits

Pressure:

- many real relations use composite keys
- foreign keys often point at multiple fields
- refs to unique non-key fields are common in databases
- runtime objects may use custom object ids

Current spec answer:

- v1 `ref` targets only string-valued single-field keys
- composite refs, non-key refs, and custom/numeric/boolean ref targets are
  reserved for later
- relation-level constraints can later model richer foreign keys

Assessment:

This is the sharpest v1 tradeoff. Keep the limit if the first implementation
must stay small, but test composite-key pressure aggressively. If early examples
cannot tolerate surrogate ids, this is the first core field shape to revisit.

Pressure scenarios:

- `localizedLabels` has key `["locale", "labelId"]`
- `memberships` joins `teamId` and `userId`
- presence points at a CRDT object id represented by a custom codec
- a database import has a unique natural key that is not the primary key

The spec survives if apps can use surrogate ids in v1 and richer foreign-key
constraints arrive as the next relation-integrity layer.

### 2.4 Key Encoding

Pressure:

- composite row keys need stable identity in patches, diagnostics, sidecars, and
  adapters
- `number`, `boolean`, and `string` keys need unambiguous encodings
- JSON object keys cannot distinguish all scalar domains

Current spec answer:

- manifest declares key fields and key order
- v1 defines logical row-key values and portable row-key text
- adapter physical key encoding remains out of scope
- custom key fields require stable runtime keying

Assessment:

Core schema needs a portable identity convention for diagnostics, patches,
sidecars, and self-hosted tooling. It does not need to dictate how adapters
physically store keys.

Pressure scenarios:

- row key `["1", 1, true]`
- key field value `-0`
- custom key whose `toScalar` returns `null`
- sidecar needs to store a key for a composite-key row

The spec survives if every layer that serializes row keys uses logical row-key
values or their canonical text, and does not overload JSON object property
names.

### 2.5 Unknown Data Preservation

Pressure:

- old clients can erase new fields
- old enum UIs can collapse unknown values
- adapters need to round-trip data outside a declared view

Current spec answer:

- strict row validation rejects undeclared fields
- adapters may preserve extra fields outside the declared relation view
- evolution/sidecar layers define preservation mechanics later

Assessment:

Do not add unknown preservation fields to base v1. The core schema is
closed-world for declared row validation. Preservation belongs to storage,
topology, and evolution.

Pressure scenarios:

- old `contacts@1` edits a row containing new `pronouns`
- old `status` UI sees unknown `"blocked"`
- vendor JSON contains unmodeled fields the app must not drop

The spec survives if row validation and adapter preservation stay explicitly
separate.

### 2.6 Codec Declaration Strength

Pressure:

- custom values may need validation, ordering, scalar storage, merge semantics,
  range anchors, binary encodings, or CRDT semantics
- `keyable: true` is too small to describe all codec behavior
- a runtime can hydrate a codec name but still not support a required operation

Current spec answer:

- core codec declarations only expose `description`, primitive `scalar`, and
  `keyable`
- runtime hydration supplies behavior
- future `capabilities` or extension layers can negotiate richer behavior

Assessment:

Keep v1 small, but avoid treating `custom` as "anything goes." Generated docs
and examples should use domain-specific codec names and declare scalar/keyable
where known.

Pressure scenarios:

- `collab.richText` validates but is not scalar
- `collab.objectReference` is keyable and comparable
- `money.decimal` has scalar string storage but exact arithmetic behavior
- `geo.point` supports validation and spatial indexes

The spec survives if missing codec behavior fails loudly during hydration and
operation-specific behavior is negotiated by later capability manifests.

### 2.7 Numeric Semantics

Pressure:

- JavaScript numbers are finite doubles, not exact decimals
- large integers are not safe across all runtimes
- `-0`, `NaN`, and infinities are traps

Current spec answer:

- finite JS numbers only
- canonicalization normalizes manifest `-0` to `0`
- exact integers/decimals are later types or codecs

Assessment:

The spec should be explicit that `number` is approximate IEEE-754-style numeric
data, not money, not arbitrary precision, and not a portable integer promise.
This is documentation pressure, not a new type requirement for v1.

Pressure scenarios:

- accounting amounts
- counters over `Number.MAX_SAFE_INTEGER`
- imported CSV ids parsed as numbers
- row key value `-0`

The spec survives if authors are pushed toward string ids, integer minor units,
or custom decimal codecs when exactness matters.

### 2.8 Host Object And Row Presence Semantics

Pressure:

- JavaScript objects can contain inherited properties, accessors, cycles,
  sparse arrays, `toJSON`, `valueOf`, prototypes, and non-JSON class instances
- `optional` can be confused with present `undefined`
- `json` fields can accidentally accept host objects that are not portable JSON

Current spec answer:

- manifest consumers treat manifests as untrusted
- validators inspect own properties only
- accessors, cycles, sparse arrays, and non-JSON values are rejected
- row `undefined` is invalid even when a field is optional

Assessment:

This belongs in core because it affects canonicalization, validation, and
security. It does not require new schema fields.

Pressure scenarios:

- row has inherited `id`
- optional field is present with value `undefined`
- JSON field contains `Date`, `BigInt`, `Map`, `Set`, sparse array, or `NaN`
- manifest object has a getter that throws or mutates state

### 2.9 Authoring And Implementation Surface

Pressure:

- dotted relation names make `refField("relation.field")` ambiguous
- invalid canonicalization needs a diagnostic channel
- `diagnosticMode: "collect"` needs a return shape
- bare `"opaque"` codecs are easy to misuse across runtime boundaries

Current spec answer:

- canonical refs are structured
- string ref shorthand is authoring-only
- structured ref authoring should exist before export is considered complete
- validation returns `SchemaManifestDiagnosticV1[]`
- hydration collect mode returns diagnostics and optional schema
- portable tooling should warn on bare `"opaque"`

Assessment:

These are implementation-surface clarifications. They make the core format
easier to implement without expanding the manifest shape.

## 3. Pressures That Belong Outside Core

These cases are important, but adding them to `SchemaManifestV1` would complect
base row meaning with other layers.

### 3.1 Runtime Topology

Examples:

- one relation from an Automerge document
- another relation from presence
- a draft relation from Immer memory
- a read-only vendor JSON snapshot
- a blob handle resolved through object storage
- a stream-backed event relation

Why outside core:

The same logical relation schema can be used with different runtime bindings.
Topology should bind relation names to data spaces, ownership, access mode, and
write routing without changing field meaning.

### 3.2 Derived Relations

Examples:

- spreadsheet computed values
- invoice totals
- current notifications derived from events
- document outline derived from CRDT tree nodes

Why outside core:

Derived rows are essential logic, not base facts. They should be represented as
query/rule manifests that depend on relation schemas.

### 3.3 Constraints

Examples:

- uniqueness beyond primary key
- foreign keys across composite fields
- non-empty strings
- price must be non-negative
- published asset must reference an available blob

Why outside core:

Constraints are integrity predicates over rows and relations. They may depend
on queries, capabilities, or transaction context. Core fields should not become
a bag of half-constraint keywords.

### 3.4 Indexes And Materialization

Examples:

- hash index by `agentId`
- btree index by `price`
- materialized search index
- cached derived relation

Why outside core:

Indexes and materializations are performance declarations. They should not
change logical row meaning.

### 3.5 Schema Evolution

Examples:

- field rename
- scalar-to-collection
- relation split
- key rewrite
- unknown field preservation

Why outside core:

Evolution connects immutable schema nodes. Putting migration behavior inside a
single schema node would blur "what this schema means" with "how to translate
to another schema."

### 3.6 Patchpit App Runtime Contracts

Examples:

- app manifests declare which state schemas they publish and consume
- app state documents store `schemaId`/`schemaRef` beside Automerge data
- a service worker hosts Tarstate beside Automerge network sync
- separate app frames/processes share one validation, query, and write boundary
- the service worker rejects malformed writes before applying Automerge changes
- codecs and schema manifests are loaded into the shared runtime boundary

Why outside core:

Patchpit makes schemas the app interoperability contract, but that contract is
not only relation shape. The runtime also needs schema discovery, document
bindings, codec availability, permissions, write routing, and possibly
cross-version negotiation. Those belong in Patchpit or topology manifests that
compose with `tarstate.schema`; they should not be baked into the base relation
catalog.

Patchpit does pressure core v1 to provide stable `schemaId`, deterministic
validation diagnostics, logical row-key identity, structured refs, strict row
validation, and portable custom codec names. It does not require core v1 to know
about service workers, Automerge, app manifests, or process boundaries.

## 4. Scenario Matrix

| Scenario | Core V1 Requirement | Later-Layer Requirement |
| --- | --- | --- |
| Patchpit apps beside data | `schemaId`, strict validation, diagnostics, custom codecs, row-key identity | app schema registry, service-worker topology, schema refs, write routing |
| Presence points at game pieces | `ephemeral`, `custom` object refs, ordinary relation schema | topology routes presence writes; evolution rewrites refs |
| Two documents plus memory drafts | same schema language for all relations | topology/data spaces and explicit commit query |
| Rewound doc plus live presence | object refs remain ordinary field values | snapshot vector pins document heads and presence/runtime clocks |
| Blob-backed assets | string/custom blob handles and asset metadata | blob capability and availability constraints |
| Vendor JSON import | `json` fields and strict diagnostics | import mapping, drift diagnostics, richer object fields |
| Accounting ledger | finite number or string/custom decimal fields | decimal/integer types, constraints, generated validators |
| Spreadsheet | cells/formulas as relations | derived relations, dependency graph, materialization |
| Agent traces | parent-child refs, JSON/custom payloads | redaction constraints, stream topology, derived summaries |
| Knowledge graph bridge | ids, refs, custom semantic ids | open-world linking and semantic extension layer |
| CRDT rich text | custom codec for text/ranges/object ids | topology, codec capabilities, merge semantics |
| Stream current state | event rows | derived current-state relation and stream binding |

## 5. Core Spec Edits Applied In This Pass

These clarifications were folded back into `docs/schema-spec.md`:

1. Add an explicit warning that `number` is finite JS numeric data, not exact
   decimal or arbitrary-precision integer data.
2. Add `relationId`, `fieldId`, `aliases`, `reservedNames`, `defaults`,
   `fieldTypes`, and `rowKeyEncoding` to reserved names, or explicitly state
   they are not v1 concepts.
3. Clarify that unknown-data preservation is adapter/evolution behavior and
   does not make extra fields valid under strict row validation.
4. Add conformance scenarios for scalar-key ambiguity: string `"1"` versus
   number `1`, boolean keys, `-0`, and custom `toScalar`.
5. Clarify that structured ref targets are required because string shorthand is
   authoring-only and cannot support dotted names or future composite targets.
6. Clarify that `metadata` is not an extension escape hatch: tools may preserve
   it, but core behavior must not depend on it.
7. Clarify that relation and field names are scoped to one `schemaId`, not
   global compatibility anchors.
8. Clarify that `ref` is a typed scalar reference, not a full foreign-key
   constraint.
9. Clarify that `ephemeral` does not weaken validation, keys, refs, or future
   evolution semantics.
10. Define logical row-key values and portable row-key text.
11. Clarify present `undefined`, hostile JS objects, sparse arrays, and JSON
    field validation.
12. Tighten implementation-surface diagnostics and hydration collect mode.

None of these added a new field type or changed the core manifest's layer
boundary.

## 6. Pressures Still Open

These are real but not yet accepted as v1 changes:

- `custom` field parameters. A future `options` object may be necessary for
  parameterized codecs such as decimal scale, CRDT range policy, bytes encoding,
  or geometry precision. For now, v1 relies on domain-specific codec names.
- richer codec declarations. `scalar` and `keyable` may be too weak for merge
  semantics, ordering, validation capability, range stability, and conflict
  exposure.
- `anchoredPath` portability. V1 now defines schema-level equality as exact
  string equality, but runtime path semantics remain host-defined.
- content-hash profiles. The spec defines canonical document bytes but still
  separates semantic `schemaId` from future content hashes.
- duplicate JSON object member handling. Parsed JS objects cannot observe
  duplicate JSON members; a text parser may need a separate diagnostic policy.

## 7. Decision Pressure Summary

High confidence:

- core v1 should stay a small relation catalog
- canonical JSON-compatible data remains the source format
- runtime behavior stays behind named codecs and capabilities
- topology, constraints, derived relations, and evolution remain separate
- strict row validation remains closed-world

Medium confidence:

- refs limited to string-valued single-field keys for v1
- no `relationId` or `fieldId` in v1
- no richer nested field shapes in v1
- no adapter-specific row-key storage encoding in core v1

Watch closely:

- composite refs may become urgent sooner than expected
- codec declarations may need richer capability declarations after the first
  real custom codec examples
- exact numeric work may need an integer or decimal type earlier than other
  richer field types
- stable relation/field identity may become necessary if lenses alone are
  awkward for real rename histories
