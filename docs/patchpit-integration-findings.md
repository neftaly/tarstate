# Patchpit integration findings and upstream design

Status: non-normative integration feedback and implemented upstream design from
Patchpit, 2026-07-15. Normative behavior remains in `docs/v1/`.

## Implementation outcome

The three accepted tracks landed under these source-generic boundaries:

- `prepareWritableExecutionContext`, `executePreparedTransaction`, and
  `simulatePreparedTransaction` provide ordered statement staging and one final
  `AtomicSource` handoff;
- `LogicalMemoryAtomicSource` and `LogicalMemoryStorageBinding` are the generic
  in-memory proving adapter;
- `AutomergeMappedStorageBinding` consumes a compiled `json-tree-v1` mapping
  for the supported object-map slice, including creatable final collections;
- `ExactArtifactResolver` composes embedded, registered, catalog, and
  authority-approved resource candidates with exact artifact verification;
  and
- `automergeArtifactResourceDriver` extracts inert carriers and heads through a
  temporary host-supplied Repo lease which is released before resolution
  settles; exact-resolution attempts and attachment preparation retain that
  provenance rather than discarding the carrier basis.

The follow-on capabilities identified below remain represented by the generic
contracts. Array-backed mappings, Automerge rekey/move, and richer physical
field-edit lowering still reject explicitly until their preservation and
concurrency semantics are implemented.

## Integration slice

Patchpit stores its workspace in canonical Automerge data shaped as the logical
relations `state`, `contexts`, `panes`, `paneContexts`, and `splits`. It seals a
Tarstate `json-tree-v1` storage mapping and uses `projectStorage` to parse that
data into relations with completeness and issues. Source readiness is supplied
separately by the captured source snapshot.

Patchpit applies named product operations such as open, activate, close, move,
split, and resize. A canonical Automerge writer stages each operation through
`AutomergeAtomicSource` before committing it. A known stale-basis rejection may
cause Patchpit to reapply the named operation to a fresh snapshot; an unknown
outcome is never retried.

This arrangement keeps workspace topology and retry policy in Patchpit, but it
also exposes a missing composition between Tarstate's transaction evaluator,
storage mappings, bindings, and atomic sources.

## Assessment and disposition

| Finding | Disposition |
| --- | --- |
| Reusable source-local transaction executor | Proceed after defining a prepared writable execution context and ordered staging protocol. |
| Compiled-mapping-backed Automerge binding | Proceed for demonstrated `json-tree-v1` object-map storage only. |
| Multi-issue schema parsing in Automerge bindings | Fold into the mapping-backed binding rather than create a separate workstream. |
| Query-backed constraints | Treat as executor acceptance, not a separate orchestration layer. |
| Artifact-reference and resource-resolution composition | Keep as an independent design track and require it before external artifacts become mandatory. |

The following ideas are deliberately out of scope for these tracks:

- separate runtime arguments for a sealed transaction artifact;
- a general filtered, joined, or unnested storage-mapping language;
- array-backed Automerge relations in the first mapping-backed binding;
- a Patchpit-specific constraint engine;
- a Tarstate-standard embedded bundle or filesystem layout;
- a Tarstate rule requiring one immutable Automerge carrier per artifact; and
- persistent Automerge Repo handles or subscriptions in resolved artifact
  cache entries.

This is not a claim that every undemonstrated capability should be removed.
Some capabilities remain part of the intended general model but should follow
the smallest proven slice:

- `json-tree-v1` includes array collections, so a complete mapping-backed
  adapter family should eventually support them with explicitly nondurable
  position locators and conservative concurrent-edit behavior;
- mapping-backed bindings should eventually lower every schema-declared field
  edit that the physical source can implement without preservation loss,
  including counter, text, list, and conflict-resolution edits;
- a reusable executor should remain source-generic and must not encode
  Automerge assumptions merely because Automerge is the second proving source;
- exact artifact resolution should work for every Tarstate artifact kind and
  every authority-approved resource driver, not only Automerge-hosted schemas,
  mappings, and constraints; and
- host-defined catalogs and multi-artifact carriers remain supported candidate
  sources even though Patchpit currently embeds a simple local map.

