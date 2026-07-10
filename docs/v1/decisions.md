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

## D-003: withhold unsupported native Automerge movement

The Automerge 3.2.6 spike found no public identity-preserving subtree-move
operation. The owner accepted a v1 `copyRelocate` adapter with explicit losses,
legacy/current metadata readers, and an honestly withheld
`identityPreservingMove` capability. A future native adapter remains obligated
to produce the same portable move meaning apart from its stronger mechanism and
identity guarantees.
