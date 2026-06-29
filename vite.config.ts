import { defineConfig } from 'vite';

const failOnRollupWarning = (warning: string | { readonly message?: string }): never => {
  const message = typeof warning === 'string' ? warning : warning.message ?? JSON.stringify(warning);
  throw new Error('Rollup warning treated as error: ' + message);
};

export default defineConfig({
  clearScreen: false,
  build: {
    target: 'safari17',
    sourcemap: true,
    rollupOptions: { onwarn: failOnRollupWarning }
  }
});
