# @tarstate/core

Portable artifacts, schemas, query evaluation, transactions, source protocols,
database observations, and incremental maintenance for Tarstate v1.

Install the downloaded release tarball directly:

```sh
npm install ./tarstate-core-0.4.1.tgz
```

## Choose the application path

Most applications should make one choice based on where their data lives:

- For a writable Automerge document, start with
  `openAutomergeDatabase` from `@tarstate/automerge`. It owns attachment
  preparation, keyed relation diffs, replay after multiplayer changes,
  validation, and publication.
- For pure in-memory query evaluation, import the typed builders and
  `evaluateQuery` from `@tarstate/core/query`.
- For live observation over host-owned sources, prepare a typed query and use
  `DatabaseView` from `@tarstate/core/database`.

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
| `@tarstate/core/database/incremental` | Explicit adapter from database observation to incremental query maintenance |
| `@tarstate/core/database/external-store` | Framework-neutral external-store runtime bridge |
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

`typedFrom`, `typedWhere`, `typedJoin`, and `typedSelect` cover the common path
while preserving exact aliases, parameters, and result rows. Advanced queries
use the exhaustive `Expr` and `QueryNode` unions directly, optionally composed
with the functional builders. This is an explicit authoring boundary; runtime
evaluation never falls back from typed to untyped behavior.

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
Callbacks must therefore be pure, replayable, and use returned logical rows—not
exceptions—for ordinary product behavior.

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

Adapter authors import `prepareManualReadOnlyAttachment`,
`prepareDatabaseAttachment`, and `createAttachmentTransactionService` from
`@tarstate/core/attachment/adapter`. Custom adapters implement the small
structural `MountableDatabaseSource` protocol; the executable quickstart contains a
complete implementation. Applications using an official adapter do not need
this construction seam. A database returned by `openAutomergeDatabase`
already conforms, and its live database projection and replayable write
projection are the same conflict-aware mapping. `AttachmentCatalog`,
`DatasetMembership`, and `DatabaseView` remain available as lower-level host
primitives for dynamic dataset runtimes rather than ordinary application setup.

## Shared maintenance

`createIncrementalDatabaseQueryMaintenance` automatically reuses exact shared
subplans across live queries in the same database and dataset. Sharing is
conservatively isolated by authority, registry, and the complete bound parameter
set; parameter values are never exposed through diagnostics. One dataset capture
updates the shared work before observer callbacks run.

`DatabaseView.getQueryMaintenanceDiagnostics()` exposes frozen physical reuse
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
