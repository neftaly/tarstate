# Tarstate React Walkthrough

This package is a guided React tutorial for Tarstate. It is not an app template.

The walkthrough starts with the problem Tarstate solves: nested React state can
duplicate the same data in many places. It then uses one tiny normalized model
for the rest of the page: `projects`, `people`, and `tasks`.

Sections cover:

- why normalized relational state helps;
- schema and seed rows;
- invalid row diagnostics while valid rows still query cleanly;
- query values that can be inspected, run, reused, materialized, watched, and
  passed to different backing stores;
- immutable transactions through `useTransact`;
- materialized aggregate views through `useMaterialized`;
- concrete `Set` and `Map` index shapes;
- readable constraint diagnostics for rejected writes;
- `useWatch` added/deleted aliases;
- the same query over an `automergeDb` snapshot.

The tutorial intentionally avoids product UI workflows, adapter/runtime
internals, memory runtime details, exhaustive operators, and full Automerge
presence or sync behavior.
