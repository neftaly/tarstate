# Tarstate

Tarstate is being redesigned as a functional, reactive relational interface
over authority-scoped local-first sources. Automerge documents are the primary
durable source of truth; Zustand, TanStack Store, and similar stores attach
through a generic atomic-source protocol.

The existing implementation is archived evidence, not the next public API.
Production rewrite work has not started. The current source of truth is the
[Tarstate v1 normative design packet](docs/v1/README.md), including its required
executable spikes and conformance gates.

Key boundaries:

- portable schemas, queries, constraints, transactions, mappings, and lenses;
- a pure functional core with an imperative source/React/network shell;
- multi-source reads with explicit evidence, but atomic writes only within one
  source;
- functional `pipe` authoring rather than fluent query chains;
- structured parse results, capability gaps, and receipts suitable for people,
  applications, and agents.

Legacy code and tests remain temporarily because they are useful behavioral
oracles for the spikes. They may be deleted only after the replacement evidence
required by the design packet exists.
