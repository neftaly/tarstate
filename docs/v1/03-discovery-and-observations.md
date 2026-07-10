# Discovery and observations

Status: normative.

Discovery, attachment, query evaluation, and source connectivity are separate
subsystems. Query recursion never performs network or filesystem discovery.

## Resolver and attachment manager

A resolver turns authority-approved resource references into typed resources.
It handles:

- live and head-pinned `automerge:` references;
- `https:` fetch, cache, redirect, ETag, integrity, CORS, and offline policy;
- schema and constraint bootstrap;
- relative references;
- aliases and cycles;
- denied, missing, loading, failed, deleted, and unsupported resources;
- bytes/data versus schema versus executable-code resource kinds.

Resolution does not execute code. An HTTPS file such as Ghostscript Tiger is a
resource leaf. It becomes a relational source only if a trusted host explicitly
attaches a schema and storage binding for it.

## Document bootstrap declaration

A self-describing relational document normalizes to this portable declaration:

```ts
type DocumentDeclaration = {
  formatVersion: 1
  storageSchema: ArtifactRef
  projection:
    | { kind: 'storage-mapping'; storageMapping: ArtifactRef }
    | { kind: 'storage-binding'; storageBinding: CapabilityRef }
  constraints?: {
    set: ArtifactRef
    mode: 'audit' | 'required'
  }
}
```

The declaration says how to resolve logical storage meaning; it grants no
authority and loads no executable code. A mapping remains portable data. A
binding ref succeeds only when the trusted host already registers that exact
capability. A host may instead supply the same declaration out of band when
attaching a document.

The Automerge adapter may carry the declaration in an opt-in reserved root map
named `__tarstateMetaV1`. The map contains immutable `storage` and `constraints`
section values so concurrent replacements produce section-level conflicts
rather than silently merging into a hybrid declaration. Its wire layout is
adapter-private; portable artifacts and app APIs never name the root key.

```ts
type AutomergeMetadataV1 = {
  formatVersion: 1
  storage: {
    storageSchema: ArtifactRef
    projection: DocumentDeclaration['projection']
  }
  constraints?: DocumentDeclaration['constraints']
}
```

A compliant writer replaces the complete `storage` or `constraints` child value
in one Automerge change; it never patches individual fields in place. Readers
inspect Automerge conflicts on the root and both section properties before
choosing a value. This exact carrier shape is for adapter interoperability, not
portable app consumption.

The adapter does not create or overwrite this key merely by opening an existing
document. An absent key means no in-document declaration. An incompatible
existing value, conflicted root/section, or malformed declaration produces a
metadata issue and disables automatic writable attachment. A trusted host may
still attach the source read-only from an explicit out-of-band declaration. It
may make that attachment writable only when the key is absent, or governance
authority explicitly classifies an incompatible value as unrelated application
data and supplies the complete constraint activation. A recognized conflicted
or malformed Tarstate declaration remains read-only until repaired; an
out-of-band declaration cannot bypass it. Unknown fields and unknown versioned
sibling keys are preserved.

Initialization and repair require explicit governance authority, an exact
source basis, and an auditable receipt. Future formats use versioned sibling
keys; old adapters preserve them and never reinterpret v1.

The attachment manager deduplicates sources while retaining every discovery edge
and alias as queryable facts. Two paths to one document produce one set of
document rows. Authority grants are not silently unioned by deduplication.

Every attached view has a stable `AttachmentId`, distinct from `SourceId`. One
source may simultaneously have live, pinned, differently bound, or differently
authorized attachments. Base storage identity remains source + relation +
locator; the attachment identifies the view through which that identity was
observed.

## Dataset membership

A dataset is an expected, versioned set of attachments. A member names an
attachment, not a bare source. Members may expose different schemas and bindings;
query preparation selects compatible schema views/lenses per referenced
relation.

```ts
type DatasetId = string

type DatasetSnapshot = {
  datasetId: DatasetId
  revision: number
  state: 'open' | 'settled'
  members: readonly {
    attachmentId: AttachmentId
    sourceId: SourceId
    expectation: 'required' | 'optional'
    discoveryEdges: readonly string[]
  }[]
}
```

