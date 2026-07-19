import type { MappedDatabaseResult, MappedDatabaseSnapshot } from '../../attachment/mapped-database-projection.js';
import type { DatabaseTransactionService } from '../transaction.js';
import type { LiveAttachmentDatabase } from '../live-attachment.js';

export type ExternalStoreDatabaseResult = MappedDatabaseResult;

export type ExternalStoreDatabaseSnapshot = MappedDatabaseSnapshot;

export type ExternalStoreDatabase = LiveAttachmentDatabase<
  DatabaseTransactionService,
  ExternalStoreDatabaseSnapshot
>;
