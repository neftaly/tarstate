# Patchpit source-native array follow-ups

These are interoperability follow-ups exposed by Patchpit's canonical
Patchwork-compatible folder graph. They are not blockers for Patchpit's current
0.4.6 integration.

## 1. Insert with source-generated collection identity

Patchwork folder links are ordinary objects in an Automerge `docs` list and do
not carry a separate logical ID. Tarstate 0.4.6 can project
`collection-element-identity` as a relation key and can edit or delete those
rows, but a keyed relation insertion still needs a key before the new
Automerge list object exists.

Patchpit-owned folders therefore currently add an `id` field so alias insertion
can use the exact keyed-array transaction path. Patchwork preserves that field
on existing links, but a link newly inserted by Patchwork has no `id` and cannot
round-trip through the owned mapping. This is a physical interoperability cost,
not Patchpit domain logic.

The desired capability is a source-generated-key insert for array relations:

- application intent supplies the non-key logical fields and an operation-local
  insertion token, not a fabricated durable identity;
- the Automerge adapter inserts one object and derives the committed logical key
  from that object's source identity;
- the receipt returns the token-to-logical-key association;
- replay/reconciliation remains idempotent and does not create a second object;
- portable mappings do not expose Automerge object IDs as storage paths or ask
  applications to allocate them.

With that capability Patchpit can use the exact Patchwork `title + docs[]`
shape for owned and foreign folders while retaining relational alias creation.

## 2. Identity-preserving array reorder

Changing a projected `collection-position` is not equivalent to moving the
existing source object. Rebuilding or delete-and-inserting a row changes its
Automerge object identity and can disturb concurrent edits. Patchpit therefore
does not currently lower reorder through `withRows` and does not describe row
sorting as a semantic move.

The desired capability is a source-routed collection move that:

- targets the existing row by its stable logical/source identity;
- expresses before/after placement without replacing the row object;
- uses an Automerge-native move when available;
- can use an adapter-owned semantic move journal while Automerge lacks native
  moves, without exposing that journal to schemas or applications;
- reports unsupported preservation rather than silently degrading to
  delete-and-insert;
- remains merge-aware and returns the final source basis and outcome evidence.

These two capabilities are related by source-native collection identity, but
they are distinct: insertion creates identity and returns it; reorder preserves
identity that already exists.
