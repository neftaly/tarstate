# @tarstate/relic-cljs

Experimental spike for running upstream `wotbrew/relic` through ClojureScript
behind a small JavaScript facade.

This package is intentionally private and opt-in. It is not included in the
normal root build path. The goal is to measure whether upstream Relic can act as
an engine behind Tarstate-shaped adapters without forcing the application to
handle ClojureScript values directly.

## Boundary

- The CLJS database is opaque to TypeScript and React code.
- JavaScript seed rows, queries, and transactions are converted at the wrapper
  boundary.
- Strings beginning with `:` are converted to Clojure keywords, so JS callers
  can write Relic query/transaction data without a keyword constructor.
- `trackTransact` returns `{ db, changes }`, with changes as an array instead of
  a map keyed by query values. That avoids lossy JS object keys.
- React integration uses `useSyncExternalStore` over a revisioned store.

## Commands

```sh
pnpm --filter @tarstate/relic-cljs test
pnpm --filter @tarstate/relic-cljs cljs:build
pnpm --filter @tarstate/relic-cljs cljs:smoke
```

`cljs:build` resolves Maven dependencies from `deps.edn`, including
`com.wotbrew/relic` and `thheller/shadow-cljs`.

## What To Measure

1. Cold Maven/shadow build cost, then bundled JS size.
2. Browser cold import time for `dist/cljs/relic.js`.
3. Initial `createDb(automergeSnapshot.data)` conversion cost.
4. `trackTransact` cost for a small Automerge-derived patch.
5. React commit latency through `useRelicCljsQuery` and `useRelicCljsWatch`.
6. Long-running memory growth when the opaque CLJS DB is replaced per commit.
