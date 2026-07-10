# Moves and relocation

Status: normative.

`move` is a semantic edit family, not a promise that every source preserves
identity. A relation or transaction that merely needs relocation requires the
minimum `move` contract. Sources satisfy it through one of two distinct
mechanisms, and receipts report which mechanism actually ran.

## Capability tiers

### `identityPreservingMove`

The same storage entity and descendants retain their locators/CRDT identities
while parent/order changes. Concurrent edits to the entity remain attached.
References remain valid without relocation translation.

Only a native source operation or an equivalent storage primitive may advertise
this capability.

### `copyRelocate`

The source copies a logical subtree/value, creates new storage entities, and
deletes or tombstones old entities. Root and descendant locators may change.
CRDT-native text, counters, list element identities, conflicts, and concurrent
old-subtree edits may not transfer faithfully.

`copyRelocate` MUST NOT satisfy a schema or transaction requirement for
`identityPreservingMove`. Both mechanisms explicitly imply the weaker `move`
contract; neither implication is inferred from its name.

## Move intent

A move intent is a statement inside a source transaction and inherits the
enclosing attempt's operation epoch/ID, source, basis policy, and replan discipline.
It contains:

- a source-local logical target query;
- a logical destination parent reference;
- a stable before/after anchor reference or explicit beginning/end position;
- required minimum move contract (`move` or `identityPreservingMove`);
- conflict policy for a missing destination anchor.

Mutable array indexes are not anchors. A later edit in the same transaction
targets the staged moved entity, not its former path.

The coordinator resolves logical targets and references to source locators at
the exact attempt basis. Locators are prepared-plan data and never appear in
portable transaction artifacts.

`reorder` is distinct from parent relocation. Editing an explicit order/rank
field within one parent does not require `copyRelocate`. A binding that
physically relocates a list element must report the capability and identity
semantics it actually provides.

Moving across sources is never one move. It is an explicit non-atomic
copy/create and delete `NonAtomicBatch` with new source identity, receipts, and partial
failure handling.

## Automerge fallback metadata (adapter-private)

Until Automerge supplies native identity-preserving move, `__tarstateMovesV1`
is the reserved candidate root property for relocation evidence. Its exact
record encoding is deliberately not frozen before the Automerge spike measures
object IDs, conflicts, descendant identity, and path/anchor behavior. No v1
implementation or spike fixture may write that key until the spike amends this
document with an exact schema, canonical encodings, conflict-reading rules,
golden bytes, and a closed preservation-loss code catalog. Disposable spike
evidence uses an explicitly provisional fixture key and makes no compatibility
claim. Writers MUST NOT place any new record shape in legacy
`__automergeMoves`.

No portable schema, mapping, query, constraint, reference, transaction, or app
API may name this property or depend on its record layout. Only the Automerge
adapter and explicit migration/diagnostic tooling interpret it. Core sees
normalized move capabilities, receipts, lineage, and issues. A future native
move can therefore replace the write mechanism without changing portable app
artifacts.

Once frozen, the property is reserved only for an attachment that enables this fallback. If
an existing document contains an incompatible value at that key, the adapter
reports a metadata collision and withholds `copyRelocate`; it never overwrites
application data or guesses ownership of the key.

The format to be frozen MUST be a map of immutable completed records keyed by a
digest that includes `{operationEpoch, operationId, statementIndex}`. This
allows one transaction to carry several move statements without collision. A
record is created atomically with relocation; an aborted attempt writes no
pending record. Its exact frozen record MUST include at least:

- `formatVersion: 1`, the original operation epoch/ID, statement index, and exact
  pre-move basis;
- source and destination paths/anchors;
- root old/new object IDs;
- a sorted list of every discoverable descendant old/new ID pair;
- the actual `copyRelocate` mechanism and bounded preservation-loss codes.

Object IDs are values, never map-property names. Unknown record fields and
unknown sibling metadata are preserved through unrelated writes. Reusing one
operation epoch/ID/statement index with different record content is an
ambiguity issue, not an overwrite or retry.

Readers may recognize two legacy `__automergeMoves` shapes without rewriting
them:

- a string value is legacy Probability old-object-ID to new-object-ID evidence;
- a `{from, to}` value is archived Patchpit path-relocation evidence.

Both have unknown basis and incomplete descendant semantics unless independently
proven. They may aid migration or diagnostics but never advertise the v1
capability. Unknown and legacy metadata is preserved.

If complete descendant mapping or CRDT-native value preservation is impossible,
the receipt and source issue relations say so. JSON copy alone never upgrades the
capability tier.

References may follow relocation only when their declared binding semantics use
stable logical entity IDs or the complete recorded mapping. An unresolved
descendant reference is an issue, not a guessed path.

## Concurrent relocation

The binding detects and exposes:

- two moves from one source to different destinations (fork);
- relocation chains;
- relocation cycles;
- destination-anchor deletion;
- edits arriving at an old subtree after relocation;
- duplicate application of one operation epoch/ID.

No generic last-writer-wins policy is imposed. Ambiguous relocation blocks hard
constraints and identity-sensitive writes until an app-specific resolution.

Ambiguity is derived from live storage identity: multiple surviving targets,
an unresolved duplicate logical entity ID, a cycle, or another currently
ambiguous lineage state. Immutable move records are historical evidence and do
not keep an otherwise repaired source blocked merely because a past fork
occurred. A copy-relocation fork that leaves duplicate logical entities is
resolved through the same authority-safe candidate relation and targeted repair
path (`tarstate.system.repair_candidates`) as duplicate keys; after only one
valid target survives, the fork remains
diagnostic history but no longer active ambiguity.

For `copyRelocate`, an edit arriving later on the old subtree remains observable
as a concurrent orphan/branch; it is not silently discarded or copied into the
new subtree.

V1 does not compact relocation records: safe compaction depends on reference,
history, and peer-retention policy that v1 does not possess. Bindings surface a
bounded metadata-size issue when configured limits are crossed; they do not
silently delete lineage.

A future format uses a new versioned sibling key and readers may combine known
versions. It may checkpoint or prune v1 evidence only under an explicit
retention capability proving that no supported reader, reachable reference,
retained historical view, or expected peer still needs it. Writing a newer
format never changes the meaning of v1 records, and old writers preserve the
unknown sibling key.

After the spike freezes it, the adapter-private wire format exists only so
durable documents remain readable across adapter versions. It is not promoted
into Tarstate's public compatibility surface.

## Future native move

A future Automerge adapter may implement `identityPreservingMove` while retaining
the same public move-intent shape. Existing schemas that require only `move`
continue to work and receipts now report the stronger mechanism. Existing v1
relocation records remain readable for old references; native moves neither
rewrite nor delete them. Schemas that require identity preservation become
writable only when the attached source advertises the stronger capability.
