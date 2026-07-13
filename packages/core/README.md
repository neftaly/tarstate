# @tarstate/core

Portable artifacts, schemas, query evaluation, transactions, source protocols,
database observations, and incremental maintenance for Tarstate v1.

## Imports

The package root remains the complete, compatibility-stable surface. For
focused modules and clearer dependency boundaries, the same public values are
also available through topic entry points:

| Entry point | Responsibility |
| --- | --- |
| `@tarstate/core/artifacts` | Portable envelopes, parsing, capabilities, issues, and resolution |
| `@tarstate/core/schema` | Schemas, codecs, constraints, mappings, lenses, and typed authoring |
| `@tarstate/core/query` | Query builders, evaluation, preparation, and incremental maintenance |
| `@tarstate/core/database` | Observation, source protocols, host runtimes, and maintenance contracts |
| `@tarstate/core/transactions` | Writes, commit coordination, receipts, and lifecycle governance |

Topic entry points are additive aliases: importing from `@tarstate/core`
continues to work, and a value exported through both paths has the same runtime
identity. Internal maintenance-pool APIs and conformance fixtures are not made
public by these entry points.

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

For repeated pure evaluation outside an observer, call
`evaluatePreparedQuery(plan, { relations, parameters, functions })`. It reuses
the plan's already-owned query AST while continuing to detach and freeze every
changing input. Use `evaluateQuery({ root, ...inputs })` at arbitrary or
untrusted query ingress; its full request, including the AST, is adopted on
every call.

## Minimal database assembly

`DatabaseView` is the imperative shell around host-owned sources and authority
policy. A minimal read path consists of a catalog, one prepared attachment, a
dataset membership, and a maintenance factory:

```ts
const catalog = new AttachmentCatalog();
const attachmentLease = catalog.attach(attachment);
const membership = new DatasetMembership({
  datasetId: 'primary',
  state: 'settled',
  members: [{
    attachmentId: attachment.attachmentId,
    sourceId: attachment.sourceId,
    expectation: 'required',
    discoveryEdges: []
  }]
});
const database = new DatabaseView({
  authorityScope,
  authorityFingerprint,
  registryFingerprint,
  attachments: catalog,
  datasets: [membership],
  canRead,
  createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
});
const plan = await prepareTypedQuery(query, {
  registryFingerprint,
  authorityFingerprint,
  datasetId: 'primary'
});
const observer = database.observe({ plan });
```

Use `prepareManualReadOnlyAttachment` for an already trusted projection, or
`prepareDatabaseAttachment` when artifacts and capabilities must be validated.
The host closes the observer, database, and attachment lease; none owns the
others. Registries and authority checks remain explicit because they are policy,
not construction defaults.

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

`pnpm --filter @tarstate/core test:fuzz` runs both the deterministic seeded
state-machine checks and shrinking fast-check properties. Each property gets a
seed derived from its stable name, so adding or reordering another property
does not change its generated cases. Increase coverage with
`TARSTATE_FUZZ_RUNS=1000`.

On failure, fast-check prints a seed and shrink path. Replay only that minimized
case by supplying its exact property name, seed, and path:

```sh
TARSTATE_FUZZ_PROPERTY=canonical-json-round-trip \
TARSTATE_FUZZ_SEED=123456789 \
TARSTATE_FUZZ_PATH='4:2:0' \
pnpm --filter @tarstate/core test:fuzz
```

Omit `TARSTATE_FUZZ_PATH` to rerun every generated case for that property and
seed. `TARSTATE_FUZZ_SEED` acts as the suite's base seed when no property is
selected.

## Performance contracts

From the repository root, `pnpm check:perf` runs the coarse release budget and
the repeated query-scaling suite. Query timings are reported as medians; the
enforced contracts are conservative relative-speed, physical-node selectivity,
and sampled-allocation ceilings rather than machine-specific absolute timings.
Use `pnpm bench:query` when iterating on query maintenance and include its JSON
output when changing a performance-sensitive execution path.
