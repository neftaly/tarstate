/** Schema authoring, codecs, constraints, storage mappings, and schema lenses. */
export * from '../codec.js';
export * from '../constraint-artifact.js';
export * from '../constraints.js';
export * from '../lens.js';
export * from '../mapping.js';
export * from '../schema.js';
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
