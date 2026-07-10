# Source transaction spike evidence

Status: executable evidence, 2026-07-10.

`InMemorySpikeSource` is an isolated implementation of the source-coordinator
sequence. Its conformance fixture is
`packages/core/tests/v1-transaction-spike.test.ts`.

The fixture proves:

- two bindings with overlapping write footprints produce one merged source
  command, one basis advance, and one notification;
- simulation produces the staged storage without mutation or reserving an
  operation ID;
- statements observe prior statements while hard constraints inspect only the
  final reprojected state;
- exact stale bases reject before planning;
- `(operationEpoch, operationId)` retries return the original receipt and a
  different intent rejects as `transaction.operation_id_ambiguous`;
- unknown containment evidence and incompatible overlapping intents reject;
- source-local guard validation rejects a foreign relation before mutation;
  and
- logical no-ops retain the basis and emit no notification.

No normative contradiction was found. The source uses volatile receipt
deduplication and therefore reports only `durability: memory`.
