# Serializable Schema Research

This note explores a serializable schema format for Tarstate. It is not an API
commitment. The goal is to make the relation model portable while preserving the
typed builder DX that currently works well in TypeScript.

The normative v1 draft lives in `docs/schema-spec.md`. The decomplected core
pressure pass lives in `docs/schema-core-pressure.md`. This file remains the
research notebook and scenario corpus behind those specs.

## Recommendation

Use a canonical JSON-compatible schema manifest, with optional EDN/YAML authoring
syntax layered on top.

The manifest should be a small relational catalog, not a direct JSON Schema
clone. JSON Schema is useful for validating nested documents, but Tarstate needs
metadata about relations, keys, refs, constraints, indexes, runtimes, and
schema-version translation. Those concerns are awkward in plain JSON Schema and
are already close to Tarstate's existing `RelationRef` and `FieldSpec` data.

The canonical format should be:

- JSON-compatible data only: strings, finite numbers, booleans, null, arrays,
  and objects.
- Stable under canonical JSON serialization and content hashing.
- Friendly to TypeScript generation and runtime hydration.
- Able to reference custom field codecs and validators by symbolic registry key,
  not by serializing functions.
- Versioned as immutable schema nodes connected by bidirectional lenses.

The top-level names should separate the manifest format from the application
schema identity:

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "real-estate@3",
  "relations": {}
}
```

`formatVersion` is the wire-format version. `schemaId` is the application schema
node used for compatibility and evolution. Avoid a bare `id` or `version` at the
top level because both become ambiguous once Cambria-style schema graphs enter
the design.

EDN can be a very good authoring and inspection format because keywords fit
schema tags nicely, but it should compile to the same JSON-compatible manifest.
That keeps the default runtime dependency-free for JS users and still leaves room
for Relic/Clojure-flavored tooling.

## Current Starting Point

The current schema API already stores most built-in relation metadata as data:

- relation name
- key field or composite key fields
- field specs
- field kind
- optional and nullable flags
- id domain
- ref target
- ephemeral relation flag

The main non-serializable part is custom field behavior. `CustomFieldSpec` can
carry functions for validation, stable keys, scalar conversion, and comparison.
Those functions need to become named capabilities resolved through a registry
during hydration.

Queries and constraints are also data-shaped, but they are a separate layer.
They may embed relation refs and host functions, so they need their own
serialization rules instead of being smuggled into the base relation schema.

## Functional Relational Scope

Tarstate should treat the schema manifest as part of a functional relational
programming model, not merely as app-state metadata.

The useful split from *Out of the Tar Pit* is:

- essential state: base relations and their attribute types
- essential logic: derived relations, pure functions, and integrity constraints
- accidental state/control: caches, indexes, materialized storage,
  denormalization, and runtime-specific performance choices
- outside-world interfaces: UI, network, storage adapters, host capabilities

That split implies the manifest should not collapse everything into one
"database schema" bucket. A relation's fields and keys describe essential state.
Constraints and derived relation definitions describe essential logic. Indexes,
materialization declarations, storage layout, and adapter ownership describe
accidental state/control and should remain separate, declarative hints.

Design consequences:

- Base relation manifests must be storage-independent. They should not mention
  Automerge paths, SQL table names, React components, cache keys, or physical
  indexes.
- Derived relations should be allowed later as named query manifests, but not
  confused with base relations.
- Materialized views should be declared as performance hints over derived
  relations, not as new essential source data.
- Runtime adapters can attach capabilities and storage mappings outside the
  essential relation manifest.
- Schema evolution lenses should translate essential state and essential logic,
  while runtime hints can be regenerated or ignored per environment.
- If data can be derived, the schema should bias toward describing how to derive
  it rather than storing it as another source relation.

This matters because Tarstate is trying to be a way to program with normalized
relations and query-as-data. A good serializable schema should make reasoning
easier by preserving the separation between facts, derivations, constraints,
and performance machinery.

### Paradigm Guardrails

Do not design this as a schema for "state management." Tarstate should be able
to model relationships in many kinds of systems:

- application domain facts
- UI/runtime observations
- CRDT document structure
- presence and peer state
- file and asset indexes
- event streams
- network and connection state
- imported external datasets
- generated views
- simulation state
- permissions and capabilities
- jobs, tasks, workflows, and agent traces
- scientific, financial, game, design, and operational data

The schema should therefore be open-world:

- Relation and field names should not encode app-specific assumptions.
- Data-space kinds should be extensible by capability key, not closed enums.
- Custom codecs should be registered capabilities, not special cases in core.
- Topology should describe composition without limiting what can be composed.
- Query, derivation, constraint, and lens manifests should be data and should
  compose predictably.
- Unknown future relation metadata should be preserved when it is inert
  `metadata`, and rejected with diagnostics when it would change semantics.

It is reasonable to borrow category-theory-shaped discipline without forcing
category-theory vocabulary into the public API:

- schemas are nodes in a compatibility graph
- lenses are bidirectional mappings between schema nodes
- queries are composable transformations from relation sets to relation sets
- codecs are structure-preserving embeddings into scalar or JSON-compatible
  representations
- constraints are predicates over relations
- topology composes independent sources into one relational universe

Those ideas should influence the design by making composition laws and
round-tripping explicit. They should not leak into everyday names if plainer
names such as `relations`, `fields`, `lenses`, `queries`, and `bindings` are
clearer.

Tarstate should also distinguish closed-world and open-world interpretation.
Within a hydrated schema, row validation, constraints, and transaction checks are
closed-world: missing required data is an error. When linking across external
datasets, semantic vocabularies, JSON-LD/RDF, package registries, or remote
snapshots, absence may mean unknown rather than false. The manifest should allow
open-world linking through refs, codecs, and extensions without weakening local
closed-world validation.

### Type And Relation System Influences

The manifest should borrow selectively from languages and systems with strong
type or relation models:

- Haskell/ML: algebraic data types, explicit optionality, parametric thinking,
  and typeclass-like capability dictionaries.
- TypeScript: structural object types, ergonomic inference, discriminated
  unions, and practical interop with plain JSON.
- Clojure/EDN/Datomic/DataScript: data-first schemas, keywords as stable names,
  facts/attributes, and query-as-data.
- SQL/Codd: relations, keys, constraints, joins, projections, and data
  independence from physical storage.
- Datalog/logic programming: derived facts, rule-like logic, and declarative
  dependency analysis.
- Protobuf/Avro: schema evolution, field identity, compatibility rules, and
  generated code.
- JSON Schema: external validation vocabulary and generated API contracts, but
  not the core source model.
- RDF/semantic web systems: open-world naming and cross-dataset linking, while
  avoiding excessive global ontology machinery in core.

Design lessons:

- Prefer algebraic data over executable callbacks in the manifest.
- Model records, variants, options, refs, and codecs explicitly.
- Keep field names stable and use lenses for renames rather than treating names
  as disposable presentation labels.
- Distinguish type compatibility from storage compatibility.
- Treat capability registries like typeclass dictionaries: the manifest can
  name required behavior, but a runtime must provide the implementation.
- Keep derived facts declarative so the system can reason about dependencies,
  materialization, and invalidation.
- Avoid making the schema language Turing-complete. Host capabilities should be
  named and explicit when the pure data vocabulary is insufficient.
- Preserve enough structure for code generation, query planning, validation,
  and evolution without requiring all consumers to implement every advanced
  feature.

## External Format Survey

A comparison pass against functional-relational, logic, database-schema, and
data-schema formats reinforces the same boundary: Tarstate's canonical format
should stay a small JSON-compatible relation catalog. Other formats are useful
as authoring languages, generated artifacts, or later query/constraint layers,
but none should replace the v1 manifest as the source of truth.

| Format family | Strongest learning | Fit for Tarstate |
| --- | --- | --- |
| DDlog | Typed `input relation` declarations, record-like fields, `primary key`, ADTs, extern types, and rules make it the best textual influence for a future Tarstate DSL. | Borrow syntax and generate to DDlog for rule/materialization experiments; do not adopt its program format as the manifest. |
| Souffle | `.decl` relation signatures and subtype/union/record/ADT support are good for static analysis and generated Datalog programs. | Generate to Souffle when useful; it lacks native keys, refs, codecs, canonicalization, and evolution semantics. |
| Flix | First-class, typed Datalog constraint values are a strong model for composable future query and constraint fragments. | Borrow composition ideas for a later rule layer; not a base schema format. |
| Rel / LogicBlox | Relations are the programming unit; base and derived relations, integrity constraints, and Graph Normal Form clarify the fact/derivation split. | Use as a semantic north star. Tarstate can optionally generate a more atomic fact projection, but v1 should keep ergonomic record-shaped relations. |
| Datomic / DataScript | Schema as ordinary EDN data with `:db/ident`, value types, cardinality, uniqueness, docs, refs, and query-as-data is the closest Clojure-family authoring model. | Add optional EDN authoring that compiles to the canonical manifest. Do not switch to EAV as the core representation. |
| XTDB | Dynamic document storage, SQL/XTQL querying, and temporal history are good runtime/storage influences. | Treat as a storage/query target, not a schema source, because it does not require a closed-world relation manifest. |
| Ciao Prolog assertions | Predicate assertions separate `pred`, `calls`, `success`, `comp`, modes, and reusable regular types from implementation. | Keep base relation shape separate from future assertions, constraints, modes, and compatibility checks. |
| Mercury | Type declarations, predicate signatures, modes, and determinism are cleanly separated. | If Tarstate grows a typed relational DSL, keep type declarations separate from relation/query signatures; defer modes/determinism. |
| Tutorial D / relational algebra | Relation headings, domains, relvars, candidate keys, constraints, set semantics, and no SQL null/bag leakage match Tarstate's desired semantics. | Good conceptual model, weak interchange format. |
| Typed miniKanren, OCanren, Walrus, Curry | Host-language ADTs, typed logic values, generic derivation, reification, and exhaustive matching improve relational-programming ergonomics. | Generate host bindings, reifiers, and exhaustive validators from Tarstate schemas; do not adopt miniKanren/Curry syntax for storage. |
| DBML / SQL DDL | Tables, columns, primary keys, composite keys, refs, and diagrams map naturally to relation catalogs. | Useful authoring/export surface, but too physical and SQL-shaped to be canonical. SQL null/default/index/FK behavior must not leak into v1. |
| JSON Schema / OpenAPI | Excellent validator and API-contract ecosystems. | Generate from Tarstate for row validation and HTTP docs. Relation identity, refs, codecs, and lenses need Tarstate semantics, not custom JSON Schema keywords as source of truth. |
| Avro / Protobuf | Canonical forms, schema resolution, aliases, field numbers, reserved names, unknown-field behavior, and code generation are useful evolution lessons. | Generate artifacts and borrow evolution discipline. Do not add field numbers to v1 solely to mimic Protobuf. |
| GraphQL SDL | Good public API type surface with custom scalars, `ID`, descriptions, deprecation, and introspection. | Generate API schemas. GraphQL is nullable-by-default and resolver-driven, not a normalized base-state schema. |
| CUE | Constraint unification and order-independent composition are excellent for authoring and validation. | Consider a Tarstate CUE package that emits canonical JSON. CUE refs and constraints are not relation refs. |

Reference sources for the survey include the DDlog language reference, Souffle
relations and types docs, Flix fixpoints docs, the Rel paper and Rel base
relation docs, Datomic schema reference, DataScript README, XTDB overview and
XTQL docs, Ciao assertions/regtypes/modes docs, Mercury types and modes docs,
DBML syntax docs, PostgreSQL constraint docs, JSON Schema core/validation docs,
OpenAPI specification, Avro specification, Protobuf proto3 guide, GraphQL type
system spec, and the CUE introduction/spec.

### Learnings For The Schema Prototype

The prototype should optimize for a disciplined center plus cheap projections:

- Implement `toSchemaManifest`, `validateSchemaManifest`,
  `canonicalSchemaManifest`, `stringifyCanonicalSchemaManifest`, and
  `hydrateSchemaManifest` before adding richer field types. Most external formats
  become useful only after Tarstate has one reliable center to import/export.
- Keep JSON-compatible manifest data canonical, but allow authoring frontends:
  a DDlog/DBML-like Tarstate DSL, EDN for Relic/Clojure users, and possibly CUE
  for constraint-heavy teams. These must compile to the same canonical manifest.
- Add structured ref authoring early. String shorthands like `"agents.id"` are
  convenient, but several surveyed formats show that qualified names and composite
  keys become ambiguous quickly.
- Treat DBML, SQL DDL, JSON Schema, Avro, Protobuf, GraphQL SDL, OpenAPI,
  Souffle, DDlog, and Datomic/DataScript as generated artifacts or import targets.
  Round-tripping is allowed only when the target can preserve Tarstate semantics
  or carry explicit Tarstate metadata.
- Do not make Graph Normal Form or 6NF the canonical model for v1. A generated
  fact projection may be valuable for provenance, diffs, sync, lenses, or
  analysis, but authors should not have to split every record field into its own
  relation.
- Add an `assertions` or `constraints` layer later rather than growing base field
  manifests with every useful invariant. Ciao, Mercury, SQL, Rel, and JSON Schema
  all point to the same split: field shape and integrity predicates evolve at
  different rates.
- Borrow Avro/Protobuf evolution discipline without copying their identity model.
  V1 can keep names-plus-`schemaId` and explicit lenses; `relationId`/`fieldId`
  remain reserved until real rename histories prove they are needed.

### API And Behavior Implications

External formats should not change the runtime behavior of base Tarstate
relations by accident.

- Builder APIs should remain the best TypeScript authoring path. Manifest APIs
  should be explicit import/export/hydration boundaries, not a replacement for
  `defineSchema` in application code.
- `refField` should gain a structured overload such as
  `refField({ relation, field })`. String shorthand can remain authoring sugar,
  but export must reject ambiguous strings instead of guessing.
- Custom field APIs should separate portable codec identity from executable
  behavior. The manifest should name codecs; hydration should resolve runtime
  validators, key functions, scalar conversions, comparators, and reifiers.
- Row validation should stay Tarstate-defined: required by default, optional and
  nullable separate, present `undefined` invalid, extra fields invalid in strict
  validation. Do not inherit nullable-by-default behavior from SQL, DBML, or
  GraphQL.
- `ref` should remain a typed scalar reference in v1, not a full SQL foreign-key
  constraint. Existence checks, cascades, composite foreign keys, and unique
  non-key references belong in the later constraints/assertions layer.
- Generated JSON Schema/OpenAPI/GraphQL/SQL should advertise their semantic loss
  clearly. For example, a GraphQL `ID!` or SQL `TEXT NOT NULL` column is only a
  projection of Tarstate `id` semantics unless Tarstate metadata is preserved.
- Tarstate APIs should eventually expose generators as explicit tools, for
  example `toJsonSchema`, `toDbml`, `toSqlDdl`, `toGraphqlSdl`, `toAvro`,
  `toProtobuf`, `toDatalog`, and `toEdn`, rather than making adapters infer these
  projections ad hoc.
- Query, derived-relation, assertion, topology, and evolution manifests should
  compose with schema manifests by `schemaId` and relation names. They should not
  be hidden inside base relation definitions.

## Extensions And Capabilities

The manifest needs an extension story because Tarstate is a paradigm surface,
not a closed product format. People will bring domain-specific types, runtimes,
query operators, validators, lens ops, storage adapters, and generated tooling
that core cannot predict.

Separate three concepts:

- `metadata`: inert JSON-compatible data that core preserves but never
  interprets.
- `extensions`: semantic data that may affect interpretation and therefore
  needs feature negotiation.
- `capabilities`: named runtime behavior used to hydrate custom codecs,
  functions, data spaces, lens operations, or query operators.

Top-level sketch:

```ts
type ExtensionUseManifest = {
  readonly extensionId: string;
  readonly formatVersion: number;
  readonly required?: boolean;
  readonly metadata?: Record<string, JsonValue>;
};

