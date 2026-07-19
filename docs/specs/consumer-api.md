# Consumer API contract

## Consumer tasks first

There should be one obvious safe path for each ordinary task:

| Task | Normal entrypoint |
| --- | --- |
| Query pure in-memory relations | typed builders from `@tarstate/core/query/authoring`; `evaluateQuery` from `@tarstate/core/query/evaluate` |
| Query one or more opened database sources | `openDatabaseQuery` from `@tarstate/core/database/session` |
| Build a custom host observation runtime | `createDatabaseView` from `@tarstate/core/database/observer` with injected maintenance |
| Open writable Automerge state | `openAutomergeDatabase` from `@tarstate/automerge` |
| Open an immutable atomic external store | `openExternalStoreDatabase` from `@tarstate/core/database/external-store` |
| Create an ephemeral atomic store | `createMemoryAtomicExternalStore` from `@tarstate/core/database/external-store` |
| Use React | `TarstateProvider`, `useQuery`, `useRow`, `useCommit` from `@tarstate/react` |
| Adapt Zustand | `zustandAtomicExternalStore` from `@tarstate/zustand` into the external-store path |
| Generate schema outputs | `@tarstate/schema-tools` |

Consumers must not choose among normal, prepared, owned, sealed, staged, or
fast variants. Those concepts may exist privately where they represent actual
ownership or lifecycle states. Public performance machinery is a DX defect.

Official source openers return a database. Ordinary consumers should not call
attachment preparation or adapter constructors. `createDatabaseView` and adapter
topic entries are host/adapter extension seams, not alternate application
recipes.

Framework adapters acquire shared external-store runtimes through
`acquireExternalStoreRuntime`; the runtime constructor is deliberately type-only
at the package boundary so identity and lease ownership cannot be bypassed.

The memory atomic store is its own default source identity. External-store
wrappers only provide `storeIdentity` when their stable underlying store differs
from the wrapper object.

## Public composition shape

Application code should provide:

- exact schemas and prepared queries;
- a host source or official adapter handle;
- portable declarations and embedded/exact artifacts;
- an explicit authority scope;
- pure replayable operation transforms;
- framework-specific rendering or product policy outside Tarstate.

Applications should define registry, authority, and dataset scope evidence once
at their database/query composition boundary and reuse those owned values.
Feature code should not invent fingerprints or scatter literal scope strings.
An authority scope identifies the host policy view; it does not authenticate a
user by itself.

Application code should not provide:

- canonical key encodings or relation-key indexes;
- transaction ASTs or literal write expressions for ordinary database edits;
- storage bindings, execution contexts, attachment fingerprints, or Automerge
  heads;
- duplicate relation keys, mapping facts, constraints, or writability already
  proven by attachment preparation;
- a second constraint evaluator or JSON/`toJS()` round trip.

## Topic entrypoints

The package root is a small portable foundation. Runtime concerns use topic
entrypoints such as `@tarstate/core/query`, `@tarstate/core/database`, and
`@tarstate/core/transactions`. Narrower entries exist when they materially
remove reachable runtime work.

Topic imports are architectural decoupling, not consumer ceremony. Package
READMEs must show the complete composition recipe so consumers do not have to
reverse-engineer which topics belong together. New topic entrypoints require a
bundle or dependency-boundary justification.

## Typed authoring

The typed path and runtime path must share one semantic implementation. Types
preserve exact schema bodies, relation names, row fields, parameter records, and
composite-key tuple order. Runtime parsing remains authoritative for untyped or
untrusted values.

Generated bindings should be ordinary exact values usable across a module
boundary. Consumers should not need casts to recover a row type already known
from a schema or prepared plan.

Use `typedUnionAll` when compatible typed branches need bag-union semantics.
It compiles to the ordinary set query, retains branch literal discriminants,
and rejects incompatible fields, aliases, or non-null logical value families.
A `null`-only field may align with a typed field in another branch without
weakening compatibility between non-null values. Selecting a possibly missing
expression produces an optional result property, matching the runtime row
rather than a required property containing `undefined`.

Type cleverness is subordinate to predictable diagnostics and compiler cost.
An overload or conditional type is justified when it removes a real consumer
cast or prevents a meaningful mistake. Type-only aliases which create another
way to perform the same task are not.

## Database operations

The operation callback is pure and may be replayed after concurrent changes.
It reads typed rows and returns a new immutable transaction snapshot through
`withRows`, `insertWithGeneratedKey`, or `spliceText`.

`withRows` is the ordinary exact relation-state authoring form. Tarstate derives
keyed inserts, updates, and deletes using prepared relation facts. Consumers
must not build generic diff transactions.

`insertWithGeneratedKey` is reserved for source-owned durable identity.
`spliceText` is reserved for position-sensitive text intent and requires the
basis the user observed. These are semantic operations, not public fast paths.

`openTextIntent({ observedBasis })` is the focused form for several bounded
splices whose later offsets depend on earlier local splices. `append` applies a
pure synchronous transform only to the session's optimistic snapshot;
`complete` publishes the accepted sequence as one ordinary transaction. The
session reports per-segment pending, committed, rejected, unknown, or cancelled
evidence and must be closed by its owner. It does not claim that dependent edits
can continue across several publications.

`simulate` and `transact` accept the same intent and transform. Simulation
cannot publish or allocate durable source identity.

## Observation

Database and query observation use synchronous `getSnapshot` plus `subscribe`
semantics. Snapshots and row arrays are readonly. Stable identity is a
performance property where documented, never permission to mutate.

Use a database's direct snapshot for its mapped logical rows. Use
`openDatabaseQuery` when evaluating a prepared query over one or more opened
sources, with optional source-link discovery and one owned close boundary.

For a direct mapped snapshot, `mappedRelationRows(snapshot.current, relation)`
verifies the exact schema view and preserves the generated row type. The
database's `capabilities(relation)` is the authority for available inserts,
deletes, replacement, generated identity, and text splice. Product code should
not re-read a mapping artifact or duplicate those facts.

Consumers should discriminate lifecycle/readiness states before reading ready
data. APIs should expose typed selection helpers when a schema view proves the
row type; requiring a cast at that boundary is a DX gap.

## Errors at the call site

An opener returns a `ParseResult` when user/source portable input can be
malformed. Programmer contract violations such as an empty authority scope,
wrong schema-view relation, or use after close may throw. A transaction attempt
resolves to a receipt for expected operational outcomes, including rejection or
unknown publication.

An API should not make the caller guess which model applies. Its name, return
type, and documentation must identify the boundary.

## Consumer-DX review

Reject changes which introduce any of these:

- multiple public ways to open or mutate the same kind of source;
- adapter internals leaking through ordinary application types;
- a required manual registry/resolver/binding graph for official adapters;
- query or transaction helpers which only save a few characters but widen the
  public vocabulary;
- generic status objects that erase meaningful lifecycle states;
- framework hooks that invent semantics absent from the database contract;
- source-specific logical types where a portable scalar already preserves the
  required meaning;
- a convenience barrel that eagerly links unrelated runtime subsystems.
