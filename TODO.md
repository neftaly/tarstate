# Remaining performance work

Ordered by the smallest useful implementation slice, not only by potential impact.

## Bounded slices

- [ ] Share one immutable capture-evidence bundle per dataset frame across query
  roots. Evidence is currently rebuilt and cloned per root, multiplying work by
  query count even when every root observes the same capture.
- [ ] Maintain counted ordered state for aggregate `minimum` and `maximum`.
  Removing the current extreme scans the full distinct value domain, and
  periodic overlay compaction copies that domain.
- [ ] Cache coordinator command canonicalization across validation phases so a
  single accepted command graph is not serialized repeatedly.

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
