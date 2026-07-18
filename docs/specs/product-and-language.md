# Product scope and domain language

## Product sentence

Tarstate is a portable relational layer over host-owned state: schemas describe
logical relations, queries derive views, databases observe sources, and
transactions author logical intent which an adapter validates and publishes.

The consumer should describe domain rows, queries, and replayable operations.
Tarstate should own generic preparation, indexing, projection, diffing,
constraint evaluation, reconciliation, and receipt construction.

## Domain vocabulary

### Portable value

A JSON value or registered tagged value that can cross source, artifact, query,
and receipt boundaries without depending on a JavaScript object identity.
`missing`, `unknown`, and `capability unavailable` are distinct semantic states;
they must not be collapsed into `null` or `undefined`.

### Artifact

An immutable, content-addressed portable envelope. Its exact identity is the
pair of `id` and `contentHash`. Its body cannot select executable code.

### Schema view

The exact schema artifact against which rows, relation keys, queries, mappings,
and transaction capabilities are interpreted. Equal relation names under
different schema views are not interchangeable.

### Source

Host-owned storage plus a lifecycle, a basis, and observation or commit
semantics. Tarstate may retain a snapshot supplied by a source; it does not
claim ownership of the host's persistence or network protocol.

### Attachment

The validated relationship between one source and a logical database view. It
contains or resolves the declaration, exact schema view, projection/mapping,
constraints, relation keys, and effective writability. It is not a file or an
email attachment.

Preparation derives owned source-neutral logical facts from portable artifacts.
Some prepared facts, such as compiled constraints and projection callbacks, are
functions and are not themselves portable. A live adapter combines the
preparation with a source binding and authority policy. Preparation must not own
a source-specific driver.

### Database

A synchronous external-store view of one prepared logical source, optionally
with transaction capabilities. Its snapshot makes lifecycle, freshness,
readiness, basis, issues, rows, and schema evidence explicit.

### Dataset and query session

A dataset is the currently mounted membership used for query evaluation. A
query session owns observation, optional source-link discovery, incremental
maintenance, settlement, and teardown for one prepared plan.

### Intent and transaction

Intent is application-owned portable meaning. A replayable transform derives
the desired logical state or semantic edits from an immutable snapshot. The
private transaction artifact is the source-neutral staged form; the adapter
lowers it into source-native work.

### Basis

Exact source evidence identifying the state used for evaluation or publication.
A basis is adapter-defined portable data. Automerge uses an order-insensitive
exact head set.

### Issue and receipt

An issue is structured evidence about malformed input, unavailable capability,
failed constraint, stale state, or another expected failure. A receipt records
the outcome and evidence of an attempted operation; it is not an exception.

## Scope boundaries

Tarstate owns:

- portable value, artifact, schema, query, transaction, issue, and receipt
  semantics;
- generic logical projection and query evaluation;
- incremental query maintenance and database observation;
- generic attachment preparation and replayable transaction orchestration;
- source-neutral reconciliation and validation ordering;
- official adapter composition and framework bindings shipped in this repo.

Consumers own:

- domain operations and the pure application transformation they apply;
- product-specific document conventions and metadata governance;
- persistence, replication, authentication, authorization policy, and UI;
- retry presentation, presence/focus semantics, and conflict resolution UX;
- conversion between application domain models and logical relation rows.

## Non-goals

Tarstate is not a SQL server, ORM, persistence engine, CRDT, general workflow
engine, application operation framework, or universal state container. It does
not make every adapter multiplayer. It does not promise to preserve incidental
object identity, source ordering, or native scalar classes unless the relevant
contract says so.

Feature breadth is not a goal by itself. A new query operator, mutation form,
adapter, or public entrypoint must remove demonstrated consumer work or enable a
strongly justified semantic capability without creating a parallel path.
