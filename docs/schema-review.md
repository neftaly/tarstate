# Code review: schema / runtime-protocol API

Review date: 2026-07-05. Scope: schema format design and the recent runtime-protocol
commits (`83a8792` Pressure test schema design, `209bfbe` Harden JSON schema boundary,
`095c392` Cover Automerge historical schema queries, `ac48028` Pin runtime snapshots and
alias key fields, `c1534ac` Cover real presence runtime composition).

## Orientation note

The initial file list this review started from (`packages/system/...`,
`docs/schema-protocol.md`, `research/*.md`, `scripts/generate-seed-fixture.mjs`,
`fixtures/seed.ts`) does not match this repo. The real layout is
`packages/{core,automerge,react}`; the schema builder is `packages/core/src/schema.ts`;
the schema protocol doc is `docs/schema-spec.md` (plus `docs/schema-research.md`,
`docs/schema-evolution.md`, `docs/schema-core-pressure.md`). There is no `research/`
directory and no seed-fixture script. This review covers the real equivalents. The
recent commits actually touched `packages/core/src/schema.ts`,
`packages/core/src/impl.ts`, `packages/automerge/src/{index,presence}.ts`, and the two
`*-api-contract.test.ts` files.

---

## Schema format (priority section)

### 1. [Critical] The documented `SchemaManifestV1` wire format has zero implementation

`docs/schema-spec.md` (1199 lines, "v1 draft-final") and `README.md:15` present schemas
as "JSON-compatible manifests" (`kind:"tarstate.schema"`, `formatVersion`, `schemaId`,
`type`-tagged fields) with a concrete implementation surface (§16): `toSchemaManifest`,
`validateSchemaManifest`, `hydrateSchemaManifest`, `canonicalSchemaManifest`,
`stringifyCanonicalSchemaManifest`, plus `RuntimeCodec`/`CodecDeclarationV1`/
`SchemaManifestDiagnosticV1`. **None of these exist in code** — grep for
`tarstate.schema`, `formatVersion`, `schemaId`, `SchemaManifest`, `hydrate`,
`canonicalSchema` returns nothing under `packages/`. `packages/core/src/schema.ts`
implements only the in-memory *builder* (`stringField()`, `idField()`, `relation()`,
`defineSchema()`, `isJsonValue`).

- **Why it matters:** a consumer following the README/spec cannot parse, validate,
  canonicalize, hash, or hydrate a `tarstate.schema` document — the entire advertised
  format is absent. The README and spec agree with *each other*; the code implements
  *neither*. Everything below about the manifest is therefore a spec-vs-builder
  consistency review, not a code-vs-code one.

### 2. [High] The builder's field encoding diverges from the manifest, and the promised mapping layer doesn't exist

Cross-checking `schema.ts` against `docs/schema-spec.md` §5/§16:

- Type discriminant: builder `FieldSpec.valueKind` (`schema.ts:18`) vs. manifest `type`.
- Id domain: builder stores `idDomain` (`schema.ts:21,90`) vs. manifest `domain`.
- Ref target: builder `refField(target: string)` stores a bare string `ref`
  (`schema.ts:22,91`); the manifest requires a structured `target:{relation,field}`
  (spec §5.5, lines 281-290).

Spec §16 (lines 1066-1090) explicitly anticipates a `toSchemaManifest` translation and
even calls for a future `refField({relation,field})`, but that layer is unbuilt, so
today the only ref encoding is the lossy `"relation.field"` string — which **cannot
represent relation/field names containing a dot** and is never validated at
construction time.

- **Why it matters:** these aren't isolated bugs — the format the docs describe cannot
  round-trip to/from the only schema objects that actually exist, and the string-ref
  encoding is a silent footgun.

### 3. [High] `refField` target convention is used two contradictory ways in-tree; core's own relations aren't spec-exportable

The documented convention (spec §16; `apps/real-estate/src/domain.ts:113`
`refField('neighborhoods.id')`) is `refField("relation.field")` — exactly one dot. But
core's own `runtimeSystemRelations.objectLocations.parentObjectId` uses
`refField('tarstate.runtime.object')` (`impl.ts:1023`) — a three-segment *id-domain*
string that (a) names no relation, (b) has two dots, so it is "ambiguous" and must fail
export with `invalid_ref` under the spec's own parse rule, and (c) conceptually points
at `objectId`, a **non-key** field, which spec §5.5 forbids (refs must target the
single-field relation key).

