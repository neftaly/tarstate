# Tarstate

Tarstate core is a generic relational query and derivation toolkit for
JSON-shaped application state. It is the package for schemas, sources, queries,
writes, and object-backed runtime helpers.

Use `@tarstate/react` as the idiomatic React entrypoint. Use `@tarstate/core`
directly when code needs to combine stored records, assignments, visibility, or
other structured data outside a renderer package.

The core API is stabilizing around a Relic-shaped split:

- `store` is the small app-facing facade: `createStore(seedRows)` returns an
  object-backed renderer-independent store, and
  `await createRuntimeStore({ runtime, relations })` returns the same facade over
  a pluggable `RelationRuntime`. Stores provide `query`, `queries`, `view`,
  non-throwing `commit`, and subscriptions. Store commit results use
  `accepted`/`partial`/`rejected` status plus a separate `reflected` flag for row
  effects. A `view(query)` is the stable derived-read API; materialization
  remains a diagnostic-backed core cache API outside the stable store contract.
- `query` describes relational row programs as data, including joins,
  explicit lookup, hash-declared equality lookup planning, btree-declared range
  lookup planning, query-only `uniqueIndex` metadata, dependency analysis
  through `dependencies`, propagated result identity through `rowKeyFields`,
  projections, `qualifyRow`, `aggregate({ groupBy, aggregates })`, aggregate
  helpers such as `countDistinct`/`avg`/`notAny`/`setConcat`/`maxBy`/`minBy`,
  and nested collection expansion.
- `source` describes read-only row sources with `rows`, optional equality
  `lookup`, optional range `rangeLookup`, optional opaque `version`, and
  diagnostics. A missing `version` hook or a hook that returns `undefined`
  means the current source identity is unknown.
- `adapter` is the write-capable storage boundary: `RelationRuntime` combines a
  `RelationSource`, optional patch target, optional snapshot, and optional host
  subscription. Patch targets and durable adapter commits use the same
  `accepted`/`partial`/`rejected` status vocabulary, with `accepted` indicating
  whether the full patch batch was accepted. Patch targets can declare writable
  relation ownership with `target.relationNames` or `target.ownsRelation`;
  composed runtimes use that target metadata before treating read-side
  `source.relationNames` as a compatibility fallback. Durable
  `RelationAdapter.commit(patches)` remains the compatibility shape for storage
  adapters and returns the same result envelope as generic relation-target apply
  semantics. The root convenience barrel also exports
  `createMemoryRelationRuntime` for small non-durable examples and tests.
- `write` defines the typed mutation vocabulary, including insert/insert-ignore,
  `insertOrReplace`, key-scoped `updateByKey`/`deleteByKey`, predicate
  `update`/`delete`, compatibility predicate aliases `updateWhere`/`deleteWhere`,
  `deleteExact`, `replaceAll`, `insertOrMerge(row, { merge })`, and explicit
  `insertOrUpdate(row, { update })` constant set-map descriptors. Computed
  update expressions are left to a future explicit API.
- `RelationDelta` is the stable adapter change-report type; diff helpers remain
  lower-level change primitives.
- `db` gives those programs a small object-backed runtime for examples, tests,
  and local state: diagnostics-aware `q`/`qMany`, row-only `qRows`/`qManyRows`,
  `stripMeta` for recovering normalized row data from a `Db`, and variadic
  all-or-nothing `tryTransact`/`transact` helpers. DB-facing helper names
  include `dbUpdateWhere` and `dbDeleteWhere`; explicit insert-or-update writes
  use `insertOrUpdate(row, { update })` from `write`.
- `memory-runtime` exposes a non-durable `RelationRuntime` over object-backed
  rows for tests, local state, and adapter prototyping.
