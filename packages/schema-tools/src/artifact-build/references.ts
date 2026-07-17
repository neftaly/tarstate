import {
  isContentHash,
  type Artifact,
  type ArtifactKind,
  type ArtifactRef,
  type ParseResult
} from '@tarstate/core';
import type { DocumentDeclaration } from '@tarstate/core/attachment/declaration';
import { artifactBuildFailure } from './failure.js';

export type ArtifactReferenceEdge = {
  readonly ref: ArtifactRef;
  readonly kind?: ArtifactKind;
};

export const declarationArtifactReferences = (
  declaration: DocumentDeclaration
): readonly ArtifactReferenceEdge[] => [
  { ref: declaration.storageSchema, kind: 'schema' },
  ...(declaration.projection.kind === 'storage-mapping'
    ? [{ ref: declaration.projection.storageMapping, kind: 'storage-mapping' as const }]
    : []),
  ...(declaration.constraints === undefined
    ? []
    : [{ ref: declaration.constraints.set, kind: 'constraint-set' as const }])
];

export const artifactReferenceEdges = (
  artifact: Artifact
): ParseResult<readonly ArtifactReferenceEdge[]> => {
  const semantic = semanticReferences(artifact);
  if (!semantic.success) return semantic;
  return {
    success: true,
    value: [
      ...artifact.dependencies.map((ref) => ({ ref })),
      ...semantic.value
    ],
    issues: []
  };
};

export const missingArtifactReference = (
  reference: ArtifactRef,
  byId: ReadonlyMap<string, Artifact>,
  owner: string,
  expectedKind?: ArtifactKind
): ParseResult<never> | undefined => {
  const resolved = byId.get(reference.id);
  if (resolved !== undefined
    && resolved.contentHash === reference.contentHash
    && (expectedKind === undefined || resolved.kind === expectedKind)) {
    return undefined;
  }
  return artifactBuildFailure('closure', {
    owner,
    reference: { id: reference.id, contentHash: reference.contentHash },
    ...(expectedKind === undefined ? {} : { expectedKind }),
    ...(resolved === undefined
      ? { actual: null }
      : { actual: { kind: resolved.kind, id: resolved.id, contentHash: resolved.contentHash } })
  });
};

const semanticReferences = (
  artifact: Artifact
): ParseResult<readonly ArtifactReferenceEdge[]> => {
  if (artifact.kind === 'schema' || artifact.kind === 'issue-code-catalog') {
    return { success: true, value: [], issues: [] };
  }
  if (!isRecord(artifact.body)) {
    return artifactBuildFailure('artifact_body_reference', { artifactId: artifact.id });
  }
  if (artifact.kind === 'storage-mapping') {
    return requiredSchemaRefs(artifact, [artifact.body.schema]);
  }
  if (artifact.kind === 'constraint-set' || artifact.kind === 'transaction') {
    return requiredSchemaRefs(artifact, [artifact.body.schemaView]);
  }
  if (artifact.kind === 'query') {
    return Array.isArray(artifact.body.schemaViews)
      ? requiredSchemaRefs(artifact, artifact.body.schemaViews)
      : artifactBuildFailure('artifact_body_reference', {
          artifactId: artifact.id,
          member: 'schemaViews'
        });
  }
  const root = requiredSchemaRefs(artifact, [artifact.body.from, artifact.body.to]);
  if (!root.success) return root;
  const references = [...root.value];
  if (!Array.isArray(artifact.body.relations)) {
    return artifactBuildFailure('artifact_body_reference', {
      artifactId: artifact.id,
      member: 'relations'
    });
  }
  for (const relation of artifact.body.relations) {
    if (!isRecord(relation) || !Array.isArray(relation.steps)) continue;
    for (const step of relation.steps) {
      if (!isRecord(step) || step.kind !== 'lens.lookup' || !isRecord(step.through)) continue;
      const through = requiredSchemaRefs(artifact, [step.through.schemaView]);
      if (!through.success) return through;
      references.push(...through.value);
    }
  }
  return { success: true, value: references, issues: [] };
};

const requiredSchemaRefs = (
  artifact: Artifact,
  values: readonly unknown[]
): ParseResult<readonly ArtifactReferenceEdge[]> => {
  if (!values.every(isArtifactRef)) {
    return artifactBuildFailure('artifact_body_reference', { artifactId: artifact.id });
  }
  return {
    success: true,
    value: values.map((ref) => ({ ref, kind: 'schema' as const })),
    issues: []
  };
};

const isArtifactRef = (value: unknown): value is ArtifactRef =>
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && isContentHash(value.contentHash);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
