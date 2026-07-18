import type * as Automerge from '@automerge/automerge';
import {
  type ReadyAttachmentPreparation
} from '@tarstate/core/attachment/adapter';
import { createLiveAttachmentDatabase } from '@tarstate/core/database/adapter';
import type {
  DatabaseTransactionService,
  LogicalRelationRow
} from '@tarstate/core/transactions';
import type { RelationInput } from '@tarstate/core/query/model';
import type { WritableLogicalState } from '@tarstate/core/source';
import type { AutomergeAtomicSource } from '../adapter/atomic-source.js';
import type { AutomergeDatabase } from './model.js';
import {
  databaseSnapshot,
  sameDatabaseSnapshot,
  type AutomergeAttachmentProjector
} from '../attachment/projection.js';

export const createLiveAutomergeDatabase = <T extends object>(input: {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly authorityScope: string;
  readonly transactions: DatabaseTransactionService;
  readonly preparation: ReadyAttachmentPreparation<Automerge.Doc<T>, readonly RelationInput[], WritableLogicalState>;
  readonly source: AutomergeAtomicSource<T>;
  readonly projector: AutomergeAttachmentProjector<T>;
}): AutomergeDatabase => {
  const logicalRows = new WeakMap<object, readonly LogicalRelationRow[]>();
  return createLiveAttachmentDatabase({
    attachmentId: input.attachmentId,
    incarnation: input.incarnation,
    authorityScope: input.authorityScope,
    service: input.transactions,
    preparation: input.preparation,
    source: input.source,
    deriveSnapshot: (source) => databaseSnapshot(source, input.projector, logicalRows),
    sameSnapshot: sameDatabaseSnapshot,
    closedSnapshot
  });
};

const closedSnapshot = Object.freeze({ state: 'closed' as const });