- `constraints`, `materialization`, `watch`, and `runtime` are diagnostic-backed
  core surfaces. They provide baseline validation, object-backed
  constraint enforcement, query-shaped `req`/`unique`/`fk` enforcement for
  deterministic query shapes, committed relation deltas, exact
  materialized-query read-through, maintained declared materialized
  set/hash/btree/unique indexes, Relic-style `watchTarget`/`unwatchTarget`
  registration, `watchChangeMap`, `trackTransact`, and patch-target commit
  tracking. Watch delivery uses ephemeral materializations and delta-first row
  changes where available. Unsupported
  incremental operator shapes keep explicit diagnostics and recompute/refresh
  fallback; final row `sort(...)`, `limit(...)`, and `sortLimit(...)`
  materializations rebuild affected ordered/windowed snapshots from source rows.
  Incremental aggregate maintenance supports a narrow subset; `avg(expr)` is
  incremental only when matching visible `sum(expr)`/`count(expr)` fields are
  present over a non-null numeric base field or numeric literal. Named
  `call('name', ...)` functions are deterministic evaluate-time expressions;
  direct host functions use `hostCall(fn, ...)` or the `call(fn, ...)` overload.
  materialized/incremental paths keep diagnostics and fallback unless a function
  registry exists. Adapter-fed invalidations, async watch streams, and public IVM
  APIs are outside the current guarantees.

```tsx
import { evaluate } from '@tarstate/core/evaluate'
import {
  as, eq, from, leftJoin, maybe, pipe, project,
} from '@tarstate/core/query'
import {
  defineSchema, idField, refField, relation, stringField,
} from '@tarstate/core/schema'
import { composeSources, fromObjectSource } from '@tarstate/core/source'

// Define todo data and relationships.
const schema = defineSchema({
  todos: relation<{ id: string; text: string }>({
    key: 'id',
    fields: { id: idField('todo'), text: stringField() },
  }),
  assignments: relation<{ todoId: string; assignee: string }>({
    key: 'todoId',
    fields: { todoId: refField('todos.id'), assignee: stringField() },
  }),
})

// Pull in data from separate sources.
const todoSource = fromObjectSource({
  todos: [
    { id: 'todo-a', text: 'Buy oat milk' },
    { id: 'todo-b', text: 'Water basil' },
  ],
})
const teamSource = fromObjectSource({
  assignments: [{ todoId: 'todo-a', assignee: 'Mina' }],
})

// Combine the sources for the query.
const source = composeSources(todoSource, teamSource)

const todo = as(schema.todos, 'todo')
const assignment = as(schema.assignments, 'assignment')

// Build the query.
const todoRows = pipe(
  from(todo), // => [{ todo: { id: 'todo-a', ... } }, { todo: { id: 'todo-b', ... } }]
  // leftJoin appends matches from another query.
  leftJoin(from(assignment), eq(todo.id, assignment.todoId)), // => [{ todo: { id: 'todo-a', ... }, assignment: { assignee: 'Mina', ... } }, { todo: { id: 'todo-b', ... } }]
  // project formats the results nicely.
  project({
    id: todo.id,
    text: todo.text,
    assignedTo: maybe(assignment.assignee),
  }), // => [{ id: 'todo-a', assignedTo: 'Mina', ... }, { id: 'todo-b', assignedTo: undefined, ... }]
)

// Run the query against the current data.
const todos = (await evaluate(source, todoRows)).rows
```

## Package Boundary

`@tarstate/core` is the standalone generic query/data library. Keep package
code independent from application schemas, renderers, adapters, and wrappers.

Examples and onboarding should teach taxonomy subpath imports:

- `@tarstate/core/adapter`
- `@tarstate/core/constraints`
- `@tarstate/core/db`
- `@tarstate/core/diagnostics`
- `@tarstate/core/diff`
- `@tarstate/core/evaluate`
- `@tarstate/core/indexed-source`
- `@tarstate/core/materialization`
- `@tarstate/core/query`
- `@tarstate/core/runtime`
- `@tarstate/core/schema`
- `@tarstate/core/source`
- `@tarstate/core/store`
- `@tarstate/core/watch`
- `@tarstate/core/write`

The root barrel `@tarstate/core` remains a public convenience export for small
consumers and compatibility, but subpaths make API ownership clearer in docs and
examples.

Do not import `packages/core/src/*`, `@tarstate/core/src/*`, or any other
source-path package internals.

This is not a publishing lane yet. Keep the package private until all release
criteria are true:

1. The public API has stabilized around taxonomy subpath exports, with the root
   barrel retained as convenience.
2. Independent consumers need the package without app code.
3. Tarstate needs an external release cadence.
4. Package export smoke tests cover every public import path.
