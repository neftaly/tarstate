import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type UserConfig } from 'vite';

type PackageConfig = {
  readonly build: NonNullable<UserConfig['build']>;
};

const failOnRollupWarning = (warning: string | { readonly message?: string }): never => {
  const message = typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning);
  throw new Error('Rollup warning treated as error: ' + message);
};

const sharedBuildOptions = { target: 'safari17', sourcemap: true, rollupOptions: { onwarn: failOnRollupWarning } } satisfies NonNullable<UserConfig['build']>;

const buildConfigsByPackageName: Record<string, PackageConfig> = {
  '@tarstate/react': {
    build: {
      ...sharedBuildOptions,
      lib: {
        entry: {
          index: 'src/index.ts'
        },
        formats: ['es'],
        fileName: (_format, entryName) => entryName + '.js'
      },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/, 'react']
      }
    }
  },
  '@tarstate/automerge': {
    build: {
      ...sharedBuildOptions,
      lib: {
        entry: {
          index: 'src/index.ts'
        },
        formats: ['es'],
        fileName: (_format, entryName) => entryName + '.js'
      },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/, '@automerge/automerge']
      }
    }
  },
  '@tarstate/core': {
    build: {
      ...sharedBuildOptions,
      lib: {
        entry: {
          index: 'src/index.ts',
          adapter: 'src/adapter.ts',
          constraints: 'src/constraints.ts',
          db: 'src/db.ts',
          delta: 'src/delta.ts',
          diff: 'src/diff.ts',
          diagnostics: 'src/diagnostics.ts',
          evaluate: 'src/evaluate.ts',
          identity: 'src/identity.ts',
          materialization: 'src/materialization.ts',
          query: 'src/query.ts',
          runtime: 'src/runtime.ts',
          schema: 'src/schema.ts',
          source: 'src/source.ts',
          watch: 'src/watch.ts',
          'write-apply': 'src/write-apply.ts',
          write: 'src/write.ts'
        },
        formats: ['es'],
        fileName: (_format, entryName) => entryName + '.js'
      },
    }
  },
  '@tarstate/demo': {
    build: sharedBuildOptions
  }
};

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly name?: string };
const packageConfig = manifest.name ? buildConfigsByPackageName[manifest.name] : undefined;
const repoRoot = path.dirname(new URL(import.meta.url).pathname);
const sourceAliases = [
  { find: '@tarstate/core/adapter', replacement: path.join(repoRoot, 'packages/core/src/adapter.ts') },
  { find: '@tarstate/core/constraints', replacement: path.join(repoRoot, 'packages/core/src/constraints.ts') },
  { find: '@tarstate/core/db', replacement: path.join(repoRoot, 'packages/core/src/db.ts') },
  { find: '@tarstate/core/delta', replacement: path.join(repoRoot, 'packages/core/src/delta.ts') },
  { find: '@tarstate/core/diff', replacement: path.join(repoRoot, 'packages/core/src/diff.ts') },
  { find: '@tarstate/core/diagnostics', replacement: path.join(repoRoot, 'packages/core/src/diagnostics.ts') },
  { find: '@tarstate/core/evaluate', replacement: path.join(repoRoot, 'packages/core/src/evaluate.ts') },
  { find: '@tarstate/core/identity', replacement: path.join(repoRoot, 'packages/core/src/identity.ts') },
  { find: '@tarstate/core/materialization', replacement: path.join(repoRoot, 'packages/core/src/materialization.ts') },
  { find: '@tarstate/core/query', replacement: path.join(repoRoot, 'packages/core/src/query.ts') },
  { find: '@tarstate/core/runtime', replacement: path.join(repoRoot, 'packages/core/src/runtime.ts') },
  { find: '@tarstate/core/schema', replacement: path.join(repoRoot, 'packages/core/src/schema.ts') },
  { find: '@tarstate/core/source', replacement: path.join(repoRoot, 'packages/core/src/source.ts') },
  { find: '@tarstate/core/watch', replacement: path.join(repoRoot, 'packages/core/src/watch.ts') },
  { find: '@tarstate/core/write-apply', replacement: path.join(repoRoot, 'packages/core/src/write-apply.ts') },
  { find: '@tarstate/core/write', replacement: path.join(repoRoot, 'packages/core/src/write.ts') },
  { find: '@tarstate/automerge', replacement: path.join(repoRoot, 'packages/automerge/src/index.ts') },
  { find: '@tarstate/react', replacement: path.join(repoRoot, 'packages/react/src/index.ts') },
  { find: '@tarstate/core', replacement: path.join(repoRoot, 'packages/core/src/index.ts') }
];

export default defineConfig(({ command }): UserConfig => {
  const baseConfig = { clearScreen: false, resolve: { alias: sourceAliases } } satisfies UserConfig;

  if (packageConfig === undefined) {
    if (command !== 'build') return baseConfig;
    throw new Error('No shared Vite config for package: ' + (manifest.name ?? '<unknown>'));
  }

  return {
    ...baseConfig,
    build: packageConfig.build
  };
});
