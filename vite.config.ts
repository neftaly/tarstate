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
  '@tarstate/core': {
    build: {
      ...sharedBuildOptions,
      lib: {
        entry: {
          index: 'src/index.ts',
          diagnostics: 'src/diagnostics.ts',
          evaluate: 'src/evaluate.ts',
          query: 'src/query.ts',
          schema: 'src/schema.ts',
          source: 'src/source.ts',
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
  { find: '@tarstate/core/diagnostics', replacement: path.join(repoRoot, 'packages/core/src/diagnostics.ts') },
  { find: '@tarstate/core/evaluate', replacement: path.join(repoRoot, 'packages/core/src/evaluate.ts') },
  { find: '@tarstate/core/query', replacement: path.join(repoRoot, 'packages/core/src/query.ts') },
  { find: '@tarstate/core/schema', replacement: path.join(repoRoot, 'packages/core/src/schema.ts') },
  { find: '@tarstate/core/source', replacement: path.join(repoRoot, 'packages/core/src/source.ts') },
  { find: '@tarstate/core/write', replacement: path.join(repoRoot, 'packages/core/src/write.ts') },
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
