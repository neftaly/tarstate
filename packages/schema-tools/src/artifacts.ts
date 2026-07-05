import {
  canonicalSchemaManifest,
  stringifyCanonicalSchemaManifest,
  type JsonObject,
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

const defaultArtifacts = ['manifest', 'typescript', 'json-schema', 'prompt-card', 'examples'] as const satisfies readonly SchemaArtifactKind[];
const validArtifacts = new Set<SchemaArtifactKind>(defaultArtifacts);

export function emitSchemaArtifacts(input: unknown, options: EmitSchemaArtifactsOptions = {}): SchemaArtifactSet {
  const manifest = canonicalSchemaManifest(input);
  const kinds = artifactKindSet(options.artifacts ?? defaultArtifacts);
  const artifacts: SchemaArtifact[] = [];

  if (kinds.has('manifest')) {
    artifacts.push({ path: 'schema.manifest.json', content: stringifyCanonicalSchemaManifest(manifest) + '\n' });
  }
  if (kinds.has('typescript')) {
    artifacts.push({ path: 'rows.d.ts', content: emitTypeScriptRowsForCanonicalManifest(manifest) });
  }
  if (kinds.has('json-schema')) {
    for (const [relationName, schema] of sortedEntries(emitJsonSchemasForCanonicalManifest(manifest))) {
      artifacts.push({
        path: uniqueArtifactPath(artifacts, `json-schema/${fileStem(relationName)}.schema.json`),
        content: stringifyStableJsonPretty(schema) + '\n'
      });
    }
  }
  if (kinds.has('prompt-card')) {
    artifacts.push({ path: 'agent-card.md', content: emitPromptCardForCanonicalManifest(manifest) });
  }
  if (kinds.has('examples')) {
    for (const [relationName, example] of sortedEntries(emitRelationExamplesForCanonicalManifest(manifest))) {
      artifacts.push({
        path: uniqueArtifactPath(artifacts, `examples/${fileStem(relationName)}.json`),
        content: stringifyStableJsonPretty(example) + '\n'
      });
    }
  }

  return { manifest, artifacts };
}

function artifactKindSet(input: readonly SchemaArtifactKind[]): ReadonlySet<SchemaArtifactKind> {
  const result = new Set<SchemaArtifactKind>();
  for (const artifact of input) {
    if (!validArtifacts.has(artifact)) throw new Error(`Unknown schema artifact: ${String(artifact)}`);
    result.add(artifact);
  }
  return result;
}

function uniqueArtifactPath(existing: readonly SchemaArtifact[], path: string): string {
  const used = new Set(existing.map((artifact) => artifact.path));
  if (!used.has(path)) return path;
  const dot = path.lastIndexOf('.');
  const base = dot === -1 ? path : path.slice(0, dot);
  const extension = dot === -1 ? '' : path.slice(dot);
  let index = 2;
  let candidate = `${base}-${index}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}${extension}`;
  }
  return candidate;
}

export function stringifyArtifactJson(input: JsonObject): string {
  return stringifyStableJsonPretty(input) + '\n';
}
