# Tarstate Schema Evolution Specification

Status: speculative design draft.

This document sketches a serializable evolution layer for Tarstate schemas. It
is not part of the v1 `tarstate.schema` manifest. The base schema spec reserves
the names used here so this layer can be added without changing the meaning of
v1 relation manifests.

The central model is a graph of immutable schema nodes connected by
bidirectional lenses. This is closer to Cambria than to one-way database
migrations. A runtime should be able to hold data in one schema, expose a view
in another schema, and translate writes back when a declared lens path can do so
without violating the compatibility policy.

## 1. Scope

This draft defines a candidate shape for:

- schema evolution graph manifests
- schema nodes and schema-node references
- lens edges between schema nodes
- lens operation envelopes
- unknown-data preservation policies
- sidecar records for information a view cannot represent
- schema negotiation between storage and view schemas
- abstract relation patch translation
- self-hosting projection into Tarstate relations

This draft does not define:

- implementation code for lens execution
- arbitrary host functions embedded in manifests
- physical storage layout for sidecars
- conflict resolution for a particular sync engine
- a complete constraint or index evolution system
- all possible field types beyond the base schema manifest
- a stable public API

## 2. Design Principles

### Immutable Schema Nodes

Each `schemaId` names one schema node. Any change that alters relation, field,
key, ref, or value meaning MUST mint a new `schemaId`. Schema evolution never
edits an existing node in place.

### Explicit Compatibility

Compatibility is not inferred from version numbers. A client can read or write
through an evolution graph only when the runtime can find a valid lens path
from the storage schema to the requested view schema.

### Bidirectional By Default

Lens edges describe both forward and backward behavior. A lens that can only
read forward is still useful for import, projection, or analytics, but it MUST
advertise that writes cannot be translated.

### Preserve Unknown Information

An older view MUST NOT silently erase newer fields, enum values, relation rows,
or sidecar data unless the evolution graph explicitly allows discard. Local-first
and collaborative systems should default to preservation.

### Patch Translation First

Evolution SHOULD translate relation patches directly when possible. Snapshot
translation is allowed as a fallback, but it loses intent, may produce larger
conflicts, and can be too expensive for large relation sets.

### Relations Stay First-Class

Evolution is relational work. Field changes, relation splits, key changes, and
ref rewrites should be represented as data that Tarstate can inspect, query, and
validate.

## 3. Document Model

An evolution manifest is a JSON-compatible object:

```ts
export type SchemaEvolutionManifestV1 = {
  readonly kind: 'tarstate.schemaEvolution';
  readonly formatVersion: 1;
  readonly evolutionId: string;
  readonly defaultSchemaId?: string;
  readonly schemaNodes: Record<string, SchemaNodeManifestV1>;
  readonly lenses: readonly LensManifestV1[];
  readonly defaultPolicy?: EvolutionPolicyV1;
  readonly sidecar?: SidecarPolicyV1;
  readonly metadata?: Record<string, JsonValue>;
};
```

`kind` MUST be exactly `"tarstate.schemaEvolution"`.

`formatVersion` MUST be exactly the integer `1`.

`evolutionId` is a stable identifier for this evolution graph or package. It is
not a content hash.

`defaultSchemaId` identifies the schema node tools should prefer when no caller
requests a view schema. It MUST reference a key in `schemaNodes` when present.
The name is intentionally not `currentSchemaId`; different deployments can
prefer different nodes while sharing the same graph.

`schemaNodes` maps schema ids to schema-node declarations. It MUST contain at
least one node.

`lenses` contains directed lens edges. Each edge declares a forward traversal
from `fromSchemaId` to `toSchemaId`, plus compatibility summaries for forward
and backward reads and writes.

`defaultPolicy` declares graph-level compatibility defaults. Lens and operation
policies can override it.

`sidecar` declares how information that cannot fit in a view schema is retained.

`metadata` is inert JSON-compatible data.

Unknown top-level properties are invalid except inside `metadata`.

## 4. Schema Nodes

```ts
export type SchemaNodeManifestV1 = {
  readonly manifest?: SchemaManifestV1;
  readonly manifestRef?: string;
  readonly contentHash?: ContentHashV1;
  readonly description?: string;
  readonly metadata?: Record<string, JsonValue>;
};

export type ContentHashV1 = {
  readonly algorithm: 'sha256';
  readonly value: string;
};
```

