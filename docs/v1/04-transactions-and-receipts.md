# Transactions and receipts

Status: normative.

## Transaction value

A transaction is immutable portable write intent:

```ts
type ReturningQuery = {
  name: string
  root: QueryNode
}

type Transaction = Artifact<{
  schemaView: ArtifactRef
  parameters: Readonly<Record<string, PortableValue>>
  statements: readonly Statement[]
  guards: readonly Guard[]
  returning?: readonly ReturningQuery[]
  requiredCapabilities: readonly CapabilityRef[]
}>

type TransactionAttempt = {
  operationEpoch: string
  operationId: string
  attachmentId: AttachmentId
  transaction: Transaction | ArtifactRef
  expectedBasis?: SourceBasis
}
```

Transactions contain no host closures, time reads, random generators, network
effects, or precompiled storage mutations. Time, IDs, and random values are
captured once as parameters before an attempt and remain fixed through replans.

Bound parameter values are part of the immutable transaction artifact. The same
artifact may be attempted against compatible sources when that is intentional.
The execution attempt—not the portable transaction body—selects exactly one
writable attachment and therefore one source, plus an operation epoch/ID and optional
expected basis. The shell verifies the selected attachment supplies the
artifact's schema view and capabilities.

Reusable write fragments may be flattened into one transaction. Nested
transaction envelopes and commits inside transactions are not supported.
Move and rekey statements inherit the enclosing transaction attempt's operation
epoch/ID, source, basis policy, and replan discipline; they do not contain nested
commit envelopes.

## Source-local dependency rule

An atomic transaction attempt names exactly one attachment and source. Every
target-selection query, write expression, guard, constraint, and referential
action that can accept or change the commit MUST depend only on that source's
staged relations and fixed transaction parameters.

Facts from other sources, presence, connection state, or a composite query may be
captured as advisory parameters, but the receipt records that evidence as
non-atomic. It cannot be called a hard guard. Query-generated cross-source writes
compile to captured per-source transactions in an explicit `NonAtomicBatch`.

## Statement semantics

Statements execute in array order. Later statements read the staged effects of
earlier statements.

Within one set-based statement:

- the target handle set is fixed from the statement-start staged snapshot;
- every row expression reads that same statement-start state and its original
  row;
- processing order cannot affect targets or values;
- duplicate paths to one target are deduplicated;
- incompatible edits for one target fail as ambiguous.

This prevents the Halloween problem and adapter iteration-order differences.

Updates and deletes matching zero rows commit as no-ops. A guard may require an
exact affected count. Statement results distinguish matched, logically changed,
inserted, and deleted counts. Uniquely named `returning` queries read the final
committed source state.

Writes name an explicit base relation or named writable view. See the
writeability limits in the identity specification.

`returning` queries are source-local and evaluate against the committed source
basis. A cross-source or system-state follow-up is a separate observation, not a
transaction return value. Returning names are unique within the transaction and
preserved in the receipt.

## Source commit coordinator

The source commit coordinator, not an individual storage binding, coordinates
planning and commit:

1. Capture one source snapshot, lifecycle state, attachment incarnation, active
   artifacts, authority, and exact basis.
2. Project all participating storage bindings and parse candidates from that
   snapshot.
3. Evaluate ordered statements into staged logical edits.
4. Expand referential actions to a fixed point in that logical staged state.
5. Plan the complete initial and generated edit set through every participating
   storage binding, collecting plan-specific footprints and storage intents.
6. Merge compatible intents source-wide; reject conflict or unknown compatibility.
7. Apply the merged commands to immutable staged storage, reproject every
   affected binding, verify that requested logical edits occurred without
   destroying unknown storage, and reparse all touched candidates.
8. Evaluate hard constraints on the final reprojected logical state.
9. Atomically compare the source basis and perform exactly one source commit.
10. Build returning rows and a receipt at the committed basis.

A source MUST provide atomic compare-and-apply, or run projection/planning inside
its own atomic functional update. Multiple bindings over one Automerge document
therefore produce one `DocHandle.change`; multiple slices over one external
store produce one atomic setter call.

Declared binding footprints are conservative binding-wide upper bounds; a
plan's footprints describe that exact attempt. Declared overlap alone does not
reject. Each plan read/write footprint MUST be `equal` to or `contained_by` its
declared bound, and each intent footprint MUST be contained by the plan write
footprint. `contains`, `overlaps`, or `unknown` where containment is required
fails with `binding.footprint_out_of_bounds`.

