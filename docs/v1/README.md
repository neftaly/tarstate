# Tarstate v1

Status: normative v1.0 specification.

This directory is the source of truth for the Tarstate rewrite. The terms MUST,
MUST NOT, SHOULD, SHOULD NOT, and MAY are normative. When implementation and
this specification disagree, the implementation is wrong or the specification
must be amended by an explicit entry in [decisions.md](decisions.md).

Release evidence is indexed in
[conformance-matrix.md](conformance-matrix.md). Documents outside `docs/v1/`
are historical or explanatory unless this specification incorporates them.
The original implementation gates are preserved in
[acceptance.md](acceptance.md); that ledger cannot be weakened by an
implementation convenience.

## Product boundary

Tarstate is a reactive relational interface over an authority-scoped set of
local-first sources.

- Automerge documents are the primary durable source type.
- Zustand, TanStack Store, and equivalent app stores use one generic atomic
  external-store protocol.
- A source is the maximum atomic write boundary: one Automerge document, one
  external store, or one custom source with an equivalent coordinator.
- Queries may span sources, but a composite basis records snapshots that were
  used; it never claims distributed snapshot isolation.
- Schemas, queries, transactions, constraints, storage mappings, and schema
  lenses are immutable portable artifacts.
- Codecs, functions, source drivers, and storage bindings are trusted host
  registrations. Data or a URL never authorizes code execution.
- Semantic evaluation, projection, and planning are pure. Resolution, loading,
  subscriptions, commits, persistence, networking, React, presence, and other
  effects are explicit imperative shells.
- The public query authoring API is functional and uses `pipe`. Fluent query
  chains and mutable builders are outside v1.

## Architecture

| Layer | Responsibility |
| --- | --- |
| Schema | Logical relation and field meaning, stable relation identity, keys, refs, value domains, and promised edit semantics |
| Storage mapping | Optional portable description of storage candidates and field destinations |
| Storage binding | Trusted pure projection and edit planning over an immutable source snapshot |
| Source | Snapshot lifecycle, basis, subscription, and atomic compare-and-apply |
| Attachment | Source plus selected bindings, schema views, lenses, and authority |
| Dataset | Versioned expected attachment membership for a query universe |
| Database | One authority-filtered view, capability registry, caches, observers, and commit coordinators |
| React | Consumption of cached immutable observer snapshots |

Schemas MUST NOT define physical paths, source lifecycle, authority, indexes,
network state, or React behavior. Source adapters and storage bindings depend
inward on generic core protocols. Public schema and query vocabulary MUST NOT
expose Automerge object layouts, external-store action conventions, or
adapter-private metadata.

## Portable artifacts and capabilities

Every portable artifact has a semantic kind, format version, immutable ID,
content hash, exact dependency references, and a body. Its hash is computed
from canonical JSON over semantic content. Locations are resolution hints, not
identity. Reusing one ID for different content, resolving two hashes for one
dependency ID, or silently choosing between valid artifacts is an error.

Ad-hoc builders MAY derive deterministic inline IDs from normalized content.
Callers never hand-author a claimed hash. Parsers are total and budgeted,
reject duplicate JSON members before ordinary JSON materialization, and return
structured issues for expected failures. They reject hostile object shapes,
unsupported host values, cycles, and prototype-pollution keys before trusted
code sees them.

Executable requirements use exact capability references. Capability
substitution exists only through an explicit, immutable implication graph;
names, version order, and semantic-version ranges imply nothing. Missing or
unknown capabilities fail explicitly, do not trigger dynamic code loading, and
participate in observer/writeability state and cache fingerprints.

## Values and relational semantics

Portable values are canonical JSON plus versioned tagged domains such as exact
decimal, instant, bytes, and registered custom codec values. Numbers are finite
binary64 values; integers are safe JavaScript integers. Every scalar domain
defines canonical equality and hashing, and operators requiring order reject a
domain that supplies no deterministic ordering.

