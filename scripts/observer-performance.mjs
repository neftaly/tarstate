import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import {
  AttachmentCatalog,
  DatabaseView,
  DatasetMembership,
  createIncrementalDatabaseQueryMaintenance,
  prepareManualReadOnlyAttachment,
  prepareQuery
} from '../packages/core/dist/index.js';

const schemaView = { id: 'urn:tarstate:observer-benchmark:schema', contentHash: 'sha256:' + 'a'.repeat(64) };
const relation = { schemaView, relationId: 'benchmark.rows' };
const rows = (count, changed = false) => Array.from({ length: count }, (_, id) => ({
  id,
  active: id % 2 === 0,
  payload: { label: 'row-' + id, values: [id, id + 1, id === 0 && changed ? 1 : 0] }
}));

class BenchmarkSource {
  sourceId = 'source:observer-benchmark';
  operationEpoch = 'epoch:observer-benchmark';
  #revision = 0;
  #rows;
  #listeners = new Set();
  constructor(initialRows) { this.#rows = initialRows; }
  snapshot() {
    return {
      sourceId: this.sourceId,
      operationEpoch: this.operationEpoch,
      basis: { incarnation: 'observer-benchmark', revision: this.#revision },
      state: 'ready', freshness: 'current', storage: { rows: this.#rows }, issues: []
    };
  }
  subscribe(listener) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  publish(nextRows) {
    this.#rows = nextRows;
    this.#revision += 1;
    for (const listener of Array.from(this.#listeners)) listener();
  }
}

const openObserver = async (count) => {
  const source = new BenchmarkSource(rows(count));
  const catalog = new AttachmentCatalog();
  const attachmentId = 'attachment:observer-benchmark';
  const attachment = catalog.attach({
    attachmentId,
    incarnation: 'attachment:observer-benchmark:one',
    sourceId: source.sourceId,
    source,
    authorityScope: 'public',
    discoveryEdges: ['benchmark'],
    preparation: prepareManualReadOnlyAttachment({
      schemaViewIds: [schemaView.id],
      project: (snapshot) => ({
        state: 'ready', issues: [], value: [{
          relation,
          rows: snapshot.storage.rows,
          occurrenceIds: snapshot.storage.rows.map(({ id }) => 'row:' + id),
          completeness: 'exact',
          sourceId: source.sourceId,
          attachmentId,
          basis: snapshot.basis
        }]
      })
    })
  });
  const dataset = new DatasetMembership({
    datasetId: 'dataset:observer-benchmark', state: 'settled',
    members: [{ attachmentId, sourceId: source.sourceId, expectation: 'required', discoveryEdges: ['benchmark'] }]
  });
  const plan = await prepareQuery({
    root: {
      kind: 'select', alias: 'result',
      input: {
        kind: 'where', input: { kind: 'from', relation, alias: 'row' },
        predicate: { kind: 'field', alias: 'row', name: 'active' }
      },
      fields: { id: { kind: 'field', alias: 'row', name: 'id' }, payload: { kind: 'field', alias: 'row', name: 'payload' } }
    },
    registryFingerprint: 'registry:observer-benchmark',
    authorityFingerprint: 'authority:observer-benchmark',
    datasetId: dataset.datasetId
  });
  const database = new DatabaseView({
    authorityScope: 'public',
    authorityFingerprint: 'authority:observer-benchmark',
    registryFingerprint: 'registry:observer-benchmark',
    attachments: catalog,
    datasets: [dataset],
    canRead: () => true,
    createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
  });
  const observer = database.observe({ plan });
  let notifications = 0;
  let previousPayloadValue = 0;
  const correctnessFailures = [];
  const unsubscribe = observer.subscribe((change) => {
    notifications += 1;
    if (change.kind !== 'diff' || change.snapshot.state !== 'open') {
      correctnessFailures.push('non-diff-publication');
      return;
    }
    const currentPayload = change.snapshot.current.rows[0]?.payload?.values?.[2];
    if (change.diff.added.length !== 0 || change.diff.removed.length !== 0) correctnessFailures.push('unexpected-membership-diff');
    if (currentPayload === previousPayloadValue) {
      if (change.diff.updated.length !== 0) correctnessFailures.push('unexpected-noop-update');
    } else {
      const updated = change.diff.updated[0];
      if (
        change.diff.updated.length !== 1
        || updated?.key !== change.snapshot.current.resultKeys[0]
        || updated.before.payload.values[2] !== previousPayloadValue
        || updated.after.payload.values[2] !== currentPayload
      ) correctnessFailures.push('incorrect-exact-update');
    }
    previousPayloadValue = currentPayload;
  });
  return {
    source,
    observer,
    notifications: () => notifications,
    correctnessFailures: () => correctnessFailures,
    close: () => { unsubscribe(); observer.close(); database.close(); attachment.close(); }
  };
};

let consumedRows = 0;
const measure = async (count, iterations) => {
  const runtime = await openObserver(count);
  const before = rows(count);
  const after = rows(count, true);
  for (let index = 0; index < 5; index += 1) runtime.source.publish(index % 2 === 0 ? after : before);
  const samples = [];
  for (let sample = 0; sample < 3; sample += 1) {
    globalThis.gc();
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      runtime.source.publish(index % 2 === 0 ? after : before);
      const snapshot = runtime.observer.getSnapshot();
      consumedRows += snapshot.state === 'open' ? snapshot.current.rows.length : 0;
    }
    samples.push((performance.now() - started) / iterations);
  }
  samples.sort((left, right) => left - right);
  const result = {
    inputRows: count,
    iterations,
    sampleCount: 3,
    millisecondsPerOperation: Number(samples[1].toFixed(3)),
    notifications: runtime.notifications(),
    expectedNotifications: 5 + samples.length * iterations,
    correctnessFailures: runtime.correctnessFailures()
  };
  runtime.close();
  return result;
};

const post = (session, method, parameters = {}) => new Promise((resolve, reject) => session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
const allocationRuntime = await openObserver(1_000);
const allocationBefore = rows(1_000);
const allocationAfter = rows(1_000, true);
const allocationSession = new inspector.Session();
allocationSession.connect();
await post(allocationSession, 'HeapProfiler.enable');
await post(allocationSession, 'HeapProfiler.startSampling', { samplingInterval: 1_024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (let index = 0; index < 100; index += 1) allocationRuntime.source.publish(index % 2 === 0 ? allocationAfter : allocationBefore);
const { profile } = await post(allocationSession, 'HeapProfiler.stopSampling');
allocationSession.disconnect();
const sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
const nodesById = new Map();
const visitProfile = (node) => { nodesById.set(node.id, node); for (const child of node.children ?? []) visitProfile(child); };
visitProfile(profile.head);
const allocationByFrame = new Map();
for (const sample of profile.samples) {
  const frame = nodesById.get(sample.nodeId)?.callFrame;
  const key = frame === undefined ? 'unknown' : `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
  allocationByFrame.set(key, (allocationByFrame.get(key) ?? 0) + sample.size);
}
const allocationHotspots = [...allocationByFrame].sort(([, left], [, right]) => right - left).slice(0, 8).map(([frame, bytes]) => ({ frame, bytes }));
allocationRuntime.close();

const measurements = [await measure(1_000, 100), await measure(10_000, 20)];
const tenThousand = measurements.find(({ inputRows }) => inputRows === 10_000);
const sampledBytesPerUpdate = Math.round(sampledBytes / 100);
const contracts = {
  repeatedSamples: measurements.every(({ sampleCount }) => sampleCount === 3),
  exactPublicationSemantics: measurements.every(({ notifications, expectedNotifications, correctnessFailures }) =>
    notifications === expectedNotifications && correctnessFailures.length === 0),
  observerOneRow10kCeiling: tenThousand !== undefined && tenThousand.millisecondsPerOperation <= 12,
  observerAllocationCeiling: sampledBytesPerUpdate <= 1_250_000
};
const failures = Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name);
process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-observer-publication',
  note: 'Synchronous end-to-end source publication through capture, maintenance, immutable observer snapshot, exact diff, and listener notification.',
  contracts,
  measurements,
  allocationSample: { inputRows: 1_000, updates: 100, sampledBytes, sampledBytesPerUpdate, hotspots: allocationHotspots },
  node: process.version,
  consumedRows
}, null, 2) + '\n');
if (failures.length > 0) {
  process.stderr.write('Observer performance contracts failed: ' + failures.join(', ') + '\n');
  process.exitCode = 1;
}
