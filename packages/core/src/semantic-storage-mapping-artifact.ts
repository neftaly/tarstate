import type { ArtifactRef } from './artifacts.js';
import { TarstateParseError, type ParseResult } from './issues.js';
import {
  defaultSemanticArtifactParseBudget,
  safeParseSemanticArtifact,
  type SemanticArtifactParseBudget
} from './internal-semantic-artifact-validation.js';
import { validateStorageMappingArtifactBody } from './internal-semantic-storage-mapping-validation.js';
import {
  compileStorageMapping,
  type CompiledStorageMapping,
  type StorageMappingArtifact
} from './mapping.js';
import type { CapabilityRegistry } from './registry.js';
import type { PreparedSchema } from './schema.js';

export type { StorageMappingArtifact } from './mapping.js';

export const safeParseStorageMappingArtifact = (
  input: unknown,
  budget = defaultSemanticArtifactParseBudget
): Promise<ParseResult<StorageMappingArtifact>> =>
  safeParseSemanticArtifact(input, 'storage-mapping', validateStorageMappingArtifactBody, budget);

export const parseStorageMappingArtifact = async (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<StorageMappingArtifact> => unwrap(await safeParseStorageMappingArtifact(input, budget));

export const safePrepareStorageMappingArtifact = async (input: unknown, options: {
  readonly schemaRef: ArtifactRef;
  readonly schema: PreparedSchema;
  readonly registry?: CapabilityRegistry;
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<{
  readonly artifact: StorageMappingArtifact;
  readonly compiled: CompiledStorageMapping;
}>> => {
  const parsed = await safeParseStorageMappingArtifact(input, options.budget);
  if (!parsed.success) return parsed;
  const compiled = compileStorageMapping(
    parsed.value.body,
    options.schemaRef,
    options.schema,
    options.registry
  );
  return compiled.success
    ? { success: true, value: { artifact: parsed.value, compiled: compiled.value }, issues: [] }
    : compiled;
};

const unwrap = <Value>(result: ParseResult<Value>): Value => {
  if (!result.success) throw new TarstateParseError(result.issues);
  return result.value;
};
