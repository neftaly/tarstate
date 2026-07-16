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
  ./tarstate-core-0.3.0.tgz \
  ./tarstate-automerge-0.3.0.tgz \
  @automerge/automerge
```

## Usage

```ts
import { openAutomergeAttachment } from '@tarstate/automerge';

type TaskDoc = {
  readonly tasks: Readonly<Record<string, { readonly id: string; readonly title: string }>>;
  readonly tarstate: {
    readonly declaration: unknown;
    readonly artifacts: readonly unknown[];
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

const operation = { kind: 'rename-task', id: 'first', title: 'Renamed' } as const;
const receipt = await opened.value.transact(operation, ({ rows }) => rows.map((row) =>
  row.relationId === 'tasks' && row.fields.id === operation.id
    ? { ...row, fields: { ...row.fields, title: operation.title } }
    : row
));

opened.value.close();
```

The callback is pure and may run again after a concurrent document change.
Tarstate derives keyed deltas from the prepared schema, re-projects and checks
constraints, and publishes only the validated candidate. Automerge heads,
changes, bindings, execution contexts, and canonical keys remain private. Use
`opened.value.simulate` with the same arguments for a non-mutating preview.

Multiplayer changes are ordinary input to this loop. Each candidate is staged
on an Automerge clone; if another player's heads arrive before publication, the
callback runs again against the newly merged snapshot. Disjoint remote work is
preserved, while conflicts already present in mapped data remain explicit
projection evidence rather than being selected or JSON-round-tripped away.

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
