# Direction And Progress Tracking

This document is intentionally not a fixed roadmap. Tarstate is still early
enough that committing to an exact implementation sequence would create false
certainty.

Use this document to track what is known, what is still a design question, and
what evidence would let us promote an API from experimental to stable.

## Current Position

Tarstate is currently a relational query and derivation layer for JSON-shaped
application state. `@tarstate/react` is the idiomatic React entrypoint; Automerge
is an API-surface consumer example for now.

That framing should hold until the runtime contracts are proven. In particular,
avoid claiming that Tarstate is a complete state management system, reactive
database, constraint engine, or materialized-view engine until those semantics
exist and are documented.

## Maturity Labels

Use these labels when discussing public APIs:

- **Declared**: typed API/data shape exists, but runtime behavior is absent or
  intentionally unsupported.
- **Naive**: runtime behavior works for the documented contract, but may scan,
  recompute, or use simple in-memory structures.
- **Stable**: API contract is documented, tested, and suitable for external
  consumers.
- **Optimized**: stable behavior has benchmark coverage and targeted planner,
  index, materialization, or adapter optimizations.

An API should not be marketed as a product feature until it is at least
**Stable**.

## Readiness Signals

These are signals that Tarstate is approaching a first serious release. They are
not an ordered checklist.

- Public package paths have documented status and no accidental internals.
- Stable APIs do not silently no-op or hide unsupported behavior.
- Transaction semantics are explicit and tested.
- Constraint behavior is either enforced or clearly scoped as advisory.
- React onboarding starts at `@tarstate/react`, with core docs reserved for the
  generic schema/query/source/write contracts.
- At least one external-state source or adapter pattern is documented and
  benchmarked.
- Watch/change tracking has a correct baseline behavior if it is presented as a
  supported feature.
- Materialization has a clear identity, lifecycle, and invalidation story before
  it is presented as a supported feature.
- Benchmarks cover the paths that materially influence API shape.
- The docs tell new developers where to start without overclaiming runtime
  guarantees.

## Open Decision Areas

The following areas need exploration before they should harden into a plan.

### Transactions

Current state:

- `tryTransact` stages object-backed write patches and commits only when the
  batch has no diagnostics.
- `transact` wraps `tryTransact` and throws on diagnostics.
- Public write constructors include `insert`, `insertIgnore`, `update`,
  `upsert`, `insertOrReplace`, `insertOrMerge`/`insertOrUpdate`, `delete`,
  `deleteExact`, and `replaceAll`.
- `q`, `qMany`, `row`, `exists`, and `whatIf` provide Relic-style read
  conveniences for the object-backed runtime, including named query batches.
  `q`, `qMany`, and `whatIf` can apply post-evaluation `mapRows` result
  shaping while preserving diagnostics; this is not a query planner,
  transducer, or collection protocol.
- `@tarstate/core/constraints` provides `tryTransactConstrained` and
  `transactConstrained` for committing object-backed writes only when both the
  staged write batch and explicit constraint set validate.
- Lower-level object-backed `applyWrites` is partial; `applyWritesAtomic` is
  all-or-nothing for mutable object-backed data. These live behind the explicit
  `@tarstate/core/write-apply` subpath.
- Committed write/transaction results include raw relation deltas.

Open questions:

- Should adapter-backed writes share the same transaction result type?
- What diagnostic shape is stable enough for external callers?

Evidence to gather:

- Tests that expose multi-patch failure behavior.
- Example adapter writes that show whether partial application is useful or
  harmful.
- Developer ergonomics from small app/demo usage.

### Expressions

Current state:

- Query expressions support field refs, literal values, tuples, aggregate calls,
  and named runtime calls.
- `evaluate` accepts custom named runtime functions through evaluator options.

Open questions:

- Should unknown named calls remain diagnostics or become typed unsupported
  values?
- Should expression functions also be attachable to DB/adapters, or should
  evaluator options remain the only registration point?
- Which functions must be serializable for adapter/materialization support?

Evidence to gather:

- Real queries from demos and adapter examples.
- More real-world expression examples from demos and adapter consumers.
- Existing tests cover unsupported expression behavior in projection, sort,
  aggregate, and lookup positions.
- Benchmark impact of expression dispatch if it becomes hot.

### Constraints

Current state:

- `check`, `req`, `fk`, `unique`, and `constrain` are descriptors.
- `validateConstraints` can scan a source for `req`, `unique`, `fk`, and
  query-bound `check`.
- Object-backed constrained transactions can enforce explicit constraint sets.
- Unbound `check` validation is explicitly unsupported until checks carry enough
  relation/query context.

Open questions:

