# Tarstate

Tarstate is a standalone generic TypeScript library, currently represented by a clean pnpm monorepo shell.

The repository is intentionally empty of package APIs for now. Migrate implementation code when the generic library boundary is ready rather than carrying placeholder stubs.

Royal-specific adapters live outside Tarstate.

## Layout

- `packages/` for library packages when they are extracted.
- `apps/` for demos or fixtures when they prove a package API.
- Root TypeScript, Vite, Vitest, and CI config stay shared until a package needs its own override.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
