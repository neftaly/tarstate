import path from 'node:path';

export const coreSubpathEntryNames = [
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
  'relation',
  'relic',
  'runtime',
  'schema',
  'source',
  'store',
  'watch',
  'write'
] as const;

const sourceAlias = (repoRoot: string, find: string, replacement: string) => ({
  find,
  replacement: path.join(repoRoot, replacement)
});

export const sourceAliasesFor = (repoRoot: string) => [
  ...coreSubpathEntryNames.map((entryName) =>
    sourceAlias(repoRoot, '@tarstate/core/' + entryName, 'packages/core/src/' + entryName + '.ts')),
  sourceAlias(repoRoot, '@tarstate/automerge/presence', 'packages/automerge/src/presence.ts'),
  sourceAlias(repoRoot, '@tarstate/automerge', 'packages/automerge/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/react', 'packages/react/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/schema-tools/cli', 'packages/schema-tools/src/cli.ts'),
  sourceAlias(repoRoot, '@tarstate/schema-tools', 'packages/schema-tools/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/core', 'packages/core/src/index.ts')
];
