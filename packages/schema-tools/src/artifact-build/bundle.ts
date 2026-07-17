import {
  createIssue,
  safeParseArtifactValue,
  safeParseJsonText,
  type Artifact,
  type ParseResult
} from '@tarstate/core';
import {
  safeParseDocumentDeclaration,
  type DocumentDeclaration
} from '@tarstate/core/attachment/declaration';
import { artifactBuildFailure } from './failure.js';
import {
  defaultArtifactBuildBudget,
  type ArtifactBuildBundle
} from './model.js';
import {
  artifactReferenceEdges,
  declarationArtifactReferences,
  missingArtifactReference
} from './references.js';

/** Parses and verifies a build bundle, including its exact artifact closure. */
export const safeParseArtifactBuildBundle = async (
  input: unknown,
  budget = defaultArtifactBuildBudget
): Promise<ParseResult<ArtifactBuildBundle>> => {
  try {
    if (!isRecord(input)
      || !hasOnlyKeys(input, ['formatVersion', 'artifacts', 'declarations'])
      || input.formatVersion !== 1
      || !Array.isArray(input.artifacts)
      || !isRecord(input.declarations)) {
      return artifactBuildFailure('bundle_shape');
    }
    if (input.artifacts.length > budget.maxArtifacts) return budgetFailure('maxArtifacts', budget.maxArtifacts);
    const declarationEntries = Object.entries(input.declarations);
    if (declarationEntries.length > budget.maxDeclarations) {
      return budgetFailure('maxDeclarations', budget.maxDeclarations);
    }

    const artifacts: Artifact[] = [];
    const byId = new Map<string, Artifact>();
    for (const candidate of input.artifacts) {
      const parsed = await safeParseArtifactValue(candidate, budget);
      if (!parsed.success) return parsed;
      const previous = byId.get(parsed.value.id);
      if (previous !== undefined && previous.contentHash !== parsed.value.contentHash) {
        return artifactBuildFailure('conflicting_artifact_id', {
          id: parsed.value.id,
          hashes: [previous.contentHash, parsed.value.contentHash].sort()
        });
      }
      if (previous === undefined) {
        byId.set(parsed.value.id, parsed.value);
        artifacts.push(parsed.value);
      }
    }

    const parsedDeclarations: [string, DocumentDeclaration][] = [];
    for (const [name, candidate] of declarationEntries.sort(compareEntries)) {
      if (name.length === 0) return artifactBuildFailure('declaration_name');
      const parsed = safeParseDocumentDeclaration(candidate);
      if (!parsed.success) return parsed;
      parsedDeclarations.push([name, parsed.value]);
    }
    const declarations = Object.fromEntries(parsedDeclarations);
    const closure = validateClosure(artifacts, declarations, byId);
    if (!closure.success) return closure;
    artifacts.sort(compareArtifacts);
    return {
      success: true,
      value: Object.freeze({
        formatVersion: 1,
        artifacts: Object.freeze(artifacts),
        declarations: Object.freeze(declarations)
      }),
      issues: []
    };
  } catch (error) {
    return artifactBuildFailure('bundle_parse_failed', { error: errorName(error) });
  }
};

export const safeParseArtifactBuildBundleText = (
  text: string,
  budget = defaultArtifactBuildBudget
): Promise<ParseResult<ArtifactBuildBundle>> => {
  const parsed = safeParseJsonText(text, budget);
  return parsed.success ? safeParseArtifactBuildBundle(parsed.value, budget) : Promise.resolve(parsed);
};

const validateClosure = (
  artifacts: readonly Artifact[],
  declarations: Readonly<Record<string, DocumentDeclaration>>,
  byId: ReadonlyMap<string, Artifact>
): ParseResult<void> => {
  for (const artifact of artifacts) {
    const references = artifactReferenceEdges(artifact);
    if (!references.success) return references;
    for (const reference of references.value) {
      const issue = missingArtifactReference(
        reference.ref,
        byId,
        artifact.id,
        reference.kind
      );
      if (issue !== undefined) return issue;
    }
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    for (const reference of declarationArtifactReferences(declaration)) {
      const issue = missingArtifactReference(
        reference.ref,
        byId,
        'declaration:' + name,
        reference.kind
      );
      if (issue !== undefined) return issue;
    }
  }
  return { success: true, value: undefined, issues: [] };
};

const compareArtifacts = (left: Artifact, right: Artifact): number =>
  compare(left.id, right.id) || compare(left.contentHash, right.contentHash);
const compareEntries = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  compare(left, right);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const hasOnlyKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  return Object.keys(value).every((key) => keys.includes(key));
};
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const budgetFailure = <Value = never>(budget: string, limit: number): ParseResult<Value> => ({
  success: false,
  issues: [createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', details: { budget, limit } })]
});
