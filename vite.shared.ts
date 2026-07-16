import path from 'node:path';

/** Build-only core modules used by repository tooling; package exports remain explicit. */
export const coreInternalEntryNames = ['golden-workloads', 'query'] as const;

/** Topic-focused public entry points; the package root intentionally contains only foundation values. */
export const corePublicEntryNames = [
  'artifacts',
  'artifacts/constraint-set',
  'artifacts/query',
  'artifacts/schema-lens',
  'artifacts/storage-mapping',
  'artifacts/transaction',
  'attachment',
  'attachment/adapter',
  'capabilities',
  'database',
  'database/external-store',
  'database/incremental',
  'database/observer',
  'database/session',
  'query',
  'query/authoring',
  'query/evaluate',
  'query/incremental',
  'query/model',
  'query/prepare',
  'schema',
  'source',
  'transactions',
  'transactions/authoring',
  'values',
] as const;

/** Narrow public Automerge entries in addition to the package root. */
export const automergePublicEntryNames = ['values'] as const;

const sourceAlias = (repoRoot: string, find: string, replacement: string) => ({
  find,
  replacement: path.join(repoRoot, replacement)
});

export const sourceAliasesFor = (repoRoot: string) => [
  sourceAlias(repoRoot, '@tarstate/schema-tools', 'packages/schema-tools/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/react', 'packages/react/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/automerge/values', 'packages/automerge/src/values/index.ts'),
  sourceAlias(repoRoot, '@tarstate/automerge', 'packages/automerge/src/index.ts'),
  sourceAlias(repoRoot, '@tarstate/zustand', 'packages/zustand/src/index.ts'),
  ...[...corePublicEntryNames]
    .sort((left, right) => right.length - left.length)
    .map((entryName) => sourceAlias(repoRoot, '@tarstate/core/' + entryName, 'packages/core/src/' + entryName + '/index.ts')),
  sourceAlias(repoRoot, '@tarstate/core', 'packages/core/src/root.ts')
];
