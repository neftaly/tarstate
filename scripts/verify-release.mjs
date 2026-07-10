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
