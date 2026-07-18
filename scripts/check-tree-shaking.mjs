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
    name: 'portable byte materializer',
    source: selectedExport('packages/core/dist/values/index.js', 'safeMaterializePortableBytes'),
    maxGzipBytes: 4_100
  },
  {
    name: 'typed query parameter',
    source: selectedExport('packages/core/dist/query/authoring/index.js', 'typedParameter'),
    maxGzipBytes: 700
  },
  {
    name: 'typed union-all authoring',
    source: selectedExport('packages/core/dist/query/authoring/index.js', 'typedUnionAll'),
    maxGzipBytes: 1_000
  },
  {
    name: 'database attachment catalog',
    source: selectedExport('packages/core/dist/database/index.js', 'AttachmentCatalog'),
    maxGzipBytes: 1_500
  },
  {
    name: 'attached database adapter lifecycle',
    source: selectedExport('packages/core/dist/database/adapter/index.js', 'createLiveAttachmentDatabase'),
    maxGzipBytes: 2_200
  },
  {
    name: 'external-store runtime bridge',
    source: selectedExport('packages/core/dist/database/external-store/index.js', 'acquireExternalStoreRuntime'),
    maxGzipBytes: 5_200
  },
  {
    name: 'memory atomic external store',
    source: selectedExport('packages/core/dist/database/external-store/index.js', 'createMemoryAtomicExternalStore'),
    maxGzipBytes: 650
  },
  {
    name: 'external-store database initial entry',
    source: selectedExport('packages/core/dist/database/external-store/index.js', 'openExternalStoreDatabase'),
    initialOnly: true,
    maxGzipBytes: 1_000
  },
  {
    name: 'mapped relation row selector',
    source: selectedExport('packages/core/dist/database/external-store/index.js', 'mappedRelationRows'),
    maxGzipBytes: 800
  },
  {
    name: 'external-store relational database',
    source: selectedExport('packages/core/dist/database/external-store/index.js', 'openExternalStoreDatabase'),
    maxGzipBytes: 67_000
  },
  {
    name: 'incremental database query session',
    source: selectedExport('packages/core/dist/database/session/index.js', 'openDatabaseQuery'),
    // This is the complete incremental evaluator, including joins, aggregates,
    // windows, fallback evaluation, field-dependency projection, observation,
    // fixed-source lifecycle, and the lazy settlement-coordinator entry point.
    initialOnly: true,
    maxGzipBytes: 45_200
  },
  {
    name: 'source-link database query session',
    source: selectedExport('packages/core/dist/database/session/index.js', 'openDatabaseQuery'),
    // Optional fixed-point traversal and settlement coordination are lazy;
    // the complete closure also includes field-dependency projection.
    maxGzipBytes: 48_300
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
    name: 'artifact bundle runtime catalog',
    source: selectedExport(
      'packages/schema-tools/dist/artifact-bundle/index.js',
      'prepareArtifactBundle'
    ),
    maxGzipBytes: 9_500
  },
  {
    name: 'Automerge value adoption',
    source: selectedExport('packages/automerge/dist/values/index.js', 'adoptConflictFreeAutomergeJsonValue'),
    maxGzipBytes: 5_200
  },
  {
    name: 'Automerge mapped relation row selector',
    source: selectedExport('packages/automerge/dist/index.js', 'mappedRelationRows'),
    maxGzipBytes: 800
  },
  {
    name: 'Automerge database',
    source: selectedExport('packages/automerge/dist/index.js', 'openAutomergeDatabase'),
    // Automerge itself remains external. This covers Tarstate's complete
    // conflict-aware attachment, transaction, and observation closure.
    maxGzipBytes: 68_000
  }
];

const externalRuntime = (id) =>
  id === 'react'
  || id === 'zustand'
  || id.startsWith('zustand/')
  || id.startsWith('@automerge/');

const bundleSize = async ({ name, source, initialOnly = false }) => {
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
  const chunks = outputs.filter(({ type }) => type === 'chunk');
  const includedFiles = new Set();
  const includeStaticImports = (chunk) => {
    if (includedFiles.has(chunk.fileName)) return;
    includedFiles.add(chunk.fileName);
    for (const imported of chunk.imports) {
      const dependency = chunks.find(({ fileName }) => fileName === imported);
      if (dependency !== undefined) includeStaticImports(dependency);
    }
  };
  if (initialOnly) {
    for (const chunk of chunks) if (chunk.isEntry) includeStaticImports(chunk);
  }
  const code = chunks
    .filter(({ fileName }) => !initialOnly || includedFiles.has(fileName))
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