A schema node MAY inline a complete `tarstate.schema` manifest with `manifest`,
or reference one with `manifestRef`.

If `manifest` is present, `manifest.schemaId` MUST equal the key used in
`schemaNodes`.

If `manifestRef` is present, it is an application-resolved reference. It can be
a relative path, package URL, registry key, or any other string understood by
the caller. Core validation MUST treat it as data.

`contentHash` MAY identify the canonical schema manifest bytes. If present, it
MUST be a hash of the base schema manifest's canonical string encoded as UTF-8.
For `sha256`, `value` SHOULD be lowercase hexadecimal.

At least one of `manifest` or `manifestRef` SHOULD be present. A graph MAY carry
a stub node temporarily during authoring, but a runtime cannot execute a lens
path through an unresolved node unless it already has that schema manifest from
another source.

## 5. Lens Edges

```ts
export type LensManifestV1 = {
  readonly lensId: string;
  readonly fromSchemaId: string;
  readonly toSchemaId: string;
  readonly description?: string;
  readonly forwardReadCompatibility?: CompatibilityLevelV1;
  readonly forwardWriteCompatibility?: CompatibilityLevelV1;
  readonly backwardReadCompatibility?: CompatibilityLevelV1;
  readonly backwardWriteCompatibility?: CompatibilityLevelV1;
  readonly operations: readonly LensOperationManifestV1[];
  readonly policy?: EvolutionPolicyV1;
  readonly metadata?: Record<string, JsonValue>;
};

export type CompatibilityLevelV1 =
  | 'lossless'
  | 'losslessWithSidecar'
  | 'declaredLoss'
  | 'partial'
  | 'unsupported';
```

`lossless` means the traversal preserves all information represented by both
schemas without sidecar storage.

`losslessWithSidecar` means the traversal can preserve all information only if
unknown data or unrepresentable values are retained outside the current view.

`declaredLoss` means the manifest explicitly allows a known loss of
information, such as many enum values mapping to one fallback value.

`partial` means only some rows, values, or patches can be translated.
Unsupported cases must produce diagnostics instead of silent discard.

`unsupported` means the traversal cannot provide that read or write capability.

`lensId` MUST be unique within an evolution manifest.

`fromSchemaId` and `toSchemaId` MUST reference nodes in `schemaNodes`.

The forward traversal direction is from `fromSchemaId` storage to `toSchemaId`
view. The backward traversal direction is from `toSchemaId` storage to
`fromSchemaId` view.

`forwardReadCompatibility` summarizes whether rows can be projected from
`fromSchemaId` to `toSchemaId`.

`forwardWriteCompatibility` summarizes whether patches authored against
`toSchemaId` can be translated back to `fromSchemaId`.

`backwardReadCompatibility` summarizes whether rows can be projected from
`toSchemaId` to `fromSchemaId`.

`backwardWriteCompatibility` summarizes whether patches authored against
`fromSchemaId` can be translated back to `toSchemaId`.

Compatibility summaries default to the most restrictive compatibility level
implied by the operations. Write compatibility defaults to `unsupported` if any
operation cannot translate writes in that traversal direction.

`operations` is ordered. Order matters for operations such as rename-then-convert
or split-relation-then-rename-field.

When a lens is traversed forward, operations are applied in declared order. When
a lens is traversed backward, inverse operation behavior is applied in reverse
order.

Unknown lens properties are invalid except inside `metadata`.

## 6. Evolution Policies

```ts
export type EvolutionPolicyV1 = {
  readonly unknownFields?: UnknownDataPolicyV1;
  readonly unknownEnumValues?: UnknownDataPolicyV1;
  readonly unknownRelations?: UnknownDataPolicyV1;
  readonly missingRequiredFields?: MissingRequiredFieldPolicyV1;
  readonly unsupportedWrites?: UnsupportedWritePolicyV1;
  readonly metadata?: Record<string, JsonValue>;
};

export type UnknownDataPolicyV1 =
  | 'reject'
  | 'discard'
  | 'preserve'
  | 'capture';

export type MissingRequiredFieldPolicyV1 =
  | 'reject'
  | 'useDefault'
  | 'derive'
  | 'capture';

export type UnsupportedWritePolicyV1 =
  | 'reject'
  | 'treatViewAsReadOnly'
  | 'capture';
```

`reject` fails negotiation or patch translation.

