# Developer Onboarding

Tarstate is currently best described as a relational query and derivation layer
for JSON-shaped application state. It should stay a relational/lens-style state
layer, not a full database, a full opinionated application state manager, or a
general bidirectional lens/view putback system.

Track release progress in [roadmap.md](roadmap.md). That document defines
maturity labels, open decision areas, and readiness signals without committing
to a fixed implementation sequence.

The opinionated part is the data model: keep essential state normalized in
relations, express derived state as queries, and route writes through typed
patches. Tarstate should not own rendering, storage, networking, scheduling, or
document sync. Those belong in adapters and consumers.

Near-term API stabilization should center on schema, query, write, source,
adapter, DB, store, and React consumption APIs. The app-facing core path should
be `createStore(seedRows)`, `store.query(query)`, `store.view(query)`, and
non-throwing `store.commit(patches)`. Constraints, materialization, watch, and
runtime orchestration remain experimental, diagnostic-backed surfaces behind
that facade where possible.
Incremental view maintenance (IVM) is only an opportunistic optimization behind
materialized snapshots, not Tarstate's product identity or a general public API.

## Current API Status

| Public path | Status | Notes |
| --- | --- | --- |
| `@tarstate/core/schema` | Stabilizing API | Typed relation and field metadata. This is part of the intended stable modeling path. |
| `@tarstate/core/query` | Stabilizing API | Builds inspectable relational programs, including explicit lookup, hash/btree index declarations, query-only `uniqueIndex` metadata, joins, projection, `qualifyRow`, query-owned result identity through `keyBy`/`rowKeyFields`, nested collection expansion, sort/limit, set ops, expression calls, literal rows, relation dependency analysis through `dependencies`, query keys, `aggregate({ groupBy, aggregates })`, and aggregate helpers such as `countDistinct`, `avg`, `notAny`, and `setConcat`. |
| `@tarstate/core/evaluate` | Stabilizing contract, naive runtime | One-shot in-memory evaluation. Uses arrays recursively; explicit lookups and simple equality filters/joins can route through `RelationSource.lookup`, and simple btree-declared range filters can route through `RelationSource.rangeLookup`, otherwise evaluation scans. |
| `@tarstate/core/source` | Stabilizing read-only adapter boundary | Read-only relation contract: `rows`, optional equality `lookup`, optional range `rangeLookup`, optional opaque `version`, optional diagnostics, plus helpers for object row maps and composed sources. Runtime surfaces adapt object-backed DB shapes internally rather than making indexed fixture sources part of the stable source contract. |
| `@tarstate/core/adapter` | Stabilizing write-capable runtime boundary | Generic runtime contract: `source`, optional patch `target`, optional read-consistent `snapshot()`, optional `subscribe`, `accepted`/`partial`/`rejected` apply/commit status, applied counts, relation deltas, diagnostics, and optional version identity. Patch targets can declare write ownership with `target.relationNames` or `target.ownsRelation`; composed runtimes use that target metadata before falling back to read-side `source.relationNames` for compatibility routing. `RelationAdapter.commit(patches)` remains the durable compatibility shape and returns the same result envelope as target `apply`; `tryApplyRelationPatches`, `tryCommitAdapter`, and `composeRelationRuntimes` are the normalization and composition helpers. The root convenience barrel also exports `createMemoryRelationRuntime` for small non-durable examples and tests. |
| `@tarstate/core/experimental/delta` | Experimental delta helpers | Immutable relation-delta helpers for adapter-produced added/removed row batches; the stable `RelationDelta` type is exported from `@tarstate/core/adapter`, and mutable write accumulators stay internal to the object-backed apply engine. |
| `@tarstate/core/experimental/identity` | Functional identity primitive | Stable structural value canonicalization used by query keys, set operations, distinct aggregates, and row diffs. |
| `@tarstate/core/experimental/diff` | Functional change primitive | Structural row-keying and row-diff helpers shared by query diffing, manual watch refresh, and tracked transactions, including experimental keyed `rowChanges`. |
| `@tarstate/core/experimental/indexed-source` | Experimental fixture/source helper | `fromIndexedObjectSource` builds object sources with equality and primitive range lookup support. This remains a test/prototype helper; production adapters should own index policy. |
| `@tarstate/core/write` | Stabilizing patch API | Typed `insert`, `insertIgnore`, `insertOrReplace`, key-scoped `updateByKey`/`deleteByKey`, predicate `update`/`delete`, compatibility predicate aliases `updateWhere`/`deleteWhere`, `insertOrMerge`, `insertOrUpdate`, `deleteExact`, and `replaceAll` patch constructors. `insertOrReplace(row)` fully replaces an existing row or inserts when missing; `insertOrMerge(row, { merge })` merges provided, all, or selected row fields into an existing row or inserts when missing; `insertOrUpdate(row, { update })` is the explicit constant set-map insert-or-update descriptor. Computed update expressions are intentionally not part of stable `WritePatch` yet. |
| `@tarstate/core/experimental/write-apply` | Functional object runtime support | Object-backed `applyWrites` and `applyWritesAtomic` helpers for runtimes and adapters that explicitly stage mutable relation arrays. |
| `@tarstate/core/db` | Stabilizing object runtime | `createDb`, `stripMeta`, `q`, `qRows`, `qMany`, `qManyRows`, `row`, `exists`, `whatIf`, `tryTransact`, and `transact` for prototypes, tests, and small object-backed runtimes, plus DB-facing patch helpers `dbUpdateWhere` and `dbDeleteWhere`; use `insertOrUpdate(row, { update })` from `@tarstate/core/write` for explicit insert-or-update writes. `q` and `whatIf` accept a single query or a named query batch; `qRows`/`qManyRows` are row-only conveniences for callers that do not need the diagnostics envelope. `stripMeta(db)` returns the normalized relation row data and passes through non-`Db` values. `q`, `qMany`, and `whatIf` can apply post-evaluation `mapRows` result shaping while preserving diagnostics; this is not a query planner, transducer, or collection protocol. `tryTransact`/`transact` accept one or more patch/callback inputs, remain all-or-nothing, and committed results include relation deltas. |
| `@tarstate/core/store` | Stabilizing app facade | `createStore` wraps the object-backed DB runtime with `query`, `queries`, `view`, non-throwing `commit`, revisioned snapshots, and subscriptions. `commit.status` is `accepted`/`partial`/`rejected`; `reflected` only reports whether row effects reached the backing store. Lower-level counts, deltas, and durability live under `commit.effects`; watch-change envelopes and materialized snapshot caches remain experimental internals. `view(query)` is the preferred derived-state API, not a separate materialization API. |
| `@tarstate/core/experimental/constraints` | Experimental diagnostic-backed validation/enforcement | `check`, `req`, `fk`, `unique`, and `constrain` build descriptors. `validateConstraints` can scan a source for relation-bound `req`, `unique`, `fk`, and query-bound `check`; query-bound `req`/`unique`/`fk` are descriptor-only stubs that return unsupported diagnostics until materialized constraint enforcement exists. `tryTransactConstrained` and `transactConstrained` can reject object-backed writes; unbound `check` remains explicitly unsupported. Attachment, adapter enforcement, and lifecycle are still open. |
| `@tarstate/core/experimental/materialization` | Experimental diagnostic-backed snapshot cache | `mat` is the async snapshot materialization shorthand for `materializeSnapshot`; both cache one-shot rows readable by id or query key. `readMaterializedQuery` reads cached rows for an exact structural query key only when the source version can be verified current; misses, stale versions, and metadata without rows return explicit diagnostics instead of recomputing. `demat` removes metadata and cached snapshot rows. `materializedSourceFor` exposes cached rows as one read-only `RelationSource` relation; Relic-shaped `index` exposes cached snapshot rows as a set index by default or a hash lookup with `{ kind: 'hash', field }`, while `{ kind: 'btree' }` and `{ kind: 'unique' }` return explicit unsupported index result families. `snapshotIndex`/`snapshotHashIndex` remain explicit helpers, and none of these helpers is an operator-maintained index, view putback surface, or general IVM API. `refreshMaterializationSnapshot` can recompute an existing snapshot, and `maintainMaterializationSnapshots` can carry snapshots onto a new DB/source object, skipping unaffected snapshots when relation deltas are supplied. Opt-in incremental maintenance is limited to single-relation pure-filter/project/extend-style queries with optional final field/literal/tuple `sort(...)`, `limit(...)`, or `sortLimit(...)` maintained by source-row rebuild, simple inner/left equality joins over base relations with optional side `hash`/`where` filters and output transforms, and a narrow aggregate subset with `count()`, `count(expr)`, `sum(expr)`, `min(expr)`, `max(expr)`, `any(expr)`, `notAny(expr)`, and `avg(expr)` only when matching visible `sum(expr)`/`count(expr)` fields are present over a non-null numeric base field or numeric literal; unsupported shapes/options, join-side output transforms, non-final row windows, and unsafe aggregate or join removals keep explicit diagnostics and recompute fallback. |
| `@tarstate/core/memory-runtime` | Functional local runtime | `createMemoryRelationRuntime` exposes object-backed rows through the same `RelationRuntime` source/target contract used by durable and presence adapters. It is for tests, local state, and adapter prototyping; accepted row-changing writes report `durability: 'memory'` and increment a numeric source version. |
| `@tarstate/core/experimental/watch` | Experimental diagnostic-backed diff surface | `diffQuery` can compute a one-shot before/after query result diff with query key and source version identity. `watch` is a manual refresh/recompute handle, not an async stream; each refresh can deliver full-row diffs plus experimental keyed `rowChanges`, using query-owned `keyBy` fields when present. `subscribeWatch` adds callback fan-out to an existing watch, `watchTarget`/`unwatchTarget` provide Relic-style target registration, `watchChangeMap` projects tracked changes by target identity, direct relation targets can derive tracked `rowChanges` from validated real relation deltas, and `watchRuntime` bridges `RelationRuntime.subscribe` host invalidations into normal watch refreshes without synthesizing deltas. |
| `@tarstate/core/experimental/runtime` | Experimental diagnostic-backed orchestration surface | `trackTransact` can run readable DB/source transactions, maintain snapshot materializations, and return recompute-backed changes for watched targets without making watch registration own transaction semantics. `trackTransactPatches` exposes the patch-planning half of that path for callers that need planned object-backed writes without committing them. `trackRuntimeCommit` applies patches through a `RelationRuntime`/`RelationAdapter`, then maintains materializations and delivers watched changes from reported commit/apply results without inventing deltas. |
| `@tarstate/react` | Stabilizing React consumption API | Idiomatic React package with `TarstateProvider`, revisioned external-store snapshots, prefixed hooks (`useTarstateQuery`, `useTarstateQueries`, `useTarstateCommit`) plus short aliases, and store constructors for object-backed DBs, read-only sources, runtimes, and write-capable adapters. The provider, hooks, store constructors, and commit path are the intended React API; constraint enforcement, materialized-query read-through, and watch-change envelopes remain experimental core internals outside the React API shape. |
| `@tarstate/automerge` / `@tarstate/automerge/presence` | Experimental API-surface consumer example | Automerge-backed consumers used to pressure-test durable map storage, presence runtimes, `RelationSource`, `RelationAdapter`, write patches, version identity, and relation deltas. The root map adapter is a low-level raw-document `map-v1` surface with `setDoc`/`subscribe`; Repo Presence is split to its own subpath and is write-capable only when `localPeerId` is supplied. Treat both packages as example integrations for now, not the central product direction. |

