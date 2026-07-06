import {
  canonicalSchemaManifest,
  stringifyCanonicalSchemaManifest,
  type SchemaManifestV1
} from '@tarstate/core/schema';
import { emitRelationExamplesForCanonicalManifest } from './examples.js';
import { emitJsonSchemasForCanonicalManifest } from './json-schema.js';
import { fileStem, sortedEntries } from './names.js';
import { emitPromptCardForCanonicalManifest } from './prompt-card.js';
import { stringifyStableJsonPretty } from './stable-json.js';
import { emitTypeScriptRowsForCanonicalManifest } from './typescript.js';

export type SchemaArtifactKind =
  | 'manifest'
  | 'typescript'
  | 'json-schema'
  | 'prompt-card'
  | 'examples';

export type EmitSchemaArtifactsOptions = {
  readonly artifacts?: readonly SchemaArtifactKind[];
};

export type SchemaArtifact = {
  readonly path: string;
  readonly content: string;
};

export type SchemaArtifactSet = {
  readonly manifest: SchemaManifestV1;
  readonly artifacts: readonly SchemaArtifact[];
};

const defaultArtifacts = [
  'manifest',
  'typescript',
  'json-schema',
  'prompt-card',
  'examples'
] as const satisfies readonly SchemaArtifactKind[];
const validArtifacts: ReadonlySet<SchemaArtifactKind> = new Set(defaultArtifacts);

export function emitSchemaArtifacts(input: unknown, options: EmitSchemaArtifactsOptions = {}): SchemaArtifactSet {
  const manifest = canonicalSchemaManifest(input);
  const kinds = artifactKindSet(options.artifacts ?? defaultArtifacts);
  const artifacts = withUniqueArtifactPaths([
    ...(kinds.has('manifest') ? [manifestArtifact(manifest)] : []),
    ...(kinds.has('typescript') ? [typescriptArtifact(manifest)] : []),
    ...(kinds.has('json-schema') ? jsonSchemaArtifacts(manifest) : []),
    ...(kinds.has('prompt-card') ? [promptCardArtifact(manifest)] : []),
    ...(kinds.has('examples') ? exampleArtifacts(manifest) : [])
  ]);

  return { manifest, artifacts };
}

function artifactKindSet(input: readonly SchemaArtifactKind[]): ReadonlySet<SchemaArtifactKind> {
  const invalidArtifact = input.find((artifact) => !validArtifacts.has(artifact));
  if (invalidArtifact !== undefined) throw new Error(`Unknown schema artifact: ${String(invalidArtifact)}`);
  return new Set(input);
}

function manifestArtifact(manifest: SchemaManifestV1): SchemaArtifact {
  return { path: 'schema.manifest.json', content: stringifyCanonicalSchemaManifest(manifest) + '\n' };
}

function typescriptArtifact(manifest: SchemaManifestV1): SchemaArtifact {
  return { path: 'rows.d.ts', content: emitTypeScriptRowsForCanonicalManifest(manifest) };
}

function jsonSchemaArtifacts(manifest: SchemaManifestV1): readonly SchemaArtifact[] {
  return sortedEntries(emitJsonSchemasForCanonicalManifest(manifest)).map(([relationName, schema]) => ({
    path: `json-schema/${fileStem(relationName)}.schema.json`,
    content: stringifyStableJsonPretty(schema) + '\n'
  }));
}

function promptCardArtifact(manifest: SchemaManifestV1): SchemaArtifact {
  return { path: 'agent-card.md', content: emitPromptCardForCanonicalManifest(manifest) };
}

function exampleArtifacts(manifest: SchemaManifestV1): readonly SchemaArtifact[] {
  return sortedEntries(emitRelationExamplesForCanonicalManifest(manifest)).map(([relationName, example]) => ({
    path: `examples/${fileStem(relationName)}.json`,
    content: stringifyStableJsonPretty(example) + '\n'
  }));
}

function withUniqueArtifactPaths(artifacts: readonly SchemaArtifact[]): readonly SchemaArtifact[] {
  return artifacts.reduce<readonly SchemaArtifact[]>(
    (existing, artifact) => [...existing, { ...artifact, path: uniqueArtifactPath(existing, artifact.path) }],
    []
  );
}

function uniqueArtifactPath(existing: readonly SchemaArtifact[], path: string): string {
  const used = new Set(existing.map((artifact) => artifact.path));
  if (!used.has(path)) return path;
  const dot = path.lastIndexOf('.');
  const base = dot === -1 ? path : path.slice(0, dot);
  const extension = dot === -1 ? '' : path.slice(dot);
  const candidateAt = (index: number) => `${base}-${index}${extension}`;
  const firstAvailable = (index: number): string => {
    const candidate = candidateAt(index);
    return used.has(candidate) ? firstAvailable(index + 1) : candidate;
  };
  return firstAvailable(2);
}
