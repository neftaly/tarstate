# Query artifacts and execution

Status: normative.

Queries are immutable portable templates. Functional TypeScript builders are a
typed authoring layer over the same data; they are not a second query language.

## Query template

```ts
type ValueDeclaration =
  | ScalarDeclaration
  | { kind: 'array'; items: ValueDeclaration }
  | { kind: 'tuple'; items: readonly ValueDeclaration[] }
  | {
      kind: 'record'
      fields: Readonly<Record<string, ValueDeclaration>>
      optional?: readonly string[]
    }

type Query = Artifact<{
  schemaViews: readonly ArtifactRef[]
  parameters: Readonly<Record<string, ValueDeclaration>>
  root: QueryNode
  requiredCapabilities: readonly CapabilityRef[]
}>

type QueryRequest = {
  query: Query | ArtifactRef
  datasetId: DatasetId
  parameters: Readonly<Record<string, PortableValue>>
  completenessMode?: 'exact' | 'lower-bound'
}
```

The template declares parameter names and portable value shapes; a request
supplies their values. Missing, extra, or unparseable parameters are issues and
the query does not evaluate. Ad-hoc builders use the deterministic inline
artifact rule, so ordinary React code does not manually create IDs or hashes.

## Relational universe

Every request selects exactly one dataset. A relation input identifies its
exact schema artifact and stable relation ID; its local schema name is authoring
syntax only. `from(relation)` reads each selected attachment that exposes that
relation through a compatible selected lens. It never scans unattached sources
or another dataset implicitly.

A dataset may be heterogeneous. Joining across two existing datasets
requires an explicit combined dataset so membership, authority, aliases,
deduplication, and observation basis remain inspectable. The attachment manager
deduplicates identical attachment IDs; it never merges distinct authority views
or live/pinned attachments.

Built-in system relations participate through their own exact schema artifact.
Joining application and system facts is therefore ordinary relational algebra,
not an ambient side channel.

## Functional authoring and aliases

The public authoring form is `pipe(from(...), operator(...), ...)`. Each
operator consumes and returns an immutable query value. Fluent query methods and
implicit mutable builders are excluded.

Every base relation or subquery occurrence has an explicit query-local alias.
Field expressions resolve through that alias, so self-joins and equal field
names never use string guessing. Aliases affect expression scope and output
names only; they do not change relation identity or provenance.

The canonical operator families and value semantics are those listed in the
implementation entry contract and artifacts/value specification. There is one
public spelling per semantic operation. Unsupported operators or value domains
produce capability issues; adapters do not approximate them.

## Preparation and execution

Preparation resolves exact schemas, lenses, functions, codecs, collations, and
capability implications against one database/authority view. It produces a
registry fingerprint and a typed prepared handle local to that host. The handle
is a cache/optimization object, not a portable artifact and grants no authority.

The pure evaluator consumes the query template, parsed parameters, selected
membership snapshot, projected logical rows, and registry fingerprint. Its
output is `QueryResult`; observers add lifecycle, caching, `lastExact`, diffs,
and subscriptions without changing query meaning.

Data null or missing may make an individual predicate logically unknown while
the evaluated relation remains exact. A required named function, codec,
collation, or extension that cannot execute is different: it makes the affected
query result completeness `unknown`, with empty current rows and a capability
issue. The evaluator never labels an unevaluable result exact.

Queries never discover resources, commit writes, read ambient time/randomness,
or silently change dataset membership. Durable time and random facts are
ordinary stored/parameter values. Presence and connection state are explicit
system-relation inputs and remain forbidden in hard source constraints.

## Type and authority boundary

Literal builders infer parameters, aliases, and result rows. Dynamically parsed
queries are runtime-typed until paired with hash-matched generated declarations.
No TypeScript type can widen runtime authority or source capabilities.

Result writeability follows proven base-row handles and named inverse bindings.
The visible row shape alone never authorizes an update. Query results expose
only authority-safe logical provenance; physical locators remain internal to the
prepared database view.
