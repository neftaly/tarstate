# Remaining performance work

Cross-cutting risks come first; concrete implementation gaps are then ordered by
the smallest useful slice, not only by potential impact.

Keep recursive ownership at hostile/portable boundaries, then use owned native
values, shallow-frozen publication shells, and targeted copy-on-write. Do not
introduce a generic immutability dependency without a measured workload that
justifies its conversion and bundle costs.

## Cross-cutting hot paths

- [ ] Make React's generic row ownership contract explicit: either require
  portable rows and validate them, or preserve opaque row identity. Generic
  deep cloning can corrupt `Map`, `Date`, and class values and can invoke getters.
- [ ] Remove repeated deep clone-and-freeze passes over graphs that are already
  owned and immutable; prefer one boundary adoption followed by shallow frozen
  wrappers and shared references.
- [ ] Reuse canonical JSON encodings and semantic hashes for owned immutable
  graphs instead of repeatedly serializing the same subtrees.
- [ ] Replace full-array copies, spread-heavy transformations, and chained
  `map`/`filter` intermediates in measured update paths with structural sharing
  or single-pass construction.
- [ ] Replace repeated sorting and deep structural comparison with maintained
  indexes, stable identities, or cached comparison keys where semantics allow.

## Bounded slices

- [ ] Maintain counted ordered state for aggregate `minimum` and `maximum`.
  Removing the current extreme scans the full distinct value domain, and
  periodic overlay compaction copies that domain.

## Medium architectural slices

- [ ] Preserve changed-source identity through dataset notifications and reuse
  unaffected source captures and projections. A source event currently causes
  the full dataset to be snapshotted and projected again.
- [ ] Track overlay relevance and revisions per optimistic query view. A global
  overlay revision currently replays every pending overlay across every view.

## Representation changes

- [ ] Replace array-backed relation transitions with persistent occurrence and
  position indexes. A one-row update still walks and allocates the full relation,
  and stable `from` maintenance copies its full output.
- [ ] Maintain an ordered index for `seek` and pool it across compatible roots.
  Keyset pagination currently performs a full sort and scan for each evaluation.

Each implementation should add a scaling or allocation contract for the
dimension it improves; the current benchmarks mainly cover one relation, source,
attachment, and observer root.
