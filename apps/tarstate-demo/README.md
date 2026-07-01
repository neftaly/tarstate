# Tarstate Real Estate Demo

This package is a compact React walkthrough for Relic-style Tarstate queries.

The demo uses one normalized real-estate sales dataset:

- `agents`
- `buyers`
- `properties`
- `rooms`
- `offers`
- `decisions`
- `commissionRates`

It shows query values for property info, current offers, accepted sales, unsold
listings, open offers, and commission due by agent. The page keeps the focus on
controls, query snippets, result tables, materialized reads, transactions,
diagnostics, watch events, and running the same listing query over an
`automergeDb` snapshot.

Run locally:

```sh
pnpm --filter @tarstate/demo dev
```
