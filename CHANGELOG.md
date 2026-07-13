# Changelog

Notable changes to Tarstate are recorded here. Dates use the repository's Git
history; the current `0.3.0` package version remains unreleased until it is
tagged.

## [Unreleased]

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
  documented for the pending `0.3.0` release.
- Query contracts and expression/diff helpers, observer dataset capture, and
  React stores now live in cohesive internal modules behind unchanged public
  entry points.
- Added an executable, release-gated end-to-end quickstart and direct tarball
  installation guidance for every public package.

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

[Unreleased]: https://github.com/neftaly/tarstate/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/neftaly/tarstate/compare/c324fdb...v0.2.2
[0.2.1]: https://github.com/neftaly/tarstate/compare/v0.2.0...c324fdb
[0.2.0]: https://github.com/neftaly/tarstate/releases/tag/v0.2.0