type CapabilityRequirementsManifest = {
  readonly codecs?: readonly string[];
  readonly dataSpaceKinds?: readonly string[];
  readonly queryOperators?: readonly string[];
  readonly lensOperations?: readonly string[];
  readonly hostFunctions?: readonly string[];
};
```

Possible top-level fields:

```ts
type SchemaManifest = {
  readonly kind: 'tarstate.schema';
  readonly formatVersion: 1;
  readonly schemaId: string;
  readonly relations: Record<string, RelationManifest>;
  readonly extensions?: readonly ExtensionUseManifest[];
  readonly requires?: CapabilityRequirementsManifest;
};
```

Rules:

- Unknown optional extensions are preserved through canonicalization.
- Unknown required extensions make validation fail before hydration.
- Extension ids should be globally unlikely to collide, for example
  `com.example.geo`, `dev.mytool.forms`, or a URL-like id.
- Extension payloads must be JSON-compatible.
- Extensions must declare whether their data is inert, validation-affecting,
  hydration-affecting, query-affecting, or evolution-affecting.
- Core reserves the `tarstate.*` extension namespace.
- Extensions cannot smuggle executable code into the manifest.
- Executable behavior is always a named capability supplied by the runtime.
- Canonicalization sorts extension entries by `extensionId` and
  `formatVersion`.

Examples:

- A geospatial extension adds a `geo.point` codec and optional spatial index
  hints.
- A forms extension adds UI labels and input widgets as inert metadata.
- A permissions extension adds semantic constraints that must be understood by
  the runtime, so it is required.
- A domain package adds a `money.decimal` codec and declares its scalar
  representation.
- A research runtime adds a new lens operation for relation normalization and
  requires support before evolution can run.

This keeps the base schema small while giving serious users a disciplined way to
grow the language.

## Runtime And Data-Space Topology

The base schema should not encode physical storage, but Tarstate also needs a
serializable way to describe how relations are assembled from many data spaces.
This should be a separate manifest layer, not fields on `RelationManifest`.

Call this a topology or binding manifest:

```ts
type RuntimeTopologyManifest = {
  readonly kind: 'tarstate.runtimeTopology';
  readonly formatVersion: 1;
  readonly topologyId: string;
  readonly dataSpaces: Record<string, DataSpaceManifest>;
  readonly relationBindings: Record<string, RelationBindingManifest>;
  readonly metadata?: Record<string, JsonValue>;
};
```

Data spaces are logical sources or runtimes, not relation definitions:

```ts
type DataSpaceManifest =
  | { readonly kind: 'automerge.document'; readonly documentId?: string }
  | { readonly kind: 'automerge.presence'; readonly channel: string }
  | { readonly kind: 'memory.immer'; readonly name: string }
  | { readonly kind: 'json.snapshot'; readonly name: string }
  | { readonly kind: 'blob.store'; readonly name: string }
  | { readonly kind: 'event.stream'; readonly name: string }
  | { readonly kind: 'connection.state'; readonly name: string }
  | { readonly kind: 'custom'; readonly capability: string };
