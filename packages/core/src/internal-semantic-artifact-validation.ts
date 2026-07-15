import {
  defaultArtifactParseBudget,
  safeParseArtifactText,
  safeParseArtifactValue,
  type Artifact,
  type ArtifactParseBudget,
  type ArtifactRef
} from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { stringTupleKey } from './internal-string-key.js';
import type { JsonValue } from './value.js';

export type SemanticArtifactParseBudget = ArtifactParseBudget & {
  readonly maxSemanticDepth: number;
  readonly maxSemanticNodes: number;
  readonly maxIssues: number;
  readonly maxNames: number;
};

export const defaultSemanticArtifactParseBudget: SemanticArtifactParseBudget = Object.freeze({
  ...defaultArtifactParseBudget,
  maxSemanticDepth: 128,
  maxSemanticNodes: 100_000,
  maxIssues: 256,
  maxNames: 10_000
});

export type SemanticArtifactKind =
  | 'query'
  | 'transaction'
  | 'constraint-set'
  | 'storage-mapping'
  | 'schema-lens';

export type SemanticRecord = Readonly<Record<string, JsonValue>>;

export type SemanticValidationContext = {
  readonly family: SemanticArtifactKind;
  readonly budget: SemanticArtifactParseBudget;
  readonly issues: Issue[];
  nodes: number;
  budgetIssue: boolean;
};

export type SemanticBodyValidator = (
  context: SemanticValidationContext,
  body: JsonValue,
  artifact: Artifact
) => boolean;

const validatedSemanticArtifacts = new WeakMap<object, Map<SemanticArtifactKind, Artifact>>();

export const safeParseSemanticArtifact = async <Value extends Artifact>(
  input: unknown,
  kind: SemanticArtifactKind,
  validateBody: SemanticBodyValidator,
  budget: SemanticArtifactParseBudget
): Promise<ParseResult<Value>> => {
  if (budget === defaultSemanticArtifactParseBudget
    && input !== null
    && typeof input === 'object'
    && Object.isFrozen(input)) {
    const cached = validatedSemanticArtifacts.get(input)?.get(kind);
    if (cached !== undefined) return { success: true, value: cached as Value, issues: Object.freeze([]) };
  }
  let parsed: ParseResult<Artifact>;
  try {
    parsed = typeof input === 'string'
      ? await safeParseArtifactText(input, budget)
      : await safeParseArtifactValue(input, budget);
  } catch (error) {
    return semanticArtifactFailure(kind, [], 'envelope_parser_failed', {
      error: semanticArtifactErrorName(error)
    });
  }
  if (!parsed.success) return parsed;
  if (parsed.value.kind !== kind) {
    return semanticArtifactFailure(kind, ['kind'], 'kind_mismatch', {
      expected: kind,
      actual: parsed.value.kind
    });
  }
  const context: SemanticValidationContext = {
    family: kind,
    budget,
    issues: [],
    nodes: 0,
    budgetIssue: false
  };
  try {
    validateBody(context, parsed.value.body, parsed.value);
  } catch (error) {
    context.issues.push(semanticIssue(kind, [], 'validator_failed', {
      error: semanticArtifactErrorName(error)
    }));
  }
  if (context.issues.length > 0) return { success: false, issues: context.issues };
  if (budget === defaultSemanticArtifactParseBudget) {
    const remember = (value: object): void => {
      const byKind = validatedSemanticArtifacts.get(value) ?? new Map<SemanticArtifactKind, Artifact>();
      byKind.set(kind, parsed.value);
      validatedSemanticArtifacts.set(value, byKind);
    };
    remember(parsed.value);
    if (input !== null && typeof input === 'object' && Object.isFrozen(input)) remember(input);
  }
  return { success: true, value: parsed.value as Value, issues: Object.freeze([]) };
};

export const semanticShape = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  required: readonly string[],
  optional: readonly string[],
  path: readonly unknown[]
): input is SemanticRecord => {
  if (!isSemanticRecord(input)) {
    semanticInvalid(context, path, 'record_required');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) semanticInvalid(context, [...path, key], 'unknown_member');
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) semanticInvalid(context, [...path, key], 'missing_member');
  }
  return true;
};

export const isSemanticRecord = (value: unknown): value is SemanticRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const semanticNonEmptyString = (
  context: SemanticValidationContext,
  value: JsonValue | undefined,
  path: readonly unknown[]
): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    semanticInvalid(context, path, 'non_empty_string_required');
    return undefined;
  }
  return value;
};

export const semanticEnumValue = (
  context: SemanticValidationContext,
  value: JsonValue | undefined,
  allowed: readonly string[],
  path: readonly unknown[]
): void => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    semanticInvalid(context, path, 'enum_value', { allowed });
  }
};

export const semanticStringArray = (
  context: SemanticValidationContext,
  value: JsonValue | undefined,
  path: readonly unknown[],
  unique: boolean
): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    semanticInvalid(context, path, 'non_empty_string_array_required');
    return undefined;
  }
  const output = value as string[];
  if (unique && new Set(output).size !== output.length) {
    semanticInvalid(context, path, 'duplicate_name');
  }
  return output;
};

