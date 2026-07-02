# @tarstate/react

`@tarstate/react` is the React integration for the TypeScript Relic-style
Tarstate core. The React layer owns subscription and render safety; data reads
and writes go through the canonical `Store` API from `@tarstate/core/store`.

Primary API:

- `TarstateProvider` accepts either a core `store` or provider-owned `db` seed
  data. When no store is provided, React creates a core `Store` with
  `createStore(db)`.
- `useTarstateStore()` returns the active core `Store`.
- `useTarstateSnapshot()` subscribes with `store.subscribe` and returns the
  current core `StoreSnapshot` from `store.getSnapshot`.
- `useDb()` reads the current core `Db`.
- `useView(query, { deps })` is the canonical read hook. It creates
  `store.view(query)`, subscribes with `view.subscribe`, reads
  `view.getSnapshot`, and returns `{ status, rows, diagnostics, revision,
  queryKey, refresh, view, snapshot }`. The hook is synchronous: `status` is
  `ready`, and diagnostics pass through from the store view snapshot.
- `useRow(query, predicate)` returns the first view row matching a type-safe
  predicate. Use `useRow(query, key, { keyBy })` for keyed lookup, where
  `keyBy(row)` produces the same key type as `key`.
- `useQuery(query)` remains available for selected data via
  `useQuery(query, { select, deps })`; it is a thin selection wrapper over
  `useView`. New read-only components should prefer `useView`.
- `useCommit()` returns the active core `Store.commit` function.
- `Store.close()` provides idempotent subscription cleanup.

Core materialization helpers retain their core shapes. React keeps these thin:
materialized rows, commit diagnostics, and DB snapshots pass through as core
data rather than React-specific models. Materialize seed data with core helpers
before passing it to `createStore` or `TarstateProvider`, then read the query
with `useView`.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested directly against `@tarstate/core` without rendering React.
