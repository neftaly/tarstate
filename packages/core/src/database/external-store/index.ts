/** Host-runtime bridge for framework external stores. */
export * from '../../external-store.js';
export { HostRuntimeRegistry } from '../../host.js';
export { mappedRelationRows } from '../../attachment/mapped-relation-rows.js';
export { createMemoryAtomicExternalStore } from './memory.js';
export type {
  ExternalStoreDatabase,
  ExternalStoreDatabaseResult,
  ExternalStoreDatabaseSnapshot
} from './model.js';
export type { OpenExternalStoreDatabaseOptions } from './open.js';

/** Lazily loads relational attachment machinery only when the database opener is used. */
export const openExternalStoreDatabase: typeof import('./open.js').openExternalStoreDatabase =
  async (input) => (await import('./open.js')).openExternalStoreDatabase(input);
