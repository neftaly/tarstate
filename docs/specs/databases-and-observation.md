# Databases and observation

## Database boundary

A live database combines an exact prepared attachment with a source lifecycle
and logical projection. It presents a synchronous external-store API:
`getSnapshot()` reads the current immutable snapshot and `subscribe(listener)`
observes later transitions.

Official live databases also expose immutable `sourceId` and `attachmentId`
fields. They are the exact detached identities used by mounts and commit
receipts, so host orchestration can name a database without retaining or
reconstructing opener inputs. Identity does not grant authority or expose a
source handle.

The subscription callback is only a notification. Consumers must call
`getSnapshot()` to read authoritative state. A source or database must not
publish a new snapshot object when no observable state changed.

A query observer may additionally deliver a proven diff, invalidation, or reset
as change evidence. Its `getSnapshot()` result remains authoritative; consumers
must not reconstruct current state by assuming every notification is a diff.

## Snapshot contract

A snapshot explicitly distinguishes closed versus open state. An open snapshot
reports readiness, source lifecycle, freshness, basis, schema view,
completeness, rows, and issues as applicable.

Ready logical data must correspond to the reported basis. A stale snapshot may
remain useful if labeled stale; it must not claim current freshness. Failed,
denied, deleted, loading, and closed are distinct lifecycle meanings.

Readonly row arrays may be retained across observations when their exact
projection is unchanged. A helper selecting a typed mapped relation should
verify the exact schema view and preserve row identity without copying solely
for API shape.

## Attachments and membership

An attachment catalog owns attachment identity and incarnation. Replacing an
attachment under the same logical ID creates a new incarnation so stale leases
and observations cannot act on the replacement.

Dataset membership is explicit. Acquiring a member returns a lease; releasing
or closing it is idempotent. Membership changes and source-data changes are
different events even if both cause a query result transition.

No observer may infer source ownership merely from being given a snapshot.
Ownership and cleanup are explicit at composition.

## Database observation

Observation captures a consistent dataset frame, prepares requested relation
inputs, and invokes an injected maintenance implementation. The generic
observer does not import incremental query maintenance; the incremental adapter
is selected at composition.

Observation must serialize or otherwise make transitions atomic to subscribers.
A listener added or removed during notification must not corrupt iteration.
Reentrant source notifications may coalesce, but the eventual snapshot must
represent the newest captured state.

Diagnostics are bounded and cold. Hot maintenance should update numeric or
retained diagnostic state; it should not allocate strings and detached report
objects unless they are observed or a failure requires them.

## Query sessions

A database query session owns the lifecycle of its prepared query observation,
source mounts, optional discovery graph, settlement coordination, and cleanup.
One idempotent `close()` releases everything the session acquired.

Fixed sources are mounted directly. Source links may discover additional source
identities through declared edges. Discovery is a fixed-point process over
stable source identity, not arbitrary recursive code execution.

## Source-link discovery

Discovery must be:

- bounded by explicit node/edge/work limits;
- cycle-safe and deterministic;
- authority-aware at every newly resolved source;
- resilient to sources arriving, disappearing, failing, or changing links;
- separate from query semantics and product navigation policy.

Dynamic membership may change the dataset and trigger incremental maintenance.
It must not make a query import a resolver or source-specific adapter.

Settlement means the session has accounted for the currently known discovery
and source readiness work. It is not a promise that remote systems will never
change again.

## Identity layers

Keep these identities separate:

- artifact identity: `(id, contentHash)`;
- source identity: host-stable source ID;
- attachment identity and incarnation;
- schema view and relation ID;
- logical row key in declared tuple order;
- source occurrence identity where available;
- query result occurrence key;
- operation epoch, operation ID, and intent hash.

Substituting one for another is a coupling and correctness defect. In
particular, array position is not source identity and a canonical key string is
an internal index representation, not a consumer concept.

## Observation adversarial review

Review changes for stale publication, missed wakeups, duplicate notifications,
reentrant teardown, identity reuse across replacement, unbounded discovery,
source-link cycles, retained listeners, copying unchanged rows, and demand
analysis that omits a semantically required field.
