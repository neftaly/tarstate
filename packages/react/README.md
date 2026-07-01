# @tarstate/react

`@tarstate/react` is the React integration for the TypeScript Relic-style
Tarstate core. The React layer owns subscription and render safety; data reads
and writes go through core `Db` values and core query/transaction helpers.

Primary API:

- `createDbStore(db?)` creates a revisioned React store around a core `Db`.
- `TarstateProvider` accepts either a `store` or a provider-owned `db`.
- `useDb()` reads the current core `Db`.
- `useQuery(query)` evaluates a core query with `q`.
- `useTransact()` applies explicit core write patches with `tryTransact`.
- `useMaterialized(query)` reads core materialized query rows after
  `store.materialize(query)`.
- `useWatch(query)` delivers core watch events as the provider DB changes.

Materialization and watch helpers retain their core shapes. React keeps these
thin: materialization rows, transaction deltas, and diagnostics pass through as
core data rather than React-specific models.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested directly against `@tarstate/core` without rendering React.
