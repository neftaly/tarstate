# Developer experience and performance

Status: normative acceptance contract.

DX and performance are part of v1 correctness. They do not change the portable
relational semantics defined elsewhere in this packet.

## TypeScript boundary

An authoring builder may infer exact row, key-tuple, parameter, alias, result,
and write types only from literal portable artifact data. It MUST emit the same
serializable artifact that an untyped host could parse; inferred types are not a
second source of meaning.

A schema loaded dynamically cannot acquire a trusted static row type from its ID
alone. It remains runtime-typed until paired with generated declarations tied to
the exact artifact content hash. Hash mismatch fails rather than silently using
stale types.

The public authoring style is functional `pipe`. Type tests must prove:

- relation rows, optional versus nullable fields, custom codec values, and
  always-tuple logical keys infer without annotations for literal schemas;
- aliases and self-joins remain distinct and projections infer their output;
- query parameters and `returning` rows are inferred;
- readable, writable, move, rekey, and field-edit capabilities are distinct;
- unsupported writes fail near the responsible operator when statically known;
- parsed dynamic artifacts return safe unknown/runtime-typed values, never
  `any` disguised as inference;
- React hooks preserve the prepared query's row and parameter types.

Runtime attachment capabilities, authority, conflicts, and bases can change, so
static writeability is only an upper bound. Simulation and commit receipts remain
the runtime authority.

Public type complexity is budgeted. Representative schema/query fixtures track
TypeScript check time, editor completion time, emitted declaration size, and
type-instantiation depth. A clever type that makes ordinary editor interaction
slow is not acceptable API design.

## Public vocabulary to test in the spikes

App-facing examples use these names unless a spike disproves them:

- `Source`/`SourceId` for one atomic Automerge document, external store, or
  custom source;
- `Dataset` for the selected versioned membership of attached sources;
- `Database` for one authority-scoped runtime view;
- `StorageMapping`, `StorageBinding`, and `SchemaLens` for the three distinct
  portability/execution/evolution roles;
- `NonAtomicBatch` and `NonAtomicBatchReceipt` for cross-source sequencing.

Canonical functional authoring uses `alias`, `from`, `where`, `select`,
`withFields`, `rename`, `omit`, and `unnest`; it does not retain terse aliases
such as `as`, `q`, `mat`, or competing `project`/`extend`/`without` spellings.
Collision-safe field access is `alias.row.field`; this is property navigation,
not a fluent query chain.

The React spelling tested is `TarstateProvider`, `useDatabase`, `useQuery`,
`useRow`, `useCommit`, and `useMutationState`. Exact overloads freeze only after
type, hover, and call-site fixtures prove them; the semantic/wire names above do
not wait on constructor ergonomics.

## Human and agent diagnostics

Every parser, resolver, preparer, simulator, and commit path returns structured
issues with stable codes and bounded paths. Presentation text may explain the
issue, but automation branches on codes and declared missing capabilities.

Schema tooling emits a machine-readable capability view containing exact
artifact hashes, available relations and operations, required registrations,
authority-visible limitations, and unsupported reasons. It does not expose
redacted facts or grant authority. This lets consumer agents escalate a missing
Tarstate capability instead of inventing a permanent user-space substitute.

The authority-filtered database description is a portable observation with:

- database-view and registry fingerprints plus observation basis;
- datasets and their membership/lifecycle state;
- exact schema/relation IDs and artifact hashes;
- readable and writable operations per relation/attachment;
- required, available, missing, and implied capability refs;
- supported system commands and receipt kinds;
- the exact issue-code catalog ref.

It contains no physical locators, hidden-row counts, executable code, or
authority tokens. Agents use the same query, simulation, command, and receipt
paths as applications; the description is discovery, not a privileged API.

```ts
type IssueCodeCatalog = Artifact<{
  codes: Readonly<Record<string, {
    phase: Issue['phase']
    retry: readonly NonNullable<Issue['retry']>[]
    requiredCapabilityFields: readonly string[]
    description?: string
  }>>
}>

type DatabaseDescription = {
  kind: 'tarstate.database-description'
  formatVersion: 1
  databaseFingerprint: `sha256:${string}`
  registryFingerprint: `sha256:${string}`
  basis: ObservationBasis
  datasets: readonly {
    datasetId: DatasetId
    revision: number
    state: 'open' | 'settled'
    attachmentIds: readonly AttachmentId[]
  }[]
  relations: readonly {
    schema: ArtifactRef
    relationId: RelationId
    localName: string
    attachmentId: AttachmentId
    readable: boolean
    editCapabilities: readonly CapabilityRef[]
    missingCapabilities: readonly CapabilityRef[]
  }[]
  commands: readonly {
    id:
      | 'tarstate.command.commit'
      | 'tarstate.command.non_atomic_batch'
      | 'tarstate.command.simulate'
      | 'tarstate.command.set_presence'
      | 'tarstate.command.source_lifecycle'
      | 'tarstate.command.governance'
    input: ValueDeclaration
    resultKind: string
    resultVersion: number
  }[]
  capabilityImplications: readonly {
    provided: CapabilityRef
    implies: CapabilityRef
  }[]
  issueCodeCatalog: ArtifactRef
}
```

