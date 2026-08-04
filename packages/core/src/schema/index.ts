/** Schema authoring, codecs, source constraints, storage mappings, and schema lenses. */
export * from '../codec.js';
export * from '../constraints.js';
export * from '../lens.js';
export {
  compileStorageMapping,
  planStorageIntents,
  planStoragePatch,
  projectStorage,
  sealStorageMapping
} from '../mapping.js';
export type {
  AbsentFieldMapping,
  BindingProjection,
  BoundRelation,
  BoundRow,
  CollectionMapping,
  CompiledStorageMapping,
  FieldMapping,
  KeyMapping,
  MappedStorageIntent,
  MappingLocator,
  ProjectStorageOptions,
  RecursiveArrayCollectionMapping,
  RelationStorageMapping,
  SourceMetadataMapping,
  SourceMetadataResolver,
  SourceMetadataResolverInput,
  StorageEditPlan,
  StorageIntentPlan,
  StorageMappingArtifact,
  StorageMappingBody,
  StoragePath,
  StorageScalarCodecInput,
  StorageScalarDecoder,
  StoredFieldMapping,
  StoredFieldWriteMapping
} from '../mapping.js';
export {
  parseLogicalKey,
  parseRelationCandidate,
  parseRelationCandidates,
  parseScalarValueForField,
  prepareSchema,
  sealSchema
} from '../schema.js';
export type {
  CandidateContext,
  FieldDeclaration,
  LogicalKey,
  ParsedCandidate,
  ParsedRelation,
  PreparedRelation,
  PreparedSchema,
  RelationCandidate,
  RelationDeclaration,
  RelationId,
  RelationRow,
  SchemaArtifact,
  SchemaBody
} from '../schema.js';
export {
  customScalar,
  referenceTo,
  relationDeclaration,
  relationLiteral,
  schemaLiteral
} from '../schema-authoring.js';
export type {
  CustomScalarDeclaration,
  LiteralRelation,
  ReferenceScalarDeclaration,
  RelationKey,
  RowOfRelation,
  ScalarValueOf,
  SchemaKey,
  SchemaRow,
  ValueOfDeclaration
} from '../schema-authoring.js';
