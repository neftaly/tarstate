# Conformance, decisions, and review record

This ledger records the 0.6.0 baseline reviewed on 2026-07-19. It separates
verified current evidence from target rules and candidates. It is not a
changelog.

## Current conformance

| Area | Status | Evidence |
| --- | --- | --- |
| Portable boundary parsing and hostile budgets | conforms | foundation/parser tests and fuzz properties |
| Exact artifact identity and semantic handler isolation | conforms | artifact tests, boundary and tree-shake checks |
| Ordered schema relation keys | conforms | preparation regression, Automerge simulate/commit matrix, type fixtures |
| One typed/untyped query semantics | conforms | shared portable model, typed set-authoring/runtime tests, typed fixtures |
| Batch/incremental agreement | conforms with bounded fallbacks | incremental/property tests and query perf contracts |
| Database external-store observation | conforms | observer/source lifecycle tests and React store use |
| Source-link discovery and settlement | conforms for current feature set | source-link unit and fuzz tests |
| Replayable exact-state transactions | conforms | source-neutral schedule properties plus attachment/external-store/Automerge integration tests |
| Captured Automerge text reconciliation | conforms for eligible pure splice transactions | real branch/head integration and rejection tests |
| Cross-publication dependent text | conforms for retained-branch Automerge sources | publication-race integration, unknown suspension, and fuzzed branch ancestry |
| Text-intent result positions | conforms for mapped Automerge text | exact-basis integration, deletion evidence, bounded capture, and delivery-order fuzzing |
| Candidate validation before reconciled publication | conforms | executor ordering and integration failure cases |
| Official adapter one-path DX | conforms | `openAutomergeDatabase`, `openExternalStoreDatabase`, package recipes |
| Topic entrypoints and acyclic core direction | conforms | source and built boundary scripts |
| Tree-shaking budgets and package side effects | conforms | selected bundle-size fitness script |
| TypeScript 7 inference and compiler budget | conforms for current fixtures | cross-module type tests and extended diagnostics budget |
| Tarball release usability | conforms | five clean consumer install/runtime verifications |

## Current gaps and audit candidates

These are not promises to refactor. They identify the highest-value places to
seek evidence in future passes.

### Large context modules

The transaction executor, query evaluator/maintenance engine, Automerge mapped
storage binding, and Automerge source runtime each combine several internal
phases. Their public direction is sound, but edit context is high.

Candidate approach: extract named pure phases or a distinct lifecycle owner only
when a real change demonstrates separable authority and the extraction reduces
required context, coupling, or duplicated tests. Avoid forwarding-only files.

### Lifecycle classes and `this`

Several owners use classes with private fields. They should be reviewed when
their area changes for detached-method hazards, binding overhead, mixed
authority, and unnecessary derived state.

Candidate approach: closure protocols plus pure transition modules. Do not
perform syntax-only conversions or replace classes with large mutable context
objects.

### Freeze and ownership cost

Cold portable facts are deliberately detached/frozen. The correctness boundary
is strong; comprehensive allocation evidence distinguishing cold ownership from
hot publication is incomplete.

Candidate approach: profile affected workloads, then remove repeated/transient
freezes or copies only where ownership remains explicit. Never weaken hostile
input adoption for a microbenchmark.

### Public error consistency

The intended parse-result/throw/receipt taxonomy is coherent, but every public
export has not yet been classified in one executable catalog.

Candidate approach: audit names and return types by entrypoint; change only APIs
whose caller cannot predict the channel. A universal `Result` wrapper would
erase programmer errors and is rejected.

### Live attachment metadata

Current behavior deliberately treats opener metadata as fixed bootstrap
configuration. Remote metadata governance after opening is not implemented.

This is a deferred feature, not a hidden defect. It requires an authority and
migration protocol before code work. Silent re-preparation or automatic hot
reload is rejected.

### Coherent multiple query projections

A query session currently owns one result plan. Independent sessions can race,
while normalizing unrelated projections into one set query can broaden query
dependencies and erase their independent readiness evidence.

