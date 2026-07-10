# Spike wire contract

Status: normative for the initial executable spikes.

This file freezes the smallest portable wire subset needed to make spike
evidence interoperable. TypeScript builders, overloads, and compiled plans
remain provisional. New semantics require new discriminants; unknown semantic
properties are rejected. A forwarding parser may preserve an unknown node but
an executor never ignores or approximates it.

## Artifact normalization

The spike artifact kinds are `schema`, `query`, `transaction`,
`constraint-set`, `storage-mapping`, and `schema-lens`. Every `ArtifactRef`
anywhere in an envelope, including its body, is reduced to exactly
`{id,contentHash}` for hashing. `dependencies` is the deduplicated set of direct
refs in the semantic body and is sorted by ID then hash; missing or decorative
entries reject.

Before RFC 8785 canonicalization, semantically set-like arrays use these exact
orders: capability refs and implications by `(id,version,contractHash)`, schema
views and artifact refs by `(id,contentHash)`, enum strings by the binary Unicode
scalar ordering in the value specification, and constraint declarations by
`constraintId`. Duplicate set members, duplicate constraint IDs, duplicate
semantic object keys, and dependency IDs with different hashes reject.
Statement, lens-step, key, argument, operand, row, and ordering arrays retain
authored order. Third-party semantic nodes use only this explicit shape:

```ts
type ExtensionNode = {
  kind: 'extension'
  capability: CapabilityRef
  payload: JsonValue
}
```

## Query subset

```ts
type SpikeValue = JsonValue

type RelationUse = {
  schemaView: ArtifactRef
  relationId: RelationId
}

type Expr =
  | { kind: 'literal'; value: SpikeValue }
  | { kind: 'parameter'; name: string }
  | { kind: 'field'; alias: string; name: string }
  | {
      kind: 'compare'
      op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
      left: Expr
      right: Expr
    }
  | { kind: 'boolean'; op: 'and' | 'or'; args: readonly Expr[] }
  | { kind: 'boolean'; op: 'not'; arg: Expr }
  | { kind: 'call'; capability: CapabilityRef; args: readonly Expr[] }
  | ExtensionNode

type AggregateExpr = {
  kind: 'aggregate.count'
  value?: Expr
  distinct?: boolean
}

type QueryNode =
  | { kind: 'from'; relation: RelationUse; alias: string }
  | { kind: 'where'; input: QueryNode; predicate: Expr }
  | {
      kind: 'select'
      input: QueryNode
      alias: string
      fields: Readonly<Record<string, Expr>>
    }
  | {
      kind: 'join'
      join: 'inner' | 'anti'
      left: QueryNode
      right: QueryNode
      on: Expr
    }
  | {
      kind: 'aggregate'
      input: QueryNode
      alias: string
      groupBy: Readonly<Record<string, Expr>>
      measures: Readonly<Record<string, AggregateExpr>>
    }
  | ExtensionNode
```

`where` expressions see the input scope; joins see both input scopes; `select`
and `aggregate` replace input scope with their declared output alias. The pure
spike implements exactly these nodes. The broader v1 algebra remains required,
but its additional discriminants freeze only with their golden workloads.

## Transaction subset

