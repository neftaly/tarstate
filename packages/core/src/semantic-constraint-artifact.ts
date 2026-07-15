import type { ConstraintSetArtifact } from './constraint-artifact.js';
import type { SourceConstraint } from './constraints.js';
import { TarstateParseError, type ParseResult } from './issues.js';
import {
  prepareParsedConstraintSetArtifact,
  type ConstraintSetPreparationOptions
} from './internal-constraint-set-preparation.js';
import {
  defaultSemanticArtifactParseBudget,
  safeParseSemanticArtifact,
  type SemanticArtifactParseBudget
} from './internal-semantic-artifact-validation.js';
import { validateConstraintSetArtifactBody } from './internal-semantic-constraint-validation.js';

export const safeParseConstraintSetArtifact = (
  input: unknown,
  budget = defaultSemanticArtifactParseBudget
): Promise<ParseResult<ConstraintSetArtifact>> =>
  safeParseSemanticArtifact(input, 'constraint-set', validateConstraintSetArtifactBody, budget);

export const parseConstraintSetArtifact = async (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<ConstraintSetArtifact> => unwrap(await safeParseConstraintSetArtifact(input, budget));

export const safePrepareConstraintSetArtifact = async <State>(input: unknown, options: ConstraintSetPreparationOptions<State> & {
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<{
  readonly artifact: ConstraintSetArtifact;
  readonly constraints: readonly SourceConstraint<State>[];
}>> => {
  const parsed = await safeParseConstraintSetArtifact(input, options.budget);
  if (!parsed.success) return parsed;
  return prepareParsedConstraintSetArtifact(parsed.value, options);
};

const unwrap = <Value>(result: ParseResult<Value>): Value => {
  if (!result.success) throw new TarstateParseError(result.issues);
  return result.value;
};
