import type {
  AttachmentTransactionRow,
  AttachmentTransactionService
} from '@tarstate/core/attachment/adapter';
import type { AttachmentCatalog } from '@tarstate/core/database';
import type { Issue } from '@tarstate/core';
import type { SourceBasis, SourceFreshness, SourceLifecycleState } from '@tarstate/core/source';

export type AutomergeAttachmentResult = {
  readonly readiness: 'ready' | 'incomplete' | 'invalid';
  readonly rows: readonly AttachmentTransactionRow[];
  readonly completeness: 'exact' | 'unknown';
  readonly freshness: SourceFreshness;
  readonly basis: SourceBasis;
  readonly sourceState: SourceLifecycleState;
  readonly issues: readonly Issue[];
};

export type AutomergeAttachmentSnapshot =
  | { readonly state: 'open'; readonly current: AutomergeAttachmentResult }
  | { readonly state: 'closed' };

export type AutomergeAttachmentMountOptions = {
  readonly discoveryEdges?: readonly string[];
};

export type AutomergeAttachmentMountLease = {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly discoveryEdges: readonly string[];
  readonly close: () => void;
};

export type AutomergeAttachment = AttachmentTransactionService & {
  readonly getSnapshot: () => AutomergeAttachmentSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly mount: (
    catalog: AttachmentCatalog,
    options?: AutomergeAttachmentMountOptions
  ) => AutomergeAttachmentMountLease;
  readonly close: () => void;
};
