# @tarstate/react

`@tarstate/react` is the idiomatic React entrypoint for Tarstate. It wraps the
core relational model in a revisioned external-store surface and keeps React
subscription concerns out of `@tarstate/core`.

Use it when a React app wants Tarstate as a local relational/lens-style state
layer with explicit writes, not general bidirectional lens/view putback:

- `createDbStore` for object-backed local state. It accepts
  `createDbStore(input, { constraints })` for creation-time object-backed
  constraint attachment. Commits enforce attached object-backed constraints and
  use delta-backed snapshot materialization maintenance, with recompute fallback
  outside the narrow incremental subset. Committed writes also return optional
  core-sourced `changes`; rejected writes do not.
- `createSourceStore` for external state exposed as a `RelationSource`, plus an
  optional patch target. Reflected commits, manual refresh, and host
  invalidations maintain existing materializations when the previous snapshot
  carries metadata; source-backed paths recompute conservatively unless real
  relation deltas are reported.
- `createRuntimeStore` for generic `RelationRuntime` integrations such as
  composed durable documents plus ephemeral presence. Runtime stores follow the
  same materialization rules as source stores.
- `createAdapterStore` for write-capable integrations that implement
  `RelationAdapter`, preferably with read-consistent `snapshot()` support.
  Adapter commits follow the reflected-commit maintenance path; host
  `refresh`/`subscribe` invalidations preserve materializations through the same
  conservative source refresh path.
- `TarstateProvider`, `useTarstateQuery`, `useTarstateQueries`,
  `useTarstateCommit`, and `useTarstateSnapshot` for components. The shorter
  `useQuery`, `useQueries`, and `useCommit` aliases are also exported. Query
  hooks try exact current materialized-query read-through before evaluating
  cache-safe queries against the captured source snapshot.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested through `@tarstate/core` without React.
