# Tarstate

Tarstate is a standalone generic TypeScript library for relational queries and
derived views over JSON-shaped application state. It is a relational/lens-style
derivation layer, not a full database or a general bidirectional lens/view
putback system.

The core library lives in `packages/core` as `@tarstate/core`. React apps should
start from `packages/react` as `@tarstate/react`; the core package stays generic
and does not own renderer concepts.

## Layout

- `packages/core` for the generic `@tarstate/core` library.
- `packages/react` for the idiomatic React entrypoint.
- `packages/automerge` for the Automerge API-surface consumer example.
- `apps/tarstate-demo` for the DOM demo that exercises query evaluation and writer patches.
- [docs/developer-onboarding.md](docs/developer-onboarding.md) for API status, onboarding flows, and package direction.
- [docs/roadmap.md](docs/roadmap.md) for maturity labels, open decision areas, and release readiness signals.
- Root TypeScript, Vite, Vitest, and CI config stay shared until a package needs its own override.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm bench
pnpm build
```