Rekey and move remain capability-gated rather than universal. Generic contracts
may support them, but the built-in Automerge adapter must continue to reject
them until it can prove the required identity, reference, and concurrency
semantics.

## Contract clarification

Tarstate v1 specifies a transaction execution model and separately exposes two
production surfaces:

- `InMemoryAtomicSource` evaluates a complete `TransactionAttempt` against its
  own logical memory representation; and
- `coordinateSourceCommit` accepts logical edits that have already been
  produced, plans them through `StorageBinding` instances, stages source
  commands, validates staged storage, and commits once through `AtomicSource`.

Despite its name, `InMemoryAtomicSource` does not implement the generic
`AtomicSource<Storage, Command>` protocol: its commit boundary is a
`TransactionAttempt` and a complete `CommitReceipt`. Track A must extract its
reusable logical semantics rather than treat the class as another protocol
adapter.

The v1 conformance claim covers the semantics exercised across those surfaces.
It does not mean that a public executor currently composes an arbitrary
transaction artifact with an arbitrary `AtomicSource`. Patchpit demonstrates
that this missing composition is useful. The normative v1 overview and
conformance matrix should say this explicitly so the new work is not mistaken
for either an already available API or a failure of the existing narrower
contract.

## Track A: source-local transaction execution

### Demonstrated gap

Transaction artifacts describe statements, guards, returning values, and
receipts. `InMemoryAtomicSource` can simulate and commit a complete
`TransactionAttempt`. `AutomergeAtomicSource`, by contrast, accepts an already
planned `SourceCommitInput<AutomergeSourceCommand>`. `coordinateSourceCommit`
begins after the caller has produced logical edits; it is not the transaction
evaluator.

A host therefore cannot currently take a named semantic operation, evaluate
its transaction queries and guards against an attached Automerge source, check
constraints on the staged logical state, and atomically commit the resulting
commands through one reusable public executor. Patchpit retains a
product-specific canonical writer rather than recreating this generic layer.

### Prepared writable execution context

The executor should consume one already-authorized, already-prepared context.
That context should own the facts needed throughout one attempt:

- attachment ID, incarnation, fingerprint, and authority-view fingerprint;
- the one `AtomicSource` and its active operation epoch;
- exact schema-view references and applicable capabilities;
- the participating `StorageBinding` instances;
- an adapter-neutral prepared query service over projected logical relations,
  able to serve transaction query nodes with parameters and compiled constraint
  queries with basis evidence;
- prepared source-local constraints; and
- an artifact resolver restricted to transaction artifacts permitted by the
  context; and
- an operation ledger which reserves accepted attempt identities before
  evaluated guards and constraints can return a receipt.

The context must be writable and must be tied to the same source as every
binding. Its construction is the authority and capability boundary. The
executor should not repeat discovery or accept raw bootstrap declarations.

The executor captures a single ready `SourceSnapshot` from the source. Callers
do not pass a second basis alongside that snapshot. `TransactionAttempt` may
still contain `expectedBasis`; when present it must equal the captured basis or
the attempt rejects before commit handoff.

Current transaction artifacts already contain their bound parameter values.
The executor therefore accepts a `TransactionAttempt`, not a transaction plus
separate arguments. Reusing one transaction structure with different values
currently means sealing distinct artifacts. A future transaction-template
format would require a separate, versioned proposal.

Simulation also accepts a complete attempt, including operation epoch and
operation ID, so its receipt can correlate with a later commit. It does not
reserve that identity in the source. A later commit may reuse the pair only for
the exact same intent; a host must not reuse it for a different intent merely
because the earlier execution was a simulation.

### Ordered staging protocol

Execution should use one captured physical snapshot and maintain both a staged
physical snapshot and its projected logical state.

1. Adopt the attempt and prepared context once at the public boundary.
2. Capture one ready source snapshot and verify attachment identity, operation
   epoch, context writability and authority, and optional expected basis.
3. Resolve and parse the transaction artifact exactly, then verify its schema
   view and required capabilities against the prepared context. Compute the
   intent hash from exactly the operation epoch, transaction hash, attachment
   ID, attachment fingerprint, optional expected basis, and authority-view
   fingerprint. Operation ID and physical command objects are excluded from
   portable intent identity.