```ts
type BaseTarget = {
  relation: RelationUse
  alias: string
  where?: Expr
}

type FieldEdit =
  | { kind: 'edit.replace'; value: Expr }
  | { kind: 'edit.counter-increment'; amount: Expr }
  | {
      kind: 'edit.text-splice'
      index: Expr
      deleteCount: Expr
      insert: Expr
    }
  | {
      kind: 'edit.conflict-resolve'
      observed: readonly SpikeValue[]
      value: Expr
    }
  | ExtensionNode

type Statement =
  | {
      kind: 'statement.insert'
      relation: RelationUse
      rows: readonly Readonly<Record<string, Expr>>[]
    }
  | {
      kind: 'statement.update'
      target: BaseTarget
      edits: Readonly<Record<string, FieldEdit>>
    }
  | { kind: 'statement.delete'; target: BaseTarget }
  | {
      kind: 'statement.rekey'
      target: BaseTarget
      key: Readonly<Record<string, Expr>>
      references: 'source-local-declared' | 'reject-if-referenced'
      requires: CapabilityRef
    }
  | {
      kind: 'statement.move'
      target: BaseTarget
      parent: Expr
      position:
        | { kind: 'beginning' }
        | { kind: 'end' }
        | { kind: 'before'; anchor: Expr }
        | { kind: 'after'; anchor: Expr }
      missingAnchor: 'reject' | 'beginning' | 'end'
      requires: CapabilityRef
    }
  | ExtensionNode

type Guard =
  | { kind: 'guard.query'; root: QueryNode; expect: 'exists' | 'empty' }
  | {
      kind: 'guard.affected-count'
      statementIndex: number
      count: 'matched' | 'logicallyChanged' | 'inserted' | 'deleted'
      op: 'eq' | 'gte' | 'lte'
      value: number
    }
  | ExtensionNode
```

Portable targets select logical entities. Locators and physical commands are
prepared source-private data. Transaction query nodes may range only over the
attempted source; foreign facts must be captured parameters.

The spike subset permits only `JsonValue` literals, parameters, lens constants,
and observed conflict values; tagged values enter spike artifacts only after
their fixtures and golden hashes are added. A rekey `key` object contains
exactly every target-view key field. `source-local-declared` follows only
declared same-source refs through the staged lens view; cross-source refs reject.
`reject-if-referenced` permits no affected declared ref. Both modes reject an
ambiguous target, new key, or inverse lens.

## Constraint-set subset

```ts
type ConstraintFootprint = {
  relation: RelationUse
  fields: '*' | readonly string[]
}

type ConstraintSetBody = {
  constraints: readonly {
    constraintId: string
    violationQuery: ArtifactRef
    code: string
    output: {
      subjectFields: readonly string[]
      contributorsField?: string
      detailsField?: string
    }
    footprint: readonly ConstraintFootprint[]
    requiredCapabilities: readonly CapabilityRef[]
  }[]
}
```

`violationQuery` MUST resolve to a query artifact. One declaration has one
stable code; helpers producing different codes compile to separate declarations.
Activation mode remains source metadata rather than artifact content.

## Storage-mapping subset

```ts
type StoragePath = readonly (string | number)[]

type StorageMappingBody = {
  schema: ArtifactRef
  model: 'json-tree-v1'
  relations: Readonly<Record<RelationId, {
    collection:
      | {
          kind: 'object-map'
          path: StoragePath
          absent: 'empty' | 'creatable' | 'invalid'
        }
      | {
          kind: 'array'
          path: StoragePath
          absent: 'empty' | 'creatable' | 'invalid'
        }
    keys: Readonly<Record<string,
      | {
          kind: 'map-key'
          mirrorPath?: StoragePath
          onMismatch: 'reject'
        }
      | { kind: 'field'; path: StoragePath }
    >>
    fields: Readonly<Record<string, {
      path: StoragePath
      write:
        | { kind: 'replace'; capability: CapabilityRef }
        | { kind: 'read-only' }
    }>>
  }>>
}
```

This subset describes JSON-tree maps/arrays, explicit absence, derived keys,
field replacement, and read-only projection. Move, conflict inspection, and
host actions remain binding behavior.

## Schema-lens subset

