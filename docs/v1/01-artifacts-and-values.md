# Artifacts and values

Status: normative.

## Artifact envelope

Every portable artifact family MUST use this semantic envelope:

```ts
type Artifact<Body> = {
  kind: ArtifactKind
  formatVersion: 1
  id: string
  contentHash: `sha256:${string}`
  dependencies: readonly ArtifactRef[]
  body: Body
}

type ArtifactRef = {
  id: string
  contentHash: `sha256:${string}`
  locations?: readonly string[]
}
```

`id` is an immutable semantic name. Reusing an ID with different content is an
error. `locations` are mutable resolution hints and are not semantic identity.
A location may use `https:`, `automerge:`, `package:`, or a host-defined scheme.

Long-lived published artifacts use an explicit semantic ID. Ad-hoc query and
transaction builders may seal an inline artifact without asking the caller for
an ID: they first hash normalized `{kind,formatVersion,dependencies,body}` and
derive `id = urn:tarstate:inline:sha256:<body-hash>`, then compute the ordinary
envelope `contentHash` including that derived ID. Inline and explicitly named
artifacts otherwise parse and execute identically. Callers never hand-author a
claimed hash. The `urn:tarstate:inline:` namespace is reserved; explicitly
named artifacts cannot use it.

`contentHash` is the SHA-256 hash of the UTF-8 encoding of the JSON
Canonicalization Scheme defined by RFC 8785 for
`{kind,formatVersion,id,dependencies,body}`. Before canonicalization, every
dependency ref is reduced to exactly `{id, contentHash}`. `contentHash` itself
and all root or dependency `locations` are excluded. Reduced dependencies are
deduplicated and sorted by ID then content hash before canonicalization because
dependency order is not semantic. Two hashes for one dependency ID are an
ambiguity error, not two dependencies. Artifact numbers MUST be
representable by RFC 8785/I-JSON; values needing greater precision use tagged
decimal or integer domains rather than artifact JSON numbers.

A SHA-256 string is exactly `sha256:` followed by 64 lowercase hexadecimal
digits. Parsers reject uppercase, shortened, padded, or alternate encodings.

Dependencies MUST use exact IDs and hashes. Resolution MUST NOT silently choose
between artifacts with the same ID, between multiple lens paths, or between
different executable capability implementations.

Resolution produces a fingerprint containing:

- every resolved artifact ID and hash;
- every codec, function, collation, and edit-capability ID/version;
- the host trust-policy identity;
- semantic resource-budget settings.

The fingerprint participates in query caches, compiled plans, and authority
views.

## Trust and executable capabilities

Artifacts are data. A schema, mapping, query, or URL MUST NOT authorize code
execution.

Executable codecs, functions, bindings, and source drivers are registered by a
trusted host using exact symbolic IDs and versions. Loading executable code
requires a host allow-list and an integrity check. A missing or mismatched
registration produces a structured capability issue.

Portable functions used by constraints or automatically retried transactions
MUST be pure, deterministic, and versioned. Time, randomness, locale, network,
and ambient mutable state are not portable inputs. They must be captured as
literal parameters or represented as source facts.

## Capability references and negotiation

Capability requirements use exact semantic contract references:

```ts
type CapabilityRef = {
  id: string
  version: string
  contractHash: `sha256:${string}`
}
```

Versions are opaque exact identifiers, not semantic-version ranges. The
contract hash identifies an immutable portable capability declaration; host
implementation integrity is checked separately. An implementation registers
against exactly one or more contract refs.

A capability declaration may explicitly imply weaker capability refs. The
implication graph is immutable, cycle-checked, and part of the registry
fingerprint. No implication is inferred from names, version ordering, semver,
or similar-looking operations. Lists named `requiredCapabilities` (and
`requiredCodecs`) are conjunctive. Schema `editCapabilities` and
`entityEditCapabilities` are catalogs of independently available edit
contracts, not a request to execute all edits together. V1 uses shared minimum
contracts plus explicit implication for substitutability; it has no implicit
“try any similarly named capability” rule.

Unknown or unavailable requirements produce structured capability issues. They
do not authorize dynamic code loading or silently select a substitute. A
relation/field edit requirement makes that edit unavailable when missing; a
codec required to parse a field makes affected rows unparseable; a required
hard-constraint capability makes the source read-only under the constraint
rules.

Old contract refs are never reinterpreted. New versions and stronger contracts
coexist, and a host may support several simultaneously. Registry changes update
observer/writeability state and invalidate caches through the fingerprint.

## Parsing and budgets

Public boundaries parse; they do not return booleans called validation.
Expected failures are values with structured issues. `parse*` MAY throw a
typed parse error; `safeParse*` returns a result. No public `validate*` or
`isValid*` synonym is provided.

All parsers MUST enforce configurable bounds on bytes, nesting depth, array and
object members, constants, dependency count, diagnostic count, and expression
nodes. They MUST reject cycles, accessors, proxies that throw during inspection,
prototype-pollution keys, sparse arrays, non-enumerable data properties, and
unsupported tagged values before trusted bindings inspect them.

Every JSON-text boundary MUST detect and reject duplicate object member names at
every depth, including inside `metadata`, `details`, and tagged values, before a
normal JSON object is materialized. `JSON.parse` last-member-wins behavior is
not an acceptable artifact parser and cannot be repaired after parsing.