4. Project every participating binding. Any required incomplete projection
   rejects; it is never converted to an empty relation.
5. For each statement in order, evaluate its target set and expressions from
   that statement's starting logical state. Produce logical edits and the
   statement result without mutating live storage.
6. Plan that statement's edits against the current staged physical snapshot.
   Check declared footprints and merge potentially competing intents across
   bindings for that statement only.
7. Append the resulting commands to the ordered command list, stage them, and
   reproject affected bindings before evaluating the next statement. Footprint
   overlap between different ordered statements is allowed; overlap between
   unordered binding plans for one statement still requires a merge proof.
8. Evaluate affected-count and query guards against the ordered staged result.
9. Derive exact staged basis evidence from the source and evaluate required and
   audit constraints against the complete final logical staged state. Required
   violation, indeterminacy, or unavailable staged basis rejects.
10. Evaluate returning queries against that same final logical state, retaining
    rows and result keys until an actual committed after-basis is known.
11. Simulation stops here and emits a simulation receipt. Commit execution
    hands the complete ordered command list to the source exactly once.
12. Wrap the source outcome without retrying. A committed outcome receives the
    actual before- and after-bases and returning evidence. A rejected or unknown
    outcome makes no invented after-basis or durability claim.

Cancellation before source handoff rejects without mutation. Cancellation
after handoff cannot change or conceal the source outcome. The executor never
replans after handoff and never retries an unknown result.

The executor also deliberately forgoes v1's optional safe pre-handoff replan
when no expected basis was supplied. It always commits against the one captured
basis. If that basis becomes stale, the source rejects and the host may choose
to reapply the named semantic operation to a fresh snapshot.

### Required protocol decisions

Implementation must settle these details before introducing a public name:

- how a prepared attachment fingerprint is derived and refreshed;
- how participating bindings and constraint dependencies are selected;
- how the current transaction-query and compiled-constraint callback shapes
  are unified behind one prepared query service without weakening parameter,
  basis, completeness, or issue evidence;
- how statement counts are reconciled with binding normalization during
  reprojection;
- how semantic field edits retain their mechanism and preservation-loss
  evidence after lowering;
- how returning evidence receives the source's actual committed after-basis
  without re-evaluating queries after handoff; and
- whether simulation exposes staged physical storage, staged logical state, or
  neither on the stable public surface.

### Acceptance

- The same transaction semantics execute against prepared in-memory and
  Automerge attachments with equivalent logical results and receipt shape.
- Later statements, guards, returning queries, and constraints observe all
  earlier staged effects.
- Two ordered statements may intentionally write the same physical footprint;
  unordered overlapping binding intents never gain last-writer-wins behavior.
- A successful execution calls exactly one source commit and emits at most one
  source notification.
- A no-op commits at the same basis and emits no source notification.
- Required incomplete input rejects and cannot be interpreted as an empty
  relation.
- Expected-basis rejection occurs before source handoff.
- Committed, rejected, and unknown outcomes remain distinct; unknown is never
  automatically retried.
- Simulation never mutates storage or reserves a source operation ID; its full
  attempt identity is correlation evidence that may be reused only for a later
  commit of the same intent.

## Track B: mapping-backed Automerge object-map binding

### Demonstrated gap

`projectStorage(CompiledStorageMapping, snapshot)` gives Patchpit a declarative,
sealed read projection with parsed relations, issues, and completeness.
`AutomergeMapStorageBinding` can plan insert, delete, and replacement commands,
but it is configured separately with a relation ID, collection path, key
source, and parse callback. It does not consume the compiled mapping used for
reads.

An application must therefore duplicate physical mapping facts in an
imperative write binding or retain a canonical writer next to its declarative
read mapping. Patchpit currently retains the canonical writer.

### First supported slice

The first mapping-backed binding should consume one sealed
`CompiledStorageMapping` and support only relations whose collection mapping is
an Automerge object map. It should support:

- mapped key fields from the object-map key or candidate field paths;
- mapped logical fields at declared physical paths;
- existing object-map collections and a `creatable` final collection when its
  parent path exists unambiguously;
