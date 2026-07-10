# Constraints and authority

Status: normative.

## Separation of concerns

- Parsing says what a candidate value or row means.
- A constraint says which persistent relational states are allowed.
- A guard says whether one requested transaction may proceed.
- Authority says who may read or write.
- A referential action generates additional writes.
- A workflow or external effect is imperative shell behavior.

These are never aliases or implicit conversions.

Primary-key presence and field shape belong to parsing. Primary-key ambiguity
is intrinsic relation integrity. Secondary unique, foreign-key, cardinality,
and arbitrary relational invariants are constraints. Cascades and set-null are
referential actions, not properties of foreign-key truth.

## Constraint artifacts and activation

A constraint is a stable named portable query returning violation rows. Helpers
such as unique, foreign key, and cardinality compile to that representation.

Constraint sets are immutable artifacts versioned separately from schemas. A
source activation record contains an exact set reference/hash and mode:

- `audit`: evaluate and expose results, but do not reject writes;
- `required`: capable cooperative executors enforce locally.

A local host may be stricter but MUST NOT weaken `required`. Conflicted or
unresolvable activation metadata makes capable executors read-only.

The sole exception is an authority-gated governance repair operation. It may
resolve only conflicted document bootstrap sections (storage schema/projection
or constraint activation), must name the exact conflicted basis and alternatives,
and emits an auditable receipt. It cannot read or edit application rows,
activate unrelated artifacts, or bypass ordinary constraint enforcement. This
escape hatch is available while relational writes are read-only so that a
metadata conflict cannot deadlock its own repair.

```ts
type GovernanceReceipt = {
  kind: 'governance'
  receiptVersion: 1
  operationEpoch: string
  operationId: string
  commandHash: `sha256:${string}`
  sourceId: SourceId
  action:
    | 'initialize_declaration'
    | 'repair_declaration'
    | 'activate_constraints'
  outcome: 'committed' | 'rejected' | 'unknown'
  beforeBasis?: SourceBasis
  afterBasis?: SourceBasis
  selectedArtifactHashes: readonly `sha256:${string}`[]
  issues: readonly Issue[]
  durability?: 'memory' | 'local' | 'persisted' | 'unknown'
}
```

The command hash binds the operation epoch, exact action, conflicted alternatives,
selected values, expected basis, and authority-view fingerprint. Operation-epoch/ID reuse and
unknown outcomes follow the same source-side deduplication rules as relational
commits. The receipt exposes artifact hashes but no redacted application data.

Activation metadata cannot force an old or malicious binary to enforce a new
set. V1 guarantees cooperative local pre-commit enforcement and post-merge
diagnostics. Strong enforcement requires an authority/host gate; future Keyhive
integration fits that boundary.

An old app schema view may write when the current host executor resolves the
active constraint set and writable lens. An old executor that cannot resolve a
required set is read-only.

## Three-state evaluation

Constraint evaluation returns exactly one of:

- `satisfied`;
- `violated`, with violation rows;
- `indeterminate`, with evidence issues.

Indeterminate causes include incomplete source projection, parse failures,
redacted data in a non-authoritative context, missing deterministic capability,
conflicted schema/constraint metadata, unresolved Automerge conflict relevant
to the query, ambiguous move/rekey, or budget exhaustion.

Hard constraints reject both violated and indeterminate final states. A hard
constraint may depend only on the write source's complete authoritative staged
state, deterministic named functions, and the active understood set. Cross-source
constraints are audit-only.

No hard constraint reads ambient time, randomness, presence, connection state,
or network reachability. Durable time facts may be stored explicitly.

## Stable violation identity

Violation queries declare a stable subject, bounded evidence contributors, and
a structured code. A violation ID is derived from constraint ID, subject, and
code—not from the complete evidence set, mutable values, or localized text.
Evidence may therefore shrink during a repair without minting a new violation.

Standard helpers choose the finest stable subject they can enforce:

- a row or foreign-key failure uses the offending base row;
- uniqueness emits one violation per offending row, with its conflicting peers
  as evidence;
- group/cardinality failures use the canonical group scope;
- genuinely global constraints use an explicit global scope.

Violation rows contain constraint/set IDs, status, basis, bounded contributor
handles, subject, code, redaction-safe details, and optional inert repair hints.
Messages are presentation data and not contract identity.

Indeterminate results use the same rule: identity is constraint ID, a stable
bounded scope, and a cause code. A parse failure is scoped to its candidate row;
an activation conflict to its source; and dependency or budget exhaustion to the
declared constraint footprint. An indeterminate result never derives identity
from a changing sample of evidence.

## Dirty states and repair

Every enforced transaction compares before and final proposed violation and
indeterminate sets.

- Newly introduced violation or indeterminate IDs reject.
- Unchanged existing failures do not block a transaction that touches none of
  their subject scopes or declared dependency footprints.
- A transaction touching the subject scope of an existing failure must remove
  that failure by final state. Changing evidence alone does not create a new
  failure or prevent a strictly improving partial repair.
- Several contributing rows may be repaired atomically in one source
  transaction.
- Arbitrary partial repair that cannot be decomposed into stable IDs requires
  an explicit authority-gated repair mode; the generic executor does not invent
  a notion of “better.”
- A newly activated set starts in audit mode when existing data has not been
  proven clean.

Constraint checking occurs on final transaction state, not intermediate
statement states. Parent and child may therefore be inserted in either order in
one transaction.

A pre-existing indeterminate hard constraint blocks writes only when their
footprint intersects its declared dependency footprint. Unrelated writes may
proceed; a write that newly causes indeterminacy still rejects. Conflicted
activation metadata remains source-wide read-only except for the governance
repair above.

Constraint dependency footprints are logical relation/field footprints.
Binding read/write footprints are physical storage footprints. They are never
compared directly: affected physical projections are reprojected, and their
logical changes are compared with constraint dependencies. Unknown overlap may
broaden evaluation, but cannot prove a write safe.

## Automerge concurrency

Two peers may each make locally valid changes whose merge violates a constraint.
Tarstate does not rewrite history, compensate automatically, or claim global
invariant convergence. The merged source exposes violations/indeterminate issues,
and subsequent authorized repair transactions follow the dirty-state rules.

Concurrent inserts with the same logical key are not silently resolved by a
visible Automerge winner. All conflicting candidates remain diagnostic evidence;
key lookup/write is ambiguous until explicitly repaired.

## Referential actions

V1 supports only named same-source delete policies proven by golden workloads:
restrict (a constraint), cascade, and set-null. Generated writes participate in
the same source plan, footprint collision detection, final parsing, and final
constraints. Cycles terminate by visited base handle; repeated paths deduplicate.

Cross-source referential actions fail planning and require an explicit
`NonAtomicBatch` or shell sequence. General triggers are excluded.

## Authority model

The host creates an authority-filtered database view before discovery rows enter
query evaluation or caches. Read and write authority are separate. A row visible
for query does not imply write authority.

Hard source constraints run in a source-authoritative context, not an app's
redacted view. Application queries see only authorized facts and redaction-safe
issues. Cache keys include principal/view scope and capability fingerprint.

Errors must not leak redacted contributor identities, hidden values, or even a
hidden duplicate count. An unauthorized keyed lookup may report only a generic
ambiguous-or-unavailable result.

Opaque row handles and provenance tokens are scoped to the database view and
rechecked at commit. They are not serialized to untrusted consumers unless a
specific authority capability permits it. Transaction queries are preferred to
client-supplied locator tokens.

Schemas, links, artifact locations, and discovered executable references grant
no authority. All executable resolution is host-allow-listed and
integrity-checked.
