# Relic Oracle Harness

This directory holds the optional Clojure-side oracle for comparing small Tarstate golden cases with `wotbrew/relic`.

The normal test suite does not run Relic or resolve Clojure dependencies. To opt in:

```sh
TARSTATE_RELIC_ORACLE=1 pnpm --filter @tarstate/core exec vitest run --config ../../vite.config.ts tests/relic-oracle.test.ts
```

or from the repo root:

```sh
pnpm relic:oracle
```

The harness shells out to:

```sh
clojure -Sdeps '{:deps {com.wotbrew/relic {:mvn/version "0.1.7"}}}' -M scripts/relic-oracle/oracle.clj
```

If Clojure or the Relic dependency is not available, the env-gated comparison is skipped. The Tarstate-side golden expectations still run as part of normal core tests.
