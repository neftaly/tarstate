import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { builtInCapabilityRefs } from '../packages/core/dist/capabilities/index.js';
import { sealSchema, sealStorageMapping } from '../packages/core/dist/schema/index.js';
import { openAutomergeAttachment } from '../packages/automerge/dist/index.js';

const requireFromAutomerge = createRequire(new URL('../packages/automerge/package.json', import.meta.url));
const { Repo } = await import(pathToFileURL(requireFromAutomerge.resolve('@automerge/automerge-repo')).href);
const rowCount = 100;
const sampleCount = 3;
const iterations = 30;
const schema = await sealSchema({ id: 'urn:tarstate:transaction-benchmark:schema', body: {
  relations: { tasks: {
    relationId: 'tasks',
    key: ['id'],
    fields: {
      id: { type: { kind: 'string' } },
      title: { type: { kind: 'string' } }
    }
  } }
} });
const mapping = await sealStorageMapping({ id: 'urn:tarstate:transaction-benchmark:mapping', body: {
  schema: reference(schema),
  model: 'json-tree-v1',
  relations: { tasks: {
    collection: { kind: 'object-map', path: ['tasks'], absent: 'creatable' },
    keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
    fields: {
      title: { path: ['title'], write: { kind: 'replace', capability: builtInCapabilityRefs.fieldReplace } }
    }
  } }
} });
const repo = new Repo();
const handle = repo.create({
  tasks: Object.fromEntries(Array.from({ length: rowCount }, (_, index) => [
    'task-' + index,
    { id: 'task-' + index, title: 'Title ' + index }
  ]))
});
const opened = await openAutomergeAttachment({
  handle,
  declaration: {
    formatVersion: 1,
    storageSchema: reference(schema),
    projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
  },
  embeddedArtifacts: [schema, mapping],
  authorityScope: 'tarstate:transaction-benchmark'
});
if (!opened.success) throw new Error('Transaction benchmark attachment failed: ' + opened.issues.map(({ code }) => code).join(', '));

const attachment = opened.value;
let sequence = 0;
const transact = async (changed) => {
  const current = sequence;
  sequence += 1;
  const receipt = await attachment.transact(
    { kind: changed ? 'replace-title' : 'no-op', sequence: current },
    ({ rows }) => changed
      ? rows.map((row) => row.fields.id === 'task-0'
        ? { ...row, fields: { ...row.fields, title: 'Changed ' + current } }
        : row)
      : rows
  );
  if (receipt.outcome !== 'committed') throw new Error('Transaction benchmark rejected: ' + receipt.issues.map(({ code }) => code).join(', '));
};

for (let index = 0; index < 5; index += 1) await transact(index % 2 === 0);
const measure = async (changed) => {
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) await transact(changed);
    samples.push((performance.now() - started) / iterations);
  }
  samples.sort((left, right) => left - right);
  return Number(samples[Math.floor(samples.length / 2)].toFixed(3));
};

const noOpMilliseconds = await measure(false);
const oneRowMilliseconds = await measure(true);
const finalTitle = handle.doc()?.tasks['task-0']?.title;
const contracts = {
  repeatedSamples: sampleCount >= 3,
  exactCommitSemantics: finalTitle === 'Changed ' + (sequence - 1),
  noOp100RowsCeiling: noOpMilliseconds <= 20,
  oneRow100RowsCeiling: oneRowMilliseconds <= 30
};
const report = {
  benchmark: 'tarstate-public-automerge-attachment-transactions',
  note: 'End-to-end public attachment calls include intent hashing, projection, exact-delta authoring, staging, validation, ledger completion, and Repo publication.',
  contracts,
  measurements: {
    inputRows: rowCount,
    iterations,
    sampleCount,
    noOpMillisecondsPerTransaction: noOpMilliseconds,
    oneRowMillisecondsPerTransaction: oneRowMilliseconds
  },
  node: process.version
};
console.log(JSON.stringify(report, null, 2));
attachment.close();
await repo.shutdown();
if (Object.values(contracts).some((passed) => !passed)) {
  console.error('Transaction performance contracts failed: ' + Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name).join(', '));
  process.exitCode = 1;
}

function reference(artifact) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}
