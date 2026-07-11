# @tarstate/core

Portable artifacts, schemas, query evaluation, transactions, source protocols,
database observations, and incremental maintenance for Tarstate v1.

## Query authoring

`typedFrom`, `typedWhere`, `typedJoin`, and `typedSelect` cover the common path
while preserving exact aliases, parameters, and result rows. Advanced queries
use the exhaustive `Expr` and `QueryNode` unions directly, optionally composed
with the functional builders. This is an explicit authoring boundary; runtime
evaluation never falls back from typed to untyped behavior.

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
