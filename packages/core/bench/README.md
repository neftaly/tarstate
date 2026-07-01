# Core Benchmarks

This directory contains the first deterministic benchmark harness for `@tarstate/core`.
It uses Vitest's benchmark runner and only public package exports plus the existing
experimental exports that are already published through `packages/core/package.json`.

## What It Measures

`fixtures.ts` builds normalized project/person/task data at three deterministic
scales:

- `small`: quick local smoke fixtures.
- `medium`: default query/write fixture used by most benchmarks.
- `large`: reserved for the object-source versus indexed-source lookup comparison.

`query.bench.ts` covers representative read paths:

- Direct relation scans through `qRows`.
- Filter/project queries.
- Inner joins and miss-heavy `leftJoin`, including larger-scale join cases.
- `sortLimit`.
- Aggregates.
- `expand` over task labels.
- `qMany` batch reads.
- `queryKey`.
- Explicit `lookup(...)` evaluated against object and indexed relation sources.
- `qRows(lookup(...))` automatic-routing candidates on plain and materialized databases.
- Explicit `lookup(...)` evaluated through a materialized hash-backed source before and after incremental maintenance.
- Explicit `lookup(...)` evaluated through a materialized unique-backed source before and after incremental maintenance.

`write-materialization.bench.ts` covers the initial write/materialization slice:

- `createDb` and the `db` alias.
- `tryTransact` and `transact` for single and batch writes.
- Predicate update and delete patches.
- Rejected writes through an attached unique constraint.
- Materialized `qRows` reads and materialized transaction maintenance.
- Requested incremental materialization maintenance for simple, joined, and aggregate deltas, including root inserts, updates, and deletes.
- Larger materialized joined-query maintenance.
- Large `trackTransact` reporting for requested incremental joined-query deltas.
- Large requested incremental versus snapshot materialization maintenance for miss-heavy `leftJoin`.
- Requested incremental versus snapshot materialization maintenance for grouped `topBy`/`bottomBy` aggregate winners.
- Materialization set/hash/btree/unique index facades.
- Materialized hash/unique/btree facade reads before and after an incrementally maintained insert.
- Compound hash/unique and expression-projected hash/btree facade reads after maintained inserts.
- Transaction maintenance for compound and expression-projected materialized index declarations.
- Watch refresh, `trackTransact`, and `diffQuery`.

## Not Yet Measured

This first harness intentionally does not measure browser frame hitching, cold
Automerge WASM/module import costs, long-running GC pressure, memory retention,
adapter durability, networked runtimes, requested-incremental `sortLimit`
materialization while it still reports fallback diagnostics, or fuzz/property
exploration. Those need separate harnesses with different isolation and
reporting.

## Commands

Run the core benchmark suite:

```sh
pnpm --filter @tarstate/core bench
```

Useful validation commands while editing the harness:

```sh
pnpm --filter @tarstate/core typecheck
pnpm --filter @tarstate/core test
```
