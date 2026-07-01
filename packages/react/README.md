# @tarstate/react

`@tarstate/react` is the idiomatic React entrypoint for Tarstate. It wraps the
core relational model in a revisioned external-store surface and keeps React
subscription concerns out of `@tarstate/core`.

The React API should stabilize around the provider, store constructors, query
hooks, and commit hook. Constraint enforcement, materialized-query read-through,
and watch-change envelopes remain experimental core behavior rather than React
API shape. Commit `effects.deltas` use the stable core adapter `RelationDelta`
shape.

Use it when a React app wants Tarstate as a local relational/lens-style state
layer with explicit writes, not general bidirectional lens/view putback:

- `createDbStore` for object-backed local state. Commits apply explicit write
  patches and publish revisioned snapshots. Constraint attachment and concrete
  watch-change envelopes remain experimental core behavior, not React
  constructor options.
- `createSourceStore` for read-only external state exposed as a `RelationSource`.
  Manual refresh and host invalidations capture a fresh source snapshot for
  React consumers.
- `createRuntimeStore` for generic `RelationRuntime` integrations such as
  composed durable documents plus ephemeral presence.
- `createAdapterStore` for write-capable integrations that implement
  `RelationAdapter`, preferably with read-consistent `snapshot()` support.
  Adapter commits and host `refresh`/`subscribe` invalidations publish fresh
  source snapshots through the same React store contract.
- `TarstateProvider`, `useTarstateQuery`, `useTarstateQueries`,
  `useTarstateCommit`, and `useTarstateSnapshot` for components. The shorter
  `useQuery`, `useQueries`, and `useCommit` aliases are also exported. Query
  hooks evaluate against the captured source snapshot.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested through `@tarstate/core` without React.

`@tarstate/react` does not expose a general IVM API, operator-maintained view
API, materialization cache API, or async stream contract.
