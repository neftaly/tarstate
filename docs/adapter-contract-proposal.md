# Adapter Runtime Contract

Tarstate treats durable documents, ephemeral presence, local memory, and future
Immer-backed state as relation runtimes. The shared boundary stays host-agnostic:

- `RelationSource` is the read-only row surface: `rows`, optional `lookup`,
  optional `rangeLookup`, optional opaque `version`, and diagnostics.
- `RelationPatchTarget` is the generic write target: `apply(WritePatch[])`
  returns `accepted`, `partial`, or `rejected`.
- `RelationRuntime` combines a `source`, optional `target`, optional
  read-consistent `snapshot()`, and optional invalidation `subscribe()`.
- `RelationAdapter` remains the durable compatibility shape: a runtime with
  legacy `commit(WritePatch[])` semantics. Durable adapters may also expose
  `target.apply` as the generic runtime facade over the same commit path.

This keeps the data shape generic. Automerge documents, Automerge Repo
Presence, and Immer stores do not need special query concepts; they expose rows,
versions, diagnostics, and optional patch application.

## Composition

Read composition uses `composeSources`.

```ts
const source = composeSources(durable.source, presence.source)
```

Write-capable composition uses `composeRelationRuntimes`. It composes sources
and routes each patch to the single target whose source declares ownership of
that relation in `relationNames`.

```ts
const runtime = composeRelationRuntimes(durableRuntime, presenceRuntime)
```

A composed runtime is still one data source to queries and React stores. Durable
document rows and ephemeral presence rows can participate in the same query, and
writes still use ordinary relation-scoped patches:

```ts
const object = as(schema.objects, 'object')
const cursor = as(schema.presence, 'cursor')

const focusedObjects = pipe(
  from(object),
  leftJoin(from(cursor), eq(object.id, cursor.targetObjectId)),
  project({
    id: object.id,
    title: object.title,
    focusedBy: maybe(cursor.peerId),
  }),
  keyBy('id')
)

const rows = await evaluate(runtime.source, focusedObjects)

await tryApplyRelationPatches(runtime, [
  write(schema.objects).upsert({ id: 'object-a', title: 'Proposal' }),
  write(schema.presence).upsert({
    peerId: 'peer-a',
    channel: 'selection',
    targetObjectId: 'object-a',
  }),
])
```

If ownership is ambiguous, the composed target rejects the batch before applying
anything. If a single target has unknown `relationNames`, it owns all writes.
After routing succeeds, each child target owns its own atomicity policy; a
multi-target batch can therefore report `partial` if an earlier target reflects
effects and a later target rejects.

## Presence

Automerge Repo Presence is exposed as a separate `RelationRuntime`, not part of
the durable Automerge map adapter.

- Presence rows are ordinary relation rows and can join with document rows.
- The current runtime exposes one row per peer/channel, with configurable field
  names for peer id, channel, value, timestamps, and the local marker.
- Local presence updates are modeled as `insert`, `upsert`, `delete`, or
  `replaceAll` patches over an ephemeral relation.
- The Automerge Repo Presence API does not expose a delete-channel command. This
  runtime maps cleared channels to `broadcast(channel, undefined)` by default
  and materializes cleared channels as absent rows. Callers can provide a
  runtime-local `isClearedValue` predicate if their presence channel protocol
  uses another sentinel; this is adapter behavior, not common schema behavior.
- Presence versions should be endpoint-local, such as a peer id plus monotonic
  local revision. Do not reuse durable Automerge heads.
- Remote presence changes should call `subscribe` listeners so React stores
  refresh and queries re-run.
- A presence target should return `durability: 'ephemeral'` on apply results.

Native presence commands can be added later if needed, but the first adapter can
stay on Tarstate `WritePatch[]` so docs, presence, and local runtimes share the
same write path.

## Memory Runtime

`createMemoryRelationRuntime` in `@tarstate/core/memory-runtime` is a small
non-durable runtime for tests, local state, and adapter prototyping.

- It uses the same `RelationRuntime` shape as durable and presence adapters.
- It applies normal `WritePatch[]` batches with object-backed write validation.
- It reports `durability: 'memory'` and increments its numeric version only
  when accepted writes change relation rows.
- If created with known relation names, it rejects writes for relations it does
  not own. If created empty without declared names, it remains dynamic.

## Automerge Map Adapter

The current map adapter stays durable and compatibility-oriented:

- It exposes `RelationAdapter<Automerge.Heads>`.
- It exposes `target.apply` by bridging its durable `commit` result into
  relation-runtime apply semantics, with `durability: 'durable'`.
- Its `source` filters invalid stored rows from reads and reports diagnostics.
- Its `commit` rejects writes touching relations that already contain invalid
  stored rows.
- It does not import Automerge Repo or Presence APIs.

The Repo Presence runtime lives beside it in
`packages/automerge/src/presence.ts` and is exported from `index.ts`.
