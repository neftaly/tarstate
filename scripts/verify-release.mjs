import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = ['core', 'automerge', 'zustand', 'react', 'schema-tools'];
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'tarstate-release-'));

const fail = (message) => { throw new Error(message); };

try {
  for (const directory of packageDirectories) {
    const packageDirectory = path.join(root, 'packages', directory);
    const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    if (manifest.version !== '0.1.0') fail(`${manifest.name}: expected version 0.1.0`);
    if (manifest.private === true) fail(`${manifest.name}: package remains private`);
    if (Object.keys(manifest.exports ?? {}).some((name) => name !== '.')) fail(`${manifest.name}: unexpected public subpath export`);
    if (manifest.exports?.['.']?.types !== './dist/index.d.ts' || manifest.exports?.['.']?.import !== './dist/index.js') {
      fail(`${manifest.name}: exports do not resolve to dist`);
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
    verifyDeclarationReachability(manifest.name, tarball, entries);
    if (entries.some((entry) => entry.includes('golden-workloads'))) fail(`${manifest.name}: tarball contains conformance fixtures`);
    if (entries.some((entry) => entry.includes('/src/') || entry.endsWith('.tsbuildinfo'))) {
      fail(`${manifest.name}: tarball contains source or build-state files`);
    }
    const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    for (const [dependency, version] of Object.entries(packedManifest.dependencies ?? {})) {
      if (String(version).startsWith('workspace:')) fail(`${manifest.name}: unresolved workspace dependency ${dependency}`);
    }

    await import(pathToFileURL(path.join(packageDirectory, 'dist', 'index.js')).href);
  }
  console.log(`Verified ${packageDirectories.length} v0.1.0 tarballs and runtime entry points.`);
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
