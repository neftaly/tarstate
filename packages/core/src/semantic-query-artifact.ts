import { createIssue, TarstateParseError, type ParseResult } from './issues.js';
import {
  defaultSemanticArtifactParseBudget,
  safeParseSemanticArtifact,
  semanticArtifactErrorName,
  semanticArtifactFailure,
  type SemanticArtifactParseBudget
} from './internal-semantic-artifact-validation.js';
import { validateQueryArtifactBody } from './internal-semantic-query-validation.js';
import { evaluateQuery } from './query/evaluate.js';
import { safeParseQueryParameters, type QueryArtifact } from './query/builder.js';
import type { FunctionRegistry, QueryResult, RelationInput } from './query/model.js';
import { prepareQuery } from './query/prepare.js';
import type { CapabilityRegistry } from './registry.js';
import type { JsonValue } from './value.js';

export const safeParseQueryArtifact = (
  input: unknown,
  budget = defaultSemanticArtifactParseBudget
): Promise<ParseResult<QueryArtifact>> =>
  safeParseSemanticArtifact(input, 'query', validateQueryArtifactBody, budget);

export const parseQueryArtifact = async (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<QueryArtifact> => unwrap(await safeParseQueryArtifact(input, budget));

export const safePrepareQueryArtifact = async (input: unknown, options: {
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<{ readonly artifact: QueryArtifact; readonly plan: Awaited<ReturnType<typeof prepareQuery>> }>> => {
  const parsed = await safeParseQueryArtifact(input, options.budget);
  if (!parsed.success) return parsed;
  try {
    const plan = await prepareQuery({
      root: parsed.value.body.root,
      registryFingerprint: options.registryFingerprint,
      authorityFingerprint: options.authorityFingerprint,
      datasetId: options.datasetId
    });
    return { success: true, value: { artifact: parsed.value, plan }, issues: [] };
  } catch (error) {
    return semanticArtifactFailure('query', [], 'preparation_failed', {
      error: semanticArtifactErrorName(error)
    });
  }
};

export const safeEvaluateQueryArtifact = async (input: unknown, request: {
  readonly relations: readonly RelationInput[];
  readonly parameters: unknown;
  readonly registry?: CapabilityRegistry;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<QueryResult>> => {
  const parsed = await safeParseQueryArtifact(input, request.budget);
  if (!parsed.success) return parsed;
  const missingCapabilities = request.registry === undefined
    ? parsed.value.body.requiredCapabilities.map((ref) => createIssue({
        code: 'capability.missing',
        retry: 'after_capability',
        requiredCapabilities: [ref]
      }))
    : request.registry.missing(parsed.value.body.requiredCapabilities);
  if (missingCapabilities.length > 0) return { success: false, issues: missingCapabilities };
  const parameters = safeParseQueryParameters(
    parsed.value.body.parameters,
    request.parameters,
    request.registry === undefined ? {} : { registry: request.registry }
  );
  if (!parameters.success) return parameters;
  try {
    return {
      success: true,
      value: evaluateQuery({
        root: parsed.value.body.root,
        relations: request.relations,
        parameters: parameters.value as Readonly<Record<string, JsonValue>>,
        ...(request.functions === undefined ? {} : { functions: request.functions }),
        ...(request.basis === undefined ? {} : { basis: request.basis }),
        ...(request.membershipRevision === undefined ? {} : { membershipRevision: request.membershipRevision })
      }),
      issues: []
    };
  } catch (error) {
    return semanticArtifactFailure('query', [], 'execution_failed', {
      error: semanticArtifactErrorName(error)
    });
  }
};

const unwrap = <Value>(result: ParseResult<Value>): Value => {
  if (!result.success) throw new TarstateParseError(result.issues);
  return result.value;
};
