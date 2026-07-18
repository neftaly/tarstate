import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { builtInCapabilityRefs } from '../packages/core/dist/capabilities/index.js';
import { relationLiteral, sealSchema, sealStorageMapping } from '../packages/core/dist/schema/index.js';
import { openAutomergeDatabase } from '../packages/automerge/dist/index.js';

const requireFromAutomerge = createRequire(new URL('../packages/automerge/package.json', import.meta.url));
const { Repo } = await import(pathToFileURL(requireFromAutomerge.resolve('@automerge/automerge-repo')).href);
const rowCount = 100;
const sampleCount = 5;
const warmupIterations = 10;
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
      title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } }
    }
  } }
} });
const tasks = relationLiteral(schema, 'tasks');
const measure = async (changed) => {
  const samples = [];
  const correctnessFailures = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const runtime = await openBenchmarkRuntime();
    try {
      for (let index = 0; index < warmupIterations; index += 1) await runtime.transact(changed);
      globalThis.gc();
      const started = performance.now();
      for (let index = 0; index < iterations; index += 1) await runtime.transact(changed);
      samples.push((performance.now() - started) / iterations);
      const expectedTitle = changed ? 'Changed ' + (runtime.sequence() - 1) : 'Title 0';
      if (runtime.title() !== expectedTitle) correctnessFailures.push('sample-' + sample);
    } finally {
      await runtime.close();
    }
  }
  samples.sort((left, right) => left - right);
  return {
    milliseconds: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    correctnessFailures
  };
};

const noOp = await measure(false);
const oneRow = await measure(true);
const contracts = {
  independentRepeatedSamples: sampleCount >= 5,
  exactCommitSemantics: noOp.correctnessFailures.length === 0 && oneRow.correctnessFailures.length === 0,
  noOp100RowsCeiling: noOp.milliseconds <= 20,
  oneRow100RowsCeiling: oneRow.milliseconds <= 30
};
const report = {
  benchmark: 'tarstate-public-automerge-database-transactions',
  note: 'End-to-end public database calls include intent hashing, projection, exact-delta authoring, staging, validation, ledger completion, and Repo publication.',
  contracts,
  measurements: {
    inputRows: rowCount,
    iterations,
    sampleCount,
    warmupIterations,
    noOpMillisecondsPerTransaction: noOp.milliseconds,
    oneRowMillisecondsPerTransaction: oneRow.milliseconds,
    correctnessFailures: [...noOp.correctnessFailures, ...oneRow.correctnessFailures]
  },
  node: process.version
};
console.log(JSON.stringify(report, null, 2));
if (Object.values(contracts).some((passed) => !passed)) {
  console.error('Transaction performance contracts failed: ' + Object.entries(contracts).filter(([, passed]) => !passed).map(([name]) => name).join(', '));
  process.exitCode = 1;
}

function reference(artifact) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}

async function openBenchmarkRuntime() {
  const repo = new Repo();
  const handle = repo.create({
    tasks: Object.fromEntries(Array.from({ length: rowCount }, (_, index) => [
      'task-' + index,
      { id: 'task-' + index, title: 'Title ' + index }
    ]))
  });
  const opened = await openAutomergeDatabase({
    handle,
    declaration: {
      formatVersion: 1,
      storageSchema: reference(schema),
      projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
    },
    embeddedArtifacts: [schema, mapping],
    authorityScope: 'tarstate:transaction-benchmark'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error('Transaction benchmark attachment failed: ' + opened.issues.map(({ code }) => code).join(', '));
  }
  const database = opened.value;
  let sequence = 0;
  return {
    transact: async (changed) => {
      const current = sequence;
      sequence += 1;
      const receipt = await database.transact(
        { kind: changed ? 'replace-title' : 'no-op', sequence: current },
        (snapshot) => changed
          ? snapshot.withRows(
              tasks,
              snapshot.rows(tasks).map((row) => row.id === 'task-0'
                ? { ...row, title: 'Changed ' + current }
                : row)
            )
          : snapshot
      );
      if (receipt.outcome !== 'committed') {
        throw new Error('Transaction benchmark rejected: ' + receipt.issues.map(({ code }) => code).join(', '));
      }
    },
    sequence: () => sequence,
    title: () => handle.doc()?.tasks['task-0']?.title,
    close: async () => {
      database.close();
      await repo.shutdown();
    }
  };
}
