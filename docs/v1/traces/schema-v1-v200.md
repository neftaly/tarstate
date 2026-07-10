# Trace: v1 app editing v200 data

Status: normative conformance trace.

## Fixture status

This is a synthetic compatibility fixture designed to exercise the complete
v1 lens subset. It does not claim to describe an existing deployed app.

## Schema nodes

Schema `tasks@1` exposes relation name `tasks`, stable relation ID
`example.task`, key `slug`, fields `slug`, `title`, and enum `state = open |
done`.

Schema `work-items@200` exposes relation name `workItems`, the same stable
relation ID, key `id`, and fields:

- `id`: stable ID;
- `legacySlug`: unique compatibility field;
- `name`: renamed title;
- `state = open | done | blocked`;
- `notes`: new field unknown to v1.

Comments in v1 refer to task slug. Comments in v200 refer to task ID.
The source activates a newer required constraint set requiring non-empty `name`
and valid comment targets.

## Selected lens

An explicitly selected, hashed bidirectional lens maps:

- relation `workItems` to view name `tasks` while retaining relation ID;
- `legacySlug` to v1 key `slug`;
- `name` to `title`;
- comment task IDs to slugs through a unique source-local lookup;
- `open` and `done` directly;
- v200 `blocked` to v1 `open`, accompanied by compatibility issue
  `lens.lossy_value`, while marking writes to `state` from that representation
  unsupported.

The lens has no permission meaning. A second equally valid lens path is added to
the fixture; resolution fails until the host selects one exact path.

## Read

1. The host resolves the v200 schema, active constraints, selected lens, codecs,
   functions, and trust fingerprint.
2. The v200 binding parses source rows and projects the v1 view.
3. A v1 app reads tasks and comments using its declared schema. Added `notes`
   remains hidden but preserved in storage.
4. A blocked work item is readable to v1 as unfinished (`state: open`); the
   result carries `lens.lossy_value` rather than silently pretending full
   round-trip support.

## Supported write

The v1 app changes only `title` for slug `draft-plan`.

1. Commit runs in the current host, not in v1 application code.
2. The source-local view resolves the selected row locator and maps `title` to
   `name`.
3. Field-level planning changes only `name`; `id`, `legacySlug`, `state`,
   `notes`, and unknown storage fields are untouched.
4. The current host evaluates the active v200 constraint set on authoritative
   final state.
5. One source commit succeeds and returns rows in the requested v1 view.

The old app did not need to know the newer constraints. An old executor unable
to resolve the required set would have been read-only.

## Rejected writes

- Attempting to write v1 `state` for an underlying `blocked` item rejects as a
  lossy reverse mapping.
- Rekeying v1 `slug` updates only unique `legacySlug` through explicit rekey
  semantics. It preserves stable v200 `id` and ID-based comment refs; it rejects
  when the new slug is not unique or the lens cannot prove that translation.
- A comment ref write rejects if slug-to-ID lookup is missing or ambiguous.
- A schema/lens/constraint metadata conflict rejects before mutation.
- Selecting neither or both compatible lens paths rejects; no shortest path is
  inferred.

## Constraint upgrade

A newly published constraint set first activates in audit mode. Existing empty
names appear as violations without freezing unrelated writes. After repair and
explicit activation as required, capable hosts reject newly introduced empty
names. A remote old peer may still merge a violation; the capable host exposes
post-merge diagnostics rather than claiming global enforcement.