- relation insert, delete, and replace-field logical edits;
- exact physical-path intents and a conservative collection-subtree declared
  footprint; and
- Automerge object identity as the binding-owned row locator.

Array collections, rekey, move, filtered collections, unnesting, joins, and
arbitrary construction functions are rejected as unavailable capabilities in
this first slice. Array collections and schema-declared physical field edits are
explicit follow-on work; the broader mapping-language features still require
independent evidence. In particular, the binding makes no identity-preserving
move claim.

The portable mapping does not itself provide stable physical identity:
`object-map-key` changes under rekey and `array-position` is explicitly
nondurable. Projection equivalence therefore means equal logical rows, logical
keys, completeness, and issues. It does not require identical locator values
between `projectStorage` and the Automerge binding. The Automerge binding adds
its own locator and source evidence at the storage boundary.

Issue equivalence is likewise semantic rather than byte-for-byte equality. The
projection paths must agree after physical candidate-path rebasing, and issue
code, phase, severity, retry guidance, and required capabilities must agree.
Binding-added source, relation, locator, and authority-permitted row evidence is
enrichment and does not make otherwise equivalent schema issues different.

### Write semantics

Replacement uses the declared field path and write capability from the
compiled mapping. Unspecified and unmapped physical fields remain untouched.

Insertion must:

- parse the complete logical candidate through the prepared relation schema;
- derive exactly one string object-map key from the declared `map-key` mapping;
- materialize every mapped key and field path without inventing unmapped
  physical fields;
- reject an existing or conflicted destination; and
- create only the final collection allowed by `absent: 'creatable'`, never
  missing or conflicted ancestors.

Deletion removes exactly the located object-map entry after confirming that
the supplied logical key and binding-owned locator still identify the projected
candidate.

Insert and delete are baseline relation operations when the representation is
unambiguous. Replacement continues to require each field's declared write
capability. This track does not add new built-in insert or delete capability
references.

### Complete parse evidence

The mapping-backed binding should use the prepared schema parser and preserve
its complete `ParseResult`:

- all failure issues are retained;
- non-error issues from a successful parse are retained;
- candidate-relative issue paths are prefixed with the physical candidate
  path;
- source ID, relation ID, logical key when known, locator, and permitted row
  evidence remain attributable without being hidden in a flattened message;
  diagnostic evidence remains bounded by the prepared authority context; and
- a rejected candidate makes relation and binding completeness unknown.

The existing Automerge map parser already makes a failed candidate incomplete.
The new work is issue multiplicity, successful-parse issues, evidence rebasing,
and direct reuse of the compiled schema and mapping.

### Acceptance

- For the supported object-map subset, projection through the binding produces
  the same logical rows, keys, completeness, and equivalent schema issue
  identities and rebased paths as
  `projectStorage` for the same mapping and Automerge snapshot.
- Insert, delete, and replacement commands round-trip through projection.
- Ordered replacements of the same field stage correctly for transaction
  execution.
- Unmapped sibling fields and nested physical fields survive replacement.
- Insert rejects incomplete candidates, non-string or ambiguous map keys,
  occupied/conflicted destinations, and uncreatable collection paths.
- Delete rejects stale keys or locators.
- Multiple parse issues and successful parse warnings retain their structured
  evidence.
- Malformed candidates never throw from projection and never appear as a
  complete empty relation.
- Array mappings and movement fail explicitly rather than receiving accidental
  semantics.

### Follow-on general coverage

After the object-map proof, the adapter family should cover the rest of the
existing portable contracts without broadening their semantics:

- array collections project with nondurable position locators, reject stale
  positions, and define insert/delete footprints against concurrent list edits;
- counter increment, text splice, list splice, and explicit conflict resolution
  lower only when the mapping and Automerge value at the mapped field path
  support the requested mechanism;
- capability and preservation-loss evidence survives lowering into statement
  results; and
- unsupported rekey or move remains an explicit capability failure, not a
  replace/delete approximation.

Filtered, joined, or unnested mappings remain separate mapping-language work.
They should be added only with a portable representation and preservation laws,
not hidden inside an Automerge-specific binding.

## Query-backed constraints

Tarstate already has portable constraint sets, attachment-time constraint
preparation, and final-state constraint checking. No Patchpit-specific
constraint layer is justified.

