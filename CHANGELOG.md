# Changelog

Notable changes to Tarstate are recorded here. Dates use the repository's Git
history.

## [0.4.10] - 2026-07-18

### Added

- Writable databases now expose prepared relation write capabilities without
  requiring consumers to inspect storage-mapping artifacts.
- Adapter implementors can compose source-neutral live database observation,
  mounting, and cleanup through `@tarstate/core/database/adapter`.

### Changed

- Logical edits that are valid but cannot be represented by the prepared
  source now resolve as rejected simulation or commit receipts. Programmer
  misuse and invalid transform ownership remain exceptions.
- Replayable attachment authoring is isolated as a pure logical-state core,
  including rejection evidence discovered after multiplayer reconciliation.

## [0.4.9] - 2026-07-17

### Added

- Added a narrow `@tarstate/schema-tools/artifact-bundle` runtime catalog that
  parses generated bundles once, performs exact typed lookup, and derives the
  minimal deterministic artifact closure for a named document declaration.

### Fixed

- Portable artifact-build records now preserve hostile but valid names such as
  `__proto__` without prototype-setter confusion.

## [0.4.8] - 2026-07-17

### Fixed

- Generated relation constants now retain their schema-body type through
  database transaction methods, preserving exact row and generated-key
  inference for artifact-binding consumers.

## [0.4.5] - 2026-07-17

### Changed

- Sparse query maintenance now uses its private stable-position evidence for
  scheduler equality and operator layout checks, avoiding redundant full-row
  scans and temporary dependency arrays without adding a public fast path.
- Portable byte materialization now preserves its concrete
  `Uint8Array<ArrayBuffer>` ownership in the public type, so browser consumers
  can construct `Blob` values without a defensive copy.

## [0.4.4] - 2026-07-17

### Added

- Added abortable query-session settlement and a narrow portable-bytes topic
  for canonical native byte conversion.
- Optional schema fields may be explicitly absent from storage mappings while
  remaining excluded from read and write footprints.

## [0.4.3] - 2026-07-17

### Fixed

- Followed database sources now retain their owned lifetimes until the final
  query lease closes.

## [0.4.2] - 2026-07-17

### Added

- Added live source-link discovery with bounded fixed-point traversal and
  settlement-aware query sessions.

## [0.4.1] - 2026-07-17

### Breaking changes

- `projectStorage` now accepts one named options object instead of positional
  registry, source, and relation-selection arguments. Adapter-specific scalar
  decoding is an optional callback on that same options object.
- Renamed the application-facing Automerge entry point and result from
  `openAutomergeAttachment`/`AutomergeAttachment` to
  `openAutomergeDatabase`/`AutomergeDatabase` so the primary API names the
  capability consumers use rather than its internal catalog mechanism.
- Constraint-set artifact authoring now lives at the self-describing
  `@tarstate/core/artifacts/constraint-set` topic rather than coupling the
  schema topic to the query model.
- Replayable database transforms now receive one immutable schema-aware
  snapshot. `rows(relation)` returns inferred logical rows and
  `withRows(relation, rows)` carries every untouched relation forward, replacing
  the flat `{ relationId, fields }[]` callback contract.

### Added

- Added `openDatabaseQuery`, an owned query session over the small structural
  mount protocol implemented by official and application database sources. It owns
  catalog, membership, database, observer, maintenance, leases, and idempotent
  reverse-order cleanup while retaining explicit authority and membership
  policy.
- Added root-object singleton storage mappings with explicit literal logical
  keys. The Automerge adapter projects and replaces native byte fields through
  one bidirectional scalar boundary without replacing unrelated document
  metadata, and reads Automerge `ImmutableString` fields as ordinary logical
  strings without changing their declared writability.

### Changed

- Preserved consumer-facing module boundaries in core, React, and schema tools,
  split canonical JSON/hash helpers from artifact parsing, and separated typed
  query preparation and React lifecycle shells from their functional authoring
  and hook cores. Representative single-export bundle sizes are now checked in
  `pnpm check`.
- Enabled TypeScript 7 erasable-syntax and stricter control-flow checks; runtime
  enums, namespaces, parameter properties, and import-assignment syntax are now
  rejected by the compiler configuration.

### Fixed

- Functional `from()` now projects schema-aware relation literals to minimal
  portable relation uses, and constraint-set sealing accepts query nodes
  directly without consumer-side `JsonValue` casts, derives syntactic relation
  dependencies, and verifies explicit dependency supersets.
- Query dependency analysis now walks query and expression syntax explicitly,
  so kind-like application JSON no longer causes false relation or seek
  invalidation.
- `DatabaseView.observe` now infers the exact result-row type carried by a
  typed prepared plan while preserving the database row type as the fallback
  for ordinary prepared plans.
- Singleton Automerge mappings declare exact mapped-field dependencies, so
  unrelated root metadata changes reuse the existing logical projection and do
  not create false transaction overlap. Generic edit footprints now also
  include stored key and mirror paths.

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

[Unreleased]: https://github.com/neftaly/tarstate/compare/v0.4.5...HEAD
[0.4.5]: https://github.com/neftaly/tarstate/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/neftaly/tarstate/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/neftaly/tarstate/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/neftaly/tarstate/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/neftaly/tarstate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/neftaly/tarstate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/neftaly/tarstate/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/neftaly/tarstate/compare/c324fdb...v0.2.2
[0.2.1]: https://github.com/neftaly/tarstate/compare/v0.2.0...c324fdb
[0.2.0]: https://github.com/neftaly/tarstate/releases/tag/v0.2.0
