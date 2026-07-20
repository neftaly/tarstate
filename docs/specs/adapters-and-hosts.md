# Adapters and hosts

## Core/adapter boundary

Core defines portable logical values, source snapshots and bases, storage
bindings, projection results, footprints, staged intent, commit results, and
database lifecycles. An adapter supplies source-native projection, planning,
reconciliation where available, atomic publication, and outcome lookup.

Core must not import Automerge, React, Zustand, or a host persistence API.
Adapters may import narrow core topics. Framework packages must not reach into
core maintenance internals.

Prepared attachment facts remain source-neutral and are derived from exact
portable artifacts. Compiled constraints/projectors may be owned functions and
must remain independent of a source driver. A transaction service is created by
combining:

`prepared attachment + live source/bindings + authority policy`

No one component owns facts belonging to another. In particular, attachment
preparation does not own a driver, and a binding does not define schema or
product authority.

## Storage binding

A binding declares stable read/write footprints, exact write capabilities,
pure projection, and deterministic planning from logical edits to source-native
intent. Multiple bindings may project disjoint relations. At most one binding
may advertise writes for a relation in one attachment.

Footprints are correctness evidence for staging and conflict analysis. They
must not be weakened to improve a benchmark. A planner reports exactly which
logical edits it handled; unhandled or multiply handled edits reject.

## Automerge adapter

`openAutomergeDatabase` is the standard public Automerge composition. It adopts
conflict-aware metadata/artifacts once, prepares the mapped attachment, creates
one source runtime and mapping binding, then exposes a logical database plus
transactions.

The adapter must:

- parse Automerge values without `toJS()` or JSON round trips;
- surface metadata conflicts, collisions, or malformed alternatives;
- use exact head sets for optimistic basis evidence;
- preserve native text-splice reconciliation where advertised;
- advertise retained cross-publication text only when one private causal branch
  can survive repeated conditional publications;
- keep heads, changes, Repo handle staging, and object IDs private;
- project portable bytes and immutable strings through the shared scalar
  boundary;
- preserve unrelated document metadata on mapped root edits;
- publish only a candidate already projected and validated by core;
- make source lifecycle and close behavior explicit.

The metadata declaration and embedded artifacts supplied to the opener are
bootstrap configuration for that database incarnation. Current fact: remote
metadata changes after opening do not automatically reconfigure the live
attachment. Live metadata governance would require an explicit authority,
compatibility, migration, in-flight transaction, and reattachment protocol; it
must not be added as silent hot reload.

The optional `@tarstate/automerge/repo-lifecycle` topic adapts stable Repo URL
allocation and exact-ID import to core lifecycle creation receipts. It accepts
canonical portable bytes, validates the detached Automerge document before the
mutation boundary, verifies exact imported heads afterward, and claims only
memory durability. It is creation-only: local eviction and global replicated
deletion are different semantics, and experimental Repo flush/create APIs are
not capability evidence. The ordinary database entry does not import Repo.

The independent `@tarstate/automerge/system-database` topic adopts typed
host-supplied peer, connection, relative-sync, conflict, and presence facts. It
normalizes them into a read-only mountable database without owning Repo or
inferring global online/synchronized state. Equal-time fact delivery is
deterministic; remote heads alone remain `observed`. Authority applies to the
whole attachment, so hosts needing different visibility scopes create separate
system databases and feed each only authorized facts.

## Atomic external-store adapter

The external-store path adapts immutable host snapshots behind synchronous
`getSnapshot`/`subscribe` and an atomic compare/publish authority. It shares
logical projection, transaction authoring, validation, receipts, and database
lifecycle with Automerge.

It must not claim CRDT conflict merging, native occurrence identity, or text
reconciliation unless its concrete source implements those capabilities.
Ordinary stale writes use replay against a new immutable snapshot.

Memory/reference fixtures should implement the same source protocol rather than
create a separate transaction semantics.

## React

React is an observation and mutation binding, not a second database. Provider
ownership and hook subscriptions use the same external-store snapshots as
imperative consumers.

Hooks must:

- preserve prepared-plan row and parameter types;
- subscribe through `useSyncExternalStore`-compatible semantics;
- avoid React state for per-source maintenance;
- preserve result identity where the underlying snapshot does;
- clean up stores and optimistic overlays deterministically;
- keep optimistic UI policy distinct from committed database truth;
- avoid importing adapter implementations through the core provider contract.

## Zustand

The Zustand package is a thin adapter to the atomic external-store contract.
It should remain small enough that adding it does not create Zustand-specific
query or transaction behavior. Hydration is explicit source lifecycle evidence,
not a hidden delay inside query evaluation.

## Schema tools

Schema tools consume portable exact artifacts and produce deterministic JSON
schema, TypeScript declarations/bindings, artifact bundles, catalogs, and issue
descriptions. They are build-time or opt-in runtime tooling, not a dependency of
ordinary query/database execution.

Generated TypeScript must preserve exact relation names, fields, key tuple
order, and tagged-value types across imports. Generation failure returns
structured issues and must not emit plausible partial declarations as success.

## Adapter acceptance

A new adapter must demonstrate:

- exact source lifecycle and basis semantics;
- bounded, conflict-honest projection;
- declared versus effective write capabilities;
- atomic or honestly unknown publication evidence;
- replay under concurrent source changes;
- candidate validation before publication for any merge/reconcile path;
- idempotent close and listener cleanup;
- source-native values crossing one portable boundary;
- no new public transaction or query semantics.
