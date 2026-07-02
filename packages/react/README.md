# @tarstate/react

`@tarstate/react` is the React integration for the TypeScript Relic-style
Tarstate core. The React layer owns subscription and render safety; data reads
and writes go through the canonical `Store` API from `@tarstate/core/store`.

Primary API:

- `TarstateProvider` accepts either a core `store` or provider-owned `db` seed
  data. When no store is provided, React creates a core `Store` with
  `createStore(db)`.
- `useTarstateStore()` returns the active core `Store`.
- `useTarstateSnapshot()` returns the current core `StoreSnapshot`.
- `useDb()` reads the current core `Db`.
- `useView(query)` is the canonical read hook. It subscribes to
  `store.view(query)` and returns `{ status, rows, diagnostics, revision,
  queryKey, refresh, view, snapshot, error }`. It also reads rows from core
  materializations when the active DB has a matching materialized query.
- `useRow(query, predicate)` returns the first view row matching a type-safe
  predicate. Use `useRow(query, key, { keyBy })` for keyed lookup, where
  `keyBy(row)` produces the same key type as `key`.
- `useQuery(query)` remains available for selected data via
  `useQuery(query, { select })`; new read-only components should prefer
  `useView`.
- `useCommit()` returns the active core `Store.commit` function.
- `Store.close()` provides idempotent subscription cleanup.
- `useWatch(query | relation)` delivers core watch events as the provider DB changes,
  including `rows`, `previousRows`, `added`, `removed`, `unchanged`,
  `rowChanges`, and `diagnostics`.

Core materialization and React watch helpers retain their core shapes. React
keeps these thin: materialized rows, commit diagnostics, and DB snapshots pass
through as core data rather than React-specific models. Materialize seed data
with core helpers before passing it to `createStore` or `TarstateProvider`, then
read the query with `useView`.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested directly against `@tarstate/core` without rendering React.
