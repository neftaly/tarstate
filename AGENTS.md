Prefer small, cohesive modules and readable multiline control flow; name domain
concepts explicitly and keep pure transformations separate from lifecycle and
I/O shells. Parse or adopt untrusted values once at public boundaries, then rely
on owned typed values internally. Before handoff run `pnpm check`; also run
`pnpm test:fuzz` for invariant-heavy changes and `pnpm check:perf` for
query-maintenance or hot-path changes.
