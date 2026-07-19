# @tarstate/automerge

The Automerge source and storage bindings for Tarstate v1.

This package depends on `@tarstate/core` and reports adapter-specific
projection and conflict guarantees through portable receipts and capabilities.

The package root exposes one standard database API. Low-level Automerge value
adoption is available without loading the adapter runtime from
`@tarstate/automerge/values`. Exact-basis document materialization is available
from the equally focused `@tarstate/automerge/view` topic. Source creation with
Automerge Repo lifecycle receipts is an optional
`@tarstate/automerge/repo-lifecycle` topic.

Install both Tarstate tarballs and the Automerge package imported by application
code:

```sh
npm install \
  ./tarstate-core-0.6.9.tgz \
  ./tarstate-automerge-0.6.9.tgz \
  @automerge/automerge
```

## Usage

This is the normal writable application path. Consumers do not choose between
prepared, owned, staged, or fast variants; the database optimizes and replays
this one operation API internally.

```ts
import {
  mappedRelationRows,
  openAutomergeDatabase
} from '@tarstate/automerge';
import { viewAutomergeDocumentAtBasis } from '@tarstate/automerge/view';
import { relationLiteral, sealSchema } from '@tarstate/core/schema';

type TaskDoc = {
  readonly tasks: Readonly<Record<string, { readonly id: string; readonly title: string }>>;
  readonly tarstate: {
    readonly declaration: unknown;
    readonly artifacts: Readonly<Record<string, unknown>>;
  };
};

// This is the same schema artifact embedded in the document. Sealing the same
// ID and body produces the same exact reference while retaining row inference.
const taskSchema = await sealSchema({
  id: 'example.tasks@1',
  body: { relations: { tasks: {
    relationId: 'tasks',
    key: ['id'],
    fields: {
      id: { type: { kind: 'string' } },
      title: { type: { kind: 'string' } }
    }
  } } }
});
const tasks = relationLiteral(taskSchema, 'tasks');

// `handle` is an already-ready, writable Automerge Repo handle. The declaration
// references schema and storage-mapping artifacts embedded in the same document.
const document = handle.doc() as TaskDoc;
const opened = await openAutomergeDatabase({
  handle,
  declaration: document.tarstate.declaration,
  embeddedArtifacts: document.tarstate.artifacts,
  authorityScope: 'workspace'
});
if (!opened.success) throw new Error(opened.issues.map(({ code }) => code).join(', '));

// These immutable identities exactly match later mount leases and receipts.
const { sourceId, attachmentId } = opened.value;

// Prepared mapping facts let the UI distinguish writable fields without
// reading or duplicating the storage-mapping artifact.
const taskCapabilities = opened.value.capabilities(tasks);
// `taskCapabilities.fields.title` describes the operations this concrete
// schema + mapping + Automerge source can execute.

const unsubscribe = opened.value.subscribe(() => {
  const snapshot = opened.value.getSnapshot();
  if (snapshot.state === 'open' && snapshot.current.readiness === 'ready') {
    renderTasks(mappedRelationRows(snapshot.current, tasks));
  }
});

const operation = { kind: 'rename-task', id: 'first', title: 'Renamed' } as const;
const receipt = await opened.value.transact(operation, (snapshot) =>
  snapshot.withRows(
    tasks,
    snapshot.rows(tasks).map((row) => row.id === operation.id
      ? { ...row, title: operation.title }
      : row)
  )
);

// Position-sensitive text intent names the basis the user actually observed.
const visible = opened.value.getSnapshot();
if (visible.state === 'open' && visible.current.readiness === 'ready') {
  await opened.value.transact(
    { kind: 'prefix-task-title', id: 'first' },
    (snapshot) => snapshot.spliceText(
      tasks,
      ['first'],
      'title',
      { index: 0, deleteCount: 0, insert: 'New ' }
    ),
    { observedBasis: visible.current.basis }
  );

  // Each publish is atomic. A later offset may depend on an earlier local
  // splice even when that earlier prefix is already publishing.
  const openedText = await opened.value.openTextIntent({
    observedBasis: visible.current.basis
  });
  if (openedText.success) {
    const text = openedText.value;
    text.append({ kind: 'insert-prefix' }, (snapshot) => snapshot.spliceText(
      tasks,
      ['first'],
      'title',
      { index: 0, deleteCount: 0, insert: 'Draft: ' }
    ));
    text.append({ kind: 'edit-inserted-prefix' }, (snapshot) => snapshot.spliceText(
      tasks,
      ['first'],
      'title',
      { index: 0, deleteCount: 5, insert: 'Ready' }
    ));
    const prefix = text.publish();
    text.append({ kind: 'suffix-after-prefix' }, (snapshot) => snapshot.spliceText(
      tasks,
      ['first'],
      'title',
      { index: 6, deleteCount: 0, insert: '!' }
    ));
    await prefix;
    const focus = text.captureTextPosition({
      name: 'selection-focus',
      relation: tasks,
      key: ['first'],
      field: 'title',
      index: 7,
      affinity: 'after'
    });
    const suffix = await text.publish({ textPositions: [focus] });
    const resolvedFocus = suffix.textPositions[0];
    if (resolvedFocus?.state === 'resolved') {
      const viewed = viewAutomergeDocumentAtBasis(
        handle.doc(),
        resolvedFocus.basis
      );
      if (viewed.success) {
        // Create product-owned native presence against this exact document.
        void { document: viewed.value, index: resolvedFocus.index };
      }
    }
    text.close();
  }
}

unsubscribe();
opened.value.close();
```

