# Relic Parity Matrix

Scope: `github.com/wotbrew/relic` public API and docs checked on 2026-07-03,
repository tree `052075f9e6045996c0c11931f3c8a3fa5478b6f9`.

Tarstate is now a TypeScript adaptation of Relic rather than a literal Clojure
API port. The canonical API remains typed builders and relation refs; the
compatibility API lives under `@tarstate/core/relic` for parsed Relic-shaped
forms represented as JavaScript arrays/objects.

## Current Parity

- Queries: `q`, `qResult`, `qMany`, `qManyResult`, `from`, `where`, `extend`,
  `select`/`project`, `without`, `join`, `leftJoin`, `agg`/`aggregate`, sort,
  limit, `constRows`/`constantRows`/`constRelation`, set ops, `qualify`,
  `rename`, lookup metadata, and `dependencies`.
- Expressions: comparisons, boolean predicates, null/missing predicates,
  `env`, `sel`, `sel1`, `self`, `tuple`, `ifElse`, `getKey`, `call`, and
  nil-safe `callMaybe`.
- Aggregates: `count`, `sum`, `avg`, `min`, `max`, `maxBy`, `minBy`, `top`,
  `bottom`, `topBy`, `bottomBy`, `countDistinct`, `any`, `notAny`, and
  `setConcat` as a deduplicated array.
- Writes: variadic `transact`/`tryTransact`, `whatIf`, insert variants,
  predicate `update`/`deleteRows`, key writes, `deleteExact`, `replaceAll`,
  nested write arrays, callbacks, and non-throwing diagnostics.
- Materialization/indexes: root and subpath `mat`, `demat`, `index`,
  materialized read-through, hash/btree/unique index metadata, constraints, and
  maintained snapshots with honest recompute diagnostics for unsupported
  incremental shapes.
- Watches/change tracking: root and subpath watch helpers, `attachWatches`,
  `detachWatches`, `trackTransact`, runtime tracking, and `relicChanges(...)`
  projection with Relic `deleted` spelling.
- Compatibility parser: `@tarstate/core/relic` exports `fromRelicQuery`,
  `fromRelicExpr`, `fromRelicTx`, and structured `RelicParseError`. It supports
  the oracle-backed query/write subset with colon-prefixed keyword strings.

## Intentional TypeScript Differences

- Typed builders are canonical. Relic vector forms are supported only as parsed
  JS arrays/objects under `@tarstate/core/relic`; EDN text parsing is not part
  of core.
- Clojure names that are poor TypeScript identifiers keep TS spellings:
  `exists`, `setEnvTx`, `trackTransact`.
- `unique` remains the constraint helper and `uniqueIndex` remains the index
  helper. The Clojure overload is intentionally not mirrored.
- `deleteRows` is not aliased to a public `delete` binding.
- Clojure transducers are not mirrored; `mapRows` and `into` are the TS-shaped
  `q` option equivalents.
- `setConcat` returns a stable array, not a Clojure set.
- Storage is pluggable through source/runtime/adapter boundaries; core does not
  collapse Automerge or other adapters into the plain `Db` shape.

## Known Remaining Gaps

- `@tarstate/core/relic` does not parse raw EDN text and intentionally supports
  only a narrow source-compatibility subset. Unsupported parser forms include
  arbitrary Clojure functions/macros, `rel/sel`/`rel/sel1`, correlation maps,
  constraints, q batch option maps, transducers, `:lookup`, `:expand`,
  `:rename`, `:qualify`, index clauses, `:insert-or-merge :*`, and
  function-valued tx/update forms.
- Incremental materialization still recomputes for set operations, predicate
  joins, non-direct joins, selected/correlated subqueries, and aggregate forms
  that require more state than the current delta model preserves. Direct
  single-source pipelines, supported grouped aggregates, top-N, inner/left
  equi-joins, and identity-preserving `expand` are incrementally maintained.
- Constraint custom error expressions are not exposed as a Relic-compatible
  parser form.
- Runtime `setEnvTx` propagation into external adapter envelopes remains an
  adapter/runtime integration concern. Direct Automerge adapter use supports an
  `env` option.
- Atomic multi-target runtime commits are still bounded by each target adapter's
  patch application semantics.

## Oracle Coverage

`pnpm relic:oracle` runs the Tarstate golden cases and optionally compares the
same cases against `com.wotbrew/relic` when Clojure can resolve the dependency.
Current cases cover projection, join, left join, aggregate, set operations, and
transaction vectors.
