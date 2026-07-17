import {
  canonicalizeJson,
  createIssue,
  safeParseArtifactValue,
  type Artifact,
  type JsonValue,
  type ParseResult
} from '@tarstate/core';
import {
  safeParseDocumentDeclaration,
  type DocumentDeclaration
} from '@tarstate/core/attachment/declaration';
import { prepareSchema, type PreparedSchema, type SchemaBody } from '@tarstate/core/schema';
import { schemaToolsFailure } from '../internal-issues.js';
import { renderArtifactBindings } from './bindings.js';
import { safeParseArtifactBuildBundle } from './bundle.js';
import { artifactBuildFailure } from './failure.js';
import {
  defaultArtifactBuildBudget,
  type ArtifactBuildBudget,
  type ArtifactBuildManifest,
  type ArtifactBuildOutputs,
  type PreparedArtifactBuildManifest,
  type PreparedRelationBinding
} from './model.js';

export type {
  ArtifactBuildBudget,
  ArtifactBuildBundle,
  ArtifactBuildManifest,
  ArtifactBuildOutputs
} from './model.js';
export { defaultArtifactBuildBudget } from './model.js';
export {
  safeParseArtifactBuildBundle,
  safeParseArtifactBuildBundleText
} from './bundle.js';

/** Builds canonical portable data and exact erased TypeScript relation types. */
export const buildArtifactOutputs = async (
  manifest: ArtifactBuildManifest,
  budget = defaultArtifactBuildBudget
): Promise<ParseResult<ArtifactBuildOutputs>> => {
  try {
    const parsedManifest = await parseManifest(manifest, budget);
    if (!parsedManifest.success) return parsedManifest;
    const bundle = await safeParseArtifactBuildBundle({
      formatVersion: 1,
      artifacts: uniqueArtifacts(parsedManifest.value.artifacts),
      declarations: parsedManifest.value.declarations
    }, budget);
    if (!bundle.success) return bundle;
    return {
      success: true,
      value: Object.freeze({
        bundle: bundle.value,
        bundleJson: canonicalizeJson(bundle.value as unknown as JsonValue) + '\n',
        bindingsTypeScript: renderArtifactBindings(parsedManifest.value)
      }),
      issues: []
    };
  } catch (error) {
    return artifactBuildFailure('build_failed', { error: errorName(error) });
  }
};

/** Rebuilds and reports stale generated files without performing filesystem I/O. */
export const checkArtifactOutputs = async (
  manifest: ArtifactBuildManifest,
  current: Pick<ArtifactBuildOutputs, 'bundleJson' | 'bindingsTypeScript'>,
  budget = defaultArtifactBuildBudget
): Promise<ParseResult<ArtifactBuildOutputs>> => {
  const built = await buildArtifactOutputs(manifest, budget);
  if (!built.success) return built;
  const stale = [
    ...(current.bundleJson === built.value.bundleJson ? [] : ['bundleJson']),
    ...(current.bindingsTypeScript === built.value.bindingsTypeScript ? [] : ['bindingsTypeScript'])
  ];
  return stale.length === 0
    ? built
    : schemaToolsFailure('schema_tools.artifact_build_stale', { outputs: stale });
};

const parseManifest = async (
  manifest: ArtifactBuildManifest,
  budget: ArtifactBuildBudget
): Promise<ParseResult<PreparedArtifactBuildManifest>> => {
  if (!isRecord(manifest) || !isRecord(manifest.artifacts)) return artifactBuildFailure('manifest_shape');
  const artifactEntries = Object.entries(manifest.artifacts).sort(compareEntries);
  if (artifactEntries.length > budget.maxArtifacts) return budgetFailure('maxArtifacts', budget.maxArtifacts);
  const parsedArtifacts: [string, Artifact][] = [];
  const schemas = new Map<string, { readonly body: SchemaBody; readonly schema: PreparedSchema }>();
  for (const [name, candidate] of artifactEntries) {
    if (!identifier(name)) return artifactBuildFailure('artifact_name', { name });
    const parsed = await safeParseArtifactValue(candidate, budget);
    if (!parsed.success) return parsed;
    parsedArtifacts.push([name, parsed.value]);
    if (parsed.value.kind !== 'schema') continue;
    const prepared = prepareSchema(parsed.value.body);
    if (!prepared.success) return prepared;
    schemas.set(name, { body: prepared.value.body, schema: prepared.value });
  }

  const artifacts = Object.fromEntries(parsedArtifacts);
  const parsedDeclarations: [string, DocumentDeclaration][] = [];
  if (manifest.declarations !== undefined && !isRecord(manifest.declarations)) {
    return artifactBuildFailure('manifest_declarations');
  }
  for (const [name, candidate] of Object.entries(manifest.declarations ?? {}).sort(compareEntries)) {
    if (name.length === 0) return artifactBuildFailure('declaration_name');
    const parsed = safeParseDocumentDeclaration(candidate);
    if (!parsed.success) return parsed;
    parsedDeclarations.push([name, parsed.value]);
  }
  const declarations = Object.fromEntries(parsedDeclarations);

  if (manifest.relations !== undefined && !isRecord(manifest.relations)) {
    return artifactBuildFailure('manifest_relations');
  }
  const relationEntries = Object.entries(manifest.relations ?? {}).sort(compareEntries);
  if (relationEntries.length > budget.maxRelationBindings) {
    return budgetFailure('maxRelationBindings', budget.maxRelationBindings);
  }
  const relations: PreparedRelationBinding[] = [];
  const typeNames = new Set<string>();
  for (const [name, binding] of relationEntries) {
    if (!identifier(name)
      || !isRecord(binding)
      || !hasOnlyKeys(binding, ['schema', 'relation'])
      || typeof binding.schema !== 'string'
      || typeof binding.relation !== 'string') {
      return artifactBuildFailure('relation_binding', { name });
    }
    const schema = schemas.get(binding.schema);
    if (schema === undefined) {
      return artifactBuildFailure('relation_schema', { name, schema: binding.schema });
    }
    if (!schema.schema.relationsByName.has(binding.relation)) {
      return artifactBuildFailure('relation_missing', { name, relation: binding.relation });
    }
    const typeName = pascalIdentifier(name);
    if (typeNames.has(typeName)) {
      return artifactBuildFailure('relation_type_name', { name, typeName });
    }
    typeNames.add(typeName);
    relations.push({
      name,
      schemaName: binding.schema,
      relationName: binding.relation,
      schemaBody: schema.body,
      schema: schema.schema
    });
  }
  return {
    success: true,
    value: Object.freeze({
      artifacts: Object.freeze(artifacts),
      declarations: Object.freeze(declarations),
      relations: Object.freeze(relations)
    }),
    issues: []
  };
};

const uniqueArtifacts = (artifacts: Readonly<Record<string, Artifact>>): readonly Artifact[] => {
  const unique = new Map<string, Artifact>();
  for (const artifact of Object.values(artifacts)) {
    unique.set(artifact.id + '\u0000' + artifact.contentHash, artifact);
  }
  return [...unique.values()];
};

const compareEntries = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0;
const identifier = (value: string): boolean => /^[$A-Z_a-z][$\w]*$/u.test(value);
const pascalIdentifier = (value: string): string => value[0]!.toUpperCase() + value.slice(1);
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