`null` is a value. Missing means an optional field is absent. `undefined`
represents neither. Comparisons involving null or missing yield logical unknown
except for explicit null/missing predicates. Predicates use strong Kleene
logic, and `where` retains only true. Capability-unavailable, logical unknown,
missing, and application data are distinct states.

Relations are bags. Equal visible rows retain distinct hidden occurrences.
`unionAll` adds multiplicities; `union` and `distinct` use canonical visible
equality. Ordering is deterministic and uses hidden result identity as the
final tie-breaker. Recursion is a monotone keyed least fixpoint with explicit
row and iteration budgets.

Queries are immutable portable templates with declared parameters, schema
views, a root relational expression, and exact capability requirements. A
request selects exactly one dataset. Preparation resolves artifacts, lenses,
codecs, functions, collations, and capabilities against one database authority
view. The pure full evaluator is the semantic oracle. Production observers use
stateful incremental view maintenance that is differentially equivalent for
the complete v1 algebra. The operator graph consumes occurrence-keyed changes,
reuses unchanged tuple segments, indexes equijoins, and stops propagation when
an operator result is unchanged. Global operators update only after an input
change reaches them. Recursion is linear, monotone, and semi-naive. The oracle
is not a production fallback.

## Identity, storage, and compatibility

Source identity, attachment identity, stable relation ID, logical key, row
locator/incarnation, and derived result key are different concepts.

- A source is the unit of atomic ownership.
- An attachment is one live, pinned, bound, and authorized view of a source.
- A relation ID is stable logical identity; display and local schema names are
  not.
- A logical key supports lookup and refs but is not physical or stable entity
  identity.
- A binding-owned locator plus row incarnation identifies one storage entity.
  Mutable indexes and paths are not durable locators.
- A result key supports diffs and UI identity but grants no write authority.

Duplicate logical keys remain visible as diagnostic candidates; keyed reads and
writes are ambiguous until explicitly repaired. No adapter chooses a winner.
Writes through query results require one proven writable base handle or a named
inverse binding. Aggregates, distinct results, windows, recursive outputs, and
ambiguous joins are read-only by default.

Schemas describe logical relations, types, optionality, nullability, key fields,
refs, and semantic edit capabilities. Optional and nullable are independent.
Storage bindings locate candidates, project total logical rows, preserve
unknown physical fields, declare conservative footprints, and plan complete
field-level intents without subscribing or committing.

Schema lenses declare exact from/to schema references and separate read and
write transforms. Lens selection is explicit or unambiguous; version numbers
and shortest paths do not select compatibility. Reads parse stored meaning
before applying a lens. Writes translate field intents back and reject when
touched meaning or unknown storage cannot be preserved. Lenses are views, not
migrations.

## Sources, discovery, and observations

Resolvers operate only on authority-approved references and never execute code.
They normalize aliases, cycles, redirects, loading, missing, failed, denied,
deleted, and unsupported resources into observable evidence. A byte or HTTPS
resource becomes relational only through an explicit trusted attachment.

A self-describing document MAY carry an adapter-private bootstrap declaration
that references its storage schema, projection, and constraint activation. The
declaration grants neither authority nor executable code. Malformed or
conflicted recognized bootstrap data disables automatic writable attachment
until an authority-gated governance repair. Unknown document fields and future
metadata are preserved.

Exact artifact resolution retains every embedded, registered, catalog, and
location attempt with lifecycle, freshness, resource, and carrier-provenance
evidence. Stores and catalogs receive the same authority scope and cancellation
signal as resource drivers. Attachment preparation retains these complete
resolution records on both ready and unavailable results.

A dataset is a versioned expected set of attachments. Required members must be
ready for an exact result. Unavailable optional members contribute no rows and
do not block exactness, but their absence remains evidence. A settled revision
means declared traversal has completed, not that membership can never change.