`discard` explicitly drops data. It MUST NOT be the default for collaborative or
local-first runtimes.

`preserve` keeps data outside the current view and writes it back unchanged.

`capture` stores data in a declared sidecar record.

`useDefault` fills a missing required value from an operation-provided default.

`derive` fills a missing required value using an operation-provided rule,
lookup, or capability.

`treatViewAsReadOnly` allows read negotiation but rejects writes before patch
translation.

Default policy for collaborative use:

```json
{
  "unknownFields": "preserve",
  "unknownEnumValues": "preserve",
  "unknownRelations": "preserve",
  "missingRequiredFields": "reject",
  "unsupportedWrites": "reject"
}
```

Server boundaries, import pipelines, and tests may choose stricter defaults.

## 7. Sidecars

Some transformations are bidirectional only if information is stored outside the
view schema. For example, an old scalar view of a new array can read the first
element, but writing the scalar back should not delete the rest of the array
unless the graph explicitly declares that loss.

```ts
export type SidecarPolicyV1 = {
  readonly mode: 'none' | 'logical' | 'relation';
  readonly relation?: string;
  readonly metadata?: Record<string, JsonValue>;
};
```

`none` means no sidecar storage is available. Operations requiring sidecars are
invalid for write-compatible paths.

`logical` means the runtime supplies an out-of-band sidecar store.

`relation` means sidecars are represented as ordinary Tarstate rows in the
named relation.

Candidate relation shape:

```json
{
  "relations": {
    "schemaEvolutionSidecars": {
      "key": ["sidecarScope", "schemaId", "relation", "rowKeyText", "pathText"],
      "fields": {
        "sidecarScope": { "type": "string" },
        "schemaId": { "type": "string" },
        "relation": { "type": "string" },
        "rowKeyText": { "type": "string" },
        "rowKey": { "type": "json" },
        "pathText": { "type": "string" },
        "path": { "type": "json" },
        "value": { "type": "json" }
      }
    }
  }
}
```

`sidecarScope` distinguishes evolution packages, storage replicas, or embedding
applications.

`rowKey` is the logical row-key value defined by the core schema spec for the
schema named by `schemaId`. It is JSON because relation keys may be scalar or
composite.

`rowKeyText` is the portable row-key text defined by the core schema spec and
exists because v1 `json` fields are not keyable.

`path` is a JSON array of strings or numbers identifying a field or nested JSON
location. For base schema fields, paths SHOULD start with the field name.

`pathText` is the canonical string form of `path` and exists because v1 `json`
fields are not keyable.

Sidecars are not a dumping ground for executable behavior. Values MUST be
JSON-compatible unless a later sidecar schema layer declares custom codecs.

## 8. Lens Operation Envelope

Every operation uses a common envelope:

```ts
export type LensOperationBaseV1 = {
  readonly operation: string;
  readonly description?: string;
  readonly forwardReadCompatibility?: CompatibilityLevelV1;
  readonly forwardWriteCompatibility?: CompatibilityLevelV1;
  readonly backwardReadCompatibility?: CompatibilityLevelV1;
  readonly backwardWriteCompatibility?: CompatibilityLevelV1;
  readonly requiresSidecar?: boolean;
  readonly metadata?: Record<string, JsonValue>;
};
```

This draft uses `operation` instead of `op` because it is self-documenting in
schemas, diagnostics, and generated docs.

Operation-specific fields MUST be JSON-compatible data. They MUST NOT contain
embedded source code or host functions. When behavior is required, the manifest
uses named rules, tables, defaults, or capability references.

## 9. Core Operation Candidates

The first implementable set should favor boring operations that cover common
evolution without becoming a general programming language.

### 9.1 `renameRelation`

```ts
type RenameRelationOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'renameRelation';
  readonly fromRelation: string;
  readonly toRelation: string;
};
```

Forward reads rows from `fromRelation` as `toRelation`. Backward writes to
`toRelation` are translated to `fromRelation`.

This is lossless when relation keys and fields are otherwise unchanged.

### 9.2 `renameField`

```ts
type RenameFieldOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'renameField';
  readonly relation: string;
  readonly fromField: string;
  readonly toField: string;
};
```

Forward renames a field. Backward renames it back.

If the field participates in a key or ref, the lens path MUST also preserve the
corresponding key or ref meaning. A validator can derive this from the two
schema manifests when both nodes are resolved.

