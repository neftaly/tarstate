# Automerge spike evidence

Status: executable evidence, 2026-07-10.

The fixture `packages/automerge/tests/v1-automerge-spike.test.ts` runs against
locked `@automerge/automerge` 3.2.6 and `@automerge/automerge-repo` 2.5.6.
`@tarstate/automerge/v1-spike` contains the isolated fallback implementation.

Measured results:

- heads compare exactly as an unordered set and retained heads remain
  viewable;
- concurrent inserts at one map key retain both conflict candidates, while the
  visible JavaScript value is only Automerge's presentation winner;
- schema metadata has the same conflict behavior, and one later causal ordinary
  assignment clears all observed scalar alternatives;
- copied roots and nested maps receive new object IDs; counters retain their
  current numeric value as a new Counter and text retains its current string,
  but neither retains CRDT identity;
- a newly assigned list has no public object ID inside the atomic change, so an
  atomic completed record cannot contain the full post-change descendant map;
- a concurrent edit to the deleted old subtree is present in retained history
  but absent from merged live state and is not forwarded to the copy; and
- Repo peer lifecycle is identified by peer ID, sync heads by storage ID, and
  Presence state by peer/channel with explicit start/stop lifecycle. Repo does
  not expose a generic connection ID.

The last three findings contradicted pre-spike wording. The move and discovery
specifications now state the measured limits. The fallback advertises only the
exact `entity/copy-relocate` capability (which explicitly implies `entity/move`)
and reports the frozen preservation-loss codes in every record.
