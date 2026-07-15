/** Compatibility facade. Prefer the artifact-kind-specific public entries. */
export {
  defaultSemanticArtifactParseBudget,
  type SemanticArtifactParseBudget
} from './internal-semantic-artifact-validation.js';
export * from './semantic-constraint-artifact.js';
export * from './semantic-query-artifact.js';
export * from './semantic-schema-lens-artifact.js';
export * from './semantic-storage-mapping-artifact.js';
export * from './semantic-transaction-artifact.js';
