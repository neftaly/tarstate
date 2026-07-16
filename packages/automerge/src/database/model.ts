import type {
  DatabaseTransactionService,
  LogicalRelationRow
} from '@tarstate/core/transactions';
import type { OwnedDatabaseSource } from '@tarstate/core/database/session';
import type { Issue } from '@tarstate/core';
import type { SourceBasis, SourceFreshness, SourceLifecycleState } from '@tarstate/core/source';

export type AutomergeDatabaseResult = {
  readonly readiness: 'ready' | 'incomplete' | 'invalid';
  readonly rows: readonly LogicalRelationRow[];
  readonly completeness: 'exact' | 'unknown';
  readonly freshness: SourceFreshness;
  readonly basis: SourceBasis;
  readonly sourceState: SourceLifecycleState;
  readonly issues: readonly Issue[];
};

export type AutomergeDatabaseSnapshot =
  | { readonly state: 'open'; readonly current: AutomergeDatabaseResult }
  | { readonly state: 'closed' };

export type AutomergeDatabase = DatabaseTransactionService & OwnedDatabaseSource & {
  readonly getSnapshot: () => AutomergeDatabaseSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
};
