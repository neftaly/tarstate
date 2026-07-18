# Transactions and concurrency

## One mutation model

The ordinary mutation API is a replayable operation over an immutable logical
snapshot. Official writable adapters expose the same `transact` and `simulate`
shape. Adapter-specific commands, heads, staging documents, bindings, and
transaction AST construction stay private.

The callback may run more than once. It must be deterministic for the supplied
snapshot and closed-over immutable operation input. It must not perform I/O,
read wall-clock/random state, mutate application state, or depend on invocation
count.

## Authoring forms

`withRows(relation, exactRows)` describes the desired exact state of one
relation. Tarstate validates rows and keys, then derives keyed insertion,
replacement, and deletion.

`insertWithGeneratedKey(relation, token, fields)` describes insertion where the
source allocates durable identity. The token is operation-local portable intent
and must remain stable across callback replay. The pending durable key is not
visible to `rows()` before commit. Only a committed receipt may report its
token-to-key association.

`spliceText(relation, key, field, edit)` captures position-sensitive text intent
in UTF-16 code units. It requires the exact basis observed by the user and a
source/binding capable of captured-basis reconciliation.

## General replay loop

For ordinary exact-state operations, the semantic loop is:

1. Capture an exact source snapshot and project logical state.
2. Invoke the pure transform and author a source-neutral transaction.
3. Validate guards, schema, capabilities, constraints, and lowering.
4. Stage source-native commands against the captured basis.
5. Conditionally publish only if the source still has that basis.
6. On a transient stale basis, capture the newest source and replay from step 1.
7. Stop with a structured receipt when committed, rejected, unknown, aborted,
   or a bounded retry policy is exhausted.

Replay is the default concurrency semantic for memory, external-store, and
Automerge adapters. It is not CRDT merging: an adapter that cannot merge still
gets correct optimistic replay if it provides atomic basis comparison.

## Captured text reconciliation

Position-sensitive text intent cannot be recreated safely by replaying an
index against changed text. For a transaction consisting only of eligible
captured text splices, the adapter may reconcile the captured source-native
change with the current source.

The safe loop is:

1. Capture and evaluate the edit at the user-observed basis.
2. Capture the current integration basis.
3. Reconcile the captured change into a private candidate.
4. Project the candidate back to logical state.
5. Confirm each exact target still exists uniquely.
6. Run final constraints and returning queries over the candidate.
7. Conditionally publish the exact validated candidate.
8. If the integration basis changes before publication, repeat reconciliation.

The canonical live source must not be mutated before candidate projection and
validation succeed. Disjoint Automerge changes should merge naturally. Same
field conflicts, deleted or ambiguous targets, changed guards, unavailable
evidence, and failed constraints may reject.

Mixed transactions or guarded work use conservative replay semantics unless a
future source-neutral rule proves reconciliation safe for the complete unit.

## Multiplayer Automerge

Remote users may change the document between any two local async steps. A
successful local evaluation therefore never implies publication authority.
Exact head sets provide basis evidence; they are private adapter details.

Automerge's ability to merge changes does not remove transaction validation,
idempotency evidence, or unknown outcomes. CRDT merge resolves data structure
concurrency, while Tarstate still enforces logical targets, constraints,
authority, and conditional publication.

## Idempotency and outcome evidence

One transaction attempt has an operation epoch, operation ID, and intent hash.
A ledger may return a known receipt for the same identity, reject ambiguous
reuse with different intent, or report expired/unavailable evidence.

The standard runtime ledger is process-local unless an adapter explicitly
claims stronger durability. It prevents duplicate publication inside the
owned execution protocol; it is not a public product-level idempotency key and
does not make an application retry after process loss exactly once.

An `unknown` outcome means publication cannot be proved either way. Callers
must not treat it as rejection and blindly repeat non-idempotent product work.

## Simulation

Simulation shares parsing, authoring, projection, validation, and lowering with
commit preparation but performs no publication. Its `would-commit` result is
evidence about the captured basis, not a reservation. The source may change
immediately afterward.

Simulation must not allocate durable source-generated identity or mutate an
operation ledger in a way that changes later commit semantics.

## Receipts

Receipts are portable evidence. They distinguish committed, rejected, unknown,
and simulation outcomes; include relevant evaluation/integration/before/after
bases; retain statement issues and returning results; and state claimed
durability.

A receipt must never claim an after basis or generated key that was not
published. A rejected attempt may include the basis against which rejection was
decided. Unexpected exceptions are converted to structured issues only at an
owned boundary that can still produce honest receipt evidence.

## Concurrency adversarial review

Attack the following:

- source changes after evaluation, after reconciliation, and during publish;
- replaying impure callbacks or unstable generated-key tokens;
- same operation ID with different intent;
- publication succeeds but acknowledgement is lost;
- captured target deletion, duplication, rekey, or field conflict;
- candidate validation accidentally reads canonical live state;
- simulation sharing a mutating path;
- retry loops without a bound or with hidden product policy;
- constraints checked before, but not after, merge;
- composite-key order changing between authoring and lowering.