This is a deferred generic capability, not permission to wrap several current
observers and label their snapshots atomic. A future implementation must batch
capture and publication at the database-observation boundary, preserve each
prepared plan's row/parameter types and focused readiness, share discovery and
mount ownership, and compare its work against independent sessions and a
normalized set query.

### Collaborative text intent sessions and anchors

`spliceText` correctly reconciles one eligible captured transaction.
`openTextIntent` composes an ordered stream whose later offsets depend on
earlier local splices. Each `publish` captures one pending prefix, while later
segments can continue on the retained private branch. This is generic editor
behavior rather than a product convention.

Automerge integration retains a fresh-actor private branch across conditional
publications. A known commit advances branch ancestry; concurrent remote work
is merged only into each validated publication candidate. Rejection blocks
dependent descendants and unknown outcome suspends them, so later segments
never publish while ancestor publication is uncertain.

Buffered dependent splices can still become one source-native change. A caller
may capture named logical text positions from the session's exact current
snapshot and request their resolution on the same `publish`. The result receipt
contains only detached offsets and exact basis evidence. Native cursors, mapped
paths, documents, and handles remain inside the adapter.

Position resolution is optional beside retained publication. Memory and
non-mergeable stores may report it unsupported without disabling ordinary text
publication. Work is bounded per publication. Duplicate names, stale captures,
invalid ranges, unsupported resolution, deletion, cancellation, rejection, and
unknown outcomes produce explicit per-position evidence.

### Physical performance evidence

Algorithmic, bundle, and correctness-bearing benchmark ratchets exist. Absolute
wall-clock ceilings can be noisy under whole-machine contention and do not
directly measure consumer devices.

Candidate approach: preserve independent samples and correctness contracts,
capture comparable clean-host baselines for meaningful hot-path work, and use
profiles rather than threshold tuning.

## Accepted architectural decisions

- One ordinary API path per source/task; performance variants remain private.
- Typed authoring and runtime semantics share one implementation.
- Attachments contain portable validated facts; source drivers remain adapter
  owned.
- Replayable operations are the common transaction model across adapters.
- Source-native reconciliation is an optional internal capability, not a
  second public transaction path.
- Automerge remains multiplayer: validation and conditional publication still
  apply after CRDT reconciliation.
- Native readonly arrays are the public row/result shape.
- Product operations, retries, presence, persistence, and document conventions
  remain consumer-owned.
- Topic entrypoints and lazy boundaries are justified by reachable work.
- GitHub tarballs are the distribution contract; npm publishing is out of scope.
- Consumer DX has priority over maintainer/agent convenience. Agent context is
  improved through honest domain boundaries, not consumer abstractions.

## Rejected or constrained approaches

| Approach | Decision |
| --- | --- |
| Public prepared/owned/sealed/fast APIs | rejected: multiple ways to do one task |
| Patchpit-shaped product operations in Tarstate | rejected: consumer coupling |
| Route non-Automerge sources through Automerge | rejected: dependency and false semantics; share the source-neutral protocol instead |
| Remove transaction/idempotency evidence because Automerge merges | rejected: merge does not prove targets, constraints, authority, or outcome |
| Expose Automerge heads/changes/staging | rejected for ordinary consumers |
| Generic universal adapter or state-machine framework | rejected: optional capability and authority coupling |
| Custom public array wrappers for O(1) slicing | rejected without demonstrated end-to-end need |
| Automatic live metadata hot reload | rejected until governance semantics exist |
| Freeze every internal object | rejected: boundary tool, not architecture |
| Avoid every assignment | rejected: single-owner retained writes are often clearer and cheaper |
| Split files by LOC alone | rejected: split by domain and authority |
| Convert unit tests to fuzz mechanically | rejected: examples and regressions retain value |
| Add SQL features for parity | rejected: require consumer and semantic justification |
| Publish to npm | rejected under current distribution policy |

## Current fuzz-suite organization

The focused source-link, observer-lifecycle, relation-delta, JSON-tree, and
Automerge suites have distinct models and should remain independently runnable.
The broad deterministic query fuzz suite emphasizes fast operator and pooled
state coverage; the fast-check property-law suite emphasizes shrinking command
models and independent oracles. Their overlap is useful unless profiling shows
duplicated cases dominate feedback time. Consolidation should reuse generators
or fixtures first, not create one giant property file.

