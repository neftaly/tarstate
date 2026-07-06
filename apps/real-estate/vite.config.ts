import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { sourceAliasesFor } from '../../vite.shared.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  base: process.env.TARSTATE_SITE_BASE ?? '/',
  clearScreen: false,
  build: {
    target: 'safari17'
  },
  resolve: {
    alias: sourceAliasesFor(repoRoot)
  }
});
