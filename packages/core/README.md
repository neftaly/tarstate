# @tarstate/core

Portable artifacts, schemas, query evaluation, transactions, source protocols,
database observations, and incremental maintenance for Tarstate v1.

Install the downloaded release tarball directly:

```sh
npm install ./tarstate-core-0.7.1.tgz
```

## Choose the application path

Most applications should make one choice based on where their data lives:

- For a writable Automerge document, start with
  `openAutomergeDatabase` from `@tarstate/automerge`. It owns attachment
  preparation, keyed relation diffs, replay after multiplayer changes,
  validation, and publication.
- For plain immutable state behind an atomic external store, start with
  `openExternalStoreDatabase` from `@tarstate/core/database/external-store`.
  It provides the same logical transaction and database lifecycle without
  claiming CRDT identity or merge semantics.
- For pure in-memory query evaluation, import the typed builders and
  `evaluateQuery` from `@tarstate/core/query`.
- For live observation over host-owned sources, prepare a typed query and use
  `createDatabaseView` from `@tarstate/core/database`.

The `source`, `attachment/adapter`, query-incremental, and transaction-authoring
entries are extension seams for adapter implementors. Application code using an
official adapter should not assemble sources, bindings, execution contexts,
canonical keys, or transaction syntax.

## Imports

The package root intentionally exports only the small `foundation` surface.
Runtime features use architectural topic entry points so Node, workers, and
non-tree-shaking bundlers do not link unrelated query, database, transaction,
and schema implementations:

| Entry point | Responsibility |
| --- | --- |
| `@tarstate/core` | Portable values, issues, artifact envelopes, hashes, and built-in capability references |
| `@tarstate/core/capabilities` | Host-owned capability registry and built-in capability registration |
| `@tarstate/core/source` | Source state, storage-independent logical edits, and live source protocols |
| `@tarstate/core/attachment` | Portable attachment declarations and host composition contracts |
| `@tarstate/core/artifacts` | Portable envelopes, capabilities, issues, and exact resolution; no semantic handlers |
| `@tarstate/core/schema` | Schemas, codecs, source-constraint contracts, mappings, lenses, and typed authoring |
| `@tarstate/core/query` | Query builders, evaluation, preparation, and incremental maintenance |
| `@tarstate/core/database` | Database catalogs, observation, host runtimes, and system relations |
| `@tarstate/core/transactions` | Writes, commit coordination, receipts, and lifecycle governance |

All other public values must be imported through a topic entry. Internal
maintenance-pool APIs and conformance fixtures are not made public by these
entry points.

Query and observation have narrower execution seams:

| Entry point | Responsibility |
| --- | --- |
| `@tarstate/core/query/model` | Portable query AST and batch request/result contracts; no runtime code |
| `@tarstate/core/query/prepare` | Query and expression preparation without evaluation |
| `@tarstate/core/query/authoring` | Query artifacts, functional builders, and typed authoring |
| `@tarstate/core/query/evaluate` | Pure batch query and expression evaluation |
| `@tarstate/core/query/incremental` | Stateful and pooled incremental maintenance |
| `@tarstate/core/database/observer` | Generic catalogs and observation with an injected maintenance factory |
| `@tarstate/core/database/adapter` | Source-neutral live database lifecycle composition for adapter implementors |
| `@tarstate/core/database/incremental` | Explicit adapter from database observation to incremental query maintenance |
| `@tarstate/core/database/external-store` | Relational database opener and framework-neutral atomic-store runtime bridge |
| `@tarstate/core/database/session` | Owned incremental query lifecycle over mounted and unresolved database sources |

Schema, query, and transaction authoring are separate implementations behind
their topic entries, so query authoring does not load schema or transaction
authoring code.

Transaction adapters also have a narrow construction seam:

| Entry point | Responsibility |
| --- | --- |
| `@tarstate/core/transactions/authoring` | Portable transaction construction without execution |

Artifact semantics and attachment preparation also have opt-in execution seams:

