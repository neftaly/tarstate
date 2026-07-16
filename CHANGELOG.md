# Changelog

Notable changes to Tarstate are recorded here. Dates use the repository's Git
history.

## [Unreleased]

### Fixed

- `DatabaseView.observe` now infers the exact result-row type carried by a
  typed prepared plan while preserving the database row type as the fallback
  for ordinary prepared plans.

## [0.4.0] - 2026-07-16

### Breaking changes

- The `@tarstate/core` root now contains only portable foundation values.
  Runtime features move to explicit topic imports such as
  `@tarstate/core/query`, `@tarstate/core/database`,
  `@tarstate/core/schema`, and `@tarstate/core/transactions`.
- Removed parallel owned, sealed, and adapter fast-path execution exports.
  Normal query evaluation automatically reuses prepared plans, and attachment
  transactions optimize one public operation path internally.
- Replaced the public low-level Automerge adapters with
  `openAutomergeAttachment`. Applications no longer construct bindings,
  execution contexts, canonical-key indexes, or transaction syntax.
- Transaction sources must implement staged-basis publication. The removed
  memory executor and legacy Automerge adapter paths are no longer supported.

### Added

- Added replayable attachment transactions that derive exact keyed relation
  deltas from before/after logical rows and expose the same callback through
  `transact` and non-mutating `simulate` operations.
- Added conflict-aware Automerge value adoption without `toJS()` or JSON
  round-tripping, plus reconciliation that replays a pure operation when
  multiplayer heads change before publication.
- Added live logical snapshots, subscriptions, and database-catalog mounting to
  the standard Automerge attachment. Reads, constraints, simulation, and writes
  now share one conflict-aware projection.
- Live and mounted projections now evaluate required and audit constraints for
  initial and remotely received Automerge states. Narrow mount leases expose
  dataset identity without leaking the raw source or document.
- Standard logical constraint queries now receive stable occurrence, source,
  attachment, and basis provenance.
- Embedded attachment artifacts may be arrays or exact ID-keyed records, and
  logical constraint sets no longer require a host query callback.
- Added exact artifact resolution, prepared attachment-to-transaction-service
  composition, and source-neutral staged transaction intent.
- Added architecture, packed-entry, duplicate-package identity, clean-install,
  Automerge multiplayer, and transaction performance release gates.

### Changed

- Distribution remains tarball-only: every package is marked private and the
  release verifier rejects manifests that could be published accidentally.
- Reduced query-maintenance traversal and allocation churn, including selective
  pooled updates, reducer and distinct maintenance, joins, windows, ordering,
  and observer publication.
- Query results use native readonly arrays through the normal evaluation API;
  consumers no longer select a separate array fast path.
- Split deterministic unit coverage from shrinking invariant and state-machine
  fuzz suites so ordinary development checks remain fast and fuzz failures are
  independently replayable.
- Organized query, attachment, and Automerge implementation files by domain
  without changing the documented topic entry points.
- Sealed schemas now preserve their exact body type, so relation and reference
  types can be inferred directly from one plain-JSON schema artifact.
- Restored the README's concise query example and self-contained JSON schema,
  and moved TypeScript generation guidance after the React example.

## [0.3.0] - 2026-07-13

### Changed

- Prepared and typed query boundaries now own and freeze portable inputs, with
  stricter authority, registry, dataset, and attachment isolation.
- Incremental query maintenance now shares exact subplans and incrementally
  maintains reducers, extrema, windows, joins, and high-cardinality distinct
  queries under explicit performance contracts.
- Observer, source, Automerge, React, schema-tooling, and release-package
  boundaries gained stronger failure semantics, diagnostics, compatibility
  coverage, fuzzing, and clean-install verification.
- Public core topic entry points and adapter compatibility policies were
  documented for the `0.3.0` release.
- Query contracts and expression/diff helpers, observer dataset capture, and
  React stores now live in cohesive internal modules behind unchanged public
  entry points.
- Added an executable, release-gated end-to-end quickstart and direct tarball
  installation guidance for every public package.
- React now preserves generic row values as opaque identities across live,
  server, and optimistic snapshots while owning optimistic container arrays.

## [0.2.2] - 2026-07-12

### Changed

- Improved pooled incremental-maintenance scheduling, ordering, recovery, and
  lifecycle isolation.

## [0.2.1] - 2026-07-12

### Added

- Shared incremental-maintenance subplans across compatible live queries.

### Fixed

- Stabilized Automerge snapshots and hardened shared-runtime failure recovery.

## [0.2.0] - 2026-07-11

### Added

- Introduced occurrence-aware differential query maintenance for the v1 API.
- Added query-scaling, allocation, and runtime-invariant fuzz coverage.

### Changed

- Hardened relational, source, transaction, typed-query, and differential
  maintenance contracts for the v1 architecture.

[Unreleased]: https://github.com/neftaly/tarstate/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/neftaly/tarstate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/neftaly/tarstate/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/neftaly/tarstate/compare/c324fdb...v0.2.2
[0.2.1]: https://github.com/neftaly/tarstate/compare/v0.2.0...c324fdb
[0.2.0]: https://github.com/neftaly/tarstate/releases/tag/v0.2.0
