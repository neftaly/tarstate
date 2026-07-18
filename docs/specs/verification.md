# Verification and review strategy

## Evidence classes

Different claims need different evidence. A large unit suite cannot substitute
for concurrency integration, type tests, fuzz invariants, bundle checks, or
profiling.

| Claim | Primary evidence |
| --- | --- |
| Named public example and exact issue code | focused unit/integration test |
| Algebraic or state-machine invariant | property/fuzz test |
| Batch and incremental equivalence | differential fuzz/property test |
| Adapter publication ordering | integration plus failure injection |
| Multiplayer reconciliation | real Automerge branch/head integration |
| Type inference and rejected misuse | compile-time fixture |
| Dependency direction | negative architecture script |
| Tree shaking and package identity | built/packed consumer checks |
| Complexity and allocation target | benchmark/profile with correctness assertions |
| React subscription/identity | hook/store integration test |
| Release usability | clean tarball install and runtime import smoke |

## Unit versus fuzz

Keep a unit test when the case is a readable behavior example, regression with
a meaningful issue/receipt, public recipe, exact boundary, or rare branch whose
generator would obscure intent.

Prefer fuzz/property testing for:

- parse/adopt never-throw and ownership laws across broad portable values;
- canonical equality/order/hash laws;
- relation diff round trips and composite-key permutations;
- batch versus incremental query equivalence;
- lifecycle transition and listener/close sequences;
- source-link graph cycles, replacement, and convergence;
- transaction state authoring and replay invariants;
- JSON-tree path and mapping round trips;
- Automerge concurrency schedules and reconciliation candidates.

Do not mechanically convert every unit into fuzz. Preserve a small named
regression when it explains the defect; add a generalized property only when a
family of nearby failures exists.

## Combining fuzz suites

Combine properties when they share the same semantic model, generator,
shrinking strategy, and setup cost. This improves reuse and developer speed.

Keep them separate when failures need different replay artifacts, one property
has a much larger search space, adapter setup dominates differently, or a broad
generator makes shrinking unreadable. One giant “everything” fuzz suite is
slow, hard to shard, and poor diagnostic evidence.

Generators should produce owned domain values rather than invalid noise unless
the property tests a parser. Bias toward boundary values, duplicate/composite
keys, missing/null/unknown distinctions, lifecycle interleavings, contention,
and hostile depth/width. Every failure must print a reproducible seed/path.

## Differential and model testing

Reference semantics should be simpler than the optimized implementation:

- batch query evaluation is the oracle for incremental maintenance;
- a pure set/map model can check source-link membership;
- exact before/after relation states can check authored deltas;
- replay from current state can check optimistic source behavior;
- Automerge's native branch/merge result plus Tarstate projection can check
  captured-intent reconciliation.

Do not use the same helper on both sides of a differential assertion when that
helper contains the behavior under test.

## Failure injection

Exercise failure before and after every authority boundary: artifact
resolution, projection, author callback, constraint evaluation, staging,
reconciliation, conditional publication, outcome lookup, notification, and
cleanup.

For async work, inject abort and source change at each await-shaped boundary.
Verify both state and negative behavior: no premature canonical mutation, no
false committed receipt, no leaked listener, and no retry after a permanent
failure.

## TypeScript evidence

Type fixtures cover exact inference across package/module boundaries, rejected
key order and field names, query parameter merging, row result inference, and
framework hook types. `@ts-expect-error` assertions must fail if the misuse
starts compiling.

Track compiler types, instantiations, memory, and allocations. A type-level DX
improvement that causes disproportionate compiler work should be simplified.
Inspect emitted JavaScript when using TypeScript features with runtime output.

## Review lenses

Run these independently; combining them too early hides tradeoffs.

1. **Hostile correctness:** malformed/hostile input, concurrency, lifecycle,
   identity, authority, unknown outcomes, and proof gaps.
2. **Consumer DX:** number of concepts/imports/casts, discoverability, one safe
   path, diagnostics, and source-specific leakage.
3. **Functional core and coupling:** effect authority, duplicated facts,
   dependency direction, state ownership, module context, and replay purity.
4. **Performance and allocation:** asymptotics, invalidation, copies, freezes,
   closures/binds, diagnostics, retained memory, JS shapes, and React renders.
5. **Packaging:** public necessity, topic reachability, side effects, emitted
   output, type cost, packed duplicate identity, and release recipe.
6. **Test portfolio:** duplicated examples, missing properties, fuzz grouping,
   flaky timing, failure injection, and developer feedback speed.

## Ratchet and stopping rule

A review pass is one complete application of a named lens over the in-scope
surface. If it finds a material issue, address or record that issue and repeat
the same lens because the first finding is evidence that nearby assumptions may
also be wrong.

Stop that lens after a complete follow-up pass finds no new material issue.
Also stop when remaining items are explicitly deferred candidates with stated
evidence gates. Do not count partial rereads as passes or keep changing names to
manufacture progress.

## Required commands

Use a feedback ladder during development:

1. run the smallest focused test/type fixture for the changed contract;
2. run the affected package tests and typecheck;
3. run the relevant fuzz or performance workload when the change has those
   semantics;
4. run the complete handoff gate once the focused evidence is stable.

Share domain fixtures and generators when they reduce setup and keep failures
readable. Do not make every focused test construct a full database, Repo, or
React tree when a pure semantic boundary is sufficient. Conversely, do not mock
away the source/concurrency behavior an integration test exists to prove.

Before handoff run `pnpm check`.

Also run:

- `pnpm test:fuzz` for invariant-heavy changes;
- `pnpm check:perf` for query-maintenance or hot-path changes;
- targeted adapter/transaction benchmarks when their runtime path changes;
- `pnpm pack:release` and the release verifier for a release candidate.

Documentation-only changes require link/content review and `pnpm check` only if
they modify executable examples, package metadata, or scripts. A docs-only
architecture phase must not drift into implementation to make its ledger look
green.
