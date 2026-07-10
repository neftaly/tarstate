# Tarstate v1 spike readiness review

Date: 2026-07-10. Scope: the full current `main` — the v1 design packet
(`docs/v1/`), the five spike implementations and their fixtures
(`@tarstate/core`, `@tarstate/automerge`, `@tarstate/zustand`), and repo/build
hygiene — reviewed as a pre-build gate before broadening from the spikes.

## Verdict

The spike gate is genuinely satisfied. All five slices have executable
evidence, `pnpm check` passes end to end (lint, typecheck, build, 41 tests
across 7 files, working tree stays clean), the frozen capability hashes are
reconstructed in tests, and the wire types in `packages/core/src/v1-spike/wire.ts`
match the spike wire contract exactly. The spike reports' claims are backed by
the fixtures I read — no claim was found without a corresponding test.

Ready to start the build order. The findings below are not gate failures; they
are semantic decisions and promotion gaps that should be resolved (or
explicitly ticketed as decision records) during build-order steps 1–4, because
each becomes expensive to change after the pure oracle and coordinator harden.

## Semantic findings (resolve before/at the pure-oracle step)

### 1. Three-valued `unknown` collides with the string `"unknown"` in value space

`packages/core/src/v1-spike/evaluator.ts` represents truth-unknown as the JSON
string `'unknown'` (`compare` returns it; `asTruth` maps any non-boolean to
it). Consequences:

- A nested comparison is unsound: `eq(eq(a, b), literal(true))` where the inner
  compare is unknown evaluates the outer compare against the *string*
  `"unknown"` and returns `false`, where Kleene semantics require `unknown`.
- A data field legitimately holding the string `"unknown"` is indistinguishable
  from truth-unknown wherever `asTruth` is applied.

Not exercised by the current fixtures (which only test top-level predicates),
so the spike evidence stands, but the production oracle (build step 3) needs a
truth domain disjoint from `JsonValue` — the evaluator already does this
correctly for missing via a private `Symbol`.

### 2. Operation ledger records only committed outcomes

`InMemorySpikeSource` (`transaction.ts`) stores `(operationEpoch, operationId)
→ receipt` only after a successful commit. `docs/v1/04-transactions-and-receipts.md`
says durable deduplication "stores the intent hash before possible mutation"
and that reusing an epoch/ID with different intent "never returns or applies
the earlier outcome". In the spike, a *rejected* attempt leaves no ledger
entry, so reusing its ID with a different intent silently executes instead of
rejecting as `transaction.operation_id_ambiguous`. The fixture only tests reuse
after a commit. The production coordinator should write the ledger entry at
attempt start; add the rejected-then-reused case to the gate-6 tests.

### 3. Runtime `parameters` are outside the intent identity

Per the spec, bound parameters are part of the immutable transaction artifact,
so `transactionHash` covers them. The spike `TransactionAttempt` instead takes
`parameters` as a separate runtime field while `transactionHash` is an opaque
caller-supplied value — nothing binds the two. Same epoch/ID/transactionHash
with *different parameters* is treated as an idempotent retry and returns the
original receipt. Spike-internal shape divergence; at promotion either fold
parameters into the hashed artifact (as the spec already says) or include them
in `intentHash`.

### 4. Missing parameter in a write expression throws instead of rejecting

`requireValue` (`transaction.ts:390`) throws a raw `Error` when an expression
produces missing (e.g. an unbound parameter in an insert row). That rejects the
commit promise rather than returning a rejected receipt with a structured
issue, violating "every expected failure is a value" and the spec's
"unexpected failure before possible mutation is rejected". Map it to something
like `transaction.parameter_missing`.

### 5. Capability-unavailable inside a `where` predicate keeps `exact` completeness

A missing `call` function makes the predicate unknown, so the row is filtered
— but completeness stays `exact` (an issue is pushed). Extension nodes, by
contrast, poison completeness to `unknown`. Data-null filtering under `exact`
is correct; an *unevaluable* predicate claiming an exact result is
questionable. Decide the policy (probably: capability failure poisons
completeness like extension nodes) before the oracle freezes.

### 6. Lens `unmapped: 'reject'` and edit-outcome reporting gaps

- `projectRow` pushes `lens.unmapped_value` as an error but still returns the
  projection (row minus the field). The wire contract calls the mode `reject`;
  whether that means row-level or projection-level rejection is unstated and
  untested. Add a fixture and a sentence to the contract.