export const semanticOptionalPositiveInteger = (
  context: SemanticValidationContext,
  value: JsonValue | undefined,
  path: readonly unknown[]
): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
    semanticInvalid(context, path, 'positive_integer_required');
  }
};

export const semanticOptionalNonNegativeInteger = (
  context: SemanticValidationContext,
  value: JsonValue | undefined,
  path: readonly unknown[]
): void => {
  if (value !== undefined) semanticNonNegativeInteger(context, value, path);
};

export const semanticNonNegativeInteger = (
  context: SemanticValidationContext,
  value: JsonValue | undefined,
  path: readonly unknown[]
): void => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    semanticInvalid(context, path, 'non_negative_integer_required');
  }
};

export const enterSemanticNode = (
  context: SemanticValidationContext,
  path: readonly unknown[],
  depth: number
): boolean => {
  context.nodes += 1;
  if (depth > context.budget.maxSemanticDepth) {
    semanticBudgetIssue(context, path, 'maxSemanticDepth', context.budget.maxSemanticDepth);
    return false;
  }
  if (context.nodes > context.budget.maxSemanticNodes) {
    semanticBudgetIssue(context, path, 'maxSemanticNodes', context.budget.maxSemanticNodes);
    return false;
  }
  return true;
};

export const checkSemanticNameBudget = (
  context: SemanticValidationContext,
  count: number,
  path: readonly unknown[]
): void => {
  if (count > context.budget.maxNames) {
    semanticBudgetIssue(context, path, 'maxNames', context.budget.maxNames);
  }
};

export const semanticInvalid = (
  context: SemanticValidationContext,
  path: readonly unknown[],
  reason: string,
  details: Readonly<Record<string, unknown>> = {}
): void => {
  if (context.issues.length >= context.budget.maxIssues) {
    semanticBudgetIssue(context, path, 'maxIssues', context.budget.maxIssues);
    return;
  }
  context.issues.push(semanticIssue(context.family, path, reason, details));
};

export const validateSemanticArtifactRef = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): ArtifactRef | undefined => {
  if (!semanticShape(context, input, ['id', 'contentHash'], ['locations'], path)) return undefined;
  const id = semanticNonEmptyString(context, input.id, [...path, 'id']);
  if (!semanticHashValue(input.contentHash)) {
    semanticInvalid(context, [...path, 'contentHash'], 'invalid_content_hash');
  }
  if (input.locations !== undefined && (
    !Array.isArray(input.locations)
    || input.locations.some((location) => typeof location !== 'string')
  )) {
    semanticInvalid(context, [...path, 'locations'], 'string_array_required');
  }
  return id === undefined || !semanticHashValue(input.contentHash)
    ? undefined
    : {
        id,
        contentHash: input.contentHash,
        ...(Array.isArray(input.locations) ? { locations: input.locations as string[] } : {})
      };
};

export const validateSemanticCapabilityRef = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): CapabilityRef | undefined => {
  if (!semanticShape(context, input, ['id', 'version', 'contractHash'], [], path)) return undefined;
  const id = semanticNonEmptyString(context, input.id, [...path, 'id']);
  const version = semanticNonEmptyString(context, input.version, [...path, 'version']);
  if (!semanticHashValue(input.contractHash)) {
    semanticInvalid(context, [...path, 'contractHash'], 'invalid_contract_hash');
  }
  return id === undefined || version === undefined || !semanticHashValue(input.contractHash)
    ? undefined
    : { id, version, contractHash: input.contractHash };
};

export const semanticArtifactRefKey = (ref: ArtifactRef): string =>
  stringTupleKey(ref.id, ref.contentHash);

export const semanticCapabilityRefKey = (ref: CapabilityRef): string =>
  stringTupleKey(ref.id, ref.version, ref.contractHash);

export const semanticUnion = <Value>(...sets: readonly ReadonlySet<Value>[]): Set<Value> =>
  new Set(sets.flatMap((set) => [...set]));

export const semanticSetEqual = <Value>(
  left: ReadonlySet<Value>,
  right: ReadonlySet<Value>
): boolean => left.size === right.size && [...left].every((value) => right.has(value));

export const semanticArtifactFailure = <Value>(
  family: SemanticArtifactKind,
  path: readonly unknown[],
  reason: string,
  details: Readonly<Record<string, unknown>>
): ParseResult<Value> => ({
  success: false,
  issues: [semanticIssue(family, path, reason, details)]
});

export const semanticArtifactErrorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

const semanticBudgetIssue = (
  context: SemanticValidationContext,
  path: readonly unknown[],
  budget: string,
  limit: number
): void => {
  if (context.budgetIssue) return;
  context.budgetIssue = true;
  context.issues.push(createIssue({
    code: 'artifact.budget_exceeded',
    retry: 'after_input',
    path,
    details: { budget, limit }
  }));
};

const semanticIssue = (
  family: SemanticArtifactKind,
  path: readonly unknown[],
  reason: string,
  details: Readonly<Record<string, unknown>>
): Issue => createIssue({
  code: `${family}.artifact_invalid`,
  phase: 'parse',
  severity: 'error',
  retry: 'after_input',
  path,
  details: { reason, ...details }
});

const semanticHashValue = (value: JsonValue | undefined): value is `sha256:${string}` =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
