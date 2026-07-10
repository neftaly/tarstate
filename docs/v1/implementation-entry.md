# Implementation entry contract

Status: normative readiness checklist.

This document defines the smallest semantic skeleton that must be proven before
the production rewrite broadens its API.

## Minimal semantic types

Names are provisional TypeScript spelling; distinctions and semantics are
normative.

```ts
type ArtifactRef = {
  id: string
  contentHash: `sha256:${string}`
  locations?: readonly string[]
}

type SourceBasis = PortableValue

type SourceSnapshot<Storage> = {
  sourceId: SourceId
  operationEpoch: string
  basis: SourceBasis
  state: 'loading' | 'ready' | 'failed' | 'denied' | 'deleted' | 'closed'
  freshness: 'current' | 'stale' | 'none'
  storage?: Storage
  issues: readonly Issue[]
}

type LogicalRow = {
  attachmentId: AttachmentId
  sourceId: SourceId
  relationId: RelationId
  key: LogicalKey
  locator: RowLocator
  fields: Readonly<Record<string, LogicalValue>>
}

type FootprintRelation =
  | 'disjoint'
  | 'equal'
  | 'contains'
  | 'contained_by'
  | 'overlaps'
  | 'unknown'

type StorageIntent<Command> = {
  footprint: Footprint
  command: Command
}

type PlanResult<Command> = {
  readFootprint: Footprint
  writeFootprint: Footprint
  intents: readonly StorageIntent<Command>[]
  issues: readonly Issue[]
}

type IntentMergeResult<Command> =
  | { outcome: 'merged'; commands: readonly Command[] }
  | { outcome: 'conflict' | 'unknown'; issues: readonly Issue[] }

type StorageBinding<Storage, Command, Delta = never> = {
  id: string
  declaredReadFootprint: Footprint
  declaredWriteFootprint: Footprint
  project(snapshot: SourceSnapshot<Storage>): ProjectionResult
  plan(snapshot: SourceSnapshot<Storage>, edits: readonly LogicalEdit[]): PlanResult<Command>
  updateProjection?(
    previous: ProjectionResult,
    snapshot: SourceSnapshot<Storage>,
    delta: Delta,
  ): ProjectionResult
}

type AtomicSource<Storage, Command, Delta = never> = {
  sourceId: SourceId
  snapshot(): SourceSnapshot<Storage>
  subscribe(listener: (change?: {
    beforeBasis?: SourceBasis
    afterBasis: SourceBasis
    delta?: Delta
  }) => void): () => void
  commit(input: {
    operationEpoch: string
    operationId: string
    intentHash: `sha256:${string}`
    expectedBasis: SourceBasis
    commands: readonly Command[]
  }): Promise<SourceCommitResult>
  relateFootprints(left: Footprint, right: Footprint): FootprintRelation
  mergeIntents(
    plans: readonly PlanResult<Command>[],
  ): IntentMergeResult<Command>
  stage(
    snapshot: SourceSnapshot<Storage>,
    commands: readonly Command[],
  ): { storage: Storage; issues: readonly Issue[] }
  queryOutcome?(input: {
    operationEpoch: string
    operationId: string
    intentHash: `sha256:${string}`
  }): Promise<OutcomeLookup<SourceCommitResult>>
}

type OutcomeLookup<Result> =
  | { status: 'known'; result: Result }
  | { status: 'not_seen' }
  | { status: 'ambiguous' | 'expired' }
  | { status: 'unavailable'; issues: readonly Issue[] }

type Attachment = {
  attachmentId: AttachmentId
  incarnation: string
  sourceId: SourceId
  source: AtomicSource<unknown, unknown, unknown>
  storageBindings: readonly StorageBinding<unknown, unknown, unknown>[]
  schemaViews: readonly ArtifactRef[]
  authorityScope: string
}
```

The source commit coordinator sits above all storage bindings and implements the
commit sequence from the transaction specification. A storage binding never
commits by itself.

## Generic external-store protocol

The core adapter seam is not Zustand-specific:

