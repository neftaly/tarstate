# Tarstate

Tarstate is a standalone generic TypeScript library for querying JSON-shaped data as rows.

The core library lives in `packages/core` as `@tarstate/core`. It is kept generic:
no application schemas, renderer concepts, or wrappers belong in the package.

## Layout

- `packages/core` for the generic `@tarstate/core` library.
- `apps/tarstate-demo` for the DOM demo that exercises query evaluation and writer patches.
- Root TypeScript, Vite, Vitest, and CI config stay shared until a package needs its own override.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