### 9.3 `addField`

```ts
type AddFieldOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'addField';
  readonly relation: string;
  readonly field: string;
  readonly fieldManifest: FieldManifestV1;
  readonly value?: FieldValueRuleV1;
};
```

Forward adds a field to the target view.

For optional or nullable fields, `value` MAY be omitted. For required
non-nullable fields, `value` MUST provide a default, derivation, lookup, or
explicit rejection behavior.

Backward writes from the target view to the source schema:

- omit the field from the translated source patch when it is representable only
  in the target schema and policy allows preservation elsewhere
- capture the field in a sidecar when `requiresSidecar` is true
- reject the write when neither preservation nor capture is available

### 9.4 `removeField`

```ts
type RemoveFieldOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'removeField';
  readonly relation: string;
  readonly field: string;
  readonly preserveRemovedValue?: boolean;
};
```

Forward removes a field from the target view.

Backward writes can be lossless only when the removed value is preserved or can
be derived. If `preserveRemovedValue` is true, the path requires unknown-field
preservation or sidecar storage.

### 9.5 `convertField`

```ts
type ConvertFieldOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'convertField';
  readonly relation: string;
  readonly field: string;
  readonly fromFieldManifest: FieldManifestV1;
  readonly toFieldManifest: FieldManifestV1;
  readonly forward: FieldValueRuleV1;
  readonly backward: FieldValueRuleV1;
};
```

`convertField` changes a field's value representation without changing the
field name. Renames should be expressed as `renameField` plus `convertField`
unless a later convenience operation combines them.

The operation is lossless only when `forward` and `backward` are inverses for
all valid values, or when sidecars preserve the extra information.

### 9.6 `copyField`

```ts
type CopyFieldOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'copyField';
  readonly relation: string;
  readonly fromField: string;
  readonly toField: string;
  readonly overwrite?: boolean;
  readonly authoritativeField?: 'fromField' | 'toField';
  readonly divergentWrite?: 'reject' | 'preferFromField' | 'preferToField' | 'capture';
};
```

Forward copies one field to another. Backward writes are ambiguous if both
fields can change independently. A write-compatible `copyField` SHOULD declare
which field is authoritative, or reject divergent writes.

### 9.7 `splitField`

```ts
type SplitFieldOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'splitField';
  readonly relation: string;
  readonly fromField: string;
  readonly toFields: readonly string[];
  readonly forward: FieldValueRuleV1;
  readonly backward: FieldValueRuleV1;
};
```

Splitting fields is often lossy. Examples include full names, addresses, and
free-form labels. The operation MUST declare lossiness unless the rules are
provably reversible or sidecars retain the original value.

### 9.8 `mergeFields`

```ts
type MergeFieldsOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'mergeFields';
  readonly relation: string;
  readonly fromFields: readonly string[];
  readonly toField: string;
  readonly forward: FieldValueRuleV1;
  readonly backward: FieldValueRuleV1;
};
```

Merging fields is the inverse shape of `splitField`. Backward behavior MUST
state how the merged value is split, whether sidecars are required, and what
happens when the value cannot be split.

### 9.9 `mapValue`

```ts
type MapValueOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'mapValue';
  readonly relation: string;
  readonly field: string;
  readonly forwardMap: readonly ValueMapEntryV1[];
  readonly backwardMap: readonly ValueMapEntryV1[];
  readonly unknownForward?: UnknownMappedValueRuleV1;
  readonly unknownBackward?: UnknownMappedValueRuleV1;
};
```

`mapValue` covers enum-like string values even though the base schema does not
yet define an enum field type. Maps use entry arrays rather than object keys so
`1`, `"1"`, and `true` remain distinct. If a value is not present in the map,
the corresponding unknown rule applies.

### 9.10 `changeKey`

```ts
type ChangeKeyOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'changeKey';
  readonly relation: string;
  readonly fromKey: string | readonly string[];
  readonly toKey: string | readonly string[];
  readonly keyMap?: KeyMapRuleV1;
  readonly rewriteRefs?: readonly RefRewriteV1[];
};
```

Key changes are high risk. A write-compatible path MUST define how old keys map
to new keys and how every affected ref is rewritten. If a key map is not
bijective, the operation is lossy or partial.

### 9.11 `changeRef`