Every query result reports rows, result keys, completeness, freshness, basis,
source evidence, and issues:

- `exact` means all evidence required by the query is available.
- `lower-bound` is allowed only for proven positive monotone evaluation.
- `unknown` means no current answer can be asserted; current rows and keys are
  empty and MUST NOT be interpreted as an empty relation.

Observers expose immutable current evidence and MAY retain the prior exact
answer separately as `lastExact` with its original basis and stale freshness.
A transition to unknown is invalidation, not a removal diff. Observer leases
are independent, close idempotently, and release shared subscriptions, caches,
projections, and retained snapshots when the last lease closes.

Presence, connectivity, sync, lifecycle, capability, issue, and constraint
facts are explicit authority-filtered system relations. Presence is ephemeral
and is neither durable transaction data nor valid input to a hard constraint.

## Transactions and receipts

A transaction is immutable portable intent attempted against exactly one
writable attachment and therefore one source. Time, randomness, and generated
IDs are captured as fixed parameters before the attempt. Cross-source work is
an explicitly non-atomic batch or shell sequence.

Statements run in order. Later statements see earlier staged effects. Within
one set-based statement, the target set and expression inputs are fixed from
that statement's starting staged state, preventing iteration-order and
Halloween effects.

The v1 transaction execution model, across source-specific transaction
executors and generic source commit coordination:

1. captures one snapshot, basis, attachment incarnation, authority, and active
   artifacts;
2. projects and parses every participating binding;
3. evaluates ordered logical statements and same-source referential actions;
4. plans the complete edit set and checks exact footprints;
5. merges compatible intents without binding-order or last-writer-wins rules;
6. applies intents to immutable staged storage and reprojects touched data;
7. evaluates hard constraints on the final logical state; and
8. performs exactly one atomic compare-and-apply.

`executePreparedTransaction` and `simulatePreparedTransaction` compose a sealed
transaction artifact with any `AtomicSource` whose prepared bindings expose
writable logical rows. The prepared context is the authority, capability,
schema, query, constraint, and artifact-resolution boundary. Statements stage
in order and may revisit a footprint; unordered binding intents within one
statement still require a merge proof. `InMemoryAtomicSource` remains the
source-specific complete evaluator, while `LogicalMemoryAtomicSource` is the
generic protocol proving adapter.

Every binding plan reports which input edit indexes it handled. Each edit must
have one exclusive handler, or one or more handlers that all explicitly opt
into cooperative handling before their intents are merged. Missing, malformed,
or conflicting handling evidence rejects before staging. A prepared writable
context must also provide an explicit capability decision callback; allow-all
authority is never inferred from an omitted policy.

Prepared generic execution reserves an operation identity before guard,
constraint, or mutation-capable evaluation and retains the resulting receipt.
Memory contexts receive a process-local ledger by default; contexts claiming
local or persisted durability must supply a durable ledger.
Sources must provide exact basis evidence for immutable staged storage. The
executor advances that basis with staged state for later statements, guards,
returning queries, binding projections, and final constraints; reusing the
captured before-basis after a logical change is invalid. Relation replacement
stages ordered delete and insert phases, while upsert replacement replaces the
complete logical row.

Expected-basis mismatch rejects. Without an expected basis, a safe pre-handoff
replan MAY occur against a newer local basis. Nothing replans after handoff.
Cancellation before handoff rejects without mutation; cancellation afterward
cannot undo a commit.

Every attempt has stable operation epoch and operation ID plus an intent hash.
Reusing that pair for different intent is ambiguous. Receipts report committed,
rejected, or—only with durable deduplication and outcome lookup—unknown. A
caller MUST NOT retry an unresolved unknown non-idempotent operation. No-op
commits are committed at the same basis and emit no source notification.

Non-atomic batches and shell sequences retain each nested receipt and report
complete, partial, failed, or unknown without claiming rollback, compensation,
or atomicity. Unknown future receipt kinds are preserved as bounded opaque
portable data; older consumers infer neither success nor retry safety.

