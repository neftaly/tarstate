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

The near-term stabilization path is schema, query, write, source, adapter, DB,
and React consumption APIs. Constraints, materialization, watch, and runtime
orchestration remain experimental until their diagnostics, lifecycle, and
fallback semantics are proven.

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
- **Stabilizing**: intended public path; changes should be conservative and
  documented, but release evidence is still being gathered.
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
- The stabilizing API path is clear: schema, query, write, source, adapter, DB,
  and React consumption.
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
- Public write constructors include `insert`, `insertIgnore`, `insertOrReplace`,
  key-scoped `updateByKey`/`deleteByKey`, predicate `update`/`delete`,
  compatibility predicate aliases `updateWhere`/`deleteWhere`,
  `insertOrMerge`, `insertOrUpdate`, `deleteExact`, and `replaceAll`.
  `insertOrReplace(row)` fully replaces an existing row or inserts when missing,
  `insertOrMerge(row, { merge })` merges provided, all, or selected row fields
  into an existing row or inserts when missing, while
  `insertOrUpdate(row, { update })` emits the explicit insert-or-update
  constant set-map descriptor. Computed update expressions need a future
  explicit API instead of overloading stable `WritePatch`.
- `tryTransact` and `transact` accept one or more patch/callback inputs while
  keeping the object-backed transaction all-or-nothing.
- `q`, `qRows`, `qMany`, `qManyRows`, `row`, `exists`, and `whatIf` provide
  Relic-style read conveniences for the object-backed runtime, including named
  query batches. `qRows` and `qManyRows` return only rows for callers that do
  not need the diagnostics envelope. `q`, `qMany`, and `whatIf` can apply
  post-evaluation `mapRows` result shaping while preserving diagnostics; this is
  not a query planner, transducer, or collection protocol.
- `dbUpdateWhere` and `dbDeleteWhere` provide DB-facing keyed/predicate helper
  names; explicit insert-or-update writes use `insertOrUpdate(row, { update })`
  from `@tarstate/core/write`.
- `stripMeta(db)` exposes the normalized row data from a `Db`, and passes
  through non-`Db` values. It is a plain object-backed helper, not a metadata
  reconciliation layer for materialization/watch/constraint lifecycle state.
- `@tarstate/core/experimental/constraints` provides `tryTransactConstrained` and
  `transactConstrained` for committing object-backed writes only when both the
  staged write batch and explicit constraint set validate.
- Lower-level object-backed `applyWrites` is partial; `applyWritesAtomic` is
  all-or-nothing for mutable object-backed data. These live behind the explicit
  `@tarstate/core/experimental/write-apply` subpath.
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
- `evaluate` accepts custom named evaluator functions through evaluate options.

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
- `validateConstraints` can scan a source for relation-bound `req`, `unique`,
  `fk`, and query-bound `check`.
- Query-bound `req`, `unique`, and `fk` constraints are descriptor-only stubs
  that return unsupported diagnostics until query/materialized constraint
  enforcement is implemented.
- Object-backed constrained transactions can enforce explicit constraint sets.
- Unbound `check` validation is explicitly unsupported until checks carry enough
  relation/query context.
- This remains an experimental, diagnostic-backed surface; adapter enforcement,
  attachment, and lifecycle are not stable contracts yet.

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
- `RelationPatchTarget` can declare writable relation ownership with
  `relationNames` or `ownsRelation`. `composeRelationRuntimes` routes writes
  through that target-owned metadata first, and uses read-side
  `source.relationNames` only as a compatibility fallback when target ownership
  is unknown.
- `RelationAdapter` remains the durable compatibility shape: a runtime plus
  `commit(patches)` returning `accepted`/`partial`/`rejected` status,
  applied counts, relation deltas, diagnostics, and optional post-commit version
  identity. Adapters may
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
- `RelationDelta` from `@tarstate/core/adapter` is the stable change-report
  boundary for adapters that can translate host changes into relation
  added/removed rows.

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
  contracts. The map adapter is a raw-document `map-v1` surface; Repo handle
  integration should wrap `setDoc`/`subscribe` instead of merging handle
  semantics into the map adapter API.
- Automerge adapter and presence targets declare writable ownership with
  `ownsRelation`; write routing should not infer Automerge ownership from
  read-side relation exposure alone. Presence without `localPeerId` is read-only
  and omits `target`.
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
- Query aliases now cover the compatibility names expected by the public
  surface: `dependencies`, `rowKeyFields`, `uniqueIndex`, and `qualifyRow`;
  aggregate grouping uses `aggregate({ groupBy, aggregates })`, and aggregate
  helpers use their canonical names (`countDistinct`, `avg`, `notAny`, and
  `setConcat`).
- `diffQuery` computes a one-shot before/after query result diff with query key
  and optional before/after source versions.
- `watch` is a manual refresh/recompute handle, not automatic source
  observation or an async stream. It can refresh query/relation targets over
  object-backed DBs or `RelationSource`s and deliver full-row
  added/removed/unchanged diffs plus experimental keyed `rowChanges`.
  `subscribeWatch` adds callback fan-out to an existing watch, but callbacks
  fire only when `refresh()` or a real tracked-change path emits an event.
- Query results can declare top-level output row identity with `keyBy(...)`.
  Diffs and watch refreshes use that metadata only when explicit row-key options
  are not supplied; missing or duplicate keys surface diagnostics and fall back
  structurally.
- `watchRuntime` bridges a `RelationRuntime.subscribe` host invalidation into a
  normal watch refresh against `runtime.snapshot?.().source ?? runtime.source`.
  It does not synthesize relation deltas or expose an async stream.
