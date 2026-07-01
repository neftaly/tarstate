# Tarstate React Examples

This package is a React-first example suite for the public TypeScript Relic API.
The shared model is plain TypeScript: schema, seed data, queries, constraints,
and store factories. The demos themselves are React components using the minimal
DB-first hooks.

## Hook API Shape

The hook API is deliberate, but it mostly follows from the core DB API:

- `TarstateProvider` plus `createDbStore(db?)` owns the current immutable `Db`
  value and publishes revisions.
- `useDb()` exposes the current `Db` when a component needs local derived write
  inputs or materialization metadata.
- `useQuery(query, options?)` mirrors core `q(db, query, options?)`.
- `useTransact()` mirrors core `tryTransact(db, writes...)` and publishes only
  committed DB values.
- `useMaterialized(query, options?)` reads materialized rows from the provider
  DB after `store.materialize(query)`.
- `useWatch(query, options?)` is the current React change hook for query-row
  changes across provider revisions.

This means React examples do not need `createSourceStore`, runtime stores,
adapter normalization, write-apply, or memory runtime concepts.

## Components

- `BasicTodoQueryExample` uses `useDb`, `useQuery`, and `useTransact` for an
  open-todo query plus a computed update.
- `DerivedDashboardExample` uses joined materialized todo cards, aggregate
  project summaries, and dependency maintenance metadata.
- `IndexedViewsExample` uses materialized query indexes with raw Set/Map shapes
  for set, hash, btree, and unique lookups.
- `ConstraintsWatchExample` uses query-bound constraints, rejected transaction
  diagnostics, and `useWatch` added/deleted aliases.
- `AutomergeCollaborationExample` shows an `automergeDb` snapshot feeding the
  same `TarstateProvider`/`useQuery` path.
- `ReactExampleSuite` composes the examples with provider-scoped stores.

Intentionally not demoed: internal adapter normalization, relation runtime
composition internals, memory runtime internals, source error plumbing,
diagnostic helper implementation details, exhaustive operator coverage, and
Automerge presence.
