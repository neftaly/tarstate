/** The standard, conflict-aware Automerge database boundary. */
export { openAutomergeDatabase } from './database/open.js';
export { mappedRelationRows } from '@tarstate/core/attachment/mapped-adapter';
export type {
  OpenAutomergeDatabaseOptions
} from './database/open.js';
export type {
  AutomergeDatabase,
  AutomergeDatabaseResult,
  AutomergeDatabaseSnapshot
} from './database/model.js';
