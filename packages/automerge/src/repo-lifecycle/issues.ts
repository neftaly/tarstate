import type { IssueDeclaration } from '@tarstate/core';

/** Issue vocabulary owned only by the optional Repo lifecycle topic. */
export const automergeRepoLifecycleIssueDeclarations: readonly IssueDeclaration[] = [
  {
    code: 'automerge.lifecycle_capability_unsupported',
    phase: 'lifecycle',
    severity: 'error',
    retries: ['after_capability']
  },
  {
    code: 'automerge.lifecycle_delete_unsupported',
    phase: 'lifecycle',
    severity: 'error',
    retries: ['never']
  }
];
