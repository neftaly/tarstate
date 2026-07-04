# @tarstate/react

`@tarstate/react` is the React integration for the TypeScript Relic-style
Tarstate core. The React layer owns subscription and render safety; data reads
and writes go through the canonical `Store` API from `@tarstate/core/store`.

Primary API:

- `TarstateProvider` accepts either a core `store` or provider-owned
  `initialDb` seed data. When no store is provided, React creates a core
  `Store` with `createStore(initialDb)`.
- `useTarstateStore()` returns the active core `Store`.
- `useTarstateSnapshot()` subscribes with `store.subscribe` and returns the
  current core `StoreSnapshot` from `store.getSnapshot`.
- `useDb()` reads the current core `Db`.
- `useView(query, { resetKey })` is the canonical read hook. It creates a core
  `StoreView`, subscribes to it, and returns synchronous rows, diagnostics,
  revision, query key, and a refresh callback.
- `useRow(query, predicate)` returns the first view row matching a type-safe
  predicate.
- `useRow(relation, key)` returns the matching relation row by key.
- `useQuery(query)` remains available for selected data via
  `useQuery(query, { select, equality, resetKey })`; it uses the same
  store-view subscription path as `useView`. New read-only components should
  prefer `useView`.
- `shallow(left, right)` is an intentionally shallow selector equality helper
  for `Object.is`, arrays, and plain records.
- `useTarstateSubscription(query, { onChange })` subscribes imperatively to a
  query without scheduling React renders. The selected form,
  `useTarstateSubscription(query, { select, equality, onChange })`, is for
  animation, canvas, and large-data paths that need to write into an external
  target directly. Changing `select`, `equality`, `resetKey`, or the query
  replaces the subscription; `onChange` is read live.
- `useCommit()` returns the active core `Store.commit` function.
- `Store.close()` provides idempotent subscription cleanup.

Core materialization helpers retain their core shapes. React keeps these thin:
materialized rows, commit diagnostics, and DB snapshots pass through as core
data rather than React-specific models. Materialize seed data with core helpers
before passing it to `createStore` or `TarstateProvider` as `initialDb`, then
read the query with `useView`.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested directly against `@tarstate/core` without rendering React.
