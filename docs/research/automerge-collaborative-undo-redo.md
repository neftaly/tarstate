# Collaborative undo and redo for Automerge documents

## Status

Research note, not an implementation plan or public API contract. Reviewed
against Tarstate 0.7.0, `@automerge/automerge` 3.2.6, and
`@automerge/automerge-repo` 2.5.6 on 20 July 2026.

The first design task is to choose observable multiplayer behavior. No generic
inverse algorithm or API should be selected before those choices survive UX and
adversarial review.

## Conclusion

Undo and redo do not belong solely to either Tarstate core or the Automerge
adapter.

- The product owns what counts as one user action, keyboard focus, labels,
  selection restoration, retention policy, and whether history follows a tab,
  device, session, or authenticated account.
- Tarstate must keep undo publication on the ordinary transaction path so it
  cannot bypass schema, authority, constraints, reconciliation, receipts, or
  unknown-outcome handling.
- The Automerge adapter owns exact heads, historical views, source-native
  changes, object identity, CRDT reconciliation, and Repo handle effects.
- A fully general, identity-preserving implementation of the semantics proposed
  by Stewen and Kleppmann needs support in the Automerge operation model. It
  cannot be faithfully recreated by rewinding a snapshot or replaying numeric
  JSON patches.

The recommended initial meaning of “local undo” is **undo an action recorded by
this local editing-history session**, not “undo the latest operation in the
document” and not yet “undo every action performed by this authenticated human
on all devices.” Remote actions never enter this session's undo stack.

## Vocabulary that must remain distinct

| Term | Meaning | Collaborative consequence |
| --- | --- | --- |
| Snapshot rewind | Replace the live state with an old snapshot | Overwrites or hides unrelated work and is not acceptable as undo |
| Global undo | Undo the latest action by any participant | One user can unexpectedly undo another user's work |
| Local-user undo | Undo an action attributed to the same human identity | Requires durable identity and cross-device stack semantics |
| Local-session undo | Undo an action captured by one owned editing-history session | Predictable first scope; actions from other tabs/devices are remote to the stack |
| Selective undo | Choose an arbitrary earlier action to undo | Useful history feature, but not ordinary linear undo |
| Compensating change | Publish a new change whose visible effect reverses an earlier action | Preserves append-only replicated history and syncs to every participant |
| Redo | Undo the effect of a prior undo | Must not blindly replay the original forward patch |
| Transaction rejection | Refuse an unpublished candidate | Not undo; nothing was committed to compensate for |
| Revert | Deliberately compensate for a named historical action, possibly someone else's | Permissioned product operation, distinct from the local undo shortcut |

Calling all of these “undo” would produce an API whose behavior could not be
predicted from its name.

## Evidence from collaborative systems

### Stewen and Kleppmann

