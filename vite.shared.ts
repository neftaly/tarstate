import path from 'node:path';

/** Build-only core modules used by repository tooling; package exports remain explicit. */
export const coreInternalEntryNames = ['golden-workloads', 'query'] as const;

/** Additive, topic-focused public entry points; the package root remains compatible. */
export const corePublicEntryNames = ['artifacts', 'database', 'query', 'schema', 'transactions'] as const;

const sourceAlias = (repoRoot: string, find: string, replacement: string) => ({
  find,
  replacement: path.join(repoRoot, replacement)
});

export const sourceAliasesFor = (repoRoot: string) => [
  sourceAlias(repoRoot, '@tarstate/schema-tools', 'packages/schema-tools/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/react', 'packages/react/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/automerge', 'packages/automerge/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/zustand', 'packages/zustand/src/index.ts'),
  ...corePublicEntryNames.map((entryName) => sourceAlias(repoRoot, '@tarstate/core/' + entryName, 'packages/core/src/' + entryName + '/index.ts')),
  sourceAlias(repoRoot, '@tarstate/core', 'packages/core/src/index.ts')
];
