import type { CompiledStorageMapping } from './mapping.js';
import type { PreparedRelation, PreparedSchema } from './schema.js';
import type { ValidatedLensSteps, ValidatedSchemaLensBody } from './lens.js';
import { provenanceRegistry } from './internal-provenance-registry.js';

export const sealPreparedRelation = (value: Omit<PreparedRelation, symbol>): PreparedRelation => {
  const sealed = Object.freeze(value) as PreparedRelation;
  provenanceRegistry.preparedRelations.add(sealed);
  return sealed;
};

export const sealPreparedSchema = (value: Omit<PreparedSchema, symbol>): PreparedSchema => {
  const sealed = Object.freeze(value) as PreparedSchema;
  provenanceRegistry.preparedSchemas.add(sealed);
  return sealed;
};

export const assertPreparedSchema = (value: PreparedSchema): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.preparedSchemas.has(value)) throw new TypeError('Prepared schema was not produced by prepareSchema');
};

export const assertPreparedRelation = (value: PreparedRelation): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.preparedRelations.has(value)) throw new TypeError('Prepared relation was not produced by prepareSchema');
};

export const sealCompiledStorageMapping = (value: Omit<CompiledStorageMapping, symbol>): CompiledStorageMapping => {
  const sealed = Object.freeze(value) as CompiledStorageMapping;
  provenanceRegistry.compiledMappings.add(sealed);
  return sealed;
};

export const assertCompiledStorageMapping = (value: CompiledStorageMapping): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.compiledMappings.has(value)) throw new TypeError('Compiled storage mapping was not produced by compileStorageMapping');
};

export const sealValidatedLens = (value: Omit<ValidatedSchemaLensBody, symbol>): ValidatedSchemaLensBody => {
  const sealed = value as ValidatedSchemaLensBody;
  for (const relation of sealed.relations) provenanceRegistry.validatedLensSteps.add(relation.steps);
  provenanceRegistry.validatedLenses.add(sealed);
  return sealed;
};

export const assertValidatedLens = (value: ValidatedSchemaLensBody): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.validatedLenses.has(value)) throw new TypeError('Validated lens was not produced by validateLens');
};

export const assertValidatedLensSteps = (value: ValidatedLensSteps): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.validatedLensSteps.has(value)) throw new TypeError('Validated lens steps were not produced by validateLens');
};
