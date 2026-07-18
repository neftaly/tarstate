# Subsystem boundaries and decomposition

This document defines target responsibility boundaries. It does not require one
file per box, a rewrite, or a public API for internal phases.

## End-to-end semantic pipeline

```text
portable declarations
  → parse/resolve/prepare
  → source-neutral attachment facts
  + live source/binding/authority
  → database snapshots
  → prepared query evaluation/maintenance
  → observed readonly results

replayable operation
  + current logical snapshot
  → source-neutral logical transaction
  → binding plan/private candidate
  → final projection and validation
  → conditional source publication
  → portable receipt
```

Every arrow is an ownership boundary. Values crossing it should be explicit,
owned, and no broader than the next phase needs.

## Authority table

| Concern | Semantic owner | Effect owner | Must not own |
| --- | --- | --- | --- |
| Portable parsing | value/artifact/schema core | boundary caller | source handles, UI policy |
| Artifact resolution | exact resolver protocol | host resolver | semantic handler loading from data |
| Attachment preparation | source-neutral attachment core | resolver/registry composition shell | live source driver |
| Source projection/planning | binding pure core | adapter composition | product operation meaning |
| Source snapshots/publication | source protocol | one adapter runtime | schemas, query semantics |
| Query semantics | prepared batch evaluator | none | subscriptions, React |
| Incremental maintenance | operator transitions and retained indexes | maintenance session | source lifecycle |
| Database observation | capture/publication rules | database view/session | adapter storage mutation |
| Transaction authoring | logical state/delta functions | replay shell invokes callback | source-native changes |
| Candidate validation | logical projection/constraints | transaction coordinator | canonical source mutation |
| React/Zustand | selection/store adapter rules | framework lifecycle shell | query or transaction semantics |

## Query subsystem

### Portable model and preparation

Owns ASTs, declarations, validation, scope fingerprints, dependencies,
projection demand, and prepared operator structure. It has no relation data,
listeners, or mutable indexes.

### Reference evaluation

Owns expression and operator semantics over one immutable input frame. It may
use caller-owned scratch internally but exposes one readonly result. This is the
differential oracle for optimized maintenance.

### Operator maintenance

Owns retained state for joins, aggregates, windows, ordering, and other
operators. Each transition consumes exact changes and either produces proven
new state/diff or requests an explicit fallback. It does not capture sources or
notify UI.

### Maintenance session and pooling

Owns operator graph lifetime, parameter/input revisions, fallback orchestration,
work sharing, and cleanup. Pool keys include every semantic scope field. Pool
publication cannot make mutable operator state public.

### Extraction signal

Extract an operator or transition when it has a distinct state model and
property/differential test, not merely to shorten the maintenance engine. Batch
and incremental implementations may share pure expression/equality/order
semantics but must not share the transition being differentially tested.

## Observation subsystem

### Dataset capture

Owns a consistent frame of membership, attachment incarnations, source bases,
authorization, lifecycle/freshness, and projection demand. It does not evaluate
a query.

### Maintenance bridge

Converts captured logical relation frames and exact changes into the injected
query-maintenance protocol. The generic observer does not import incremental
implementation code.

### Publication

Owns current/last-exact snapshots, proven diff/invalidation/reset evidence,
listener iteration, and diagnostic containment. It does not own sources.

### Session/discovery shell

Owns catalogs, membership leases, opened linked sources, fixed-point discovery,
settlement waiters, and close order. Source-link graph logic remains a pure
bounded model separate from async opening.

### Extraction signal

Split capture, maintenance, publication, or discovery only when a change crosses
their distinct state machines. Do not create one generic observable framework;
source, database, and query lifecycles carry different evidence.

## Transaction subsystem

### Boundary adoption and identity

Owns intent adoption, operation identity, intent hashing, abort evidence, and
ledger reservation/completion. It performs no logical write evaluation.

### Logical authoring

Projects the captured source, exposes an immutable typed transaction snapshot,
invokes the replayable callback, validates exact relation states/semantic edits,
and emits a portable transaction plus issues. It performs no publication.

### Evaluation and binding plan

Evaluates guards/statements/returning data, derives exact logical edits and
footprints, asks bindings to handle edits, and stages source-native intent
against an exact basis. Binding planning remains source-specific but deterministic
for its supplied snapshot.

### Ordinary optimistic coordinator

Hands staged commands to the common conditional-publication effect boundary. A
transient stale basis re-enters capture and logical authoring; permanent
rejection and unknown outcome go directly to receipt evidence.

### Captured-intent reconciliation

For an explicitly eligible transaction, combines captured commands with the
current source into a private candidate. This phase is optional source
capability. It cannot publish, evaluate product callbacks, or skip final
validation.

### Candidate validation

Projects integration and candidate snapshots, proves exact captured targets,
runs final constraints/returning queries, and yields either blocking issues or
a validated candidate basis. It is pure over snapshots and prepared context.

### Publication and receipt

For ordinary work, conditionally applies staged commands; for captured-intent
work, conditionally installs the validated candidate. It checks published basis
evidence, completes ledger state, and builds the portable receipt. This common
effect boundary is the only phase allowed to mutate the canonical source.

### Extraction signal

The transaction executor is a strong candidate for phase extraction because
ordinary replay and captured reconciliation have different control flow but
share preparation, validation, and receipt contracts. An extraction is valid
only if it prevents cross-phase mutation and reduces context; duplicating
receipt or validation logic would be worse than the current large module.

## Adapter subsystem

### Document/value boundary

Owns foreign/native value inspection and one conversion into portable logical
values. It is independent of database lifecycle.

### Mapping binding

Owns source-shape locators, exact projection, edit lowering, footprints, and
native capabilities. Pure mapping rules should be separate from command
closures or source publication.

### Source runtime

Owns one live source, exact basis comparison, commit serialization, source
notifications, source-native reconciliation/merge, bounded outcome evidence,
and close. It does not know schemas or queries.

### Standard opener

Is a small composition shell: boundary adoption → artifact index → attachment
preparation → runtime/binding → transaction service → live database. It should
not reimplement any phase.

## Framework and tooling boundaries

React query and mutation stores may share database observations but not query
indexes. Optimistic overlays transform observed results without claiming
publication. Zustand only adapts atomic store mechanics. Schema tools only
consume portable artifacts and emit build outputs.

These packages should remain removable without changing core behavior or
pulling their dependencies into unrelated bundles.

## Decomposition strategy

Tarstate does not currently need a clean rewrite. Use incremental,
evidence-driven decomposition:

1. Name the semantic/effect boundary and acceptance evidence.
2. Extract the pure side with task-specific inputs.
3. Keep one lifecycle/public path and route it through the extraction.
4. Delete duplicated old logic in the same change.
5. Run boundary, behavior, fuzz, type, tree-shake, and perf evidence appropriate
   to the path.
6. Repeat the coupling review; stop if no new material authority overlap exists.

A permanent v2 path, compatibility alias, generic command VM, or package split
is not an acceptable substitute for a cohesive boundary.
