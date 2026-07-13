import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = ['core', 'automerge', 'zustand', 'react', 'schema-tools'];
const coreSubpaths = ['artifacts', 'database', 'query', 'schema', 'transactions'];
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'tarstate-release-'));
const releaseVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (typeof releaseVersion !== 'string' || releaseVersion.length === 0) throw new Error('Root package version must be a non-empty string');
const packedPackages = [];
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const fail = (message) => { throw new Error(message); };

try {
  for (const directory of packageDirectories) {
    const packageDirectory = path.join(root, 'packages', directory);
    const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    if (manifest.version !== releaseVersion) fail(`${manifest.name}: expected version ${releaseVersion}`);
    if (manifest.private === true) fail(`${manifest.name}: package remains private`);
    const expectedExports = manifest.name === '@tarstate/core' ? ['.', ...coreSubpaths.map((name) => './' + name)] : ['.'];
    if (JSON.stringify(Object.keys(manifest.exports ?? {}).sort()) !== JSON.stringify(expectedExports.sort())) {
      fail(`${manifest.name}: unexpected public exports`);
    }
    if (manifest.exports?.['.']?.types !== './dist/index.d.ts' || manifest.exports?.['.']?.import !== './dist/index.js') {
      fail(`${manifest.name}: exports do not resolve to dist`);
    }
    if (manifest.name === '@tarstate/core') {
      for (const subpath of coreSubpaths) {
        const exported = manifest.exports?.['./' + subpath];
        if (exported?.types !== `./dist/${subpath}/index.d.ts` || exported?.import !== `./dist/${subpath}/index.js`) {
          fail(`${manifest.name}: ${subpath} export does not resolve to dist`);
        }
      }
    }

    const destination = path.join(temporaryDirectory, directory);
    mkdirSync(destination);
    execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: packageDirectory, stdio: 'pipe' });
    const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) fail(`${manifest.name}: expected one packed tarball`);
    const tarball = path.join(destination, tarballs[0]);
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
    for (const required of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js', 'package/dist/index.d.ts']) {
      if (!entries.includes(required)) fail(`${manifest.name}: tarball is missing ${required}`);
    }
    for (const exported of Object.values(manifest.exports ?? {})) {
      for (const target of [exported.types, exported.import]) {
        const entry = 'package/' + String(target).replace(/^\.\//, '');
        if (!entries.includes(entry)) fail(`${manifest.name}: tarball is missing exported entry ${entry}`);
      }
    }
    verifyDeclarationReachability(manifest.name, tarball, entries);
    if (entries.some((entry) => entry.includes('golden-workloads'))) fail(`${manifest.name}: tarball contains conformance fixtures`);
    if (entries.some((entry) => entry.includes('/src/') || entry.endsWith('.tsbuildinfo'))) {
      fail(`${manifest.name}: tarball contains source or build-state files`);
    }
    const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    if (manifest.name === '@tarstate/zustand') {
      if (packedManifest.dependencies?.zustand !== undefined) fail('@tarstate/zustand: zustand must remain a peer dependency');
      if (packedManifest.peerDependencies?.zustand !== '>=5.0.0 <6') fail('@tarstate/zustand: unexpected zustand peer range');
    }
    for (const [dependency, version] of Object.entries(packedManifest.dependencies ?? {})) {
      if (String(version).startsWith('workspace:')) fail(`${manifest.name}: unresolved workspace dependency ${dependency}`);
      if (dependency.startsWith('@tarstate/') && !internalRangeIncludesRelease(String(version))) {
        fail(`${manifest.name}: internal dependency ${dependency}@${version} does not admit ${releaseVersion}`);
      }
    }
    verifyRuntimeDependencyDeclarations(packedManifest, tarball, entries);
    packedPackages.push({ directory, manifest: packedManifest, tarball });

    if (manifest.name === '@tarstate/core') await verifyCoreCrossEntryProvenance(tarball, destination);
  }
  await verifyPackedRuntime(packedPackages);
  console.log(`Verified ${packageDirectories.length} v${releaseVersion} tarballs and installed runtime entry points.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function internalRangeIncludesRelease(range) {
  return range === releaseVersion || range === `^${releaseVersion}` || range === `~${releaseVersion}`;
}

function verifyRuntimeDependencyDeclarations(manifest, tarball, entries) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ]);
  const javascriptEntries = entries.filter((entry) => entry.startsWith('package/dist/') && entry.endsWith('.js'));
  for (const entry of javascriptEntries) {
    const source = execFileSync('tar', ['-xOf', tarball, entry], { encoding: 'utf8' });
    const specifiers = [
      ...Array.from(source.matchAll(/^(?:import\s+(?:[^"'`\n;]+?\s+from\s+)?|export\s+[^"'`\n;]+?\s+from\s+)["']([^"']+)["'];?/gm), (match) => match[1]),
      ...Array.from(source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g), (match) => match[1])
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || builtins.has(specifier)) continue;
      const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!declared.has(dependency)) fail(`${manifest.name}: ${entry} imports undeclared runtime dependency ${dependency}`);
    }
  }
}