```ts
type AtomicExternalStore<State> = {
  getState(): State
  subscribe(listener: () => void): () => void
  update<Result>(fn: (current: State) => {
    state: State
    changed: boolean
    result: Result
  }): Result
  hydration?: {
    getState(): 'loading' | 'ready' | 'failed'
    subscribe(listener: () => void): () => void
  }
}
```

`update` MUST be synchronous and atomic relative to that store's other updates.
`changed: false` preserves the basis and emits no state notification;
`changed: true` advances the shared revision exactly once before return and
publishes exactly one coherent notification. Direct mutation outside the
setter violates the adapter contract. Zustand and TanStack Store integrations
are thin adapters over this protocol; Immer middleware is neither required nor
forbidden.

Every legitimate state-changing setter, including setters called outside
Tarstate, MUST notify `subscribe` synchronously before that setter returns. A
store that offers only delayed notification does not satisfy this protocol
unless its adapter supplies an authoritative version token read/compared inside
the store's atomic update boundary. The shared commit coordinator compares the
expected revision inside `update` and advances its revision in that same call;
its own resulting store notification is coalesced rather than double-counted.

Every hydration-status transition MUST notify `hydration.subscribe`, even when
the hydrated data equals the initial state and the store emits no state
notification. The adapter combines store and hydration subscriptions and
re-reads `hydration.getState()` after either signal. Its commit coordinator
maintains one monotonic revision for the external store and shares it across
attachments.

Exactly one source runtime, commit coordinator, and underlying store/hydration
subscription exists per `(SourceId, store identity)` in the host adapter
registry—not per `Database`. Every database/attachment borrows a refcounted
lease to that runtime, so separate authority views cannot create incomparable
revisions for the same store. Registering a different live store under the same
source ID is an error. At zero leases the runtime unsubscribes and releases
adapter state but never closes the borrowed store. Reattaching later creates a
new source incarnation, so its basis cannot compare equal to queued work from
the discarded runtime.

## Portable public concepts

The stable v1 public concepts are:

- artifact refs/resolution and capability registries;
- schema, relation, field, codec, storage mapping, storage binding, and explicit
  schema lens;
- functional query/expressions with aliases;
- constraint sets and same-source referential actions;
- transaction, simulation, commit receipt, `NonAtomicBatch`, and
  `NonAtomicBatchReceipt`;
- atomic source, attachment, dataset membership, database view, query result,
  observer, and structured issue;
- Automerge, generic external-store, Zustand/TanStack convenience, and React
  adapters.

The portable algebra must cover these proven families:

- `alias`, `from`, constant values, and query-scoped aliases;
- `where`, `select`, `withFields`, `rename`, `omit`, and `unnest`;
- inner, cross, left, semi, and anti joins;
- aggregate, distinct, union/union-all, intersect, and except;
- deterministic ordering, limit, offset, and basis-aware keyset seek;
- scalar/correlated/exists subqueries;
- keyed monotone recursion;
- the rank/row-number/lag window subset required by the leaderboard trace;
- literals, parameters, fields, comparisons, three-valued boolean logic,
  arithmetic, strings, collections, records, case/coalesce, null/missing, and
  named versioned calls;
- count/count-distinct, sum, average, minimum, maximum, any, every, ordered
  collect, and ordered first/last;
- logical `sourceOf` and `keyOf` provenance.

Broad semantics use one canonical spelling. There are no public synonyms such
as project/select or agg/aggregate. Physical lookups, indexes, sort-limit fusion,
dependency helpers, raw clauses, and host closures are private.

Writes cover insert, insert-from-query, upsert with explicit conflict policy,
update/delete by explicit base target, replace-all, typed semantic edits,
rekey, move/relocate, conflict resolution, guards, expected basis, affected
counts, and returning.

Exact helper function names and overloads are frozen only by public API contract
tests after the semantic vertical slice. Root-only exports are not a success
metric; exported concepts are.

## Package boundaries

- `@tarstate/core`: portable artifacts, pure evaluator/simulator, generic source
  protocols, commit coordinator, database/observer shell.
