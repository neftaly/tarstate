# Tarstate v1 conformance matrix

Status: v0.3.0 release evidence. Date: 2026-07-13.

This matrix is the self-contained index of production release gates and their
executable evidence. A complete gate means the in-repository contract in
[README.md](README.md) is implemented and tested; it does not broaden that
contract's explicit exclusions or the scope records in
[decisions.md](decisions.md).

| Gate | Status | Primary executable evidence |
| --- | --- | --- |
| 1. Artifacts | Complete | `core/foundation.test.ts` covers canonical round trips, exact hashes and dependencies, registry fingerprints, duplicate JSON members, hostile shapes, and budgets. `core/semantic-artifact-parsers.test.ts` applies the same total boundary to all five semantic artifact families. |
| 2. Values/storage parsing | Complete | `core/schema-production.test.ts` covers missing versus null, custom codecs, unknown storage preservation, duplicate candidates, map-key mismatch, and codec failure. |
| 3. Query semantics/identity | Complete | `core/foundation.test.ts`, `core/query.test.ts`, and `core/golden-workloads.test.ts` cover full truth tables, bag multiplicity, empty aggregates, deterministic order/window ties, keyed recursion and the cyclic Patchpit graph, budgets, basis/membership cursors, and occurrence identity across replacement/reincarnation. |
| 4. Incremental equivalence | Complete | `core/incremental-query.test.ts` compares the differential operator graph with the independent pure oracle for every relational operator, expression family, and aggregate family across inserts, removals, updates, reordering on both join sides, duplicate occurrences, reincarnation, exact/lower-bound/unknown transitions, basis and membership changes, rejected evidence, and recovery. `core/fuzz-properties.test.ts` generates two-sided mixed changes across local, join, aggregate, distinct, set, order, and window operators. It also proves unrelated branches are untouched and propagation stops when an operator output is unchanged. `core/database-observer.test.ts` proves the production observer owns one IVM session and recovers through source invalidation without an oracle fallback. |
| 5. Lineage/planning/rekey | Complete | `core/query.test.ts`, `core/source-protocol.test.ts`, `core/production-transaction.test.ts`, `core/schema-production.test.ts`, `core/database-observer.test.ts`, and `automerge/core-adapter.test.ts` cover self-join lineage, all footprint relations, permutation-invariant n-ary merging, ambiguous bindings/inverses, exact rekey plus declared ref rewrite/rejection, and authority-scoped caches. |
| 6. Source transactions | Complete | `packages/core/tests/production-transaction.test.ts`, `packages/core/tests/source-protocol.test.ts`, `packages/core/tests/support/restartable-source.ts`, `packages/automerge/tests/core-adapter.test.ts`, and `packages/automerge/tests/production-automerge.test.ts` cover statement order/Halloween prevention, bases, serialization/reentrancy, no-ops, constraints, conflicts, cancellation, epochs/IDs, retained rejection, edit mechanisms, and a serialized reservation/mutation/result recovered after both persistence-shell and source recreation. |
| 7. Constraints/governance | Complete | `packages/core/tests/attachment-preparation.test.ts`, `packages/core/tests/constraint-artifact.test.ts`, `packages/core/tests/production-transaction.test.ts`, `packages/core/tests/semantic-artifact-parsers.test.ts`, `packages/core/tests/lifecycle-governance.test.ts`, `packages/automerge/tests/production-automerge.test.ts`, and `packages/automerge/tests/metadata.test.ts` cover dirty and indeterminate state, locally valid peers merging into duplicate-key ambiguity, old-executor capability refusal/read-only attachment derivation, metadata conflict, exact repair, and activation. |
| 8. Discovery/bootstrap | Complete | `packages/core/tests/attachment-preparation.test.ts`, `packages/core/tests/database-observer.test.ts`, `packages/core/tests/system-relations.test.ts`, and `packages/automerge/tests/metadata.test.ts` cover alias chains, cycles, missing/denied/stale states, bounded authority caches, bootstrap absence/collision/conflict, the explicit read-only out-of-band override, derived attachment availability/writability, dataset scoping, system schemas, negative-query suppression while membership is open, and production IVM invalidation/recovery. |
| 9. Automerge movement boundary | Complete (scope revised by D-003) | `automerge/production-automerge.test.ts`, `automerge/core-adapter.test.ts`, `automerge/metadata.test.ts`, `automerge/system-relations.test.ts`, and `automerge/public-surface.test.ts` cover duplicate candidates, explicit conflict resolution, convergence, neutral remote-head observation, rejection of contradictory equal-time evidence, absence of a built-in move surface/capability and Tarstate move metadata, pre-mutation missing-capability refusal, and preservation without interpretation of app-owned unknown records. Experimental copy-relocation tests are historical spike evidence, not production conformance. |
| 10. External stores | Complete | `core/external-store.test.ts` and `zustand/external-store.test.ts` cover hydration races/equal data, middleware/actions, external/direct updates, host runtime sharing, exact revisions, no-ops, and one coherent notification for Zustand and TanStack Store. |
| 11. React | Complete | `packages/core/tests/database-observer.test.ts`, `packages/react/tests/react.test.ts`, and `packages/react/tests/type-contract.test.ts` cover cached snapshots, independent leases/last close, basis changes, selectors, StrictMode, current versus `lastExact`, invalidation, external ownership, SSR, immutable optimistic apply/rebase/receipt removal, presentation-error isolation from authoritative commits, and preservation of prepared row/parameter types. |
| 12. Golden workloads | Complete | `packages/core/tests/golden-workloads.test.ts` runs the five explicitly labelled semantic fixtures, routing every query-bearing portion through the production IVM path. This includes an incremental Probability scene/external-store update and the actual Patchpit source-lifecycle plus stale-basis link failure, producing a partial sequence receipt that names the orphan. Broader CljIdle, RealWorld, and collaborative-feed ports remain compatibility gates, not core-v1 gates. |
| 13. Agent surface | Complete | `schema-tools/schema-tools.test.ts`, `core/semantic-artifact-parsers.test.ts`, `core/system-relations.test.ts`, `core/production-transaction.test.ts`, and `core/lifecycle-governance.test.ts` cover authority-filtered descriptions, safe commands, catalogs, simulation, capability escalation, denial, and structured receipts. |
| 14. DX/performance | Complete | `packages/core/tests/type-authoring.test.ts`, `packages/core/type-fixtures/authoring-budget.ts`, `packages/react/tests/type-contract.test.ts`, `packages/schema-tools/tests/schema-tools.test.ts`, `packages/core/tests/incremental-query.test.ts`, and resolver/observer retention tests cover inference/errors, hash-bound generation, compiler/declaration limits, explicit cache/refcount/subscription bounds, differential update/propagation counts, coherent dataset-level refresh, and structurally shared cross-query subplans with isolated cohorts and deterministic eviction. `pnpm bench` retains the loose golden-workload ceiling selected in D-002; `pnpm bench:query` reports pure, direct-delta, snapshot-diff, equijoin, global-operator, recursion, and allocation scaling without machine-dependent pass thresholds. |
| 15. Compatibility | Complete (scope revised by D-003) | `packages/core/tests/foundation.test.ts`, `packages/core/tests/receipts.test.ts`, `packages/automerge/tests/metadata.test.ts`, and `packages/automerge/tests/public-surface.test.ts` cover exact generic capability graphs/upgrades, unknown receipt forwarding, unknown metadata preservation, and the absence of built-in Automerge move capabilities/readers/writers. App-owned move records remain uninterpreted application data; Tarstate promises no legacy/current move-record interoperability. |

## Release verification

`pnpm check:release` is the release gate. It runs lint, workspace typechecking,
the structural compiler budget, all builds and tests, the coarse runtime ceiling,
declaration consumption, and pack verification for all five public packages. Pack verification requires
dist-only JavaScript/declarations, a README and license, resolved workspace
dependency versions, and successful runtime imports.

`pnpm bench` runs the five staged golden workloads after build and fails above
its loose ceiling. It is a gross regression signal, not a claim of legacy
performance parity. `pnpm bench:query` is a release-gated structural and GC
diagnostic with conservative relative-time, selectivity, and sampled-allocation
contracts. The immutable
legacy reference remains the `legacy-v0-final` tag at commit `25f707c`.

Publishing packages, creating a Git tag/release, and claiming compatibility for
the three excluded external app ports are operational follow-ups, not hidden
requirements of this source checkpoint.