`describeDatabase(database)` returns this snapshot through the ordinary
authority-filtered shell and `safeParseDatabaseDescription` parses forwarded
descriptions. Changes to membership, authority, attachments, or registry produce
a new fingerprint/basis. Command descriptions advertise shapes and receipts;
they do not create a second execution API or grant those commands.

Each relation availability entry describes exactly one attachment. Consumers
must not infer that a capability available on one attachment applies to another
attachment exposing the same schema and relation.

Public runtime operations remain functional: database/source/attachment values
are explicit arguments to query, observe, simulate, commit, and presence
commands. Stateful observer/source protocols may expose `getSnapshot`,
`subscribe`, and `close`, but the relational DSL and write construction never
become fluent method chains. Public results consistently use `Issue`, `outcome`,
and typed receipt vocabulary rather than parallel diagnostic/status models.

## Runtime performance contract

The pure full evaluator remains the semantic oracle. Incremental maintenance,
indexes, materialization, and adapter hints may change cost but never rows,
identity, ordering, completeness, issues, or receipts.

Source subscriptions may carry an optional adapter-specific change token.
Bindings for that source may use it to invalidate or update projections. The
token is an optimization hint, is tied to before/after source bases, grants no
authority, and is never trusted as the only evidence of state. Missing, stale,
or unsupported tokens fall back to a fresh snapshot and full projection.

V1 exposes no portable physical index or query-plan controls. Query artifacts
remain independent of storage strategy; a binding or database implementation may
build private indexes from declared keys, query dependencies, and observed
workloads. A future physical-hint artifact can be added without changing query
meaning if evidence shows it is needed.

## Retention and garbage collection

Correctness never depends on JavaScript reachability, `WeakRef`, or
`FinalizationRegistry`. Public `close`/detach operations and internal reference
counts define liveness.

- A live observer strongly owns its `current` snapshot and required `lastExact`
  until close; neither is an evictable cache. Its bounded provenance/issues are
  part of those snapshots.
- Equal observers may share maintenance. The maintenance owns source
  subscriptions while its reference count is nonzero. At zero it unsubscribes,
  cancels owned loads, and releases snapshots/projections.
- A database releases an attachment subscription when no dataset, observer,
  transaction, or explicit attachment reference needs it. It closes an
  underlying source only when that source was explicitly transferred as
  database-owned; borrowed Automerge handles and external stores are never
  closed by Tarstate.
- Prepared plans, inactive projections, private indexes, parsed artifacts, and
  rendered receipt objects are recomputable caches and may be evicted under host
  bounds. Active artifact/declaration refs remain resolvable or the affected
  attachment becomes unavailable/read-only explicitly.
- Candidate handles expire on basis or attachment-incarnation change.
  Optimistic overlays live until their operation resolves, rebases, is rejected,
  or their owning observer/database closes.
- Semantic operation dedup/outcome ledgers are not receipt caches. Active-epoch
  entries are not individually evictable; explicit epoch retirement and
  fail-closed expired lookup follow the transaction specification.
- Automerge history and adapter-private relocation/bootstrap metadata are
  durable source data, not JS caches. V1 never claims that heap GC compacts them.

Eviction may cause recomputation, never semantic loss. Retention policies and
reference counts are observable through development diagnostics, without
exposing hidden row data.

## V1 structural performance gate

The clean-slate implementation uses simple full recomputation and the five
golden workloads as a coarse structural smoke. `pnpm bench` fails only when the
whole staged workload exceeds a deliberately loose per-iteration ceiling; the
ceiling can be overridden for constrained CI hosts. This detects gross runaway
work without presenting one machine's elapsed time as a portable API promise.

V1 does not require microbenchmarks, GC profiles, per-operator latency targets,
or legacy performance parity. Compiler/declaration budgets and executable
cache, lease, and subscription-lifetime tests remain release gates. A material
workload regression calls for ownership/data-flow simplification first and
focused profiling second; it never permits weaker rows, identities, ordering,
completeness, issues, or receipts.

This scope is the explicit owner decision recorded as D-002 in
`decisions.md`, not a contradiction discovered by a spike.