- `@tarstate/automerge`: Automerge source/storage bindings, object/conflict/move facts,
  Repo sync/presence relations.
- `@tarstate/zustand`: a deliberately thin, official convenience adapter over
  the generic core protocol. Other stores, including the current Probability
  TanStack Store, may use the core adapter builder without forcing a package per
  store.
- `@tarstate/react`: provider and five small hooks over observers.
- `@tarstate/schema-tools`: dev-only TypeScript, JSON Schema, Markdown, and agent
  capability artifacts.

Intentional package entry points may organize public concepts. Removing subpaths
without reducing concepts is not surface reduction.

## Structured issues

Every expected failure is a value with stable identity and structured fields:

```ts
type Issue = {
  id: string
  code: string
  severity: 'info' | 'warning' | 'error'
  phase:
    | 'resolve'
    | 'load'
    | 'parse'
    | 'query'
    | 'plan'
    | 'constraint'
    | 'commit'
    | 'governance'
    | 'lifecycle'
    | 'presence'
    | 'sync'
  sourceId?: SourceId
  relationId?: RelationId
  key?: LogicalKey
  path?: readonly PortableValue[]
  operationId?: string
  requiredCapabilities?: readonly CapabilityRef[]
  retry?:
    | 'never'
    | 'after_input'
    | 'after_refresh'
    | 'after_capability'
    | 'after_authority'
    | 'query_outcome'
    | 'manual_repair'
  details?: JsonValue
}
```

Localized message text is not identity. Details are authority-redacted. Global
warn/throw diagnostic modes are removed; development logging subscribes to issue
relations.

Issue codes are registered, stable, lowercase namespaced identifiers such as
`transaction.operation_id_ambiguous`; agents never branch on presentation text
or free-form details. Every public code has a machine-readable catalog entry
describing its phase, possible retry classes, and relevant capability fields.

## Conformance gates

Legacy tests may be deleted only after replacement coverage exists for the
semantics they protect:

1. Canonical artifact round-trip, hash mismatch, dependency ambiguity, registry
   fingerprint, duplicate JSON members before materialization, hostile shapes,
   and budgets.
2. Parsing missing/null/custom values, unknown storage preservation, duplicate
   keys, map-key mismatch, and codec failure.
3. Complete value truth tables, aggregate empties, multiplicity, deterministic
   ordering, recursion cycles/budgets, window ties, and cursors across basis and
   membership changes; result keys remain stable across attachment replacement
   but change on proven row reincarnation.
4. Pure query oracle versus incremental maintenance for every operator.
5. Alias/self-join lineage, overlapping bindings, ambiguous derived writes,
   declared-versus-plan footprint bounds, every footprint relation, n-ary merge
   order independence, rekey/ref behavior, and authority-scoped caches.
6. Source transaction statement order, Halloween prevention, stale/exact basis,
   local concurrency, no-op, constraint failure, conflicts, reentrant commits,
   cancellation, operation-epoch rotation/expiry, operation-ID/different-intent
   rejection, receipt-cache eviction, per-statement edit mechanisms/losses, and
   crash-after-handoff receipts.
7. Dirty constraints, parse-induced indeterminate state, concurrent valid peers
   merging invalid, metadata conflict, old executor, repair, and activation.
8. Discovery cycle/alias/missing/denied/stale cases, bootstrap metadata
   absence/collision/conflict/out-of-band override, explicit dataset scoping,
   system-relation schemas, and negative queries over incomplete membership.
9. Automerge concurrent duplicate keys, conflict resolution, copy relocation,
   descendant refs, old-subtree edits, live-state fork repair despite retained
   history, move chains/cycles, and convergence.
10. External-store hydration, middleware, external updates, invalid direct
    mutation, equal-state hydration notification, two databases sharing one
    runtime/subscription, no double revision, and one-notification atomic commits
    for Zustand and TanStack.
11. React cached snapshots, independent shared-maintenance leases, last-close
    collection, basis-only changes, selectors, StrictMode,
    unknown-current versus `lastExact`, invalidation versus removal diffs,
    externally owned lifecycle, optimistic rebase, and supplied SSR hydration.