| Entry point | Responsibility |
| --- | --- |
| `@tarstate/core/artifacts/query` | Query artifact parsing, preparation, and evaluation |
| `@tarstate/core/artifacts/transaction` | Transaction artifact parsing and validation |
| `@tarstate/core/artifacts/constraint-set` | Constraint-set parsing and compilation |
| `@tarstate/core/artifacts/storage-mapping` | Storage-mapping parsing and compilation |
| `@tarstate/core/artifacts/schema-lens` | Schema-lens parsing and validation |
| `@tarstate/core/attachment/adapter` | Adapter-facing preparation and replayable transaction-service composition |
| `@tarstate/core/attachment/mapped-adapter` | Shared mapped projection and embedded-artifact composition for source adapters |
| `@tarstate/core/attachment/retained-text-adapter` | Optional source-native retained publication composition for merge-capable adapters |
| `@tarstate/core/attachment/text-intent-adapter` | Bounded source-neutral dependent-text session lifecycle |
| `@tarstate/core/values` | Portable built-in scalar conversion at host boundaries |

The portable `artifacts` entry never imports query evaluation, mapping, lens,
constraint, or transaction implementations. Hosts opt into only the semantic
artifact kinds they support; artifact data cannot select or load handlers.

Applications may load the database/incremental adapter at their own composition
boundary. Artifact or capability data never determines a module specifier:

```ts
const { createIncrementalDatabaseQueryMaintenance } =
  await import('@tarstate/core/database/incremental');
```

## Query authoring

`typedFrom`, `typedWhere`, `typedJoin`, `typedSelect`, and `typedUnionAll` cover
the common path while preserving exact aliases, parameters, literal
discriminants, and result rows. Union branches may use `typedLiteral(null)` to
align a field with another branch's typed value while incompatible non-null
families remain errors. Selecting a possibly missing expression infers an
optional result property, matching the runtime row. Advanced queries use the
exhaustive `Expr` and `QueryNode` unions directly, optionally composed with the
functional builders. This is an explicit authoring boundary; runtime evaluation
never falls back from typed to untyped behavior.

Call `prepareTypedQuery(query, { registryFingerprint,
authorityFingerprint, datasetId })` for the application path. It detaches and
freezes the portable query while carrying its inferred row and parameter types
into observers and framework adapters. `prepareQuery` remains the lower-level
API for an already-erased `QueryNode`.

For pure evaluation outside an observer, call
`evaluateQuery({ root: query, relations, parameters, functions })`. `query` may
be portable syntax or a plan returned by `prepareTypedQuery`/`prepareQuery`;
the evaluator automatically reuses an already-owned plan while continuing to
detach and freeze every changing input. There is no separate fast-path API.

## Failure boundary

Public parsers and database openers return `ParseResult` for untrusted
documents and artifacts. Invalid host configuration, malformed method
arguments, and a transform that fails before producing its first valid
transaction reject with `TypeError` or `TarstateParseError`. After a valid
candidate enters execution, expected source, guard, constraint, and handoff
failures resolve to a receipt; an uncertain handoff resolves with
`outcome: 'unknown'` rather than throwing.

A replay callback may run after its operation has been reserved. If that replay
throws, the operation resolves to a rejected receipt with
`transaction.unexpected_failure` so the reservation reaches a final state.
Callbacks must therefore be pure and replayable. Use `snapshot.reject(issue)`
for an expected data-dependent refusal such as an occupied idempotency key;
the rejection is reevaluated on replay and produces an ordinary rejected
receipt without mutation. Exceptions remain programmer or unexpected-failure
evidence.

Independent databases cannot share an atomic transaction. When partial
completion is intentional, `executeDatabaseNonAtomicBatch` from
`@tarstate/core/transactions` runs ordinary database transaction callbacks in
sequence and retains each exact nested receipt. Its `stop | continue` policy
controls only future callbacks: it promises no rollback, workflow persistence,
or cross-source retry. Portable transaction attempts continue to use
`executeNonAtomicBatch`; both paths share the same outcome semantics.
Official live databases expose immutable `sourceId` and `attachmentId` fields
for these step declarations; applications do not reproduce adapter defaults.

## Atomic external-store database

`openExternalStoreDatabase` is the ordinary relational path for host state that
can compare and replace one immutable state synchronously. Supply the same exact
declaration and embedded schema, mapping, and constraint artifacts used by other
attached databases:

