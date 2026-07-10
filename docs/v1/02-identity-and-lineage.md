# Identity and lineage

Status: normative.

Tarstate distinguishes identity concepts that must never be substituted for one
another.

```ts
type SourceId = string
type SourceBasis = PortableValue
type AttachmentId = string
type RelationId = string
type LogicalKey = readonly [PortableValue, ...PortableValue[]]
type RowLocator = {
  namespace: string
  token: PortableValue
  rowIncarnation: string
}
type ResultKey = string

type BaseIdentity = {
  sourceId: SourceId
  relationId: RelationId
  locator: RowLocator
}

type BaseRowHandle = {
  attachmentId: AttachmentId
  attachmentIncarnation: string
  identity: BaseIdentity
  key: LogicalKey
  basis: SourceBasis
}
```

## Source identity and atomic ownership

A source is the unit of atomic commit.

- An Automerge live root source is identified by document identity, ignoring
  aliases, paths, and heads. A pinned historical view is a separate read-only
  attachment to that source.
- An external store source uses an explicit application-supplied ID. Attaching
  two different live stores under one ID is an error.
- An HTTP resource uses the requested canonical absolute URL as source identity;
  redirects are recorded separately and do not silently change identity.

HTTP identity uses WHATWG URL serialization after relative resolution. The
fetch identity excludes the fragment; the discovery edge retains it as an
application selector. Credentials and scheme-specific normalization remain host
policy and never derive authority from the URL itself.

Replacing a handle for the same source may preserve source identity, but it
invalidates the attachment incarnation and all queued row locators.

`BaseIdentity` excludes basis so an untouched row does not acquire a new
identity on every source commit. A query occurrence is attachment ID plus base
identity; this distinguishes simultaneous live and pinned views. A row handle
adds attachment incarnation, observed key, and basis as commit evidence; none
is stable identity.

Row incarnation is different: it distinguishes deletion/reinsertion or storage
entity replacement at the same token and remains part of base identity. A
source-handle replacement changes the attachment incarnation, not the row
incarnation, when the adapter can re-resolve the same storage entity. Result
keys then remain stable while old write handles reject as stale. If continuity
cannot be proven, the adapter emits a new row incarnation rather than guessing.

## Relation identity and names

Every relation has a stable `relationId` independent of its local schema key or
display name. Compatible schema versions MAY expose the same relation ID under
different names. A relation split or merge requires an explicit lens and does
not invent shared identity.

`relationId` is used in base row handles and references. Query-scoped aliases
are presentation and disambiguation only.

## Logical keys

A key is logical data used for lookup, refs, uniqueness, grouping, and API
ergonomics. It is not guaranteed to be stable entity identity or a physical
locator.

Keys may be composite. Source-scoped base identity is source + relation + row
locator; the currently parsed key is attached to that handle.

A logical key is always a non-empty tuple. A single array-valued field is
represented as a one-element tuple containing that array, so it cannot be
confused with a composite key.

If two storage candidates parse to the same key, neither is chosen as the
winner. Both remain inspectable through authority-safe issue/system relations,
normal keyed lookup is ambiguous, and writes by key fail. Candidates whose rows
otherwise parse remain in unkeyed scans and aggregates, with a key-integrity
issue; this does not make a complete scan inexact. Truly unparseable candidates
are excluded and make completeness indeterminate. The binding never discards
their locators or diagnostic evidence.

Authorized repair code may query `tarstate.system.repair_candidates` and select
one verified candidate inside the same database view and transaction. Raw
locator tokens supplied by an untrusted client remain invalid. This is the
sanctioned way to repair duplicate keys without making ordinary keyed writes
ambiguous.

## Row locators and incarnations

A storage binding supplies an opaque source-scoped row locator. A locator identifies a
specific storage entity and row incarnation. It may be an
Automerge object ID, a map slot plus object incarnation, an external-store
entity token, or a binding-defined synthetic locator.

The locator namespace is a stable binding-declared identity domain, not the
binding implementation version. A storage-binding upgrade retains it only when
the new binding proves token and row-incarnation continuity; otherwise it uses
a new namespace and result identity honestly resets.

Locators:

- are never schema keys;
- are never accepted from an untrusted app without authority-scoped
  verification;
- are not stable across delete-and-reinsert unless the source explicitly says
  so;
- are re-resolved or rejected when their handle basis or attachment incarnation
  is stale;
- may support reading legacy lists that lack application IDs.

Bindings MUST NOT use a mutable array index as a durable locator. For a legacy
list without IDs, an Automerge object ID may provide a readable locator, but a
portable writable schema SHOULD introduce a stable logical entry ID. Patchpit
v1's target folder model requires stable IDs; the archived positional-path
model requires migration. Position/path is ordering data, not identity.

## Rekey and replacement

Rekeying changes the logical key. If a binding advertises identity-preserving
rekey, the row locator/incarnation remains and declared refs can be rewritten in
the same source transaction. Otherwise rekey is explicit delete-plus-insert,
produces a new locator/incarnation, and returns replacement lineage. Generic
field update MUST NOT mutate key fields accidentally.

## Derived result identity

`ResultKey` supports deterministic diffs, React keys, and incremental state. It
does not authorize writes.

- A one-to-one projection derives it from query/operator identity and the row
  occurrence identity (attachment ID plus base identity), excluding basis and
  current key. Attachment incarnation is also excluded.
- A group derives it from query/operator identity and canonical group key.
- A window row retains the input result key.
- A set/distinct result derives it from canonical visible value plus query
  identity, while retaining only bounded ambiguity metadata.

Aggregate result identity MUST NOT contain the entire contributor set.

## Write targets and provenance

Writes name an explicit base relation or named writable view. A selection query
may select targets only when each output proves one unambiguous writable base
handle for that target.

Aggregates, distinct results, windows, recursive output, and ambiguous joins are
read-only unless a named inverse binding exists. Repeated join paths to the same
base handle are deduplicated. If they compute different edits, planning fails.

Full provenance is optional, bounded, and authority-controlled. Ordinary query
results carry compact opaque internal handles, not enumerable document IDs,
storage paths, or contributor lists. `sourceOf` and `keyOf` reveal only the
logical provenance authorized by the database view. An explicit `explain`
facility may expose more under a separate capability.
