import path from 'node:path';

export const coreSubpathEntryNames = ['v1-spike'] as const;

const sourceAlias = (repoRoot: string, find: string, replacement: string) => ({
  find,
  replacement: path.join(repoRoot, replacement)
});

export const sourceAliasesFor = (repoRoot: string) => [
  sourceAlias(repoRoot, '@tarstate/core/v1-spike', 'packages/core/src/v1-spike.ts'),
  sourceAlias(repoRoot, '@tarstate/automerge/v1-spike', 'packages/automerge/src/v1-spike.ts'),
  sourceAlias(repoRoot, '@tarstate/automerge', 'packages/automerge/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/zustand', 'packages/zustand/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/core', 'packages/core/src/index.ts')
];
