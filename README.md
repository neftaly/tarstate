# Tarstate

Tarstate is a clean-slate v1 rewrite of a functional, reactive relational
interface over authority-scoped local-first sources.

The legacy implementation was removed from `main`. It remains available at the
annotated Git tag `legacy-v0-final` (commit `25f707c`) for coarse benchmark and
historical comparisons. It is not a compatibility target or dependency of the
rewrite.

The current repository contains:

- the [normative v1 design packet](docs/v1/README.md);
- isolated executable semantic seeds in `@tarstate/core`;
- measured Automerge copy-relocation evidence in `@tarstate/automerge`; and
- the generic external-store runtime plus Zustand/TanStack evidence.

These seeds prove the five entry spikes. They are now the only implementation
surface and will be replaced or promoted as the production build order
advances.

```sh
pnpm check
```

Legacy performance is intentionally only a gross-regression signal. See
[benchmarks/README.md](benchmarks/README.md) for the isolated baseline runner.
