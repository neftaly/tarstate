import type { ReadyAttachmentPreparation } from '../../attachment/preparation.js';
import type { ArtifactRef } from '../../artifacts.js';
import { createLiveAttachmentDatabase } from '../live-attachment.js';
import type { DatabaseTransactionService } from '../transaction.js';
import type { RelationInput } from '../../query/model.js';
import type { WritableLogicalState } from '../../logical-edit.js';
import type { ExternalStoreAtomicSource } from './atomic-source.js';
import type { ExternalStoreDatabase } from './model.js';
import {
  mappedDatabaseSnapshot,
  sameMappedDatabaseSnapshot,
  type MappedAttachmentProjector,
  type MappedLogicalRelationRow
} from '../../attachment/mapped-database-projection.js';
import type { ExternalStoreMappedRow } from './mapped-binding.js';

export const createLiveExternalStoreDatabase = <State extends object>(input: {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly authorityScope: string;
  readonly schemaView: ArtifactRef;
  readonly transactions: DatabaseTransactionService;
  readonly preparation: ReadyAttachmentPreparation<State, readonly RelationInput[], WritableLogicalState>;
  readonly source: ExternalStoreAtomicSource<State>;
  readonly projector: MappedAttachmentProjector<State, ExternalStoreMappedRow>;
}): ExternalStoreDatabase => {
  const logicalRows = new WeakMap<object, readonly MappedLogicalRelationRow[]>();
  return createLiveAttachmentDatabase({
    attachmentId: input.attachmentId,
    incarnation: input.incarnation,
    authorityScope: input.authorityScope,
    service: input.transactions,
    preparation: input.preparation,
    source: input.source,
    deriveSnapshot: (source) => mappedDatabaseSnapshot(
      source,
      input.projector,
      logicalRows,
      input.schemaView
    ),
    sameSnapshot: sameMappedDatabaseSnapshot,
    closedSnapshot
  });
};

const closedSnapshot = Object.freeze({ state: 'closed' as const });