Disjoint intents coexist. Every equality/containment/overlap-connected group is
passed to one deterministic, permutation-invariant, source-wide merge. Only a
`merged` result proceeds; `conflict` and `unknown` reject. Cross-binding overlap
is never resolved by binding order or last-writer-wins. Unknown used only for
cache invalidation may cause full reprojection, but unknown used as a safety,
containment, or compatibility proof rejects.

## Basis and local serialization

Source bases are opaque and compared by the source. Automerge expected-basis
comparison is exact canonical heads equality. External stores use a
source-scoped monotonic revision maintained by the shared commit coordinator;
multiple live attachments never maintain independent counters. A pinned
historical attachment may intentionally observe a different historical basis.

An external-store basis includes the coordinator/source incarnation plus its
revision, not a bare number. Expected-basis comparison and revision advancement
occur inside the store's atomic update boundary. A delayed notification alone
can never be the authority for accepting an expected basis.

Local commits for one source are linearized. Without `expectedBasis`, a
transaction may be fully re-evaluated against a newer local basis before
handoff. With `expectedBasis`, any mismatch rejects. No replan occurs after
handoff.

This is serialization over locally known source states, not global Automerge
serializability. A remote concurrent change may merge afterward and create
conflicts or constraint violations.

## Operation identity and receipts

Every commit attempt has a stable caller-visible `(operationEpoch, operationId)`,
generated before handoff and reused for every safe pre-handoff replan.

`transactionHash` is exactly the resolved transaction artifact's `contentHash`,
not a body-only or pre-inline-ID hash. The shell derives `intentHash` as SHA-256
over RFC-8785 canonical
`{operationEpoch, transactionHash, attachmentId, attachmentFingerprint, expectedBasis?,
authorityViewFingerprint}`; the `expectedBasis` member is omitted exactly when
the attempt omitted it. The attachment fingerprint covers its declaration,
selected lenses, storage bindings, and registry fingerprint. Durable
deduplication is scoped by source, operation epoch, and operation ID and stores
the intent hash before possible mutation.
Reusing an operation epoch/ID with different intent is
`transaction.operation_id_ambiguous`; it never returns or applies the earlier
outcome as if it matched.

```ts
type SemanticEditOutcome = {
  edit: 'move' | 'rekey' | 'counter' | 'text' | 'list' | 'custom'
  mechanism: CapabilityRef
  preservationLosses: readonly string[]
}

type StatementResult = {
  statementIndex: number
  matched: number
  logicallyChanged: number
  inserted: number
  deleted: number
  editOutcomes: readonly SemanticEditOutcome[]
  issues: readonly Issue[]
}

type ReturningResult = {
  name: string
  rows: readonly unknown[]
  resultKeys: readonly ResultKey[]
  sourceId: SourceId
  basis: SourceBasis
  issues: readonly Issue[]
}

type CommitReceipt = {
  kind: 'commit'
  receiptVersion: 1
  operationEpoch: string
  operationId: string
  transactionHash: `sha256:${string}`
  intentHash: `sha256:${string}`
  attachmentId: AttachmentId
  attachmentFingerprint: `sha256:${string}`
  sourceId: SourceId
  outcome: 'committed' | 'rejected' | 'unknown'
  beforeBasis?: SourceBasis
  afterBasis?: SourceBasis
  statementResults: readonly StatementResult[]
  returning?: readonly ReturningResult[]
  issues: readonly Issue[]
  durability?: 'memory' | 'local' | 'persisted' | 'unknown'
}
```

Built-in Automerge and synchronous atomic external-store adapters MUST return
`committed` or `rejected` for local state. Persistence and remote sync remain
separate facts.

Durability means:

- `memory`: accepted only into volatile process memory;
- `local`: accepted by the local source, with no stronger storage claim;
- `persisted`: acknowledged by the source's configured durable storage;
- `unknown`: the adapter cannot assert any of the above after handoff.

`beforeBasis` is absent when rejection occurs before a usable source snapshot.
`durability` is present for committed or unknown outcomes and absent for a
pre-handoff rejection; a rejected operation makes no durability claim.

An adapter MAY return `unknown` only if it also provides durable source-side
operation deduplication and `queryOutcome({operationEpoch, operationId,
intentHash})`. Callers and agents MUST NOT retry an unknown non-idempotent
operation until its outcome is resolved.
Unexpected failure before possible mutation is rejected; after possible
mutation it is unknown.

`queryOutcome` requires the expected intent hash and applies the same ambiguity
rule. Receipts and operation records report the actual semantic edit mechanism
and bounded preservation-loss codes per statement; a fallback never masquerades
as a stronger edit.