async function verifyPackedRuntime(packages) {
  const installation = path.join(temporaryDirectory, 'installed');
  mkdirSync(installation);
  const dependencies = Object.fromEntries(packages.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]));
  dependencies.react = '19.2.7';
  dependencies.zustand = '5.0.14';
  writeFileSync(path.join(installation, 'package.json'), JSON.stringify({
    name: 'tarstate-release-consumer',
    private: true,
    type: 'module',
    dependencies
  }, null, 2) + '\n');

  try {
    execFileSync('npm', ['install', '--ignore-scripts', '--no-package-lock', '--strict-peer-deps'], {
      cwd: installation,
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter((value) => typeof value === 'string' && value.length > 0).join('\n');
    fail(`packed consumer installation failed${output.length > 0 ? `:\n${output}` : ''}`);
  }

  const specifiers = packages.flatMap(({ manifest }) => Object.keys(manifest.exports ?? {}).map((exported) =>
    exported === '.' ? manifest.name : `${manifest.name}/${exported.slice(2)}`
  ));
  const verificationModule = path.join(installation, 'verify-imports.mjs');
  writeFileSync(verificationModule, `${specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n')}\n`);
  execFileSync(process.execPath, [verificationModule], { cwd: installation, stdio: 'pipe' });
}

async function verifyCoreCrossEntryProvenance(tarball, destination) {
  const producerDirectory = path.join(destination, 'producer');
  const consumerDirectory = path.join(destination, 'consumer');
  mkdirSync(producerDirectory);
  mkdirSync(consumerDirectory);
  execFileSync('tar', ['-xzf', tarball, '-C', producerDirectory]);
  execFileSync('tar', ['-xzf', tarball, '-C', consumerDirectory]);

  const producer = await import(pathToFileURL(path.join(producerDirectory, 'package/dist/index.js')).href);
  const queryConsumer = await import(pathToFileURL(path.join(consumerDirectory, 'package/dist/query/index.js')).href);
  const schemaConsumer = await import(pathToFileURL(path.join(consumerDirectory, 'package/dist/schema/index.js')).href);

  const plan = await producer.prepareQuery({
    root: { kind: 'values', alias: 'value', rows: [{ id: 1 }] },
    registryFingerprint: 'registry:packed-cross-entry',
    authorityFingerprint: 'authority:packed-cross-entry',
    datasetId: 'dataset:packed-cross-entry'
  });
  const session = queryConsumer.openIncrementalQueryMaintenance(plan, { relations: [] });
  if (session.getCurrentResult().rows[0]?.id !== 1) fail('@tarstate/core: packed query entry rejected root-entry prepared plan');
  session.close();
  if (queryConsumer.evaluatePreparedQuery(plan, { relations: [] }).rows[0]?.id !== 1) {
    fail('@tarstate/core: packed query entry rejected root-entry plan for prepared evaluation');
  }
  const subpathPlan = await queryConsumer.prepareQuery({
    root: { kind: 'values', alias: 'value', rows: [{ id: 2 }] },
    registryFingerprint: 'registry:packed-cross-entry',
    authorityFingerprint: 'authority:packed-cross-entry',
    datasetId: 'dataset:packed-cross-entry'
  });
  const reverseSession = producer.openIncrementalQueryMaintenance(subpathPlan, { relations: [] });
  if (reverseSession.getCurrentResult().rows[0]?.id !== 2) fail('@tarstate/core: packed root entry rejected query-entry prepared plan');
  reverseSession.close();
  if (producer.evaluatePreparedQuery(subpathPlan, { relations: [] }).rows[0]?.id !== 2) {
    fail('@tarstate/core: packed root entry rejected query-entry plan for prepared evaluation');
  }
  try {
    queryConsumer.openIncrementalQueryMaintenance({ ...plan }, { relations: [] });
    fail('@tarstate/core: packed query entry accepted forged prepared plan');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }

  const prepared = producer.prepareSchema({
    relations: {
      values: { relationId: 'test.value', key: ['id'], fields: { id: { type: { kind: 'number' } } } }
    }
  });
  if (!prepared.success) fail('@tarstate/core: packed root entry could not prepare schema');
  const parsed = schemaConsumer.parseRelationCandidate(prepared.value, 'test.value', { id: 1 });
  if (!parsed.success) fail('@tarstate/core: packed schema entry rejected root-entry prepared schema');

  const hash = (character) => `sha256:${character.repeat(64)}`;
  const schemaRef = { id: 'urn:test:schema:packed-cross-entry', contentHash: hash('1') };
  const mapping = producer.compileStorageMapping({
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: {
      'test.value': {
        collection: { kind: 'array', path: ['values'], absent: 'empty' },
        keys: { id: { kind: 'field', path: ['id'] } },
        fields: {}
      }
    }
  }, schemaRef, prepared.value);
  if (!mapping.success) fail('@tarstate/core: packed root entry could not compile mapping');
  if (schemaConsumer.projectStorage(mapping.value, { values: [{ id: 1 }] }).relations.get('test.value')?.rows.length !== 1) {
    fail('@tarstate/core: packed schema entry rejected root-entry compiled mapping');
  }

  const lens = producer.validateLens({
    from: { id: 'urn:test:schema:from', contentHash: hash('2') },
    to: { id: 'urn:test:schema:to', contentHash: hash('3') },
    relations: [{
      fromRelationId: 'test.value',
      toRelationId: 'test.projected-value',
      steps: [{ kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' }]
    }]
  });
  if (!lens.success) fail('@tarstate/core: packed root entry could not validate lens');
  if (schemaConsumer.projectLensRelation(lens.value, 'test.projected-value', { 'test.value': [{ id: 1 }] }).rows[0]?.id !== 1) {
    fail('@tarstate/core: packed schema entry rejected root-entry validated lens');
  }

  const subpathPrepared = schemaConsumer.prepareSchema({
    relations: {
      reverse: { relationId: 'test.reverse', key: ['id'], fields: { id: { type: { kind: 'number' } } } }
    }
  });
  if (!subpathPrepared.success || !producer.parseRelationCandidate(subpathPrepared.value, 'test.reverse', { id: 2 }).success) {
    fail('@tarstate/core: packed root entry rejected schema-entry prepared schema');
  }
  const subpathMapping = schemaConsumer.compileStorageMapping({
    schema: schemaRef,
    model: 'json-tree-v1',
    relations: {
      'test.reverse': {
        collection: { kind: 'array', path: ['reverse'], absent: 'empty' },
        keys: { id: { kind: 'field', path: ['id'] } },
        fields: {}
      }
    }
  }, schemaRef, subpathPrepared.value);
  if (!subpathMapping.success || producer.projectStorage(subpathMapping.value, { reverse: [{ id: 2 }] }).relations.get('test.reverse')?.rows.length !== 1) {
    fail('@tarstate/core: packed root entry rejected schema-entry compiled mapping');
  }
  const subpathLens = schemaConsumer.validateLens({
    from: { id: 'urn:test:schema:reverse-from', contentHash: hash('4') },
    to: { id: 'urn:test:schema:reverse-to', contentHash: hash('5') },
    relations: [{
      fromRelationId: 'test.reverse',
      toRelationId: 'test.reverse-view',
      steps: [{ kind: 'lens.field', from: 'id', to: 'id', write: 'invertible' }]
    }]
  });
  if (!subpathLens.success || producer.projectLensRelation(subpathLens.value, 'test.reverse-view', { 'test.reverse': [{ id: 2 }] }).rows[0]?.id !== 2) {
    fail('@tarstate/core: packed root entry rejected schema-entry validated lens');
  }
}

function verifyDeclarationReachability(packageName, tarball, entries) {
  const packedDeclarations = new Set(entries.filter((entry) => entry.startsWith('package/dist/') && entry.endsWith('.d.ts')));
  for (const declaration of packedDeclarations) {
    const source = execFileSync('tar', ['-xOf', tarball, declaration], { encoding: 'utf8' });
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(declaration), match[1]));
      const candidates = dependency.endsWith('.js')
        ? [dependency.slice(0, -3) + '.d.ts']
        : [dependency + '.d.ts', path.posix.join(dependency, 'index.d.ts')];
      if (!candidates.some((candidate) => packedDeclarations.has(candidate))) {
        fail(`${packageName}: ${declaration} references missing declaration ${match[1]}`);
      }
    }
  }
}
