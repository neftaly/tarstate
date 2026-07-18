import type { MappedDatabaseResult, MappedDatabaseSnapshot } from '../../attachment/mapped-database-projection.js';
import type { DatabaseTransactionService } from '../transaction.js';
import type { OwnedDatabaseSource } from '../source-mount.js';

export type ExternalStoreDatabaseResult = MappedDatabaseResult;

export type ExternalStoreDatabaseSnapshot = MappedDatabaseSnapshot;

export type ExternalStoreDatabase = DatabaseTransactionService & OwnedDatabaseSource & {
  readonly getSnapshot: () => ExternalStoreDatabaseSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
};
