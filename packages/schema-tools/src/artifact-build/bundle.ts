import {
  createIssue,
  isContentHash,
  safeParseArtifactValue,
  safeParseJsonText,
  type Artifact,
  type ArtifactKind,
  type ArtifactRef,
  type JsonValue,
  type ParseResult
} from '@tarstate/core';
import {
  safeParseDocumentDeclaration,
  type DocumentDeclaration
} from '@tarstate/core/attachment/declaration';
import { schemaToolsFailure } from '../internal-issues.js';
import {
  defaultArtifactBuildBudget,
  type ArtifactBuildBundle
} from './model.js';

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
      return buildFailure('bundle_shape');
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
        return buildFailure('conflicting_artifact_id', {
          id: parsed.value.id,
          hashes: [previous.contentHash, parsed.value.contentHash].sort()
        });
      }
      if (previous === undefined) {
        byId.set(parsed.value.id, parsed.value);
        artifacts.push(parsed.value);
      }
    }

    const declarations: Record<string, DocumentDeclaration> = {};
    for (const [name, candidate] of declarationEntries.sort(compareEntries)) {
      if (name.length === 0) return buildFailure('declaration_name');
      const parsed = safeParseDocumentDeclaration(candidate);
      if (!parsed.success) return parsed;
      declarations[name] = parsed.value;
    }
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
    return buildFailure('bundle_parse_failed', { error: errorName(error) });
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
    for (const dependency of artifact.dependencies) {
      const issue = missingReference(dependency, byId, artifact.id);
      if (issue !== undefined) return issue;
    }
    const semantic = semanticReferences(artifact);
    if (!semantic.success) return semantic;
    for (const reference of semantic.value) {
      const issue = missingReference(reference.ref, byId, artifact.id, reference.kind);
      if (issue !== undefined) return issue;
    }
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    const references: readonly { readonly ref: ArtifactRef; readonly kind: ArtifactKind }[] = [
      { ref: declaration.storageSchema, kind: 'schema' },
      ...(declaration.projection.kind === 'storage-mapping'
        ? [{ ref: declaration.projection.storageMapping, kind: 'storage-mapping' as const }]
        : []),
      ...(declaration.constraints === undefined
        ? []
        : [{ ref: declaration.constraints.set, kind: 'constraint-set' as const }])
    ];
    for (const reference of references) {
      const issue = missingReference(reference.ref, byId, 'declaration:' + name, reference.kind);
      if (issue !== undefined) return issue;
    }
  }
  return { success: true, value: undefined, issues: [] };
};

const semanticReferences = (
  artifact: Artifact
): ParseResult<readonly { readonly ref: ArtifactRef; readonly kind: ArtifactKind }[]> => {
  if (artifact.kind === 'schema' || artifact.kind === 'issue-code-catalog') {
    return { success: true, value: [], issues: [] };
  }
  if (!isRecord(artifact.body)) return buildFailure('artifact_body_reference', { artifactId: artifact.id });
  if (artifact.kind === 'storage-mapping') return requiredSchemaRefs(artifact, [artifact.body.schema]);
  if (artifact.kind === 'constraint-set' || artifact.kind === 'transaction') {
    return requiredSchemaRefs(artifact, [artifact.body.schemaView]);
  }
  if (artifact.kind === 'query') {
    return Array.isArray(artifact.body.schemaViews)
      ? requiredSchemaRefs(artifact, artifact.body.schemaViews)
      : buildFailure('artifact_body_reference', { artifactId: artifact.id, member: 'schemaViews' });
  }
  const root = requiredSchemaRefs(artifact, [artifact.body.from, artifact.body.to]);
  if (!root.success) return root;
  const references = [...root.value];
  if (!Array.isArray(artifact.body.relations)) {
    return buildFailure('artifact_body_reference', { artifactId: artifact.id, member: 'relations' });
  }
  for (const relation of artifact.body.relations) {
    if (!isRecord(relation) || !Array.isArray(relation.steps)) continue;
    for (const step of relation.steps) {
      if (isRecord(step) && step.kind === 'lens.lookup' && isRecord(step.through)) {
        const through = requiredSchemaRefs(artifact, [step.through.schemaView]);
        if (!through.success) return through;
        references.push(...through.value);
      }
    }
  }
  return { success: true, value: references, issues: [] };
};

const requiredSchemaRefs = (
  artifact: Artifact,
  values: readonly unknown[]
): ParseResult<readonly { readonly ref: ArtifactRef; readonly kind: ArtifactKind }[]> => {
  if (!values.every(isArtifactRef)) {
    return buildFailure('artifact_body_reference', { artifactId: artifact.id });
  }
  return { success: true, value: values.map((ref) => ({ ref, kind: 'schema' as const })), issues: [] };
};

const missingReference = (
  reference: ArtifactRef,
  byId: ReadonlyMap<string, Artifact>,
  owner: string,
  expectedKind?: ArtifactKind
): ParseResult<void> | undefined => {
  const resolved = byId.get(reference.id);
  if (resolved === undefined
    || resolved.contentHash !== reference.contentHash
    || (expectedKind !== undefined && resolved.kind !== expectedKind)) {
    return buildFailure('closure', {
      owner,
      reference: { id: reference.id, contentHash: reference.contentHash },
      ...(expectedKind === undefined ? {} : { expectedKind }),
      ...(resolved === undefined
        ? { actual: null }
        : { actual: { kind: resolved.kind, id: resolved.id, contentHash: resolved.contentHash } })
    });
  }
  return undefined;
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
const isArtifactRef = (value: unknown): value is ArtifactRef =>
  isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && isContentHash(value.contentHash);
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const buildFailure = <Value = never>(reason: string, details: JsonValue = {}): ParseResult<Value> =>
  schemaToolsFailure('schema_tools.artifact_build_invalid', { reason, details });
const budgetFailure = <Value = never>(budget: string, limit: number): ParseResult<Value> => ({
  success: false,
  issues: [createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', details: { budget, limit } })]
});
