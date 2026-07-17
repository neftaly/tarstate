/** Schema authoring, codecs, source constraints, storage mappings, and schema lenses. */
export * from '../codec.js';
export * from '../constraints.js';
export * from '../lens.js';
export * from '../mapping.js';
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