Examples and onboarding should import from taxonomy subpaths such as
`@tarstate/core/schema`, `@tarstate/core/query`, `@tarstate/core/source`,
`@tarstate/core/adapter`, `@tarstate/core/write`, and
`@tarstate/core/store`. The root barrel
`@tarstate/core` remains available as a convenience export, but it should not be
the default teaching path.

Functional but intentionally simple:

- `aggregate` evaluation is currently in-memory. Incremental materialization can
  maintain a narrow terminal aggregate subset with `count()`, `count(expr)`,
  `sum(expr)`, `min(expr)`, `max(expr)`, `any(expr)`, `notAny(expr)`, and
  `avg(expr)` only when matching visible `sum(expr)`/`count(expr)` fields are
  present over a non-null numeric base field or numeric literal; unsupported
  aggregate options and unsafe aggregate removals fall back to recompute with
  diagnostics.
- `hash` and `btree` are query-level index declarations. A single-field
  `hash(from(...))` can help the one-shot evaluator plan simple equality
  filters and joins against `RelationSource.lookup`; a single-field
  `btree(from(...))` can plan simple literal range filters against optional
  `RelationSource.rangeLookup`. `uniqueIndex` is query metadata only; uniqueness
  validation remains a constraint concern, not a query index guarantee.
- `keyBy` is query-owned result identity metadata. It does not change evaluated
  rows; `rowKeyFields` can inspect propagated key fields, and diff/watch surfaces
  use that metadata only when no explicit key options are passed.
