export {
  AutomergeAtomicSource,
  AutomergeMapStorageBinding,
  automergePathFootprint,
  relateAutomergeFootprints
} from './core-adapter.js';
export type {
  AutomergeAtomicSourceOptions,
  AutomergeMapStorageBindingOptions,
  AutomergePathFootprint,
  AutomergePathFootprintEntry
} from './core-adapter.js';

export {
  automergeArtifactResourceDriver,
  extractAutomergeArtifactCarrier
} from './artifact-resource-driver.js';
export type {
  AutomergeArtifactCarrierLease,
  AutomergeArtifactCarrierRepo,
  AutomergeArtifactCarrierSnapshot,
  InertAutomergeArtifactCarrier
} from './artifact-resource-driver.js';

export {
  adoptAutomergeJsonValue,
  adoptConflictFreeAutomergeJsonValue
} from './automerge-json.js';
export { automergeIssueDeclarations } from './issues.js';

export {
  applyAutomergeMetadataPlan,
  automergeGovernanceSourceAdapter,
  automergeMetadataProperty,
  isAutomergeReservedRootProperty,
  planAutomergeMetadataMutation,
  readAutomergeMetadata
} from './metadata.js';
export type {
  AppliedAutomergeMetadataMutation,
  AutomergeMetadataConflictAlternative,
  AutomergeMetadataDocumentStatus,
  AutomergeMetadataMutation,
  AutomergeMetadataMutationPlan,
  AutomergeMetadataPlanResult,
  AutomergeMetadataReadResult,
  AutomergeMetadataStorageV1,
  AutomergeMetadataV1,
  TrustedAutomergeMetadataOverride
} from './metadata.js';

export { AutomergeMappedStorageBinding } from './mapping-storage-binding.js';
export type {
  AutomergeMappedStorageBindingOptions,
  AutomergeMappedStorageRow
} from './mapping-storage-binding.js';

export {
  defaultAutomergeProjectionBudget,
  projectAutomergeFacts
} from './projection.js';
export type {
  AutomergeConflictFact,
  AutomergeFactProjection,
  AutomergeFactValue,
  AutomergeObjectFact,
  AutomergePath,
  AutomergeProjectionBudget,
  AutomergeProjectionIssue,
  AutomergePropertyFact
} from './projection.js';

export {
  AutomergeSourceRuntime,
  automergeBasis,
  automergeRepoSourceRuntime,
  exactAutomergeBasisEqual,
  exactAutomergeHeadsEqual
} from './source.js';
export type {
  AutomergeBasis,
  AutomergeRepoHandle,
  AutomergeSnapshot,
  AutomergeSourceChange,
  AutomergeSourceCommand,
  AutomergeSourceCommitResult,
  AutomergeSourceDiagnostic,
  AutomergeSourceDiagnosticReporter,
  AutomergeSourceIssue,
  AutomergeSourceOutcomeLookup,
  AutomergeSourceRuntimeApi
} from './source.js';

export {
  AutomergeMapProjectionPlanner,
  snapshotAutomergeDocument
} from './storage-binding.js';
export type {
  AutomergeEditPlan,
  AutomergeMapProjectionPlannerOptions,
  AutomergeProjectedRow,
  AutomergePropertyEdit,
  AutomergeRelationProjection,
  AutomergeRowLocator,
  PriorAutomergeRelationProjection
} from './storage-binding.js';

export {
  AutomergeSystemRelationState,
  automergeSystemRelationIds,
  automergeSystemSchema,
  materializeAutomergeConflictRows
} from './system-relations.js';
export type {
  AutomergeConflictSystemRow,
  AutomergeConnectionSystemRow,
  AutomergePeerSystemRow,
  AutomergePresenceSystemRow,
  AutomergeSyncState,
  AutomergeSyncSystemRow,
  AutomergeSystemEvent,
  AutomergeSystemRelationSnapshot,
  AutomergeSystemRows,
  ConflictLogicalEvidence
} from './system-relations.js';
