# Tarstate

Tarstate is a standalone generic TypeScript library, currently represented by a clean pnpm monorepo scaffold.

The repository is intentionally empty of package APIs for now. Migrate implementation code when the generic library boundary is ready rather than carrying placeholder stubs.

Royal-specific adapters live outside Tarstate.

The current `apps/dummy-app` and `packages/dummy-package` workspaces are neutral config fixtures. They prove the app/package Vite, TypeScript, and Vitest wiring without defining Tarstate runtime APIs.

## Layout

- `packages/` for library packages when they are extracted; `packages/dummy-package` preserves package build conventions until then.
- `apps/` for demos or fixtures when they prove a package API; `apps/dummy-app` preserves app build conventions until then.
- Root TypeScript, Vite, Vitest, and CI config stay shared until a package needs its own override.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