```

The built-in `kind` examples are vocabulary, not a closed universe. Anything
outside the known set should use `kind: "custom"` plus a capability key until a
pattern is common enough to standardize.

Relation bindings say where rows come from and what write semantics apply:

```ts
type RelationBindingManifest = {
  readonly relation: string;
  readonly dataSpace: string;
  readonly access?: 'readOnly' | 'readWrite' | 'localOnly' | 'derived';
  readonly ownership?: 'authoritative' | 'mirror' | 'cache' | 'presence';
  readonly codec?: string;
  readonly path?: JsonValue;
  readonly metadata?: Record<string, JsonValue>;
};
```

This lets a Tarstate app state: "these relations describe the logical model;
these bindings describe where this runtime gets them." It supports composed
systems without contaminating the essential relation schema.

Examples:

- A base relation `cards` is stored in an Automerge document.
- A relation `peerPresence` comes from Automerge presence, is local-only or
  ephemeral, and references a `cards` object id.
- A relation `connectionStatus` comes from a network runtime and is ephemeral.
- A relation `assetBlobs` indexes external blob ids, while the bytes live in a
  blob store.
- A relation `importRows` is a read-only JSON snapshot.
- A relation `draftEdits` lives in an Immer memory space before being committed
  to an Automerge document.
- A relation `activityEvents` comes from an append-only event stream and is
  projected into current state by derived relations.

Cross-space relationships should be modeled at the relational level through ids,
refs, constraints, and codecs. For example, an Automerge presence row can point
to a document object by storing an `automerge.objectReference` custom field. The
binding says presence and document rows come from different data spaces; the
schema says what the value means.

Design consequences:

- `RelationManifest` remains storage-independent.
- Runtime topology is optional and can vary per deployment.
- Cross-runtime joins are normal Tarstate queries over composed sources.
- Writes need routing through relation bindings, not through relation schema.
- Ephemeral runtime relations such as presence and connection state should still
  have schemas so queries can reason over them.
- Blob bytes and streams should not be forced into row JSON; relations can index
  handles, metadata, offsets, hashes, and capabilities.
- Object ids are data only when a codec gives them stable comparison/key
  behavior.

### Composite Runtime Snapshots

A composed runtime snapshot should identify one coherent observation across all
data spaces, not just "current app state." For Automerge-backed relations, the
snapshot coordinate is the selected document heads. For presence, connection,
and memory spaces, the coordinate may be a runtime sequence, peer clock, session
id, or local generation. Together these coordinates form a small version vector
for the mixed runtime state.

The snapshot source should be pinned to that observation. Holding a snapshot and
reading it later should not silently advance to newer document heads or presence
generations.

Any runtime that participates in a replayable composite snapshot needs a version
coordinate. If a component cannot provide one, the composed runtime can still be
queried live, but tools should not treat its result as a complete replay token.

Object-id presence resolution depends on that vector. A presence row that names
an Automerge object id is only interpretable against the document heads selected
for the query or snapshot. At different heads, the object may exist, be deleted,
or expose different field values; the presence value has not changed, but its
relation to document state has.

Object ids also need a data-space coordinate. In a composed runtime, presence
should normally identify the target runtime or document as well as the object
id. Joining on object id alone can false-match when multiple documents,
branches, or runtimes are present.

This policy is not part of `RelationManifest`. The base relation schema defines
row meaning, runtime topology defines which data spaces provide rows, and
snapshot/version-vector policy defines which observations are selected from
those spaces. Keeping those layers separate prevents Automerge heads, presence
clocks, connection generations, or memory draft ids from becoming accidental
relation fields.

## Candidate Formats

### JSON Catalog

The strongest default candidate:

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "real-estate@3",
  "relations": {
    "listings": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "listing" },
        "agentId": {
          "type": "ref",
          "target": { "relation": "agents", "field": "id" }
        },
        "price": { "type": "number" },
        "status": { "type": "enum", "values": ["active", "sold"] },
        "notes": { "type": "string", "optional": true, "nullable": true },
        "metadata": { "type": "json" }
      }
    }
  }
}
```

Pros:

- Native to TypeScript, browsers, workers, package manifests, HTTP, and
  Automerge documents.
- Easy to hash, validate, diff, test, and store.
- Simple for `hydrateSchemaManifest(manifest)` and
  `toSchemaManifest(schema)`.

Cons:

- Verbose for hand-authored schemas.
- No first-class keywords or tagged values.
- Needs conventions for refs, ids, and symbolic custom codecs.

### EDN Authoring

Useful as an optional surface:

```clojure
{:kind :tarstate.schema
 :format-version 1
 :schema-id "real-estate@3"
 :relations
 {:listings
  {:key :id
   :fields
   {:id {:type :id :domain :listing}
    :agentId {:type :ref :target [:agents :id]}
    :price {:type :number}
    :status {:type :enum :values [:active :sold]}
    :notes {:type :string :optional true :nullable true}
    :metadata {:type :json}}}}}
```

Pros:

- Concise and pleasant for Relic/Clojure-adjacent users.
- Keywords make tags and field names clearer.
- Good fit for query-as-data examples.

Cons:

- Adds parser/printer decisions and a dependency or maintained parser.
- Most JS users will still want JSON.
- EDN values like symbols, keywords, sets, and namespaced maps need a defined
  projection into the canonical manifest.

The practical path is EDN as a frontend, not the storage representation.

### JSON Schema Extension

Possible but not ideal:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "x-tarstate-id-domain": "listing" },
    "agentId": { "type": "string", "x-tarstate-ref": "agents.id" }
  },
  "required": ["id", "agentId"],
  "x-tarstate-key": "id"
}
```

Pros:

- Existing validators and tooling.
- Familiar to API consumers.

Cons:

- Relation-level concerns become extension fields.
- Composite keys, refs, constraints, indexes, evolution lenses, and custom
  scalar behavior are not native.
- JSON Schema compatibility rules are not the same as Tarstate compatibility.

JSON Schema should be generated from Tarstate schemas where useful, not be the
source format.

### TypeScript-Only Builders

Keep the current builder as the best authoring DX:

```ts
const schema = defineSchema({
  listings: relation<Listing>({
    key: 'id',
    fields: {
      id: idField('listing'),
      agentId: refField('agents.id'),
      price: numberField()
    }
  })
});
```

This should remain canonical for application code. The serializable format
should complement it with:

- `toSchemaManifest(schema)`
- `hydrateSchemaManifest(manifest, { codecs })`
- `schemaManifest({ ... })` for direct data authoring with type inference
- optional `parseSchemaEdn(text)` and `printSchemaEdn(manifest)`

## Proposed Manifest Shape

Top level:

```ts
type SchemaManifest = {
  readonly kind: 'tarstate.schema';
  readonly formatVersion: 1;
  readonly schemaId: string;
  readonly description?: string;
  readonly relations: Record<string, RelationManifest>;
  readonly constraints?: readonly ConstraintManifest[];
  readonly indexes?: readonly IndexManifest[];
  readonly codecs?: Record<string, CodecDeclaration>;
  readonly evolution?: EvolutionManifest;
  readonly extensions?: readonly ExtensionUseManifest[];
  readonly requires?: CapabilityRequirementsManifest;
  readonly metadata?: Record<string, JsonValue>;
};
```

Naming stance:

- `SchemaManifest` means the serializable schema document.
- `RelationManifest` means one relation entry inside that document.
- `FieldManifest` means one relation field entry.
- `formatVersion` means Tarstate's schema-manifest format version.
- `schemaId` means the user's immutable application schema node.
- `codec` means a named runtime capability used to hydrate custom behavior.
- `metadata` means inert user/tool data that core preserves but does not
  interpret.
- `defaultSchemaId` means the schema node tools should prefer when no caller
  requests a view schema in an evolution graph.
- `lensId` means one named bidirectional translation edge between two schema
  nodes.
- `schemaNodes` means the known schema nodes in an evolution graph.
- `operations` means the ordered lens operations that make up one translation
  edge.

Avoid shorter alternatives like `id`, `version`, `schema`, and `typeVersion` in
the manifest because they read well initially but become unclear when a document
contains multiple schema nodes, evolution edges, and generated runtime refs.

Relation:

```ts
type RelationManifest = {
  readonly relationId?: string;
  readonly key: string | readonly string[];
  readonly fields: Record<string, FieldManifest>;
  readonly reservedNames?: readonly string[];
  readonly ephemeral?: boolean;
  readonly description?: string;
  readonly metadata?: Record<string, JsonValue>;
};
```

Field:

```ts
type FieldManifest = {
  readonly fieldId?: string;
  readonly type: FieldType;
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly description?: string;
  readonly default?: DefaultManifest;
  readonly metadata?: Record<string, JsonValue>;

  readonly domain?: string;
  readonly target?: RefTarget;
  readonly values?: readonly JsonValue[];
  readonly value?: JsonValue;
  readonly unknown?: 'reject' | 'preserve' | 'fallback';
  readonly fallback?: JsonValue;
  readonly encoding?: 'base64url' | 'hex';
  readonly format?: string;
  readonly item?: FieldManifest;
  readonly fields?: Record<string, FieldManifest>;
  readonly variants?: readonly FieldManifest[] | Record<string, FieldManifest>;
  readonly codec?: string;
};
```

`relationId` and `fieldId` are deferred from core v1 because the current
Tarstate API identifies fields by name and explicit lenses can represent rename
intent. They remain reserved because schema evolution may eventually benefit
from stable identity that survives renames. If they are introduced later, they
should behave more like Protobuf field numbers or Avro aliases than like display
names. Deleted or renamed fields should be tracked through `reservedNames` and
lenses so future schemas cannot accidentally reuse an old meaning.

Ref target:

```ts
type RefTarget =
  | { readonly relation: string; readonly field: string }
  | { readonly relation: string; readonly fields: readonly string[] };