The source-local executor must pass the final projected logical state and exact
basis evidence to prepared constraints. Track A must adapt the currently
different transaction-query and compiled-constraint callback shapes to the same
prepared query service used by query statements, guards, returning queries, and
constraints. Required constraints reject both violations and indeterminate
results; audit constraints contribute warnings without blocking the source
commit.

This is acceptance for Track A after Track B supplies a writable Automerge
projection. It is not an independent implementation track.

## Track C: exact artifact resolution

### Demonstrated gap

Patchpit currently makes its workspace document self-contained. The document
names its exact primary schema artifact with an `ArtifactRef` and also embeds
that sealed artifact in a document-local map. This is useful portable
packaging, but an inline-only rule would duplicate artifacts that naturally
live in catalogs or external carriers.

Tarstate already defines the component boundaries:

- `ArtifactRef` separates exact artifact identity, `{ id, contentHash }`, from
  optional locations that do not participate in semantic identity.
- Automerge bootstrap metadata preserves locations on storage-schema,
  storage-mapping, and constraint references.
- `prepareDatabaseAttachment` accepts an effect-isolated artifact callback and
  verifies the resolved artifact's kind, ID, and content hash.
- `ResourceResolver` supplies authority checks, scheme drivers, redirects,
  caching, carrier integrity checks, and explicit lifecycle states.
- `@tarstate/automerge` owns a structural Automerge Repo source-runtime
  boundary without taking a hard dependency on Automerge Repo.

These pieces are not composed. Attachment preparation collapses missing and
failed callback results into artifact dependency issues, and no public path
selects authorized `ArtifactRef.locations`, preserves per-location lifecycle
evidence, or extracts an inert artifact from an Automerge carrier.

### Resolution boundary

An exact-artifact resolver should accept every Tarstate artifact kind together
with:

- the expected artifact kind and exact `ArtifactRef`;
- an authority scope and optional cancellation signal;
- embedded and pre-registered exact-artifact stores supplied by the host;
- the host's `ResourceResolver`; and
- optional host catalog candidates.

Embedded, registered, catalog, and location candidates share one result model.
Each attempted candidate retains its resource identity, lifecycle, freshness,
issues, and source basis or provenance. Overall resolution is ready only when
one candidate yields an inert artifact with the expected kind, ID, and content
hash. When none succeeds, individual loading, missing, denied, failed, deleted,
and unsupported states remain visible rather than being collapsed into an
empty relation or one generic missing result.

Embedded stores and catalogs receive the authority scope, expected kind, and
abort signal for the attempt. Resolution checks cancellation before and after
each awaited host callback and never accepts a candidate after cancellation.

Host candidate priority selects provenance among multiple exact matches; it
never selects semantic content. Every exact match has the same meaning.
Wrong-kind, wrong-ID, wrong-hash, and malformed values remain diagnostic
attempts and never satisfy the reference. Locations are availability hints,
grant no authority, and never authorize code execution.

### Carrier integrity and artifact identity

Artifact locations should enter `ResourceResolver` as inert `data` carriers,
regardless of the location scheme.
Resolver integrity, when supplied, applies to the carrier representation.
After resolution, the artifact layer parses the carrier and independently
checks the sealed artifact's semantic content hash. An Automerge document's
heads are source basis or provenance; they are neither carrier-byte integrity
nor artifact semantic identity.

Tarstate does not need to standardize whether a carrier contains one artifact
or a host-defined bundle. The host-provided extractor must return an inert
candidate, and exact artifact verification remains identical in either case.
Changing or upgrading a carrier cannot silently change the meaning of an
existing exact reference: the old reference either still resolves to its exact
artifact or becomes unavailable.

Artifact locations remain non-semantic during reference equality, command
hashing, and governance alternative comparison. Governance metadata mutations
must nevertheless preserve the selected raw reference's location hints on
initialization, constraint activation, and conflict repair; normalization for
comparison must not become normalization of the written carrier.

### Automerge Repo driver lifetime

An Automerge resource driver should use a host-supplied structural Repo
interface to acquire the carrier, wait for the requested snapshot state,
extract an inert carrier value and exact heads, and release its handle before
the resolution call settles. Loading, cancellation, failure, and unsupported
results must also release temporary handles.

