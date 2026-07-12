import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = ['core', 'automerge', 'zustand', 'react', 'schema-tools'];
const coreSubpaths = ['artifacts', 'database', 'query', 'schema', 'transactions'];
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'tarstate-release-'));

const fail = (message) => { throw new Error(message); };

try {
  for (const directory of packageDirectories) {
    const packageDirectory = path.join(root, 'packages', directory);
    const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    if (manifest.version !== '0.2.2') fail(`${manifest.name}: expected version 0.2.2`);
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
    for (const [dependency, version] of Object.entries(packedManifest.dependencies ?? {})) {
      if (String(version).startsWith('workspace:')) fail(`${manifest.name}: unresolved workspace dependency ${dependency}`);
    }

    for (const exported of Object.values(manifest.exports ?? {})) {
      await import(pathToFileURL(path.join(packageDirectory, String(exported.import))).href);
    }
  }
  console.log(`Verified ${packageDirectories.length} v0.2.2 tarballs and runtime entry points.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
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
