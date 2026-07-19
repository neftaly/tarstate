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

`reject(issue)` returns an expected data-dependent refusal as the same immutable
snapshot type. It is for operation intent such as an occupied idempotency key,
not schema or constraint validation. The issue is adopted once, an error is
required, and replay may legitimately change between staged and rejected as
the source changes. Exceptions remain programmer or unexpected failures.

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

### Dependent collaborative text streams

`openTextIntent({ observedBasis })` owns one retained causal segment stream.
Each synchronous `append` is evaluated against the stream's current optimistic
logical snapshot, so a later numeric splice may depend on text added by an
earlier accepted segment. `publish` captures the currently pending prefix and
lowers it to one text-only transaction. Appends remain available while that
prefix is publishing and become the next causal suffix.

The source adapter creates one unpublished branch at the observed basis. A
successful publication advances that private branch without importing unrelated
remote state into local numeric coordinates. The next publication extends the
same source-native history, merges it with current integration state, projects
and validates the exact candidate, and conditionally publishes it. The private
branch and canonical source remain distinct until that handoff succeeds.

The session retains bounded pending work and recent per-segment settlement
evidence, source freshness, cancellation, and idempotent in-flight publication.
Invalid segments do not replace the last accepted optimistic snapshot. Queued
pure transforms are replayed only against the advanced private branch to reset
cumulative authoring state and bound GC churn.

A rejected prefix rejects its dependent descendants. An unknown prefix outcome
suspends every descendant because the session cannot prove which causal history
is canonical. Sources without retained-branch capability must report the
session unavailable; they must not emulate it with numeric offset transforms.

`captureTextPosition` creates an opaque, session-owned logical request against
the exact current optimistic snapshot. Supplying those requests to `publish`
captures source-native identity from that publication's local candidate and
resolves it only against the exact committed `afterBasis`. Requests captured
before another accepted segment are rejected rather than reinterpreted.

The public receipt exposes named resolved offsets or explicit deleted,
rejected, unknown, cancelled, unsupported, or budget-exhausted evidence. It
never exposes native cursor encodings. Automerge's `before` and `after`
affinities control movement when the referenced character is deleted; its
unanchored start and end sentinels may coincide at an empty boundary. Presence,
editor rendering, input methods, undo policy, and transport remain product
concerns.

The Automerge package exposes one pure historical-view bridge so a host can
apply a resolved offset to the receipt's exact basis even if its live handle has
already advanced. The helper accepts a caller-owned immutable document and
portable basis evidence. Missing history fails closed; the helper never
substitutes the current document or fetches history.

## Multiplayer Automerge

Remote users may change the document between any two local async steps. A
successful local evaluation therefore never implies publication authority.
Exact head sets provide portable basis evidence. Their validation and native
historical materialization belong to the Automerge adapter; consumers do not
parse head representations themselves.

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

## Deliberately non-atomic batches

Cross-source work is not an atomic transaction. `executeDatabaseNonAtomicBatch`
runs host-local ordinary transaction callbacks sequentially; the portable
artifact path uses `executeNonAtomicBatch`. One shared functional core derives
step and aggregate outcomes for both paths. Exact nested receipts are retained,
identity disagreement fails closed as unknown, and cancellation prevents only
callbacks that have not started.

Official live databases expose the authoritative `sourceId` and `attachmentId`
needed by each database batch step. Consumers must not repeat adapter-specific
default attachment-ID derivation.

The batch receipt exposes partial completion. It does not claim rollback,
durable workflow identity, source discovery, or automatic product retries.

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
- dependent local text splices silently reinterpreted after a rejected or
  unknown predecessor;
- composite-key order changing between authoring and lowering.
- receipt source/attachment identity disagreeing with its scheduled batch step;
- cancellation or stop policy accidentally discarding completed batch evidence.