- `watchTarget`/`unwatchTarget` are Relic-style target registration facades over
  the same watch registry, and `watchChangeMap` projects tracked changes by
  watched target identity.
- `trackTransact` lives in `@tarstate/core/experimental/runtime`, composes readable
  DB/source transactions with watch refresh and materialization maintenance, and
  returns recompute-backed changes for watched query/relation targets.
- `trackTransactPatches` exposes the patch-planning half of object-backed
  tracked transactions for callers that need planned patches and diagnostics
  before committing.
- `trackRuntimeCommit` applies patches through a `RelationRuntime` or
  `RelationAdapter`, then maintains materializations and reports watched
  changes from the real apply/commit result. Rejected commits do not maintain or
  emit changes, and missing deltas force recompute rather than fake deltas.
- Direct relation watch targets can derive tracked `rowChanges` from one
  matching validated `RelationDelta`; ambiguous, invalid, or inconsistent
  deltas fall back to recompute.
- When relation deltas are available, tracked transactions use query
  dependencies to skip watches that cannot be affected before recomputing rows.

Open questions:

- How far should query-owned row identity go beyond top-level `keyBy(...)`
  fields?
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

- Materialization is an experimental snapshot cache. Partial incremental view
  maintenance (IVM) is an opportunistic optimization behind those snapshots, not
  a general public IVM API or product identity.
- `mat` is the async shorthand for `materializeSnapshot`.
- `materializeSnapshot` can cache one-shot rows readable by materialization id or
  query key.
- `readMaterializedQuery` can read cached rows for an exact structural query key
  when the cached source version matches the current source version; it reports
  explicit miss, stale, missing-row, or unknown-version diagnostics and does not
  recompute.
- `index` exposes cached snapshot rows through a Relic-shaped compatibility
  facade: set rows by default, or a read-only hash lookup with
  `{ kind: 'hash', field }`. Requests for `{ kind: 'btree' }` or
  `{ kind: 'unique' }` return explicit unsupported result families. The shape is
  for compatibility with Relic-style call sites; it does not provide Relic
  operator-maintained `hash`, `btree`, or `unique` semantics.
- `snapshotIndex` and `snapshotHashIndex` remain available as explicit helper
  names; these lookup maps are not operator-maintained indexes.
- `refreshMaterializationSnapshot` can recompute an existing snapshot by id,
  metadata, or structural query key.
- `maintainMaterializationSnapshots` can carry snapshot materializations onto a
  new DB/source object by recomputing them.
- When relation deltas are supplied, snapshot maintenance can carry unaffected
  cached rows forward using query dependencies instead of recomputing them.
- Opt-in incremental maintenance can update cached rows from `RelationDelta` for
  a narrow single-relation subset: `from`, optional single-field `hash`,
  optional pure base-field predicates (`eq`/`neq`/`lt`/`lte`/`gt`/`gte` against
  literal/env/tuple values, composed with `and`/`or`/`not`), simple
  `project`/`extend`/`without`/`rename`/`qualify` transforms, and optional final
  field/literal/tuple `sort(...)`, terminal `limit(...)`, or terminal
  `sortLimit(...)`. Affected final ordered/windowed snapshots rebuild from
  current source rows inside the incremental maintenance path rather than using
  row-splice ordering. A terminal `aggregate` over the same base/filter
  subset can also be maintained when every aggregate is `count()`, `count(expr)`,
  `sum(expr)`, `min(expr)`, `max(expr)`, `any(expr)`, `notAny(expr)`, or
  `avg(expr)` with matching visible `sum(expr)`/`count(expr)` fields over a
  non-null numeric base field or numeric literal, and grouped keys are simple
  field/literal/tuple projections.
- Simple inner/left equality joins over base relations can also be maintained
  incrementally, including optional side-local `hash`/`where` filters. Raw inner
  joined rows reuse cached relation-key pair identity; filtered sides, left
  joins, and joined queries with simple output transforms rebuild joined rows
  from validated current source rows.
- `@tarstate/react` evaluates hooks against captured source snapshots and keeps
  materialized-query read-through outside the stable React API.
- React commit results expose stable status/reflected/effects/snapshot fields;
  watch-change envelopes and materialization maintenance stay in experimental
  core surfaces.
- Materialization metadata records a structural `queryKey`.
- Snapshot rows are read by materialization id or structural query key; display
  names are metadata only.
- `hash` and `btree` can declare index intent in query data. A single-field
  `hash(from(...))` can participate in simple equality lookup planning, but
  `btree(from(...))` can participate in simple literal range filter planning
  when a source exposes `RelationSource.rangeLookup`.
- Non-equality/self joins, join-side output transforms,
  field-to-field predicates outside the raw join slice, subqueries, unsupported
  aggregate shapes/options, non-final ordering/windows, custom calls, and
  unsupported btree shapes still fall back to recompute with explicit
  unsupported incremental diagnostics. Unsafe extrema removals, unsafe join
  removals, and other
  ambiguous supported delta batches fall back to recompute with advisory fallback
  diagnostics.

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

## Tests To Rip Next

The next cleanup pass should remove or rewrite tests that lock in implementation
details instead of public contracts:

- Object-backed write tests that assert private patch expansion details instead
  of `WritePatch`, `Db` transaction, or adapter apply/commit results.
- Materialization tests coupled to private incremental planner branches rather
  than public diagnostics, cached rows, and set/hash/unsupported index result
  families.
- Watch/runtime tests that inspect registry internals instead of
  `watchTarget`, `unwatchTarget`, `watchChangeMap`, `trackTransact`, or
  `trackTransactPatches` outputs.
- Constraint tests that expect query-bound `req`/`unique`/`fk` enforcement
  before those descriptors graduate from unsupported stubs.

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
