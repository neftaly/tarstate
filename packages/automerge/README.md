# @tarstate/automerge

The Automerge source and storage bindings for Tarstate v1.

This package depends on `@tarstate/core` and reports adapter-specific
projection and conflict guarantees through portable receipts and capabilities.

Install both Tarstate tarballs and the Automerge package imported by application
code:

```sh
npm install \
  ./tarstate-core-0.3.0.tgz \
  ./tarstate-automerge-0.3.0.tgz \
  @automerge/automerge
```

`AutomergeMapProjectionPlanner` is the pure map projection/edit-planning
kernel. `AutomergeMapStorageBinding` adapts that kernel to core's
`StorageBinding` protocol, and `AutomergeAtomicSource` is the atomic source
shell.

## Usage

```ts
import * as Automerge from '@automerge/automerge';
import {
  AutomergeAtomicSource,
  AutomergeMapStorageBinding,
  AutomergeSourceRuntime
} from '@tarstate/automerge';

type TaskDoc = {
  readonly tasks: Readonly<Record<string, { readonly title: string }>>;
};

const doc = Automerge.from<TaskDoc>({ tasks: { first: { title: 'First' } } });
const runtime = new AutomergeSourceRuntime({ sourceId: 'source:tasks', doc });
const source = new AutomergeAtomicSource({
  runtime,
  operationEpoch: 'session:one',
  ownsRuntime: true
});
const binding = new AutomergeMapStorageBinding({
  id: 'binding:tasks',
  relationId: 'tasks',
  collectionPath: ['tasks'],
  missingCollection: 'invalid',
  keySource: 'map-key'
});

const projection = binding.project(source.snapshot());
console.log(projection.rows.map(row => row.fields));
source.close();
```

Keep one `AutomergeSourceRuntime` per live document. Set `ownsRuntime: true` only
when closing the atomic source should also close that runtime; otherwise close
or release the runtime through its host owner.

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
