/** Read-only query database over normalized, host-supplied Automerge facts. */
export { openAutomergeSystemDatabase } from './open.js';
export type {
  AutomergeSystemDatabase,
  AutomergeSystemDatabaseSnapshot,
  AutomergeSystemRelations,
  OpenAutomergeSystemDatabaseOptions
} from './open.js';
export type {
  AutomergeSyncState,
  AutomergeSystemEvent,
  AutomergeSystemRelationSnapshot
} from '../system-relations.js';