```ts
import {
  mappedRelationRows,
  openExternalStoreDatabase
} from '@tarstate/core/database/external-store';

const opened = await openExternalStoreDatabase({
  sourceId: 'source:presence',
  store: atomicStore,
  declaration,
  embeddedArtifacts,
  authorityScope: 'workspace.presence'
});

if (!opened.success) throw new Error(opened.issues[0]?.code);
const presence = opened.value;

const current = presence.getSnapshot();
if (current.state === 'open' && current.current.readiness === 'ready') {
  const paneRows = mappedRelationRows(current.current, panes);
  // paneRows retains the exact schema row type and projected object identities.
}

await presence.transact({ kind: 'select-pane', paneId }, snapshot =>
  snapshot.withRows(panes, applySelection(snapshot.rows(panes), paneId))
);
```

The transform is pure and may replay if the store changes before publication.
Tarstate stages copy-on-write JSON-tree edits, projects and validates the
candidate, then commits against the exact external-store basis. Concurrent host
updates are preserved by replay; they are not CRDT-merged. State must be plain
immutable data and store actions must remain outside it. JSON-tree mappings may
use map keys, stored keys, literals, and collection positions; stable generated
element identity is deliberately unavailable for plain JSON.

The standard opener owns runtime leasing and transaction plumbing. Pass a
`hostRegistry` only when the application needs an explicit isolation/lifetime
boundary. `acquireExternalStoreRuntime` remains the lower-level seam for
framework adapters and non-relational host state.

`createMemoryAtomicExternalStore(initialState)` supplies the small reference
store for ephemeral application state and tests; it needs no separate
`storeIdentity`. A wrapper adapter supplies `storeIdentity` only when its stable
underlying store differs from the wrapper object.

`mappedRelationRows` verifies the result's exact schema artifact before
selecting a relation. It returns a stable native readonly array for repeated
reads of the same immutable result and does not replace the caller's explicit
readiness or completeness check.

## Database query sessions

Applications query database sources through one owned session. Authority,
membership expectations, discovery edges, and dataset settlement remain
explicit policy; catalog, database, observer, incremental maintenance, leases,
and reverse-order cleanup are mechanical and remain inside the session:

```ts
const plan = await prepareTypedQuery(query, {
  registryFingerprint,
  authorityFingerprint,
  datasetId: 'primary'
});
const session = await openDatabaseQuery({
  sources: [{
    source: databaseSource
  }],
  plan,
  queryAuthorityScope: authorityScope
});

// One idempotent close owns the complete query lifecycle.
session.close();
```

Sources are required by default, and the default read policy permits only a
source whose authority scope exactly matches `queryAuthorityScope`. Specify
`expectation`, `discoveryEdges`, or `canRead` only when application policy
differs.

A known source that is not currently mountable remains explicit evidence in the
same list: `{ unresolved: { attachmentId, sourceId } }`. A required unresolved
source makes the snapshot incomplete; Tarstate never fetches it or silently
treats it as an empty relation.

When rows in one source link to other sources, the same session can maintain
the reachable source set. A source-link query returns `linkId`,
`originSourceId`, `targetSourceId`, optional `targetAttachmentId`, and optional
`expectation` (`required` by default):

```ts
const link = typedFrom(sourceLinks, 'link');
const sourceLinkQuery = typedSelect(link, 'sourceLink', ({ link }) => ({
  linkId: link.row.linkId,
  originSourceId: typedSourceOf(link),
  targetSourceId: link.row.targetSourceId
}));
const sourceLinkPlan = await prepareTypedQuery(sourceLinkQuery, queryScope);

const session = await openDatabaseQuery({
  sources: [{ source: rootSource }],
  plan: applicationPlan,
  queryAuthorityScope: authorityScope,
  followSourceLinks: {
    plan: sourceLinkPlan,
    budget: {
      maxLinkedSources: 1_000,
      maxDiscoveryEdges: 4_000,
      maxDepth: 32,
      maxTraversalSteps: 10_000
    },
    openSource: ({ sourceId, attachmentId, signal }) =>
      sourceStore.open({ sourceId, attachmentId, signal })
  }
});

// Wait for recursive membership to reach a fixed point without interpreting
// diagnostic issue codes. Missing or invalid sources remain ordinary result
// evidence; cancellation rejects with an AbortError.
const settled = await session.whenSettled();
```

Portable provenance remains typed as `string | undefined`; the discovery
boundary accepts that honest type and diagnoses a candidate at runtime if its
origin is actually absent.

