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

`write-materialization.bench.ts` covers the initial write/materialization slice:

- `createDb` and the `db` alias.
- `tryTransact` and `transact` for single and batch writes.
- Predicate update and delete patches.
- Rejected writes through an attached unique constraint.
- Materialized `qRows` reads and materialized transaction maintenance.
- Larger materialized joined-query maintenance.
- Materialization set/hash/btree/unique index facades.
- Watch refresh, `trackTransact`, and `diffQuery`.

## Not Yet Measured

This first harness intentionally does not measure browser frame hitching, cold
Automerge WASM/module import costs, long-running GC pressure, memory retention,
adapter durability, networked runtimes, or fuzz/property exploration. Those need
separate harnesses with different isolation and reporting.

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