`settled` means the resolver has completed the declared traversal for this
membership revision. It does not claim the graph can never change; a source
change creates a later open revision. Cycles do not prevent settlement once
visited source identities have been deduplicated.

Removing a source from expected membership is different from a required source
becoming unavailable. The former can yield a complete new observation; the
latter cannot.

A required member must be ready at a usable basis for an exact query. An
optional unavailable member does not block settlement or exactness and
contributes no rows, but its absence and expectation remain explicit source
evidence. If it later becomes ready, that is a new membership/source
observation and subscribers update normally.

Every query execution selects exactly one dataset as its relational
universe. `from(relation)` ranges over each member attachment exposing that
relation ID through the query's schema view, with no implicit access to other
database attachments. Joining across datasets requires an explicitly
constructed combined dataset. This selection is part of observer/cache
identity and observation basis.

## Source lifecycle and freshness

Generic source lifecycle states are `loading`, `ready`, `failed`, `denied`,
`deleted`, and `closed`. Freshness is separately `current`, `stale`, or `none`.
Network offline/sync lag does not make a loaded local Automerge snapshot stale;
connection and remote-sync facts are separate relations.

External-store hydration is lifecycle state. An unhydrated Zustand/TanStack
store MUST NOT be presented as an authoritative empty relation unless the host
explicitly chooses that policy.

An external store that declares no hydration capability is `ready` immediately.
If it declares hydration, it remains `loading` until the adapter receives the
store's positive hydration signal; absence of data is not that signal.

## Composite basis

A multi-source observation records, but does not atomically capture, a set of
source snapshots:

```ts
type ObservationBasis = {
  dataset: { datasetId: DatasetId; revision: number }
  attachments: readonly {
    attachmentId: AttachmentId
    sourceId: SourceId
    basis: SourceBasis
  }[]
}
```

It means exactly “these were the source snapshots used.” It is not distributed
snapshot isolation.

## Query result evidence

Query results separate semantic completeness from freshness and source state:

```ts
type QueryResult<Row> = {
  rows: readonly Row[]
  resultKeys: readonly ResultKey[]
  completeness: 'exact' | 'lower-bound' | 'unknown'
  freshness: 'current' | 'stale' | 'mixed' | 'none'
  basis: ObservationBasis
  sourceStates: readonly SourceEvidence[]
  issues: readonly Issue[]
}
```

The default evaluation mode requires complete declared inputs and returns exact
current results only. While newer inputs load, the current result becomes
unknown; retained data is never relabeled as a current result.

Partial evaluation is opt-in:

- Positive monotone operations may return a lower bound from available inputs.
- Anti-join, difference, left-unmatched rows, global count/aggregate, windows,
  limit/offset, uniqueness, absence checks, and other non-monotone conclusions
  are unknown until their declared inputs and membership are settled.
- Unknown results MUST NOT be treated as an empty relation or used as a hard
  transaction guard.
- Each operator records the missing evidence responsible for unknownness.

For a whole query with `completeness: 'unknown'`, `rows` and `resultKeys` MUST be
empty arrays, but that does not assert an empty relation. A retained prior exact
answer is exposed separately as an observer's `lastExact` snapshot, with its
original basis and stale freshness. Known monotone answers use `lower-bound`,
not `unknown`.

An observer snapshot contains `current` and optional `lastExact`. Whenever
`current` is exact, `lastExact` is the same result. On transition to unknown,
`current` has empty rows at the current observation evidence while `lastExact`
retains its old rows and basis with stale freshness. React consumers must choose
explicitly whether to render current evidence or stale retained data.

Monotone recursive query evaluation may operate over a settled membership
snapshot. Recursive discovery itself remains the resolver's job.

## Observers and incremental maintenance

```ts
type ObserverSnapshot<Row> =
  | {
      state: 'open'
      current: QueryResult<Row>
      lastExact?: QueryResult<Row>
    }
  | { state: 'closed' }
```