Unknown storage fields are not artifact fields. They are preserved by
field-level binding edits and are never erased by serializing a parsed row back
wholesale.

## Portable and logical values

Artifact structure is canonical JSON. Query parameters and row values may also
contain these tagged values:

```ts
type TaggedValue =
  | { kind: 'tarstate.value'; type: 'decimal'; value: string }
  | { kind: 'tarstate.value'; type: 'instant'; value: string }
  | { kind: 'tarstate.value'; type: 'bytes'; value: string }
  | { kind: 'tarstate.value'; type: string; value: JsonValue }
```

- Decimal strings match
  `-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?`, except `-0` is forbidden. They
  have no plus sign, exponent, leading integer zero, or fractional trailing
  zero. Decimal arithmetic is exact; rounding requires an explicit operation
  and mode.
- Instant strings are UTC Gregorian RFC 3339 timestamps with uppercase `T`/`Z`
  and exactly nine fractional digits: `YYYY-MM-DDTHH:mm:ss.fffffffffZ`.
  Years are `0000` through `9999`; offsets, `24:00`, and leap seconds are
  forbidden. Millisecond/microsecond declarations require the unused trailing
  six/three digits to be zero.
- Bytes use unpadded base64url with alphabet `[A-Za-z0-9_-]`; length modulo
  four cannot be one, and unused trailing bits MUST be zero.
- Custom tagged values require a registered codec.

The built-in tagged type names `decimal`, `instant`, and `bytes`, and every
name beginning `tarstate.`, are reserved. Custom codecs MUST use another
globally scoped name.

Core logical scalar domains are string, boolean, finite number, integer,
decimal, instant, bytes, JSON, relation reference, and custom codec value.
URLs are application domains/codecs rather than a privileged core scalar.

`number` is an IEEE-754 binary64 value and `integer` is a safe JavaScript
integer. Larger exact integers use decimal or a named custom codec. Strings are
compared as exact Unicode scalar sequences with no implicit normalization; lone
surrogates are rejected at portable boundaries.

`undefined`, functions, symbols, `NaN`, infinities, cyclic values, `Map`, `Set`,
and host class instances are not portable values. Executable bindings may parse
such host values into portable logical values.

## Equality, hashing, and ordering

Every scalar domain MUST define canonical equality and hashing. Ordering is
optional; an operator requiring ordering fails with a capability issue when the
domain does not provide it.

- Numbers are finite; `-0` equals `0`.
- Decimal equality is numeric after canonicalization.
- Bytes compare by content.
- Instants compare by their canonical instant value.
- Strings use deterministic binary Unicode scalar ordering by default. Locale
  collation or Unicode normalization is a named capability.
- Records compare by sorted field name and value; arrays compare positionally.
- Custom codecs declare `equals`, `hash`, and optionally `compare`, all tied to
  the codec version.

Grouping, `distinct`, keys, and set operators use the same canonical equality
and hash semantics. Adapters MUST NOT substitute JavaScript reference equality.

## Null, missing, and predicates

`null` is a value. Missing means an optional field is absent. `undefined` is
never the representation of either at a portable boundary.

Comparisons involving null or missing produce logical unknown, except explicit
`isNull`, `isMissing`, and presence operators. `where` retains only true.
Boolean operators use strong Kleene semantics: false dominates `and`, true
dominates `or`, and `not unknown` is unknown.

Logical unknown, missing, and capability-unavailable are disjoint internal
evaluation states outside `JsonValue`. In particular, none is represented by
the ordinary data string `"unknown"`. Nested expressions preserve these states
until an operator resolves or propagates them; portable output never encodes an
internal state as a colliding application value.

Outer joins introduce missing fields, not null fields. Projection omits missing
properties and preserves explicit nulls. Grouping treats all nulls as one group
and all missing values as a distinct group.

## Bags, aggregates, ordering, and recursion

Query relations use bags. Base row identity and hidden row handles distinguish
equal visible values from different sources.

- `unionAll` adds multiplicities.
- `union` removes duplicates.
- `intersect` and `except` are distinct set operations in v1.
- `distinct` removes duplicates using canonical visible-value equality while
  retaining bounded internal target ambiguity information.

Empty aggregate results are: count `0`; collect `[]`; any `false`; every `true`;
sum, average, minimum, maximum, first, and last `null`. Field-count and numeric
aggregates ignore null and missing inputs. For boolean any/every, null, missing,
and logical unknown contribute unknown: any is true if any input is true,
otherwise unknown when an unknown input exists, otherwise false; every is false
if any input is false, otherwise unknown when an unknown input exists, otherwise
true.

Ordering is deterministic. Unless overridden, null and missing sort after
ordinary values, with missing after null, independent of ascending/descending
direction. Hidden row handles break otherwise equal ties. Portable keyset
cursors include the complete order tuple, tie-break result key, observation
basis, membership revision, and whether the cursor is live or pinned.

Recursive queries use a keyed/set least fixpoint even though ordinary relations
are bags. The recursive body MUST be monotone, declare a deduplication key, and
run under iteration and row budgets. Windows initially require only the
operations proven by golden workloads; unsupported frames are capability
issues, not silently approximated.
