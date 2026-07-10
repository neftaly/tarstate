# @tarstate/automerge

The Automerge source and storage bindings for Tarstate v1.

This package depends on `@tarstate/core` and reports adapter-specific
projection and conflict guarantees through portable receipts and capabilities.

`AutomergeMapProjectionPlanner` is the pure map projection/edit-planning
kernel. `AutomergeMapStorageBinding` adapts that kernel to core's
`StorageBinding` protocol, and `AutomergeAtomicSource` is the atomic source
shell.

System-relation events record observations without inferring stronger network
facts. In particular, `remote-heads-observed` produces sync state `observed`,
not `synced`; the host must supply an explicit `sync-state` event for lifecycle
claims. Contradictory facts with the same `observedAt` are rejected rather than
resolved by arrival order.