- **Why it matters:** `refField` has two incompatible meanings in the same codebase
  ("relation.field pointer" vs. "id-domain tag"). Any manifest-export implementation
  written to the documented rule will choke on core's own runtime relations, and the
  intended referential meaning of `parentObjectId` is unclear.

### 4. [Medium] `CustomFieldSpec` conflates portable declaration with executable runtime, and its codec-name field is `kind` while the runtime contract uses `codec`

`schema.ts:5-14` bundles executable functions (`validate`, `stableKey`, `compare`,
`toScalar`, `fromScalar`) directly on the field spec and names the codec `kind`. The
spec deliberately splits these into `CodecDeclarationV1` (portable: `description`/
`scalar`/`keyable`) and `RuntimeCodec` (executable), and names the identity field
`codec` (§6, §9).

- **Why it matters:** the builder's custom field can't serialize (functions aren't
  JSON), and the identity key name (`kind` vs. `codec`) is a seam a consumer will trip
  over when the manifest/registry layer lands. The builder also has no `scalar`/
  `keyable` declaration fields, so an exporter can't synthesize a faithful codec
  declaration without executing user code (which the spec forbids).

### 5. [Medium — versioning/CRDT] The manifest's forward-compat model is a hard-reject, a hazard for persisted / mixed-version documents

Spec §3 (line 114) and §11 (lines 745-777): "Unknown top-level properties are invalid
in v1 except inside `metadata`" and "any additive semantic layer outside `metadata`
requires a new `formatVersion`." That is a closed-world validator — a v1 reader **must
reject** any manifest a newer writer extended, rather than ignoring unknown fields.
Cross-version reading is deferred to "lenses" (§12) that don't exist.

- **Why it matters:** for the project's stated Automerge/mixed-version-peer target, an
  older peer cannot read a newer schema manifest at all (hard fail, not lenient). This
  is baked into the spec the code will eventually implement. It's arguably deliberate
  strictness, but it should be a conscious decision, not a surprise. (Note: this is
  about the *manifest*; the historical Automerge *data*-document query path is a
  separate, working mechanism — see verdicts below.)

### 6. [Clean] The optional / nullable / undefined ambiguity is well-resolved

Spec §5/§10 unambiguously distinguish omitted (`optional`) from explicit `null`
(`nullable`), rule that a present `undefined` is invalid even for optional fields, and
base presence on own (not inherited) properties. The builder mirrors this
(`optional`/`nullable` flags, `schema.ts:98-99`) and `validateRelationRow` enforces it
— the contract tests confirm custom-key-must-be-keyable and field-type rejection
(`public-api-contract.test.ts:557-641`). This part of the format is internally
consistent; the only gap is that enforcement lives in the builder row-validator, and
the manifest-level validation (unknown-property/surrogate/structured-ref checks) is
unimplemented (finding 1).

Minor within this section: the builder permits a one-element key array (`['id']`),
which the manifest declares invalid and expects to be normalized on export — a
normalization step that doesn't exist yet.

---

## JSON boundary hardening (the code actually changed in "Harden JSON schema boundary")

### 7. [High] `isJsonValue` guards cycles but not exponential blow-up on shared acyclic subtrees

`schema.ts:112-163` add each node to `seen` on entry and **delete it on exit**
(`finally`, lines 131,161). This correctly rejects true cycles, but a DAG that
references the same array/object twice at each of D levels is re-validated 2^D times.
Since the spec frames this as an untrusted boundary (§13), an adversarial *acyclic*
input — e.g. `a0=[leaf,leaf]; a1=[a0,a0]; … aD=[a(D-1),a(D-1)]` — costs O(2^D): ~40
levels (≈80 objects) is ~10^12 operations.

- **Why it matters:** a tiny payload can hang the "hardened" validator — an
  algorithmic-complexity DoS at exactly the boundary this commit set out to harden. The
  fix is to memoize nodes that validated OK, not only the current path.