`mappedRelationRows` verifies the snapshot's exact schema view, preserves the
generated row type and projected row identities, and reuses its readonly array
for repeated selection from the same immutable result.

The callback is pure and may run again after a concurrent document change.
Tarstate derives keyed deltas from the prepared schema, re-projects and checks
constraints, and publishes only the validated candidate. Automerge heads,
changes, bindings, execution contexts, and canonical keys remain private. Use
`opened.value.simulate` with the same arguments for a non-mutating preview.
Constraint-set artifacts run against this same logical row projection; hosts do
not install a second constraint-query callback. Embedded artifacts may be an
array or a record keyed by exact artifact ID. A keyed record rejects entries
whose embedded `id` disagrees with its key. The standard constraint evaluator
uses a deterministic work budget; exhausting it makes the constraint result
indeterminate and prevents publication.

`openTextIntent` is a causal publication session, not a hidden editor or
writer. Each `append` is synchronous and pure, updates only the session's
optimistic snapshot, and produces pending or rejected segment evidence.
`publish` atomically captures the currently pending prefix. Appends made while
that prefix is publishing form its causal suffix and remain unpublished until
the next `publish`. A known commit advances the retained private branch; a
rejected ancestor rejects its descendants, while an unknown ancestor outcome
suspends them. Pending-work and recent-evidence budgets bound retained memory.
The owner must call `close`.

`captureTextPosition` is typed by the prepared relation and belongs to the
session's exact current optimistic snapshot. Pass captured requests only to the
next `publish`; accepting another segment first makes them stale. Automerge
cursors remain adapter-private. Results expose detached UTF-16 offsets at the
receipt's exact committed basis, or explicit non-resolution evidence. Affinity
controls movement after referenced-character deletion; start/end sentinel
positions can coincide at an empty string boundary.

`viewAutomergeDocumentAtBasis(document, basis)` is the pure host-side bridge
from detached exact-basis evidence back to an immutable Automerge view. It
strictly adopts canonical unique heads and fails explicitly when the document
is unavailable or no longer contains the requested history. It never writes,
fetches, merges, subscribes, or transfers handle ownership. Native documents
and cursors remain host-local and must not cross portable application
boundaries.

A document whose root is one logical entity needs no artificial array or
object-map wrapper. Its storage mapping uses an explicit singleton and literal
logical key:

```ts
{
  collection: { kind: 'singleton', path: [], absent: 'invalid' },
  keys: { id: { kind: 'literal', value: 'content' } },
  fields: {
    content: {
      path: ['content'],
      write: { replace: builtInCapabilityRefs.fieldReplace }
    }
  }
}
```

Mapped Automerge `Uint8Array` fields cross the adapter's standard scalar
boundary as canonical Tarstate `bytes` values and are written back as native
bytes. Consumers that need native bytes use the shared core
`safeMaterializePortableBytes` helper from `@tarstate/core/values` rather than
decoding the tagged value themselves. Root-field replacement preserves
unrelated namespaced metadata.
Automerge `ImmutableString` fields declared as logical strings cross the same
boundary as ordinary strings. A read-only mapping can therefore query foreign
immutable text without upgrading its write capability or exposing an
Automerge-specific logical type. If a mapping deliberately enables replacement,
the replacement is written as an ordinary Automerge string.

Array mappings may expose current order and stable Automerge element identity
without adding properties to a foreign document:

```ts
{
  collection: { kind: 'array', path: ['docs'], absent: 'empty' },
  keys: {
    occurrenceId: {
      kind: 'source-metadata',
      value: 'collection-element-identity'
    }
  },
  fields: {
    order: { kind: 'source-metadata', value: 'collection-position' },
    name: { path: ['name'], write: {} }
  }
}
```

Portable JSON projection can derive collection position but reports source
identity as unavailable unless its adapter supplies one. Source metadata is
read-only, and collection position cannot be used as a logical key. When every
key field uses `collection-element-identity`, queue insertion through the same
transaction callback without fabricating an Automerge object ID:

```ts
const intent = { kind: 'add-doc', token: 'new-doc', name: 'Notes' } as const;
const receipt = await opened.value.transact(intent, (snapshot) =>
  snapshot.insertWithGeneratedKey(docs, intent.token, { name: intent.name })
);

if (receipt.outcome === 'committed') {
  const inserted = receipt.generatedKeys?.find(({ token }) => token === intent.token);
  // inserted?.key is the committed logical key tuple.
}
```