- Incremental materialization currently accepts only one base relation with an
  optional single-field `hash`, optional pure base-field predicates
  (`eq`/`neq`/`lt`/`lte`/`gt`/`gte` against literal/env/tuple values, composed
  with `and`/`or`/`not`), and simple
  `project`/`extend`/`without`/`rename`/`qualify` transforms and optional final
  field/literal/tuple `sort(...)`, terminal `limit(...)`, and terminal
  `sortLimit(...)`; affected final ordered/windowed snapshots rebuild from
  current source rows inside the incremental maintenance path. Terminal `count()`,
  `count(expr)`, `sum(expr)`, `min(expr)`, `max(expr)`, `any(expr)`, and
  `notAny(expr)` aggregates are supported over the same subset; `avg(expr)` is
  supported only with matching visible `sum(expr)`/`count(expr)` fields over a
  non-null numeric base field or numeric literal.
  Non-final `limit` and `sortLimit` remain diagnostic-backed. It also accepts simple
  inner/left equality joins of two base relations with optional side-local
  `hash`/`where` filters and simple post-join
  `project`/`extend`/`without`/`rename`/`qualify` output transforms;
  non-equality joins, self joins, and join-side output transforms remain
  diagnostic-backed. Treat this as opportunistic IVM behind materialized
  snapshots, not a general incremental-view-maintenance API.
