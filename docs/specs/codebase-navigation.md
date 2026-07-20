# Codebase navigation

This is a context map, not a substitute for types and tests. Start from the
smallest task bundle below, then follow direct imports. Do not begin with the
test-only `packages/core/src/index.ts` broad barrel.

## Repository map

```text
packages/core          portable semantics, queries, databases, transactions
packages/automerge     Automerge projection, source runtime, standard opener
packages/react         React observation and mutation bindings
packages/zustand       thin atomic-external-store adapter
packages/schema-tools  generated declarations, bundles, catalogs, JSON schema
examples               consumer-shaped smoke recipe
scripts                architecture, bundle, perf, packaging, release fitness
docs/specs              behavior and architecture authority
```

## Core semantic groups

The exact file membership and allowed directions live in
`scripts/check-boundaries.mjs`.

| Group | Start here | Purpose |
| --- | --- | --- |
| Foundation | `value.ts`, `issues.ts`, `artifacts.ts`, `canonical-json.ts` | portable values, ownership, hashes, issues |
| Capabilities | `capability-model.ts`, `registry.ts`, `resolver.ts` | declared versus installed behavior |
| Source contract | `source-state.ts`, `source-protocol.ts`, `logical-edit.ts` | snapshots, bases, bindings, commits |
| Schema | `schema.ts`, `mapping.ts`, `lens.ts`, `constraints.ts` | logical rows and source projection |
| Query model/batch | `query/model.ts`, `query/prepare.ts`, `query/internal/evaluator.ts` | reference query semantics |
| Query incremental | `query/incremental.ts`, `query/internal/maintenance-engine.ts` | retained operator maintenance |
| Transaction model | `database/transaction.ts`, `transaction.ts`, `relation-delta-authoring.ts` | public operation surface and portable writes |
| Transaction runtime | `transaction-executor.ts`, `commit-coordinator.ts`, `lifecycle-governance.ts`, `non-atomic-batch.ts` | stage, reconcile, validate, publish, ledger, deliberate cross-source sequencing |
| Attachment runtime | `attachment/preparation.ts`, `attachment/transaction-service.ts` | prepared logical facts plus live transaction bridge |
| Observer | `observer.ts`, `database.ts`, `external-store.ts` | snapshots, catalogs, generic observation |
| Database session | `database/query-session.ts`, `database/source-link-graph.ts` | mounts, discovery, settlement, owned close |
| External-store adapter | `database/external-store/open.ts` and siblings | standard immutable-source database path |

## Task context bundles

### Change portable parsing or artifact identity

Read:

- `packages/core/src/value.ts`
- `packages/core/src/internal-owned-json.ts`
- `packages/core/src/canonical-json.ts`
- `packages/core/src/artifacts.ts`
- `packages/core/src/issues.ts`
- `packages/core/tests/foundation.test.ts`
- `packages/core/tests/fuzz-properties.fuzz.spec.ts`

Check hash/ordering laws, hostile budgets, alias ownership, and packed duplicate
identity.

### Change schema, mapping, or relation keys

Read:

- `schema.ts`, `schema-authoring.ts`, `mapping.ts`
- the relevant semantic artifact parser
- `attachment/preparation.ts`
- `attachment/mapped-database-projection.ts`
- `tests/schema-production.test.ts`
- mapping/attachment tests in core and the target adapter

Trace ordered key fields through preparation, capabilities, indexing,
authoring, lowering, and generated types. Never treat a key tuple as a set.

### Add or change a query operator

Read:

- `query/model.ts`, `query/builder.ts`, `query/authoring.ts`
- `query/prepare.ts` and `query/internal/prepared-plan.ts`
- `query/internal/rows.ts` and `query/internal/evaluator.ts`
- the matching incremental operator module and maintenance engine
- `query/projection-demand.ts`
- query unit, property, incremental, perf, tree-shake, and type-budget evidence

Define batch semantics first, then differential incremental behavior. Update
typed authoring only after runtime semantics are settled.

`query/internal/rows.ts` owns scoped-row construction, identity, and indexes;
keep those domain mechanics out of operator evaluation and maintenance shells.

### Change database observation or source discovery

Read:

- `database-model.ts`, `database.ts`, `observer.ts`
- `observer-maintenance-contracts.ts`
- `database/query-session.ts`, `database/source-mount.ts`
- `database/source-link-graph.ts`, `database/follow-source-links.ts`
- observer/source-link unit and fuzz suites

Separate dataset membership, source lifecycle, query maintenance, and
settlement. Audit listener ownership and snapshot identity.

### Change transaction authoring or concurrency

Read:

- `database/transaction.ts`
- `attachment/transaction-snapshot.ts`
- `attachment/transaction-state-authoring.ts`
- `relation-delta-authoring.ts`
- `transaction-executor.ts`
- `source-protocol.ts`, `commit-coordinator.ts`, `lifecycle-governance.ts`
- transaction/attachment unit and fuzz suites

Keep the public replayable callback source-neutral. Trace candidate validation
and conditional publication before changing any retry/reconciliation behavior.

### Change Automerge behavior

Read:

- `packages/automerge/src/database/open.ts`
- `database/live.ts` and `database/model.ts`
- `source/runtime.ts`, `adapter/atomic-source.ts`
- the relevant projection/mapping/property-edit module
- document metadata/value modules for boundary changes
- Automerge database, source-runtime, mapping, and fuzz tests

For normalized Repo/network observations, start instead at
`system-relations.ts` for deterministic state and `system-database/open.ts` for
the read-only mount/query lifecycle. Repo event wiring remains outside both.

Use actual Automerge branches/heads for concurrency evidence. Do not infer CRDT
behavior from an immutable-memory adapter.

### Change React or optimistic behavior

Read:

- `packages/react/src/contracts.ts`, `runtime.ts`, `provider.ts`
- `query-store.ts`, `mutation-store.ts`, `optimistic-store.ts`
- the affected hook and React tests

Keep database truth, optimistic overlay state, and render observation separate.
Profile subscription/render identity before adding memo layers.

### Change public exports or package layout

Read:

- the package `package.json` exports map
- the topic `index.ts`
- package `README.md`
- `scripts/check-boundaries.mjs`
- `scripts/check-built-boundaries.mjs`
- `scripts/check-tree-shaking.mjs`
- public-surface and release-smoke tests

Prove consumer need, runtime reachability, type closure, duplicate-package
identity, and clean tarball installation.

## Large-module caution

`transaction-executor.ts`, the query maintenance engine/evaluator,
`AutomergeMappedStorageBinding`, and `AutomergeSourceRuntime` currently require
large context. Their size alone is not a refactor mandate. When changing them,
identify phase boundaries and authority first; extract only cohesive pure
transformations or lifecycle owners with narrower inputs.

Do not create generic helper folders. Name extracted modules after domain work,
such as candidate validation, captured-intent reconciliation, or aggregate
maintenance.

## Search vocabulary

Useful terms are `schemaView`, `relationId`, `keyFields`, `basis`,
`operationEpoch`, `intentHash`, `projectionDemand`, `completeness`,
`attachmentIncarnation`, `resultKeys`, `commitReconciled`, and exact issue
codes. Search the public type first, then its producer, consumer, and tests.

## Handoff expectation

A focused change should be explainable as:

`contract changed → pure semantic module → lifecycle shell (if any) → evidence`

If explaining it requires unrelated package internals, treat that as a coupling
finding and record it before widening the change.
