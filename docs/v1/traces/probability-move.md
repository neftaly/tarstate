# Trace: Probability nested move

Status: normative conformance trace.

## Fixture status

This is a target migration plus a synthetic capability fixture, not a claim
about current Probability storage. Current entities use Automerge object IDs
rather than stable logical IDs; it has no persistent geometry source and the
text/counter descendants below are synthetic stress cases. Conformance requires
a stable entity-ID migration. The external-store portion adapts Probability's
real transient TanStack drag state; a Zustand variant proves the same generic
protocol independently.

## Fixture

Automerge source `scene` contains entity `panel-1`, nested entity `label-1`, an
Automerge text value, and a counter. Another row refers logically to `label-1`.
The current adapter advertises `copyRelocate`, not
`identityPreservingMove`.

A generic external-store source `geometry` (TanStack Store or Zustand) contains
ephemeral layout rows keyed by stable entity ID.

At scene basis `H1`, locators are:

- panel root object `O1`;
- label object `O2`;
- text/counter descendants with their own CRDT identities.

## Move attempt

1. The app asks to move `panel-1` under destination parent `column-2`, after
   stable anchor `panel-7`, requiring only the minimum `move` contract.
2. The commit coordinator captures `H1`, verifies source/destination/anchor
   locators, and plans all scene edits.
3. The disposable Automerge spike creates replacement objects `N1`, `N2` and
   records available descendant evidence under a provisional fixture key while
   deleting/tombstoning the old subtree in one change. Its findings must freeze
   the exact `__tarstateMovesV1` encoding before that reserved key is written.
4. The receipt says `copyRelocate`, lists identity losses, and does not claim
   that CRDT text/counter history was preserved.
5. The logical reference to `label-1` remains valid only because it targets the
   stable logical entity ID and the binding resolves the new locator. A physical
   object-ID reference would require a complete mapping or become unresolved.
6. A later edit in the same transaction follows the staged `panel-1` entity at
   its destination.

## Concurrent old-subtree edit

A remote peer concurrently edits `O2` from a branch based on `H1`.

When it merges after the local relocation:

- the edit is not silently copied into `N2`;
- the old edited branch/orphan remains inspectable through move/conflict issue
  relations;
- hard identity-sensitive operations become indeterminate;
- the app must explicitly reconcile the old edit with the relocated entity.

Two concurrent moves from `O1` to different destinations form a relocation
fork. Move chains and cycles are likewise diagnostics, not hidden
last-writer-wins behavior.

## Geometry source

Scene and geometry queries may join by stable logical entity ID. Updating
geometry and moving the scene are two source commits. A `NonAtomicBatch` may make
this easy and report per-source outcomes, but remains visibly non-atomic.
Presence/drag
updates do not become durable scene constraints.

## Native move upgrade

When Automerge provides native move, the adapter may advertise
`identityPreservingMove`. The same public move intent then preserves `O1`, `O2`,
descendant CRDT identities, concurrent edits, and references. Tests for the
fallback and native capability remain separate; one is never accepted as the
other.
