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
