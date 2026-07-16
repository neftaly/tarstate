import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDirectory = path.join(root, 'packages/core');
const dist = path.join(coreDirectory, 'dist');
const automergeDist = path.join(root, 'packages/automerge/dist');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'tarstate-built-boundaries-'));

try {
  assertClosure('foundation/index.js', 45_000, ['registry-', 'builtins-', 'query', 'schema', 'semantic-artifact', 'transaction', 'database', 'memory-source']);
  assertClosure('capabilities/index.js', 55_000, ['query', 'schema', 'semantic-artifact', 'transaction', 'database', 'memory-source']);
  assertClosure('artifacts/index.js', 70_000, ['semantic-', 'query-', 'mapping-', 'lens-', 'constraint-', 'transaction-']);
  assertClosure('artifacts/query/index.js', 165_000, ['query-incremental', 'observer-maintenance', 'semantic-transaction', 'semantic-storage-mapping', 'semantic-schema-lens', 'semantic-constraint']);
  assertClosure('artifacts/transaction/index.js', 80_000, ['internal-query-evaluator', 'semantic-query-artifact', 'mapping-', 'lens-', 'constraint-']);
  assertClosure('artifacts/constraint-set/index.js', 85_000, ['internal-query-evaluator', 'semantic-query-artifact', 'mapping-', 'lens-', 'transaction-']);
  assertClosure('artifacts/storage-mapping/index.js', 90_000, ['query-', 'lens-', 'constraint-', 'transaction-']);
  assertClosure('artifacts/schema-lens/index.js', 75_000, ['query-', 'mapping-', 'constraint-', 'transaction-']);
  assertClosure('source/index.js', 100, []);
  assertClosure('source/projection/index.js', 6_000, []);
  assertClosure('attachment/index.js', 100, []);
  assertClosure('attachment/prepare/index.js', 140_000, ['internal-query-evaluator', 'semantic-query-artifact', 'semantic-schema-lens', 'transaction-']);
  assertClosure('attachment/transact/index.js', 180_000, ['query-authoring', 'schema-authoring', 'internal-query-evaluator', 'query-incremental', 'observer-maintenance']);
  assertClosure('query/model/index.js', 100, []);
  assertClosure('query/prepare/index.js', 60_000, ['internal-query-evaluator', 'query-incremental', 'observer-maintenance-contracts', 'transaction-executor']);
  assertClosure('query/authoring/index.js', 75_000, ['schema-authoring', 'transaction-authoring', 'internal-query-evaluator', 'query-incremental', 'observer-maintenance-contracts', 'transaction-executor']);
  assertClosure('query/evaluate/index.js', 120_000, ['query-incremental', 'internal-observer-query-maintenance', 'memory-source', 'transaction-executor']);
  assertClosure('query/incremental/index.js', 215_000, ['internal-observer-query-maintenance', 'observer-maintenance-contracts', 'memory-source', 'transaction-executor']);
  assertClosure('schema/index.js', 100_000, ['query-authoring', 'transaction-authoring', 'internal-query-evaluator', 'query-incremental']);
  assertClosure('transactions/index.js', 158_000, ['query-authoring', 'schema-authoring', 'internal-query-evaluator', 'query-incremental', 'observer-maintenance']);
  assertClosure('database/observer/index.js', 80_000, ['query-incremental', 'internal-observer-query-maintenance', 'memory-source', 'system-relations', 'transaction-executor']);
  assertClosure('database/incremental/index.js', 225_000, ['memory-source', 'system-relations', 'transaction-executor']);
  assertClosure('database/external-store/index.js', 60_000, ['query-incremental', 'internal-observer-query-maintenance', 'memory-source', 'system-relations', 'transaction-executor']);
  assertClosure('values/index.js', 15_000, [
    'artifact-resource-driver',
    'core-adapter',
    'metadata',
    'projection',
    'source-',
    'storage-binding'
  ], automergeDist);
  await verifyPackedDuplicateCopies();
  console.log('Verified narrow built closures and packed duplicate-copy identities.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function assertClosure(entry, maximumBytes, forbiddenNames, directory = dist) {
  const closure = staticClosure(path.join(directory, entry));
  const bytes = [...closure].reduce((total, file) => total + statSync(file).size, 0);
  if (bytes > maximumBytes) {
    throw new Error(entry + ' static closure is ' + bytes + ' bytes; budget is ' + maximumBytes);
  }
  for (const file of closure) {
    const name = path.basename(file);
    const forbidden = forbiddenNames.find((candidate) => name.includes(candidate));
    if (forbidden !== undefined) throw new Error(entry + ' reaches forbidden built module ' + name);
  }
}

function staticClosure(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const specifiers = Array.from(
      source.matchAll(/^(?:import\s+(?:[^"'`\n;]+?\s+from\s+)?|export\s+[^"'`\n;]+?\s+from\s+)["']([^"']+)["'];?/gm),
      (match) => match[1]
    );
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      visit(path.resolve(path.dirname(file), specifier));
    }
  };
  visit(entry);
  return seen;
}

async function verifyPackedDuplicateCopies() {
  const packedDirectory = path.join(temporaryDirectory, 'packed');
  const producerDirectory = path.join(temporaryDirectory, 'producer');
  const consumerDirectory = path.join(temporaryDirectory, 'consumer');
  mkdirSync(packedDirectory);
  mkdirSync(producerDirectory);
  mkdirSync(consumerDirectory);
  execFileSync('pnpm', ['pack', '--pack-destination', packedDirectory], { cwd: coreDirectory, stdio: 'pipe' });
  const tarballs = readdirSync(packedDirectory).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error('Expected one packed @tarstate/core tarball');
  const tarball = path.join(packedDirectory, tarballs[0]);
  execFileSync('tar', ['-xzf', tarball, '-C', producerDirectory]);
  execFileSync('tar', ['-xzf', tarball, '-C', consumerDirectory]);

  const producerDist = path.join(producerDirectory, 'package/dist');
  const consumerDist = path.join(consumerDirectory, 'package/dist');
  const producer = await import(pathToFileURL(path.join(producerDist, 'index.js')).href);
  const queryProducer = await import(pathToFileURL(path.join(producerDist, 'query/index.js')).href);
  const foundationConsumer = await import(pathToFileURL(path.join(consumerDist, 'foundation/index.js')).href);
  const queryConsumer = await import(pathToFileURL(path.join(consumerDist, 'query/index.js')).href);

  for (const sentinel of ['missingValue', 'logicalUnknown', 'capabilityUnavailable']) {
    if (producer[sentinel] !== foundationConsumer[sentinel]) throw new Error('Duplicate copies disagree on ' + sentinel + ' identity');
  }

  const expression = queryProducer.prepareExpression({ kind: 'literal', value: 11 });
  if (queryConsumer.evaluatePreparedExpression(expression, {}) !== 11) {
    throw new Error('Duplicate query copy rejected a prepared expression');
  }

  const plan = await queryProducer.prepareQuery({
    root: { kind: 'values', alias: 'value', rows: [{ id: 12 }] },
    registryFingerprint: 'registry:built-boundaries',
    authorityFingerprint: 'authority:built-boundaries',
    datasetId: 'dataset:built-boundaries'
  });
  if (queryConsumer.evaluatePreparedQuery(plan, { relations: [] }).rows[0]?.id !== 12) {
    throw new Error('Duplicate query copy rejected a prepared plan');
  }
}