```ts
type ChangeRefOperationV1 = LensOperationBaseV1 & {
  readonly operation: 'changeRef';
  readonly relation: string;
  readonly field: string;
  readonly fromTarget: RefTargetV1;
  readonly toTarget: RefTargetV1;
  readonly keyMap?: KeyMapRuleV1;
};
```

`changeRef` retargets a reference. If the target relation's keys changed, the
lens needs the same key-map behavior as `changeKey`.

Supporting shapes:

```ts
export type KeyMapRuleV1 =
  | { readonly rule: 'identity' }
  | { readonly rule: 'lookup'; readonly lookupId: string }
  | { readonly rule: 'table'; readonly entries: readonly KeyMapEntryV1[] }
  | { readonly rule: 'capability'; readonly capability: string };

export type KeyMapEntryV1 = {
  readonly from: JsonValue;
  readonly to: JsonValue;
};

export type RefTargetV1 = {
  readonly relation: string;
  readonly field: string;
};

export type RefRewriteV1 = {
  readonly relation: string;
  readonly field: string;
  readonly fromTarget: RefTargetV1;
  readonly toTarget: RefTargetV1;
};
```

`RefTargetV1.field` is a string in this draft because the base v1 schema
manifest only supports refs to single-field keys. Composite ref rewrites are a
future ref-layer concern.

### 9.12 Relation Restructuring

These operations are important, but probably not first-wave implementation
targets:

- `moveField`
- `splitRelation`
- `mergeRelation`
- `normalizeRelation`
- `denormalizeRelation`
- `wrapScalar`
- `unwrapScalar`

They should remain reserved operation names. A runtime that does not implement
one MUST reject paths that require it for reads or writes.

## 10. Value Rules

Value rules describe deterministic transformations without embedding code.

```ts
export type FieldValueRuleV1 =
  | { readonly rule: 'identity' }
  | { readonly rule: 'constant'; readonly value: JsonValue }
  | { readonly rule: 'default'; readonly value: JsonValue }
  | { readonly rule: 'lookup'; readonly lookupId: string }
  | { readonly rule: 'table'; readonly entries: readonly ValueMapEntryV1[] }
  | { readonly rule: 'template'; readonly template: string }
  | { readonly rule: 'capability'; readonly capability: string }
  | { readonly rule: 'reject'; readonly reason?: string };

export type ValueMapEntryV1 = {
  readonly from: JsonValue;
  readonly to: JsonValue;
};
```

`identity` preserves the value unchanged.

`constant` always produces the same value.

`default` fills missing values but SHOULD NOT overwrite existing representable
values.

`lookup` names a data lookup supplied by the runtime. The manifest declares the
lookup id, not the implementation.

`table` maps JSON-compatible values using explicit entries. Missing values need
an unknown-value rule. Duplicate `from` values after canonicalization are
invalid.

`template` is a restricted string template over named fields. This is convenient
for low-risk merges such as `"{city}, {region}"`, but it is not a general
expression language.

`capability` names a runtime function. It is the escape hatch for cases that
cannot be represented declaratively. Capability use makes portability explicit
and should appear in diagnostics.

`reject` marks an intentionally unsupported direction.

```ts
export type UnknownMappedValueRuleV1 =
  | { readonly rule: 'reject' }
  | { readonly rule: 'preserve' }
  | { readonly rule: 'capture' }
  | { readonly rule: 'fallback'; readonly value: JsonValue };
```

`fallback` is lossy unless the original value is preserved or captured.

## 11. Abstract Patch Model

This draft assumes evolution can operate on an abstract relation patch format.
The exact runtime patch API can differ, but it should be representable in this
shape:

```ts
export type RelationPatchV1 =
  | InsertRowPatchV1
  | UpdateRowPatchV1
  | DeleteRowPatchV1;

export type InsertRowPatchV1 = {
  readonly action: 'insertRow';
  readonly relation: string;
  readonly row: Record<string, JsonValue>;
};

export type UpdateRowPatchV1 = {
  readonly action: 'updateRow';
  readonly relation: string;
  readonly key: JsonValue;
  readonly set?: Record<string, JsonValue>;
  readonly unset?: readonly string[];
};

export type DeleteRowPatchV1 = {
  readonly action: 'deleteRow';
  readonly relation: string;
  readonly key: JsonValue;
};
```

Patch translation SHOULD preserve intent:

