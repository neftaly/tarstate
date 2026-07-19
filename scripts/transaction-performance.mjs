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
      title: { path: ['title'], write: {
        replace: builtInCapabilityRefs.fieldReplace,
        textSplice: builtInCapabilityRefs.textSplice
      } }
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
const dependentText = await measureDependentText();
const continuedText = await measureContinuedText();
const directAutomerge = await measureDirectAutomerge();
const contracts = {
  independentRepeatedSamples: sampleCount >= 5,
  exactCommitSemantics: noOp.correctnessFailures.length === 0 && oneRow.correctnessFailures.length === 0,
  dependentTextCompositionSemantics: dependentText.correctnessFailures.length === 0,
  continuedTextCompositionSemantics: continuedText.correctnessFailures.length === 0,
  noOp100RowsCeiling: noOp.milliseconds <= 20,
  oneRow100RowsCeiling: oneRow.milliseconds <= 30,
  dependentText16SegmentsCeiling: dependentText.milliseconds <= 60,
  continuedText8Segments2PublicationsCeiling: continuedText.milliseconds <= 100
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
    dependentText16SegmentsMillisecondsPerComposition: dependentText.milliseconds,
    continuedText8Segments2PublicationsMillisecondsPerComposition: continuedText.milliseconds,
    directAutomergeOneRowMillisecondsPerChange: directAutomerge,
    correctnessFailures: [
      ...noOp.correctnessFailures,
      ...oneRow.correctnessFailures,
      ...dependentText.correctnessFailures,
      ...continuedText.correctnessFailures
    ]
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

async function measureDirectAutomerge() {
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const repo = new Repo();
    const handle = repo.create({
      tasks: Object.fromEntries(Array.from({ length: rowCount }, (_, index) => [
        'task-' + index,
        { id: 'task-' + index, title: 'Title ' + index }
      ]))
    });
    let sequence = 0;
    const change = () => {
      const current = sequence;
      sequence += 1;
      handle.change((draft) => {
        draft.tasks['task-0'].title = 'Changed ' + current;
      });
    };
    try {
      for (let index = 0; index < warmupIterations; index += 1) change();
      globalThis.gc();
      const started = performance.now();
      for (let index = 0; index < iterations; index += 1) change();
      samples.push((performance.now() - started) / iterations);
    } finally {
      await repo.shutdown();
    }
  }
  samples.sort((left, right) => left - right);
  return Number(samples[Math.floor(samples.length / 2)].toFixed(3));
}

async function measureDependentText() {
  const segments = 16;
  const textIterations = 10;
  const samples = [];
  const correctnessFailures = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const runtime = await openBenchmarkRuntime();
    try {
      await runtime.composeText(segments);
      globalThis.gc();
      const started = performance.now();
      for (let index = 0; index < textIterations; index += 1) {
        await runtime.composeText(segments);
      }
      samples.push((performance.now() - started) / textIterations);
      if (!runtime.title()?.endsWith('x'.repeat(segments * (textIterations + 1)))) {
        correctnessFailures.push('dependent-text-sample-' + sample);
      }
    } finally {
      await runtime.close();
    }
  }
  samples.sort((left, right) => left - right);
  return {
    milliseconds: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    correctnessFailures
  };
}

async function measureContinuedText() {
  const segments = 8;
  const textIterations = 5;
  const samples = [];
  const correctnessFailures = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const runtime = await openBenchmarkRuntime();
    try {
      await runtime.composeTextAcrossPublications(segments, 4);
      globalThis.gc();
      const started = performance.now();
      for (let index = 0; index < textIterations; index += 1) {
        await runtime.composeTextAcrossPublications(segments, 4);
      }
      samples.push((performance.now() - started) / textIterations);
      if (!runtime.title()?.endsWith('x'.repeat(segments * (textIterations + 1)))) {
        correctnessFailures.push('continued-text-sample-' + sample);
      }
    } finally {
      await runtime.close();
    }
  }
  samples.sort((left, right) => left - right);
  return {
    milliseconds: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    correctnessFailures
  };
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
    composeText: async (segmentCount) => {
      const visible = database.getSnapshot();
      if (visible.state !== 'open' || visible.current.readiness !== 'ready') {
        throw new Error('Transaction benchmark database is not ready');
      }
      const openedText = await database.openTextIntent({
        observedBasis: visible.current.basis
      });
      if (!openedText.success) {
        throw new Error('Text benchmark session failed: ' + openedText.issues.map(({ code }) => code).join(', '));
      }
      const text = openedText.value;
      const initialLength = handle.doc()?.tasks['task-0']?.title.length ?? 0;
      for (let index = 0; index < segmentCount; index += 1) {
        const segment = text.append(
          { kind: 'append-text', index },
          (snapshot) => snapshot.spliceText(
            tasks,
            ['task-0'],
            'title',
            { index: initialLength + index, deleteCount: 0, insert: 'x' }
          )
        );
        if (segment.status !== 'pending') {
          throw new Error('Text benchmark segment rejected: ' + segment.issues.map(({ code }) => code).join(', '));
        }
      }
      try {
        const receipt = await text.publish();
        if (receipt.outcome !== 'committed') {
          throw new Error('Text benchmark composition rejected: ' + receipt.issues.map(({ code }) => code).join(', '));
        }
      } finally {
        text.close();
      }
    },
    composeTextAcrossPublications: async (segmentCount, publicationSize) => {
      const visible = database.getSnapshot();
      if (visible.state !== 'open' || visible.current.readiness !== 'ready') {
        throw new Error('Transaction benchmark database is not ready');
      }
      const openedText = await database.openTextIntent({
        observedBasis: visible.current.basis
      });
      if (!openedText.success) {
        throw new Error('Text benchmark session failed: ' + openedText.issues.map(({ code }) => code).join(', '));
      }
      const text = openedText.value;
      const initialLength = handle.doc()?.tasks['task-0']?.title.length ?? 0;
      let publication;
      let publishedSegments = 0;
      try {
        for (let index = 0; index < segmentCount; index += 1) {
          const segment = text.append(
            { kind: 'append-continued-text', index },
            (snapshot) => snapshot.spliceText(
              tasks,
              ['task-0'],
              'title',
              { index: initialLength + index, deleteCount: 0, insert: 'x' }
            )
          );
          if (segment.status !== 'pending') {
            throw new Error('Text benchmark segment rejected: ' + segment.issues.map(({ code }) => code).join(', '));
          }
          if ((index + 1) % publicationSize !== 0) continue;
          if (publication !== undefined) await publication;
          publication = text.publish();
          publishedSegments = index + 1;
        }
        if (publication !== undefined) await publication;
        if (publishedSegments < segmentCount) await text.publish();
      } finally {
        text.close();
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