The opener translates portable source identity into a newly opened source with
`mount()` and idempotent `close()` methods. Its lifetime transfers to the
session; Tarstate owns fixed-point traversal, deduplication, cycles, readiness,
cancellation, mount detachment, and source cleanup. Explicit root sources remain
caller-owned. A required link makes the application query
incomplete while it opens and invalid if resolution fails. Removing the
last reachable link aborts pending work and closes its mounted subtree. The
source-link query and application query must use the same dataset, registry,
and authority fingerprints.

The graph budget is evaluated before opening sources and is independent of
asynchronous completion order. Exceeding it produces `limited` source evidence
and an incomplete result, never a silently truncated graph. An adapter that
already has parse or policy issues may return `{ state: 'failed', issues }`
from `openSource`; Tarstate retains those issues under the linked source.
Thrown exceptions remain generic opening failures.

Portable bytes remain tagged base64url values at relational boundaries. Use
`safeMaterializePortableBytes(value)` from `@tarstate/core/values` when a host
specifically needs a `Uint8Array`; malformed data returns `ParseResult` issues
rather than throwing. `toPortableBytes(bytes)` performs the inverse canonical
conversion.

A storage layout that deliberately has no physical representation for an
optional logical field maps it as `{ kind: 'absent' }`. Required fields cannot
use this mapping. Absent fields are omitted from projection and physical
footprints, and attempts to write them are rejected as read-only.

Adapter authors import `prepareManualReadOnlyAttachment`,
`prepareDatabaseAttachment`, and `createAttachmentTransactionService` from
`@tarstate/core/attachment/adapter`. Custom adapters implement the small
structural `MountableDatabaseSource` protocol; the executable quickstart contains a
complete implementation. Applications using an official adapter do not need
this construction seam. Official adapters may compose their service, source,
projection, catalog mounts, and cleanup with `createLiveAttachmentDatabase`
from `@tarstate/core/database/adapter`; this is not an alternative application
transaction API. A database returned by `openAutomergeDatabase`
already conforms, and its live database projection and replayable write
projection are the same conflict-aware mapping. `AttachmentCatalog`,
`DatasetMembership`, and `createDatabaseView` remain available as lower-level
host primitives for dynamic dataset runtimes rather than ordinary application
setup.

## Shared maintenance

`createIncrementalDatabaseQueryMaintenance` automatically reuses exact shared
subplans across live queries in the same database and dataset. Sharing is
conservatively isolated by authority, registry, and the complete bound parameter
set; parameter values are never exposed through diagnostics. One dataset capture
updates the shared work before observer callbacks run.

`database.getQueryMaintenanceDiagnostics()` exposes frozen physical reuse
and lifecycle counters when the built-in maintenance factory is active. An empty
list can also mean there are no active shared cohorts. Seek, recursion,
expression subqueries, divergent input streams, custom factories, and
incompatible cohorts safely use isolated maintenance sessions.
`getQueryMaintenanceReuseDiagnostics()` reports how often active runtimes computed
or reused relation deltas across parameter cohorts; custom factories report zeroes.

## Property tests and replay

`pnpm --filter @tarstate/core test:fuzz` runs both deterministic seeded
state-machine checks and shrinking fast-check properties. Every test gets a
seed derived from its stable name, so adding or reordering another test does
not change its generated cases. Increase coverage with
`TARSTATE_FUZZ_RUNS=1000`.

Set `TARSTATE_FUZZ_PROPERTY` to either kind of test's exact name to run it in
isolation. Fast-check failures additionally print a shrink path; replay one
minimized case by supplying its exact property name, seed, and path:

```sh
TARSTATE_FUZZ_PROPERTY=canonical-json-round-trip \
TARSTATE_FUZZ_SEED=123456789 \
TARSTATE_FUZZ_PATH='4:2:0' \
pnpm --filter @tarstate/core test:fuzz
```

Omit `TARSTATE_FUZZ_PATH` to rerun every generated case for that property and
seed. Deterministic state-machine tests do not use a shrink path.
`TARSTATE_FUZZ_SEED` acts as the suite's base seed when no property is selected.

## Performance contracts

From the repository root, `pnpm check:perf` runs the coarse release budget and
the repeated query-scaling suite. Query timings are reported as medians; the
enforced contracts are conservative relative-speed, physical-node selectivity,
and sampled-allocation ceilings rather than machine-specific absolute timings.
Use `pnpm bench:query` when iterating on query maintenance and include its JSON
output when changing a performance-sensitive execution path.
