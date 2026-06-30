# Tarstate

Tarstate core is a generic relational query and derivation toolkit for
JSON-shaped application state. It is the package for schemas, sources, queries,
writes, and object-backed runtime helpers.

Use `@tarstate/react` as the idiomatic React entrypoint. Use `@tarstate/core`
directly when code needs to combine stored records, assignments, visibility, or
other structured data outside a renderer package.

The core API is moving toward a Relic-shaped split:

- `query` describes relational row programs as data, including joins,
  explicit lookup, hash-declared equality lookup planning, btree-declared range
  lookup planning, dependency analysis, projections, aggregates, and nested
  collection expansion.
- `source` describes read-only row sources with `rows`, optional equality
  `lookup`, optional range `rangeLookup`, optional opaque `version`, and
  diagnostics.
- `adapter` is the write-capable storage boundary: `RelationRuntime` combines a
  `RelationSource`, optional patch target, optional snapshot, and optional host
  subscription. Durable `RelationAdapter.commit(patches)` remains the
  compatibility shape for storage adapters, with
  `relationApplyResultFromAdapterCommit` bridging that durable commit result
  into generic relation-target apply semantics.
- `write` defines the typed mutation vocabulary, including `deleteExact` and
  `replaceAll` alongside insert/update/upsert/delete patches.
- `delta` and `diff` are the change primitives: relation-level change batches
  and structural row diffs.
- `db` gives those programs a small object-backed `q`/`qMany`/`transact`
  runtime for examples, tests, and local state.
- `constraints`, `materialization`, `watch`, and `runtime` expose the next API
  surfaces with baseline validation, explicit object-backed constraint
  enforcement, committed relation deltas, snapshot maintenance with a narrow
  single-relation incremental subset, supported `count()`, `sum(expr)`,
  `min(expr)`, and `max(expr)` aggregate maintenance, manual/recompute-backed
  watch refresh with callback fan-out from real refresh/tracked-change events,
  coarse dependency-filtered recomputation, and explicit fallback diagnostics;
  schema-attached or adapter-backed enforcement, general operator-maintained
  views/indexes, host-driven source observation, and async watch streams are
  outside the current public guarantees. Host-driven refresh/subscribe
  invalidations do not automatically maintain materializations; source-like
  integrations should recompute unless their ordering semantics are explicit.

See [developer-onboarding.md](../../docs/developer-onboarding.md) for current
API status, onboarding flows, and package direction.
See [roadmap.md](../../docs/roadmap.md) for maturity labels, open decision
areas, and release readiness signals.

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

## Materialization Snapshot Indexes

`snapshotIndex(db, target)` remains the compatibility helper for reading cached
snapshot rows as a set. `snapshotHashIndex(db, target, field)` builds a small
read-only lookup map from the same cached snapshot rows, grouped by an own field
on each cached row. These helpers do not expose Relic-style operator-maintained
indexes: missing materializations, metadata-only declarations, and rows that
cannot be keyed by the requested field return explicit materialization
diagnostics instead.

## Package Boundary

`@tarstate/core` is the standalone generic query/data library. Keep package
code independent from application schemas, renderers, adapters, and wrappers.

Examples and onboarding should teach taxonomy subpath imports:

- `@tarstate/core/adapter`
- `@tarstate/core/constraints`
- `@tarstate/core/db`
- `@tarstate/core/delta`
- `@tarstate/core/diff`
- `@tarstate/core/diagnostics`
- `@tarstate/core/evaluate`
- `@tarstate/core/identity`
- `@tarstate/core/materialization`
- `@tarstate/core/query`
- `@tarstate/core/runtime`
- `@tarstate/core/schema`
- `@tarstate/core/source`
- `@tarstate/core/watch`
- `@tarstate/core/write`
- `@tarstate/core/write-apply`

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
