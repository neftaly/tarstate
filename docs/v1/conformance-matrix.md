# Tarstate v1 conformance matrix

Status: v0.1.0 release evidence. Date: 2026-07-10.

This matrix maps every production gate in `implementation-entry.md` to
executable evidence. A checked gate means the in-repository v1 contract is
implemented and tested; it does not broaden the explicit exclusions in the
design packet.

| Gate | Status | Primary executable evidence |
| --- | --- | --- |
| 1. Artifacts | Complete | `core/foundation.test.ts` covers canonical round trips, exact hashes and dependencies, registry fingerprints, duplicate JSON members, hostile shapes, and budgets. `core/semantic-artifact-parsers.test.ts` applies the same total boundary to all five semantic artifact families. |
| 2. Values/storage parsing | Complete | `core/schema-production.test.ts` covers missing versus null, custom codecs, unknown storage preservation, duplicate candidates, map-key mismatch, and codec failure. |
| 3. Query semantics/identity | Complete | `core/foundation.test.ts`, `core/query.test.ts`, and `core/golden-workloads.test.ts` cover full truth tables, bag multiplicity, empty aggregates, deterministic order/window ties, keyed recursion and the cyclic Patchpit graph, budgets, basis/membership cursors, and occurrence identity across replacement/reincarnation. |
| 4. Incremental equivalence | Complete | `core/differential-maintenance.test.ts` compares every query-node family with the pure oracle across inserts, updates, deletes, and missing/stale/invalid/rejected hints. |
| 5. Lineage/planning/rekey | Complete | `core/query.test.ts`, `core/source-protocol.test.ts`, `core/production-transaction.test.ts`, `core/schema-production.test.ts`, `core/database-observer.test.ts`, and `automerge/core-adapter.test.ts` cover self-join lineage, all footprint relations, permutation-invariant n-ary merging, ambiguous bindings/inverses, exact rekey plus declared ref rewrite/rejection, and authority-scoped caches. |
| 6. Source transactions | Complete | `packages/core/tests/production-transaction.test.ts`, `packages/core/tests/source-protocol.test.ts`, `packages/core/src/restartable-source.ts`, `packages/automerge/tests/core-adapter.test.ts`, and `packages/automerge/tests/production-automerge.test.ts` cover statement order/Halloween prevention, bases, serialization/reentrancy, no-ops, constraints, conflicts, cancellation, epochs/IDs, retained rejection/cache eviction, edit mechanisms, and a serialized reservation/mutation/result recovered after both persistence-shell and source recreation. |
| 7. Constraints/governance | Complete | `packages/core/tests/attachment-preparation.test.ts`, `packages/core/tests/constraint-artifact.test.ts`, `packages/core/tests/production-transaction.test.ts`, `packages/core/tests/semantic-artifact-parsers.test.ts`, `packages/core/tests/lifecycle-governance.test.ts`, `packages/automerge/tests/production-automerge.test.ts`, and `packages/automerge/tests/metadata.test.ts` cover dirty and indeterminate state, locally valid peers merging into duplicate-key ambiguity, old-executor capability refusal/read-only attachment derivation, metadata conflict, exact repair, and activation. |
| 8. Discovery/bootstrap | Complete | `packages/core/tests/attachment-preparation.test.ts`, `packages/core/tests/database-observer.test.ts`, `packages/core/tests/system-relations.test.ts`, and `packages/automerge/tests/metadata.test.ts` cover alias chains, cycles, missing/denied/stale states, bounded authority caches, bootstrap absence/collision/conflict/out-of-band fallback, derived attachment availability/writability, dataset scoping, system schemas, and negative-query suppression while membership is open. |
| 9. Automerge moves | Complete | `automerge/production-automerge.test.ts`, `automerge/core-adapter.test.ts`, and `automerge/gate9-moves.test.ts` cover duplicate candidates, explicit conflict resolution, copy relocation, descendant mappings/unresolved list mappings, retained old-subtree edits, chains/cycles, convergence, legacy/current readers, and exact authority-gated live fork repair with immutable history. |
| 10. External stores | Complete | `core/external-store.test.ts` and `zustand/external-store.test.ts` cover hydration races/equal data, middleware/actions, external/direct updates, host runtime sharing, exact revisions, no-ops, and one coherent notification for Zustand and TanStack Store. |
| 11. React | Complete | `packages/core/tests/database-observer.test.ts`, `packages/react/tests/react.test.ts`, and `packages/react/tests/type-contract.test.ts` cover cached snapshots, independent leases/last close, basis changes, selectors, StrictMode, current versus `lastExact`, invalidation, external ownership, SSR, immutable optimistic apply/rebase/receipt removal, and preservation of prepared row/parameter types. |
| 12. Golden workloads | Complete | `packages/core/tests/golden-workloads.test.ts` runs the five explicitly labelled semantic fixtures and the actual Patchpit source-lifecycle plus stale-basis link failure, producing a partial sequence receipt that names the orphan. Broader CljIdle, RealWorld, and collaborative-feed ports remain compatibility gates, not core-v1 gates. |
| 13. Agent surface | Complete | `schema-tools/schema-tools.test.ts`, `core/semantic-artifact-parsers.test.ts`, `core/system-relations.test.ts`, `core/production-transaction.test.ts`, and `core/lifecycle-governance.test.ts` cover authority-filtered descriptions, safe commands, catalogs, simulation, capability escalation, denial, and structured receipts. |
| 14. DX/performance | Complete | `packages/core/tests/type-authoring.test.ts`, `packages/core/type-fixtures/authoring-budget.ts`, `packages/react/tests/type-contract.test.ts`, `packages/schema-tools/tests/schema-tools.test.ts`, resolver/observer retention tests, and `packages/core/tests/differential-maintenance.test.ts` cover inference/errors, hash-bound generation, compiler/declaration limits, explicit cache/refcount/subscription bounds, and oracle fallback. `pnpm bench` enforces the deliberately loose gross-regression ceiling selected in D-002. |
| 15. Compatibility | Complete | `packages/core/tests/foundation.test.ts`, `packages/core/tests/receipts.test.ts`, `packages/automerge/tests/metadata.test.ts`, and `packages/automerge/tests/gate9-moves.test.ts` cover exact capability graphs/upgrades, unknown receipt forwarding, unknown version preservation, and legacy/current move metadata. D-003 withholds native identity-preserving Automerge movement because Automerge 3.2.6 exposes no such operation. |

## Release verification

`pnpm check:release` is the release gate. It runs lint, workspace typechecking,
the structural compiler budget, all builds and tests, the coarse runtime ceiling,
declaration consumption, and pack verification for all five public packages. Pack verification requires
dist-only JavaScript/declarations, a README and license, resolved workspace
dependency versions, and successful runtime imports.

`pnpm bench` runs the five staged golden workloads after build and fails above
its loose ceiling. It is a gross regression signal, not a claim of legacy
performance parity. The immutable
legacy reference remains the `legacy-v0-final` tag at commit `25f707c`.

Publishing packages, creating a Git tag/release, and claiming compatibility for
the three excluded external app ports are operational follow-ups, not hidden
requirements of this source checkpoint.