Resolved cache entries contain only inert extracted values and provenance, not
Repo handles or subscriptions. Persistent observation of artifact carriers is
out of scope. Hosts retain the existing responsibility to invalidate resolver
caches when their freshness policy requires it. Resolver cache identity remains
authority-scoped; this track does not require cache eviction whenever one
attachment closes.

### Attachment preparation composition

Attachment preparation should consume exact-artifact resolution results rather
than a callback that returns an untyped value. It should retain dependency
lifecycle evidence on unavailable preparation and continue to verify every
artifact before preparing schemas, mappings, or constraints.

Ready and unavailable preparation results retain the complete exact-resolution
records, including unsuccessful fallback attempts and selected carrier
provenance; issues are not a substitute for those structured records.

The same boundary applies to embedded and external artifacts. Patchpit may keep
its current inline packaging while this track is absent. It should not make
external workspace artifacts mandatory or build a parallel product resolver.

Patchpit should use Tarstate's complete Automerge bootstrap declaration when it
adopts this path. A writable attachment needs its logical storage schema and
either a portable storage-mapping reference or a trusted storage binding. The
product may continue to identify the document as a workspace without defining
another artifact-resolution model.

### Acceptance

- The same attachment prepares equivalently when its artifacts are embedded,
  pre-registered, catalogued, or obtained from an authorized location.
- A wrong artifact kind, ID, content hash, or malformed carrier never satisfies
  the reference.
- Per-candidate loading, missing, denied, failed, deleted, and unsupported
  states remain distinguishable.
- Multiple locations cannot select different semantic content for one exact
  reference.
- Carrier integrity, Automerge heads, and artifact content hash remain distinct
  evidence.
- Location and redirect authority are checked by `ResourceResolver` before
  carrier extraction.
- Cancellation and every terminal driver path release temporary Repo handles.
- Resolver caches contain no Repo handles, subscriptions, executable modules,
  or authority-independent results.
- Governance initialization, activation, and repair preserve selected location
  hints even though those hints remain outside semantic artifact identity.
- Query, transaction, schema-lens, issue-catalog, and future artifact kinds use
  the same exact-resolution boundary as schemas, mappings, and constraints.
- Non-Automerge scheme drivers satisfy the same authority, lifecycle,
  provenance, cancellation, and exact-verification rules.

## Boundaries and non-gaps

- Stale-basis retry is product or host policy. Patchpit retries only a known
  stale rejection by reapplying a named semantic operation to a fresh snapshot.
  Low-level sources and the generic executor do not retry automatically.
- Workspace graph invariants, topology repair, active-context behavior, and
  split semantics are Patchpit product constraints. Tarstate supplies
  projection and execution machinery without knowing this graph.
- Arbitrary cross-source semantic operations are not implied. One source
  remains the atomic write boundary; cross-source work is explicitly
  non-atomic.
- Raw Automerge handles, unresolved resources, and sandbox-local state do not
  cross an authority-scoped application launch boundary.
- Folder co-location and embedded bundle shapes are packaging policy, not
  Tarstate artifact semantics.
- Refresh behavior and app-facing capability APIs still lack a demonstrated
  Tarstate use case.

## Delivery order

1. Clarify the normative v1 overview and conformance claim for the existing
   split execution surfaces.
2. Define the prepared writable execution context and ordered statement staging
   protocol. Extract the reusable pure transaction semantics from the memory
   implementation without changing public behavior.
3. Implement and prove the compiled-mapping-backed Automerge object-map binding,
   including complete schema parse evidence.
4. Compose the executor with in-memory and Automerge attachments and prove
   equivalent receipts, incomplete-input rejection, no-op behavior, and unknown
   outcome handling.
5. Exercise prepared query-backed constraints through that executor.

Exact artifact resolution is independent. It should precede any Patchpit change
that makes external workspace artifacts required, but it does not block the
transaction and binding tracks while Patchpit retains embedded artifacts.

Together these changes would let Patchpit remove its canonical writer and
orchestration duplication while retaining product semantics, canonical
ownership, authority, and retry policy in the product layer.