- `edit.replace` records no `editOutcome`, while the spec says receipts report
  "the actual semantic edit mechanism … per statement" and the catalog has
  `field/replace`. Probably intentional (replace is the baseline) — state it.
- Spec's `SemanticEditOutcome.edit` includes `'list'`; the spike union omits it
  (no list edits in scope). Additive, just track it.

## Robustness notes (spike-acceptable, fix at promotion)

- **`tupleFor` shape leniency** (`lens.ts:155`): a non-array value against a
  multi-field lookup yields `[value]`, and out-of-range positions compare
  against `undefined`, which `sameJson` treats as equal-to-absent
  (`canonicalJson(undefined)` goes through `JSON.stringify(undefined)`). A
  malformed edit could false-match a lookup row. The production artifact
  parser must reject the shape before evaluation.
- **Zustand hydration staleness window** (`packages/zustand/src/index.ts`):
  `hydration.getState()` only changes via listeners registered inside
  `subscribe`; it never re-checks `persist.hasHydrated()`. If hydration
  completes between adapter creation and the runtime's subscription, the source
  reports `loading` forever. Narrow window, but cheap to close by delegating
  `getState` to `hasHydrated()`.
- **Module-global external-store registry** (`external-store.ts`):
  `liveRuntimeBySourceId` is process-wide singleton state. Matches the "host
  adapter registry" contract for the spike, but production needs explicit
  registry ownership (test isolation, multiple hosts per process).
- **`simulate` bypasses the commit queue**: it snapshots directly, so a
  simulation raced against queued commits can be stale the moment it returns.
  Acceptable for advisory simulation; keep it documented.
- **Revision rollback on commit throw** (`external-store.ts:98`): restoring
  `previousRevision` is safe only because the update is synchronous and store
  signals are suppressed while coordinating; hydration signals are not
  suppressed. Currently unreachable interleaving in JS — keep the invariant in
  mind if `update` ever becomes async.

## Hygiene

- `pnpm check` = lint (oxlint `--deny-warnings --type-aware`) + typecheck +
  build + test; all green, and the check does not dirty the tree. Rollup
  warnings are escalated to errors. Good discipline.
- **Version pins vs "locked" claims**: the Automerge spike report says the
  fixture "runs against locked `@automerge/automerge` 3.2.6", but the package
  declares `^3.2.6` (same for `automerge-repo` `^2.5.6`, Zustand `^5.0.14`,
  TanStack Store `^0.11.0`). The golden-bytes test asserts a byte-exact SHA-256
  of `Automerge.save` output, so any transparent minor upgrade can break it.
  Either pin exact versions in the measured packages or amend the reports to
  say the pnpm lockfile is the lock.
- Package `exports` point at `src/*.ts`; the vite `dist` build is effectively a
  bundling check that nothing consumes. Fine while packages are private —
  revisit exports before anything is published.
- `apps/` is an empty directory not covered by `pnpm-workspace.yaml`
  (`packages/*` only). Remove it or add it when the golden app fixtures land.

## What was verified and found sound

- Wire types, statement/guard/lens grammars, and the built-in capability
  catalog (hashes reconstructed from canonical declarations in tests) match
  `docs/v1/10-spike-wire-contract.md` exactly.
- Kleene truth tables, missing-vs-null, bag multiplicity, lower-bound
  monotonicity, and anti-join/aggregate incompleteness rejection behave per the
  packet and are tested.
- The source coordinator implements the spec sequence: statements staged in
  order, guards then final-state constraints, footprint bound checks, n-ary
  intent merge with conflict rejection, exact-basis rejection before planning,
  no-op basis preservation with zero notifications, single atomic notification.
- The external-store runtime satisfies the generic protocol: revision advanced
  inside the atomic update, coalesced self-notification, lease refcounting with
  one shared subscription, incarnation rotation on reattach, borrowed stores
  never closed, direct mutation left visibly outside the protocol.
- The Automerge fallback records the full frozen loss catalog, the metadata
  record round-trips inside the document, deterministic golden bytes, and the
  measured Repo/Presence identity claims are exercised against real
  `automerge-repo` objects.
- `implementation-entry.md` and the spike reports are consistent with each
  other and with the code; the packet's amendment note (copyRelocate fallback,
  Repo identity) is reflected in the move/discovery wording and the capability
  implications.
