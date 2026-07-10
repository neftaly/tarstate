# Tarstate v1 Normative Design Packet

Status: normative v1.0 specification.

This directory is the source of truth for the Tarstate rewrite. Documents
outside `docs/v1/` are historical research unless this packet explicitly
incorporates them. If implementation and this packet disagree, implementation
is wrong or this packet must be amended by an explicit decision record.

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## Product contract

Tarstate is a reactive relational database interface over an authority-scoped
set of local-first sources.

- Automerge documents are the primary durable source of truth.
- Zustand, TanStack Store, and similar external stores are local/app-state
  sources behind one generic atomic-store protocol.
- Queries may span sources. No composite observation pretends to be a
  distributed atomic snapshot.
- One source is the maximum atomic write boundary. A source is one Automerge
  document, one external store, or one custom source with an equivalent atomic
  coordinator.
- Schemas, queries, constraints, transactions, storage mappings, and schema
  lenses are immutable portable artifacts. Executable capabilities are trusted
  host registrations, never implicitly downloaded code.
- The core is pure. Source loading, subscriptions, commits, React, networking,
  storage, presence, and effects form the imperative shell.
- The JavaScript query API is functional and uses `pipe`. Fluent query chains
  and `compose` are not part of v1.

## Normative documents

1. [Artifacts and values](01-artifacts-and-values.md)
2. [Identity and lineage](02-identity-and-lineage.md)
3. [Discovery and observations](03-discovery-and-observations.md)
4. [Transactions and receipts](04-transactions-and-receipts.md)
5. [Constraints and authority](05-constraints-and-authority.md)
6. [Moves and relocation](06-moves-and-relocation.md)
7. [Schemas, schema lenses, storage mappings, and storage bindings](07-schemas-lenses-mappings-bindings.md)
8. [Developer experience and performance](08-dx-and-performance.md)
9. [Query artifacts and execution](09-query-artifacts-and-execution.md)
10. [Spike wire contract](10-spike-wire-contract.md)
11. [Implementation entry contract](implementation-entry.md)

Production evidence is mapped gate by gate in the
[v1 conformance matrix](conformance-matrix.md).
Owner-selected scope changes are recorded separately from measured spike
contradictions in the [v1 decision log](decisions.md).

Required end-to-end traces:

- [Patchpit recursive folder and HTTPS resource](traces/patchpit-folder.md)
- [Probability nested move](traces/probability-move.md)
- [v1 app editing v200 data](traces/schema-v1-v200.md)

Executable initial spike evidence:

- [pure semantic evaluator](spikes/pure-semantic.md)
- [source transaction coordinator](spikes/source-transaction.md)
- [Automerge behavior and fallback](spikes/automerge.md)
- [Zustand and TanStack external stores](spikes/external-store.md)
- [v1/v200 schema lens](spikes/lens.md)

## Layer model

| Layer | Responsibility |
| --- | --- |
| Schema | Logical relation and field meaning, stable relation identity, logical keys, refs, value domains, promised edit semantics |
| Storage mapping | Portable description of how storage candidates correspond to logical relations |
| Storage binding | Trusted pure projection and edit-planning implementation |
| Source | Imperative snapshots, lifecycle, basis, subscription, and atomic commit |
| Attachment | Source + storage bindings + schema views + authority |
| Dataset | Versioned expected attachment membership used by multi-source queries |
| Database | One authority-scoped view of attachments, capability registry, query cache, and commit coordinators |
| React | Cached immutable observation consumption only |

Schemas do not define storage topology, permissions, indexes, React behavior,
source lifecycle, or network state.

## Coupling rule

Portable artifacts depend on semantic contracts, never a library's object
model, event shape, storage path, or fallback metadata. Core depends on source,
storage-binding, and capability protocols; Automerge, Zustand, TanStack, React, and
future adapters depend inward on those protocols.

Source-specific details may exist inside an adapter, but are not public query or
schema vocabulary. System relations expose normalized facts rather than raw
adapter metadata. Replacing an adapter mechanism with a stronger native one
must not require changing an app's schema or query when its semantic guarantees
still hold.

This does not promise that every implementation is interchangeable: artifacts
declare exact minimum capabilities, and missing capabilities fail explicitly.
The goal is substitutable contracts, not a lowest-common-denominator API.

## Stable compatibility boundary

The long-lived compatibility boundary is the portable artifact formats and
their semantics. TypeScript constructors are convenience APIs and may evolve
more freely, while remaining functional and producing the same artifacts.

A self-describing document carries immutable schema, projection, and constraint
artifact references through adapter-private bootstrap metadata; a trusted host
may instead supply the same declaration out of band. A host may expose an older
or newer schema view only through an explicitly selected compatibility lens.
Compatibility is never inferred from version numbers.

## Explicit v1 exclusions

- distributed atomic transactions or global serializability;
- globally convergent constraint enforcement;
- automatic migrations, compensation, or conflict repair;
- general triggers, durable workflows, and sagas;
- arbitrary host closures in portable artifacts;
- implicit execution of code discovered through a document or URL;
- public physical index/materialization controls;
- full outer or lateral join primitives when specified compositions cover the
  required workloads;
- native identity-preserving moves until a source advertises that capability.

These exclusions are safe only because v1 includes structured observation
diffs, commit and explicitly non-atomic batch receipts, named capability gaps,
and extension points for sources, storage bindings, codecs, functions, and edit
semantics.

Future additions remain additive:

- distributed commit or global enforcement requires a new coordinator
  capability and receipt/activation mode; it cannot reinterpret a v1
  `NonAtomicBatch` or audit constraint as atomic;
- migration, durable-workflow, and effect orchestration use new receipt kinds
  that retain nested v1 outcomes; v1 source-lifecycle and sequence receipts
  remain unchanged;
- physical tuning uses private planning or a future separate hint artifact and
  cannot change query meaning;
- native source operations satisfy existing semantic minimum contracts while
  reporting their actual stronger mechanism;
- React features remain consumers of observers and do not alter core query or
  transaction artifacts.
