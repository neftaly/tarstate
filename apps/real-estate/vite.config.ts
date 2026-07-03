import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '../..');
const sourceAlias = (find: string, replacement: string) => ({
  find,
  replacement: path.join(repoRoot, replacement)
});

export default defineConfig({
  clearScreen: false,
  build: {
    target: 'safari17'
  },
  resolve: {
    alias: [
      sourceAlias('@tarstate/core/adapter', 'packages/core/src/adapter.ts'),
      sourceAlias('@tarstate/core/constraints', 'packages/core/src/constraints.ts'),
      sourceAlias('@tarstate/core/db', 'packages/core/src/db.ts'),
      sourceAlias('@tarstate/core/diff', 'packages/core/src/diff.ts'),
      sourceAlias('@tarstate/core/diagnostics', 'packages/core/src/diagnostics.ts'),
      sourceAlias('@tarstate/core/evaluate', 'packages/core/src/evaluate.ts'),
      sourceAlias('@tarstate/core/materialization', 'packages/core/src/materialization.ts'),
      sourceAlias('@tarstate/core/memory-runtime', 'packages/core/src/memory-runtime.ts'),
      sourceAlias('@tarstate/core/query', 'packages/core/src/query.ts'),
      sourceAlias('@tarstate/core/runtime', 'packages/core/src/runtime.ts'),
      sourceAlias('@tarstate/core/schema', 'packages/core/src/schema.ts'),
      sourceAlias('@tarstate/core/source', 'packages/core/src/source.ts'),
      sourceAlias('@tarstate/core/store', 'packages/core/src/store.ts'),
      sourceAlias('@tarstate/core/watch', 'packages/core/src/watch.ts'),
      sourceAlias('@tarstate/core/write', 'packages/core/src/write.ts'),
      sourceAlias('@tarstate/react', 'packages/react/src/index.ts'),
      sourceAlias('@tarstate/core', 'packages/core/src/index.ts')
    ]
  }
});
