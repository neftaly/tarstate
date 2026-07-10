# V1 scope decisions

Status: normative decision record. Date: 2026-07-10.

This log distinguishes measured technical contradictions from owner-selected
product scope. It exists so implementation convenience cannot be presented as
spike evidence.

## D-001: remove the legacy implementation

The owner selected a clean-slate v1 tree after the spike replacements existed.
The legacy implementation and tests remain immutable at `legacy-v0-final`
(`25f707c`), solely for archaeology and optional coarse comparison. V1 gates
must have current executable evidence; the tag is not a runtime dependency or
a reason to preserve parallel production paths.

## D-002: use performance as a structural warning

The owner selected simplicity and decomplection over v1 microbenchmark, GC, and
per-operator timing programs. This supersedes the original broad measurement
list; it was a product decision, not contradictory spike evidence.

The release gate retains three useful safeguards:

- compiler and declaration-size budgets for the public TypeScript surface;
- explicit cache, lease, and subscription lifetime tests;
- a deliberately loose coarse-golden runtime ceiling that catches gross
  regressions while avoiding claims about portable latency.

A coarse failure is a signal to inspect ownership and data flow first. It does
not authorize weakened semantics, hidden mutable caches, or benchmark-specific
fast paths. Focused profiling and numeric budgets should be introduced only
when a real workload shows a material problem.

## D-003: remove Tarstate-owned Automerge movement

The Automerge 3.2.6 spike found no public identity-preserving subtree-move
operation and showed that a copy/delete fallback changes object, descendant,
text, counter, and list-element identity while failing to forward concurrent
old-subtree edits. The owner therefore rejected the previously proposed
Tarstate `copyRelocate` fallback instead of productizing its loss catalog.

The built-in Automerge adapter advertises no `move`, `copyRelocate`, or
`identityPreservingMove` capability. It reserves, writes, reads, migrates, or
interprets no Tarstate move-metadata key. Existing `__automergeMoves`,
`__tarstateMovesV1`, or similar values are application data: the adapter
preserves them as unknown storage but assigns them no Tarstate meaning.

Portable move tiers remain valid generic contracts for non-Automerge sources
and explicit custom bindings. An application or custom binding that implements
movement owns its record namespace, migration, conflict behavior, retention,
and capability claims. Those records are not a built-in Tarstate wire format or
an interoperability promise. Adding movement to the built-in Automerge adapter
requires a new owner decision and evidence; it is not an automatic upgrade when
a library primitive appears.

## D-004: revoked — full recomputation is not v1 completion

An earlier implementation pass incorrectly treated a fake differential wrapper
as evidence that incremental maintenance could be removed. The wrapper always
ran the full evaluator and was correctly deleted, but the original IVM
acceptance criterion remains mandatory.

V1 keeps the pure evaluator as a test oracle and uses one real incremental
production path. It must not retain speculative delta hooks or silently fall
back to full-query recomputation. The executable requirements are locked in
[acceptance.md](acceptance.md).