- Set operations use stable JSON row keys.
- Expression calls use named evaluator functions, not arbitrary closures in query
  data. Evaluate options can provide custom functions. Unsupported call names
  evaluate to `undefined` and produce an `unsupported_expression` diagnostic.
- Field validation is local and shallow. Extra fields pass; `refField` metadata
  is not referential integrity.
- `Db` freezes relation arrays and the root data map, not deep row objects.
- Object-backed `applyWrites` runtime support is partial by design. Use
  `applyWritesAtomic` or the `Db` transaction helpers when all-or-nothing
  behavior is required.
- Object-backed `tryTransact` and `transact` are all-or-nothing. Failed
  transactions expose diagnostics and the original `Db`.

API blockers to resolve before stronger product claims:

- Adapter transaction atomicity: decide how non-object-backed adapters expose
  all-or-nothing writes, partial writes, or unsupported transaction semantics.
- Constraint lifecycle: object-backed constrained transactions validate
  explicit constraint sets after staged writes and roll back on constraint
  diagnostics; schema/DB attachment remains open.
- Change tracking contract: one-shot query diffs, manual watch refreshes,
  `subscribeWatch` callback fan-out, host-driven `watchRuntime` refreshes, and
  recompute-backed `trackTransact`/`trackRuntimeCommit` report full rows, keyed
  `rowChanges`, and query/source identity without async stream semantics. Direct
  relation targets can derive `rowChanges` from validated real deltas. React
  commit results do not expose watch-change envelopes; patch-like or
  relation/query-specific semantics still need decisions before true incremental
  delivery exists.
- Materialization identity: `queryKey` gives query-structure identity, and
  `RelationSource.version` gives adapters an optional opaque snapshot identity.