### 8. [Low] `isJsonValue` is stricter than "JSON-serializable"

`isPlainJsonObject`/`isJsonArray` reject an object/array on the first symbol key or
non-enumerable own property (`schema.ts:118-125,150-155`). But
`JSON.stringify({a:1,[Symbol()]:2})` succeeds (drops the symbol). So values that *are*
serializable return `false`.

- **Why it matters:** if callers use `isJsonValue` as a gate before `JSON.stringify`,
  they'll reject legitimately-serializable inputs (e.g. an object a library tagged with
  a symbol). Defensible as conservative, but it's stricter than the spec's own §2
  "JSON-compatible" value-type definition and worth documenting.

### 9. [Clean] The rest of the hardening is correct and well-tested

The commit fixes real prior gaps: `NaN`/`±Infinity` now rejected via
`Number.isFinite` (previously accepted), cycles no longer stack-overflow, sparse
arrays and arrays-with-extra-props rejected via descriptor checks, non-plain
prototypes rejected, and accessors/getters are inspected without invocation
(`getOwnPropertyDescriptor`). `public-api-contract.test.ts:201-262` covers hostile
proxies, accessors, cycles, sparse arrays, `Date`/`Map`/`Set`/`Uint8Array`. No
false-positives found (BigInt, symbol values, functions, `undefined` all correctly
rejected). Good work aside from finding 7.

---

## General API surface

### 10. [Medium] `package.json` exports raw `.ts` with a `./*` wildcard that publishes all internals

`packages/core/package.json:8-11` (same in automerge) maps `"."` → `./src/index.ts` and
`"./*"` → `./src/*.ts`, with no `types`/`main`/`module` and `"private":true`,
`"version":"0.0.0"`. This is intentional ("export package sources for git consumers"),
but `./*` makes every internal module a public entry point —
`@tarstate/core/impl`, `/relic`, `/memory-runtime`, etc. Indeed
`public-api-contract.test.ts` imports from `@tarstate/core/adapter`, `/evaluate`,
`/delta` directly.

- **Why it matters:** the public/private boundary is only `index.ts` by convention;
  `./*` lets consumers depend on `impl.ts` internals, so there's no encapsulation to
  refactor behind. A curated subpath-exports map would fix this.

### 11. [Medium] The `as()` reserved-key change silently shadows common domain field names (breaking)

`impl.ts:172` now makes `key` a reserved alias field
(`AliasedReservedField = keyof RelationRef | keyof Query | …`) and adds `'key'` to
`ALIASED_FIELD_RESERVED_KEYS` (`impl.ts:10007`), removing the old
`fieldName === 'key'` special-case (`impl.ts:310`). So for a relation with a field
literally named `key`, `alias.key` no longer returns the field expression — it returns
the relation's key *spec* (e.g. `'id'`); the field is only reachable via `alias.$.key`.
The same shadowing already applies to `name`, `data`, `fields`, `relations`, etc.

- **Why it matters:** `key` and `name` are extremely common field names. This is a
  breaking behavior change (previously `alias.key` was the field expr) and a footgun.
  It's tested and mitigated by the `$` escape hatch and by the type system excluding
  these from the flat accessor (`query-api-contract.test.ts:88-110`), so it's a
  deliberate, coherent design — but callers upgrading with a `key`/`name` field will
  get different runtime values. Worth an explicit changelog/migration note.

### 12. [Medium] Automerge `snapshot()` is only partially pinned

The fix (`automerge/src/index.ts:514-536`) correctly captures
`const doc = driver.getDoc()` and rebuilds the data source, object-location cache, and
`version` from that immutable doc — so document-derived rows now match the snapshot
heads (a real consistency fix; `presence.ts:165-177` does the same for rows+version).
But `repoSystem?.state` is passed as a live **thunk** (`repoSystemState?.()`,
`index.ts:527,841-844`) and is invoked lazily, so the snapshot's `sync`/`peers`/
`storage` rows read live repo transport state at read time.

