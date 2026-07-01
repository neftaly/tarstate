# Tarstate

Tarstate is a TypeScript conversion/adaptation of
[wotbrew/relic](https://github.com/wotbrew/relic), the Clojure relational
programming library inspired by
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf).

The goal is to bring Relic's normalized data model, query-as-data, functional
transactions, materialized views, constraints, and watched change tracking into
TypeScript, while keeping storage pluggable enough for object-backed state,
Automerge-backed collaboration, and React applications.

The core library lives in `packages/core` as `@tarstate/core`. React apps should
start from `packages/react` as `@tarstate/react`; the core package stays generic
and does not own renderer concepts. Automerge support lives in
`packages/automerge` as an integration backing over the same DB-first API.

## Layout

- `packages/core` for the generic `@tarstate/core` library.
- `packages/react` for the idiomatic React entrypoint.
- `packages/automerge` for Automerge-backed DB integration.
- `apps/tarstate-demo` for React-first examples covering queries,
  transactions, materialization, constraints, watches, and Automerge backing.
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