An observer has cached immutable `getSnapshot`, `subscribe`, and `close`
operations. Each `observe` call creates a distinct public lease. Equal query,
parameter, authority-view, registry-fingerprint, and dataset identity inputs
may share internal maintenance, but never one closeable public object. A
membership revision is changing observed state, not a new observer identity.

Closing one lease drops its listeners and reference count without affecting
other leases. Listener unsubscription alone does not close the lease. After
close, `getSnapshot()` returns one stable closed snapshot and `subscribe()` is
inert. At zero leases, shared maintenance unsubscribes, cancels only work it
owns, releases `current`, `lastExact`, projections and diff history, and removes
its cache entry. A later observer starts a new lifetime and cannot inherit a
collected `lastExact`.

Snapshots change when rows, result keys, basis, completeness, freshness, source
evidence, or issues change. Basis-only changes therefore notify full-result
subscribers. Selectors may suppress React rendering when selected data remains
equal.

Observer notifications include identity-aware added, removed, and updated
diffs. Listener failure is isolated. Reentrant commits are queued after the
current notification. Unsubscription and close are idempotent.

Transitioning to unknown emits an invalidation, not a diff claiming that prior
rows were removed. Once a later exact result exists, it may be diffed against
the retained prior exact result when their query, authority view, and occurrence
identity domains are compatible; otherwise it emits a reset.

Incremental maintenance is private physical optimization. A pure full evaluator
is the semantic oracle. Every incremental operator is differentially tested
against it and may fall back to bounded recomputation without changing public
semantics.

## Authority and caches

The database view is authority-filtered before query evaluation and caching.
Cache identity includes principal/view scope and registry/trust fingerprint.
Rows, counts, result keys, issues, and provenance from a stronger view MUST NOT
be reused in a weaker view.

An attachment's effective authority is the intersection of its source grant and
the selected database-view grant. Grants reached through multiple discovery
edges remain separate attachment views and are never implicitly unioned. A host
may deliberately construct a combined authority view, but that is a new,
auditable view identity rather than a side effect of source deduplication.

Redaction normally creates a complete authorized view rather than leaking that
hidden facts exist. Source-level constraints are evaluated in a separate
source-authoritative context.

## Presence and system relations

Presence is a readable ephemeral relation plus explicit `setPresence` commands.
It is neither durable nor part of durable transactions or constraints. Delivery
and expiry behavior are source capabilities.

Generic system relations expose sources, memberships, schemas,
capabilities, current issues, and constraint violations. Automerge adapters add
peer, connection, sync, conflict, and presence facts. These facts do not redefine
local commit success.

The v1 built-in system schema uses stable relation IDs and minimum logical
fields:

| Relation ID | Key | Minimum fields |
| --- | --- | --- |
| `tarstate.system.sources` | `sourceId` | source kind, lifecycle, freshness, current-basis evidence, durability capability |
| `tarstate.system.attachments` | `attachmentId` | source ID, lifecycle, freshness, writable state, declaration state |
| `tarstate.system.memberships` | dataset/revision/attachment | expectation and settlement state |
| `tarstate.system.resources` | `resourceId` | kind, requested/resolved refs, lifecycle/freshness, redirects, media/cache/integrity evidence, optional bytes |
| `tarstate.system.discovery_edges` | `edgeId` | dataset/revision, origin, declared ref/path, expectation, resolution state, target/alias/cycle evidence |
| `tarstate.system.schemas` | attachment/schema hash | exact schema ref, selected lens refs, resolution state |
| `tarstate.system.capabilities` | attachment/capability ref | availability and redaction-safe reason code |
| `tarstate.system.issues` | issue ID | code, severity, phase, authorized subject fields |
| `tarstate.system.constraints` | violation ID | set/constraint IDs, status, subject, code |
| `tarstate.system.repair_candidates` | attachment/candidate | source/relation, logical key when parseable, candidate kind/live state, related issue IDs |
| `tarstate.automerge.peers` | attachment/peer ID | observed peer state, storage ID and ephemeral metadata when reported |
| `tarstate.automerge.connections` | attachment/peer ID | connected/disconnected lifecycle; no generic connection ID is asserted |
| `tarstate.automerge.sync` | attachment/document/storage ID | normalized offline/idle/syncing/synced/error state, heads and timestamp evidence; peer ID when correlated through storage metadata |
| `tarstate.automerge.conflicts` | issue ID | authorized logical row/path and bounded alternative evidence |
| `tarstate.automerge.presence` | attachment/peer ID/channel | JSON payload, observed/local state, activity/expiry evidence |