- Adapter ownership: `RelationSource` is read-only, while `RelationRuntime`
  defines the source plus optional patch target shape for stores that accept
  writes. A patch target should declare writable relation ownership with
  `relationNames` or `ownsRelation`; source `relationNames` is read-side
  metadata and only a compatibility fallback for write routing. `RelationAdapter`
  is the durable `commit` compatibility layer, and a durable adapter can expose
  `target.apply` when it can bridge that commit path into generic runtime
  semantics. Indexed lookup policy, write atomicity, and snapshot/version
  identity remain integration-specific.

Tests to rip next:

- Tests that assert internal object-backed patch expansion details instead of
  public `WritePatch`, `Db` transaction, or adapter apply/commit results.
- Materialization tests coupled to private incremental planner branches rather
  than public diagnostics, cached rows, and set/hash/unsupported index result
  families.
- Watch/runtime tests that inspect registry internals instead of
  `watchTarget`, `unwatchTarget`, `watchChangeMap`, `trackTransact`, or
  `trackTransactPatches` outputs.
- Constraint tests that expect query-bound `req`/`unique`/`fk` enforcement
  before those descriptors graduate from unsupported stubs.

## Open API Decisions

These should be settled before expanding implementation much further.

Constraints:

- Attachment: object-backed transaction option exists; schema-level, DB-level,
  materialized query, or separate registry attachment remains open.
- Failure mode: constrained object transactions reject writes; advisory
  validation remains available through `validateConstraints`.
- Scope: row shape, relation-local uniqueness, cross-relation foreign keys, and
  arbitrary query-level checks may need different execution paths.

Materialization:

- Identity: object identity is not enough. We need stable query keys or an
  explicit user-provided id.
- Invalidation: adapter-backed sources need snapshot/version information.
- Exposure: decide whether a materialized query can be read as a relation.
- Lifecycle: decide who owns memory and when indexes/views are released.

Watch/change tracking:

- Diff shape: experimental keyed `rowChanges` exist; final key encoding,
  patch-like deltas, and relation/query-specific changes remain open.
- Timing: synchronous transaction result, refresh/tracked-change callback,
  runtime host invalidation callback, async stream, or all three. Current
  `watch` callbacks are refresh/recompute-backed and do not imply async streams
  or automatic materialization maintenance.
- Adapter role: an adapter may provide source changes, but Tarstate should own
  derived-query diffs if it claims watch semantics.

Writes/adapters:

- Object-backed apply runtime support is not enough for external stores;
  `RelationSource` is the read-only boundary and `RelationRuntime` is the
  minimal write-capable adapter-facing contract.
- A write adapter needs to translate either `WritePatch` batches or host-system
  changes into the backing system's mutation model, emit stable `RelationDelta`
  change reports, and report diagnostics in Tarstate terms.
- Object-backed `tryTransact` is atomic. Adapter-backed writes still need an
  explicit atomicity contract.

## Flow A: Build A React App

Use this when you are starting a small React app or tool and want Tarstate to be
the local relational state layer.

1. Define normalized relations with `defineSchema` and `relation`.
2. Start with `createDb(seedRows)`.
3. Define view queries as top-level constants.
4. Create a React store with `createDbStore(seedRows)`.
5. Render with `TarstateProvider`, `useTarstateQuery`, and `useTarstateQueries`.
6. Write with relation-scoped `write(schema.todos)` patches such as `insert`,
   `updateByKey`, predicate `update`, `insertOrReplace`, `insertOrMerge`,
   `deleteByKey`, predicate `delete`, `deleteExact`, `replaceAll`, and explicit
   `insertOrUpdate(row, { update })` through `useTarstateCommit`.
7. Keep core `createDb`, `q`, and `tryTransact` tests around the same schemas,
   queries, and patches.

Example shape:

```ts
const todos = write(schema.todos)
const store = createDbStore({ todos: [] })

await store.commit([
  todos.insert({ id: 'todo-a', text: 'Sketch schema', done: false }),
])
```

What this gives today:

- A typed relational model.
- React subscription through a revisioned external-store snapshot.
- One-shot derived reads through hooks.
- Explicit write patches committed through the DB store, runtime store, or
  adapter store. Commit results expose status, reflected row effects, stable
  relation deltas, diagnostics, and a fresh snapshot.

Experimental core surfaces can be layered underneath when needed:

- Constraint enforcement through explicit object-backed constrained
  transactions.
- Snapshot materialization and opportunistic incremental maintenance for simple
  single-relation pure predicates/transforms with optional final
  field/literal/tuple `sort(...)`, plus the current narrow aggregate and simple
  equality-join subsets. This is
  opportunistic IVM behind snapshots, not a general IVM surface.

What it does not give yet:

- General async streams or adapter-fed relation-delta subscriptions.
- Stable/general/operator-maintained materialized views.
- Schema-attached or adapter-backed relational constraints.
- Storage persistence.

For non-React code, use the same schema/query/write split directly through
`@tarstate/core/db`, `@tarstate/core/evaluate`, and `@tarstate/core/write`.

## Flow B: Add A Relational Lens To Existing State

Use this when state already lives in Redux, Zustand, React state, Automerge,
server snapshots, or application-specific stores.

Do not migrate state first. Instead:

1. Identify the minimum normalized relations you wish you had.
2. Expose a read-only `RelationSource` over the existing store.
3. Define queries for derived views, validation reports, and debugging tables.
4. Use `evaluate(source, query)` or `q(createDb(snapshot), query)` at the edge.
5. Add `lookup` or `rangeLookup` support only after benchmarks show scans are
   too expensive.
6. Introduce write patches only where you want a typed mutation vocabulary.
7. Promote the boundary to `RelationRuntime` only when the existing store should
   accept Tarstate patch application; use `RelationAdapter` when it has durable
   commit semantics.

This flow treats Tarstate as a relational lens-style read and write boundary. It
should reduce glue code without forcing ownership of the existing state runtime
or implying general bidirectional view putback. In React, wrap that source with
`createSourceStore`, promote it to `createRuntimeStore` when it has a patch
target, or use `createAdapterStore` when durable commits are part of the
integration.

Read-only relation source for a plain app store:

```ts
type AppState = {
  readonly todosById: ReadonlyMap<string, Todo>
  readonly assignments: readonly Assignment[]
}

const sourceForState = (state: AppState): RelationSource => ({
  relationNames: ['todos', 'assignments'],
  rows: (relation) => {
    if (relation.name === 'todos') return state.todosById.values()
    if (relation.name === 'assignments') return state.assignments
    return []
  },
  lookup: ({ relation, field, value }) => {
    if (relation.name !== 'todos' || field !== 'id') return undefined
    if (typeof value !== 'string') return []

    const row = state.todosById.get(value)
    return row === undefined ? [] : [row]
  },
})
```

That source can power reads and derived views, but it cannot apply writes. A
write-capable runtime adds a patch target, while a durable adapter wraps a
source with `commit(patches)`. Both report version identity through
`source.version` and apply/commit results. When composing multiple write-capable
runtimes, set `target.relationNames` or `target.ownsRelation` for the relations
each target accepts; do not treat read-side `source.relationNames` as proof that
the source is writable.
Return `undefined` from `lookup` or `rangeLookup` when the source cannot answer
that indexed request; return `[]` only when the index is supported and no rows
match.

Use `tryCommitAdapter(adapter, patches)` when callers want a normalized report
with consistent source identity and version fallback; it does not validate the
adapter's store-specific write semantics.

## Flow C: Agents Building From Scratch

Agents should start here because it produces the least accidental structure.

1. Name entities as relations, not nested object paths.
2. Give every durable relation an explicit key.
3. Keep source rows boring: ids, refs, primitive facts, timestamps, flags.
4. Express UI, reports, visibility, validity, and cross-object joins as queries.
5. Declare constraints early; validate them explicitly or use constrained DB
   transactions when enforcement is required.
6. Add benchmarks when a query becomes important enough to optimize.
7. Only then choose an adapter or persistence layer.

Agent checklist:

