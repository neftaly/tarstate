import type * as Automerge from '@automerge/automerge';
import {
  type ReadyAttachmentPreparation
} from '@tarstate/core/attachment/adapter';
import { createLiveAttachmentDatabase } from '@tarstate/core/database/adapter';
import type {
  DatabaseTransactionService
} from '@tarstate/core/transactions';
import type { RelationInput } from '@tarstate/core/query/model';
import type { WritableLogicalState } from '@tarstate/core/source';
import type { AutomergeAtomicSource } from '../adapter/atomic-source.js';
import type { AutomergeDatabase } from './model.js';
import {
  mappedDatabaseSnapshot,
  sameMappedDatabaseSnapshot,
  type MappedAttachmentProjector,
  type MappedLogicalRelationRow
} from '@tarstate/core/attachment/mapped-adapter';
import type { AutomergeMappedStorageRow } from '../adapter/mapped-storage.js';

export const createLiveAutomergeDatabase = <T extends object>(input: {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly authorityScope: string;
  readonly transactions: DatabaseTransactionService;
  readonly preparation: ReadyAttachmentPreparation<Automerge.Doc<T>, readonly RelationInput[], WritableLogicalState>;
  readonly source: AutomergeAtomicSource<T>;
  readonly projector: MappedAttachmentProjector<Automerge.Doc<T>, AutomergeMappedStorageRow>;
}): AutomergeDatabase => {
  const logicalRows = new WeakMap<object, readonly MappedLogicalRelationRow[]>();
  return createLiveAttachmentDatabase({
    attachmentId: input.attachmentId,
    incarnation: input.incarnation,
    authorityScope: input.authorityScope,
    service: input.transactions,
    preparation: input.preparation,
    source: input.source,
    deriveSnapshot: (source) => mappedDatabaseSnapshot(source, input.projector, logicalRows),
    sameSnapshot: sameMappedDatabaseSnapshot,
    closedSnapshot
  });
};

const closedSnapshot = Object.freeze({ state: 'closed' as const });
