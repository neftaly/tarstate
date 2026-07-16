# @tarstate/automerge

The Automerge source and storage bindings for Tarstate v1.

This package depends on `@tarstate/core` and reports adapter-specific
projection and conflict guarantees through portable receipts and capabilities.

The package root exposes one standard attachment API. Low-level Automerge value
adoption is available without loading the adapter runtime from
`@tarstate/automerge/values`.

Install both Tarstate tarballs and the Automerge package imported by application
code:

```sh
npm install \
  ./tarstate-core-0.4.0.tgz \
  ./tarstate-automerge-0.4.0.tgz \
  @automerge/automerge
```

## Usage

This is the normal writable application path. Consumers do not choose between
prepared, owned, staged, or fast variants; the attachment optimizes and replays
this one operation API internally.

```ts
import { openAutomergeAttachment } from '@tarstate/automerge';

type TaskDoc = {
  readonly tasks: Readonly<Record<string, { readonly id: string; readonly title: string }>>;
  readonly tarstate: {
    readonly declaration: unknown;
    readonly artifacts: Readonly<Record<string, unknown>>;
  };
};

// `handle` is an already-ready, writable Automerge Repo handle. The declaration
// references schema and storage-mapping artifacts embedded in the same document.
const document = handle.doc() as TaskDoc;
const opened = await openAutomergeAttachment({
  handle,
  declaration: document.tarstate.declaration,
  embeddedArtifacts: document.tarstate.artifacts,
  authorityScope: 'workspace'
});
if (!opened.success) throw new Error(opened.issues.map(({ code }) => code).join(', '));

const unsubscribe = opened.value.subscribe(() => {
  const snapshot = opened.value.getSnapshot();
  if (snapshot.state === 'open' && snapshot.current.readiness === 'ready') {
    renderTasks(snapshot.current.rows);
  }
});

const operation = { kind: 'rename-task', id: 'first', title: 'Renamed' } as const;
const receipt = await opened.value.transact(operation, ({ rows }) => rows.map((row) =>
  row.relationId === 'tasks' && row.fields.id === operation.id
    ? { ...row, fields: { ...row.fields, title: operation.title } }
    : row
));

unsubscribe();
opened.value.close();
```

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

`getSnapshot` and `subscribe` form a synchronous external-store boundary. The
snapshot reports readiness, exactness, freshness, source lifecycle, basis, and
issues; its logical row array retains identity while the mapped projection is
unchanged. To compose the same attachment into Tarstate database observation,
mount it rather than rebuilding a prepared attachment:

```ts
import { AttachmentCatalog, DatasetMembership } from '@tarstate/core/database';

const catalog = new AttachmentCatalog();
const lease = opened.value.mount(catalog, { discoveryEdges: ['workspace'] });

const membership = new DatasetMembership({
  datasetId: 'workspace',
  state: 'settled',
  members: [{
    attachmentId: lease.attachmentId,
    sourceId: lease.sourceId,
    expectation: 'required',
    discoveryEdges: lease.discoveryEdges
  }]
});

// The trusted catalog retains the internal source. The public lease exposes
// only dataset identity and lifecycle, never the raw Automerge document.
// Closing the opened attachment also releases every lease it created.
lease.close();
```

Multiplayer changes are ordinary input to this loop. Each candidate is staged
on an Automerge clone; if another player's heads arrive before publication, the
callback runs again against the newly merged snapshot. Disjoint remote work is
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
valid candidate, expected transaction failures resolve as receipts. In
particular, a callback failure during multiplayer replay becomes a rejected
receipt so no reserved operation is left pending.

## Automerge Repo compatibility

The Repo integration consumes a small structural handle interface; this package
does not depend on or re-export `@automerge/automerge-repo`. Applications may
therefore use either the stable Repo release or its latest `next` prerelease
without installing a second Repo copy. The adapter accepts compatible Automerge
3.x releases so Repo and Tarstate can share one Automerge installation. CI runs
the integration suite against the locked stable release and a separate `next`
compatibility lane.

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