The token is operation-local application intent and must remain stable if the
callback is replayed. Source-generated fields such as identity and position are
omitted from the supplied fields. Only a committed receipt returns their final
token-to-key association; simulation creates no durable identity. Arrays with
an explicit stored key continue to use `withRows` for ordinary append
insertion, field edits, and deletion. Tarstate does not advertise
identity-preserving reorder because Automerge has no native object move;
changing only the row array passed to `withRows` remains a relational no-op.

`getSnapshot` and `subscribe` form a synchronous external-store boundary. The
snapshot reports readiness, exactness, freshness, source lifecycle, basis, and
issues; its logical row array retains identity while the mapped projection is
unchanged. To query the same database through Tarstate's incremental observer,
mount it as a source rather than rebuilding adapter machinery:

```ts
import { openDatabaseQuery } from '@tarstate/core/database/session';

const session = await openDatabaseQuery({
  sources: [{
    source: opened.value,
    discoveryEdges: ['workspace']
  }],
  plan,
  queryAuthorityScope: 'workspace'
});

// One idempotent close releases the observer, database, membership, and mount.
session.close();
```

Plans created with `prepareQuery` also bound storage projection to the relations
and fields the query actually reads when that can be proven safely. A query for
a file title therefore does not decode an unselected binary content field, and
a content-only change can retain the title projection. This is automatic: the
ordinary query API remains the only path. Full database snapshots, transactions,
constraints, and query shapes whose dependencies are ambiguous still project
the complete mapped state.

Multiplayer changes are ordinary input to this loop. Replayable row transforms
run again against a newer logical snapshot when needed. Position-sensitive
text edits instead extend one private Automerge branch from their observed
basis. Each publication merges the next causal prefix with current heads,
re-projects and validates the exact candidate, then conditionally publishes it.
Disjoint remote work is
preserved, while conflicts already present in mapped data remain explicit
projection evidence rather than being selected or JSON-round-tripped away.
Required constraints are also evaluated for live and remotely received states,
not only locally authored candidates. A violation makes snapshot readiness
`invalid` and makes a required database projection unavailable; audit
violations remain warnings. Final-state transactions may still repair an
invalid document, while invalid candidates remain unpublished.

Opening returns a `ParseResult`; malformed declarations and embedded artifacts
produce an unsuccessful result. Invalid transaction intent or an initial
callback failure rejects that transaction call. Once execution has reserved a
valid candidate, expected transaction failures resolve as receipts. A valid
logical edit that the prepared mapping cannot represent also resolves as a
rejected simulation or commit receipt; use `capabilities(relation)` to
avoid offering known read-only edits. In particular, a callback failure during
multiplayer replay becomes a rejected receipt so no reserved operation is left
pending.

## Automerge Repo compatibility

The ordinary database integration consumes a small structural handle interface
and does not load or re-export `@automerge/automerge-repo`. Applications may
therefore keep their existing compatible Repo installation.

Hosts that create documents through Tarstate can opt into the Repo lifecycle
topic:

```ts
import * as Automerge from '@automerge/automerge';
import { SourceLifecycleCoordinator } from '@tarstate/core/transactions';
import { toPortableBytes } from '@tarstate/core/values';
import { createAutomergeRepoLifecycleAdapter } from '@tarstate/automerge/repo-lifecycle';

const lifecycle = new SourceLifecycleCoordinator({
  lifecycleCoordinatorId: 'workspace-documents',
  operationEpoch,
  authorityViewFingerprint,
  authorize,
  adapter: createAutomergeRepoLifecycleAdapter({ repo, sourceCapability })
});

const receipt = await lifecycle.execute({
  lifecycleCoordinatorId: 'workspace-documents',
  operationEpoch,
  operationId,
  request: {
    action: 'create',
    sourceCapability,
    input: toPortableBytes(Automerge.save(detachedDocument))
  }
});
```

The topic requires compatible `@automerge/automerge-repo` 2.5.6–2.x APIs. It
preallocates an Automerge URL without Repo mutation, imports exact history under
that ID, returns no raw handle, and truthfully claims only process-memory
durability. Repeating the same known lifecycle operation returns its original
receipt. Deletion and experimental Repo persistence APIs remain unsupported.

System-relation events record observations without inferring stronger network
facts. In particular, `remote-heads-observed` produces sync state `observed`,
not `synced`; the host must supply an explicit `sync-state` event for lifecycle
claims. Contradictory facts with the same `observedAt` are rejected rather than
resolved by arrival order.

## Replaying fuzz failures

The Automerge model properties use `fast-check` shrinking and independent
per-property seeds. A failure reports a seed and path that can be replayed
without running the other properties:

```sh
TARSTATE_FUZZ_PROPERTY=commands-replays-stale-bases-and-epoch-retirement-follow-the-model \
TARSTATE_FUZZ_SEED=<reported-seed> TARSTATE_FUZZ_PATH=<reported-path> \
pnpm --filter @tarstate/automerge test:fuzz
```

Set `TARSTATE_FUZZ_RUNS` to increase the normal run count. The model suite
covers non-empty map, list, text, and counter edits; current and stale bases;
operation replay and ambiguity; epoch retirement; notifications; and document
save/load with an intentionally process-local operation ledger.
