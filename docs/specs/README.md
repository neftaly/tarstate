# Tarstate behavior and architecture specifications

This folder is the design authority for Tarstate's observable behavior and
architectural boundaries. Package READMEs remain recipes. Types, tests, and
fitness scripts remain executable evidence. Point-in-time findings and
proposals are not specifications.

Tarstate turns portable relational descriptions and host-owned state into
typed queries, incremental observations, and replayable logical mutations. It
does not own application operations, product policy, persistence, transport,
presence, or conflict presentation.

## Reading order

Consumers should start with:

1. [product-and-language.md](./product-and-language.md)
2. [consumer-api.md](./consumer-api.md)
3. The contract for their source and task

Maintainers and agents should then read:

1. [ownership-and-dependencies.md](./ownership-and-dependencies.md)
2. [subsystem-boundaries.md](./subsystem-boundaries.md)
3. [verification.md](./verification.md)
4. [codebase-navigation.md](./codebase-navigation.md)
5. [conformance-and-decisions.md](./conformance-and-decisions.md)

## Contract map

| Document | Authority |
| --- | --- |
| [product-and-language.md](./product-and-language.md) | Scope, vocabulary, normative language, non-goals |
| [consumer-api.md](./consumer-api.md) | Consumer tasks, entrypoints, one-path DX, attachment meaning |
| [values-artifacts-and-schemas.md](./values-artifacts-and-schemas.md) | Portable values, artifacts, schemas, mappings, lenses, constraints |
| [queries.md](./queries.md) | Query semantics, typed authoring, preparation, batch and incremental agreement |
| [databases-and-observation.md](./databases-and-observation.md) | Snapshots, sources, datasets, observation, discovery and identity |
| [transactions-and-concurrency.md](./transactions-and-concurrency.md) | Replay, reconciliation, validation, publication, receipts and simulation |
| [adapters-and-hosts.md](./adapters-and-hosts.md) | Core/adapter separation, Automerge, external stores, React, Zustand, schema tools |
| [lifecycle-errors-and-authority.md](./lifecycle-errors-and-authority.md) | Ownership, close behavior, authority, issue/result/throw taxonomy |
| [ownership-and-dependencies.md](./ownership-and-dependencies.md) | Functional core, module direction, state/write discipline, coupling rules |
| [subsystem-boundaries.md](./subsystem-boundaries.md) | Phase ownership and concrete decoupling seams |
| [performance-and-packaging.md](./performance-and-packaging.md) | Work, allocation, GC, engine, tree-shaking, release budgets |
| [verification.md](./verification.md) | Evidence types, unit/fuzz/property/perf allocation, stopping rule |
| [codebase-navigation.md](./codebase-navigation.md) | Task-to-module and task-to-test map for bounded agent context |
| [conformance-and-decisions.md](./conformance-and-decisions.md) | Current evidence, gaps, rejected alternatives, review record |

## Normative language

- **Must** and **must not** define behavior or architecture required of future
  changes.
- **Should** records a strong default that may be violated only with concrete
  evidence and a documented tradeoff.
- **May** identifies supported variation.
- **Current fact** names behavior verified in the 0.6.0 source or checks.
- **Gap** names incomplete evidence or a known mismatch. A gap is not permission
  to invent a second path.
- **Candidate** is deliberately non-normative until it survives review and gains
  an acceptance contract.

Normative claims should describe observable semantics, ownership, or dependency
direction. File names, helper shapes, and incidental algorithms are evidence,
not contracts, unless a document explicitly says otherwise.

## Change discipline

A behavior change updates the relevant specification and its executable
evidence together. An internal refactor should not rewrite specs merely to
mirror its new file layout. A proposal becomes obsolete once its accepted
claims are represented here or its rejected claims are recorded in the
decision ledger.

After a review finds a material defect, revise the affected contract and run
that review lens again. Stop when a complete pass finds no new material issue;
do not manufacture ceremonial passes.