## Cross-project process evidence

The pre-execution review history from Royal was used as process guidance, not as
Tarstate architecture. The relevant lessons were:

| Observed problem | Adopted rule here | Expected benefit |
| --- | --- | --- |
| Contracts scattered between code, findings, and aspirational docs | one indexed normative folder; proposals become obsolete | one authority and less stale context |
| Existing behavior presented as intentional design | explicit current fact, must, gap, and candidate language | avoids fossilizing accidents |
| Brainstorming collapsed too quickly into one canonical representation | record rejected/constrained alternatives and require amplification review | prevents elegant-looking memory/copy regressions |
| A consumer-DX review drifted into code during a spec phase | docs-only gap ledger; no implementation conformance edits | preserves phase focus |
| Functional-core style risked allocation-heavy abstraction | semantic purity permits caller-owned scratch and retained owner state | cleaner ownership without GC ideology |
| Agent-friendly fragmentation risked tiny forwarding modules | split only by authority, volatility, reachability, or test model | lower context without file ceremony |
| Microbenchmark pressure could dominate architecture | correctness/ownership first and profiling before engine tuning | fewer parallel fast paths |
| Repeated passes lacked an explicit finish condition | repeat a lens after a material finding; stop after a clean complete pass | real ratcheting without endless churn |
| Post-doc execution could dominate retrospective attention | use later work only as validation of which documented rules held | keeps planning evidence concrete and bounded |

## Review acceptance criteria

This specification set is acceptable when:

- a consumer can identify one path without reading adapter internals;
- every observable state/concurrency/error claim names its evidence class;
- no document requires Patchpit or another consumer's product convention;
- portable core, adapter, framework, and host authority remain distinct;
- performance rules account for algorithms, allocations, retained memory,
  engine behavior, React, and bundle reachability without public fast paths;
- an agent can start a focused task from one context bundle;
- contradictions and unresolved candidates are visible here rather than hidden
  in prose;
- a follow-up pass for each named review lens finds no new material issue.

## Documentation review record

The initial corpus received independent passes on 2026-07-19. Only material
findings and resulting changes are recorded.

| Lens | Material findings and revisions | Follow-up |
| --- | --- | --- |
| Hostile correctness | Corrected the false claim that compiled attachment preparation is fully portable; separated portable artifact evidence from source-neutral owned functions. Corrected authority ownership so preparation can be reused while live contexts cannot. Clarified query-observer change evidence and the common publication boundary. | A complete third pass found no new material correctness issue. |
| Consumer DX | Named `openDatabaseQuery` as the normal multi-source query path and `createDatabaseView` as a host seam; added exact import paths, direct mapped-row selection, prepared capabilities, one-place scope configuration, truthful optional result properties, typed `unionAll`, and a reference memory atomic store. | A later consumer pass found the set-authoring cast and repeated memory-store plumbing; both now use existing runtime protocols. Coherent multi-projection publication remains a named gap because a wrapper would not satisfy its atomicity promise. |
| Coupling and agent context | Principles/navigation did not concretely divide large subsystem phases. Added `subsystem-boundaries.md` with semantic/effect owners and evidence-driven extraction seams; corrected an ordinary-versus-reconciled publication ambiguity found on the repeat. | A complete third pass found no new authority overlap in the documents. |
| Performance, allocation, and TypeScript | Tightened the React rule so it prevents required per-row subscription fan-out without outlawing independent `useRow`; formalized freeze, assignment, bind/closure, engine-shape, emitted-JS, erasable TypeScript, and type-budget rules. | The repeat found no new optimization claim that justified API or architectural complexity. |
| Verification portfolio | Confirmed focused fuzz suites have distinct models; recorded why the two broad query suites should not be merged mechanically. Added a source-neutral end-to-end replay schedule model and a focused-to-full feedback ladder. | The replay model now covers stale-basis, abort, and unknown-outcome schedules without coupling CRDT-specific shrinking vocabulary into the core suite. |

The initial specification review intentionally made no production-code change.
The later implementation slices named above were reviewed and verified
separately. Current gaps remain gaps until a future task supplies its own
acceptance evidence.
