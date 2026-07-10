# Tarstate v1 acceptance ledger

Status: normative release checklist. Baseline: `25f707c`.

This ledger preserves the acceptance conditions that existed before production
implementation. A gate may change only when reproducible implementation
evidence disproves an assumption or the owner explicitly changes scope. A
passing build alone cannot amend a gate.

The only approved scope decisions are:

- D-001: the legacy implementation remains outside the v1 runtime;
- D-002: performance is a coarse structural warning, not a microbenchmark goal;
- D-003: the built-in Automerge adapter owns no movement behavior or metadata.

D-004 is revoked. Incremental view maintenance is required for v1.

## Incremental view-maintenance gate

The production observer path MUST use a stateful incremental operator graph.
The pure evaluator is a test oracle and MUST NOT be a production fallback.

Acceptance requires exact maintenance for:

- values, aliases, projections, field extension, rename, omit, and unnest;
- where, inner/cross/left/semi/anti joins, and correlated subqueries;
- aggregate, distinct, union, union-all, intersect, and except with bag
  multiplicity;
- deterministic order, slice, basis-aware seek, rank, row-number, and lag;
- keyed linear monotone recursion with row and iteration budgets;
- every expression and aggregate family in the v1 query algebra;
- exact, lower-bound, unknown, invalidation, and recovery transitions.

Executable evidence MUST cover inserts, removals, updates, duplicate visible
rows, key reincarnation, basis-only changes, membership changes, and mixed
mutation sequences. Every maintained result is compared with the pure oracle.
Tests MUST prove that observer updates do not call the oracle or silently
recompute the complete query.

Source-specific change evidence MAY accelerate logical-delta derivation, but
adapter hints are never trusted without before/after basis validation. Missing,
stale, malformed, or rejected evidence must produce explicit behavior; it may
not select a hidden full-query fallback.

## Release gates

| Gate | Required evidence | Current status |
| --- | --- | --- |
| 1. Artifacts | Canonical round-trip, hashes, dependencies, duplicate members, hostile shapes, budgets | Complete |
| 2. Values and storage parsing | Missing/null/custom values, unknown preservation, duplicate candidates, map-key mismatch, codec failure | Complete |
| 3. Query semantics and identity | Truth tables, bags, aggregates, order, recursion, windows, cursors, occurrence identity | Complete oracle |
| 4. Incremental equivalence | Stateful maintenance for every operator and differential mutation sequences | Complete |
| 5. Planning and lineage | Self-joins, footprints, n-ary merge order, rekey/ref behavior, authority-scoped caches | Complete |
| 6. Transactions | Statement order, bases, concurrency, no-ops, constraints, cancellation, epochs, retained outcomes, restart recovery | Complete |
| 7. Constraints and governance | Dirty/indeterminate state, concurrent violation, metadata conflict, old executor, repair, activation | Complete |
| 8. Discovery and observation | Resolver lifecycle, bootstrap states, dataset scoping, system schemas, incomplete membership | Complete |
| 9. Automerge | Duplicate candidates, conflict resolution, convergence, system evidence; movement follows D-003 | Complete |
| 10. External stores | Hydration, middleware/actions, external updates, shared runtime, revisions, coherent notification | Complete |
| 11. React | Shared observers, selectors, StrictMode, invalidation, ownership, optimistic UI, SSR | Complete |
| 12. Golden workloads | Executable labelled fixtures and Patchpit partial-sequence recovery | Complete; rerun through IVM |
| 13. Agent surface | Authority-filtered descriptions, safe parsing, catalogs, simulation, escalation, receipts | Complete |
| 14. DX and performance | Type/declaration budgets, explicit lifetimes, coarse runtime ceiling, IVM structural measurements | Complete |
| 15. Compatibility | Exact capability graphs, receipt forwarding, metadata preservation; movement follows D-003 | Complete |

## Completion rule

V1 is complete only when every row above is complete, the IVM gate has direct
executable proof, the API/dead-path review has no unresolved material finding,
`pnpm check:release` passes, package tarballs pass consumption checks, and the
worktree contains no unexplained changes.
