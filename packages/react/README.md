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
- `useQuery(query)` evaluates through `store.query(query, options)`.
- `useCommit()` returns the active core `Store.commit` function.
- `Store.close()` provides idempotent subscription cleanup.
- `useMaterialized(query)` reads materialized query rows from
  `useTarstateSnapshot().db`.
- `useWatch(query)` delivers core watch events as the provider DB changes,
  including `rows`, `previousRows`, `added`, `removed`, `unchanged`,
  `rowChanges`, and `diagnostics`.

Materialization and watch helpers retain their core shapes. React keeps these
thin: materialization rows, commit diagnostics, and DB snapshots pass through as
core data rather than React-specific models. React no longer owns independent
materialization tracking; materialize seed data with core helpers before passing
it to `createStore` or `TarstateProvider` when using `useMaterialized`.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested directly against `@tarstate/core` without rendering React.
