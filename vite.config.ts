import { readFileSync } from 'node:fs';
import { defineConfig, type UserConfig } from 'vite';

type PackageConfig = {
  readonly external?: string[];
  readonly lib: {
    readonly entry: string | Record<string, string>;
    readonly formats: ['es'];
    readonly fileName: string | ((_format: string, entryName: string) => string);
  };
};

const buildConfigsByPackageName: Record<string, PackageConfig> = {
  '@tarstate/dummy-package': {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index'
    }
  }
};

const appPackageNames = new Set(['@tarstate/dummy-app']);
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly name?: string };
const packageConfig = manifest.name ? buildConfigsByPackageName[manifest.name] : undefined;
const isAppPackage = manifest.name === undefined ? false : appPackageNames.has(manifest.name);
const appBase = process.env.BASE_PATH ?? '/';

const failOnRollupWarning = (warning: string | { readonly message?: string }): never => {
  const message = typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning);
  throw new Error('Rollup warning treated as error: ' + message);
};

const sharedBuildOptions = { target: 'safari17', sourcemap: true, rollupOptions: { onwarn: failOnRollupWarning } } satisfies NonNullable<UserConfig['build']>;

export default defineConfig(({ command }): UserConfig => {
  if (isAppPackage) {
    return { base: appBase, clearScreen: false, build: sharedBuildOptions };
  }

  if (packageConfig === undefined) {
    if (command !== 'build') return { clearScreen: false };
    throw new Error('No shared Vite config for package: ' + (manifest.name ?? '<unknown>'));
  }

  return {
    clearScreen: false,
    build: {
      ...sharedBuildOptions,
      lib: packageConfig.lib,
      rollupOptions: { ...sharedBuildOptions.rollupOptions, ...(packageConfig.external === undefined ? {} : { external: packageConfig.external }) }
    }
  };
});
