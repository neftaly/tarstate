# Lifecycle, errors, and authority

## Ownership vocabulary

Every live component must make clear whether it owns, borrows, or shares each
source, listener, maintenance session, registry, and child resource.

- An **owner** creates or explicitly adopts responsibility for cleanup.
- A **lease** borrows a resource until one idempotent release.
- A **snapshot** is immutable observation, not ownership.
- A **prepared value** owns its detached portable facts but no live source.
- A **service** owns only the lifecycle named by its construction contract.

Cleanup order follows dependency order: stop new work, unsubscribe upstream,
release downstream sessions/leases, then close an owned source. Cleanup failure
may be diagnosed, but must not prevent independent cleanup steps.

`close()` and release functions should be idempotent. Calls which require an
open resource may throw after close. Async work already in flight must either
finish with honest evidence or observe cancellation; it must not publish through
a replaced incarnation.

## Error taxonomy

Tarstate uses three error channels for three ownership boundaries.

### Parse results

`ParseResult<T>` is for untrusted portable values where malformed input is an
expected domain outcome: artifacts, schemas, mappings, metadata, receipts,
parameters, and adapter open inputs.

A failed parse returns structured issues and no partial value. Safe parsers do
not throw for malformed data within their documented input domain. Convenience
parsers may throw `TarstateParseError`, but their name and return type must make
that choice explicit.

### Thrown errors

Throws are for programmer contract violations or broken internal invariants:
empty required identifiers, using a relation from the wrong schema view,
calling after close, duplicate internal ownership, an impossible capability
composition, or an unavailable platform primitive required by construction.

Exceptions must not represent ordinary stale concurrency, constraint failure,
denied authority, missing source data, or a rejected transaction.

### Issues and receipts

Issues describe expected operational evidence. Transactions resolve to receipts
whose outcomes include committed, rejected, and unknown. Database snapshots may
carry current source/projection issues. Observation should not throw from a
subscription callback merely because a source entered a failed state.

Unexpected exceptions caught inside an operation shell may become an issue only
when the shell can still state the outcome honestly. If publication may have
occurred, the result is unknown rather than rejected.

## Issue contract

Issue codes are stable machine vocabulary. An issue includes phase, severity,
retry guidance, and relevant portable context. IDs and detached detail objects
must not encode nondeterministic object identity.

Retry guidance describes what evidence could change the outcome; it is not an
automatic retry instruction. Product retry policy remains consumer-owned.

New issue codes require:

- one precise condition;
- a stable phase and severity;
- explicit retry meaning;
- negative and positive evidence;
- no collision with a programmer-invariant throw.

## Authority

Capabilities separate portable declarations from host-installed
implementations. A registry has an explicit trust/authority identity and a
fingerprint. Preparation proves required capabilities against that view.

Authority scope must be supplied at application composition. Artifacts,
documents, queries, or source links cannot grant their own authority. Resolving
an artifact or discovering a source does not imply permission to execute a
capability or write it.

Prepared plans are exact to their registry, authority, and dataset
fingerprints. Live transaction and database contexts are exact to the authority
under which they were composed and must not be reused under another one.
Source-neutral attachment preparation may be reused only when its registry,
schema, mapping, and resolver evidence remain valid; it must be combined with a
new authority-specific live context. A caller-visible string scope is
application evidence, not a substitute for the host's actual authorization
checks.

## Cancellation and replacement

Abort signals cancel work that has not irrevocably published. Cancellation
after publication cannot rewrite a committed receipt into rejection.

Source, attachment, and operation epochs prevent stale work from crossing a
replacement boundary. Retiring an epoch bounds idempotency storage and makes
later lookup explicitly expired.

## Lifecycle adversarial review

Review reentrant notification, close during async work, double close, partial
construction failure, listener exceptions, source replacement under the same
ID, stale callbacks, abort at every await, outcome lookup failure, authority
change, and cleanup steps which throw.
