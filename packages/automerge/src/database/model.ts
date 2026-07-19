import type {
  DatabaseTextIntentService,
  DatabaseTransactionService,
} from '@tarstate/core/transactions';
import type { OwnedDatabaseSource } from '@tarstate/core/database/session';
import type { MappedDatabaseResult, MappedDatabaseSnapshot } from '@tarstate/core/attachment/mapped-adapter';

export type AutomergeDatabaseResult = MappedDatabaseResult;

export type AutomergeDatabaseSnapshot = MappedDatabaseSnapshot;

export type AutomergeDatabase = DatabaseTransactionService & DatabaseTextIntentService & OwnedDatabaseSource & {
  readonly getSnapshot: () => AutomergeDatabaseSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
};