- **Why it matters:** `AdapterSnapshot.source` is therefore not a fully immutable
  point-in-time value; reading the same snapshot twice can yield different peer/sync/
  storage rows. If a consumer caches a snapshot or compares snapshots by content
  (rather than by `version` heads), it can observe drift. Whether that's acceptable
  depends on intent, but it's a subtlety the "Pin runtime snapshots" title obscures.

### 13. [Low] `RuntimeSystemState.diagnostics` accepts two row shapes for one relation

`impl.ts:890` types it `readonly (RuntimeDiagnosticRow | TarstateDiagnostic)[]`, but the
`diagnostics` relation is keyed/typed as `RuntimeDiagnosticRow`. Callers must route
through `runtimeSystemSource` (which normalizes) and can't rely on a single row shape.
Mild inconsistency.

### 14. [Low] Runtime `detail?: unknown` + `opaqueField(...)` lets non-JSON host objects into "queryable" rows

Every runtime row type has `detail?: unknown` (`impl.ts:771,782,…`) backed by
`opaqueField(...)`, and presence's `rowInvalidDiagnostic(row)` sets `detail: row` from
arbitrary input (`presence.ts:638,649`). Opaque fields bypass JSON validation, so a
`Map`/`Date`/function can flow into `tarstate.runtime.diagnostics` rows —
contradicting spec §8 ("diagnostic `detail` MUST be JSON-compatible"). Boundary-hygiene
note.

### 15. [Low] Unsafe `jsonField() as FieldSpec<readonly string[]>` casts assert element types the runtime doesn't enforce

`impl.ts:967-969,1006-1007,1022,1027,1062` cast JSON fields to typed arrays
(`localHeads`, `deps`, `heads`, `pathSegments`, `relationNames`). A json field accepts
any JSON value at runtime, but TS consumers are told it's `readonly string[]`, so
malformed persisted data (a number in `localHeads`) would be trusted as a string. Minor
type-safety gap at the row boundary.

---

## Verdicts on backward-compat, error-handling, and type-safety at the boundary

- **Backward-compat / historical documents:** two separate mechanisms. The Automerge
  *data*-document historical path (the "historical schema queries" / snapshot work) is
  fine — the snapshot-pinning change actually *improves* point-in-time consistency
  (finding 12 is a partial-pin nuance, not a regression). The *manifest format*'s
  forward-compat is the genuine hazard (finding 5): strict unknown-property rejection
  means older readers can't read newer manifests. Since no manifest code exists yet
  (finding 1), this is a design-level concern, not a live bug.
- **Error-handling at the boundary:** the `isJsonValue` boundary is thorough and
  well-tested (finding 9), with the one real gap being the exponential-blowup DoS
  (finding 7). The spec's structured-diagnostic validation layer
  (`validateSchemaManifest`, `SchemaManifestDiagnosticV1`, the fixture matrix in §8) is
  entirely unimplemented, so there is no manifest error-handling to review yet.
- **Type-safety at the boundary:** mostly sound; the notable gaps are the
  `jsonField() as …` casts (15), `detail: unknown` opacity (14), and the un-validated
  string `refField` target (2).

---

## Nitpicks (grouped)

- `README.md:3` "hooks for React (**and other languages**)" is aspirational — only
  TS/React packages exist. `README.md:11` has trailing whitespace. The perf claims
  ("faster than hand-rolled state management at scale", "optimized for video games")
  are unbacked marketing, not code concerns.
- README's manifest *example* (structured `target:{relation,field}`, `size` as string
  because "enum fields are not part of v1") is faithful to the spec — the drift is
  purely that no code implements it.
- `presence.ts:588` `valuesEqual` via `JSON.stringify` comparison is order-sensitive and
  will throw on cyclic/BigInt values; fine for presence payloads but fragile if
  arbitrary values flow in.

---

## Bottom line

The single most important finding is **#1** — the schema *format* the docs and README
advertise is entirely unimplemented; `schema.ts` is only the in-memory builder that
format is supposed to serialize to/from. Within the format itself, the concrete
internal-consistency problems are the encoding divergences (**#2**) and the
contradictory `refField` conventions (**#3**). In the code that actually changed, the
real bug is the `isJsonValue` exponential-blowup DoS (**#7**); the rest of that
hardening is solid.
