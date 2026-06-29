# Tarstate

Tarstate is being prepared as a standalone monorepo. This repository is intentionally scaffold-only for now; package code will move here after the Royal-side package boundaries are clean.

## Planned Layout

- `packages/tarstate-core`: generic Tarstate schema, sources, query, evaluation, and write APIs.
- `apps/tarstate-demo`: small demo app once the package is extracted.

Royal-specific integration, including `@royal/tarstate-lens`, stays in the Royal repository unless it becomes generic.

## Extraction Criteria

Before moving code here:

- `@tarstate/core` has no `@royal/*`, renderer, or app dependencies.
- Royal consumes Tarstate through package exports, not source paths.
- The public API and compatibility story are documented.
- Tests and typecheck pass in both repositories during the transition.

## Current State

Scaffold only. No Tarstate package code has been copied into this repository yet.