## Constraints, authority, and repair

Parsing, constraints, guards, authority, referential actions, and workflows are
separate mechanisms. Constraint sets are immutable artifacts activated per
source as audit or required. Constraint evaluation is satisfied, violated, or
indeterminate. Required constraints reject both newly violated and newly
indeterminate final states.

Hard constraints run on the complete authoritative staged state of one source
and deterministic registered functions only. Cross-source, presence,
connectivity, time, randomness, and network reachability are audit-only unless
captured as durable source facts. Concurrently valid Automerge changes may
merge into a violating state; Tarstate exposes the violation and requires an
authorized repair rather than rewriting history.

Read and write authority are distinct and applied before query evaluation and
caching. Cache identity includes authority and capability fingerprints.
Diagnostics MUST NOT leak hidden contributors, values, or counts. Opaque
handles are scoped to a database view and rechecked at commit.

Recognized bootstrap or constraint-activation conflicts make ordinary writes
read-only. A narrowly authority-gated governance operation MAY repair only that
metadata at an exact basis and MUST emit an auditable receipt. It does not
permit arbitrary application-data edits or bypass constraints.

## Move semantics

Move is a generic semantic edit family, not a promise made by every source.
Capabilities form three explicit contracts:

- `move` is the minimum relocation requirement.
- `identityPreservingMove` keeps the same storage entities and descendant
  identities while parent/order changes.
- `copyRelocate` copies logical data and deletes or tombstones the old entities;
  locators, CRDT identity, conflicts, and concurrent old-location edits may be
  lost.

The two mechanisms MAY explicitly imply `move`. `copyRelocate` never satisfies
`identityPreservingMove`. Receipts report the actual mechanism and bounded
preservation losses.

A move intent is source-local transaction intent with a logical target,
destination parent, stable before/after anchor or boundary position, required
minimum capability, and missing-anchor policy. Mutable indexes are not anchors.
Cross-source relocation is an explicit non-atomic copy/create and delete
workflow.

The built-in Automerge adapter advertises none of `move`,
`copyRelocate`, or `identityPreservingMove` and rejects a requirement for them
before mutation. Tarstate reserves, reads, writes, migrates, compacts, or
interprets no Automerge move metadata. Names such as `__automergeMoves` and
`__tarstateMovesV1` are ordinary application data and are preserved without
Tarstate meaning.

An app may model parent and order as ordinary fields through its own schema and
binding. A custom source or binding MAY implement generic movement, but then it
owns record namespaces, migration, conflict/concurrency behavior, retention,
reference translation, repair, and capability claims. Those records are not a
built-in Tarstate wire format or interoperability promise.

## Explicit exclusions

V1 excludes:

- distributed atomic transactions and global serializability;
- globally convergent constraint enforcement;
- automatic migrations, compensation, conflict repair, durable workflows, and
  general triggers;
- implicit execution of code discovered through a document or URL;
- arbitrary host closures in portable artifacts;
- public physical index or materialization controls;
- Tarstate-owned Automerge movement and move metadata;
- Suspense and source ownership hidden inside React.

Future features require additive capabilities and receipt kinds. They MUST NOT
reinterpret v1 results, upgrade unknown or partial outcomes, broaden authority,
or imply stronger atomicity.

## Release posture

V1 favors semantic clarity and explicit lifetime ownership over microbenchmark
and GC targets. Release checks retain compiler/declaration budgets, explicit
cache/lease/subscription lifetime tests, and a loose coarse runtime ceiling for
gross regressions. A material failure is a signal to simplify ownership and
data flow before adding benchmark-specific paths.

The legacy implementation remains immutable at tag `legacy-v0-final`, commit
`25f707c`, for archaeology and optional coarse comparison only. It is not a
runtime dependency or conformance authority.
