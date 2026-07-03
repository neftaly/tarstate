import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vite';

type PackageConfig = {
  readonly build: NonNullable<UserConfig['build']>;
};

const coreSubpathEntryNames = [
  'adapter',
  'constraints',
  'db',
  'diagnostics',
  'delta',
  'diff',
  'evaluate',
  'materialization',
  'memory-runtime',
  'query',
  'runtime',
  'schema',
  'source',
  'store',
  'watch',
  'write'
] as const;

const packageEntryPath = (entryName: string): string => 'src/' + entryName + '.ts';
const coreBuildEntries = Object.fromEntries(['index', ...coreSubpathEntryNames].map((entryName) => [entryName, packageEntryPath(entryName)]));

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
          index: 'src/index.ts',
          presence: 'src/presence.ts'
        },
        formats: ['es'],
        fileName: (_format, entryName) => entryName + '.js'
      },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/, '@automerge/automerge', '@automerge/automerge-repo']
      }
    }
  },
  '@tarstate/core': {
    build: {
      ...sharedBuildOptions,
      lib: {
        entry: coreBuildEntries,
        formats: ['es'],
        fileName: (_format, entryName) => entryName + '.js'
      }
    }
  }
};

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly name?: string };
const packageConfig = manifest.name ? buildConfigsByPackageName[manifest.name] : undefined;
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceAlias = (find: string, replacement: string) => ({ find, replacement: path.join(repoRoot, replacement) });
const sourceAliases = [
  ...coreSubpathEntryNames.map((entryName) => sourceAlias('@tarstate/core/' + entryName, 'packages/core/src/' + entryName + '.ts')),
  sourceAlias('@tarstate/automerge/presence', 'packages/automerge/src/presence.ts'),
  sourceAlias('@tarstate/automerge', 'packages/automerge/src/index.ts'),
  sourceAlias('@tarstate/react', 'packages/react/src/index.ts'),
  sourceAlias('@tarstate/core', 'packages/core/src/index.ts')
];

export default defineConfig(({ command }): UserConfig => {
  const baseConfig = {
    clearScreen: false,
    optimizeDeps: {
      exclude: ['@automerge/automerge']
    },
    resolve: { alias: sourceAliases }
  } satisfies UserConfig;

  if (packageConfig === undefined) {
    if (command !== 'build') return baseConfig;
    throw new Error('No shared Vite config for package: ' + (manifest.name ?? '<unknown>'));
  }

  return {
    ...baseConfig,
    build: packageConfig.build
  };
});
