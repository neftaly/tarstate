import type {
  DatabaseTextIntentService,
  DatabaseTransactionService,
} from '@tarstate/core/transactions';
import type { LiveAttachmentDatabase } from '@tarstate/core/database/adapter';
import type { MappedDatabaseResult, MappedDatabaseSnapshot } from '@tarstate/core/attachment/mapped-adapter';

export type AutomergeDatabaseResult = MappedDatabaseResult;

export type AutomergeDatabaseSnapshot = MappedDatabaseSnapshot;

export type AutomergeDatabase = LiveAttachmentDatabase<
  DatabaseTransactionService & DatabaseTextIntentService,
  AutomergeDatabaseSnapshot
>;