[Undo and Redo Support for Replicated Registers](https://arxiv.org/abs/2404.11308)
surveys Google Sheets, Google Slides, Microsoft Excel Online, Microsoft
PowerPoint Online, Figma, and Miro. Almost all observed products use local undo;
Miro instead blocked undo after a remote operation on the same register.

The paper derives two central principles:

1. An undo selects the participant's own most recent local operation, ignoring
   remote operations when choosing the stack entry.
2. Undo/redo neutrality: starting in state `s`, `n` undos followed by `n` redos,
   with no intervening edits, restores `s`.

Its prototype introduces a CRDT-native `RestoreOp` that points to an operation
in the causal history. Undo and redo are both restore operations; redo is
effectively an undo of an undo. The undo and redo stacks contain only locally
generated operations and ignore remote operations. A new local edit after undo
clears redo, while a remote edit does not.

This evidence is narrower than a general Automerge document implementation:

- the prototype implements one multi-value replicated register;
- “user” is operationalized as the local replica and its local stacks;
- map, list, object-identity, text, mark, schema, and authority behavior is not
  implemented;
- generalization to composed Automerge datatypes is a proposed direction, not
  acceptance evidence.

The paper's [prototype and survey artifacts](https://github.com/lstwn/undo-redo-replicated-registers/tree/papoc-camera-ready)
are valuable as a model oracle, not as a drop-in Automerge library.

### Figma

Figma describes the same neutrality requirement in its
[multiplayer engineering write-up](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/#implementing-undo):
undo captures redo history at undo time, and redo captures undo history at redo
time. “Redo” cannot mean “repeat my old forward mutation,” because doing that
can overwrite another participant's later work.

Figma also keeps deleted object data in the deleting client's undo buffer. That
is a product-specific storage tradeoff, not evidence that generic reconstruction
of an Automerge object preserves CRDT identity.

### Current Yjs behavior

The [Yjs UndoManager](https://docs.yjs.dev/api/undo-manager) demonstrates useful
API and UX mechanisms: scoped shared types, tracked transaction origins,
time-based capture grouping, explicit capture boundaries, stack metadata, and
selection restoration. These are useful questions for Tarstate even though the
Stewen/Kleppmann evaluation finds that Yjs's inverse-operation semantics do not
implement their desired local-register behavior in every remote-edit case.

### Automerge implementations and APIs

Automerge has had several materially different approaches:

1. The official [Automerge 0.13 backend](https://github.com/automerge/automerge/blob/v0.13.0/automerge-backend/src/op_set.rs)
   retained inverse operations in local undo/redo stacks. That implementation
   was removed during the later architecture and storage rewrite; it is evidence
   of edge cases, not a compatible foundation for Automerge 3.
2. The experimental
   [Automerge Repo Undo Redo](https://github.com/onsetsoftware/automerge-repo-undo-redo)
   wrapper records forward and inverse patches with heads, uses `changeAt` when
   untracked changes have arrived, and supports grouping and scopes. Its own
   documentation demonstrates a text case that produces corrupted output. Its
   published release targets Automerge 2.1 and Repo 1.1.
3. The alpha
   [Automerge Patcher](https://github.com/onsetsoftware/automerge-patcher)
   applies and synthesizes inverse patches. Its current implementation still
   reconstructs values, uses index/path patches, performs whole-value cloning
   during inversion, and cannot make those patches carry original Automerge
   object identity.
4. Automerge 3.2.6 exposes `getHeads`, `view`, `diff`, `applyPatches`,
   `getChanges`, and `changeAt`. These are useful feasibility primitives, but
   there is no stable UndoManager or generic revert operation. The upstream
   [undo/revert feature request](https://github.com/automerge/automerge/issues/985)
   remains open.

The existence of `diff` and `applyPatches` does not prove correct undo. Patches
describe a materialized transition using paths and sequence indexes. They are
not causal restore operations, and assigning a reconstructed map or list object
does not recover its original object ID.

## Candidate UX semantics

These are recommended starting semantics, not accepted Tarstate behavior.

### UX laws

1. **Local selection:** the shortcut selects the latest eligible action in the
   focused history session, never another participant's latest action.
2. **Shared result:** a committed undo or redo is visible to every replica; it
   is not a private alternate document state.
3. **Neutrality:** undo followed by redo with no intervening edit restores the
   exact visible state from before undo, including remote work already present.
4. **Remote independence:** receiving remote work neither adds an undo entry nor
   clears redo.
5. **Linear history:** a new tracked local action after undo clears redo instead
   of exposing an undo tree.
6. **Focus locality:** the product chooses which editor or workspace history
   receives the shortcut. Tarstate does not guess from document activity.
7. **Truthful availability:** unsupported identity, missing history, authority,
   conflicts, rejection, and unknown publication remain distinguishable.
8. **No recursive capture:** compensating changes update the owning stacks
   explicitly and are not captured again as ordinary new actions. Other
   sessions observe them as remote changes.

### Stack ownership

- One opened editing-history session owns one linear undo stack and one linear
  redo stack for one Automerge document.
- Only successful ordinary transactions explicitly tracked by that session
  create entries.
- Remote changes, untracked handle changes, lifecycle metadata, presence, and
  failed/simulated transactions do not create entries.
- A new tracked local action after an undo clears redo. A remote or untracked
  action does not clear redo.
- Closing the session releases its in-memory history. Cross-restart and
  cross-device history are separate future capabilities and must be labeled as
  such.

This deliberately uses session ownership rather than Automerge actor ID.
Actors, Repo peers, storage IDs, tabs, devices, and authenticated humans are not
interchangeable identities. A product may later supply a durable history-owner
identity, but Tarstate must not infer one.

The Automerge Repo [device-ID discussion](https://github.com/automerge/automerge-repo/issues/89)
also identifies undo as needing local-versus-network attribution, while showing
why Repo/storage identity does not automatically define a human user across
ephemeral tabs and persistent devices.

### Shared effect

Undo and redo publish new changes. They do not delete prior changes, move the
canonical handle to old heads, or make history diverge per user. Once committed,
every replica observes the resulting document effect.

The **choice** of action is local; the **effect** is shared.

### Action grouping

- One committed Tarstate transaction is one undo group by default.
- Grouping multiple transactions is product intent and must be explicit. Wall
  clock proximity alone is insufficient for buttons, drags, imports, or agent
  operations.
- A grouped action must still publish its compensation atomically for one
  document. Merely placing several independently published transactions under
  one label would create partial undo.
- Text input may use an explicit editor-owned capture window, composition
  boundary, or existing retained text-intent session.
- Selection, focus, viewport, and cursor restoration are local metadata attached
  to a history entry. They are not Automerge document changes.
- Multi-document undo is not atomic and should not be included in the first
  capability.
- External side effects such as messages, uploads, billing, or lifecycle
  operations are not reversed by document undo. A product must present those as
  separate compensating workflows.

### Availability and failure

`canUndo` cannot be only a boolean once the source is distributed. A truthful
history snapshot may need to distinguish:

- available;
- empty;
- temporarily publishing;
- blocked by current authority or writability;
- blocked by a schema/constraint change;
- ambiguous because the target was concurrently changed or deleted;
- unavailable because required history is missing;
- unsupported for the action's datatype or identity semantics;
- suspended after an unknown publication outcome;
- closed.

An undo entry is popped only after a known committed outcome. Rejection leaves
it available for inspection or retry if conditions change. An unknown outcome
suspends dependent undo and redo until publication is resolved; retrying it as
though nothing happened risks a duplicate compensating change.

### Authority and validation

Undo is not privileged rollback. It uses current authority, not authority the
participant held when the original action committed. Its candidate must pass
the same mapping, schema, constraints, captured-target checks, final projection,
conditional publication, and receipt rules as an ordinary transaction.

If a schema migration or another participant's edit makes compensation invalid,
the UI should show the action as blocked or unsupported. It must not mutate the
Repo handle directly to force old state back into existence.

## Behavior timelines

The following scenarios should be reviewed as product behavior before an API is
designed. `A` owns the local history session; `B` is remote.

### Disjoint fields

```text
initial: title = "Draft", archived = false
A: title = "Plan"
B: archived = true
A undo
expected: title = "Draft", archived = true
A redo
expected: title = "Plan", archived = true
```

Remote work outside the action's effect remains visible throughout.

### Later remote write to the same register

The Stewen/Kleppmann local-undo semantics are deliberately stronger than
“remove only my operation”:

```text
initial: color = black
A: color = red
B: color = green
A undo
paper's expected state: color = black
A redo
paper's expected state: color = green
```

Undo restores the state before A's action, temporarily removing B's later
visible write to that register. Redo restores the state captured before undo,
not A's old `red` mutation. This is the mainstream behavior reported by the
paper, but it is surprising enough that Tarstate should not adopt it without an
explicit product decision.

An alternative “cancel only A's contribution” semantic would leave `green`
visible during undo. That is not the algorithm or observed local-undo behavior
described by the paper. The two models must not be mixed opportunistically by
datatype.

### Concurrent writes to the same register

If A's red and B's green assignments are causally concurrent, an Automerge MVR
may retain siblings. Undo must converge to the same value/conflict evidence at
all replicas regardless of delivery order. Picking whichever patch was seen
last is invalid. Tarstate must either implement the chosen conflict semantics or
report the action unavailable; it cannot silently linearize concurrency.

### Remote work after undo but before redo

```text
A performs action X
A undoes X
B performs action Y
A redoes
```

Disjoint Y must survive. Same-target Y is not fully specified by the register
paper's neutrality example because an edit intervenes between undo and redo.
Before implementation, Tarstate needs an explicit rule for whether redo restores
the pre-undo target, yields CRDT conflict evidence, or becomes blocked. Blindly
replaying X is rejected because it can overwrite Y and violates the reason redo
history is captured at undo time.

### Insert followed by a remote edit

```text
A inserts object O
B edits a field of O
A undoes the insertion
A redoes
```

A correct implementation must define whether B's edit disappears while O is
undone and reappears on redo. Reconstructing an equivalent JSON object with a
new Automerge object ID is not correct: concurrent edits remain attached to the
original identity. This scenario is unsupported until identity preservation is
proved.

### Delete followed by a remote edit

Undoing A's delete should restore the original object identity and reconcile B's
concurrent edit. Re-inserting the projected row or cloned JSON value creates a
different object and may strand B's edit. A relation that uses
`collection-element-identity` makes this mismatch externally observable.

### Collaborative text

Numeric inverse splices are not adequate when B inserts or deletes text near A's
captured range. Undo must use CRDT character identity/anchors or native history
semantics. The documented corruption in the experimental Repo wrapper is a
direct regression example. Marks, block objects, Unicode coordinates, input
method composition, and cursor restoration each need separate evidence.

Tarstate's captured text-intent machinery is relevant infrastructure, but it
does not by itself define undo semantics.

### Constraints, permissions, and unknown outcomes

- If undoing would violate a current constraint, reject it without popping the
  entry.
- If the participant lost write authority, report it blocked; old authority is
  not revived.
- If publication may have succeeded but acknowledgement was lost, suspend the
  stack until outcome evidence is recovered.
- Simulation may preview the candidate but must not move either stack.

### Multiple tabs, devices, and sessions

The phrase “my last action” is ambiguous when one authenticated user has two
tabs or devices. A first version should undo only actions captured by the
focused local history session. Making the stack account-wide requires replicated
history ownership, total ordering or conflict presentation between devices,
security rules, persistence, and UX for actions the current device may never
have displayed. That is a different feature.

## Architecture implications for Tarstate

### What can be source-neutral

A pure history model can own:

- linear undo/redo stack transitions;
- action grouping identifiers and labels;
- committed, rejected, unknown, blocked, and closed settlement transitions;
- redo clearing after a new tracked local action;
- metadata needed to restore local selection or focus;
- model-based behavior timelines independent of delivery order.

This does not justify a public generic undo framework yet. Extract the pure
model only if an Automerge slice proves the boundary and a second source would
actually reuse it.

### What belongs in the Automerge adapter

- capture of exact before/after heads and committed source-native changes;
- historical materialization and missing-history evidence;
- generation of a private compensating candidate;
- object/list/text identity preservation;
- reconciliation with current Repo state;
- delivery-order-independent conflict evidence;
- conditional publication through the canonical handle.

Heads, patches, actor IDs, branches, and changes stay private to the adapter.

### What belongs upstream in Automerge

The paper's `RestoreOp` changes value resolution for the CRDT itself. Tarstate
cannot add that operation through Automerge's public JSON mutation API. A robust
general implementation of those semantics therefore belongs upstream in
Automerge, with Tarstate adapting it to schema, authority, transaction, and
receipt behavior.

Tarstate should not emulate a missing CRDT operation using reserved hidden
document metadata. That would create Tarstate-aware and ordinary Automerge
readers with different document meaning, repeating the rejected semantic-order
overlay problem.

### One-path consumer DX

Undo tracking must compose with the existing database transaction service.
Consumers should not choose between `transact` and an undoable wrapper's
separate `change` method. The ordinary committed action should be tracked when
an owned history capability is active; undo and redo should publish through the
same validation and receipt pipeline.

The product may decide grouping and labels, but it should never receive or
construct inverse patches, heads, change hashes, canonical keys, or native
branches.

## Why inverse patches are insufficient

An inverse patch experiment is useful for feasibility but is not an acceptance
criterion. Adversarial cases include:

- list indexes shifted by concurrent insertion or deletion;
- text indexes shifted or attached to deleted characters;
- a deleted map/list/text object reconstructed under a new object ID;
- conflicts flattened into one projected patch value;
- a counter requiring an inverse increment rather than a value assignment;
- mark expansion and overlapping marks;
- source-generated keys and relation membership;
- a path whose parent was deleted, moved, or replaced;
- before/after snapshots whose history is unavailable after partial loading;
- applying compensation directly to a handle before final Tarstate validation.

Passing `apply(invert(diff(before, after))) === before` in a sequential JSON
example proves only snapshot inversion. It does not prove multiplayer undo.

## Recommended research and implementation sequence

No production code is recommended during this research pass.

1. **Approve behavior vocabulary and timelines.** Decide local-session versus
   local-user scope, same-register behavior, redo with intervening remote work,
   and unsupported identity cases.
2. **Build an executable pure behavior model.** Model two or three participants,
   local stacks, remote delivery, grouping, rejection, and unknown outcomes.
   This becomes an oracle, not the production algorithm.
3. **Run private Automerge feasibility spikes.** Test reverse `diff`,
   `applyPatches`, `changeAt`, historical views, change metadata, list/object
   identity, conflicts, marks, and text against the model. Do not expose an API.
4. **Choose the honest first capability.** If only scalar mapped-field
   compensation is sound, advertise exactly that. Do not call it general
   document undo. If identity-preserving create/delete and text cannot conform,
   wait for upstream Automerge support.
5. **Implement one vertical slice through the existing transaction service.**
   Capture one committed action, undo it after a disjoint remote edit, redo it,
   and preserve receipts, constraints, authority, and handle isolation.
6. **Expand only with differential/model fuzz evidence.** Add datatypes one at
   a time. Every supported action kind must converge under replica and delivery
   permutations and retain source identity.

## Acceptance evidence for any future implementation

### Behavior and convergence

- Every merge and delivery order yields equivalent document state, conflicts,
  stack state, availability, and receipt evidence.
- Remote operations never become local undo entries or clear local redo.
- Undo/redo neutrality holds for every supported action kind.
- A new tracked action after undo clears only the owning session's redo branch.
- Save/load, offline work, reconnection, and history unavailability are
  explicit.

### Identity and datatype semantics

- map/list/text object IDs survive every operation claimed to preserve them;
- insert/delete with remote descendant edits has defined behavior;
- text uses source-native positions and covers adjacent/concurrent edits,
  deletion, marks, blocks, Unicode, and IME grouping;
- counters, bytes, dates, conflicts, generated keys, and absent parents are
  either proven or explicitly unsupported.

### Tarstate integration

- undo and redo use the same projection, constraint, authority, simulation,
  publication, and receipt logic as ordinary transactions;
- canonical handles are not mutated before candidate validation;
- rejection does not pop history;
- unknown outcomes suspend dependent history;
- close is idempotent and releases retained documents, patches, listeners, and
  selection metadata;
- the feature is a separate tree-shakeable Automerge topic if its native
  machinery would otherwise enter the ordinary database bundle.

### Performance and retention

- retained history has an explicit count/byte budget and deterministic eviction
  semantics;
- entries do not retain complete document snapshots when exact heads and a
  bounded action representation suffice;
- hot-path transaction cost is measured with history disabled and enabled;
- undo latency is measured after long history and after remote merges;
- compaction never discards history that an advertised undo entry still needs.

## Decisions required before code

1. Does “mine” mean this focused editing session, this device, or an
   authenticated account across devices? Recommendation: local session first.
2. For `black → A:red → B:green → A:undo`, should the visible result be
   `black` as in the paper, or `green` under contribution cancellation?
   Recommendation: deliberately choose; do not infer it from Automerge APIs.
3. What should redo do when B changes the same target after A's undo?
4. Is a scalar-field-only first capability useful, or would partial support be
   worse than waiting for native Automerge restore operations?
5. Must undo survive close/restart? Recommendation: no for the first slice,
   unless persistence is an explicit product requirement.
6. Which product events form groups, particularly typing, drag streams,
   imports, agent actions, and generated multi-step operations?

Until these are answered, the right next artifact is a behavior review, not a
public API or inverse-patch implementation.
