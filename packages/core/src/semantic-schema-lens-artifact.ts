import { TarstateParseError, type ParseResult } from './issues.js';
import {
  defaultSemanticArtifactParseBudget,
  safeParseSemanticArtifact,
  type SemanticArtifactParseBudget
} from './internal-semantic-artifact-validation.js';
import { validateSchemaLensArtifactBody } from './internal-semantic-schema-lens-validation.js';
import {
  validateLens,
  type SchemaLensArtifact,
  type ValidatedSchemaLensArtifact
} from './lens.js';

export type { SchemaLensArtifact } from './lens.js';

export const safeParseSchemaLensArtifact = async (
  input: unknown,
  budget = defaultSemanticArtifactParseBudget
): Promise<ParseResult<SchemaLensArtifact>> => {
  const parsed = await safeParseValidatedSchemaLensArtifact(input, budget);
  return parsed.success
    ? { success: true, value: parsed.value.artifact, issues: [] }
    : parsed;
};

export const parseSchemaLensArtifact = async (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<SchemaLensArtifact> => unwrap(await safeParseSchemaLensArtifact(input, budget));

export const safePrepareSchemaLensArtifact = async (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<ParseResult<ValidatedSchemaLensArtifact>> => {
  const parsed = await safeParseValidatedSchemaLensArtifact(
    input,
    budget ?? defaultSemanticArtifactParseBudget
  );
  if (!parsed.success) return parsed;
  const dependencies = Object.freeze(parsed.value.artifact.dependencies.map((dependency) => Object.freeze({
    ...dependency,
    ...(dependency.locations === undefined
      ? {}
      : { locations: Object.freeze([...dependency.locations]) })
  })));
  return {
    success: true,
    value: Object.freeze({
      ...parsed.value.artifact,
      dependencies,
      body: parsed.value.body
    }),
    issues: []
  };
};

const safeParseValidatedSchemaLensArtifact = async (
  input: unknown,
  budget: SemanticArtifactParseBudget
): Promise<ParseResult<{
  readonly artifact: SchemaLensArtifact;
  readonly body: ValidatedSchemaLensArtifact['body'];
}>> => {
  const parsed = await safeParseSemanticArtifact<SchemaLensArtifact>(
    input,
    'schema-lens',
    validateSchemaLensArtifactBody,
    budget
  );
  if (!parsed.success) return parsed;
  const validated = validateLens(parsed.value.body);
  if (!validated.success) return validated;
  return {
    success: true,
    value: { artifact: parsed.value, body: validated.value },
    issues: []
  };
};

const unwrap = <Value>(result: ParseResult<Value>): Value => {
  if (!result.success) throw new TarstateParseError(result.issues);
  return result.value;
};