Exact field declarations live in an immutable built-in schema artifact and are
covered by generated types/conformance tests. Adapters may publish new schema
versions or additional namespaced relations; they do not silently add meaning
to an existing version. All rows remain authority-filtered and basis-bearing.

These Automerge keys reflect Repo 2.5.6 evidence. Network peer and disconnect
events identify only a peer; `remote-heads` identifies a document observation
by storage ID, heads, and timestamp; Presence identifies updates by peer and
channel. An adapter-specific transport may expose a connection ID as additional
versioned evidence, but the built-in minimum cannot manufacture one.

The resource/discovery minimum rows are:

```ts
type ResourceSystemRow = {
  resourceId: string
  kind:
    | 'bytes'
    | 'document'
    | 'schema'
    | 'constraint'
    | 'storage-mapping'
    | 'executable'
    | 'unknown'
  requestedRef: string
  resolvedRef?: string
  lifecycle: 'loading' | 'ready' | 'failed' | 'denied' | 'deleted'
  freshness: 'current' | 'stale' | 'none'
  redirects: readonly string[]
  mediaType?: string
  etag?: string
  contentHash?: `sha256:${string}`
  cacheState?: 'miss' | 'memory' | 'local' | 'revalidated'
  bytes?: { kind: 'tarstate.value'; type: 'bytes'; value: string }
}

type DiscoveryEdgeSystemRow = {
  edgeId: string
  datasetId: DatasetId
  revision: number
  originAttachmentId?: AttachmentId
  originResourceId?: string
  path: readonly PortableValue[]
  declaredRef: string
  expectation: 'required' | 'optional'
  state: 'loading' | 'ready' | 'missing' | 'denied' | 'failed' | 'unsupported'
  targetResourceId?: string
  aliasOfResourceId?: string
  cycle: boolean
}
```

An executable resource row never authorizes or loads code. Large bytes remain
subject to resolver/query budgets and may be absent with an issue even when
metadata is ready. A direct HTTPS byte resource remains a resource row and
discovery target, not a relational source.

`repair_candidates` exposes a view-local `candidateId` for correlation while its
prepared rows retain a hidden candidate handle scoped to the database view,
attachment incarnation, and source basis. The ID is neither a physical locator
nor sufficient write authority. An authorized transaction selection query
retains the hidden handle and commit rechecks its scope/live storage identity.
This permits choosing between otherwise identical duplicates or relocation
targets without accepting raw client-supplied locators.

```ts
type SetPresenceCommand = {
  operationId: string
  attachmentId: AttachmentId
  sessionId: string
  action: 'set' | 'clear'
  value?: JsonValue
}

type PresenceReceipt = {
  kind: 'presence'
  receiptVersion: 1
  operationId: string
  attachmentId: AttachmentId
  outcome: 'accepted' | 'rejected'
  issues: readonly Issue[]
}
```

`set` requires `value`; `clear` forbids it. `accepted` means only that the local
presence source accepted the ephemeral update. It claims neither delivery nor
remote observation. Those remain queryable source facts. Presence commands are
not transaction or sequence steps unless a future shell explicitly records them
as non-atomic effects.

## React boundary

The React package consumes observers through cached immutable external-store
snapshots. The provider borrows a database and never closes externally owned
sources. Attachment reference counting and load cancellation are StrictMode
safe.

V1 React exports are limited to the provider, database access, query/row hooks,
commit, and mutation-state convenience. Suspense is excluded. SSR is supported
only when the host supplies a serialized matching server observation; otherwise
the hook explicitly requires client rendering.