- Where do constraints attach: schema, DB, transaction call, materialized query,
  or separate registry?
- Are constraints rejecting writes, producing advisory diagnostics, or both?
- Which constraint types should be relation-local versus query-level?

Evidence to gather:

- Small examples that need `unique` and `fk`.
- Diagnostics consumers can actually act on.
- Interaction between constraint failures and transaction atomicity.

### External Adapters

Current state:

- `RelationSource` is the read-only boundary.
- `RelationSource.lookup` is an optional equality lookup hook; evaluators fall
  back to scans when a lookup is unsupported.
- `RelationSource.rangeLookup` is an optional range lookup hook for
  btree-declared literal filters; evaluators fall back to scans when a range
  lookup is unsupported.
- `RelationSource.version` is an optional opaque source snapshot identity.
- `RelationRuntime` in `@tarstate/core/adapter` is the write-capable boundary:
  a source, optional patch target, optional read-consistent `snapshot()`, and
  optional invalidation `subscribe()`.
- `RelationAdapter` remains the durable compatibility shape: a runtime plus
  `commit(patches)` returning commit status, committed/applied counts, relation
  deltas, diagnostics, and optional post-commit version identity. Adapters may
  additionally expose `target.apply` when the same durable commit path can be
  used through generic runtime composition.
- Apply/commit `status` is the authoritative outcome: rejected attempts have no
  reflected patch effects, while partial attempts report only reflected
  deltas/version and diagnostics for rejected effects.
- `tryApplyRelationPatches`, `tryCommitAdapter`, and `composeRelationRuntimes`
  normalize envelopes, rejected-result invariants, source identity, routing, and
  missing version fallback; they do not validate adapter-owned business
  semantics.
- Object-backed DB/write helpers exist for local use and tests.
- `createMemoryRelationRuntime` provides a non-durable object-backed
  `RelationRuntime` for local state and adapter contract tests.
- `@tarstate/core/delta` is the change boundary for adapters that can translate
  host changes into relation added/removed rows.

Open questions:

- Which adapters can provide cheap, stable snapshot/version identity?
- Which external stores should expose only `RelationSource`, which should expose
  `RelationRuntime` targets, and which should implement full durable
  `RelationAdapter` commits?
- Should write patch translation helpers live in adapter packages while core
  owns only the `WritePatch`, `RelationRuntime`, and `RelationAdapter`
  contracts?
- What lookup/index promises can adapters make without leaking internals?
- Which adapters can commit atomically, partially, or only reject unsupported
  patches, and how should that be documented?
- Should adapters produce deltas from their native patch streams, keyed relation
  diffs, or both?

Evidence to gather:

- Keep `@tarstate/automerge` outside `@tarstate/core` as an API-surface consumer
  example. Current package coverage uses real Automerge documents for heads,
  map row extraction, equality/range lookup, adapter commits, `deleteExact`,
  `replaceAll`, relation deltas, and atomic rejection; deeper native change to
  relation-delta translation should happen only where it clarifies generic
  contracts.
- More benchmarks that compare native adapter extraction cost, indexed lookup
  cost, and Tarstate evaluation cost. Automerge benchmark coverage remains a gap
  until benchmark lanes use `@tarstate/automerge` and real
  `@automerge/automerge` documents outside `@tarstate/core`.
- A tiny non-Automerge existing-state `RelationSource` example kept current
  with `lookup`, `rangeLookup`, and write-adapter boundaries.

### Watch And Change Tracking

Current state:

- Query data can report relation dependencies, which gives watch and
  materialization a coarse invalidation boundary before narrow incremental
  maintenance is considered.
- `diffQuery` computes a one-shot before/after query result diff with query key
  and optional before/after source versions.
- `watch` is a manual refresh/recompute handle, not automatic source
  observation or an async stream. It can refresh query/relation targets over
  object-backed DBs or `RelationSource`s and deliver full-row
  added/removed/unchanged diffs plus experimental keyed `rowChanges`.
  `subscribeWatch` adds callback fan-out to an existing watch, but callbacks
  fire only when `refresh()` or a real tracked-change path emits an event.
- `watchRuntime` bridges a `RelationRuntime.subscribe` host invalidation into a
  normal watch refresh against `runtime.snapshot?.().source ?? runtime.source`.
  It does not synthesize relation deltas or expose an async stream.
- `trackTransact` lives in `@tarstate/core/runtime`, composes readable
  DB/source transactions with watch refresh and materialization maintenance, and
  returns recompute-backed changes for watched query/relation targets.
