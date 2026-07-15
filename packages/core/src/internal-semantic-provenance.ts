import { provenanceRegistry } from './internal-provenance-registry.js';

export const sealPreparedRelation = <PreparedRelation extends object>(value: Omit<PreparedRelation, symbol>): PreparedRelation => {
  const sealed = Object.freeze(value) as PreparedRelation;
  provenanceRegistry.preparedRelations.add(sealed);
  return sealed;
};

export const sealPreparedSchema = <PreparedSchema extends object>(value: Omit<PreparedSchema, symbol>): PreparedSchema => {
  const sealed = Object.freeze(value) as PreparedSchema;
  provenanceRegistry.preparedSchemas.add(sealed);
  return sealed;
};

export const assertPreparedSchema = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.preparedSchemas.has(value)) throw new TypeError('Prepared schema was not produced by prepareSchema');
};

export const assertPreparedRelation = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.preparedRelations.has(value)) throw new TypeError('Prepared relation was not produced by prepareSchema');
};

export const sealCompiledStorageMapping = <CompiledStorageMapping extends object>(value: Omit<CompiledStorageMapping, symbol>): CompiledStorageMapping => {
  const sealed = Object.freeze(value) as CompiledStorageMapping;
  provenanceRegistry.compiledMappings.add(sealed);
  return sealed;
};

export const assertCompiledStorageMapping = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.compiledMappings.has(value)) throw new TypeError('Compiled storage mapping was not produced by compileStorageMapping');
};

type LensBody = { readonly relations: readonly { readonly steps: object }[] };

export const sealValidatedLens = <ValidatedLens extends LensBody>(value: Omit<ValidatedLens, symbol>): ValidatedLens => {
  const sealed = value as ValidatedLens;
  for (const relation of sealed.relations) provenanceRegistry.validatedLensSteps.add(relation.steps);
  provenanceRegistry.validatedLenses.add(sealed);
  return sealed;
};

export const assertValidatedLens = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.validatedLenses.has(value)) throw new TypeError('Validated lens was not produced by validateLens');
};

export const assertValidatedLensSteps = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || !provenanceRegistry.validatedLensSteps.has(value)) throw new TypeError('Validated lens steps were not produced by validateLens');
};