```ts
type SchemaLensBody = {
  from: ArtifactRef
  to: ArtifactRef
  relations: readonly {
    fromRelationId: RelationId
    toRelationId: RelationId
    steps: readonly LensStep[]
  }[]
}

type LensStep =
  | { kind: 'lens.field'; from: string; to: string; write: 'invertible' | 'read-only' }
  | { kind: 'lens.default'; to: string; value: SpikeValue; write: 'preserve' }
  | { kind: 'lens.hide'; from: string; write: 'preserve' }
  | {
      kind: 'lens.value-map'
      from: string
      to: string
      cases: readonly {
        from: SpikeValue
        to: SpikeValue
        writeBack: 'to-from' | 'same-only' | 'reject'
      }[]
      unmapped: 'reject'
    }
  | {
      kind: 'lens.lookup'
      from: string
      to: string
      through: RelationUse
      sourceFields: readonly string[]
      resultFields: readonly string[]
      onMissing: 'reject'
      onAmbiguous: 'reject'
      write: 'invertible' | 'read-only'
    }
  | ExtensionNode
```

Direction is stored/current `from` to requested view `to`. Arbitrary split or
merge writes remain read-only unless a future exact inverse binding is named.
An invertible rekey translates key fields backward through these steps, then
re-evaluates declared source-local ref lookups in the staged view. A stable
stored ID/ref that still denotes the same entity is preserved rather than
rewritten merely because the requested view key changed.

## Built-in capability catalog

```ts
type CapabilityDeclaration = {
  kind: 'tarstate.capability-contract'
  formatVersion: 1
  id: string
  version: string
  class: 'edit' | 'executor' | 'source' | 'function' | 'codec' | 'collation'
  contract: JsonValue
  implies: readonly CapabilityRef[]
}
```

`contractHash` is SHA-256 over RFC 8785 canonicalization of the complete
declaration. Every built-in below uses version `1`, contract exactly
`{"operation":"<ID suffix>"}`, and the stated implication list. The table is a
golden vector: implementations MUST reconstruct and verify these hashes.

| ID suffix | Class | Contract hash | Implies |
| --- | --- | --- | --- |
| `field/replace` | edit | `sha256:b60c245fe7811ce744805e1cd6c22ad9f270879e46bc03299fbd5270122afb74` | — |
| `field/counter-increment` | edit | `sha256:9df5e2507b3d10ca1d40c3e7b0b42c9c6de272a02ebaee8b69a838206f881963` | — |
| `field/text-splice` | edit | `sha256:9a9cc22f2768d5de353a390682e17430952614e8e30eb8fc12992170d4c5d0fc` | — |
| `field/conflict-resolve` | edit | `sha256:d2f90f3c1fcda78718037d6c4c1d27b7155e276c92c14fd2c2d4fb08aa9729d3` | — |
| `entity/move` | edit | `sha256:4406275cc0916b33bf7cde7ef69f07be2788f0fe1e903b792f44ff3e238dcdc6` | — |
| `entity/rekey` | edit | `sha256:1cdfeb0b1e43c76df6b4fd5774c37eca5f33c3d17310caa9a11a88489f020e5f` | — |
| `entity/copy-relocate` | edit | `sha256:0403e04d4800fc6e143d8e91c98605e72445a0af94d58c7bbcfc7cf450d1d44b` | exact `entity/move` ref |
| `entity/identity-preserving-move` | edit | `sha256:0a6ab736c23054f2b6dac6c5baa671769a078ac57c3540b73e63878c26442cb5` | exact `entity/move` ref |
| `constraint/required-local-enforcement` | executor | `sha256:f339e39b0df5dfc61fc65eb953be4fa57221be6ec4c85b14f00f113c1eaa9e46` | — |
| `source/durable-operation-receipts` | source | `sha256:f6a5fc6304dc80d2b3449caf78518839967f483992541539b9f49f90a440c771` | — |

The full ID is `urn:tarstate:capability:<suffix>`. The implication ref for both
stronger move contracts is exactly the `entity/move` full ID, version `1`, and
its table hash. `implies` is otherwise `[]`. No field edit implies replacement,
and neither stronger move mechanism implies the other.

All five required spikes consume this grammar and catalog directly. They may
propose additive nodes and contracts, but may not emit private alternate wire
shapes and call them v1 evidence.