- a field rename translates an `updateRow.set.oldName` into `set.newName`
- a relation rename translates the patch relation name
- a key change translates patch keys and any affected ref values
- a split field may translate one field update into multiple field updates
- a merge field may require reading the current row to translate safely

When a patch cannot be translated without a row snapshot, the runtime MAY use
snapshot translation and SHOULD report that downgrade in diagnostics.

## 12. Schema Negotiation

Negotiation inputs:

```ts
export type SchemaNegotiationRequestV1 = {
  readonly storageSchemaId: string;
  readonly viewSchemaId: string;
  readonly requireRead?: boolean;
  readonly requireWrite?: boolean;
  readonly allowDeclaredLoss?: boolean;
  readonly allowSidecars?: boolean;
  readonly metadata?: Record<string, JsonValue>;
};
```

Negotiation output:

```ts
export type SchemaNegotiationResultV1 = {
  readonly storageSchemaId: string;
  readonly viewSchemaId: string;
  readonly path: readonly LensPathStepV1[];
  readonly readCompatibility: CompatibilityLevelV1;
  readonly writeCompatibility: CompatibilityLevelV1;
  readonly requiresSidecar: boolean;
  readonly diagnostics: readonly SchemaEvolutionDiagnosticV1[];
};

export type LensPathStepV1 = {
  readonly lensId: string;
  readonly direction: 'forward' | 'backward';
};
```

`path` contains lens ids and traversal directions in order. Identity paths are
allowed when the storage and view schema ids are equal.

Path search SHOULD prefer:

1. paths that satisfy required read/write capabilities
2. lossless paths over sidecar paths
3. sidecar paths over declared-loss paths
4. fewer lenses when compatibility is otherwise equal
5. deterministic tie breaking by canonical lens id order

Ambiguous paths are not necessarily invalid, but the runtime SHOULD report them
so authors can add a direct lens or mark one path as preferred.

## 13. Diagnostics

```ts
export type SchemaEvolutionDiagnosticV1 = {
  readonly code: SchemaEvolutionDiagnosticCodeV1;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly detail?: Record<string, JsonValue>;
};
```

Candidate diagnostic codes:

```ts
export type SchemaEvolutionDiagnosticCodeV1 =
  | 'schema_evolution.invalid_manifest'
  | 'schema_evolution.invalid_schema_node'
  | 'schema_evolution.missing_schema_node'
  | 'schema_evolution.schema_id_mismatch'
  | 'schema_evolution.duplicate_lens'
  | 'schema_evolution.invalid_lens'
  | 'schema_evolution.unknown_operation'
  | 'schema_evolution.invalid_operation'
  | 'schema_evolution.no_path'
  | 'schema_evolution.ambiguous_path'
  | 'schema_evolution.lossy_path'
  | 'schema_evolution.sidecar_required'
  | 'schema_evolution.unsupported_write'
  | 'schema_evolution.missing_capability'
  | 'schema_evolution.missing_lookup'
  | 'schema_evolution.missing_default'
  | 'schema_evolution.invalid_key_map'
  | 'schema_evolution.invalid_ref_rewrite'
  | 'schema_evolution.snapshot_translation_required';
```

Diagnostics MUST carry a path into the evolution manifest where possible. If a
diagnostic is adapted to a broader Tarstate diagnostic type, the manifest path
must remain available.

## 14. Validation Rules

Structural validation MUST reject:

- wrong `kind`
- wrong `formatVersion`
- empty `evolutionId`
- empty `schemaNodes`
- `defaultSchemaId` that is not present in `schemaNodes`
- inline node manifest whose `schemaId` does not equal the node key
- duplicate `lensId`
- lens endpoints missing from `schemaNodes`
- empty operation arrays
- unknown properties outside `metadata`
- operation objects with unknown or malformed required fields
- strings containing unpaired UTF-16 surrogate code units
- executable values and non-JSON-compatible values

Resolved validation SHOULD reject or warn on:

- operation relations or fields missing from the relevant schema node
- field manifests that do not match the target schema after an operation
- ref rewrites that miss affected refs
- key changes without a key map
- non-bijective key maps marked as lossless
- required added fields without a value rule
- sidecar-required operations when sidecar mode is `none`
- capability rules without a declared runtime capability
- lookup rules without a declared lookup
- duplicate `from` values in table maps after canonicalization

Validation can happen in two phases. Catalog validation checks the manifest as
data. Resolved validation also requires loading referenced schema manifests and
runtime capability declarations.

