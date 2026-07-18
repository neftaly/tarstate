# Values, artifacts, and schemas

## Portable values

Portable JSON is detached and adopted once at an untrusted public boundary.
Internals may then rely on owned readonly values. Adoption must enforce bounded
depth, property count, array length, and byte/string limits where hostile input
could otherwise amplify work.

Tagged values extend JSON without allowing data-selected code. Their tag and
payload remain portable. Native values such as `Uint8Array` cross an adapter
boundary as a canonical portable representation and materialize through one
shared safe helper.

JavaScript numbers must be finite where a logical number is required. Missing,
null, unknown, unavailable, and absent source fields retain distinct semantics.

## Artifacts

Artifact identity is exact `(id, contentHash)` identity. Sealing computes the
hash from canonical semantic content. Parsing verifies envelope shape, hash,
dependency references, budgets, and ownership before semantic handling.

Artifact resolution must be deterministic and exact. A keyed embedded-artifact
record must reject a value whose embedded ID disagrees with its record key.
Resolvers must not silently substitute the latest artifact with a matching ID.

The portable artifact catalog does not import semantic handlers. Hosts opt into
schema, query, transaction, constraint, mapping, or lens implementations at a
composition boundary. Artifact data cannot name a module to load.

## Schemas

A schema defines named logical relations, stable relation IDs, ordered key
fields, and field declarations. Relation-key order is tuple semantics and must
be preserved across sealing, preparation, capabilities, indexing, diffing,
lowering, receipts, and generated TypeScript.

Rows are readonly records of portable values. Candidate parsing either returns
an owned row with an exact logical key or structured issues. Duplicate logical
keys are invalid when exact relation state requires uniqueness.

Schemas are the type source of truth. Type generation and typed literals must
retain exact string literals and tuple order without changing runtime behavior.

## Mappings

A storage mapping declares how a source shape projects to logical relations.
It may use singleton, array, or object-map collections; stored, literal,
map-key, or source-metadata key fields; stored, absent, or source-metadata
fields; and explicit write capabilities.

Projection is pure with respect to the supplied source snapshot. It must report
completeness and issues rather than fabricate unavailable identity. Collection
position is not stable identity and cannot be used as a logical key.

Source metadata is read-only unless a separate source capability explicitly
defines a write. Literal keys are logical facts and still participate in exact
tuple ordering.

A mapping advertises a write only when the artifact, concrete binding, and live
source protocol can preserve it. Effective capabilities are their
intersection, not an optimistic union.

## Schema lenses

A lens translates between exact schema views. Lens-path resolution is bounded,
deterministic, and explicit about missing or ambiguous paths. Projection and
edit translation must agree on relation identity, key semantics, and loss.

Lenses do not turn schema evolution into implicit best-effort coercion. A host
chooses exact lens artifacts; failure remains structured evidence.

## Constraints

Constraints evaluate logical before/after state, bases, and touched relations.
Current-state checks and final-candidate checks are distinct. A final candidate
must pass projection and blocking constraints before publication.

Constraint queries use the same logical query semantics as ordinary evaluation
and a deterministic work budget. Exhaustion or unavailable evidence makes the
result indeterminate and blocks a write when correctness cannot be proven.

Audit issues may accompany success; blocking issues prevent publication. Hosts
must not install an adapter-specific second constraint semantics.

## Boundary review

Adversarial review should ask:

- Can aliases mutate a supposedly owned value after parsing?
- Can canonicalization reorder an ordered domain value?
- Can hostile nesting or width create unbounded work or recursion?
- Can data select executable behavior or load a module?
- Can a schema/mapping mismatch advertise a write that lowering cannot honor?
- Can native source values bypass conflict-aware parsing?
- Can type inference accept a value runtime parsing necessarily rejects?