```

## Canonical Form

The canonical form is the byte-stable representation used for hashing, cache
keys, equality, generated artifacts, and cross-runtime exchange. Authoring
surfaces may accept shorthand, but `canonicalSchemaManifest(...)` should emit
only canonical form.

Rules:

- Object keys sort lexicographically at every level.
- `kind` is always `"tarstate.schema"`.
- `formatVersion` is always the integer `1` for this format.
- `schemaId` is required and must be non-empty.
- Relation names and field names are object keys, not duplicated inside each
  relation or field entry.
- Omit falsey default flags: `optional: false`, `nullable: false`, and
  `ephemeral: false` are absent in canonical output.
- Keep semantically meaningful false/null values, such as `default: false` or
  `fallback: null`.
- Preserve user `metadata`, but require it to be JSON-compatible and
  canonicalize its object key order.
- Ref targets are structured objects, not strings.
- Composite keys and field lists preserve array order because order can affect
  key encoding.
- Empty composite keys are invalid.
- Duplicate composite-key fields are invalid.
- Non-finite numbers, `undefined`, functions, symbols, BigInts, Maps, Sets,
  Dates, and typed arrays are invalid unless a codec explicitly maps them into
  JSON-compatible data.

Canonical ref target:

```json
{ "relation": "agents", "field": "id" }
```

Authoring sugar may accept `"agents.id"` and EDN may accept `[:agents :id]`,
but both normalize to the structured form. This avoids ambiguity for relation
names that contain dots and leaves room for composite targets:

```json
{ "relation": "localizedLabels", "fields": ["locale", "id"] }
```

The first implementation should reject dotted relation names when using string
ref shorthand. The canonical structured form can support any non-empty relation
or field string later without changing the manifest.

Field type names should be short, stable, and host-independent.

```ts
type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'id'
  | 'ref'
  | 'json'
  | 'enum'
  | 'literal'
  | 'array'
  | 'object'
  | 'record'
  | 'tuple'
  | 'union'
  | 'date'
  | 'instant'
  | 'decimal'
  | 'integer'
  | 'bytes'
  | 'anchoredPath'
  | 'custom'
  | 'opaque';