## 15. Canonicalization

Evolution manifests SHOULD use the same canonical JSON profile as
`tarstate.schema` manifests:

- JSON-compatible values only
- no unpaired UTF-16 surrogates
- finite numbers only
- `-0` normalized to `0`
- object keys emitted in UTF-16 code-unit order
- no insignificant whitespace
- string and number emission compatible with the base schema canonicalizer

A future `contentHash` for evolution manifests should hash the UTF-8 bytes of
the canonical evolution manifest string.

## 16. Self-Hosting Projection

An evolution graph can be projected into Tarstate relations:

```ts
const schemaEvolutionCatalog = defineSchema({
  schemaEvolutionManifests: relation({
    key: 'evolutionId',
    fields: {
      evolutionId: idField('schemaEvolution'),
      kind: stringField(),
      formatVersion: numberField(),
      defaultSchemaId: optional(stringField()),
      metadata: optional(jsonField())
    }
  }),
  schemaEvolutionNodes: relation({
    key: ['evolutionId', 'schemaId'],
    fields: {
      evolutionId: refField('schemaEvolutionManifests.evolutionId'),
      schemaId: stringField(),
      manifestRef: optional(stringField()),
      contentHash: optional(jsonField()),
      description: optional(stringField()),
      metadata: optional(jsonField())
    }
  }),
  schemaEvolutionLenses: relation({
    key: ['evolutionId', 'lensId'],
    fields: {
      evolutionId: refField('schemaEvolutionManifests.evolutionId'),
      lensId: stringField(),
      fromSchemaId: stringField(),
      toSchemaId: stringField(),
      forwardReadCompatibility: optional(stringField()),
      forwardWriteCompatibility: optional(stringField()),
      backwardReadCompatibility: optional(stringField()),
      backwardWriteCompatibility: optional(stringField()),
      description: optional(stringField()),
      policy: optional(jsonField()),
      metadata: optional(jsonField())
    }
  }),
  schemaEvolutionOperations: relation({
    key: ['evolutionId', 'lensId', 'position'],
    fields: {
      evolutionId: refField('schemaEvolutionManifests.evolutionId'),
      lensId: stringField(),
      position: numberField(),
      operation: stringField(),
      payload: jsonField(),
      forwardReadCompatibility: optional(stringField()),
      forwardWriteCompatibility: optional(stringField()),
      backwardReadCompatibility: optional(stringField()),
      backwardWriteCompatibility: optional(stringField()),
      requiresSidecar: optional(booleanField()),
      metadata: optional(jsonField())
    }
  })
});
```

Useful derived relations:

- `schemaEvolutionReachable(fromSchemaId, toSchemaId, path, readCompatibility,
  writeCompatibility)`
- `schemaEvolutionMissingNodes(evolutionId, lensId, schemaId)`
- `schemaEvolutionUnsupportedOperations(evolutionId, lensId, operation)`
- `schemaEvolutionLossyPaths(fromSchemaId, toSchemaId, path, reason)`
- `schemaEvolutionSidecarRequirements(evolutionId, lensId, operation, reason)`
- `schemaEvolutionRefRewriteCoverage(evolutionId, lensId, relation, field,
  covered)`

Self-hosting is important because compatibility questions are graph and relation
queries:

- which app versions can still write to this storage schema?
- which lenses require sidecars?
- which refs are affected by a key change?
- which operation blocks an old client?
- which schema nodes are isolated?

## 17. Examples

### 17.1 Rename and Add Optional Field

```json
{
  "kind": "tarstate.schemaEvolution",
  "formatVersion": 1,
  "evolutionId": "real-estate-evolution",
  "defaultSchemaId": "real-estate@2",
  "schemaNodes": {
    "real-estate@1": { "manifestRef": "./real-estate-v1.schema.json" },
    "real-estate@2": { "manifestRef": "./real-estate-v2.schema.json" }
  },
  "lenses": [
    {
      "lensId": "real-estate-v1-v2",
      "fromSchemaId": "real-estate@1",
      "toSchemaId": "real-estate@2",
      "forwardReadCompatibility": "lossless",
      "forwardWriteCompatibility": "partial",
      "backwardReadCompatibility": "losslessWithSidecar",
      "backwardWriteCompatibility": "losslessWithSidecar",
      "operations": [
        {
          "operation": "renameField",
          "relation": "listings",
          "fromField": "agent",
          "toField": "agentId"
        },
        {
          "operation": "addField",
          "relation": "listings",
          "field": "status",
          "fieldManifest": { "type": "string", "optional": true }
        }
      ]
    }
  ]
}
```

