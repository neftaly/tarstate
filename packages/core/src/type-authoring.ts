/** Compatibility facade for schema, query, and transaction authoring. */
export * from './schema-authoring.js';
export * from './query/authoring.js';
export { prepareTypedQuery } from './query/typed-plan.js';
export * from './transaction-authoring.js';
