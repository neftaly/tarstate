import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vite';
import { coreInternalEntryNames, corePublicEntryNames, sourceAliasesFor } from './vite.shared.js';

type PackageConfig = { readonly build: NonNullable<UserConfig['build']> };

const packageEntryPath = (entryName: string): string => 'src/' + entryName + '.ts';
const coreBuildEntries = Object.fromEntries([
  ['index', packageEntryPath('root')],
  ...coreInternalEntryNames.map((entryName) => [entryName, packageEntryPath(entryName)]),
  ...corePublicEntryNames.map((entryName) => [entryName + '/index', 'src/' + entryName + '/index.ts'])
]);

const failOnRollupWarning = (warning: string | { readonly message?: string }): never => {
  const message = typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning);
  throw new Error('Rollup warning treated as error: ' + message);
};

const sharedBuildOptions = {
  target: 'safari17',
  sourcemap: true,
  rollupOptions: { onwarn: failOnRollupWarning }
} satisfies NonNullable<UserConfig['build']>;

const buildConfigsByPackageName: Record<string, PackageConfig> = {
  '@tarstate/core': {
    build: {
      ...sharedBuildOptions,
      lib: { entry: coreBuildEntries, formats: ['es'], fileName: (_format, entryName) => entryName + '.js' }
    }
  },
  '@tarstate/automerge': {
    build: {
      ...sharedBuildOptions,
      lib: {
        entry: { index: 'src/index.ts', 'values/index': 'src/values/index.ts' },
        formats: ['es'],
        fileName: (_format, entryName) => entryName + '.js'
      },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/, '@automerge/automerge']
      }
    }
  },
  '@tarstate/zustand': {
    build: {
      ...sharedBuildOptions,
      lib: { entry: { index: 'src/index.ts' }, formats: ['es'], fileName: (_format, entryName) => entryName + '.js' },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/, /^zustand(?:\/.*)?$/]
      }
    }
  },
  '@tarstate/react': {
    build: {
      ...sharedBuildOptions,
      lib: { entry: { index: 'src/index.ts' }, formats: ['es'], fileName: (_format, entryName) => entryName + '.js' },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/, /^react(?:\/.*)?$/]
      }
    }
  },
  '@tarstate/schema-tools': {
    build: {
      ...sharedBuildOptions,
      lib: { entry: { index: 'src/index.ts' }, formats: ['es'], fileName: (_format, entryName) => entryName + '.js' },
      rollupOptions: {
        ...sharedBuildOptions.rollupOptions,
        external: [/^@tarstate\/core(?:\/.*)?$/]
      }
    }
  }
};

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly name?: string };
const packageConfig = manifest.name ? buildConfigsByPackageName[manifest.name] : undefined;
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }): UserConfig => {
  const baseConfig = {
    clearScreen: false,
    optimizeDeps: { exclude: ['@automerge/automerge'] },
    resolve: { alias: sourceAliasesFor(repoRoot) }
  } satisfies UserConfig;
  if (packageConfig === undefined) {
    if (command !== 'build') return baseConfig;
    throw new Error('No shared Vite config for package: ' + (manifest.name ?? '<unknown>'));
  }
  return { ...baseConfig, build: packageConfig.build };
});