- `trackRuntimeCommit` applies patches through a `RelationRuntime` or
  `RelationAdapter`, then maintains materializations and reports watched
  changes from the real apply/commit result. Rejected commits do not maintain or
  emit changes, and missing deltas force recompute rather than fake deltas.
- When relation deltas are available, tracked transactions use query
  dependencies to skip watches that cannot be affected before recomputing rows.

Open questions:

- What is row identity for query results?
- Should diffs report added/deleted rows, row keys, patch-like deltas, or
  relation/query-specific change records?
- Should current refresh/tracked-change/runtime callback delivery grow into
  async streams, adapter-fed relation-delta observation, or a separate host
  integration contract?
- How should recompute-backed `trackTransact` promote to incremental
  maintenance without changing its public result shape?

Evidence to gather:

- Naive before/after query diff experiments.
- UI/demo integration that consumes diffs.
- Benchmarks showing where recomputation becomes too expensive.

### Materialization

Current state:

- `mat` is the async shorthand for `materializeSnapshot`.
- `materializeSnapshot` can cache one-shot rows readable by materialization id or
  query key.
- `snapshotIndex` can expose cached snapshot rows as a set index and reports
  explicit diagnostics when a materialization is missing.
- `snapshotHashIndex` can build read-only hash lookup maps derived from cached
  snapshot rows; these lookup maps are not operator-maintained indexes.
- `refreshMaterializationSnapshot` can recompute an existing snapshot by id,
  metadata, or structural query key.
- `maintainMaterializationSnapshots` can carry snapshot materializations onto a
  new DB/source object by recomputing them.
- When relation deltas are supplied, snapshot maintenance can carry unaffected
  cached rows forward using query dependencies instead of recomputing them.
- Opt-in incremental maintenance can update cached rows from `RelationDelta` for
  a narrow single-relation subset: `from`, optional single-field `hash`,
  optional pure base-field predicates (`eq`/`neq`/`lt`/`lte`/`gt`/`gte` against
  literal/env/tuple values, composed with `and`/`or`/`not`), and simple
  `project`/`extend`/`without`/`rename`/`qualify` transforms. A terminal
  `aggregate` over the same base/filter subset can also be maintained when every
  aggregate is plain `count()`, `sum(expr)`, `min(expr)`, or `max(expr)` and
  grouped keys are simple field/literal/tuple projections.
- `@tarstate/react` `createDbStore` uses delta-backed snapshot maintenance after
  committed object-backed DB writes.
- React source/runtime/adapter stores maintain existing materializations only
  after reflected commits. They should recompute conservatively unless source
  order semantics are explicit.
- Host-driven refresh/subscribe invalidations refresh snapshots and revisions;
  they do not automatically maintain materializations unless the store path
  explicitly does so.
- Materialization metadata records a structural `queryKey`.
- Snapshot rows are read by materialization id or structural query key; display
  names are metadata only.
- `hash` and `btree` can declare index intent in query data. A single-field
  `hash(from(...))` can participate in simple equality lookup planning, but
  `btree(from(...))` can participate in simple literal range filter planning
  when a source exposes `RelationSource.rangeLookup`.
- Joins, field-to-field predicates, subqueries, unsupported aggregate
  shapes/options, ordering, limits, custom calls, and unsupported btree shapes
  still fall back to recompute with explicit unsupported incremental
  diagnostics. Unsafe extrema removals and other ambiguous supported delta
  batches fall back to recompute with advisory fallback diagnostics.

Open questions:

- Is `queryKey` sufficient for equivalent queries, or do future planner rewrites
  need canonicalization beyond structural query data?
- Is a materialized query a cache, a relation-like value, or both?
- Who owns materialized memory and lifecycle?
- What source versioning is required to invalidate safely?
- Which transaction paths should automatically call recompute-backed snapshot
  maintenance, and which should stay low-level?

Evidence to gather:

- Benchmarks showing which query shapes need caching or indexes.
- Watch/change-tracking experiments, because they may share invalidation logic.
- Adapter examples with explicit snapshot identities.

## Benchmarking Principle

Benchmarks should guide decomposition, not justify abstractions after the fact.

Useful benchmark lanes:

- row extraction from an external state source,
- one-shot query evaluation,
- join/filter lookup versus scan,
- aggregate recomputation,
- write patch application,
- end-to-end update to derived view.

Record benchmark output when changing planner, index, materialization, adapter,
or query runtime behavior. Do not add those abstractions without either a
correctness contract or a measured bottleneck.

## Tracking Practice

For each area of work, prefer a short note that records:

- the question being answered,
- the current API status label,
- the evidence gathered,
- the behavior tests added,
- any benchmark result that influenced the decision,
- whether the public docs need to change.

This keeps progress visible without pretending the full route is known.