- Create `schema.ts` first.
- Create `queries.ts` second.
- Create `writes.ts` third.
- For React apps, wire `@tarstate/react` after the schema/query/write files are
  clear.
- Add seed data tests with `createDb`, `q`, and `tryTransact`.
- Add benchmark cases for representative data sizes before optimizing.

This order keeps the API honest: if a query is awkward to express, fix the
query API before building storage, rendering, or sync machinery around it.

## Automerge As API-Surface Consumer Example

Automerge should guide Tarstate as an API-surface consumer example, not as a
core dependency or product center.

Use Automerge to answer concrete questions:

- Can a document snapshot expose normalized relation rows cheaply?
- Which relations need indexes for common joins?
- How expensive is extracting rows from an Automerge document versus evaluating
  Tarstate queries once rows are available?
- What write vocabulary maps cleanly onto Automerge changes?
- What version identity should a source expose so materialized queries can know
  whether they are stale?

Current status:

- `@tarstate/core` does not contain Automerge-specific tests, document fixtures,
  or benchmarks.
- `@tarstate/automerge` exercises an Automerge-backed integration using
  `@automerge/automerge` heads and `Automerge.change`. The map adapter is
  intentionally raw-document only; Repo handle integrations should wrap it and
  push host document changes through `setDoc`.
- Automerge map storage is currently `map-v1`: row keys are map keys, tuple or
  non-string keys are JSON strings, and stored row values omit key fields.
- `packages/core/tests/adapter.test.ts` covers generic `RelationRuntime`
  composition plus the durable `RelationAdapter` contract, including the
  adapter-commit to relation-apply bridge.
- `packages/core/bench/evaluate.bench.ts` covers Tarstate evaluator paths over
  core object sources. It is not Automerge coverage.
- `packages/automerge/tests/automerge.test.ts` exercises real
  `@automerge/automerge` documents, heads, changes, row extraction, lookup/range
  lookup, `deleteExact`, `replaceAll`, and atomic patch rejection.
- Automerge patch targets declare writable ownership with `ownsRelation`; do not
  infer Automerge write ownership from read-side relation exposure alone.
  Presence runtimes without `localPeerId` are read-only and omit `target`.
- Automerge-specific benchmarks remain a gap; they should live outside
  `@tarstate/core` and import the real host package.

The adapter package supplies hooks from the host document library: read current
heads, extract relation rows from a snapshot, answer equality/range lookups by
scanning extracted relation rows, translate `WritePatch` batches into document
changes, and return commit-effect `RelationDelta` batches.

The snapshot identity belongs to `adapter.source.version` and commit results;
an adapter should not grow a separate top-level `version()` method.
`status` is the authoritative commit outcome: rejected commits have
`applied: 0` and empty deltas; partial commits carry diagnostics for rejected
effects plus deltas/version for the effects actually reflected by the adapter.

`tryCommitAdapter` can wrap this raw commit result to normalize the report
envelope and fill a missing version from `adapter.source.version`, without
changing adapter-owned mutation semantics.

Suggested benchmark lanes:

- Snapshot extraction: document snapshot to relation rows.
- Query evaluation: relation rows to derived view rows.
- Indexed lookup: adapter-backed lookup versus Tarstate object index.
- Write application: Tarstate patches to document changes.
- End-to-end view update: document change to derived query result.

Keep Automerge consumers outside `@tarstate/core`. Iterate
`@tarstate/automerge` only where it clarifies the generic source, adapter,
patch, version, and delta contracts.

## Product Framing

Current claim:

> Tarstate is a relational query and derivation layer for JSON-shaped
> application state.

Possible later claim, once runtime contracts are stable:

> Tarstate lets TypeScript apps model essential state as relations, derive views
> with queries, validate relationships, and observe query changes.

Avoid claiming:

- Full state management.
- Full database behavior.
- General bidirectional lens/view putback.
- Reactive database or general reactive state management.
- Automerge-native state management.
- General/operator-maintained incremental materialized views.
- IVM as a product identity or general public API; use it only to describe an
  opportunistic optimization behind materialized snapshots.

Those claims should wait until the runtime contracts are real and benchmarked.
