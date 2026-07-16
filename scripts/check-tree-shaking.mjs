import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const selectedExport = (packagePath, exportName) =>
  `export { ${exportName} as selected } from ${JSON.stringify(path.join(repoRoot, packagePath))};`;

const cases = [
  {
    name: 'foundation canonical JSON',
    source: selectedExport('packages/core/dist/index.js', 'canonicalizeJson'),
    maxGzipBytes: 650
  },
  {
    name: 'typed query parameter',
    source: selectedExport('packages/core/dist/query/authoring/index.js', 'typedParameter'),
    maxGzipBytes: 700
  },
  {
    name: 'database attachment catalog',
    source: selectedExport('packages/core/dist/database/index.js', 'AttachmentCatalog'),
    maxGzipBytes: 1_500
  },
  {
    name: 'incremental database query session',
    source: selectedExport('packages/core/dist/database/session/index.js', 'openDatabaseQuery'),
    // This is the complete incremental evaluator, including joins, aggregates,
    // windows, fallback evaluation, observation, and owned source lifecycle.
    maxGzipBytes: 44_000
  },
  {
    name: 'query expression evaluator',
    source: selectedExport('packages/core/dist/query/evaluate/index.js', 'evaluateExpression'),
    maxGzipBytes: 9_500
  },
  {
    name: 'React commit hook',
    source: selectedExport('packages/react/dist/index.js', 'useCommit'),
    maxGzipBytes: 400
  },
  {
    name: 'React query hook',
    source: selectedExport('packages/react/dist/index.js', 'useQuery'),
    maxGzipBytes: 5_200
  },
  {
    name: 'schema JSON generator',
    source: selectedExport('packages/schema-tools/dist/index.js', 'generateJsonSchema'),
    maxGzipBytes: 8_500
  },
  {
    name: 'Automerge value adoption',
    source: selectedExport('packages/automerge/dist/values/index.js', 'adoptConflictFreeAutomergeJsonValue'),
    maxGzipBytes: 5_200
  }
];

const externalRuntime = (id) =>
  id === 'react'
  || id === 'zustand'
  || id.startsWith('zustand/')
  || id.startsWith('@automerge/');

const bundleSize = async ({ name, source }) => {
  const virtualId = `\0tarstate-tree-shaking:${name}`;
  const result = await build({
    root: repoRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'tarstate-tree-shaking-entry',
      resolveId(id) {
        return id === 'tarstate-tree-shaking-entry' ? virtualId : undefined;
      },
      load(id) {
        return id === virtualId ? source : undefined;
      }
    }],
    build: {
      write: false,
      minify: 'oxc',
      target: 'safari17',
      rollupOptions: {
        input: 'tarstate-tree-shaking-entry',
        preserveEntrySignatures: 'strict',
        external: externalRuntime
      }
    }
  });
  const outputs = Array.isArray(result)
    ? result.flatMap(({ output }) => output)
    : result.output;
  const code = outputs
    .filter(({ type }) => type === 'chunk')
    .map(({ code: chunkCode }) => chunkCode)
    .join('\n');
  return {
    bytes: Buffer.byteLength(code),
    gzipBytes: gzipSync(code).byteLength
  };
};

for (const entry of cases) {
  const size = await bundleSize(entry);
  console.log(`${entry.name}: ${size.gzipBytes} gzip bytes (${size.bytes} raw)`);
  if (size.gzipBytes > entry.maxGzipBytes) {
    throw new Error(
      `${entry.name} exceeded its ${entry.maxGzipBytes}-byte gzip budget by `
      + `${size.gzipBytes - entry.maxGzipBytes} bytes`
    );
  }
}
