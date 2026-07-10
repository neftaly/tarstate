# Legacy benchmark baseline

The legacy implementation is not retained on `main`. The annotated Git tag
`legacy-v0-final` points to commit `25f707c`, the final checkout used for legacy
benchmark comparisons. `legacy-v0.json` records its toolchain, commands, stable
seeds, workload sizes, and scenario names.

Run the archived suite in an isolated worktree:

```sh
pnpm bench:legacy
```

The runner creates `/tmp/tarstate-legacy-v0`, installs the baseline lockfile,
and executes its benchmark command. Pass a different worktree path as the first
argument when required:

```sh
pnpm bench:legacy ../tarstate-legacy-bench
```

Replacement benchmarks should reconstruct the same portable workload inputs
from `legacy-v0.json` and report their own implementation and commit. Old and
new packages do not need to coexist in one dependency graph.

The production tree also has one deliberately coarse smoke benchmark over its
five staged golden workloads. Build first, then run:

```sh
pnpm build
pnpm bench
```

Set `TARSTATE_BENCH_ITERATIONS` only when a longer gross-regression sample is
useful. This is a structural signal, not a microbenchmark or a parity claim for
the archived legacy scenarios.

The benchmark policy favors semantic simplicity over hot-path tuning. Retain a
small number of representative workloads and investigate only large
regressions. A large gap is primarily a signal to simplify boundaries, remove
duplicated work, or decomplect the design; it is not a mandate to preserve the
legacy implementation or its micro-optimizations.