12. Golden workloads are staged. The initial semantic gate requires executable
    Real Estate, migrated/synthetic Patchpit Ghostscript Tiger, migrated/synthetic
    Probability scene/move plus external-store, leaderboard windows, and v1/v200
    fixtures. Rewritten CljIdle, RealWorld, and collaborative-feed app ports gate
    deletion of their own legacy coverage and broader compatibility claims, not
    the core vertical slice. Fixtures MUST label migrations and synthetic data;
    they cannot claim to describe the current external apps. Patchpit creation
    failure proves source-lifecycle plus partial sequence/orphan receipts.
13. Agent database-description/system-relation discovery, safe query/transaction
    parsing, stable issue-code/retry catalogs, simulation, missing capability
    escalation, authority denial, and structured receipts.
14. Type inference/error fixtures, generated-declaration hash checks, compiler
    budgets, cold/incremental runtime measurements, cache bounds, and full-oracle
    equivalence when change hints are absent, stale, or rejected.
15. Exact capability refs and implication graphs, registry upgrade/downgrade,
    unknown future receipt forwarding, adapter-private move metadata across old
    and native adapters, and identical portable move results apart from the
    honestly reported mechanism/identity guarantees.

## Required spikes before broad implementation

All spikes use the exact portable subset and capability refs in the
[spike wire contract](10-spike-wire-contract.md). Private compiled plans and
source commands may differ; portable evidence may not.

### Pure semantic slice

Implement a temporary or isolated reference evaluator for values/from/where/
select/inner-join/anti-join/aggregate with exact versus incomplete inputs. It
must prove the truth and completeness tables without adapters.

Executable evidence: [pure semantic spike report](spikes/pure-semantic.md).

### Source transaction slice

Implement one in-memory source with two overlapping storage bindings,
simulation, final
constraints, exact basis, operation epoch/ID, and receipt. It must reject ambiguous
footprints and cross-source guards.

Executable evidence: [source transaction spike report](spikes/source-transaction.md).

### Automerge slice

Measure actual Automerge behavior for exact heads, duplicate-key concurrent
insert, conflicted schema metadata, ordinary assignment conflict clearing,
counter/text copying, nested object IDs, fallback relocation, and concurrent
old-subtree edits. Also record peer, connection, sync, and presence event
identity/lifecycle needed to freeze the built-in system-relation schema.
Findings amend capability tiers; they do not weaken them silently.

Executable evidence is recorded in [the Automerge spike report](spikes/automerge.md).
The measured fallback is `copyRelocate`, with a closed loss catalog; it does not
advertise `identityPreservingMove`. Repo event identity and the fallback record
amendments are incorporated into the discovery and move specifications.

### External-store slice

Adapt one Zustand and the current Probability TanStack store through the generic
protocol. Prove hydration state, external subscription, atomic updater, actions
preservation, and one coherent notification.

Executable evidence: [external-store spike report](spikes/external-store.md).

### Lens slice

Execute the complete v1/v200 trace, including unknown fields, changed key/ref,
newer constraints, lossy reverse rejection, and ambiguous paths.

Executable evidence: [schema lens spike report](spikes/lens.md).

All five required slices have executable evidence as of 2026-07-10. The
Automerge evidence amended the fallback preservation and Repo identity claims;
the other four slices found no normative contradiction. This satisfies the
pre-broad-implementation spike gate, not the broader conformance gates above.

## Build order after spikes

1. Portable value/canonical artifact parser and structured issues.
2. Schema, codec, relation identity, and explicit lens subset.
3. Pure query oracle and golden algebra.
4. Transaction evaluator, constraints, receipts, and in-memory source.
5. Resolver, membership, source lifecycle, attachments, commit coordinator, and
   observers using full recomputation.
6. Generic external-store adapters, then Automerge source/bindings and move
   tiers.
7. Differential incremental maintenance.
8. React.
9. Schema/agent tooling and all golden end-to-end fixtures.

Production implementation is ready to broaden only after all five slices have
executable evidence and this packet is amended with any contradictions they
discover.
