# Trace: Patchpit recursive folder and HTTPS resource

Status: normative conformance trace.

## Migration status

This is the target v1 Patchpit fixture, not a description of the archived
storage model. The archived `@patchpit/fs` uses positional `number[]` paths as
node keys and tests identity changing on move. Conformance therefore requires a
coordinated schema/data migration to stable entry IDs. The resolver, direct
HTTPS resource handling, and authority model are also new Tarstate behavior.

## Fixture

An authority-scoped Patchpit database starts with folder source `A`.

Folder entries have stable logical entry IDs. Parent and order are fields; path
segments and positions are not keys.

| Entry | Source | Meaning |
| --- | --- | --- |
| `a-app` | `automerge:B` | child folder |
| `a-tiger` | `https://upload.wikimedia.org/.../Ghostscript_Tiger.svg` | byte resource leaf |
| `a-missing` | `automerge:C` | missing document |
| `a-denied` | `automerge:D` | document denied by authority |

Folder `B` contains entry `b-cycle` linking back to `automerge:A`.

`A` and `B` declare immutable schema refs with exact hashes. The Tiger URL does
not declare a relational schema or executable code.

## Resolution sequence

1. Membership revision 1 is `open` with required source `A`; `A` is loading.
2. `A` becomes ready. Its four discovery edges are queryable. Revision 2 is
   open and expects `B`, `C`, and `D` while the HTTPS resource resolver begins a
   byte fetch.
3. `B` becomes ready. Its edge back to `A` is retained, but source `A` is not
   attached twice.
4. `C` resolves missing and `D` resolves denied. Their target relations are not
   fabricated as empty.
5. The Tiger fetch returns SVG bytes, content type, requested URL, resolved URL,
   ETag, and content hash. It remains a resource fact, not a relational source.
6. The traversal has visited every reachable authorized edge. Membership
   revision 2 becomes settled despite the cycle and unavailable targets.

## Query semantics

- A filesystem tree query may exactly show the known entries, including an
  inaccessible/missing state for `C` and `D`, because those states are positive
  resolver facts.
- A query over rows inside `A` and `B` is exact once both are ready and its
  declared dataset excludes unavailable targets.
- A query asking “which linked documents contain no matching row?” is unknown
  if `C` is a required member; it MUST NOT classify missing data as absence.
- Opt-in lower-bound evaluation may return positive rows from `A` and `B`, with
  evidence that `C` and `D` contributed none because they were unavailable, not
  empty.
- The cycle never recursively invokes query evaluation or duplicates rows.
- Reaching `A` through two paths does not combine authority grants.

## Writes

Renaming or reordering `a-tiger` commits one transaction to source `A` and keeps
entry identity. Reordering an explicit order field is an ordinary edit; changing
parents uses the declared move capability. Changing the URL is a field edit,
not rekey.

Creating a new Automerge document and linking it into `A` is a shell workflow:
create source, then commit the folder entry. Failure after creation exposes an
`SourceLifecycleReceipt` plus a partial `SequenceReceipt` naming the orphan; no
fake cross-document rollback occurs.

## Required Ghostscript Tiger test

The Patchpit end-to-end case MUST prove:

- a folder can contain both `automerge:` and direct `https:` sources;
- the Tiger bytes are fetched/rendered without opening an Automerge handle;
- URL, bytes, and folder metadata remain separate;
- offline/cache failure leaves the folder entry queryable with explicit resource
  state;
- no schema or executable binding is inferred from the HTTPS link;
- moving/reordering the entry preserves its stable entry ID.
