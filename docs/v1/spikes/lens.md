# Schema lens spike evidence

Status: executable evidence, 2026-07-10.

The fixture `packages/core/tests/v1-lens-spike.test.ts` executes the complete
synthetic v1-app/v200-data trace through the exact schema-lens wire steps.

The fixture proves:

- two compatible paths reject until one exact lens ref is selected; selecting
  both and same-ID/different-hash metadata also reject;
- current rows project renamed fields and source-local ID-to-slug references;
- v200-only, unknown, and action-like storage fields remain hidden and survive
  field-level v1 writes;
- `blocked -> open` remains readable with `lens.lossy_value`, while any reverse
  write through that representation rejects;
- a v1 slug rekey updates only `legacySlug`, preserving stable ID and comment
  references, and uniqueness is checked on current final state;
- a v1 comment-ref change maps a unique slug back to its stable ID and rejects
  missing or ambiguous lookups; and
- newer required constraints run after inverse translation, while an executor
  unable to resolve them is read-only.

No normative contradiction was found.