### 17.2 Preserve Newer Data for Older Views

```json
{
  "kind": "tarstate.schemaEvolution",
  "formatVersion": 1,
  "evolutionId": "tasks-evolution",
  "defaultPolicy": {
    "unknownFields": "preserve",
    "unknownEnumValues": "preserve",
    "unknownRelations": "preserve",
    "missingRequiredFields": "reject",
    "unsupportedWrites": "reject"
  },
  "sidecar": { "mode": "logical" },
  "schemaNodes": {
    "tasks@1": { "manifestRef": "./tasks-v1.schema.json" },
    "tasks@2": { "manifestRef": "./tasks-v2.schema.json" }
  },
  "lenses": [
    {
      "lensId": "tasks-v1-v2",
      "fromSchemaId": "tasks@1",
      "toSchemaId": "tasks@2",
      "forwardReadCompatibility": "losslessWithSidecar",
      "forwardWriteCompatibility": "losslessWithSidecar",
      "backwardReadCompatibility": "losslessWithSidecar",
      "backwardWriteCompatibility": "losslessWithSidecar",
      "operations": [
        {
          "operation": "removeField",
          "relation": "tasks",
          "field": "legacyRank",
          "preserveRemovedValue": true,
          "requiresSidecar": true
        }
      ]
    }
  ]
}
```

### 17.3 Runtime Presence Is Just Another Relation

Presence, cursor, connection-state, and planning relations should evolve through
the same graph as durable domain relations when they refer to domain objects.
They may be ephemeral, but their refs still have meaning.

```json
{
  "lensId": "board-v1-v2",
  "fromSchemaId": "board@1",
  "toSchemaId": "board@2",
  "operations": [
    {
      "operation": "changeKey",
      "relation": "pieces",
      "fromKey": "pieceId",
      "toKey": "pieceObjectId",
      "keyMap": { "rule": "lookup", "lookupId": "piece-object-id-map" },
      "rewriteRefs": [
        {
          "relation": "plannedMoves",
          "field": "targetPiece",
          "fromTarget": { "relation": "pieces", "field": "pieceId" },
          "toTarget": { "relation": "pieces", "field": "pieceObjectId" }
        },
        {
          "relation": "peerPresence",
          "field": "pointingAtPiece",
          "fromTarget": { "relation": "pieces", "field": "pieceId" },
          "toTarget": { "relation": "pieces", "field": "pieceObjectId" }
        }
      ]
    }
  ]
}
```

This example is intentionally generic. The same pattern applies whether the
storage engine is a document CRDT, an in-memory store, a database, a stream, or
a mixed runtime. Evolution cares about relation meaning and refs, not about
which engine owns the bytes.

## 18. Open Questions

- Should evolution manifests be separate documents, embedded under
  `evolution`, or both?
- Should `manifestRef` have a standard URI profile, or remain application data?
- Is `defaultSchemaId` the right name, or should this be `preferredSchemaId`?
- Should first-wave operation names include relation restructuring, or reserve
  those until the field-level operations are proven?
- How should path search expose multiple valid paths without making authoring
  noisy?
- Should sidecars be declared only at the graph level, or also per lens?
- What is the smallest patch model that preserves intent without binding
  Tarstate to one storage engine?
- Should capability-based value rules be allowed in portable manifests, or only
  in application-local manifests?
- How much validation requires resolved schema nodes versus catalog-only checks?
- Should ephemeral relations default to stricter discard policies, or should
  they preserve refs exactly like durable relations?

## 19. Current Confidence

High confidence:

- immutable `schemaId` nodes
- graph-based compatibility
- bidirectional lens edges
- explicit operation data
- unknown-data preservation
- sidecars for otherwise unrepresentable information
- patch translation as the preferred write path
- self-hosted relational projection

Medium confidence:

- top-level field names
- compatibility level vocabulary
- exact sidecar record shape
- core operation boundary
- value-rule vocabulary

Low confidence:

- relation restructuring operation shapes
- capability portability rules
- best default path-search tie breaks
- how much of this belongs in the first implementation
