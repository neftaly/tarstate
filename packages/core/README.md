# Tarstate

Tarstate core is a generic relational query and derivation toolkit for
JSON-shaped application state. Its root API is the stable starter surface for
diagnostics, schemas, canonical queries, db/query helpers, constraints, stores,
and typed writes.

Use `@tarstate/react` as the idiomatic React entrypoint. Use `@tarstate/core`
directly when code needs to combine stored records, assignments, visibility, or
other structured data outside a renderer package.

The core API is stabilizing around a Relic-shaped split:

- `store` is the small app-facing facade: root `createStore(seedRows)` returns
  an object-backed renderer-independent `Store`. Stores provide synchronous
  `query`/`queries` reads, `view(query)` `StoreView` snapshots, what-if reads,
  non-throwing `commit`, subscriptions, `refresh`, and idempotent `close`. The
  runtime-backed `createRuntimeStore` helper is an advanced
  `@tarstate/core/store` subpath API for adapters.
- `query` describes relational row programs as data, including joins,
  explicit lookup, hash-declared equality lookup planning, btree-declared range
  lookup planning, query-only unique metadata, dependency analysis,
  propagated result identity,
  projections, `qualify`, `aggregate({ groupBy, aggregates })`, aggregate
  helpers such as `countDistinct`/`avg`/`notAny`/`setConcat`/`maxBy`/`minBy`,
  and nested collection expansion.
- `source` describes read-only row sources with `rows`, optional equality
  `lookup`, optional range `rangeLookup`, optional opaque `version`, and
  diagnostics. A missing `version` hook or a hook that returns `undefined`
  means the current source identity is unknown.
- `adapter` is the write-capable storage boundary: `RelationRuntime` combines a
  `RelationSource`, optional patch target, optional snapshot, and optional host
  subscription. Patch targets use the same `accepted`/`partial`/`rejected`
  status vocabulary, with `accepted` indicating whether the full patch batch was
  accepted. Patch targets can declare writable
  relation ownership with `target.relationNames` or `target.ownsRelation`;
  composed runtimes use that target metadata before treating read-side
  `source.relationNames` as a compatibility fallback.
  Adapter-specific runtimes may further narrow writable operations. For example,
  the Automerge presence runtime is writable only when constructed with a
  `localPeerId`, only writes rows for that local peer, and rejects predicate
  `update`/`delete` patches through diagnostics because presence writes must be
  key- or row-based.
- `write` defines the typed mutation vocabulary, including insert/insert-ignore,
  `insertOrReplace`, key-scoped `updateByKey`/`deleteByKey`, predicate
  `update`/`deleteRows`, full-row `deleteExact`, `replaceAll`,
  `insertOrMerge(row, { merge })`, and explicit
  `insertOrUpdate(row, { update })` set-map descriptors.
- `RelationDelta` is the stable adapter change-report type; diff helpers remain
  lower-level change primitives.
- Root db/query helpers give those programs a small object-backed runtime for
  examples, tests, and local state: row-returning `q`/`qMany`, diagnostics-aware
  `qResult`/`qManyResult`, single-row `row`, `stripMeta` for recovering
  normalized row data from a `Db`, and variadic all-or-nothing
  `tryTransact`/`transact` helpers.
- `memory-runtime` exposes `createMemoryRelationRuntime`, a non-durable
  `RelationRuntime` over object-backed rows for tests, local state, and adapter
  prototyping.
- `constraints`, `materialization`, `watch`, and `runtime` are diagnostic-backed
  core surfaces. They provide object-backed constraint enforcement,
  materialized-query read-through, declared lookup metadata, Relic-style watch
  registration, change maps, tracked transactions, and runtime composition.
  Materialization is recompute/cache backed where required; declared indexes are
  planning and lookup metadata, not a general promise of fully maintained
  physical indexes.
- Automerge is a pluggable adapter/runtime package rather than the core storage
  model.

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
const todos = evaluate(source, todoRows).rows
```

## Package Boundary

`@tarstate/core` is the standalone generic query/data library. Keep package
code independent from application schemas, renderers, adapters, and wrappers.

Advanced examples and integration docs should teach explicit subpath imports:

- `@tarstate/core/adapter`
- `@tarstate/core/delta`
- `@tarstate/core/diff`
- `@tarstate/core/evaluate`
- `@tarstate/core/materialization`
- `@tarstate/core/memory-runtime`
- `@tarstate/core/relic`
- `@tarstate/core/runtime`
- `@tarstate/core/source`
- `@tarstate/core/store`
- `@tarstate/core/watch`

The root barrel `@tarstate/core` is the stable starter surface: diagnostics,
schema, the canonical query DSL, db/query helpers, constraints, materialization,
watches/change tracking, `createStore`, and write patch builders/types. Advanced
surfaces also keep explicit subpaths: adapter, runtime, source, delta, diff,
evaluate, memory-runtime, materialization, relic compatibility, and watch.

Do not import `packages/core/src/*`, `@tarstate/core/src/*`, or any other
source-path package internals.

This is not a publishing lane yet. Keep the package private until all release
criteria are true:

1. The public API has stabilized around taxonomy subpath exports, with the root
   barrel retained as convenience.
2. Independent consumers need the package without app code.
3. Tarstate needs an external release cadence.
4. Package export smoke tests cover every public import path.