```

The first release can support only the types that exist today:

- `string`
- `number`
- `boolean`
- `id`
- `ref`
- `anchoredPath`
- `json`
- `custom`
- `opaque`

The manifest should reserve the richer names now so the format does not have to
change when richer validation appears.

## Data Type Notes

### Missing, Undefined, Null

`undefined` is not serializable. The schema needs a strict distinction:

- missing field: property is absent
- optional field: missing is allowed
- null field: present with value `null`
- nullable field: null is allowed

Default values should fill missing data, not silently reinterpret null unless a
lens explicitly says so.

### Numbers

JavaScript `number` includes values JSON cannot represent safely. Tarstate
should require finite numbers for `number` fields, as it does today.

Open questions:

- Is `-0` meaningful? Probably no; canonicalization should normalize it to `0`.
- Should integer be a separate field type? Yes, because ids, counters, array
  indexes, and quantities often need integer semantics.
- Should money use `decimal` or integer minor units? The schema should support a
  `decimal` codec, but docs should recommend integer minor units when exact
  arithmetic is required.

### Strings

String fields should not imply trimming, normalization, locale, case folding, or
non-empty constraints. Those belong in constraints or codec metadata.

Useful future refinements:

- `format`: `email`, `url`, `uuid`, `isoDate`, `isoDateTime`
- `minLength` and `maxLength`
- `collation` for sort/compare behavior

### Dates and Times

Dates are a common trap. JS `Date` is not JSON. Suggested split:

- `instant`: ISO 8601 UTC timestamp, a point in time
- `date`: calendar date without timezone, `YYYY-MM-DD`
- `time`: optional future type for wall-clock time without date
- `duration`: optional future type

Until those are first-class, use `string` or `custom` codecs such as
`automerge.date`.

### IDs and References

`id` is semantically a string plus a domain. `ref` is semantically a string plus
a target relation and field.

Use structured targets internally:

```json
{ "type": "ref", "target": { "relation": "agents", "field": "id" } }
```

Allow `"agents.id"` as authoring sugar, but canonicalization should expand it.

Refs should be allowed to point to composite keys eventually:

```json
{
  "type": "ref",
  "target": {
    "relation": "localizedLabels",
    "fields": ["locale", "id"]
  }
}
```

Composite refs imply either multiple local fields or a structured local field.
For relation-level foreign keys, constraints are probably the better home.

### Enums

Enums are useful but risky for distributed compatibility. Adding enum values is
backward-incompatible for old clients unless there is an unknown fallback.

Represent them as data:

```json
{
  "type": "enum",
  "values": ["todo", "doing", "done"],
  "unknown": "preserve"
}
```

Possible unknown policies:

- `reject`: strict validation
- `preserve`: accept unknown values and round-trip them
- `fallback`: map unknown values to a configured value for old views

The default for local-first collaboration should probably be `preserve`.

### Arrays, Tuples, Objects, Records

Current `jsonField` admits arbitrary JSON. Richer schemas can add structure:

- `array`: homogeneous ordered collection
- `tuple`: fixed-position collection
- `object`: known properties
- `record`: string-keyed map of one value type

Important edge cases:

- Sparse arrays are not JSON; reject them.
- Object property order should not matter for equality.
- Array order does matter.
- Record keys are strings; numeric map keys need explicit encoding.
- Optional object properties need the same missing/null distinction as row
  fields.

### Union Types

Union fields are important for event payloads, app-specific state, and imported
API data.

Prefer tagged unions when possible:

```json
{
  "type": "union",
  "tag": "kind",
  "variants": {
    "cash": { "type": "object", "fields": { "kind": { "type": "literal", "value": "cash" } } },
    "loan": { "type": "object", "fields": { "kind": { "type": "literal", "value": "loan" } } }
  }
}
```

Untagged unions are harder to validate, harder to evolve, and worse for
diagnostics.

### Bytes and Binary

JSON has no bytes. Use base64url or hex and name it:

```json
{ "type": "bytes", "encoding": "base64url" }
```

Automerge bytes currently use custom scalar helpers. A first-class `bytes` type
can map to those helpers later.

### Custom and Opaque Values

Custom fields should serialize only their identity and declarative options:

```json
{
  "type": "custom",
  "codec": "automerge.text",
  "description": "an Automerge text value"
}
```

Hydration resolves the codec:

```ts
hydrateSchemaManifest(manifest, {
  codecs: {
    'automerge.text': automergeTextCodec
  }
});
```

Codec capabilities should be explicit:

```ts
type CodecDeclaration = {
  readonly kind: 'codec';
  readonly scalar?: FieldManifest;
  readonly validates?: boolean;
  readonly stableKey?: boolean;
  readonly comparable?: boolean;
};
```

Opaque fields are useful for host objects but should be excluded from portable
schemas unless their relation never crosses a runtime boundary. Opaque key
fields are unsafe unless a stable key codec is registered.

## Constraints and Indexes

Keep constraints outside base fields so field shape and data invariants can
evolve independently.

Examples:

```json
{
  "constraints": [
    { "op": "req", "relation": "listings", "fields": ["id", "price"] },
    { "op": "unique", "relation": "listings", "fields": ["id"] },
    {
      "op": "fk",
      "relation": "listings",
      "fields": ["agentId"],
      "targetRelation": "agents",
      "targetFields": ["id"],
      "cascade": "restrict"
    }
  ]
}
```

Checks need more thought because they depend on serializable predicates. Simple
checks can use query expression data. Host-function checks need a named
capability registry, just like custom field codecs.

Indexes should describe lookup intent, not promise a physical implementation:

```json
{
  "indexes": [
    { "kind": "hash", "relation": "listings", "fields": ["agentId"] },
    { "kind": "btree", "relation": "listings", "fields": ["price"] }
  ]
}
```

## Evolution Model

Cambria's most useful idea for Tarstate is not the exact document lens syntax.
It is the model of immutable schema nodes connected by bidirectional translation
edges.

Tarstate should distinguish:

- storage schema: how data is physically stored in a runtime
- view schema: the schema an application version wants to read and write
- translation graph: known mappings between schema nodes

Top-level shape:

```json
{
  "evolution": {
    "defaultSchemaId": "real-estate@3",
    "schemaNodes": {
      "real-estate@2": { "ref": "./schema-v2.json" },
      "real-estate@3": { "inline": true }
    },
    "lenses": [
      {
        "lensId": "listing-status-v2-v3",
        "fromSchemaId": "real-estate@2",
        "toSchemaId": "real-estate@3",
        "operations": [
          {
            "op": "convertField",
            "relation": "listings",
            "field": "status",
            "fromType": "boolean",
            "toType": "enum",
            "forward": { "false": "active", "true": "sold" },
            "backward": { "active": false, "paused": false, "sold": true }
          }
        ]
      }
    ]
  }
}
```

Unlike one-way migrations, lenses should preserve the ability for old and new
clients to collaborate when possible. That matters for Automerge and other
local-first runtimes where peers may edit different schema versions at the same
time.

### Lens Operations to Support

Start with boring but useful operations:

- `renameRelation`
- `renameField`
- `addField`
- `removeField`
- `convertField`
- `copyField`
- `moveField`
- `splitField`
- `mergeFields`
- `wrapScalar`
- `unwrapScalar`
- `splitRelation`
- `mergeRelation`
- `normalizeRelation`
- `denormalizeRelation`
- `changeKey`
- `changeRef`
- `mapEnum`

Each operation needs explicit forward and backward behavior when information can
be lost.

Examples:

- Renaming a field is reversible.
- Adding an optional field is reversible if unknown fields are preserved.
- Adding a required field needs a default, derivation, lookup, or a partial
  failure mode.
- Splitting `fullName` into `givenName` and `familyName` is culturally unsafe
  and lossy; a lens should force the author to declare how loss is handled.
- Converting `assignee` to `assignees` can use first element, last element, or a
  sidecar field to preserve the old scalar.
- Changing primary keys requires a key map and ref rewrites.

### Unknown Data Preservation

Forward compatibility requires preserving fields and enum values unknown to the
current view. Otherwise an old client can erase data created by a newer client.

The manifest should allow a relation-level unknown policy:

```json
{
  "unknown": {
    "fields": "preserve",
    "enumValues": "preserve"
  }
}
```

Potential policies:

- `reject`: strict mode for server boundaries and tests
- `ignore`: read but do not write back
- `preserve`: round-trip unknown data
- `capture`: move unknown data into an explicit sidecar field

For collaborative runtimes, `preserve` should be the default.

### Sidecars

Some bidirectional transformations need storage for data that one schema cannot
represent. Tarstate should reserve a system relation or metadata slot for this.

Examples:

- old scalar view of a new array value
- original enum value when old schema sees a fallback
- deleted field retained for old clients
- key rewrite maps during id migration
- relation split provenance

Possible system relation:

```json
{
  "relations": {
    "$schemaSidecars": {
      "key": ["schemaId", "relation", "rowKey", "path"],
      "ephemeral": false,
      "fields": {
        "schemaId": { "type": "string" },
        "relation": { "type": "string" },
        "rowKey": { "type": "string" },
        "path": { "type": "json" },
        "value": { "type": "json" }
      }
    }
  }
}
```

This may be too heavy for the first release, but the format should not preclude
it.

### Schema Negotiation

Applications need to know what schema they are seeing:

- data source declares a storage `schemaId`
- app declares a desired view `schemaId`
- runtime finds a path through the lens graph
- reads translate storage rows to view rows
- writes translate view patches back to storage patches

Diagnostics should report:

- no path between schemas
- lossy path
- missing codec
- missing default or lookup for required field
- unsupported lens op
- ambiguous shortest path
- incompatible constraint strengthening
- incompatible compatibility mode, such as backward-only when full transitive
  compatibility is required

Compatibility checks should be graph/path based, not only adjacent-version
based. Local-first clients can miss many releases, so the question is often
"can `schemaId` A still read and write against storage schema B through the
available lens graph?"

Where possible, evolution should translate write patches and relation deltas
directly. Snapshot-only translation is simpler, but it loses intent and can be
too expensive for large relation sets.

## DX Goals

The best user experience is probably three layers:

### 1. Typed Builders

Application authors keep using `defineSchema`, `relation`, and field builders.

### 2. Data Builders

Users who want serializable schemas can write:

```ts
const manifest = schemaManifest({
  schemaId: 'real-estate@3',
  relations: {
    listings: {
      key: 'id',
      fields: {
        id: id('listing'),
        agentId: ref('agents.id'),
        price: number(),
        status: enumeration(['active', 'sold'])
      }
    }
  }
});
```

These builders return plain data, not runtime relation refs.

### 3. Hydration

Runtime code hydrates data into Tarstate refs:

```ts
const schema = hydrateSchemaManifest(manifest, {
  codecs: automergeCodecs,
  diagnosticMode: 'throw'
});
```

Hydration should:

- canonicalize shorthand
- validate manifest structure
- reject missing custom codecs
- attach field behavior
- generate useful diagnostics
- preserve source locations when parsed from EDN/YAML

## Scenario Gauntlet

These scenarios are the design pressure test. A review-ready schema format
should either support each case directly or state a clear non-goal.

### Todo App Becomes Team Planner

Version 1 has `todos { id, text, done }`. Version 2 adds `assigneeId` and
`people`. Version 3 changes `done` into `status`.

Required behavior:

- V1 data hydrates under V2 because `assigneeId` is optional or has a default.
- V3 maps `done: true` to `status: "done"` and `done: false` to
  `status: "todo"`.
- Old clients preserve unknown `status` values such as `"blocked"` rather than
  overwriting them.
- The `done` to `status` mapping is a lens op, not an ad hoc migration hidden
  in app code.

Design implication: enum fields need unknown-value policy, and conversion lenses
need explicit backward behavior.

### Real Estate App Adds Collaboration

Listings start as plain JSON rows. Later, notes become Automerge text and photo
annotations point to Automerge object ids.

Required behavior:

- Portable schema names these fields as custom codecs, for example
  `automerge.text` and `automerge.objectReference`.
- A runtime without those codecs refuses hydration with useful diagnostics.
- A runtime with those codecs can validate, compare, and key values according to
  codec capabilities.
- The base relation schema does not expose Automerge storage paths.

Design implication: codecs are named capabilities; adapter storage details stay
outside essential relation manifests.

### Presence Points Into An Automerge Document

A canvas app stores shapes in an Automerge document. Presence broadcasts each
peer's selected object id and cursor position. A query joins `shapes` with
`peerSelections` to show who is selecting what.

Required behavior:

- `shapes` and `peerSelections` both have relation schemas.
- `peerSelections` is marked ephemeral or bound as presence in topology, not in
  the essential field definitions.
- The selected object reference uses a codec such as
  `automerge.objectReference`.
- Object refs survive path changes when a document tree or array is reordered.
- Queries can join document rows and presence rows by stable object reference or
  by a scalarized object id.
- Presence writes are routed to the presence runtime, not to the document patch
  target.

Design implication: relation schemas describe row meaning; topology describes
which runtime owns reads and writes.

### Patchpit Apps Publish Schemas Beside Data

Patchpit app manifests and app state documents need schemas as runtime
contracts. Each app can publish schemas for the state documents it owns, and
other apps or the shell can use those schemas to query, validate, and route
writes without relying on private TypeScript types.

Required behavior:

- App manifests can point at schema manifests by stable `schemaId` and by a
  resolvable `schemaRef`.
- App state documents can carry the `schemaId` they claim to satisfy beside the
  data, not inside every relation row.
- A shared service worker can host Tarstate beside Automerge network sync and
  act as the validation/query/write boundary for separate app frames.
- The service worker loads schemas, checks codec availability, validates writes,
  routes patches to the correct Automerge document, and returns structured
  diagnostics for rejected writes.
- Apps can talk to other apps through declared relation schemas instead of
  importing each other's private runtime types.
- Bad writes fail before they mutate shared Automerge state.
- Schema mismatch is explicit: a doc with `schemaId` A opened by an app expecting
  `schemaId` B either negotiates through an evolution graph or fails with a
  useful diagnostic.

Design implication: Patchpit is the first concrete consumer of schema manifests
as interoperability contracts. It pressures core v1 to keep `schemaId`,
diagnostics, row-key identity, structured refs, custom codecs, and strict row
validation solid. It does not mean `tarstate.schema` should know about
Patchpit, service workers, Automerge, app manifests, or permissions; those are
topology and runtime-boundary layers.

### Rich Text Has Different Merge Semantics Than Strings

A note app has a title, body text, comments, formatting marks, and selections.
The title is plain string. The body is collaborative rich text. Comments anchor
to ranges. Presence stores cursor endpoints.

Required behavior:

- `string` and `automerge.text`/`loro.text` are distinct schema meanings even if
  both appear as strings in TypeScript.
- Plain string fields can use register/LWW semantics in a CRDT runtime.
- Collaborative text codecs preserve concurrent inserts and expose stable range
  endpoints.
- Formatting marks can have policies such as expands-at-boundary or
  does-not-expand-at-boundary.
- Multiple comments over the same range are modeled by comment ids/anchors, not
  a single scalar mark.
- Cursor and comment anchors should use relative/stable positions rather than
  absolute offsets when the runtime supports them.

Design implication: codecs may need semantic capability declarations beyond
validation, including merge semantics, range stability, and conflict exposure.

### Two Automerge Docs Join With Immer Drafts

A product app has one Automerge document for catalog data and another for a
team's local planning workspace. The UI also keeps unsaved draft edits in an
Immer-backed memory store. A query combines all three.

Required behavior:

- The same schema can describe relations from multiple data spaces.
- Relation bindings route `products` to `catalogDoc`, `plans` to
  `workspaceDoc`, and `draftPlanEdits` to `memory.immer`.
- Cross-doc joins are ordinary query composition.
- Draft relations can shadow or override durable rows through explicit query
  logic, not hidden adapter behavior.
- Committing a draft uses write routing to move data from memory to the target
  Automerge document.

Design implication: composed data spaces need topology metadata, while merge and
override semantics should remain explicit relational logic.

### Blob Store Holds Large Media

A design tool stores image metadata in rows but stores image bytes in a blob
store or remote object store. Rows contain blob ids, hashes, dimensions, and
preview status.

Required behavior:

- Blob bytes are not forced into JSON row values.
- Relations can model `assets`, `assetVariants`, and `blobReferences`.
- Blob handles are strings or custom codecs with stable identity.
- Constraints can require every published asset to reference an available blob.
- Runtime topology binds blob lookup/write capability separately from relation
  schemas.

Design implication: schema should model handles and metadata; large binary
payload transport is a runtime capability.

### Stream Feeds Derived Current State

A collaboration system receives activity events from a stream. The app wants a
current `notifications` relation derived from the append-only event history.

Required behavior:

- The event stream can be represented as an `activityEvents` relation binding.
- `notifications` can later be a named derived relation over events and user
  state.
- Materialization is a performance choice, not a second source of truth.
- Stream offsets, replay status, and connection errors can be separate runtime
  relations.

Design implication: event streams fit the relational model when events are rows
and current state is a derivation.

### Spreadsheet Dependency Graph

A spreadsheet-like tool stores cells, formulas, ranges, and computed values.
Some formulas depend on large ranges, some functions are volatile, and some
dependencies form cycles.

Required behavior:

- Cells and formulas are base relations.
- Computed cell values are derived relations or materialized views.
- Dependencies are query-derived or explicitly represented as relation rows.
- Range dependencies can be represented compactly instead of exploding into one
  edge per cell.
- Cycles and volatile functions produce diagnostics or capability requirements.

Design implication: derived relation manifests need dependency analysis and
materialization metadata; spreadsheet recalculation is a core test family for
functional relational programming.

### Workflow And Agent Trace Provenance

An AI workflow runtime records runs, spans, model calls, tool calls, handoffs,
guardrail results, redaction metadata, and generated summaries.

Required behavior:

- Traces, spans, tool calls, model calls, and outputs are relations with
  parent-child refs.
- Derived summaries and metrics are derived relations over trace events.
- Provenance records which activity, agent, model, or user produced each
  artifact.
- Sensitive data policies and redaction state are explicit fields or
  constraints, not hidden logger behavior.
- Runtime topology can bind some trace data to streams and some to durable
  snapshots.

Design implication: provenance and observability are first-class relational
domains, not logging side channels.

### Connection State Joins With Domain Data

A sync UI needs to show which documents are online, which peers are connected,
and which rows have pending writes.

Required behavior:

- Connection state is represented as ephemeral relations such as
  `runtimeConnections`, `runtimePeers`, and `pendingWrites`.
- Those relations can be queried with durable domain relations.
- Their schemas are real schemas even if their data is runtime-local.
- They are excluded from portable persisted snapshots unless topology says
  otherwise.

Design implication: ephemeral runtime data is still relational data; persistence
is a binding concern.

### Random JSON Snapshot Is Mixed In

An integration imports a vendor JSON file nightly. The app queries it beside
first-party Automerge data and memory-only user preferences.

Required behavior:

- The vendor snapshot is bound as read-only `json.snapshot`.
- Its rows can use `json` fields initially and move to richer object schemas
  later.
- Vendor schema drift produces manifest or import diagnostics.
- First-party writes cannot accidentally target the read-only snapshot.

Design implication: relation bindings need access mode, and schema evolution may
apply to external snapshots too.

### Accounting App Needs Exact Money

Entries have amounts. A team wants reports to reconcile exactly across
browsers, Node, Workers, and imported CSVs.

Required behavior:

- `number` remains finite JS number and is not sold as exact decimal.
- Exact money is modeled as integer minor units or a future `decimal` codec.
- Canonical JSON rejects `NaN`, infinities, and non-JSON numeric values.

Design implication: do not overload `number`; make precision a schema choice.

### Offline Client Misses Two Releases

A local-first client last shipped with `contacts@1`. Current data is
`contacts@4`. The old client edits a phone number while a new client edits a
new `pronouns` field and adds an enum value.

Required behavior:

- Runtime finds a path through the schema graph if one exists.
- Unknown fields and enum values survive the old client's write.
- If the lens path is lossy, diagnostics say which op loses information.
- Writes translate back to the storage schema, not merely reads into the old
  view.

Design implication: evolution must cover read and write translation and needs
unknown-data preservation, not just one-way migrations.

### Imported API Has Messy Optionality

An external API sometimes omits `middleName`, sometimes sends `null`, and
sometimes sends an empty string.

Required behavior:

- Missing, null, and empty string stay distinct.
- `optional` controls missing fields.
- `nullable` controls explicit null.
- Empty string is just a string unless constraints say otherwise.

Design implication: optional and nullable should remain separate flags, and
defaults should fill only missing values unless a lens says otherwise.

### Composite Key Becomes Surrogate Key

`localizedLabels` starts with key `["locale", "labelId"]`. Later it gets a
surrogate `id`, while old refs still use the composite identity.

Required behavior:

- Composite key order is canonical and preserved.
- Changing keys requires a lens that rewrites refs or records a key map.
- Relation-level foreign key constraints can point at multiple fields.
- Single-field `ref` sugar is not enough for the full model.

Design implication: canonical ref targets should allow `field` or `fields`, and
key evolution is a first-class lens category.

### Derived Data Is Accidentally Stored

A project stores `invoice.total` even though it is derivable from line items.
Later line item tax logic changes and totals drift.

Required behavior:

- The schema can distinguish base relations from derived relation manifests.
- A materialized total is declared as a cached derivation, not another source of
  truth.
- Schema evolution updates the derivation, not every stored total, unless the
  runtime intentionally persists the materialization.

Design implication: functional relational scope matters. The format should
support derived relations later and avoid making denormalized state look
essential by default.

### Hand-Written Schema Has Ambiguous Names

A developer writes a relation named `"crm.contacts"` and a ref target string
`"crm.contacts.id"`.

Required behavior:

- Canonical form represents refs structurally.
- String shorthand is either rejected for dotted relation names or parsed only
  under strict rules.
- Diagnostics point to the ambiguous ref field.

Design implication: structured ref targets should be canonical from v1.

### Enum Expansion Meets Old UI

An old UI knows `draft`, `sent`, and `paid`. New data introduces `voided`.

Required behavior:

- Strict server validation may reject `voided` under an old schema.
- Collaborative clients should preserve `voided` and display fallback behavior
  without rewriting the stored value.
- Lenses can map old views to fallback display values while retaining original
  data in sidecars or unknown-value preservation.

Design implication: unknown enum behavior is a compatibility decision, not just
  a validator detail.

### Host Function Sneaks Into a Constraint

A check constraint calls `isValidTaxId(value)` from application code.

Required behavior:

- Serializable constraints cannot embed the function.
- The manifest can reference a named capability such as `taxId.us.valid`.
- Hydration fails if the capability is absent.
- Pure expression constraints remain serializable without a host capability.

Design implication: constraints need the same registry discipline as custom
field codecs.

### Runtime Wants Physical Indexes

An adapter wants a B-tree over `listings.price`, while another runtime can only
scan rows.

Required behavior:

- Index declarations describe lookup intent and planning hints.
- They do not change relation semantics.
- A runtime may ignore an unsupported index with diagnostics or build a local
  physical index.

Design implication: indexes are accidental control/performance metadata and
must stay separate from essential relation definitions.

### Schema Is Used For Code Generation

A package generates TypeScript row types, docs, forms, and import validators
from the manifest.

Required behavior:

- Names are stable and self-documenting.
- Metadata is preserved but not interpreted by core.
- Canonical output is deterministic so generated files do not churn.
- Authoring sugar does not leak into generated artifacts.

Design implication: canonicalization is part of the public contract, not an
implementation detail.

### Malicious Or Corrupt Manifest Arrives

A remote source declares `kind: "tarstate.schema"` but includes a key pointing
to a missing field and a custom field with no codec.

Required behavior:

- Manifest validation reports all structural errors it can find.
- Hydration fails before creating partial runtime refs.
- Diagnostics include relation and field names.
- Unknown future `formatVersion` is rejected unless explicit compatibility mode
  exists.

Design implication: validation is a first-class API, separate from hydration.

## Research Corpus For Examples

The schema design should be tested against a broad corpus, not just todo apps
and CRUD stores. The point is to cover different kinds of relationships, data
spaces, evolution pressure, and runtime behavior.

### Functional Relational Core

Sources:

- *Out of the Tar Pit*
- Codd's relational model
- Datalog and Souffle
- Datomic and DataScript
- Relic

Example fixtures:

- base facts plus derived relations
- constraints as relational predicates
- materialized views as replaceable caches
- query-as-data dependency analysis
- immutable snapshots and what-if transactions

### Incremental Dataflow And Reactive Derivation

Sources:

- DBSP
- Differential Dataflow
- Salsa-style incremental computation
- spreadsheet recalculation systems such as HyperFormula
- reactive derivation systems such as MobX, Solid, Vue, Svelte, and re-frame

Example fixtures:

- dependency graph recalculation
- range dependency compression
- volatile functions
- circular dependencies
- stale materialization diagnostics
- equality pruning for derived values
- partial recompute after relation deltas
- derived UI state as query output

### Workflow, Provenance, And Agent Traces

Sources:

- W3C PROV
- Temporal-style event history
- Airflow/Dagster/Prefect workflow DAGs
- OpenTelemetry traces and GenAI semantic conventions
- agent tracing systems

Example fixtures:

- entity/activity/agent provenance rows
- workflow run/task/asset lineage
- trace/span/tool-call/model-call relations
- replay event streams
- derived workflow state from event history
- redaction and data policy metadata
- generated summaries linked to source spans

### Schema Evolution And Lenses

Sources:

- Cambria
- bidirectional transformation/lens literature
- incremental relational lenses
- live/local schema-change challenge problems
- Avro schema resolution
- Protobuf unknown fields and reserved names
- Confluent compatibility modes

Example fixtures:

- old clients editing new data
- field rename with reserved old name
- enum expansion with unknown-value preservation
- add required field with default
- split/merge relation
- scalar-to-array conversion with sidecar data
- patch translation through a lens path
- incompatible transitive compatibility path

### Type Systems And Extensible Data

Sources:

- Haskell algebraic data types and typeclasses
- Standard ML datatypes
- row-polymorphic and extensible record systems
- OCaml polymorphic variants
- TypeScript structural/discriminated unions

Example fixtures:

- closed object vs open object
- closed enum vs open enum
- tagged union field
- recursive JSON-like value
- custom codec with ordering/keying capability
- ambiguous capability provider
- generated TypeScript row type stability

### Wire Formats And Extension Systems

Sources:

- JSON Schema vocabularies
- OpenAPI specification extensions
- Protobuf custom options and unknown fields
- Avro metadata and canonical fingerprints
- JSON-LD/RDF contexts
- LSP capability negotiation
- plugin contribution manifests such as VS Code

Example fixtures:

- unknown optional extension preserved
- unknown required extension rejected
- capability negotiation succeeds/fails
- canonical fingerprint unchanged by key order
- metadata extension cannot affect validation
- semantic extension must declare required support

### Local-First And CRDT Collaboration

Sources:

- Local-first software
- Automerge document values, rich text, refs, ephemeral data
- Yjs awareness/presence
- Peritext rich-text CRDT
- CRDT literature and collaborative modeling papers

Example fixtures:

- presence points at durable document object id
- remote cursor references rich-text range
- peer state disappears without deleting durable rows
- rich text annotations represented by custom codecs
- concurrent edits create conflicts visible as relations
- multiple Automerge docs joined with memory-only drafts

### Runtime Topology And Mixed Data Spaces

Sources:

- Automerge repositories/doc handles/presence
- Yjs providers and awareness
- event-stream architectures
- blob/object stores
- in-memory immutable stores
- JSON snapshots

Example fixtures:

- two CRDT documents plus Immer draft overlay
- read-only vendor JSON snapshot joined to first-party data
- blob metadata rows with bytes outside the row store
- append-only activity stream projected into current state
- connection state and pending writes as ephemeral relations
- relation binding rejects write to read-only data space

### Semantic Graphs And Open-World Linking

Sources:

- RDF and JSON-LD
- SHACL
- schema.org
- GraphQL
- property graphs
- knowledge graph systems

Example fixtures:

- globally qualified extension ids
- compact local names expanded through context
- open-world relationship where target may be absent locally
- graph edge relation with typed endpoints
- shape validation as generated constraint manifests
- cross-dataset joins through external ids

### Domain-Heavy Schemas

Sources:

- FHIR healthcare resources
- GeoJSON and OGC geospatial formats
- media asset management
- CAD/design document models
- accounting ledgers
- package/dependency graphs
- observability logs/traces/metrics
- IAM and permission systems

Example fixtures:

- healthcare resource refs and code systems
- geospatial point/polygon codec and spatial index hint
- exact money and multi-currency accounting
- design object hierarchy plus cross-object constraints
- package dependency graph with version ranges
- trace/span/event stream derived into service health
- access-control relations joined with domain facts

First broad fixture set:

- GeoJSON FeatureCollection and STAC assets for nested geometry, foreign member
  preservation, derived bounding boxes, spatial index hints, and blob refs.
- glTF document normalization for object graphs, typed refs, buffers, materials,
  extension preservation, and blob handles.
- XBRL-like facts for exact decimals, units, contexts, duplicate facts, and
  composite keys.
- FHIR Patient/Observation/Encounter/Provenance subset for resource refs,
  extensions, terminology bindings, privacy, and audit data.
- SPDX/CycloneDX plus OSV for package identity, dependency graphs, license
  expressions, vulnerability ranges, and lockfile drift.
- OpenTelemetry traces/logs/metrics for append-only events, trace/span joins,
  high-cardinality attributes, and derived current state.
- SCIM users/groups plus IAM/Kubernetes/Cedar-style policies for subject
  graphs, deny/allow precedence, condition capabilities, and policy migration.

Use fixed-version source documents for golden fixtures where possible. Keep
`latest` or `current` URLs only as drift canaries, not as deterministic test
inputs.

## Edge Cases Checklist

- Relation key references a missing field.
- Composite key has duplicate field names.
- Key field is optional or nullable.
- Custom key field has no stable key or scalar conversion.
- Ref target relation or field does not exist.
- Ref target points to non-key field unless a foreign-key constraint permits it.
- Field names collide after a rename.
- Relation names collide after a rename.
- Unknown fields are dropped by old clients.
- Unknown enum values are rewritten to fallback values and lose original data.
- JSON fields contain `undefined`, functions, symbols, `NaN`, or infinity.
- `Date`, `BigInt`, `Uint8Array`, `Map`, and `Set` are passed without codecs.
- Decimal money is represented as floating point and rounded.
- Array-to-scalar conversion loses non-first values.
- Split/merge fields are culturally or semantically invalid, such as personal
  names and addresses.
- Key migration leaves stale refs.
- Cascade delete crosses schema versions and deletes data a newer schema still
  references.
- Constraint strengthening rejects existing documents.
- Constraint weakening permits data old clients cannot handle.
- Index metadata is mistaken for a maintained physical index.
- Two lens paths produce different results.
- Lens graph has cycles with non-idempotent conversions.
- Stored `schemaId` is absent or lies.
- Schema manifests disagree only by field order but hash differently.
- EDN keywords and JSON strings round-trip differently.

## Settled Stances

- Use both semantic and content-derived identity, but do not overload one field.
  `schemaId` is the human/application node id. A future `contentHash` can be
  added after canonicalization is implemented.
- Canonical relation and field names may be any non-empty string. Authoring
  helpers may restrict to TypeScript-safe identifiers for better generated
  types, but the wire format should not.
- Unknown field and enum preservation is a core semantic requirement for
  collaborative runtimes. Adapters can choose how to store preservation data.
- Logical row-key values are a core convention for diagnostics, patches,
  sidecars, and self-hosted tooling; adapter physical key encoding remains out
  of scope.
- Patchpit-style service-worker runtimes should compose schema manifests with
  topology, capabilities, and app permissions instead of folding those runtime
  boundaries into `tarstate.schema`.
- Lens evaluation must eventually work for both reads and write patches. Row
  snapshot translation alone is insufficient for local-first collaboration.
- JSON Schema is generated output, not source of truth.
- Constraints are versioned with the schema node they belong to. They can later
  be factored into reusable named bundles if real examples demand it.
- Codecs should declare their scalar storage representation when they have one.
  That lets runtimes reason about lookup, key stability, sorting, and generated
  validators without executing arbitrary host code.
- Sidecar preservation is a core convention, but the physical sidecar storage is
  adapter-specific.
- EDN parsing should live outside the first core implementation. A later
  `@tarstate/core/relic` or dedicated package can parse EDN into the canonical
  JSON-compatible manifest.

## Holistic Synthesis

The broad corpus points toward a layered language, not a single all-purpose
schema object.

Layers:

1. Relation schema: names, keys, fields, refs, optionality, nullability, codecs.
2. Constraint schema: required fields, uniqueness, foreign keys, pure checks.
3. Derived relation schema: named query/rule manifests over base and derived
   relations.
4. Runtime topology: bindings from relation names to data spaces and write
   targets.
5. Extension/capability declarations: semantic features and host-provided
   behavior.
6. Evolution graph: schema nodes and bidirectional lenses between them.
7. Materialization/index hints: performance declarations that do not change
   meaning.

Each layer should be useful independently. A small app may only need relation
schema. A local-first collaborative editor may need relation schema, topology,
custom codecs, presence relations, and evolution. A knowledge-graph integration
may need open-world ids and semantic extensions. A workflow engine may mostly
need event streams, derived relations, and capability declarations.

Design tradeoffs:

- Keep v1 small enough to finish, but choose names that survive the larger
  model.
- Treat schemas as data, but avoid a Turing-complete schema language.
- Let tools generate JSON Schema, TypeScript types, forms, docs, and tests from
  the manifest without making those outputs canonical.
- Prefer explicit capabilities over magic host functions.
- Prefer structured targets and stable ids over parse-heavy strings.
- Preserve unknown data where collaboration requires round-tripping.
- Fail early when unknown semantics would affect validation, hydration, query
  meaning, or evolution.
- Keep runtime topology outside relation schema so the same logical relations
  can be used with Automerge, memory, JSON snapshots, streams, blobs, or future
  systems we have not imagined.

The central question for every proposed field is: does it describe the meaning
of the relation, the logic over relations, the runtime that stores/observes it,
or an optimization? If the answer is not "meaning of the relation," it probably
does not belong in `RelationManifest`.

## Readiness Assessment

The design is close enough for review once the team agrees on the v1 boundary.
The broad shape has survived the scenario gauntlet:

- The canonical artifact is JSON-compatible data, not JSON Schema, EDN, or
  TypeScript declarations.
- EDN remains attractive as authoring syntax, but does not become the canonical
  interoperability contract.
- Base relations stay independent of storage, collaboration runtime, and
  physical indexing.
- Runtime topology models mixed spaces such as Automerge documents, presence,
  connection state, Immer memory, JSON snapshots, streams, and blobs.
- Custom behavior is named by capabilities and hydrated by registries instead
  of serialized as functions.
- Evolution is a graph of immutable schema nodes connected by lenses, not a
  linear migration log.
- Unknown preservation and sidecars are acknowledged as semantic requirements
  for collaborative and multi-version clients, even if v1 defers them.

What still needs review is mostly naming and boundary-setting, not a new core
model. The names `SchemaManifest`, `RelationManifest`, `FieldManifest`,
`schemaId`, `formatVersion`, `defaultSchemaId`, `dataSpaces`,
`relationBindings`, `extensions`, `requires`, and `capabilities` are
self-describing enough to start with. The only names that still deserve extra
scrutiny are `opaque`, because it may be too runtime-specific for portable data,
and `custom`, because it can become a catch-all unless tied to explicit codec
capabilities.

The main risks are:

- Overfitting v1 to the current TypeScript builder and making later lenses,
  topology, or extension negotiation feel bolted on.
- Overcorrecting toward a universal ontology and making the first manifest too
  abstract to implement.
- Treating runtime data such as presence, connection status, blob handles, or
  stream offsets as second-class because they are not ordinary domain rows.
- Treating category-theory or type-theory inspiration as user-facing vocabulary
  rather than design discipline.
- Implementing schema evolution as one-way migrations, which would miss the
  local-first/Cambria requirement for peers on different schema versions.

The practical stopping rule: if a new idea can be expressed as a relation,
constraint, derived relation, topology binding, extension/capability, lens, or
materialization hint, the model is broad enough. If it needs executable host
code, that should become a named capability. If it needs to change validation or
query meaning and the runtime does not understand it, validation should fail
early instead of silently preserving it as inert metadata.

## Review Questions Resolved By The V1 Spec

- Are `SchemaManifest`, `RelationManifest`, `FieldManifest`, `schemaId`,
  `formatVersion`, `defaultSchemaId`, and `lensId` self-documenting enough?
  Yes for v1. The spec uses `SchemaManifestV1`, `RelationManifestV1`,
  `FieldManifestV1`, `schemaId`, and `formatVersion`. Evolution names remain
  reserved rather than implemented.
- Should `schemaId` require a URI-like shape, package-style name, or remain any
  non-empty string?
  V1 keeps `schemaId` as any non-empty string.
- Should canonical JSON use RFC 8785 exactly, or Tarstate's own stable sorted
  object serializer?
  V1 uses a Tarstate sorted-key JSON profile.
- Should v1 include `custom` fields without requiring codecs, or should missing
  codecs always be fatal during hydration?
  V1 requires declared codecs and runtime codec implementations.
- Is `opaque` useful in a portable schema, or should it remain only a runtime
  builder concept?
  V1 has no `opaque` wire type. `opaqueField(...)` serializes as `custom` with
  a codec name.

## V1 Contract

V1 should be intentionally small and finished, not a partial version of the
entire research note.

V1 includes:

- `SchemaManifest` with `kind`, `formatVersion`, `schemaId`, `relations`, and
  optional `description`/`metadata`/`codecs`.
- `RelationManifest` with `key`, `fields`, optional `ephemeral`, and optional
  `description`/`metadata`.
- `FieldManifest` for existing Tarstate field kinds: `string`, `number`,
  `boolean`, `id`, `ref`, `anchoredPath`, `json`, and `custom`.
  `opaqueField(...)` exports as `custom` with a codec name.
- Structured canonical ref targets.
- `toSchemaManifest`.
- `canonicalSchemaManifest`.
- `validateSchemaManifest`.
- `hydrateSchemaManifest`.
- Codec registry hooks for custom fields.
- Stable canonical stringification or a documented canonical serializer.

V1 explicitly excludes:

- EDN parsing/printing.
- JSON Schema generation.
- Serializable constraints.
- Serializable indexes.
- Derived relation manifests.
- Rich nested field validation beyond `json`.
- Schema evolution and lenses.
- Sidecar preservation storage.
- Runtime adapter storage mappings.

That exclusion is not a design rejection. It protects the first API from
pretending to solve Cambria-scale evolution before the base manifest is stable.

## Suggested First Milestone

Implement the narrowest useful slice:

1. Define `SchemaManifestV1` for current built-in relation fields.
2. Add `toSchemaManifest(schema)` and
   `hydrateSchemaManifest(manifest, options)`.
3. Add a custom codec registry for `custom` fields, including values authored
   with `opaqueField(...)`.
4. Add canonicalization and manifest diagnostics.
5. Add tests for missing keys, refs, optional/nullability, JSON compatibility,
   custom codec hydration, and stable canonical stringification.
6. Defer constraints, indexes, EDN, and lenses until the base manifest is stable.

Then add evolution:

1. Immutable `schemaId` values.
2. A lens graph data model.
3. `renameField`, `addField`, `removeField`, and `convertField`.
4. Read translation between schema versions.
5. Write patch translation back to storage schema.
6. Unknown field and enum preservation rules.

## Spec Alignment Check

`docs/schema-spec.md` is aligned with this research note on the core v1
boundary:

- canonical JSON-compatible manifest, not EDN or JSON Schema as the source of
  truth
- `kind`, `formatVersion`, `schemaId`, and `relations` as top-level anchors
- storage-independent base relations
- `metadata` as inert preserved data
- custom behavior through named codecs and runtime registries
- explicit validation before hydration
- deterministic canonical stringification
- no embedded executable functions
- no constraints, indexes, derived relations, topology, EDN, JSON Schema
  generation, or lenses in v1
- self-hosting projection into ordinary Tarstate relations

The spec deliberately tightens a few research ideas for v1:

- `opaque` is not a wire field type. It serializes as `custom` with a codec.
- V1 refs target string-valued single-field relation keys only. Composite refs,
  refs to non-key unique fields, and refs to custom/numeric/boolean keys are
  reserved for a later layer.
- Single-field keys use string form in canonical v1 manifests; key arrays are
  only for composite keys with at least two fields.
- Canonical byte stability is defined by the canonical string, using emit-time
  key sorting and UTF-16 code-unit order.
- Codec declarations expose primitive scalar representations only.
- Custom key fields require runtime `stableKey` or `toScalar`; `compare` is not
  a v1 keying capability.
- Strict row validation rejects undeclared extra fields; adapters may preserve
  them outside the declared relation view.
- Schema diagnostics have a fixed minimum shape and fixture matrix.
- Manifests are treated as untrusted data, with robustness requirements for
  prototype-safe inspection, no user-defined conversion hooks, and no mutation
  during canonicalization.

The research items intentionally deferred by the spec are still represented as
reserved layers or explicit non-goals:

- Cambria-style evolution graph and lenses
- unknown field/enum preservation and sidecars
- serializable constraints and indexes
- derived relations and materialization hints
- runtime/data-space topology
- extension negotiation beyond codec declarations
- richer field types such as enum, decimal, bytes, arrays, objects, records,
  tuples, unions, date, and instant

## Source Notes

- *Out of the Tar Pit* motivates the functional relational split used here:
  essential state should be modeled relationally, essential logic should remain
  declarative/functional, and accidental storage/control concerns should be
  minimized or kept separate. The schema manifest should reinforce that split.
- Ink & Switch Cambria frames schema evolution as compatibility between many
  schema versions through bidirectional lenses and a graph of schemas. Tarstate
  should borrow the graph/lens model while adapting it to normalized relations.
- Cambria also highlights difficult cases such as enum expansion, scalar-array
  conversion, missing required data, and decentralized clients editing different
  versions concurrently. Those should be treated as first-class Tarstate design
  constraints rather than afterthoughts.

## Source Index

Core and relational:

- Out of the Tar Pit: https://curtclifton.net/papers/MoseleyMarks06a.pdf
- Codd relational model DOI: https://doi.org/10.1145/362384.362685
- Datalog text/spec family: https://datalog-specs.info/
- Souffle docs: https://souffle-lang.github.io/
- Datomic schema/query docs: https://docs.datomic.com/
- DataScript: https://github.com/tonsky/datascript
- Relic: https://github.com/wotbrew/relic

Evolution and compatibility:

- Cambria: https://www.inkandswitch.com/cambria/
- Local-first software: https://martin.kleppmann.com/papers/local-first.pdf
- Live and local schema change: https://arxiv.org/abs/2309.11406
- Lenses TOPLAS paper: https://www.cis.upenn.edu/~bcpierce/papers/lenses-toplas-final.pdf
- Incremental relational lenses: https://arxiv.org/abs/1807.01948
- Co-existing schema versions: https://arxiv.org/abs/1608.05564
- Avro specification: https://avro.apache.org/docs/1.12.0/specification/
- Protocol Buffers proto3 guide: https://protobuf.dev/programming-guides/proto3/
- Confluent schema evolution: https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html

Types, schema languages, and extensions:

- Haskell report: https://www.haskell.org/onlinereport/haskell2010/
- Standard ML definition: https://smlfamily.github.io/sml97-defn.pdf
- OCaml polymorphic variants: https://ocaml.org/manual/5.3/polyvariant.html
- Row-polymorphic records: https://arxiv.org/abs/1707.07872
- ML-style extensible records: https://arxiv.org/abs/2108.06296
- JSON Schema core: https://json-schema.org/draft/2020-12/json-schema-core
- OpenAPI specification: https://spec.openapis.org/oas/latest.html
- JSON-LD: https://www.w3.org/TR/json-ld11/
- RDF concepts: https://www.w3.org/TR/rdf11-concepts/
- LSP specification: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/

Local-first, CRDT, and collaboration:

- Automerge docs: https://automerge.org/docs/
- Yjs docs: https://docs.yjs.dev/
- Peritext: https://www.inkandswitch.com/peritext/
- Loro docs: https://loro.dev/docs
- Fluid Framework data structures: https://fluidframework.com/docs/data-structures/overview
- Electric shapes: https://electric.ax/docs/sync/guides/shapes
- Replicache: https://replicache.dev/
- Jazz docs: https://jazz.tools/docs

Dataflow, provenance, and observability:

- DBSP: https://arxiv.org/abs/2203.16684
- Differential Dataflow: https://github.com/TimelyDataflow/differential-dataflow
- HyperFormula dependency graph: https://hyperformula.handsontable.com/docs/guide/dependency-graph.html
- W3C PROV overview: https://www.w3.org/TR/prov-overview/
- OpenTelemetry: https://opentelemetry.io/docs/specs/otel/
- OpenTelemetry GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/

Semantic graph and domain fixtures:

- SHACL: https://www.w3.org/TR/shacl/
- Schema.org data model: https://schema.org/docs/datamodel.html
- GraphQL specification: https://spec.graphql.org/
- TinkerPop: https://tinkerpop.apache.org/docs/current/reference/
- GeoJSON RFC 7946: https://www.rfc-editor.org/rfc/rfc7946
- STAC: https://github.com/radiantearth/stac-spec
- glTF schemas: https://github.com/KhronosGroup/glTF/tree/main/specification/2.0/schema
- HL7 FHIR R5: https://hl7.org/fhir/R5/
- SPDX: https://spdx.dev/specifications/
- CycloneDX: https://cyclonedx.org/specification/overview/
- OSV schema: https://ossf.github.io/osv-schema/
- SCIM RFC 7643: https://www.rfc-editor.org/rfc/rfc7643
- Cedar spec: https://github.com/cedar-policy/cedar-spec
