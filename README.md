# Tarstate

Tarstate 1.0 is a clean-slate rewrite of a functional, reactive relational
interface over authority-scoped local-first sources.

The legacy implementation was removed from `main`. It remains available at the
annotated Git tag `legacy-v0-final` (commit `25f707c`) for coarse benchmark and
historical comparisons. It is not a compatibility target or dependency of the
rewrite.

The current repository contains:

- the [normative v1 contract](docs/v1/README.md);
- the portable semantic oracle, source coordinator, resolver, database,
  observers, and receipts in `@tarstate/core`;
- production Automerge and generic external-store/Zustand adapters;
- the small React observer, commit, mutation-state, and optimistic-display adapter; and
- deterministic schema, issue-catalog, and agent-description tooling.

Historical design and spike material remains available in Git history. The
retained contract and executable production tests are the authority for v1.

```sh
pnpm check:release
```

The release check builds and tests the workspace, enforces the TypeScript
complexity budget, consumes the emitted declarations, and verifies all five
dist-only package tarballs. The gate-by-gate record is in
[docs/v1/conformance-matrix.md](docs/v1/conformance-matrix.md).

Legacy performance is intentionally only a gross-regression signal. See
[benchmarks/README.md](benchmarks/README.md) for the isolated baseline runner.