No-op commits return `committed` with the same basis and produce no source
change notification.

The source operation ledger is correctness state, not a receipt cache. Entries
in an active epoch cannot be individually evicted; they may be compacted only
to immutable evidence sufficient to reproduce the exact semantic outcome,
never by re-evaluating against current source state. Decoded/rendered receipt
objects are evictable only when the authoritative outcome remains exactly
reconstructable. No-op and rejected handed-off attempts are ledger entries too.

Outcome lookup returns `known`, `not_seen`, `ambiguous`, `expired`, or
`unavailable`. `not_seen` is allowed only when the active epoch durably proves
handoff never began, and only that result permits retry. The other unresolved
states fail closed. Epoch retirement is explicit and atomic; retired or
unrecognized epochs reject and are never rebound to the current epoch. A source
may instead use one never-retired epoch with unbounded retention. Advertising
durable operation receipts requires persisting both epoch and ledger through
restart for the advertised lifetime. These rules also apply to lifecycle and
governance commands that claim operation-ID deduplication.

## CRDT-native edits and conflicts

Counter increments, text/list edits, maps, moves, and named future CRDT edits
remain semantic intents until binding planning. They are never lowered to
replacement merely to simplify retries.

An ordinary field set against an observed Automerge multi-value conflict fails
with `transaction.conflict_requires_resolution`. An explicit resolve edit
acknowledges and replaces the observed alternatives. A conflict arriving only
after local commit is surfaced by the later merged observation.

Key mutation requires explicit rekey semantics. Move and relocation follow the
separate move specification.

## Simulation and optimistic overlays

Pure simulation uses the same parser, statement evaluator, constraints, and
logical planner against a captured source snapshot. It returns predicted rows,
issues, and required capabilities without source commands.

Simulation is not a reservation. An optimistic overlay is tagged with source
basis and operation epoch/ID, then rebased or discarded when a newer source observation
or receipt arrives.

## Non-atomic batch semantics

`NonAtomicBatch` is an ordered list of source transactions with stable batch and
step IDs. Non-atomicity is part of its public name, not a documentation caveat:

```ts
type NonAtomicBatch = {
  batchId: string
  failurePolicy: 'stop' | 'continue'
  steps: readonly {
    stepId: string
    attempt: TransactionAttempt
  }[]
}

type NonAtomicBatchReceipt = {
  kind: 'non-atomic-batch'
  receiptVersion: 1
  batchId: string
  outcome: 'complete' | 'partial' | 'failed' | 'unknown'
  steps: readonly {
    stepId: string
    attachmentId: AttachmentId
    sourceId: SourceId
    capturedBasis?: SourceBasis
    outcome: 'applied' | 'failed' | 'unattempted' | 'unknown'
    receipt?: CommitReceipt
  }[]
  issues: readonly Issue[]
}
```

Default execution is sequential and stops on failure or unknown outcome.
`continue` is explicit. There is no rollback or automatic compensation.
Overall outcome uses the same complete/partial/failed/unknown aggregation rule
as `SequenceReceipt` below.

For `NonAtomicBatchReceipt` and `SequenceReceipt`, an `applied` step requires its
committed nested receipt and a known `failed` step requires its rejected nested
receipt. `unattempted`
forbids a nested receipt. `unknown` may omit it only for crash/lost-result cases;
when an unknown receipt exists it is retained. Wrappers cannot discard a known
step outcome.

A query-generated non-atomic batch captures target row handles, membership
revision, and each source basis. Its steps use those captured bases by default so
a changing query cannot silently retarget later sources. A manually authored
non-atomic batch may opt to evaluate each step against the latest source basis.

Non-atomic batch state is resumable from unapplied steps only when previous step
outcomes are known. Crash-after-commit-before-result can be resolved
automatically only when the source advertises `durableOperationReceipts` and can
look up the step operation epoch/ID after restart. Without that capability, the step
remains `unknown`; the executor must not retry or claim crash-resumability.

An Automerge adapter may advertise that capability only when the operation epoch/ID
is durably embedded in or indexed alongside its change history and lookup is
available after restart. Ordinary in-memory receipt caching is insufficient.
The durable record covers committed no-ops as well as mutating commits; a
missing change is not proof that an operation was never accepted.

Document creation/deletion and cross-document copy are shell steps, not
relational transactions. V1 represents their observable outcomes without
claiming a durable workflow engine:

```ts
type SourceLifecycleCommand = {
  lifecycleCoordinatorId: string
  operationEpoch: string
  operationId: string
  request:
    | {
        action: 'create'
        sourceCapability: CapabilityRef
        input: PortableValue
      }
    | {
        action: 'delete'
        sourceId: SourceId
        expectedBasis?: SourceBasis
      }
}

type SourceLifecycleReceipt = {
  kind: 'source-lifecycle'
  receiptVersion: 1
  lifecycleCoordinatorId: string
  operationEpoch: string
  operationId: string
  commandHash: `sha256:${string}`
  action: 'create' | 'delete'
  sourceId?: SourceId
  outcome: 'committed' | 'rejected' | 'unknown'
  durability?: 'memory' | 'local' | 'persisted' | 'unknown'
  issues: readonly Issue[]
}

type SequenceReceipt = {
  kind: 'sequence'
  receiptVersion: 1
  sequenceId: string
  outcome: 'complete' | 'partial' | 'failed' | 'unknown'
  steps: readonly {
    stepId: string
    outcome: 'applied' | 'failed' | 'unattempted' | 'unknown'
    receipt?:
      | CommitReceipt
      | NonAtomicBatchReceipt
      | SourceLifecycleReceipt
      | GovernanceReceipt
  }[]
  orphanedSourceIds: readonly SourceId[]
  issues: readonly Issue[]
}
```

The lifecycle `commandHash` is SHA-256 over RFC-8785 canonical
`{lifecycleCoordinatorId, operationEpoch, request,
authorityViewFingerprint}`. A committed create receipt MUST contain
the allocated `sourceId`; a delete receipt always contains its requested
`sourceId`; and an unknown create includes it whenever allocation is known. The
exact create input or delete target is therefore bound during deduplication and
outcome lookup.

`SequenceReceipt` records caller-run shell orchestration only. It provides no
scheduler, durable resumption, rollback, or compensation. A create-then-link
sequence whose link fails includes the successful create receipt and created
source ID in `orphanedSourceIds`; the orphan cannot disappear into a generic
error channel.

`complete` means every step applied; `failed` means no step applied and failure
is known; `partial` means at least one step applied and a later step is known
failed/unattempted; `unknown` means any possibly applied step is unresolved.

A source-lifecycle `unknown` outcome is permitted only when its adapter durably
deduplicates and resolves operation epoch/ID plus command hash. Reusing an
operation epoch/ID for a different create/delete command is ambiguous, never
cached success.

Lifecycle epochs belong to a stable host-selected lifecycle coordinator, not to
the source being created. Its ledger key is `(lifecycleCoordinatorId,
operationEpoch, operationId)`, so create can be deduplicated before a source ID
exists. The same coordinator allocates the source ID before possible external
mutation and retains that allocation in unknown-outcome evidence. Delete may
name an existing source, but remains in this lifecycle ledger rather than being
silently rebound to the source transaction epoch.

## Migration and workflow extension seam

Lenses translate compatible reads and writes; they never become migrations. A
future migration command names exact from/to schema artifacts, authority,
expected source bases, and stable operation IDs, then executes ordinary source
transactions or explicit non-atomic batches. It cannot acquire wider atomicity
by being called a migration. Schema/constraint activation is atomic with data
only when one source adapter explicitly supports one governance commit
containing both; otherwise partial progress is receipted.

Commit, non-atomic-batch, source-lifecycle, governance, sequence, and presence
receipts have stable `kind` and `receiptVersion` discriminants. Future migration,
durable-workflow, or external-effect receipts use new kinds and embed or
reference the original receipts without rewriting their outcomes. A wrapper
never upgrades `unknown` to success, hides a partial result, or implies rollback.

Receipt parsers return an opaque, bounded `unknown_receipt` value for an unknown
kind or version, preserving its portable data for forwarding and attaching an
issue. An old consumer must not infer success, retry safety, or compensation
semantics from that value.

Future effect steps require their own stable idempotency keys and receipts.
They run only after the relational outcome they depend on is known and remain
non-atomic with it. Durable scheduling/resumption additionally requires durable
step state and operation-outcome lookup; v1 does not publish a workflow engine.

## Cancellation, lifecycle, and effects

Cancellation before handoff rejects without mutation. Cancellation after
handoff cannot undo a commit and the outcome must still be resolved.
Detachment, source replacement, schema/constraint metadata conflict, denied
authority, closed sources, and unavailable required capabilities reject before
mutation.

Subscriptions may turn observation diffs into later transactions in the
imperative shell. V1 has no database triggers or external effects inside a
transaction. This prevents effects from running multiple times during replans.
